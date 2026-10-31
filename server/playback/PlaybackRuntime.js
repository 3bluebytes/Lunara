import {
  DEFAULT_IDEMPOTENCY_WINDOW,
  DEFAULT_NARRATION_POLICY,
  PLAYBACK_RUNTIME_SCHEMA_VERSION,
  PlaybackCommandType,
  PlaybackEffectType,
  PlaybackEventType,
  PlaybackPhase,
  cloneRuntimeValue,
  deepFreeze,
  isPlaybackRuntimeSnapshot,
  normalizeRuntimeTrack,
  validatePlaybackEvent,
} from './playbackRuntimeTypes.js';
import { normalizePerformance, toPlainText } from '../tts/performance/markers.js';
import { synthesisReason, synthesisElapsed } from '../tts/boundedSynthesis.js';
import { CONTINUATION_LOOKAHEAD } from '../program/continuationBudget.js';
import {
  AUTOMATIC_NARRATION_MIN_INTERVAL_MS,
  DEFAULT_COMPANION_MODE_ID,
  isCompanionModeId,
  occurrencePositionAutoEligible,
  resolveCompanionModePolicy,
} from './companionModes.js';

/** A failed automatic continuation is retried on recovery at most this many times per boundary. */
export const MAX_CONTINUATION_ATTEMPTS = 3;

/**
 * 提前续选阈值：当前曲目之后剩余已提交曲目数降到该值时，不等队列耗尽就
 * 开始为这个边界找后面的歌（耗尽路径仍是兜底，不是唯一触发）。
 * 数值与“一次补几首”共享同一份预算定义，见 program/continuationBudget.js。
 */
export { CONTINUATION_LOOKAHEAD };

// Epoch 计数只需保证“同一 occurrence 只计一次”与顺序稳定；上限防止快照无限增长。
const MAX_MODE_COUNTED_OCCURRENCES = 64;

export function createPlaybackRuntimeState(options = {}) {
  return deepFreeze({
    schemaVersion: PLAYBACK_RUNTIME_SCHEMA_VERSION,
    version: 0,
    queue: [],
    currentIndex: -1,
    currentSongId: null,
    phase: PlaybackPhase.IDLE,
    txn: null,
    activationSeq: 0,
    radioMode: options.radioMode !== false,
    radioModeOverride: null,
    pendingContinuation: null,
    processedEventIds: [],
    completedCorrelationIds: [],
    lastError: null,
    diagnostics: [],
    activeListeningSessionId: options.listeningSessionId || 'conversation:primary',
    outputGeneration: 0,
    narrationPolicy: { ...DEFAULT_NARRATION_POLICY, ...(options.narrationPolicy || {}) },
    suspendedSessions: {},
    queueVersion: 0,
    positionSeconds: 0,
    hasStarted: false,
    listeningPlan: null,
    pendingSwitch: null,
    lastOutputTrack: null,
    // 陪伴模式状态：新会话默认多聊一点；缺字段/显式 null 的旧 snapshot 由 hydrate
    // 归一到同一默认，不存在“未设置·沿用原行为”的第四种策略。
    companionModeId: isCompanionModeId(options.companionModeId)
      ? options.companionModeId : DEFAULT_COMPANION_MODE_ID,
    modePolicyVersion: 1,
    modeRevision: 0,
    modeSource: 'default',
    modeEpoch: 0,
    modeActivationCount: 0,
    modeCountedOccurrences: [],
    lastAutomaticNarrationAtMs: null,
  });
}

const SESSION_FIELDS = ['queue', 'currentIndex', 'currentSongId', 'phase', 'txn', 'radioMode', 'radioModeOverride',
  'queueVersion', 'positionSeconds', 'hasStarted', 'listeningPlan', 'pendingContinuation', 'lastError',
  'companionModeId', 'modePolicyVersion', 'modeRevision', 'modeSource', 'modeEpoch', 'modeActivationCount',
  'modeCountedOccurrences', 'lastAutomaticNarrationAtMs'];

// A requested narration may speak long after the automatic insertion window closed.
const REQUESTED_NARRATION_MAX_OFFSET_MS = 24 * 60 * 60 * 1000;

function sessionValue(state) {
  return Object.fromEntries(SESSION_FIELDS.map(key => [key, cloneRuntimeValue(state[key])]));
}

/** A scoped view never includes another conversation's queue, preferences or history. */
export function listeningSnapshot(state, listeningSessionId = state.activeListeningSessionId) {
  const value = listeningSessionId === state.activeListeningSessionId ? sessionValue(state)
    : state.suspendedSessions[listeningSessionId] || sessionValue(createPlaybackRuntimeState());
  return deepFreeze({ ...cloneRuntimeValue(value), listeningSessionId, conversationId: listeningSessionId,
    active: listeningSessionId === state.activeListeningSessionId, runtimeVersion: state.version, outputGeneration: state.outputGeneration });
}

function switchListeningSession(state, id, commands, positionSeconds = null, { activate = true, effects = [], nowMs = Date.now() } = {}) {
  if (id === state.activeListeningSessionId) return;
  if (state.hasStarted && currentTrack(state)) state.lastOutputTrack = { title: currentTrack(state).title, artist: currentTrack(state).artist, songId: state.currentSongId };
  if (Number.isFinite(positionSeconds)) state.positionSeconds = Math.max(0, positionSeconds);
  const saved = sessionValue(state);
  saved.phase = saved.currentIndex >= 0 ? PlaybackPhase.PAUSED : PlaybackPhase.IDLE;
  saved.txn = null;
  saved.pendingContinuation = null;
  state.suspendedSessions[state.activeListeningSessionId] = saved;
  const incoming = state.suspendedSessions[id] || sessionValue(createPlaybackRuntimeState());
  Object.assign(state, incoming);
  delete state.suspendedSessions[id];
  state.activeListeningSessionId = id;
  state.outputGeneration += 1;
  state.pendingSwitch = null;
  commands.push({ type: PlaybackCommandType.STOP_PLAYBACK });
  if (activate && state.currentIndex >= 0) resumeCurrentOccurrence(state, commands, effects, nowMs);
}

/** 恢复当前 occurrence：已开始过的接着播，没开始过的重新激活。 */
function resumeCurrentOccurrence(state, commands, effects = [], nowMs = Date.now()) {
  const item = currentTrack(state);
  if (!item) return false;
  if (state.hasStarted) { resumeSavedTrack(state, commands, effects, nowMs); return true; }
  return createActivation(state, state.currentIndex, 'listening_session_resumed', commands, effects, nowMs);
}

function resumeSavedTrack(state, commands, effects = [], nowMs = Date.now()) {
  const track = currentTrack(state);
  if (!track) return;
  state.activationSeq += 1;
  const correlationId = `runtime-${state.activationSeq}-${track.queueItemId}`;
  state.phase = PlaybackPhase.LOADING;
  state.hasStarted = false;
  // 与 createActivation 同口径：新的激活不继承上一次的失败。
  state.lastError = null;
  state.txn = { correlationId, queueItemId: track.queueItemId, requestId: track.requestId,
    programId: track.programId, songId: track.songId, phase: PlaybackPhase.LOADING,
    reason: 'listening_session_resumed', narrationDelivery: initialNarrationDelivery(state, track, false),
    modeRevision: state.modeRevision,
    narrationAutoEligible: occurrenceAutoEligible(state, track.queueItemId),
    startedAtMs: null,
    startedPositionSeconds: state.positionSeconds };
  commands.push({ type: PlaybackCommandType.PLAY_TRACK, ...commandIdentity(state, track, correlationId),
    url: track.url, positionSeconds: state.positionSeconds, resume: true });
  discardStalePredecessorNarration(state, track);
  requestNarrationForActivation(state, track, correlationId, effects);
  prepareUpcomingNarration(state, state.currentIndex, effects);
  state.txn.narrationGenerationRevision = track.narration.generationRevision;
  state.txn.activatedAtMs = nowMs;
}

function mutableCopy(state) {
  return cloneRuntimeValue(state);
}

function cap(array, limit) {
  return array.length <= limit ? array : array.slice(array.length - limit);
}

function commandIdentity(state, track, correlationId) {
  return {
    runtimeVersion: state.version + 1,
    requestId: track.requestId,
    programId: track.programId,
    songId: track.songId,
    queueItemId: track.queueItemId,
    correlationId,
    listeningSessionId: state.activeListeningSessionId,
    conversationId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
    virtualPersonId: track.virtualPersonId,
    voiceProfileId: track.voiceProfileId,
  };
}

function currentTrack(state) {
  return state.currentIndex >= 0 ? state.queue[state.currentIndex] || null : null;
}

function narrationEffect(type, state, track, correlationId, previousTrack = state.lastOutputTrack) {
  return {
    type,
    queueItemId: track.queueItemId,
    generationRevision: track.narration.generationRevision,
    // 准备结果携带模式 revision：模式变化后，旧 revision 的迟到结果不能再开口。
    modeRevision: state.modeRevision,
    effectiveCompanionModeId: effectiveModePolicy(state).id,
    listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
    requestId: track.requestId,
    programId: track.programId,
    songId: track.songId,
    correlationId,
    virtualPersonId: track.virtualPersonId,
    recommendedBy: track.recommendedBy || null,
    voiceProfileId: track.narration.voiceProfileId || track.voiceProfileId,
    previousTrack,
    transitionReason: state.txn?.reason || null,
    track,
  };
}

function trackIdentity(track) {
  return track ? { title: track.title, artist: track.artist, songId: track.songId } : null;
}

/** 会话的自动续播开关；没写过偏好的会话默认开。 */
export function effectiveRadioMode(sessionState) {
  return sessionState.radioMode !== false;
}

/** 本会话当前生效的模式策略；非法/空 id 兜底到默认模式，而不是第四种策略。 */
function effectiveModePolicy(sessionState) {
  return resolveCompanionModePolicy(sessionState.companionModeId)
    || resolveCompanionModePolicy(DEFAULT_COMPANION_MODE_ID);
}

/**
 * 旧 snapshot 的陪伴模式字段归一：缺字段/显式 null/非法 id 一律回到默认模式与
 * 默认来源；有效的显式/场景/默认选择原样保留。计数、epoch、revision 与上次自动开口
 * 时间不因恢复被清空，也不补讲。
 */
function normalizeCompanionModeFields(sessionState) {
  const valid = isCompanionModeId(sessionState.companionModeId);
  if (!valid) sessionState.companionModeId = DEFAULT_COMPANION_MODE_ID;
  sessionState.modePolicyVersion = 1;
  sessionState.modeRevision = Math.max(0, Number.parseInt(sessionState.modeRevision, 10) || 0);
  // 只有原本就有效的来源才保留；缺失、旧 'legacy' 与无效值都归到默认来源。
  sessionState.modeSource = valid && ['explicit', 'scene', 'default'].includes(sessionState.modeSource)
    ? sessionState.modeSource : 'default';
  sessionState.modeEpoch = Math.max(0, Number.parseInt(sessionState.modeEpoch, 10) || 0);
  sessionState.modeActivationCount = Math.max(0, Number.parseInt(sessionState.modeActivationCount, 10) || 0);
  sessionState.modeCountedOccurrences = (Array.isArray(sessionState.modeCountedOccurrences)
    ? sessionState.modeCountedOccurrences : [])
    .filter(entry => entry && typeof entry.queueItemId === 'string' && entry.queueItemId)
    .slice(-MAX_MODE_COUNTED_OCCURRENCES)
    .map(entry => ({ queueItemId: entry.queueItemId, position: Math.max(0, Number(entry.position) || 0),
      eligible: entry.eligible === true }));
  // 上次自动开口时间：缺失/ null 保持为“没有开口过”；否则保留原数值。
  // （不能把 null 当 0，那会凭空制造一个早于所有播放的“上次开口”。）
  const lastAutomaticNarrationAtMs = sessionState.lastAutomaticNarrationAtMs;
  sessionState.lastAutomaticNarrationAtMs = lastAutomaticNarrationAtMs != null
    && Number.isFinite(Number(lastAutomaticNarrationAtMs))
    ? Number(lastAutomaticNarrationAtMs) : null;
}

