// presenceGrounding.js — 主动开口前，她真正知道的事（只读账本，可复核）。
//
// 调用顺序：PresenceRuntime 拿到一个已通过确定性资格判定的 moment →
//   gatherPresenceGrounding 读本聊天账本：
//     1. pick_reason：occurrence 上提交它的 requestId → 那次已完成 request 的听众原话与她的可见回复；
//        续播没有聊天回合时，用她给这一批写下的方向（listeningPlan.softPreferences）。
//     2. recent_chat：本聊天最近 30 分钟内至多 6 条可见聊天回合（总长 ≤1200 字）。
//     3. song_history：这首歌（同 provider + songId）在本聊天里之前出现过几次、她上次怎么介绍它。
//   每条都经 ConversationStore.canReadTurn（同一套撤回/披露/群聊规则）；不跨聊天、不读私人记忆。
// → hasPresenceHook 判定「有没有话可说」：没有就不调模型。钩子强弱由说话角色的在场性格决定。
// 这里只读，不写账本、不调模型；读失败按「没有这条素材」处理。
//
// Python 伪代码：
//   g = gather_presence_grounding(store, room, person, moment, now)
//   if not has_presence_hook(moment, g, policy): return silence('no-hook')   # 0 次模型调用
import { createHash } from 'node:crypto';

export const RECENT_CHAT_WINDOW_MS = 30 * 60_000;
export const RECENT_CHAT_MAX_TURNS = 6;
export const RECENT_CHAT_MAX_CHARS = 1200;
const EXCERPT_CHARS = 200;
const INTRO_CHARS = 120;
const LEDGER_SCAN = 80;
// 不算「聊天」的可见呈现：她自己的主动开口与串词另有防复读。
const NOT_CHAT = new Set(['presence', 'track_intro']);
const INTRINSIC_MOMENTS = new Set(['session_open', 'queue_exhausted']);

