// PresenceRuntime.js — 一次「她主动说一句」的生成 → 入账 → 交付（P1）。
//
// 调用顺序（输入是一个已通过确定性资格判定的 moment，以及说话角色的在场性格 policy）：
//   1. 读接地素材（presenceGrounding：为什么放这首、刚才聊了什么、这首歌的来历）；
//      没有钩子 → silent('no-hook')，不调模型。
//   2. 组锁定任务（证据 + 她最近说过的话 + 当地时段 + 在场方式），调 presence_utterance 受限任务；
//      沉默/超时/失败 → 结束，什么都不写。
//   3. 进入与用户回合共享的会话队列，重验：没被用户打断、听歌会话仍是这一场、聊天仍在。
//      通过才 recordPresenceTurn（确定性 id，幂等；sourceRefs 是账本来源，如 pick:<requestId>、chat:<turnId>）。
//   4. 出队后交付：PresentationService（sourceTurnId = presence turn）→ 共享交付形状 →
//      queueService.publishSnapshot；不满足出声条件或已被打断时只出文字。最后标记未读。
// 它不写队列/phase、不提交播放事件、不写记忆或观察；失败只会让她这次没开口。
//
// Python 伪代码：
//   g = gather_grounding(store, moment); if not has_hook(moment, g, policy): return silent('no-hook')
//   result = utterance.generate(task, signal=ctrl.signal)
//   if result.action != 'speak': return silent(result.reason)
//   with session_queue(sid):
//       if aborted or not is_current(): return silent('stale')
//       turn = store.record_presence_turn(...)
//   deliver(turn, speak=can_speak_aloud(sid) and not aborted)
import { EMPTY_GROUNDING, gatherPresenceGrounding, hasPresenceHook } from './presenceGrounding.js';
import { buildPresenceTask, dayPartOf } from './presenceLine.js';
import { deliverPresenceTurn } from './presenceDelivery.js';
import { presenceTemperamentOf, resolvePresencePolicy } from './presenceTemperament.js';

export class PresenceRuntime {
  constructor({ conversationStore, registry, utterance, presentationService, queueService,
    runExclusive = (sessionId, work) => work(), canSpeakAloud = () => false,
    now = () => Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    trace = null, logger = console } = {}) {
    if (!conversationStore?.recordPresenceTurn) throw new TypeError('PresenceRuntime requires conversationStore');
    if (!utterance?.generate) throw new TypeError('PresenceRuntime requires utterance.generate()');
    Object.assign(this, { conversationStore, registry, utterance, presentationService, queueService,
      runExclusive, canSpeakAloud, now, timeZone, trace, logger });
    this.controllers = new Map();
  }

  /** 用户开口/切会话：作废该会话正在准备的主动开口（已入账的不撤回，只是不再出声）。 */
  interrupt(sessionId) {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort(new Error('presence interrupted'));
    return true;
  }

  /**
   * @returns {{ outcome: 'spoken'|'text-only'|'silent', reason: string, turnId?: string }}
   */
  async speak(moment, { isCurrent = () => true, policy = null } = {}) {
    const { sessionId, personId } = moment;
    this.controllers.get(sessionId)?.abort(new Error('presence superseded'));
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    const { signal } = controller;
    const current = () => !signal.aborted && isCurrent();
    const silent = reason => {
      this._trace(sessionId, { type: 'presence_result', triggerKey: moment.triggerKey, outcome: 'silent', reason });
      return { outcome: 'silent', reason };
    };
    try {
      const person = this.registry?.get?.(personId);
      const room = this.conversationStore.getSession(sessionId);
      if (!person || !room?.memberIds?.includes(personId)) return silent('no-speaker');
      const temperament = presenceTemperamentOf(person);
      const cadence = policy || resolvePresencePolicy({ temperament: temperament.temperament });
      let grounding = EMPTY_GROUNDING;
      try {
        grounding = gatherPresenceGrounding({ store: this.conversationStore, sessionId, personId, moment, nowMs: this.now(),
          nameOf: id => this.registry?.get?.(id)?.displayName || null });
      } catch { this.logger?.warn?.('[presence] grounding failed'); }
      // 没有可说的就不开口，也不花一次模型调用。
      if (!hasPresenceHook(moment, grounding, cadence)) return silent('no-hook');
      const task = buildPresenceTask(moment, {
        recentLines: this.conversationStore.recentSpokenLines?.(sessionId, personId, { limit: 3 }) || [],
        dayPart: dayPartOf(this.now(), this.timeZone), personName: person.displayName,
        grounding, temperament: { hint: cadence?.hint, style: temperament.style },
      });
      const result = await this.utterance.generate(task, { persona: person, signal, isCurrent: current });
      if (result.action !== 'speak') return silent(result.rejectedRule ? `${result.reason}:${result.rejectedRule}` : result.reason);
      const sourceRefs = [...new Set((result.evidenceRefs || []).map(ref => task.sources?.[ref] || ref))];

      const turn = await this.runExclusive(sessionId, async () => {
        if (!current()) return null;
        return this.conversationStore.recordPresenceTurn({ sessionId, personId, triggerKey: moment.triggerKey,
          kind: moment.kind, text: result.text, sourceRefs });
      });
      if (!turn) return silent(signal.aborted ? 'interrupted' : 'stale');

      let outcome = 'text-only';
      try {
        outcome = await deliverPresenceTurn({ presentationService: this.presentationService, queueService: this.queueService,
          conversationStore: this.conversationStore, turn, person, sessionId,
          correlationId: `presence:${moment.triggerKey}`, voice: current() && this.canSpeakAloud(sessionId) === true,
          isCurrent: current });
      } catch {
        // 已入账的话刷新后仍可见；交付失败不补发、不重试。
        this.logger?.warn?.('[presence] delivery failed');
      }
      this._trace(sessionId, { type: 'presence_result', triggerKey: moment.triggerKey, outcome, reason: 'delivered',
        turnId: turn.turnId, evidenceRefs: result.evidenceRefs });
      return { outcome, reason: 'delivered', turnId: turn.turnId };
    } catch {
      this.logger?.warn?.('[presence] utterance failed');
      return silent('error');
    } finally {
      if (this.controllers.get(sessionId) === controller) this.controllers.delete(sessionId);
    }
  }

  _trace(sessionId, event) {
    try { this.trace?.(sessionId, event); } catch { /* trace 失败不影响主动开口 */ }
  }
}

export default PresenceRuntime;
