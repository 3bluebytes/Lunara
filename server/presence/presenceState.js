// presenceState.js — 「她在不在场」的感知层（P0：只观察、不开口）。
//
// 输入只有 runtime 已经接受的快照差分 (previous, event, next)；输出一份有界的
// 每听歌会话状态和若干候选时刻（moment）。这里不写队列、不提交事件、不判断喜恶，
// 曲目级事实都能从权威快照复核。时间只来自调用方注入的 nowMs。
import { effectiveRadioMode } from '../playback/PlaybackRuntime.js';
import { PlaybackEventType as P, PlaybackPhase } from '../playback/playbackRuntimeTypes.js';

export const SESSION_GAP_MS = 30 * 60_000;
const COMPLETED_COVERAGE = 0.8;
const SKIPPED_COVERAGE = 0.2;
const LONG_VOICE_GAP_MS = 15 * 60_000;

export function createPresenceEntry({ sessionId } = {}) {
  return Object.freeze({
    sessionId, sessionStartedAtMs: null, lastActivityAtMs: null,
    listenedMs: 0, playingSinceMs: null,
    activations: 0, completedCount: 0, skipCount: 0, consecutiveCompletions: 0, consecutiveSkips: 0,
    lastOutputTrack: null, lastVoiceAtMs: null,
    // 每场的开口时间（P0 记录的是「本来会开口」的影子决策），用于窗口/整场预算。
    presenceLog: [], momentCounters: {},
  });
}

export const currentTrack = snapshot => snapshot?.queue?.[snapshot.currentIndex] || null;
/**
 * 这首是谁挑的：只读提交时写进 occurrence 的 narration.context，拿不到就是 null（不猜）。
 * her_pick：她自己续播挑的；her_pick_for_request：听众给了方向、具体这首是她挑的；
 * listener_request：听众点名的这首。
 */
export function pickOrigin(track) {
  const context = track?.narration?.context;
  if (!context || typeof context !== 'object') return null;
  if (context.reason === 'auto_continue') return 'her_pick';
  if (context.reason !== 'user_request') return null;
  return context.mode === 'exact' || context.mode === 'explicit' ? 'listener_request' : 'her_pick_for_request';
}
const trackRef = track => track ? { provider: track.provider || track.source || null, songId: track.songId,
  title: track.title || '', artist: track.artist || '', album: track.album || '', queueItemId: track.queueItemId,
  requestId: track.requestId || null, origin: pickOrigin(track) } : null;
// 她选歌时给这一批写下的方向（listeningPlan.request.softPreferences）；接地素材用，不进 trace。
const planDirection = snapshot => String(snapshot?.listeningPlan?.request?.softPreferences || '').trim().slice(0, 200) || null;
export const personOf = (track, snapshot) => track?.virtualPersonId || snapshot?.listeningPlan?.curatorId || 'lunara';
/** 当前听歌伙伴：正在放的这首由谁负责；拿不到就是 Lunara。 */
export const speakerOf = snapshot => personOf(currentTrack(snapshot), snapshot);

/** 已确认的媒体激活：LOADING → PLAYING 且是新的 occurrence（重连确认不算新激活）。 */
function confirmedActivation(previous, event, next) {
  return event.type === P.TRACK_STARTED && previous.phase === PlaybackPhase.LOADING
    && next.phase === PlaybackPhase.PLAYING && Boolean(next.txn?.correlationId);
}

/** 本曲在这次差分前的播放位置；拿不到可信位置时返回 null（宁可不判断）。 */
function positionBefore(previous, event, nowMs) {
  const reported = Number(event.playedSeconds ?? event.positionSeconds);
  if (Number.isFinite(reported) && reported >= 0) return reported;
  if (previous.phase === PlaybackPhase.PLAYING && previous.txn?.startedAtMs != null) {
    return Math.max(0, Number(previous.txn.startedPositionSeconds) || 0) + Math.max(0, nowMs - previous.txn.startedAtMs) / 1000;
  }
  if (previous.phase === PlaybackPhase.PAUSED && Number.isFinite(Number(previous.positionSeconds))) return Number(previous.positionSeconds);
  return null;
}