/**
 * 旧未设置会话的 txn 可能没有 modeRevision（早于陪伴模式的快照）。只把该缺失字段
 * 回填成归一后的会话 revision：不清媒体身份、不补讲、不重置计数；已有值原样保留。
 */
function backfillTxnModeRevision(sessionState) {
  if (sessionState.txn && typeof sessionState.txn === 'object' && sessionState.txn.modeRevision == null) {
    sessionState.txn.modeRevision = Number(sessionState.modeRevision) || 0;
  }
}

/**
 * 某 occurrence 的自动串词资格。已计数的 occurrence 使用计数时记录的资格
 * （epoch 在真实模式切换时重建，因此记录值与当前策略一致）；未计数的从当前
 * 游标向后预测它的名次——尚未被媒体确认的当前 occurrence 也占一个名次。
 */
function occurrenceAutoEligible(sessionState, queueItemId) {
  const policy = effectiveModePolicy(sessionState);
  const countedEntries = sessionState.modeCountedOccurrences || [];
  const counted = countedEntries.find(entry => entry.queueItemId === queueItemId);
  if (counted) return counted.eligible === true;
  const isCounted = id => countedEntries.some(entry => entry.queueItemId === id);
  let position = Number(sessionState.modeActivationCount || 0);
  for (let index = Math.max(0, sessionState.currentIndex || 0); index < sessionState.queue.length; index += 1) {
    const item = sessionState.queue[index];
    if (!item || isCounted(item.queueItemId)) continue;
    position += 1;
    if (item.queueItemId === queueItemId) return occurrencePositionAutoEligible(policy, position);
  }
  return occurrencePositionAutoEligible(policy, position + 1);
}

/**
 * 一个真实媒体激活被 runtime 接受：在当前模式 epoch 内按不同 occurrence 首次
 * 接受计数。排队、URL 解析、seek、pause/resume、重连、重复确认都不计数。
 */
function acceptMediaActivationForMode(state) {
  const txn = state.txn;
  if (!txn?.queueItemId) return;
  if ((state.modeCountedOccurrences || []).some(entry => entry.queueItemId === txn.queueItemId)) return;
  const policy = effectiveModePolicy(state);
  const position = Number(state.modeActivationCount || 0) + 1;
  state.modeActivationCount = Number(state.modeActivationCount || 0) + 1;
  state.modeCountedOccurrences = [...(state.modeCountedOccurrences || []),
    { queueItemId: txn.queueItemId, position, eligible: occurrencePositionAutoEligible(policy, position) }]
    .slice(-MAX_MODE_COUNTED_OCCURRENCES);
}

/**
 * 交付时刻的自动串词阻断原因。用户明确请求的介绍绕过模式频率与间隔，但
 * 身份、窗口与人声串行规则照旧。`waitMs` 表示只是还没到最小间隔，仍可等待。
 */
function automaticNarrationBlock(state, nowMs) {
  const txn = state.txn;
  if (!txn) return { reason: 'no-activation' };
  if (txn.narrationUserRequested === true) return null;
  // 所有会话都有具体模式：自动口播一律受节奏与最小间隔约束。
  const policy = effectiveModePolicy(state);
  if (txn.modeRevision !== state.modeRevision) return { reason: 'mode-changed' };
  if (!policy.automaticNarration || txn.narrationAutoEligible === false) return { reason: 'mode-ineligible' };
  const lastSpokenAt = state.lastAutomaticNarrationAtMs;
  if (lastSpokenAt != null && Number.isFinite(Number(lastSpokenAt))) {
    const earliest = Number(lastSpokenAt) + AUTOMATIC_NARRATION_MIN_INTERVAL_MS;
    if (nowMs < earliest) {
      // 等待只有在自动启动窗口内还来得及才有意义；否则这是错过，不补讲。
      const windowEndMs = Number(txn.startedAtMs) + Math.max(0, Number(state.narrationPolicy?.maxStartOffsetMs) || 0);
      if (earliest > windowEndMs) return { reason: 'auto-interval-missed' };
      return { waitMs: earliest - nowMs };
    }
  }
  return null;
}

/**
 * Prepare the narration of the following committed occurrence while the current
 * track plays, so its introduction is ready before that occurrence activates.
 * Never speaks, activates or advances anything, and stays bounded to one item.
 * Only a occurrence predicted eligible under the current companion mode is
 * prepared; music-only and cadence-ineligible occurrences start no work.
 */
function prepareUpcomingNarration(state, index, effects) {
  const upcoming = state.queue[index + 1];
  if (!upcoming) return;
  if (!occurrenceAutoEligible(state, upcoming.queueItemId)) return;
  const narration = upcoming.narration;
  // A failed narration is not retried in the background, and an introduction that was
  // already heard is not rewritten; its activation decides.
  if (!narration?.context || narration.status === 'failed' || narration.status === 'preparing'
    || narration.spoken === true) return;
  const correlationId = `prepare:${upcoming.queueItemId}:${narration.generationRevision}`;
  const predecessor = trackIdentity(state.queue[index]);
  if (narration.status === 'ready') {
    if (narration.assetStatus === 'ready' || narration.assetStatus === 'resolving') return;
    narration.assetStatus = 'resolving';
    effects.push(narrationEffect(PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET, state, upcoming, correlationId, predecessor));
    return;
  }
  narration.status = 'preparing';
  narration.generationRevision += 1;
  effects.push(narrationEffect(PlaybackEffectType.PREPARE_TRACK_NARRATION, state, upcoming,
    `prepare:${upcoming.queueItemId}:${narration.generationRevision}`, predecessor));
}

/**
 * Narration prepared ahead of an activation predicted its predecessor. If the
 * track that actually played before this one differs, the prepared text must not
 * be delivered as-is: it is invalidated for a fresh preparation.
 */
function discardStalePredecessorNarration(state, track) {
  const narration = track?.narration;
  const preparedFor = narration?.previousSongId || null;
  if (!narration || !preparedFor || narration.status !== 'ready') return;
  // An introduction that has already been heard is never automatically delivered
  // again, so rewriting it would only burn a model call and a TTS render.
  if (narration.spoken === true) return;
  const actual = state.lastOutputTrack?.songId || null;
  if (preparedFor === actual) return;
  narration.status = 'absent';
  narration.assetStatus = 'missing';
  narration.ttsUrl = null;
  narration.previousSongId = null;
  state.diagnostics.push({ type: 'track-narration-predecessor-changed', queueItemId: track.queueItemId,
    preparedFor, actual });
}

/**
 * The narration work a fresh activation needs. An introduction that has already been
 * heard owes nothing: it is neither rewritten nor re-resolved, because only an explicit
 * listener request re-opens it. A failed artifact is left failed for the same reason.
 * Automatic preparation additionally requires companion-mode eligibility; an explicit
 * listener request re-opens the artifact regardless of the automatic cadence.
 */
function requestNarrationForActivation(state, track, correlationId, effects) {
  if (track.narration.spoken === true) return;
  // 只听歌或节奏不合格的 occurrence 不启动任何自动模型/TTS 工作（含资产重解析）。
  if (!occurrenceAutoEligible(state, track.queueItemId)) return;
  if (track.narration.status === 'ready') {
    if (track.narration.assetStatus === 'resolving') return;
    track.narration.assetStatus = 'resolving';
    effects.push(narrationEffect(PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET, state, track, correlationId));
    return;
  }
  if (!track.narration.context || track.narration.status === 'preparing') return;
  track.narration.status = 'preparing';
  track.narration.generationRevision += 1;
  effects.push(narrationEffect(PlaybackEffectType.PREPARE_TRACK_NARRATION, state, track, correlationId));
}

/**
 * An introduction belongs to its occurrence and is delivered at most once. It has
 * already been spoken when the artifact says so, in which case a new activation owes
 * the listener nothing: a card tap on the playing song, a retry, or returning to this
 * session must not rewrite it and must not speak it again. Only an in-flight delivery
 * for the same occurrence is carried over, and an explicit request re-opens it.
 */
function initialNarrationDelivery(state, track, reattachesCurrent) {
  if (track.narration.spoken === true) return 'delivered';
  const inFlight = state.txn?.narrationDelivery;
  if (reattachesCurrent && ['queued', 'starting', 'speaking'].includes(inFlight)) return inFlight;
  return 'waiting';
}


function createActivation(state, index, reason, commands, effects = [], nowMs = Date.now()) {
  const track = state.queue[index];
  if (!track) return false;
  const outgoing = currentTrack(state);
  // Activating the occurrence that is already current — tapping the card of the song
  // that is playing, pressing the play/retry control after a media failure, returning
  // to this session's saved item — is an idempotent re-attach of that same occurrence,
  // not a new playback. It must keep the confirmed position instead of restarting the
  // track, must keep the introduction it already owns instead of rewriting or repeating
  // it, and must keep the transaction identity so a client that still holds the media is
  // left untouched.
  const reattachesCurrent = outgoing != null && state.txn != null
    && state.txn.queueItemId === track.queueItemId;
  if (state.hasStarted && outgoing && !reattachesCurrent) {
    state.lastOutputTrack = { title: outgoing.title, artist: outgoing.artist, songId: outgoing.songId };
  }
  state.activationSeq += 1;
  const correlationId = reattachesCurrent
    ? state.txn.correlationId
    : `runtime-${state.activationSeq}-${track.queueItemId}`;
  const positionSeconds = reattachesCurrent ? Math.max(0, Number(state.positionSeconds) || 0) : 0;
  state.currentIndex = index;
  state.phase = PlaybackPhase.LOADING;
  state.queueVersion += 1;
  state.currentSongId = track.songId;
  state.positionSeconds = positionSeconds;
  state.hasStarted = reattachesCurrent ? state.hasStarted : false;
  state.lastError = null;
  state.pendingContinuation = null;
  const narrationDelivery = initialNarrationDelivery(state, track, reattachesCurrent);
  state.txn = {
    correlationId,
    queueItemId: track.queueItemId,
    requestId: track.requestId,
    programId: track.programId,
    songId: track.songId,
    reason,
    phase: PlaybackPhase.LOADING,
    narrationDelivery,
    // 模式 revision 与该 occurrence 的资格预测随激活快照进 txn：交付前重验。
    modeRevision: state.modeRevision,
    narrationAutoEligible: occurrenceAutoEligible(state, track.queueItemId),
    narrationGenerationRevision: track.narration.generationRevision,
    activatedAtMs: nowMs,
    startedAtMs: null,
    startedPositionSeconds: 0,
  };
  const identity = commandIdentity(state, track, correlationId);
  commands.push({ type: PlaybackCommandType.PLAY_TRACK, ...identity, url: track.url,
    ...(positionSeconds > 0 ? { positionSeconds, resume: true } : {}) });
  // The predecessor only changed when this activation actually moves to another
  // occurrence; a re-attach of the same one keeps the introduction it was prepared for.
  if (!reattachesCurrent) discardStalePredecessorNarration(state, track);
  requestNarrationForActivation(state, track, correlationId, effects);
  prepareUpcomingNarration(state, index, effects);
  state.txn.narrationGenerationRevision = track.narration.generationRevision;
  state.txn.activatedAtMs = nowMs;
  // 换到这首歌时就评估提前续选（放在串词准备之后）：剩余曲目降到阈值内，
  // 不等最后一首播完才找歌。同曲 reattach 不重复评估。
  if (!reattachesCurrent) maybePrefetchContinuation(state, effects);
  return true;
}

