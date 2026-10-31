// AmbientPresence.js — CompanionHeartbeat 的 onWake：叫醒她跑一轮 ambient turn，说了就交付
// （add-companion-heartbeat D2；群聊一拍见 D9）。
//
// 调用顺序：心跳到点过门控 → onWake(wake) → runtime.handleAmbientTurn（同一主循环的一轮，
// 她自己决定说不说；入账在会话队列里重验后进行）→ 入账后回调 deliver：
// 满足出声条件且仍然有效才配语音，否则只出文字；最后标未读。
//
// 群聊一拍（wake.followerIds 非空；add-companion-expression-and-reception D1/D3）：出声者先跑；跟话的人由
// 「心里有没有事」决定（intentOf：约过到期 followup、在她上次开口后被提到、有没提过的没完的事），
// 最多 1 位、同分按轮换；没人有事就只有出声者一句。谁接下一句由与用户回合共用的 FloorRunner 决定：
//   - 每拍最多 3 句可见（含出声者），正好容纳 A→B→A：说话的人可以在 presence_respond 里点名一位
//     还没说过的成员接话（invite），被点名的人可以点回邀请者一次，之后不再交接；被邀请者不占跟话名额；
//   - 只有出声者的第一句可能配语音；交付前出声者已经不是解析结果（设置里改了主持人）就只出文字；
//   - 其余的话只出文字、标未读，各用自己的唤醒 id 入账（幂等互不冲突），各自做入账重验；
//   - 你开口、换听歌来源、改陪伴模式或心跳撤销：整拍结束，后面的人不再跑。
// 打分与原因码只进 trace（ambient_intent_scored），不进提示词。
// 输出是心跳认识的形状 { outcome: 'spoken'|'text-only'|'quiet'|'silent', reason, lines }，一拍只记一次。
// 它不写队列/phase、不提交播放事件、不写记忆或观察。
//
// Python 伪代码：
//   async def on_wake(wake):
//       followers = choose_followers(rotate(wake.follower_ids), intent_of)        # 至多 1 位
//       run = FloorRun('ambient', [(wake.person_id, 'holder'), *[(f, 'follower') for f in followers]])
//       while (entry := run.next()):
//           if entry is not first and tick_interrupted(wake): break
//           r = await runtime.handle_ambient_turn(entry.person_id, floor=run.view(entry.person_id), ...)
//           run.settle(entry.person_id, spoke=r.action == 'speak')
//           if r.action not in ('speak', 'quiet'): break                     # 打断/忙/过期：整拍结束
//       return summarize(run.lines)
import { deliverPresenceTurn } from './presenceDelivery.js';
import { rotateFollowers } from './groupVoice.js';
import { chooseFollowers, intentFacts, intentOf } from './intentOf.js';
import { createFloorRun, FLOOR_KINDS } from '../virtual-person/floorRunner.js';

export const GROUP_TICK_LIMITS = Object.freeze({ maxLines: FLOOR_KINDS.ambient.maxLines });
const ROTATION_MEMORY = 64;
const INTENT_LOOKBACK_TURNS = 30;

/** 揭示延迟随句长在 1–3 秒之间：短句一下就到，长句像真的在打字。 */
export function revealDelayMs(text = '') {
  return Math.max(1000, Math.min(3000, 800 + 40 * String(text || '').length));
}

// 可被撤销打断的等待：你一开口或心跳撤销，已入账的话立即揭示，不再等。
const defaultSleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  timer.unref?.();
  function done() { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); }
  signal?.addEventListener?.('abort', done, { once: true });
});

const wakeIdFor = (wake, personId, role) => {
  if (role === 'holder') return wake.id;
  return role === 'returned' ? `${wake.id}:${personId}:r` : `${wake.id}:${personId}`;
};

