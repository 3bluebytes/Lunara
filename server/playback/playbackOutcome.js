// playbackOutcome.js — 从 runtime 已接受的状态转换推出「这一首的收听结果」。
//
// 输入是 runtime.subscribe 给出的 (next, event, previous)，输出是 previous 当前那一首的结果，
// 或 null（这次转换不构成结果）。浏览器分析上报不走这里：只有权威状态机接受的转换才算数。
//
// Python 伪代码：
//   r = classify_playback_transition(next, event, previous)
//   if r: ledger.apply(r.track.queue_item_id, r.outcome)
//
// 共享给反思桥（ListeningReflectionBridge）与推荐决策账本。superseded（切换听歌来源导致的
// 中断）只给账本用：反思桥按既有契约把它当作「没有结果」。
import { PlaybackEventType as P, PlaybackPhase } from './playbackRuntimeTypes.js';

const currentOf = snapshot => snapshot?.queue?.[snapshot.currentIndex] || null;
const ACTIVE = [PlaybackPhase.PLAYING, PlaybackPhase.PAUSED];

/**
 * @returns {{ track: object, outcome: 'completed'|'technical_failure'|'skipped'|'partial'|'superseded',
 *   correlationId: string } | null}
 */
export function classifyPlaybackTransition(next, event, previous) {
  if (!previous || !next || !event) return null;
  const track = currentOf(previous);
  if (!track || !previous.txn) return null;
  const correlationId = previous.txn.correlationId;
  // Switching output suspends the old room. It is not a dislike, skip or partial play.
  if (event.type !== P.TRACK_ENDED && next.activeListeningSessionId !== previous.activeListeningSessionId) {
    return ACTIVE.includes(previous.phase) ? { track, outcome: 'superseded', correlationId } : null;
  }
  const sameIdentity = event.songId === track.songId
    && (!event.programId || event.programId === track.programId)
    && event.correlationId === correlationId;
  const advanced = next.txn?.correlationId !== correlationId || next.phase === PlaybackPhase.EXHAUSTED;
  let outcome = null;
  if (event.type === P.TRACK_ENDED && sameIdentity && advanced
    && event.natural === true && previous.phase === PlaybackPhase.PLAYING) {
    outcome = 'completed';
  } else if (event.type === P.TRACK_FAILED && sameIdentity && next.phase === PlaybackPhase.ERROR) {
    outcome = 'technical_failure';
  } else if ([P.NEXT_REQUESTED, P.CARD_SELECTED, P.TRACK_DISMISS_REQUESTED].includes(event.type)
    && ACTIVE.includes(previous.phase) && advanced) {
    outcome = 'skipped';
  } else if (event.type === P.PROGRAM_COMMITTED && event.delivery === 'replace_now'
    && advanced && ACTIVE.includes(previous.phase)) {
    outcome = 'partial';
  }
  return outcome ? { track, outcome, correlationId } : null;
}