function eventMatchesCurrent(state, event, { correlation = true } = {}) {
  const track = currentTrack(state);
  if (!track) return false;
  if (event.outputGeneration != null && event.outputGeneration !== state.outputGeneration) return false;
  if (event.listeningSessionId && event.listeningSessionId !== state.activeListeningSessionId) return false;
  if (event.songId != null && String(event.songId) !== track.songId) return false;
  if (event.programId != null && String(event.programId) !== track.programId) return false;
  if (correlation && event.correlationId != null && String(event.correlationId) !== String(state.txn?.correlationId || '')) return false;
  return true;
}

function playCurrentAfterTts(state, commands, degradedReason = null) {
  const track = currentTrack(state);
  if (!track || !state.txn) return false;
  state.phase = PlaybackPhase.LOADING;
  state.txn.phase = PlaybackPhase.LOADING;
  if (degradedReason) state.diagnostics.push({ type: 'tts-degraded', reason: degradedReason, songId: track.songId });
  commands.push({
    type: PlaybackCommandType.PLAY_TRACK,
    ...commandIdentity(state, track, state.txn.correlationId),
    url: track.url,
  });
  return true;
}

function commitProgram(state, event, commands, effects, nowMs) {
  const tracks = event.tracks.map((track, index) => structuredClone(normalizeRuntimeTrack({
    ...track,
    conversationId: track.conversationId || track.listeningSessionId || state.activeListeningSessionId,
    // The commit event is the stable occurrence seed. Re-committing the same
    // program later must create a new queue occurrence, while event replay is
    // already stopped by event idempotency.
    occurrenceKey: event.eventId,
  }, index)));
  if (event.listeningPlan) {
    state.listeningPlan = structuredClone(event.listeningPlan);
    if (state.listeningPlan.request.mode === 'exact') state.listeningPlan.request.targets = tracks.map(track => ({
      songId: track.songId, source: track.source, title: track.title, artist: track.artist,
    }));
    state.radioMode = state.radioModeOverride ?? (state.listeningPlan.request.continueMode !== 'off');
  }
  let retained = state.queue;
  let firstNewIndex = retained.length;
  if (event.delivery === 'replace_now') {
    retained = state.currentIndex < 0 ? [] : state.queue.slice(0, state.currentIndex);
    firstNewIndex = retained.length;
  } else if (event.delivery === 'after_current') {
    retained = state.currentIndex < 0 ? [] : state.queue.slice(0, state.currentIndex + 1);
    firstNewIndex = retained.length;
  }
  state.queue = [...retained, ...tracks];
  state.queueVersion += 1;
  // auto_continue 在耗尽边界提交时激活第一首新歌（EXHAUSTED 条件）；播放中
  // 到达的提前续选提交只追加队列，绝不打断当前歌——这是滚动供歌，不是切歌。
  const shouldActivate = event.delivery === 'replace_now'
    || state.currentIndex < 0
    || state.phase === PlaybackPhase.EXHAUSTED;
  if (shouldActivate) createActivation(state, firstNewIndex, event.source === 'auto_continue' ? 'auto_continue' : 'program_committed', commands, effects, nowMs);
}

function exhaustOrContinue(state, event, effects) {
  state.phase = PlaybackPhase.EXHAUSTED;
  state.txn = null;
  // 手动跳过队尾与自然播完一样请求一次续选；自动续播关闭时诚实停止。
  const wantsContinuation = event.natural === true || event.manual === true;
  if (!effectiveRadioMode(state) || !wantsContinuation) return;
  requestContinuation(state, effects);
}

function requestContinuation(state, effects) {
  if (state.pendingContinuation?.status === 'requested') return;
  const boundaryKey = `${state.version + 1}:${state.currentSongId || 'none'}:${state.queue.length}`;
  state.lastError = null;
  state.pendingContinuation = { boundaryKey, status: 'requested', attempts: 1 };
  effects.push({
    type: PlaybackEffectType.REQUEST_CONTINUATION,
    runtimeVersion: state.version + 1,
    boundaryKey,
    attempt: state.pendingContinuation.attempts,
    songId: state.currentSongId,
    listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  });
}

/**
 * 提前续选评估点：每次真实换到一首歌（非同曲 reattach）时，若之后剩余
 * 曲目已降到阈值内就提前请求一次续选。提交回来时只追加队列，不打断
 * 当前歌；边界由 requestContinuation 的 requested 守卫与 boundary key
 * 校验保证最多一个 in-flight 请求，换歌本身会清除旧边界并重新评估。
 */
function maybePrefetchContinuation(state, effects) {
  if (!effectiveRadioMode(state)) return;
  const remainingAfterCurrent = state.queue.length - 1 - state.currentIndex;
  if (remainingAfterCurrent > CONTINUATION_LOOKAHEAD) return;
  requestContinuation(state, effects);
}

function estimatedPositionSeconds(state, nowMs) {
  const txn = state.txn;
  if (txn?.startedAtMs == null || state.phase !== PlaybackPhase.PLAYING) return Math.max(0, Number(state.positionSeconds) || 0);
  return Math.max(0, Number(txn.startedPositionSeconds) || 0) + Math.max(0, nowMs - txn.startedAtMs) / 1000;
}

function assessNarrationWindow(state, nowMs, { observedPositionSeconds = null, durationSeconds = null } = {}) {
  const track = currentTrack(state);
  if (!track || state.txn?.startedAtMs == null || state.phase !== PlaybackPhase.PLAYING) return 'not-playing';
  const position = Number.isFinite(observedPositionSeconds)
    ? Math.max(0, observedPositionSeconds)
    : estimatedPositionSeconds(state, nowMs);
  const duration = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? durationSeconds
    : Number(track.duration) || 0;
  const policy = state.narrationPolicy || DEFAULT_NARRATION_POLICY;
  // An explicit listener request is not an accidental interruption: it may start
  // after the automatic window, but every other delivery condition still applies.
  const requested = state.txn?.narrationUserRequested === true;
  if (!requested && position * 1000 < policy.settlingDelayMs) return 'not-settled';
  if (!requested && position * 1000 > policy.maxStartOffsetMs) return 'late';
  if (duration <= 0 || (duration - position) * 1000 < policy.minRemainingMs) return 'too-little-time';
  return 'eligible';
}

function recordNarrationSkip(state, reason) {
  if (!state.txn || ['delivered', 'skipped'].includes(state.txn.narrationDelivery)) return;
  state.txn.narrationDelivery = 'skipped';
  state.diagnostics.push({ type: 'track-narration-skipped', queueItemId: state.txn.queueItemId,
    correlationId: state.txn.correlationId, reason });
}

/**
 * The insertion window has passed for good. Being merely early is not a miss: the
 * runtime arms the window from when it received the track-start fact, while the browser
 * measures the media's own clock, so a confirmation can arrive a few dozen milliseconds
 * before the settle and then only needs waiting for, never discarding.
 */
function narrationWindowExpired(status) {
  return status === 'late' || status === 'too-little-time' || status === 'not-playing';
}

function queueNarrationOverlay(state, commands, nowMs, observation = {}, effects = null) {
  const track = currentTrack(state);
  const txn = state.txn;
  if (!track || !txn || state.phase !== PlaybackPhase.PLAYING || txn.narrationDelivery !== 'eligible') return false;
  if (track.queueItemId !== txn.queueItemId || track.narration.status !== 'ready') return false;
  if (track.narration.assetStatus !== 'ready' || !track.narration.ttsUrl) {
    if (track.narration.assetStatus === 'failed' || track.narration.assetStatus === 'missing') recordNarrationSkip(state, 'missing-audio');
    return false;
  }
  const block = automaticNarrationBlock(state, nowMs);
  if (block?.reason) { recordNarrationSkip(state, block.reason); return false; }
  if (block?.waitMs != null) {
    txn.narrationDelivery = 'waiting';
    return openNarrationWindow(state, commands, nowMs, observation, effects);
  }
  const windowStatus = assessNarrationWindow(state, nowMs, observation);
  if (windowStatus === 'not-settled') return false;
  if (windowStatus !== 'eligible') {
    recordNarrationSkip(state, windowStatus);
    return false;
  }
  txn.narrationDelivery = 'queued';
  const identity = commandIdentity(state, track, txn.correlationId);
  // The browser preflight validates the same bounds, so a requested delivery must
  // ship the relaxed bounds instead of the automatic ones.
  const requested = txn.narrationUserRequested === true;
  commands.push({
    type: PlaybackCommandType.PLAY_TRACK_NARRATION,
    ...identity,
    // 客户端待播命令携带模式 revision：真正开口前仍由 runtime 重验。
    modeRevision: state.modeRevision,
    text: track.narration.text,
    url: track.narration.ttsUrl,
    narrationContentHash: track.narration.contentHash,
    settlingDelayMs: requested ? 0 : state.narrationPolicy.settlingDelayMs,
    maxStartOffsetMs: requested ? REQUESTED_NARRATION_MAX_OFFSET_MS : state.narrationPolicy.maxStartOffsetMs,
    minRemainingMs: state.narrationPolicy.minRemainingMs,
    duckLevel: state.narrationPolicy.duckLevel,
    duckRampMs: state.narrationPolicy.duckRampMs,
    restoreRampMs: state.narrationPolicy.restoreRampMs,
  });
  return true;
}

function openNarrationWindow(state, commands, nowMs, observation = {}, effects = null) {
  const txn = state.txn;
  if (!txn || !currentTrack(state) || txn.narrationDelivery !== 'waiting') return false;
  const windowStatus = assessNarrationWindow(state, nowMs, observation);
  if (windowStatus === 'not-playing' || windowStatus === 'not-settled') return false;
  if (windowStatus !== 'eligible') {
    recordNarrationSkip(state, windowStatus);
    return false;
  }
  const block = automaticNarrationBlock(state, nowMs);
  if (block?.reason) { recordNarrationSkip(state, block.reason); return false; }
  if (block?.waitMs != null) {
    // 距上次自动开口不足最小间隔，但启动窗口内还来得及：有界等待后再开窗。
    effects?.push({ type: PlaybackEffectType.SCHEDULE_NARRATION_WINDOW,
      queueItemId: txn.queueItemId, correlationId: txn.correlationId,
      listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration,
      delayMs: Math.max(0, Number(block.waitMs) || 0) });
    return false;
  }
  txn.narrationDelivery = 'eligible';
  return queueNarrationOverlay(state, commands, nowMs, observation, effects);
}

/**
 * Media evidence concluded the current activation: this occurrence is sounding in
 * a browser at the reported position. The narration window is armed only here,
 * because this is the only evidence that the committed track actually started.
 */