export function createAmbientPresence({ runtime, presentationService, queueService, trace = null, sleep = defaultSleep,
  canSpeakAloud = () => false, isWakeCurrent = () => true, isVoiceHolder = () => true, logger = console } = {}) {
  if (typeof runtime?.handleAmbientTurn !== 'function') throw new TypeError('createAmbientPresence requires runtime.handleAmbientTurn()');
  // 每个聊天上一拍最后跟话的人：下一拍同分时排到最后。只在进程内记，重启后从入群顺序开始。
  const lastFollower = new Map();
  const store = () => runtime.conversationStore;
  const nameOf = personId => runtime.registry?.get?.(personId)?.displayName || personId;

  const runOne = async (wake, entry, run) => {
    const { personId, role } = entry;
    const sessionId = wake.sessionId;
    const inviterId = entry.invitation?.fromPersonId || null;
    const memberWake = Object.freeze({ ...wake, personId, role, id: wakeIdFor(wake, personId, role),
      ...(inviterId ? { invitedBy: Object.freeze({ personId: inviterId, displayName: nameOf(inviterId) }) } : {}) });
    const isCurrent = () => isWakeCurrent(wake) === true;
    // 这位此刻能点名谁（短编号 m1.. 在 runtime 里映射，模型看不到真实 id）。
    const floor = Object.freeze({
      targets: run.inviteTargets(personId).map(id => Object.freeze({ personId: id, displayName: nameOf(id) })),
      invite: toPersonId => run.invite(personId, toPersonId),
    });
    return runtime.handleAmbientTurn({
      sessionId, personId, wake: memberWake, floor,
      // 听歌来源换了或陪伴模式改过，这一轮就不再算数（入账前重验与交付前都看它）。
      isCurrent,
      deliver: async ({ turn, entity, isCurrent: stillCurrent }) => {
        const voice = role === 'holder' && stillCurrent() && canSpeakAloud(sessionId) === true && isVoiceHolder(wake) === true;
        // 只出文字的那句：已入账，先显示 1–3 秒「正在输入」再揭示气泡（安静的回合从不显示）。
        // 出声的那句不延迟，免得拖后语音。没有活动通道时不等。
        const typing = !voice && typeof runtime.emitActivity === 'function';
        const activity = (state, outcome) => runtime.emitActivity({ sessionId, personId, correlationId: memberWake.id, state, outcome });
        if (typing) {
          activity('composing');
          await sleep(revealDelayMs(turn.visibleText), wake.signal);
        }
        try {
          return await deliverPresenceTurn({
            presentationService, queueService, conversationStore: runtime.conversationStore, turn, person: entity,
            sessionId, correlationId: memberWake.id, isCurrent: stillCurrent, voice,
          });
        } finally {
          if (typing) activity('idle', 'committed');
        }
      },
    });
  };

  // 出声者之后每轮开始前再看：心跳撤销、来源/模式变了、或者你在这一拍里开口了。
  const tickInterrupted = wake => {
    if (wake.signal?.aborted || isWakeCurrent(wake) !== true) return true;
    try {
      const lastUserAt = store()?.lastUserTurnAt?.(wake.sessionId);
      return Number.isFinite(lastUserAt) && Number.isFinite(wake.firedAtMs) && lastUserAt > wake.firedAtMs;
    } catch { return true; }
  };

  // 这一拍开始时的只读事实；读失败等同没有这条事实（宁可少问）。
  const scoreFollowers = (wake, candidates) => {
    if (!candidates.length) return { chosen: [], scored: [] };
    let turns = [];
    try { turns = store()?.listTurns?.(wake.sessionId, { limit: INTENT_LOOKBACK_TURNS, visibleOnly: true }) || []; } catch { turns = []; }
    const names = new Map(candidates.map(id => [id, nameOf(id)]));
    const openLoopOf = personId => {
      try {
        return (store()?.notes?.listVisible?.({ personId, sessionId: wake.sessionId, isGroup: true, mode: 'ambient', wake }) || [])
          .some(note => note.kind === 'open_loop');
      } catch { return false; }
    };
    return chooseFollowers(candidates, personId => intentOf(intentFacts({ personId, wake, turns, names,
      openLoop: openLoopOf(personId) })));
  };

  return async function onWake(wake) {
    const sessionId = wake?.sessionId;
    const followerIds = Array.isArray(wake?.followerIds) ? wake.followerIds : [];
    const rotated = rotateFollowers(followerIds, lastFollower.get(sessionId));
    const { chosen, scored } = scoreFollowers(wake, rotated);
    if (scored.length) {
      try {
        trace?.(sessionId, { type: 'ambient_intent_scored', wakeId: wake.id, chosen,
          scored: scored.map(item => ({ personId: item.personId, score: item.score, reasons: item.reasons })) });
      } catch { /* trace 失败不影响这一拍 */ }
    }
    const run = createFloorRun({ kind: 'ambient', memberIds: [wake?.personId, ...followerIds],
      initial: [{ personId: wake?.personId, role: 'holder' }, ...chosen.map(personId => ({ personId, role: 'follower' }))],
      canOpenInvite: () => true });
    let spoken = false, quiet = false, stopReason = null, lastSpeaker = null, first = true;
    for (let entry = run.next(); entry; entry = run.next()) {
      if (!first && tickInterrupted(wake)) { run.interrupt('interrupted'); break; }
      first = false;
      let result;
      try {
        result = await runOne(wake, entry, run);
      } catch {
        logger?.warn?.('[presence] ambient turn failed');
        result = { action: 'silent', reason: 'error' };
      }
      const speaking = result?.action === 'speak';
      run.settle(entry.personId, { spoke: speaking });
      if (speaking) {
        if (result.delivery === 'spoken') spoken = true;
        if (entry.role !== 'holder' && entry.personId !== wake.personId) lastSpeaker = entry.personId;
        continue;
      }
      if (result?.action === 'quiet') { quiet = true; continue; }
      stopReason = result?.reason || 'error';
      run.interrupt(stopReason);
      break;
    }
    if (lastSpeaker) {
      lastFollower.delete(sessionId);
      lastFollower.set(sessionId, lastSpeaker);
      if (lastFollower.size > ROTATION_MEMORY) lastFollower.delete(lastFollower.keys().next().value);
    }
    const lines = run.lines;
    if (lines) return { outcome: spoken ? 'spoken' : 'text-only', reason: 'delivered', lines };
    // 有人选择了安静就记一拍安静（之后被打断也一样）；没人表态才是沉默原因码。
    if (quiet) return { outcome: 'quiet', reason: 'quiet', lines: 0 };
    return { outcome: 'silent', reason: stopReason || 'error', lines: 0 };
  };
}

export default createAmbientPresence;
