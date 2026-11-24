// trackLineFreshness.js — 没说出口的串词，到开口前核对一次还算不算数。
//
// 串词写好后可能隔很久才轮到。这几种情况那段话已经不对了，直接作废，这首歌安静播放：
// 写得太久、房间成员变了、host 写完之后已经在聊天里提过这首歌。
// 没有 writtenAt 的是早先就存着的串词，没有依据判断，照常交付。

import { mentionsIdentity } from './ProgramNarrationComposer.js';

export const TRACK_LINE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const RECENT_TURNS = 20;

export function createTrackLineFreshness({ conversationStore, now = Date.now, maxAgeMs = TRACK_LINE_MAX_AGE_MS } = {}) {
  return (track, sessionId) => {
    const narration = track?.narration;
    if (!narration?.writtenAt) return null;
    if (now() - narration.writtenAt > maxAgeMs) return 'too-old';
    const room = conversationStore.getSession(sessionId);
    if (narration.membershipRevision != null && room && room.membershipRevision !== narration.membershipRevision) {
      return 'membership-changed';
    }
    const named = conversationStore.listTurns(sessionId, { limit: RECENT_TURNS, visibleOnly: true }).some(turn =>
      turn.role === 'assistant' && turn.createdAt > narration.writtenAt
      && turn.message?.presentation !== 'track_intro'
      && turn.speakerVirtualPersonId === track.virtualPersonId
      // 提交这首歌的那一轮确认不算：串词本来就是接着那一轮写的。
      && !(track.requestId && turn.requestId === track.requestId)
      && mentionsIdentity(turn.message?.content || '', track.title));
    return named ? 'host-already-named' : null;
  };
}