function concludeActivation(state, positionSeconds, commands, effects, nowMs) {
  state.phase = PlaybackPhase.PLAYING;
  state.hasStarted = true;
  state.txn.phase = PlaybackPhase.PLAYING;
  state.txn.startedAtMs = nowMs;
  state.txn.startedPositionSeconds = Number.isFinite(positionSeconds) ? Math.max(0, positionSeconds) : 0;
  state.positionSeconds = state.txn.startedPositionSeconds;
  // Confirmed media evidence: this occurrence首次被接受，进入模式 epoch 计数。
  acceptMediaActivationForMode(state);
  const delay = Math.max(0, Number(state.narrationPolicy?.settlingDelayMs) || 0);
  if (delay > 0) {
    effects.push({ type: PlaybackEffectType.SCHEDULE_NARRATION_WINDOW,
      queueItemId: state.txn.queueItemId, correlationId: state.txn.correlationId,
      listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration,
      delayMs: delay });
    return;
  }
  openNarrationWindow(state, commands, nowMs, { observedPositionSeconds: state.positionSeconds,
    durationSeconds: Number(currentTrack(state)?.duration) || null }, effects);
}

/**
 * A real companion-mode change: bump the revision, rebuild the counting epoch, and
 * cancel automatic narration work the new mode no longer grants. Re-selecting the
 * effective mode (or a duplicate request, deduped upstream) changes nothing, so
 * counts survive refreshes and repeated saves. Songs, progress and spoken history
 * are never touched; the current song never suddenly catches up on narration.
 */
function applyCompanionModeChange(state, event, commands, effects, { background = false } = {}) {
  const targetModeId = event.modeId == null ? null : event.modeId;
  // scene 来源：用户显式使用场景而应用的默认模式；手动覆盖（explicit）优先于它。
  const requestedSource = event.modeSource === 'scene' ? 'scene' : 'explicit';
  if (requestedSource === 'scene' && state.modeSource === 'explicit') {
    // 已有手动覆盖时场景不改模式；调用方据此提示“当前仍手动覆盖”。
    state.diagnostics.push({ type: 'companion-mode-scene-deferred', sceneModeId: targetModeId,
      activeModeId: state.companionModeId });
    return;
  }
  // 没有显式覆盖或场景模式时“清除覆盖”无事可做；重复保存同一模式幂等返回。
  if (targetModeId == null && !['explicit', 'scene'].includes(state.modeSource)) return;
  // 清除显式覆盖回到默认模式；显式选择则成为会话覆盖来源。兼容的 nullable
  // PATCH 只表达“清除覆盖”，不会再生成 null/legacy 状态。
  const nextModeId = targetModeId != null ? targetModeId : DEFAULT_COMPANION_MODE_ID;
  if (nextModeId === state.companionModeId) {
    if (targetModeId != null && state.modeSource === requestedSource) return;
    // 有效模式不变、只有来源变化（选中当前模式，或清除覆盖回到默认）：策略没变，
    // 不跨 revision、不动计数。
    state.modeSource = targetModeId != null ? requestedSource : 'default';
    state.diagnostics.push({ type: targetModeId == null ? 'companion-mode-cleared-to-default' : 'companion-mode-source-changed',
      modeId: nextModeId, modeSource: state.modeSource });
    return;
  }
  const previousModeId = state.companionModeId;
  state.companionModeId = nextModeId;
  // 清除覆盖回到默认来源；显式/场景选择记录对应来源。
  state.modeSource = targetModeId != null ? requestedSource : 'default';
  state.modeRevision = Number(state.modeRevision || 0) + 1;
  state.modeEpoch = Number(state.modeEpoch || 0) + 1;
  state.modeActivationCount = 0;
  state.modeCountedOccurrences = [];
  // 最后自动开口时间跨 epoch 保留：切换模式不能洗掉 120 秒间隔。
  const txn = state.txn;
  if (txn) {
    if (txn.narrationUserRequested !== true) {
      // 当前 occurrence 在模式切换时不获得新资格；已开始的人声只被只听歌取消。
      state.modeCountedOccurrences = [{ queueItemId: txn.queueItemId, position: 0, eligible: false }];
      txn.narrationAutoEligible = false;
      if (['waiting', 'eligible'].includes(txn.narrationDelivery)) recordNarrationSkip(state, 'mode-changed');
      else if (['queued', 'starting'].includes(txn.narrationDelivery)) {
        recordNarrationSkip(state, 'mode-changed');
        commands.push({ type: PlaybackCommandType.CANCEL_TRACK_NARRATION,
          ...commandIdentity(state, currentTrack(state), txn.correlationId),
          reason: 'companion-mode-changed', narrationContentHash: currentTrack(state)?.narration?.contentHash || null });
      } else if (txn.narrationDelivery === 'speaking' && nextModeId === 'music_only') {
        // 只听歌是唯一会打断已出声自动串词的切换：有界取消并恢复音乐增益。
        recordNarrationSkip(state, 'mode-changed-music-only');
        commands.push({ type: PlaybackCommandType.CANCEL_TRACK_NARRATION,
          ...commandIdentity(state, currentTrack(state), txn.correlationId),
          reason: 'companion-mode-music-only', narrationContentHash: currentTrack(state)?.narration?.contentHash || null });
      }
      txn.modeRevision = state.modeRevision;
    } else {
      txn.modeRevision = state.modeRevision;
    }
  }
  // 未开始的旧模式自动准备结果失效：prepared-but-unheard 的串词作废。当前
  // occurrence 正在生成的自动准备同样作废（迟到 READY 会被状态检查拒绝）；
  // 用户明确请求的准备不属于自动口播，保留。
  const invalidated = [];
  for (let index = state.currentIndex; index < state.queue.length; index += 1) {
    const narration = state.queue[index]?.narration;
    if (!narration || narration.spoken === true) continue;
    if (index === state.currentIndex && txn?.narrationUserRequested === true) continue;
    if (narration.status === 'ready' || narration.status === 'preparing') {
      narration.status = 'absent';
      narration.assetStatus = 'missing';
      narration.ttsUrl = null;
      narration.contentHash = null;
      narration.spokenText = null;
      narration.performance = null;
      narration.previousSongId = null;
      invalidated.push(state.queue[index].queueItemId);
    }
  }
  if (invalidated.length) {
    state.diagnostics.push({ type: 'track-narration-invalidated-by-mode', queueItemIds: invalidated,
      previousModeId, nextModeId });
  }
  // 后台编辑丢弃 effects：在这里置 preparing 会留下没有 worker 的串词；被挂起会话在激活时重新准备。
  if (!background) prepareUpcomingNarration(state, state.currentIndex, effects);
  state.diagnostics.push({ type: 'companion-mode-changed', previousModeId, nextModeId,
    modeRevision: state.modeRevision, modeSource: state.modeSource });
}