const clean = value => String(value ?? '').trim();
const excerpt = (value, max = EXCERPT_CHARS) => {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export const EMPTY_GROUNDING = Object.freeze({ pickReason: null, pickFresh: false, recentChat: [], chatFresh: false, songHistory: null });

export function gatherPresenceGrounding({ store, sessionId, personId, moment, nowMs, nameOf = id => id } = {}) {
  const room = store?.getSession?.(sessionId);
  if (!room) return EMPTY_GROUNDING;
  const isGroup = (room.memberIds || []).length > 1;
  const readable = turn => {
    try { return Boolean(turn) && turn.sessionId === sessionId && store.canReadTurn(personId, turn, { sessionId, isGroup }); }
    catch { return false; }
  };
  const turns = store.listTurns(sessionId, { limit: LEDGER_SCAN, visibleOnly: true }).filter(readable);
  const ownPresence = turns.filter(turn => turn.message?.presentation === 'presence' && turn.speakerVirtualPersonId === personId);
  const lastPresenceAt = ownPresence.reduce((latest, turn) => Math.max(latest, Number(turn.createdAt) || 0), 0);
  const citedSources = new Set(ownPresence.flatMap(turn => turn.message?.presence?.sourceRefs || []));
  const track = moment?.evidence?.track || null;

  const pick = pickReason({ store, track, direction: moment?.evidence?.planDirection, sessionId, readable });
  const usedTurnIds = new Set(pick?.turnIds || []);
  const speakerOf = turn => turn.role === 'user' ? '听众'
    : (turn.speakerVirtualPersonId === personId ? '你' : (nameOf(turn.speakerVirtualPersonId) || '同伴'));
  let recent = turns.filter(turn => ['user', 'assistant'].includes(turn.role) && !NOT_CHAT.has(turn.message?.presentation)
    && !usedTurnIds.has(turn.turnId) && clean(turn.visibleText) && nowMs - Number(turn.createdAt) <= RECENT_CHAT_WINDOW_MS)
    .slice(-RECENT_CHAT_MAX_TURNS)
    .map(turn => ({ speaker: speakerOf(turn), said: excerpt(turn.visibleText), turnId: turn.turnId,
      fromListener: turn.role === 'user', createdAt: Number(turn.createdAt) || 0 }));
  while (recent.reduce((sum, item) => sum + item.said.length, 0) > RECENT_CHAT_MAX_CHARS) recent = recent.slice(1);

  return Object.freeze({
    pickReason: pick ? Object.freeze({ listener: pick.listener, reply: pick.reply, direction: pick.direction, source: pick.source }) : null,
    pickFresh: Boolean(pick) && !citedSources.has(pick.source),
    recentChat: Object.freeze(recent.map(({ speaker, said, turnId }) => Object.freeze({ speaker, said, turnId }))),
    chatFresh: recent.some(item => item.fromListener && item.createdAt > lastPresenceAt),
    songHistory: songHistory(turns, track),
  });
}

function pickReason({ store, track, direction, sessionId, readable }) {
  const requestId = clean(track?.requestId);
  let request = null;
  try { request = requestId ? store.getRequest(requestId) : null; } catch { request = null; }
  if (request && request.sessionId === sessionId && request.state === 'completed') {
    const asked = store.getTurn?.(request.userTurnId);
    const answered = store.getTurn?.(request.assistantTurnId);
    const listener = readable(asked) ? excerpt(asked.visibleText) || null : null;
    const reply = readable(answered) ? excerpt(answered.visibleText) || null : null;
    if (listener || reply) {
      return { listener, reply, direction: null, source: `pick:${requestId}`.slice(0, 160),
        turnIds: [asked?.turnId, answered?.turnId].filter(Boolean) };
    }
  }
  const written = excerpt(direction);
  if (!written) return null;
  return { listener: null, reply: null, direction: written,
    source: `plan:${createHash('sha256').update(written).digest('hex').slice(0, 16)}`, turnIds: [] };
}

function songHistory(turns, track) {
  const songId = clean(track?.songId);
  if (!songId) return null;
  const provider = clean(track?.provider);
  const sameSong = item => clean(item?.songId) === songId
    && (!provider || !clean(item?.source || item?.provider) || clean(item?.source || item?.provider) === provider);
  const earlier = turns.filter(turn => (turn.requestId == null || turn.requestId !== track.requestId)
    && turn.message?.queueItemId !== track.queueItemId
    && (turn.message?.tracks || []).some(sameSong));
  if (!earlier.length) return null;
  const intro = [...earlier].reverse().find(turn => turn.message?.presentation === 'track_intro');
  return Object.freeze({ timesBefore: earlier.length, lastIntro: intro ? excerpt(intro.visibleText, INTRO_CHARS) : null });
}

/** 这一刻的钩子：强钩子（新的选歌理由、她开口后听众又说了话）、弱钩子（歌的来历、相邻、连续、久未开口）。 */
export function presenceHooks(moment, grounding = EMPTY_GROUNDING) {
  const evidence = moment?.evidence || {};
  const strong = [];
  const weak = [];
  if (grounding.pickReason && grounding.pickFresh) strong.push('pick_reason');
  if (grounding.chatFresh) strong.push('recent_chat');
  if (grounding.songHistory) weak.push('song_history');
  if (evidence.sameArtistAsPrevious === true || evidence.sameAlbumAsPrevious === true) weak.push('adjacent');
  if (Number(evidence.consecutiveCompletions) >= 2) weak.push('completion_streak');
  if (Number(evidence.consecutiveSkips) >= 2) weak.push('skip_streak');
  if (evidence.longGapSinceVoice === true) weak.push('quiet_while');
  return { intrinsic: INTRINSIC_MOMENTS.has(moment?.kind), strong, weak };
}

export function hasPresenceHook(moment, grounding, policy) {
  const hooks = presenceHooks(moment, grounding);
  if (hooks.intrinsic || hooks.strong.length) return true;
  return (policy?.hooks ?? 'any') === 'any' && hooks.weak.length > 0;
}
