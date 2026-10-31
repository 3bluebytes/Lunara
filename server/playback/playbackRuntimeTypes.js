import { createHash } from 'node:crypto';
import { isCompanionModeId } from './companionModes.js';
import { normalizePerformance, toPlainText } from '../tts/performance/markers.js';
import { synthesisReason, synthesisElapsed } from '../tts/boundedSynthesis.js';

export const PLAYBACK_RUNTIME_SCHEMA_VERSION = 3;
export const DEFAULT_IDEMPOTENCY_WINDOW = 256;

export const DEFAULT_NARRATION_POLICY = Object.freeze({
  settlingDelayMs: 1_000,
  maxStartOffsetMs: 60_000,
  minRemainingMs: 15_000,
  maxPreparationConcurrency: 2,
  duckLevel: 0.25,
  duckRampMs: 300,
  restoreRampMs: 500,
});

export const PlaybackPhase = Object.freeze({
  IDLE: 'idle',
  AWAITING_INTRO: 'awaiting_intro',
  SPEAKING: 'speaking',
  LOADING: 'loading',
  PLAYING: 'playing',
  PAUSED: 'paused',
  EXHAUSTED: 'exhausted',
  ERROR: 'error',
});

export const PlaybackEventType = Object.freeze({
  PROGRAM_COMMITTED: 'PROGRAM_COMMITTED',
  NEXT_REQUESTED: 'NEXT_REQUESTED',
  TRACK_DISMISS_REQUESTED: 'TRACK_DISMISS_REQUESTED',
  CARD_SELECTED: 'CARD_SELECTED',
  TRACK_ENDED: 'TRACK_ENDED',
  TRACK_STARTED: 'TRACK_STARTED',
  // Media evidence from a client that already holds the current occurrence: the
  // attachment is confirmed without claiming a second track-start fact.
  TRACK_REATTACHED: 'TRACK_REATTACHED',
  TRACK_FAILED: 'TRACK_FAILED',
  TTS_FINISHED: 'TTS_FINISHED',
  TTS_FAILED: 'TTS_FAILED',
  PAUSE_REQUESTED: 'PAUSE_REQUESTED',
  RESUME_REQUESTED: 'RESUME_REQUESTED',
  RETRY_REQUESTED: 'RETRY_REQUESTED',
  RADIO_MODE_CHANGED: 'RADIO_MODE_CHANGED',
  CONTINUATION_FAILED: 'CONTINUATION_FAILED',
  RESET_REQUESTED: 'RESET_REQUESTED',
  LISTENING_SESSION_CREATED: 'LISTENING_SESSION_CREATED',
  LISTENING_SESSION_SWITCH_REQUESTED: 'LISTENING_SESSION_SWITCH_REQUESTED',
  LISTENING_SWITCH_CANCELLED: 'LISTENING_SWITCH_CANCELLED',
  LISTENING_PLAN_CHANGED: 'LISTENING_PLAN_CHANGED',
  POSITION_REPORTED: 'POSITION_REPORTED',
  QUEUE_EDIT_REQUESTED: 'QUEUE_EDIT_REQUESTED',
  TRACK_INTRO_READY: 'TRACK_INTRO_READY',
  TRACK_NARRATION_READY: 'TRACK_NARRATION_READY',
  TRACK_NARRATION_FAILED: 'TRACK_NARRATION_FAILED',
  TRACK_NARRATION_ASSET_READY: 'TRACK_NARRATION_ASSET_READY',
  TRACK_NARRATION_ASSET_FAILED: 'TRACK_NARRATION_ASSET_FAILED',
  NARRATION_WINDOW_OPENED: 'NARRATION_WINDOW_OPENED',
  NARRATION_REQUESTED: 'NARRATION_REQUESTED',
  NARRATION_DELIVERY_STARTED: 'NARRATION_DELIVERY_STARTED',
  NARRATION_DELIVERY_AUDIBLE: 'NARRATION_DELIVERY_AUDIBLE',
  NARRATION_DELIVERY_FINISHED: 'NARRATION_DELIVERY_FINISHED',
  NARRATION_DELIVERY_FAILED: 'NARRATION_DELIVERY_FAILED',
  NARRATION_DELIVERY_CANCELLED: 'NARRATION_DELIVERY_CANCELLED',
  // A memory/context change invalidates prepared-but-unheard introductions so the
  // next preparation reflects it; nothing playing or already spoken is touched.
  NARRATION_CONTEXT_STALE_REQUESTED: 'NARRATION_CONTEXT_STALE_REQUESTED',
  // 仅补全已存在 occurrence 的封面元数据：服务端内部事件（曲库/解析补全后回投），
  // 不改变队列顺序、当前项、phase、输出代次或任何转场状态，也不产生命令。
  TRACK_ARTWORK_RESOLVED: 'TRACK_ARTWORK_RESOLVED',
  // Companion-mode updates enter the runtime through the validated mode API only,
  // never from the generic pb-event wire.
  COMPANION_MODE_CHANGED: 'COMPANION_MODE_CHANGED',
  // 会话被删除：只丢弃该会话挂起的队列/偏好，不触碰活动会话。
  // 只能由会话删除这个服务端入口提交，客户端伪造等于可以清掉别人的待播队列。
  LISTENING_SESSION_REMOVED: 'LISTENING_SESSION_REMOVED',
});