function handleAcceptedEvent(state, event, commands, effects, nowMs, { background = false } = {}) {
  switch (event.type) {    case PlaybackEventType.TRACK_INTRO_READY:
      // Old clients may still report this migration-era event. New activations
      // never block on it; normalized updates are handled through queue-item IDs.
      return;
    case PlaybackEventType.TRACK_ARTWORK_RESOLVED: {
      // 只补元数据：不重建队列、不切换当前项、不碰 phase/txn/outputGeneration。
      // 合法性（目标存在、是歌曲项、当前无封面）已在 reducePlayback 的准入阶段判定。
      const index = state.queue.findIndex(item => item.queueItemId === event.queueItemId);
      if (index < 0) return;
      const next = state.queue.slice();
      next[index] = { ...next[index], artwork: event.artwork.trim() };
      state.queue = next;
      return;
    }
    case PlaybackEventType.QUEUE_EDIT_REQUESTED: {
      const fixed = state.queue.slice(0, state.currentIndex + 1);
      const upcoming = state.queue.slice(state.currentIndex + 1);
      const ids = new Set(event.queueItemIds || event.songIds);
      const targetId = track => event.queueItemIds ? track.queueItemId : track.songId;
      const ordered = event.action === 'clear' ? [] : event.action === 'remove'
        ? upcoming.filter(track => !ids.has(targetId(track)))
        : [...(event.queueItemIds || event.songIds).map(id => upcoming.find(track => targetId(track) === id)),
          ...upcoming.filter(track => !ids.has(targetId(track)))];
      state.queue = [...fixed, ...ordered];
      state.queueVersion += 1;
      return;
    }
    case PlaybackEventType.NARRATION_CONTEXT_STALE_REQUESTED: {
      // Life-context changes also revoke the current introduction, including an
      // already queued or speaking overlay. The cancel command restores music gain.
      const invalidated = [];
      const first = event.includeCurrent === true ? Math.max(0, state.currentIndex) : state.currentIndex + 1;
      for (let index = first; index < state.queue.length; index += 1) {
        const narration = state.queue[index]?.narration;
        if (!narration || (narration.spoken === true && index !== state.currentIndex)
          || (narration.status !== 'ready' && !(event.includeCurrent === true && narration.status === 'preparing'))) continue;
        if (index === state.currentIndex && state.txn) {
          const delivery = state.txn.narrationDelivery;
          if (['queued', 'starting', 'speaking'].includes(delivery) && !background) {
            commands.push({ type: PlaybackCommandType.CANCEL_TRACK_NARRATION,
              ...commandIdentity(state, state.queue[index], state.txn.correlationId),
              reason: 'life-context-revoked', narrationContentHash: narration.contentHash || null });
          }
          recordNarrationSkip(state, 'life-context-stale');
        }
        narration.status = 'absent';
        narration.assetStatus = 'missing';
        narration.ttsUrl = null;
        narration.contentHash = null;
        narration.spokenText = null;
        narration.performance = null;
        narration.previousSongId = null;
        narration.generationRevision += 1;
        invalidated.push(state.queue[index].queueItemId);
      }
      if (invalidated.length) {
        state.diagnostics.push({ type: 'track-narration-invalidated-by-memory', queueItemIds: invalidated });
        // A background edit discards effects, so re-arming here would strand a
        // 'preparing' artifact with no worker; a suspended session re-prepares on
        // activation instead. The active session re-arms within this transition.
        if (!background) prepareUpcomingNarration(state, state.currentIndex, effects);
      }
      return;
    }
    case PlaybackEventType.PROGRAM_COMMITTED:
      // auto_continue 的边界一次性消费：耗尽路径由激活清除，播放中的提前
      // 续选追加不激活，必须在这里清掉，否则同一 boundary 可被不同 eventId
      // 的迟到提交重复消费、重复加歌。
      if (event.source === 'auto_continue') state.pendingContinuation = null;
      commitProgram(state, event, commands, effects, nowMs);
      return;
    case PlaybackEventType.TRACK_DISMISS_REQUESTED: {
      const outgoing = currentTrack(state);
      const sameSong = item => item.songId === outgoing.songId
        && String(item.source || '').split(':')[0].toLowerCase() === event.provider;
      const successor = state.queue.slice(state.currentIndex + 1).find(item => !sameSong(item));
      if (state.hasStarted) state.lastOutputTrack = { title: outgoing.title, artist: outgoing.artist, songId: outgoing.songId };
      const removedIds = state.queue.filter(sameSong).map(item => item.queueItemId);
      state.queue = state.queue.filter(item => !sameSong(item));
      state.queueVersion += 1;
      state.txn = null;
      state.pendingContinuation = null;
      state.positionSeconds = 0;
      state.hasStarted = false;
      state.lastError = null;
      // 先撤下旧音乐和串词；后继只由同一迁移里的权威激活产生，不用两次 HTTP 拼接。
      commands.push({ type: PlaybackCommandType.STOP_PLAYBACK });
      state.currentIndex = -1;
      state.currentSongId = null;
      if (successor) {
        createActivation(state, state.queue.findIndex(item => item.queueItemId === successor.queueItemId),
          'disliked_track_removed', commands, effects, nowMs);
      } else {
        // 耗尽时历史仍可显式回看，但不能把它们当新待播自动回放。
        state.currentIndex = state.queue.length - 1;
        state.currentSongId = currentTrack(state)?.songId || null;
        exhaustOrContinue(state, { natural: false, manual: true }, effects);
      }
      state.diagnostics.push({ type: 'track-dismissed', provider: event.provider, songId: outgoing.songId,
        queueItemIds: removedIds });
      return;
    }
    case PlaybackEventType.NEXT_REQUESTED: {
      const next = state.currentIndex + 1;
      if (next < state.queue.length) createActivation(state, next, 'manual_next', commands, effects, nowMs);
      // 队尾手动跳过与自然播完共享同一续播边界。
      else exhaustOrContinue(state, { natural: false, manual: true }, effects);
      return;
    }
    case PlaybackEventType.CARD_SELECTED: {
      const index = event.queueItemId
        ? state.queue.findIndex(track => track.queueItemId === String(event.queueItemId))
        : state.queue.findIndex(track => track.songId === String(event.songId || ''));
      if (index >= 0) createActivation(state, index, 'card_selected', commands, effects, nowMs);
      return;
    }
    case PlaybackEventType.TRACK_ENDED: {
      if (event.natural !== true || !eventMatchesCurrent(state, event, { correlation: false })) return;
      if (state.pendingSwitch) {
        const target = state.pendingSwitch.listeningSessionId;
        const ended = currentTrack(state);
        if (ended) state.lastOutputTrack = { title: ended.title, artist: ended.artist, songId: ended.songId };
        state.positionSeconds = 0;
        state.hasStarted = false;
        if (state.currentIndex + 1 < state.queue.length) {
          state.currentIndex += 1;
          state.currentSongId = state.queue[state.currentIndex].songId;
        } else {
          state.phase = PlaybackPhase.EXHAUSTED;
          state.currentIndex = -1;
          state.currentSongId = null;
        }
          switchListeningSession(state, target, commands, null, { effects, nowMs });
        return;
      }
      // A listener pause is the latest decision for this session. A natural end whose
      // fact arrives behind the pause advances the queue without starting output or a
      // continuation; resuming lets the listener open what is next by their own hand.
      if (state.phase === PlaybackPhase.PAUSED) {
        const endedTrack = currentTrack(state);
        if (endedTrack) state.lastOutputTrack = { title: endedTrack.title, artist: endedTrack.artist, songId: endedTrack.songId };
        state.positionSeconds = 0;
        state.hasStarted = false;
        state.txn = null;
        if (state.currentIndex + 1 < state.queue.length) {
          state.currentIndex += 1;
          state.currentSongId = state.queue[state.currentIndex].songId;
        } else {
          state.phase = PlaybackPhase.EXHAUSTED;
        }
        return;
      }
      const catalogDuration = Number(currentTrack(state)?.duration || 0);
      const deliveredDuration = Number(event.deliveredDuration || 0);
      if (catalogDuration > 0 && deliveredDuration > 0 && Math.abs(catalogDuration - deliveredDuration) > 3) {
        state.diagnostics.push({ type: 'duration-mismatch', songId: state.currentSongId, catalogDuration, deliveredDuration });
      }
      const next = state.currentIndex + 1;
      if (next < state.queue.length) createActivation(state, next, 'natural_next', commands, effects, nowMs);
      else exhaustOrContinue(state, event, effects);
      return;
    }
    case PlaybackEventType.TRACK_STARTED:
      if (state.phase === PlaybackPhase.LOADING && eventMatchesCurrent(state, event)) {
        concludeActivation(state, event.positionSeconds, commands, effects, nowMs);
      }
      return;
    case PlaybackEventType.TRACK_REATTACHED:
      // A client that already holds this occurrence's media confirms the attachment
      // instead of reporting a second start fact. It is the same media evidence, so
      // it concludes the activation exactly once and never touches the media itself.
      if (state.phase === PlaybackPhase.LOADING && eventMatchesCurrent(state, event)) {
        concludeActivation(state, event.positionSeconds, commands, effects, nowMs);
        state.diagnostics.push({ type: 'track-reattached', queueItemId: state.txn.queueItemId,
          correlationId: state.txn.correlationId, positionSeconds: state.positionSeconds });
      }
      return;
    case PlaybackEventType.TRACK_FAILED:
      if (eventMatchesCurrent(state, event)) {
        state.phase = PlaybackPhase.ERROR;
        state.lastError = { type: 'track-failed', songId: state.currentSongId, message: String(event.error || 'media failed') };
        if (state.txn) state.txn.phase = PlaybackPhase.ERROR;
        if (state.txn && !['delivered', 'skipped'].includes(state.txn.narrationDelivery)) {
          recordNarrationSkip(state, 'track-failed');
        }
      }
      return;
    case PlaybackEventType.PAUSE_REQUESTED:
      // A pause is the listener's decision, not media evidence, so it stays effective
      // for the current occurrence even while its activation is still unconfirmed
      // (restart recovery). A position the client actually holds wins over an estimate,
      // because the estimate cannot advance past a frozen confirmed position.
      if ([PlaybackPhase.PLAYING, PlaybackPhase.LOADING].includes(state.phase)
        && eventMatchesCurrent(state, event, { correlation: false })) {
        state.positionSeconds = Number.isFinite(event.positionSeconds)
          ? Math.max(0, event.positionSeconds)
          : estimatedPositionSeconds(state, nowMs);
        if (state.txn) state.txn.startedAtMs = null;
        state.phase = PlaybackPhase.PAUSED;
        commands.push({ type: PlaybackCommandType.PAUSE_TRACK, runtimeVersion: state.version + 1, songId: state.currentSongId });
      }
      return;
    case PlaybackEventType.RESUME_REQUESTED:
      if (state.phase === PlaybackPhase.EXHAUSTED && effectiveRadioMode(state) && state.queue.length) {
        requestContinuation(state, effects);
        return;
      }
      if (state.phase === PlaybackPhase.LOADING && state.txn
        && eventMatchesCurrent(state, event, { correlation: false })) {
        // The activation was never confirmed, so the phase command itself is the
        // idempotent resume: a client without media re-attaches this occurrence.
        const track = currentTrack(state);
        commands.push({ type: PlaybackCommandType.PLAY_TRACK,
          ...commandIdentity(state, track, state.txn.correlationId),
          url: track.url, positionSeconds: Math.max(0, Number(state.positionSeconds) || 0), resume: true });
        return;
      }
      if (state.phase === PlaybackPhase.PAUSED && eventMatchesCurrent(state, event, { correlation: false })) {
        if (!state.txn) { resumeCurrentOccurrence(state, commands, effects, nowMs); return; }
        state.phase = PlaybackPhase.PLAYING;
        state.txn.startedPositionSeconds = state.positionSeconds;
        state.txn.startedAtMs = nowMs;
        const track = currentTrack(state);
        commands.push({ type: PlaybackCommandType.RESUME_TRACK,
          ...commandIdentity(state, track, state.txn.correlationId),
          url: track.url,
          narrationGenerationRevision: track.narration.generationRevision,
          positionSeconds: state.positionSeconds });
        if (state.txn.narrationDelivery === 'waiting') {
          effects.push({ type: PlaybackEffectType.SCHEDULE_NARRATION_WINDOW,
            queueItemId: state.txn.queueItemId, correlationId: state.txn.correlationId,
            listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration,
            delayMs: Math.max(0, Number(state.narrationPolicy?.settlingDelayMs) || 0) });
        }
      }
      return;
    case PlaybackEventType.POSITION_REPORTED:
      // An unconfirmed activation still has a browser holding its media, so keeping the
      // confirmed position fresh is what lets a later re-attach resume this occurrence
      // instead of replaying it from the beginning. It never claims playback.
      if (eventMatchesCurrent(state, event) && [PlaybackPhase.PLAYING, PlaybackPhase.PAUSED,
        PlaybackPhase.LOADING].includes(state.phase)) {
        state.positionSeconds = event.positionSeconds;
        if (state.txn && state.phase === PlaybackPhase.PLAYING) {
          state.txn.startedPositionSeconds = event.positionSeconds;
          state.txn.startedAtMs = nowMs;
        }
        if (state.phase === PlaybackPhase.PLAYING && state.txn?.narrationDelivery === 'queued'
          && narrationWindowExpired(assessNarrationWindow(state, nowMs,
            { observedPositionSeconds: event.positionSeconds, durationSeconds: currentTrack(state)?.duration }))) {
          recordNarrationSkip(state, 'delivery-window-expired-before-start');
        }
      }
      return;
    case PlaybackEventType.LISTENING_SESSION_CREATED:
      if (event.listeningSessionId !== state.activeListeningSessionId && !state.suspendedSessions[event.listeningSessionId]) {
        state.suspendedSessions[event.listeningSessionId] = sessionValue(createPlaybackRuntimeState());
      }
      return;
    case PlaybackEventType.LISTENING_SESSION_REMOVED:
      // 会话已被删除：它挂起的队列/偏好已无处可回，继续留着只会变成指向不存在
      // 会话的孤儿播放状态。活动会话由验收阶段拒绝，这里只清理挂起与待切换目标。
      delete state.suspendedSessions[event.listeningSessionId];
      if (state.pendingSwitch?.listeningSessionId === event.listeningSessionId) state.pendingSwitch = null;
      state.diagnostics.push({ type: 'listening-session-removed', listeningSessionId: event.listeningSessionId });
      return;
    case PlaybackEventType.LISTENING_SESSION_SWITCH_REQUESTED:
      if (event.listeningSessionId === state.activeListeningSessionId) {
        state.pendingSwitch = null;
        if (state.phase === PlaybackPhase.EXHAUSTED && effectiveRadioMode(state) && state.queue.length) {
          requestContinuation(state, effects);
          return;
        }
        if (state.phase === PlaybackPhase.PAUSED) resumeCurrentOccurrence(state, commands, effects, nowMs);
        return;
      }
      if (event.delivery === 'after_current' && state.currentIndex >= 0 && ![PlaybackPhase.EXHAUSTED, PlaybackPhase.IDLE].includes(state.phase)) {
        state.pendingSwitch = { listeningSessionId: event.listeningSessionId, outputGeneration: state.outputGeneration };
      } else switchListeningSession(state, event.listeningSessionId, commands, event.positionSeconds, { effects, nowMs });
      return;
    case PlaybackEventType.LISTENING_SWITCH_CANCELLED:
      state.pendingSwitch = null;
      return;
    case PlaybackEventType.LISTENING_PLAN_CHANGED:
      state.listeningPlan = cloneRuntimeValue(event.plan || null);
      state.queueVersion += 1;
      return;
    case PlaybackEventType.RETRY_REQUESTED:
      if (state.phase === PlaybackPhase.ERROR && state.currentIndex >= 0) createActivation(state, state.currentIndex, 'retry', commands, effects, nowMs);
      else if (state.phase === PlaybackPhase.EXHAUSTED && effectiveRadioMode(state) && state.queue.length) requestContinuation(state, effects);
      // 播放中的提前续选失败：歌还在放，重试就是在当前播放里再发起一次续选。
      else if (state.pendingContinuation?.status === 'failed' && effectiveRadioMode(state) && state.queue.length) requestContinuation(state, effects);
      return;
    case PlaybackEventType.NARRATION_REQUESTED: {
      const track = currentTrack(state);
      // Pre-checks already proved this is the playing occurrence in a playing phase.
      if (!track || !state.txn || state.phase !== PlaybackPhase.PLAYING) return;
      if (track.queueItemId !== state.txn.queueItemId) return;
      state.txn.narrationUserRequested = true;
      // Already being delivered for this activation: the request is satisfied.
      if (['queued', 'speaking'].includes(state.txn.narrationDelivery)) return;
      if (track.narration.status === 'ready') {
        state.txn.narrationDelivery = 'eligible';
        if (track.narration.assetStatus === 'ready' && track.narration.ttsUrl) {
          queueNarrationOverlay(state, commands, nowMs, {}, effects);
          return;
        }
        track.narration.assetStatus = 'resolving';
        effects.push(narrationEffect(PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET, state, track,
          state.txn.correlationId));
        return;
      }
      if (!track.narration.context) return;
      track.narration.status = 'preparing';
      track.narration.generationRevision += 1;
      state.txn.narrationGenerationRevision = track.narration.generationRevision;
      // 明确请求重新打开本激活的交付：即便此前自动路径已记为 skipped。
      state.txn.narrationDelivery = 'waiting';
      effects.push(narrationEffect(PlaybackEffectType.PREPARE_TRACK_NARRATION, state, track,
        state.txn.correlationId));
      return;
    }
    case PlaybackEventType.NARRATION_WINDOW_OPENED:
      if (eventMatchesCurrent(state, event) && event.queueItemId === state.txn?.queueItemId) {
        openNarrationWindow(state, commands, nowMs, {
          observedPositionSeconds: event.positionSeconds,
          durationSeconds: event.durationSeconds,
        }, effects);
      }
      return;
    case PlaybackEventType.NARRATION_DELIVERY_STARTED: {
      if (!eventMatchesCurrent(state, event) || event.queueItemId !== state.txn?.queueItemId
        || state.txn?.narrationDelivery !== 'queued') return;
      const status = assessNarrationWindow(state, nowMs, { observedPositionSeconds: event.positionSeconds,
        durationSeconds: event.durationSeconds });
      // Not settled yet: the browser is a few milliseconds ahead of the runtime's timer.
      // Keep the delivery queued so it can still be authorized instead of expiring it.
      if (status === 'not-settled') return;
      if (status !== 'eligible') {
        recordNarrationSkip(state, narrationWindowExpired(status)
          ? 'delivery-window-expired-before-start' : 'delivery-window-invalid-before-start');
        return;
      }
      state.txn.narrationDelivery = 'starting';
      state.txn.narrationAuthorizedAtMs = nowMs;
      return;
    }
    case PlaybackEventType.NARRATION_DELIVERY_AUDIBLE: {
      if (!eventMatchesCurrent(state, event) || event.queueItemId !== state.txn?.queueItemId
        || state.txn?.narrationDelivery !== 'starting') return;
      const status = assessNarrationWindow(state, nowMs, { observedPositionSeconds: event.positionSeconds,
        durationSeconds: event.durationSeconds });
      // The introduction is already sounding, and the settle bound only governs when it
      // may start (already authorized), so a millisecond of clock disagreement between
      // the runtime timer and the media clock must not throw away a delivered voice.
      if (status !== 'eligible' && status !== 'not-settled') {
        recordNarrationSkip(state, narrationWindowExpired(status)
          ? 'delivery-window-expired-before-audible' : 'delivery-window-invalid-before-audible');
        return;
      }
      state.txn.narrationDelivery = 'speaking';
      state.txn.narrationStartedAtMs = nowMs;
      // 按被接受的实际开口事实计时：自动串词从这里刷新最小启动间隔。用户明确
      // 请求的介绍不是自动口播，不占用该间隔。
      if (state.txn.narrationUserRequested !== true) state.lastAutomaticNarrationAtMs = nowMs;
      // Durable evidence that this occurrence's introduction has been heard, so no
      // later activation of the same occurrence can speak it again.
      const spokenTrack = currentTrack(state);
      if (spokenTrack) spokenTrack.narration.spoken = true;
      state.diagnostics.push({ type: 'track-narration-started', queueItemId: event.queueItemId,
        correlationId: event.correlationId });
      return;
    }
    case PlaybackEventType.NARRATION_DELIVERY_FINISHED:
      if (eventMatchesCurrent(state, event) && event.queueItemId === state.txn?.queueItemId
        && state.txn.narrationDelivery === 'speaking') {
        state.txn.narrationDelivery = 'delivered';
        state.diagnostics.push({ type: 'track-narration-delivered', queueItemId: event.queueItemId,
          correlationId: event.correlationId });
      }
      return;
    case PlaybackEventType.NARRATION_DELIVERY_FAILED:
    case PlaybackEventType.NARRATION_DELIVERY_CANCELLED:
      if (eventMatchesCurrent(state, event) && event.queueItemId === state.txn?.queueItemId
        && ['queued', 'starting', 'speaking'].includes(state.txn.narrationDelivery)) {
        recordNarrationSkip(state, event.type === PlaybackEventType.NARRATION_DELIVERY_FAILED
          ? 'tts-failed' : String(event.reason || 'cancelled'));
      }
      return;
    case PlaybackEventType.RADIO_MODE_CHANGED: {
      state.radioMode = event.enabled === true;
      state.radioModeOverride = state.radioMode;
      if (!state.radioMode) state.pendingContinuation = null;
      else if (state.phase === PlaybackPhase.EXHAUSTED && state.queue.length) requestContinuation(state, effects);
      return;
    }
    case PlaybackEventType.COMPANION_MODE_CHANGED:
      applyCompanionModeChange(state, event, commands, effects, { background });
      return;
    case PlaybackEventType.CONTINUATION_FAILED:
      if (state.pendingContinuation?.boundaryKey === event.boundaryKey) {
        state.pendingContinuation.status = 'failed';
        state.lastError = { type: 'continuation-failed', message: String(event.error || 'continuation failed') };
        // 耗尽边界的续播失败保持 exhausted；播放中的提前续选失败不能把还在
        // 出声的歌谎报成“队列已放完”，phase 保持由当前事务决定。
        if (!state.txn || state.phase === PlaybackPhase.EXHAUSTED) state.phase = PlaybackPhase.EXHAUSTED;
      }
      return;
    case PlaybackEventType.RESET_REQUESTED:
      state.queue = [];
      state.currentIndex = -1;
      state.currentSongId = null;
      state.phase = PlaybackPhase.IDLE;
      state.txn = null;
      state.pendingContinuation = null;
      state.lastError = null;
      state.queueVersion += 1;
      state.positionSeconds = 0;
      state.hasStarted = false;
      state.pendingSwitch = null;
      commands.push({ type: PlaybackCommandType.STOP_PLAYBACK, runtimeVersion: state.version + 1 });
      return;
    default:
  }
}