function coverage(previous, event, nowMs) {
  const duration = Number(currentTrack(previous)?.duration);
  const position = positionBefore(previous, event, nowMs);
  if (!(duration > 0) || position == null) return null;
  return position / duration;
}

/** 新 occurrence 是否已由陪伴模式授予自动串词（legacy 会话逐首都有）。 */
function introGranted(next) {
  if (next.companionModeId == null) return true;
  const queueItemId = next.txn?.queueItemId;
  return (next.modeCountedOccurrences || []).some(entry => entry.queueItemId === queueItemId && entry.eligible === true);
}

function bumpCounters(counters, kind) {
  const entry = counters[kind] || { spoken: 0, sinceSpoken: null };
  return { ...counters, [kind]: { ...entry, sinceSpoken: entry.sinceSpoken == null ? null : entry.sinceSpoken + 1 } };
}

/**
 * reducePresence(entry, {previous, event, next, nowMs}) → { entry, moments }
 * 纯函数；调用方保证 previous 属于 entry.sessionId 对应的活动听歌会话。
 */
export function reducePresence(entry, { previous, event, next, nowMs }) {
  const moments = [];
  if (!previous || !next || !event) return { entry, moments };
  const state = { ...entry, momentCounters: { ...entry.momentCounters } };
  const sessionId = state.sessionId;
  const switched = next.activeListeningSessionId !== previous.activeListeningSessionId;

  // 真实收听时长：只累计 PLAYING 区间；离开当前会话也结算。
  const wasPlaying = previous.phase === PlaybackPhase.PLAYING && state.playingSinceMs != null;
  const isPlaying = !switched && next.phase === PlaybackPhase.PLAYING;
  if (wasPlaying && !isPlaying) { state.listenedMs += Math.max(0, nowMs - state.playingSinceMs); state.playingSinceMs = null; }
  if (!wasPlaying && isPlaying) state.playingSinceMs = nowMs;
  // 持续播放中的任何已接受事件都结算到此刻，状态随时可读。
  if (wasPlaying && isPlaying) { state.listenedMs += Math.max(0, nowMs - state.playingSinceMs); state.playingSinceMs = nowMs; }

  // 切换听歌来源、技术失败都不是跳过/听完，也不产生时刻。
  // 「最近活动」只算正在听的时刻：空闲时提交节目、切源到未开播的会话都不算一起听过。
  const listening = previous.phase === PlaybackPhase.PLAYING || (!switched && next.phase === PlaybackPhase.PLAYING);
  if (switched || event.type === P.TRACK_FAILED) {
    if (listening) state.lastActivityAtMs = nowMs;
    return { entry: Object.freeze(state), moments };
  }

  const before = currentTrack(previous);
  const key = (kind, bucket, person) => `${sessionId}/${person}/${kind}/${bucket}`;
  const sameOccurrence = before && previous.txn
    && event.songId === before.songId && event.correlationId === previous.txn.correlationId;
  const advanced = Boolean(previous.txn) && (next.txn?.correlationId !== previous.txn.correlationId
    || next.phase === PlaybackPhase.EXHAUSTED);

  if (event.type === P.TRACK_ENDED && event.natural === true && sameOccurrence && advanced
    && previous.phase === PlaybackPhase.PLAYING) {
    const ratio = coverage(previous, event, nowMs);
    if (ratio != null && ratio >= COMPLETED_COVERAGE) {
      state.completedCount += 1; state.consecutiveCompletions += 1; state.consecutiveSkips = 0;
      state.momentCounters = bumpCounters(state.momentCounters, 'track_completed');
      const person = personOf(before, previous);
      moments.push({ kind: 'track_completed', personId: person, sessionId,
        triggerKey: key('track_completed', `${before.queueItemId}:${previous.txn.correlationId}`, person),
        evidence: { track: trackRef(before), consecutiveCompletions: state.consecutiveCompletions } });
    }
  } else if ([P.NEXT_REQUESTED, P.CARD_SELECTED].includes(event.type) && advanced
    && [PlaybackPhase.PLAYING, PlaybackPhase.PAUSED].includes(previous.phase)) {
    const ratio = coverage(previous, event, nowMs);
    if (ratio != null) {
      state.consecutiveCompletions = 0;
      if (ratio < SKIPPED_COVERAGE) {
        state.skipCount += 1; state.consecutiveSkips += 1;
        state.momentCounters = bumpCounters(state.momentCounters, 'track_skipped');
        const person = personOf(before, previous);
        moments.push({ kind: 'track_skipped', personId: person, sessionId,
          triggerKey: key('track_skipped', `${before.queueItemId}:${previous.txn.correlationId}`, person),
          evidence: { track: trackRef(before), consecutiveSkips: state.consecutiveSkips } });
      } else state.consecutiveSkips = 0;
    }
  }

  if (next.phase === PlaybackPhase.EXHAUSTED && previous.phase !== PlaybackPhase.EXHAUSTED && !effectiveRadioMode(next)) {
    const person = personOf(before, previous);
    moments.push({ kind: 'queue_exhausted', personId: person, sessionId,
      triggerKey: key('queue_exhausted', `${previous.txn?.correlationId || next.queueVersion || 0}`, person),
      evidence: { track: trackRef(before), listenedMs: state.listenedMs } });
  }

  if (confirmedActivation(previous, event, next) && next.txn.correlationId !== state.lastActivationCorrelationId) {
    const track = currentTrack(next);
    const person = personOf(track, next);
    const newSession = state.lastActivityAtMs == null ? state.sessionStartedAtMs == null
      : nowMs - state.lastActivityAtMs >= SESSION_GAP_MS;
    if (newSession) {
      Object.assign(state, { sessionStartedAtMs: nowMs, listenedMs: 0, activations: 0, completedCount: 0, skipCount: 0,
        consecutiveCompletions: 0, consecutiveSkips: 0, presenceLog: [], momentCounters: {} });
      state.playingSinceMs = nowMs;
    }
    const previousTrack = state.lastOutputTrack;
    state.activations += 1;
    state.lastActivationCorrelationId = next.txn.correlationId;
    state.momentCounters = bumpCounters(state.momentCounters, 'boundary_without_intro');
    state.lastOutputTrack = { ...trackRef(track), correlationId: next.txn.correlationId };
    if (newSession) {
      moments.push({ kind: 'session_open', personId: person, sessionId,
        triggerKey: key('session_open', String(nowMs), person),
        evidence: { track: trackRef(track), gapMs: entry.lastActivityAtMs == null ? null : nowMs - entry.lastActivityAtMs } });
    } else if (!introGranted(next)) {
      moments.push({ kind: 'boundary_without_intro', personId: person, sessionId,
        triggerKey: key('boundary_without_intro', `${track?.queueItemId}:${next.txn.correlationId}`, person),
        evidence: {
          track: trackRef(track),
          sameArtistAsPrevious: Boolean(previousTrack?.artist && previousTrack.artist === track?.artist),
          sameAlbumAsPrevious: Boolean(previousTrack?.album && previousTrack.album === track?.album),
          consecutiveSkips: state.consecutiveSkips,
          longGapSinceVoice: state.lastVoiceAtMs != null && nowMs - state.lastVoiceAtMs >= LONG_VOICE_GAP_MS,
        } });
    }
  }

  for (const moment of moments) moment.evidence.planDirection = planDirection(moment.kind === 'session_open'
    || moment.kind === 'boundary_without_intro' ? next : previous);

  // 串词真正可听也是自动人声，参与最小间隔。
  if (event.type === P.NARRATION_DELIVERY_AUDIBLE) state.lastVoiceAtMs = nowMs;
  if (listening) state.lastActivityAtMs = nowMs;
  return { entry: Object.freeze(state), moments };
}

/** 影子/真实开口后的记账：刷新人声时间、预算日志和该时刻的计数。 */
export function recordPresenceSpoken(entry, moment, nowMs) {
  const counter = entry.momentCounters[moment.kind] || { spoken: 0, sinceSpoken: null };
  return Object.freeze({ ...entry, lastVoiceAtMs: nowMs,
    presenceLog: [...entry.presenceLog, nowMs].slice(-16),
    momentCounters: { ...entry.momentCounters, [moment.kind]: { spoken: counter.spoken + 1, sinceSpoken: 0 } } });
}