export const PlaybackCommandType = Object.freeze({
  SHOW_TRACK_INTRO: 'SHOW_TRACK_INTRO',
  PLAY_TTS: 'PLAY_TTS',
  PLAY_TRACK_NARRATION: 'PLAY_TRACK_NARRATION',
  PLAY_TRACK: 'PLAY_TRACK',
  PAUSE_TRACK: 'PAUSE_TRACK',
  RESUME_TRACK: 'RESUME_TRACK',
  STOP_PLAYBACK: 'STOP_PLAYBACK',
  // Bounded cancellation of an in-flight automatic track narration (e.g. switching
  // to music-only): stop the voice and restore the music gain, touch nothing else.
  CANCEL_TRACK_NARRATION: 'CANCEL_TRACK_NARRATION',
});

export const PlaybackEffectType = Object.freeze({
  REQUEST_CONTINUATION: 'REQUEST_CONTINUATION',
  PREPARE_TRACK_INTRO: 'PREPARE_TRACK_INTRO',
  PREPARE_TRACK_NARRATION: 'PREPARE_TRACK_NARRATION',
  RESOLVE_TRACK_NARRATION_ASSET: 'RESOLVE_TRACK_NARRATION_ASSET',
  SCHEDULE_NARRATION_WINDOW: 'SCHEDULE_NARRATION_WINDOW',
});

// 封面 repair 事件的字符串上界：与封面缓存保持一致，避免把任意长度串塞进快照。
export const MAX_ARTWORK_URL_LENGTH = 2048;