const BACKGROUND_NARRATION_EVENTS = new Set([
  PlaybackEventType.TRACK_NARRATION_READY,
  PlaybackEventType.TRACK_NARRATION_FAILED,
  PlaybackEventType.TRACK_NARRATION_ASSET_READY,
  PlaybackEventType.TRACK_NARRATION_ASSET_FAILED,
]);

function applyBackgroundNarrationEvent(previousState, event, nowMs, idempotencyWindow) {
  const reject = reason => deepFreeze({ state: previousState, commands: [], effects: [], accepted: false, reason });
  const targetId = event.listeningSessionId;
  const target = listeningSnapshot(previousState, targetId);
  const item = target.queue.find(track => track.queueItemId === event.queueItemId);
  if (!item || (event.songId && event.songId !== item.songId) || (event.programId && event.programId !== item.programId)) {
    return reject('stale narration queue item');
  }
  const artifact = item.narration;
  if (event.generationRevision !== artifact.generationRevision) return reject('stale narration generation');
  if ([PlaybackEventType.TRACK_NARRATION_READY, PlaybackEventType.TRACK_NARRATION_FAILED].includes(event.type)
    && artifact.status !== 'preparing') return reject('narration generation no longer active');
  if ([PlaybackEventType.TRACK_NARRATION_ASSET_READY, PlaybackEventType.TRACK_NARRATION_ASSET_FAILED].includes(event.type)
    && (artifact.status !== 'ready' || artifact.assetStatus !== 'resolving')) return reject('narration asset resolution no longer active');

  const state = mutableCopy(previousState);
  const queue = targetId === state.activeListeningSessionId
    ? state.queue
    : state.suspendedSessions[targetId]?.queue;
  const track = queue?.find(candidate => candidate.queueItemId === event.queueItemId);
  if (!track) return reject('stale narration queue item');
  const commands = [];
  const effects = [];
  let eventFailed = [PlaybackEventType.TRACK_NARRATION_FAILED, PlaybackEventType.TRACK_NARRATION_ASSET_FAILED].includes(event.type);
  if (event.type === PlaybackEventType.TRACK_NARRATION_READY) {
    // text 是唯一人读文本（时间线、账本、播放命令都读它），一律剥离表演标记；
    // 带标记的 spokenText 与中立 performance 只为重合成保留，且必须与 text 对应。
    const rawText = String(event.text || '').trim().slice(0, 800);
    const text = toPlainText(rawText);
    const spokenCandidate = String(event.spokenText || (rawText !== text ? rawText : '')).trim().slice(0, 1000);
    const spokenText = spokenCandidate && toPlainText(spokenCandidate) === text ? spokenCandidate : null;
    const ttsUrl = String(event.ttsUrl || '').trim();
    const voiceProfileId = String(event.voiceProfileId || track.narration.voiceProfileId || track.voiceProfileId || '').trim() || null;
    track.narration.synthesisReason = ttsUrl ? null : synthesisReason(event.synthesisReason) || 'failed';
    track.narration.synthesisElapsedMs = synthesisElapsed(event.synthesisElapsedMs);
    if (!text) {
      eventFailed = true;
      track.narration.status = 'failed';
      track.narration.assetStatus = 'failed';
      track.narration.ttsUrl = null;
      state.diagnostics.push({ type: 'track-narration-failed', queueItemId: track.queueItemId,
        generationRevision: event.generationRevision, reason: 'empty narration' });
    } else {
      // 已接受的文字与资产分别保存：合成失败不丢掉正文，也不伪造声音交付。
      track.narration.status = 'ready';
      track.narration.assetStatus = ttsUrl ? 'ready' : 'failed';
      track.narration.text = text;
      track.narration.spokenText = spokenText;
      track.narration.performance = event.spokenText && !spokenText ? null : normalizePerformance(event.performance);
      track.narration.voiceProfileId = voiceProfileId;
      track.narration.ttsUrl = ttsUrl || null;
      track.narration.contentHash = String(event.contentHash || '').trim() || null;
      track.narration.previousSongId = String(event.previousSongId || track.narration.previousSongId || '').trim() || null;
      eventFailed = !ttsUrl;
      state.diagnostics.push({ type: ttsUrl ? 'track-narration-prepared' : 'track-narration-asset-failed',
        queueItemId: track.queueItemId, generationRevision: event.generationRevision,
        ...(!ttsUrl ? { reason: track.narration.synthesisReason, elapsedMs: track.narration.synthesisElapsedMs } : {}) });
    }
  } else if (event.type === PlaybackEventType.TRACK_NARRATION_FAILED) {
    track.narration.status = 'failed';
    track.narration.assetStatus = 'failed';
    state.diagnostics.push({ type: 'track-narration-failed', queueItemId: track.queueItemId,
      generationRevision: event.generationRevision, reason: synthesisReason(event.synthesisReason) || 'failed',
      elapsedMs: synthesisElapsed(event.synthesisElapsedMs) });
  } else if (event.type === PlaybackEventType.TRACK_NARRATION_ASSET_READY) {
    const ttsUrl = String(event.ttsUrl || '').trim();
    if (!ttsUrl) {
      eventFailed = true;
      track.narration.assetStatus = 'failed';
      track.narration.ttsUrl = null;
      track.narration.synthesisReason = synthesisReason(event.synthesisReason) || 'failed';
      track.narration.synthesisElapsedMs = synthesisElapsed(event.synthesisElapsedMs);
      state.diagnostics.push({ type: 'track-narration-asset-failed', queueItemId: track.queueItemId,
        generationRevision: event.generationRevision, reason: track.narration.synthesisReason,
        elapsedMs: track.narration.synthesisElapsedMs });
    } else {
      track.narration.assetStatus = 'ready';
      track.narration.ttsUrl = ttsUrl;
      track.narration.contentHash = String(event.contentHash || track.narration.contentHash || '').trim() || null;
      track.narration.synthesisReason = null;
      track.narration.synthesisElapsedMs = synthesisElapsed(event.synthesisElapsedMs);
      state.diagnostics.push({ type: 'track-narration-asset-ready', queueItemId: track.queueItemId,
        generationRevision: event.generationRevision });
    }
  } else {
    track.narration.assetStatus = 'failed';
    track.narration.synthesisReason = synthesisReason(event.synthesisReason) || 'failed';
    track.narration.synthesisElapsedMs = synthesisElapsed(event.synthesisElapsedMs);
    state.diagnostics.push({ type: 'track-narration-asset-failed', queueItemId: track.queueItemId,
      generationRevision: event.generationRevision, reason: track.narration.synthesisReason,
      elapsedMs: track.narration.synthesisElapsedMs });
  }

  if (eventFailed && targetId === state.activeListeningSessionId && state.txn?.queueItemId === track.queueItemId
    && ['waiting', 'eligible'].includes(state.txn.narrationDelivery)) recordNarrationSkip(state, 'preparation-failed');
  if (targetId === state.activeListeningSessionId && state.txn?.queueItemId === track.queueItemId
    && state.phase === PlaybackPhase.PLAYING) {
    const elapsed = state.txn.startedAtMs == null ? 0 : Math.max(0, nowMs - state.txn.startedAtMs);
    if (state.txn.narrationDelivery === 'waiting'
      && elapsed >= Math.max(0, Number(state.narrationPolicy?.settlingDelayMs) || 0)) {
      openNarrationWindow(state, commands, nowMs, {}, effects);
    } else if (state.txn.narrationDelivery === 'eligible') {
      queueNarrationOverlay(state, commands, nowMs, {}, effects);
    }
  }
  state.processedEventIds.push(event.eventId);
  state.processedEventIds = cap(state.processedEventIds,
    Math.max(16, Number(idempotencyWindow) || DEFAULT_IDEMPOTENCY_WINDOW));
  state.diagnostics = cap(state.diagnostics, 100);
  state.version += 1;
  const frozenState = deepFreeze(state);
  const versionedCommands = commands.map(command => deepFreeze({ ...command, runtimeVersion: frozenState.version,
    listeningSessionId: state.activeListeningSessionId, conversationId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration }));
  return deepFreeze({ state: frozenState, commands: versionedCommands, effects, accepted: true, reason: null });
}

