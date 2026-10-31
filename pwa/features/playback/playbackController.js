import { STORAGE_KEYS } from '../../core/storageKeys.js';
import { createNarrationCoordinator } from './narrationCoordinator.js';
import { getMusicVolumePreference } from './musicVolumePreference.js';

const NOOP = () => {};

function realSource(audio, locationHref) {
  return Boolean(audio?.src && audio.src !== locationHref);
}

function normalizedSeconds(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

/**
 * Owns only client-local audio concerns that are outside PlaybackRuntime:
 * non-track radiohost overlays, music ducking, and best-effort listening telemetry.
 * Queue selection, current-song changes, track loading, and media facts belong
 * exclusively to playbackRuntimeClient.
 */
export function createPlaybackController({
  store,
  narrationAudio,
  musicAudio,
  narrationCoordinator = null,
  apiClient,
  storage,
  locationHref = globalThis.location?.href || '',
  audioGraph,
  getAudioGraph = () => audioGraph,
  callbacks = {},
} = {}) {
  if (!store || typeof store.getState !== 'function') throw new TypeError('playback store is required');
  if (!narrationAudio || !musicAudio) throw new TypeError('both audio channels are required');
  if (!apiClient || typeof apiClient.post !== 'function') throw new TypeError('playback api client is required');

  const notify = {
    onStatus: callbacks.onStatus || NOOP,
    onChanged: callbacks.onChanged || NOOP,
    onNarration: callbacks.onNarration || NOOP,
    onUnlock: callbacks.onUnlock || NOOP,
    onError: callbacks.onError || NOOP,
    onTimeUpdate: callbacks.onTimeUpdate || NOOP,
  };

  let initialized = false;
  let overlayQueue = [];
  let overlayActive = false;
  let overlayCurrent = null;
  let musicDucked = false;
  let duckLevel = 0.2;
  let activeDuckLevel = 1;
  let musicDuckOwner = null;
  let unsubscribeNarrationLifecycle = null;
  let outcomeReportedForUrl = null;
  const ownsNarrationCoordinator = !narrationCoordinator;
  const narrator = narrationCoordinator || createNarrationCoordinator({
    audio: narrationAudio,
    locationHref,
  });
  const overlayOwner = `playback-overlay:${Math.random().toString(36).slice(2)}`;
  const terminalCancelReasons = new Set([
    'playback-stopped',
    'playback-reset',
    'radiohost-changed',
    'overlay-controller-destroyed',
    'destroyed',
  ]);

  const state = () => store.getState();

  function currentTrackItem() {
    const runtime = state().runtimeState;
    const queue = state().queue || [];
    const queueItemId = runtime?.txn?.queueItemId
      || runtime?.queue?.[runtime?.currentIndex]?.queueItemId
      || null;
    if (queueItemId) {
      const exact = queue.find(item => item?.kind === 'track'
        && String(item.queueItemId || item.queue_item_id || '') === String(queueItemId));
      if (exact) return exact;
    }
    if (Number.isInteger(runtime?.currentIndex) && runtime.currentIndex >= 0) {
      const indexed = queue[runtime.currentIndex];
      if (indexed?.kind === 'track') return indexed;
    }
    const songId = runtime?.currentSongId;
    if (songId == null) return null;
    const matches = queue.filter(item => item?.kind === 'track'
      && String(item.song_id ?? item.songId ?? '') === String(songId));
    return matches.length === 1 ? matches[0] : null;
  }

  function currentPlayingSongId() {
    const songId = state().runtimeState?.currentSongId;
    return songId == null ? null : String(songId);
  }

  function hasRealMusicPlaying() {
    return !musicAudio.paused && realSource(musicAudio, locationHref);
  }

  function duckMusic(level = duckLevel, durationMs = 0, owner = overlayOwner) {
    const target = Math.max(0.05, Math.min(1, Number(level) || duckLevel));
    if (musicDucked && musicDuckOwner === owner && activeDuckLevel === target) return false;
    musicDucked = true;
    musicDuckOwner = owner;
    activeDuckLevel = target;
    // 有 Web Audio 图时 element volume 保留用户偏好，压低落在 GainNode 上相乘；
    // 无图回退不能把用户偏好覆写成压低值/固定 1，要显式相乘与还原。
    if (!getAudioGraph()?.setMusicGain?.(target, durationMs)) {
      musicAudio.volume = Math.min(1, getMusicVolumePreference() * target);
    }
    return true;
  }

  function restoreMusic(durationMs = 0, owner = null) {
    if (!musicDucked || (owner && musicDuckOwner !== owner)) return false;
    musicDucked = false;
    musicDuckOwner = null;
    activeDuckLevel = 1;
    if (!getAudioGraph()?.setMusicGain?.(1, durationMs)) {
      musicAudio.volume = getMusicVolumePreference();
    }
    return true;
  }

  function runtimeDuckOwner(task) {
    const command = task?.meta?.command || {};
    return `runtime-narration:${command.queueItemId || ''}:${command.correlationId || ''}:${command.outputGeneration ?? ''}`;
  }

  function onNarrationLifecycle(event) {
    const task = event?.task;
    const command = task?.meta?.command;
    if (task?.lane !== 'runtime' || command?.type !== 'PLAY_TRACK_NARRATION') return;
    const owner = runtimeDuckOwner(task);
    if (event.type === 'runtime-audible') {
      duckMusic(command.duckLevel, command.duckRampMs, owner);
    } else if (['finished', 'error', 'cancelled'].includes(event.type)) {
      restoreMusic(command.restoreRampMs, owner);
    }
  }

  function playNextOverlayNarration() {
    const item = overlayQueue.shift();
    if (!item) return finishOverlayNarrations();
    overlayActive = true;
    overlayCurrent = item;
    if (hasRealMusicPlaying()) duckMusic(duckLevel, 0, overlayOwner);
    notify.onChanged(getSnapshot());
    const token = narrator.enqueue({
      id: item.correlationId || `overlay:${Date.now()}:${overlayQueue.length}`,
      lane: 'foreground',
      url: item.url,
      meta: { owner: overlayOwner, item },
      onStart: () => {
        if (overlayCurrent !== item) return;
        // 人声不进波形图：analyser 只跟随播放器内容（歌曲/背景床）。
        // 聊天朗读不接管它，也不为此把 narrationAudio 挂进 Web Audio 图。
        notify.onNarration(item, { overlay: true });
        notify.onStatus('speaking');
        notify.onChanged(getSnapshot());
      },
      onFinish: () => {
        if (overlayCurrent === item) handleNarrationEnded();
      },
      onError: error => {
        notify.onError(error, item);
        if (overlayCurrent === item) handleNarrationEnded();
      },
      onCancel: reason => {
        if (overlayCurrent !== item) return;
        if (terminalCancelReasons.has(String(reason || ''))) {
          overlayQueue = [];
          finishOverlayNarrations();
          return;
        }
        handleNarrationEnded();
      },
    });
    if (token == null) {
      overlayCurrent = null;
      return playNextOverlayNarration();
    }
    return true;
  }

  function playOverlayNarrations(items) {
    const incoming = (items || []).filter(item => item?.url);
    if (!incoming.length) return false;
    overlayQueue.push(...incoming);
    if (!overlayActive) void playNextOverlayNarration();
    return true;
  }

  function finishOverlayNarrations() {
    overlayActive = false;
    overlayCurrent = null;
    restoreMusic();
    notify.onUnlock();
    notify.onStatus(hasRealMusicPlaying() ? 'playing' : 'Idle');
    notify.onChanged(getSnapshot());
    return true;
  }

  function handleNarrationEnded() {
    if (!overlayActive) return false;
    const finished = overlayCurrent;
    overlayCurrent = null;
    if (overlayQueue.length) {
      playNextOverlayNarration();
      return true;
    }
    if (finished?.keepThinkingOnEnd) {
      overlayActive = false;
      narrationAudio.src = '';
      restoreMusic();
      notify.onStatus('thinking');
      notify.onChanged(getSnapshot());
      return true;
    }
    return finishOverlayNarrations();
  }

  function queueOutcome(payload) {
    if (!storage) return;
    try {
      const existing = JSON.parse(storage.getItem(STORAGE_KEYS.outcomeQueue) || '[]');
      existing.push({ payload, attempts: 0 });
      storage.setItem(STORAGE_KEYS.outcomeQueue, JSON.stringify(existing.slice(-50)));
    } catch {
      storage.setItem(STORAGE_KEYS.outcomeQueue, JSON.stringify([{ payload, attempts: 0 }]));
    }
  }

  async function reportOutcomeForCurrent(outcome, playedSeconds) {
    const item = currentTrackItem();
    if (!item?.song_id) return false;
    if (outcomeReportedForUrl === item.url) return false;
    outcomeReportedForUrl = item.url;
    const payload = {
      song_id: item.song_id,
      outcome,
      played_seconds: normalizedSeconds(playedSeconds),
    };
    try {
      await apiClient.post('/api/play-outcome', payload);
      return true;
    } catch {
      queueOutcome(payload);
      return false;
    }
  }

  function reportPartial(sendBeacon, BlobImpl = globalThis.Blob) {
    const item = currentTrackItem();
    if (!item?.song_id || outcomeReportedForUrl === item.url) return false;
    const seconds = Number(musicAudio.currentTime) || 0;
    if (seconds < 1 || typeof sendBeacon !== 'function') return false;
    outcomeReportedForUrl = item.url;
    const body = JSON.stringify({
      song_id: item.song_id,
      outcome: 'partial',
      played_seconds: normalizedSeconds(seconds),
    });
    const payload = BlobImpl ? new BlobImpl([body], { type: 'application/json' }) : body;
    return Boolean(sendBeacon('/api/play-outcome', payload));
  }

  async function flushOutcomeQueue() {
    if (!storage) return [];
    let items;
    try {
      items = JSON.parse(storage.getItem(STORAGE_KEYS.outcomeQueue) || '[]');
    } catch {
      items = [];
    }
    const remaining = [];
    for (const item of items) {
      if ((item.attempts || 0) >= 3) continue;
      const payload = item.payload || (typeof item.body === 'string' ? JSON.parse(item.body) : item.body);
      try {
        await apiClient.post('/api/play-outcome', payload);
      } catch {
        remaining.push({ payload, attempts: (item.attempts || 0) + 1 });
      }
    }
    storage.setItem(STORAGE_KEYS.outcomeQueue, JSON.stringify(remaining));
    return remaining;
  }

  function resetOutcomeLatch() {
    outcomeReportedForUrl = null;
  }

  function setDuckLevel(value) {
    duckLevel = Math.max(0.05, Math.min(1, Number(value) || 0.2));
    return duckLevel;
  }

  function getSnapshot() {
    return Object.freeze({
      overlayActive,
      overlayCurrent,
      overlayQueueLength: overlayQueue.length,
      musicDucked,
      currentItem: currentTrackItem(),
    });
  }

  const listeners = {
    narrationTime: () => notify.onTimeUpdate(narrationAudio),
    musicTime: () => notify.onTimeUpdate(musicAudio),
    playState: () => notify.onChanged(getSnapshot()),
  };

  function init() {
    if (initialized) return api;
    initialized = true;
    narrator.init();
    unsubscribeNarrationLifecycle = narrator.subscribe?.(onNarrationLifecycle) || null;
    narrationAudio.addEventListener('timeupdate', listeners.narrationTime);
    musicAudio.addEventListener('timeupdate', listeners.musicTime);
    narrationAudio.addEventListener('play', listeners.playState);
    narrationAudio.addEventListener('pause', listeners.playState);
    musicAudio.addEventListener('play', listeners.playState);
    musicAudio.addEventListener('pause', listeners.playState);
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    narrationAudio.removeEventListener('timeupdate', listeners.narrationTime);
    musicAudio.removeEventListener('timeupdate', listeners.musicTime);
    narrationAudio.removeEventListener('play', listeners.playState);
    narrationAudio.removeEventListener('pause', listeners.playState);
    musicAudio.removeEventListener('play', listeners.playState);
    musicAudio.removeEventListener('pause', listeners.playState);
    narrator.cancel(task => task.meta?.owner === overlayOwner, 'overlay-controller-destroyed');
    unsubscribeNarrationLifecycle?.();
    unsubscribeNarrationLifecycle = null;
    overlayQueue = [];
    overlayActive = false;
    overlayCurrent = null;
    if (ownsNarrationCoordinator) narrator.destroy();
    restoreMusic();
  }

  const api = Object.freeze({
    init,
    destroy,
    playOverlayNarrations,
    finishOverlayNarrations,
    handleNarrationEnded,
    currentPlayingSongId,
    currentTrackItem,
    reportOutcomeForCurrent,
    reportPartial,
    flushOutcomeQueue,
    getSnapshot,
    hasRealMusicPlaying,
    duckMusic,
    restoreMusic,
    resetOutcomeLatch,
    setDuckLevel,
    cancelAllNarrations: reason => narrator.cancelAll(reason || 'playback-reset'),
  });
  return api;
}