const EVENT_TYPES = new Set(Object.values(PlaybackEventType));
const CLIENT_IDENTITY_EVENTS = new Set([
  PlaybackEventType.NEXT_REQUESTED,
  PlaybackEventType.TRACK_DISMISS_REQUESTED,
  PlaybackEventType.CARD_SELECTED,
  PlaybackEventType.TRACK_ENDED,
  PlaybackEventType.TRACK_STARTED,
  PlaybackEventType.TRACK_REATTACHED,
  PlaybackEventType.TRACK_FAILED,
  PlaybackEventType.TTS_FINISHED,
  PlaybackEventType.TTS_FAILED,
  PlaybackEventType.PAUSE_REQUESTED,
  PlaybackEventType.RESUME_REQUESTED,
  PlaybackEventType.RETRY_REQUESTED,
  PlaybackEventType.POSITION_REPORTED,
  PlaybackEventType.NARRATION_WINDOW_OPENED,
  PlaybackEventType.NARRATION_DELIVERY_STARTED,
  PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
  PlaybackEventType.NARRATION_DELIVERY_FINISHED,
  PlaybackEventType.NARRATION_DELIVERY_FAILED,
  PlaybackEventType.NARRATION_DELIVERY_CANCELLED,
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function cloneRuntimeValue(value) {
  return value == null ? value : structuredClone(value);
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function normalizeOrderedTarget(target, index = 0) {
  if (!isRecord(target)) throw new TypeError(`ordered target ${index} must be an object`);
  const title = String(target.title || '').trim();
  const artist = String(target.artist || '').trim();
  if (!title) throw new TypeError(`ordered target ${index} requires title`);
  return deepFreeze({
    title,
    artist,
    provider: String(target.provider || '').trim() || null,
    exact: target.exact !== false,
  });
}


function restoredPerformance(source, text) {
  const spoken = String(source.spokenText || '').trim().slice(0, 1000);
  const spokenText = spoken && toPlainText(spoken) === text ? spoken : null;
  return {
    spokenText,
    performance: spoken && !spokenText ? null : normalizePerformance(source.performance),
  };
}

export function normalizeRuntimeTrack(track, index = 0) {
  if (!isRecord(track)) throw new TypeError(`runtime track ${index} must be an object`);
  const songId = String(track.songId ?? track.song_id ?? '').trim();
  const programId = String(track.programId ?? track.program_id ?? '').trim();
  const requestId = String(track.requestId ?? '').trim();
  const title = String(track.title || '').trim();
  const artist = String(track.artist || '').trim();
  const url = String(track.url || '').trim();
  if (!songId || !programId || !requestId || !title || !artist || !url) {
    throw new TypeError(`runtime track ${index} requires songId, programId, requestId, title, artist, and url`);
  }
  const legacyIntro = isRecord(track.intro) ? track.intro : {};
  const narrationSource = isRecord(track.narration) ? track.narration : {};
  const legacyUrl = String(legacyIntro.ttsUrl || legacyIntro.url || track.ttsUrl || '').trim() || null;
  const ttsUrl = String(narrationSource.ttsUrl || narrationSource.url || legacyUrl || '').trim() || null;
  const text = String(narrationSource.text || legacyIntro.text || track.introText || `接下来是${artist}的《${title}》。`).trim();
  const conversationId = String(track.conversationId || track.listeningSessionId || '').trim() || null;
  const queueItemId = String(track.queueItemId || track.queue_item_id || '').trim()
    || `queue:${createHash('sha256').update([
      conversationId || '', programId, requestId, String(track.occurrenceKey || ''), index, songId,
      String(track.virtualPersonId || ''),
    ].join('\u001f')).digest('hex').slice(0, 32)}`;
  const allowedNarrationStatuses = new Set(['absent', 'preparing', 'ready', 'failed']);
  const declaredStatus = allowedNarrationStatuses.has(narrationSource.status) ? narrationSource.status : null;
  // Only a *derived* ready state can be a placeholder in disguise: a queue item
  // that was inferred as ready from a legacy asset reference while carrying no
  // narration of its own. A declared narration state is always taken at face
  // value, so the bounded one-sentence fallback survives a restart.
  const placeholderOnly = /^\s*接下来是.{1,60}的《.{1,80}》。\s*$/u.test(text);
  const status = (placeholderOnly && !declaredStatus) ? 'absent' : (declaredStatus || (ttsUrl ? 'ready' : 'absent'));
  const allowedAssetStatuses = new Set(['unknown', 'ready', 'resolving', 'missing', 'failed']);
  const legacyHash = ttsUrl?.match(/\/tts\/([a-f0-9]{16,64})\.mp3(?:$|[?#])/i)?.[1] || null;
  const narration = {
    status,
    assetStatus: status === 'ready'
      ? (allowedAssetStatuses.has(narrationSource.assetStatus) ? narrationSource.assetStatus : 'unknown')
      : 'missing',
    text: text.slice(0, 800),
    synthesisReason: synthesisReason(narrationSource.synthesisReason),
    synthesisElapsedMs: synthesisElapsed(narrationSource.synthesisElapsedMs),
    // 带表演标记的发声文本与中立表演意图，只为重合成保留；必须与 text 对应，否则丢弃。
    ...restoredPerformance(narrationSource, text.slice(0, 800)),
    voiceProfileId: String(narrationSource.voiceProfileId || track.voiceProfileId || '').trim() || null,
    ttsUrl: status === 'ready' ? ttsUrl : null,
    // Whether this introduction has already been heard. It outlives the transaction that
    // delivered it, so returning to this occurrence never rewrites or repeats it; only an
    // explicit listener request re-opens a spoken introduction.
    spoken: narrationSource.spoken === true,
    // The predecessor this text was written for. Narration prepared ahead of an
    // activation predicts it, so it must be verifiable before delivery.
    previousSongId: String(narrationSource.previousSongId || '').trim().slice(0, 128) || null,
    contentHash: String(narrationSource.contentHash || narrationSource.assetHash || legacyHash || '').trim() || null,
    generationRevision: Math.max(0, Number.parseInt(narrationSource.generationRevision, 10) || (ttsUrl ? 1 : 0)),
    ...(narrationSource.context || legacyIntro.context
      ? { context: cloneRuntimeValue(narrationSource.context || legacyIntro.context) }
      : (placeholderOnly && status === 'absent'
        ? { context: { origin: 'live', reason: 'user_request', mode: null } }
        : {})),
  };
  return deepFreeze({
    queueItemId,
    songId,
    programId,
    requestId,
    virtualPersonId: String(track.virtualPersonId || '').trim() || null,
    // 推荐人（可空）：别的成员推荐、由负责人提交的歌。旧队列项没有这个字段，按无推荐人处理。
    recommendedBy: String(track.recommendedBy || '').trim() || null,
    voiceProfileId: String(track.voiceProfileId || '').trim() || null,
    conversationId,
    title,
    artist,
    album: String(track.album || '').trim(),
    source: String(track.source || '').trim(),
    url,
    duration: Math.max(0, Number(track.duration) || 0),
    artwork: track.artwork || track.pic_url || null,
    lyric: track.lyric || null,
    narration: deepFreeze(narration),
  });
}

export function validatePlaybackEvent(event) {
  if (!isRecord(event)) return { ok: false, error: 'event must be an object' };
  if (!EVENT_TYPES.has(event.type)) return { ok: false, error: `unknown playback event: ${event.type || '(empty)'}` };
  if (!nonEmpty(event.eventId)) return { ok: false, error: 'eventId required' };
  if (event.listeningSessionId != null && (!/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/.test(event.listeningSessionId)
    || ['__proto__', 'constructor', 'prototype'].includes(event.listeningSessionId))) return { ok: false, error: 'invalid listeningSessionId' };
  if ([PlaybackEventType.LISTENING_SESSION_CREATED, PlaybackEventType.LISTENING_SESSION_SWITCH_REQUESTED,
    PlaybackEventType.LISTENING_PLAN_CHANGED, PlaybackEventType.LISTENING_SESSION_REMOVED,
    PlaybackEventType.NARRATION_CONTEXT_STALE_REQUESTED].includes(event.type)
    && !nonEmpty(event.listeningSessionId)) {
    return { ok: false, error: 'listeningSessionId required' };
  }
  if ([PlaybackEventType.POSITION_REPORTED, PlaybackEventType.TRACK_REATTACHED].includes(event.type)
    && (!Number.isFinite(event.positionSeconds) || event.positionSeconds < 0)) {
    return { ok: false, error: 'positionSeconds must be a non-negative number' };
  }
  if (event.type === PlaybackEventType.PAUSE_REQUESTED
    && event.positionSeconds != null && (!Number.isFinite(event.positionSeconds) || event.positionSeconds < 0)) {
    return { ok: false, error: 'positionSeconds must be a non-negative number' };
  }
  if ([PlaybackEventType.NARRATION_WINDOW_OPENED, PlaybackEventType.NARRATION_DELIVERY_STARTED,
    PlaybackEventType.NARRATION_DELIVERY_AUDIBLE].includes(event.type)
    && event.positionSeconds != null && (!Number.isFinite(event.positionSeconds) || event.positionSeconds < 0)) {
    return { ok: false, error: 'positionSeconds must be a non-negative number' };
  }
  if ([PlaybackEventType.NARRATION_WINDOW_OPENED, PlaybackEventType.NARRATION_DELIVERY_STARTED,
    PlaybackEventType.NARRATION_DELIVERY_AUDIBLE].includes(event.type)
    && event.durationSeconds != null && (!Number.isFinite(event.durationSeconds) || event.durationSeconds < 0)) {
    return { ok: false, error: 'durationSeconds must be a non-negative number' };
  }
  if ([PlaybackEventType.NARRATION_WINDOW_OPENED, PlaybackEventType.NARRATION_REQUESTED,
    PlaybackEventType.NARRATION_DELIVERY_STARTED, PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    PlaybackEventType.NARRATION_DELIVERY_FINISHED, PlaybackEventType.NARRATION_DELIVERY_FAILED,
    PlaybackEventType.NARRATION_DELIVERY_CANCELLED].includes(event.type) && !nonEmpty(event.queueItemId)) {
    return { ok: false, error: 'narration delivery event requires queueItemId' };
  }
  if ([PlaybackEventType.NARRATION_WINDOW_OPENED, PlaybackEventType.NARRATION_REQUESTED,
    PlaybackEventType.NARRATION_DELIVERY_STARTED, PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    PlaybackEventType.NARRATION_DELIVERY_FINISHED, PlaybackEventType.NARRATION_DELIVERY_FAILED,
    PlaybackEventType.NARRATION_DELIVERY_CANCELLED].includes(event.type)
    && (!nonEmpty(event.correlationId) || !nonEmpty(event.listeningSessionId)
      || !Number.isInteger(event.outputGeneration) || event.outputGeneration < 0)) {
    return { ok: false, error: 'narration delivery event requires activation identity' };
  }
  if ([PlaybackEventType.NARRATION_DELIVERY_STARTED, PlaybackEventType.NARRATION_DELIVERY_AUDIBLE].includes(event.type)
    && (!Number.isFinite(event.positionSeconds) || !Number.isFinite(event.durationSeconds) || event.durationSeconds <= 0)) {
    return { ok: false, error: 'narration delivery acknowledgement requires position and duration' };
  }
  if (event.type === PlaybackEventType.TRACK_DISMISS_REQUESTED
    && (!nonEmpty(event.queueItemId) || !nonEmpty(event.songId) || !nonEmpty(event.provider)
      || !/^[a-z0-9_-]{1,32}$/.test(event.provider) || !nonEmpty(event.listeningSessionId)
      || !Number.isInteger(event.outputGeneration) || event.outputGeneration < 0)) {
    return { ok: false, error: 'track dismissal requires occurrence, canonical song and output identity' };
  }
  if (event.type === PlaybackEventType.QUEUE_EDIT_REQUESTED && (!['clear', 'remove', 'reorder'].includes(event.action)
    || !(Array.isArray(event.queueItemIds) || Array.isArray(event.songIds))
    || (event.queueItemIds || event.songIds).length > 500)) return { ok: false, error: 'invalid queue edit' };
  if (CLIENT_IDENTITY_EVENTS.has(event.type)) {
    if (!Number.isInteger(event.runtimeVersion) || event.runtimeVersion < 0) {
      return { ok: false, error: 'client playback event requires runtimeVersion' };
    }
  }
  if (event.type === PlaybackEventType.CARD_SELECTED && !nonEmpty(event.queueItemId) && !nonEmpty(event.songId)) {
    return { ok: false, error: 'CARD_SELECTED requires queueItemId or songId' };
  }
  if (event.type === PlaybackEventType.TRACK_ARTWORK_RESOLVED) {
    if (!nonEmpty(event.listeningSessionId)) return { ok: false, error: 'artwork repair requires listeningSessionId' };
    if (!nonEmpty(event.queueItemId)) return { ok: false, error: 'artwork repair requires queueItemId' };
    if (typeof event.artwork !== 'string' || !event.artwork.trim()
      || event.artwork.trim().length > MAX_ARTWORK_URL_LENGTH) {
      return { ok: false, error: 'artwork repair requires a bounded artwork URL' };
    }
  }
  if ([PlaybackEventType.TRACK_NARRATION_READY, PlaybackEventType.TRACK_NARRATION_FAILED,
    PlaybackEventType.TRACK_NARRATION_ASSET_READY, PlaybackEventType.TRACK_NARRATION_ASSET_FAILED].includes(event.type)) {
    if (!nonEmpty(event.queueItemId) || !Number.isInteger(event.generationRevision) || event.generationRevision < 1) {
      return { ok: false, error: 'track narration event requires queueItemId and generationRevision' };
    }
    if (!nonEmpty(event.listeningSessionId)) return { ok: false, error: 'track narration event requires listeningSessionId' };
  }
  if (event.type === PlaybackEventType.PROGRAM_COMMITTED) {
    if (!Array.isArray(event.tracks) || !event.tracks.length) {
      return { ok: false, error: 'PROGRAM_COMMITTED requires tracks' };
    }
    if (!['replace_now', 'after_current', 'append'].includes(event.delivery)) {
      return { ok: false, error: `unsupported delivery: ${event.delivery || '(empty)'}` };
    }
    if (event.source === 'auto_continue' && !nonEmpty(event.continuationBoundaryKey)) {
      return { ok: false, error: 'auto continuation commit requires continuationBoundaryKey' };
    }
  }
  if (event.type === PlaybackEventType.COMPANION_MODE_CHANGED) {
    if (!nonEmpty(event.listeningSessionId)) return { ok: false, error: 'listeningSessionId required' };
    if (!nonEmpty(event.requestId)) return { ok: false, error: 'companion mode change requires requestId' };
    if (event.modeId != null && !isCompanionModeId(event.modeId)) {
      return { ok: false, error: `unknown companion mode: ${event.modeId}` };
    }
    if (event.modeSource != null && !['explicit', 'scene'].includes(event.modeSource)) {
      return { ok: false, error: 'invalid companion mode source' };
    }
    if (event.expectedRevision != null && (!Number.isInteger(event.expectedRevision) || event.expectedRevision < 0)) {
      return { ok: false, error: 'expectedRevision must be a non-negative integer' };
    }
  }
  return { ok: true };
}

export function isPlaybackRuntimeSnapshot(value) {
  if (!isRecord(value) || value.schemaVersion !== PLAYBACK_RUNTIME_SCHEMA_VERSION) return false;
  if (!Number.isInteger(value.version) || value.version < 0) return false;
  if (!nonEmpty(value.activeListeningSessionId) || !Number.isInteger(value.outputGeneration) || value.outputGeneration < 0
    || !isRecord(value.suspendedSessions)) return false;
  if (!Array.isArray(value.queue) || !Array.isArray(value.processedEventIds) || !Array.isArray(value.completedCorrelationIds)) return false;
  if (!Object.values(PlaybackPhase).includes(value.phase)) return false;
  if (!Number.isInteger(value.currentIndex) || value.currentIndex < -1 || value.currentIndex >= value.queue.length) return false;
  try {
    const queueItemIds = new Set();
    value.queue.forEach((track, index) => {
      if (!nonEmpty(track?.queueItemId)) throw new Error('queue item identity missing');
      if (queueItemIds.has(track.queueItemId)) throw new Error('duplicate queue item identity');
      queueItemIds.add(track.queueItemId);
      const normalized = normalizeRuntimeTrack(track, index);
      if (!isRecord(track.narration) || !['absent', 'preparing', 'ready', 'failed'].includes(track.narration.status)) {
        throw new Error('track narration state missing');
      }
      if (normalized.queueItemId !== track.queueItemId) throw new Error('queue item identity changed');
    });
    for (const session of Object.values(value.suspendedSessions)) {
      if (!Array.isArray(session.queue)) return false;
      const suspendedQueueItemIds = new Set();
      session.queue.forEach((track, index) => {
        if (!nonEmpty(track?.queueItemId)) throw new Error('suspended queue identity missing');
        if (!isRecord(track.narration)) throw new Error('suspended track narration missing');
        if (suspendedQueueItemIds.has(track.queueItemId)) throw new Error('duplicate suspended queue item identity');
        suspendedQueueItemIds.add(track.queueItemId);
        normalizeRuntimeTrack(track, index);
      });
      if (!Number.isInteger(session.currentIndex) || session.currentIndex < -1 || session.currentIndex >= session.queue.length) return false;
    }
  } catch {
    return false;
  }
  const currentItem = value.currentIndex >= 0 ? value.queue[value.currentIndex] : null;
  const expectedSongId = currentItem ? String(currentItem.songId || '') : '';
  if (String(value.currentSongId || '') !== expectedSongId) return false;
  if (value.txn) {
    if (!nonEmpty(value.txn.correlationId)) return false;
    if (!nonEmpty(value.txn.songId)) return false;
  }
  return true;
}