export function reducePlayback(previousState, event, options = {}) {
  const validation = validatePlaybackEvent(event);
  if (!validation.ok) return deepFreeze({ state: previousState, commands: [], effects: [], accepted: false, reason: validation.error });
  if (!isPlaybackRuntimeSnapshot(previousState)) {
    return deepFreeze({ state: previousState, commands: [], effects: [], accepted: false, reason: 'invalid runtime state' });
  }
  if (previousState.processedEventIds.includes(event.eventId)) {
    return deepFreeze({ state: previousState, commands: [], effects: [], accepted: false, reason: 'duplicate event' });
  }
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  if (BACKGROUND_NARRATION_EVENTS.has(event.type)) {
    return applyBackgroundNarrationEvent(previousState, event, nowMs, options.idempotencyWindow);
  }
  if (event.runtimeVersion != null && event.runtimeVersion !== previousState.version) {
    return deepFreeze({ state: previousState, commands: [], effects: [], accepted: false, reason: 'stale runtime version' });
  }
  const reject = reason => deepFreeze({ state: previousState, commands: [], effects: [], accepted: false, reason });
  const targetId = event.listeningSessionId || previousState.activeListeningSessionId;
  const target = listeningSnapshot(previousState, targetId);
  if (event.expectedQueueVersion != null && event.expectedQueueVersion !== target.queueVersion) return reject('stale listening queue version');
  if (event.type === PlaybackEventType.COMPANION_MODE_CHANGED && event.expectedRevision != null
    && event.expectedRevision !== (target.modeRevision || 0)) {
    return reject('stale mode revision');
  }
  if (event.type === PlaybackEventType.LISTENING_SESSION_REMOVED) {
    // 删除只清理挂起状态：正在听的会话必须由前端先切换，而不是被静默停掉。
    if (targetId === previousState.activeListeningSessionId) return reject('active listening session');
  }
  if (event.type === PlaybackEventType.TRACK_DISMISS_REQUESTED) {
    const item = currentTrack(previousState);
    if (targetId !== previousState.activeListeningSessionId || !item
      || event.queueItemId !== item.queueItemId || event.songId !== item.songId
      || event.provider !== String(item.source || '').split(':')[0].toLowerCase()) {
      return reject('dismissal targets a non-current canonical track');
    }
  }
  if (event.type === 'QUEUE_EDIT_REQUESTED') {
    const targetIds = event.queueItemIds || event.songIds;
    const upcoming = new Set(target.queue.slice(target.currentIndex + 1)
      .map(track => event.queueItemIds ? track.queueItemId : track.songId));
    if (new Set(targetIds).size !== targetIds.length || targetIds.some(id => !upcoming.has(id))) return reject('queue target is not upcoming');
  }
  if (event.outputGeneration != null && event.outputGeneration !== previousState.outputGeneration) return reject('stale output generation');
  const mediaEvent = ['TRACK_ENDED', 'TRACK_STARTED', 'TRACK_REATTACHED', 'TRACK_FAILED', 'TTS_FINISHED', 'TTS_FAILED', 'POSITION_REPORTED',
    'TRACK_INTRO_READY', 'NARRATION_WINDOW_OPENED', 'NARRATION_REQUESTED', 'NARRATION_DELIVERY_STARTED', 'NARRATION_DELIVERY_AUDIBLE', 'NARRATION_DELIVERY_FINISHED',
    'NARRATION_DELIVERY_FAILED', 'NARRATION_DELIVERY_CANCELLED'].includes(event.type);
  if (mediaEvent && (targetId !== previousState.activeListeningSessionId
    || (previousState.outputGeneration > 0 && event.outputGeneration == null))) return reject('inactive media identity');
  if (mediaEvent && !eventMatchesCurrent(previousState, event)) return reject('stale media identity');
  if (event.type === 'TRACK_INTRO_READY') return reject('legacy narration event unsupported');
  if (targetId !== previousState.activeListeningSessionId && ['NEXT_REQUESTED', 'CARD_SELECTED', 'PAUSE_REQUESTED',
    'RESUME_REQUESTED', 'RETRY_REQUESTED', 'RESET_REQUESTED', 'CONTINUATION_FAILED', 'NARRATION_REQUESTED'].includes(event.type)) return reject('inactive listening session');
  if (event.source === 'auto_continue' && targetId !== previousState.activeListeningSessionId) return reject('inactive continuation');
  if (event.type === PlaybackEventType.PROGRAM_COMMITTED && event.source === 'auto_continue') {
    // 边界验收不看 phase：耗尽兜底与播放中的提前续选共用同一套 boundary
    // 身份（radio 开、requested 且 key 匹配）。激活语义由 commitProgram 按
    // phase 区分——只有耗尽边界才激活新歌，播放中的提交只追加。
    const boundaryMatches = previousState.radioMode
      && previousState.pendingContinuation?.status === 'requested'
      && previousState.pendingContinuation?.boundaryKey === event.continuationBoundaryKey;
    if (!boundaryMatches) {
      return deepFreeze({
        state: previousState,
        commands: [],
        effects: [],
        accepted: false,
        reason: 'stale continuation boundary',
      });
    }
  }
  if ([PlaybackEventType.PAUSE_REQUESTED, PlaybackEventType.NEXT_REQUESTED].includes(event.type) && event.queueItemId != null) {
    // A pause or skip always targets the occurrence the listener is hearing: accept it
    // even while that activation is unconfirmed, but never let a stale window or a chat
    // turn that outlived its song act on another queue occurrence.
    const occurrence = previousState.txn?.queueItemId
      || previousState.queue[previousState.currentIndex]?.queueItemId || null;
    if (occurrence == null || String(event.queueItemId) !== String(occurrence)) {
      return reject(`${event.type === PlaybackEventType.PAUSE_REQUESTED ? 'pause' : 'next'} targets a non-current occurrence`);
    }
  }
  if (event.type === PlaybackEventType.TRACK_ARTWORK_RESOLVED) {
    // metadata-only 修复只作用于活动会话里真实存在的歌曲项，且只补「当前没有封面」的项：
    // 已释放的 occurrence、已有封面都拒收，避免它变成第二个封面真相源。
    if (targetId !== previousState.activeListeningSessionId) return reject('artwork repair targets an inactive listening session');
    const repairTarget = previousState.queue.find(track => track.queueItemId === event.queueItemId) || null;
    if (!repairTarget) return reject('artwork repair target is not in the queue');
    if (String(repairTarget.artwork || '').trim()) return reject('artwork already present');
  }
  if (event.type === PlaybackEventType.NARRATION_REQUESTED) {
    // Only the occurrence that is actually playing may be spoken for.
    const playing = previousState.queue[previousState.currentIndex] || null;
    if (!playing || playing.queueItemId !== event.queueItemId) return reject('narration request targets a non-current occurrence');
    if (previousState.phase !== PlaybackPhase.PLAYING) return reject('narration requested while the track is not playing');
  }
  if (event.type === PlaybackEventType.CARD_SELECTED && !event.queueItemId
    && previousState.queue.filter(track => track.songId === String(event.songId || '')).length > 1) {
    return reject('ambiguous song id; queueItemId required');
  }
  const state = mutableCopy(previousState);
  const commands = [];
  const effects = [];
  const backgroundEdit = targetId !== state.activeListeningSessionId
    && ['PROGRAM_COMMITTED', 'LISTENING_PLAN_CHANGED', 'RADIO_MODE_CHANGED', 'QUEUE_EDIT_REQUESTED',
      'NARRATION_CONTEXT_STALE_REQUESTED', 'COMPANION_MODE_CHANGED'].includes(event.type)
    && (event.type !== 'PROGRAM_COMMITTED' || event.activate === false || event.delivery !== 'replace_now');
  if (backgroundEdit) {
    const scoped = { ...state, ...sessionValue(target), activeListeningSessionId: targetId };
    handleAcceptedEvent(scoped, { ...event, ...(event.delivery === 'after_current' ? { delivery: 'replace_now' } : {}) }, [], [], nowMs, { background: true });
    scoped.phase = scoped.currentIndex >= 0 ? PlaybackPhase.PAUSED : PlaybackPhase.IDLE;
    scoped.txn = null;
    scoped.pendingContinuation = null;
    state.suspendedSessions[targetId] = sessionValue(scoped);
    if (event.type === 'PROGRAM_COMMITTED' && event.delivery === 'after_current') {
      if (state.currentIndex >= 0 && ![PlaybackPhase.IDLE, PlaybackPhase.EXHAUSTED].includes(state.phase)) {
        state.pendingSwitch = { listeningSessionId: targetId, outputGeneration: state.outputGeneration };
      } else switchListeningSession(state, targetId, commands, null, { effects, nowMs });
    }
  } else {
    if (event.type === 'PROGRAM_COMMITTED' && targetId !== state.activeListeningSessionId) {
      switchListeningSession(state, targetId, commands, event.positionSeconds, { activate: false, nowMs });
    }
    handleAcceptedEvent(state, event, commands, effects, nowMs);
  }
  state.processedEventIds.push(event.eventId);
  if (event.type === PlaybackEventType.TTS_FINISHED || event.type === PlaybackEventType.TTS_FAILED) {
    if (event.correlationId) state.completedCorrelationIds.push(String(event.correlationId));
  }
  const limit = Math.max(16, Number(options.idempotencyWindow) || DEFAULT_IDEMPOTENCY_WINDOW);
  state.processedEventIds = cap(state.processedEventIds, limit);
  state.completedCorrelationIds = cap([...new Set(state.completedCorrelationIds)], limit);
  state.diagnostics = cap(state.diagnostics, 100);
  state.version += 1;
  const frozenState = deepFreeze(state);
  const versionedCommands = commands.map(command => deepFreeze({ ...command, runtimeVersion: frozenState.version,
    listeningSessionId: state.activeListeningSessionId, conversationId: state.activeListeningSessionId, outputGeneration: state.outputGeneration }));
  const versionedEffects = effects.map(effect => deepFreeze({ ...effect, runtimeVersion: frozenState.version }));
  return deepFreeze({ state: frozenState, commands: versionedCommands, effects: versionedEffects, accepted: true, reason: null });
}

export function resumeCommandsForState(state) {
  if (!isPlaybackRuntimeSnapshot(state) || !state.txn) return [];
  const track = currentTrack(state);
  if (!track) return [];
  const identity = {
    runtimeVersion: state.version,
    requestId: track.requestId,
    programId: track.programId,
    songId: track.songId,
    queueItemId: track.queueItemId,
    narrationGenerationRevision: track.narration.generationRevision,
    correlationId: state.txn.correlationId,
    listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  };
  if ([PlaybackPhase.LOADING, PlaybackPhase.AWAITING_INTRO, PlaybackPhase.SPEAKING,
    PlaybackPhase.PLAYING].includes(state.phase)) {
    // A connecting client may hold no media for this activation (reload, reopened
    // window, restarted host). Reissuing the phase command with the confirmed
    // position lets it re-attach the same occurrence instead of playing silence.
    return [deepFreeze({ type: PlaybackCommandType.PLAY_TRACK, ...identity, url: track.url,
      positionSeconds: Math.max(0, Number(state.positionSeconds) || 0), resume: true })];
  }
  return [];
}

export function resumeEffectsForState(state) {
  const effects = [];
  if (state.phase === PlaybackPhase.EXHAUSTED && state.radioMode
    && state.pendingContinuation?.status === 'requested') {
    effects.push({
      type: PlaybackEffectType.REQUEST_CONTINUATION,
      runtimeVersion: state.version,
      boundaryKey: state.pendingContinuation.boundaryKey,
      attempt: state.pendingContinuation.attempts,
      songId: state.currentSongId,
      listeningSessionId: state.activeListeningSessionId,
      outputGeneration: state.outputGeneration,
      recovered: true,
    });
  }
  const sessions = [[state.activeListeningSessionId, state], ...Object.entries(state.suspendedSessions || {})];
  for (const [listeningSessionId, session] of sessions) {
    for (const track of session.queue || []) {
      const artifact = track.narration;
      if (artifact?.status === 'preparing') effects.push({
        type: PlaybackEffectType.PREPARE_TRACK_NARRATION,
        queueItemId: track.queueItemId,
        generationRevision: artifact.generationRevision,
        listeningSessionId,
        requestId: track.requestId,
        programId: track.programId,
        songId: track.songId,
        correlationId: session.txn?.queueItemId === track.queueItemId
          ? session.txn.correlationId : `prepare:${track.queueItemId}:${artifact.generationRevision}`,
        voiceProfileId: artifact.voiceProfileId || track.voiceProfileId,
        track,
        previousTrack: state.lastOutputTrack,
        transitionReason: session.txn?.reason || 'recovered-preparation',
      });
      else if (artifact?.status === 'ready' && artifact.assetStatus === 'resolving') effects.push({
        type: PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET,
        queueItemId: track.queueItemId,
        generationRevision: artifact.generationRevision,
        listeningSessionId,
        requestId: track.requestId,
        programId: track.programId,
        songId: track.songId,
        correlationId: session.txn?.queueItemId === track.queueItemId
          ? session.txn.correlationId : `asset:${track.queueItemId}:${artifact.generationRevision}`,
        voiceProfileId: artifact.voiceProfileId || track.voiceProfileId,
        track,
      });
    }
  }
  return effects;
}

export function hydratePlaybackRuntimeState(snapshot) {
  // 旧默认值不是用户模式选择；恢复时升级，其他定制窗口保持原值。
  if (snapshot?.narrationPolicy?.maxStartOffsetMs === 20_000) snapshot = { ...snapshot,
    narrationPolicy: { ...snapshot.narrationPolicy, maxStartOffsetMs: DEFAULT_NARRATION_POLICY.maxStartOffsetMs } };
  if ([1, 2].includes(snapshot?.schemaVersion)) {
    const legacyPhase = snapshot.phase;
    const base = createPlaybackRuntimeState({ narrationPolicy: snapshot.narrationPolicy });
    const sessionId = String(snapshot.activeListeningSessionId || snapshot.listeningSessionId || base.activeListeningSessionId);
    const legacyQueue = Array.isArray(snapshot.queue) ? snapshot.queue : [];
    const suspended = Object.fromEntries(Object.entries(snapshot.suspendedSessions || {}).map(([id, session]) => [id, {
      ...session,
      queue: (session.queue || []).map((track, index) => normalizeRuntimeTrack({
        ...track, conversationId: track.conversationId || id,
      }, index)),
    }]));
    snapshot = {
      ...base,
      ...snapshot,
      schemaVersion: PLAYBACK_RUNTIME_SCHEMA_VERSION,
      activeListeningSessionId: sessionId,
      narrationPolicy: { ...DEFAULT_NARRATION_POLICY, ...(snapshot.narrationPolicy || {}) },
      queue: legacyQueue.map((track, index) => normalizeRuntimeTrack({
        ...track, conversationId: track.conversationId || sessionId,
      }, index)),
      suspendedSessions: suspended,
    };
    if (snapshot.txn && snapshot.currentIndex >= 0) {
      const track = snapshot.queue[snapshot.currentIndex];
      snapshot.txn = {
        ...snapshot.txn,
        queueItemId: track?.queueItemId || snapshot.txn.queueItemId,
        narrationGenerationRevision: track?.narration.generationRevision || 0,
        narrationDelivery: legacyPhase === 'awaiting_intro' ? 'waiting'
          : (legacyPhase === 'speaking' || Boolean(track?.narration.ttsUrl) ? 'delivered' : 'waiting'),
        startedAtMs: null,
        startedPositionSeconds: Number(snapshot.positionSeconds) || 0,
      };
    }
    if (legacyPhase === 'awaiting_intro' || legacyPhase === 'speaking') {
      snapshot.phase = PlaybackPhase.LOADING;
      if (snapshot.txn) snapshot.txn.phase = PlaybackPhase.LOADING;
      snapshot.hasStarted = false;
    }
  }
  if (!isPlaybackRuntimeSnapshot(snapshot)) {
    const recovered = mutableCopy(createPlaybackRuntimeState());
    if (Array.isArray(snapshot?.queue)) {
      for (let index = 0; index < snapshot.queue.length; index += 1) {
        try { recovered.queue.push(normalizeRuntimeTrack(snapshot.queue[index], index)); } catch { /* keep only valid committed facts */ }
      }
    }
    recovered.lastError = {
      type: 'invalid-snapshot-safe-idle',
      message: 'invalid runtime snapshot recovered to safe idle',
    };
    recovered.diagnostics.push({ type: 'snapshot-recovery', preservedTracks: recovered.queue.length });
    return deepFreeze(recovered);
  }
  const state = cloneRuntimeValue(snapshot);
  state.narrationPolicy = { ...DEFAULT_NARRATION_POLICY, ...(state.narrationPolicy || {}) };
  state.radioModeOverride ??= null;
  normalizeCompanionModeFields(state);
  backfillTxnModeRevision(state);
  for (const session of Object.values(state.suspendedSessions || {})) {
    normalizeCompanionModeFields(session);
    backfillTxnModeRevision(session);
  }
  state.queue = state.queue.map((track, index) => normalizeRuntimeTrack(track, index));
  for (const [sessionId, session] of Object.entries(state.suspendedSessions || {})) {
    session.queue = (session.queue || []).map((track, index) => normalizeRuntimeTrack({
      ...track, conversationId: track.conversationId || sessionId,
    }, index));
    if (session.txn && session.currentIndex >= 0) session.txn.queueItemId ||= session.queue[session.currentIndex]?.queueItemId;
  }
  if (state.txn && state.currentIndex >= 0) state.txn.queueItemId ||= state.queue[state.currentIndex]?.queueItemId;
  if (state.phase === PlaybackPhase.PLAYING && state.txn && state.currentIndex >= 0) {
    // The media process that confirmed this playback is gone. Restore the same queue
    // occurrence and transaction as an unconfirmed loading activation so a connecting
    // client re-attaches exactly this track at its confirmed position.
    state.phase = PlaybackPhase.LOADING;
    state.txn.phase = PlaybackPhase.LOADING;
    state.hasStarted = true;
    state.lastError = null;
  } else if ([PlaybackPhase.PLAYING, PlaybackPhase.PAUSED].includes(state.phase)) {
    state.phase = PlaybackPhase.PAUSED;
    state.hasStarted = true;
    state.lastError = null;
  }
  if (state.phase === PlaybackPhase.EXHAUSTED && state.radioMode && state.pendingContinuation?.status === 'failed'
    && Number(state.pendingContinuation.attempts || 0) < MAX_CONTINUATION_ATTEMPTS) {
    // A recoverable continuation failure survives restarts only as a diagnosable flag;
    // recovery re-requests it a bounded number of times for the same boundary.
    state.pendingContinuation = { ...state.pendingContinuation, status: 'requested', recovered: true,
      attempts: Number(state.pendingContinuation.attempts || 0) + 1 };
  }
  return deepFreeze(state);
}
