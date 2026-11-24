import { STORAGE_KEYS } from '../../core/storageKeys.js';
import { createNarrationCoordinator } from './narrationCoordinator.js';
import { getMusicVolumePreference, setMusicVolumePreference } from './musicVolumePreference.js';

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
  setTimer = (fn, ms) => { const h = setTimeout(fn, ms); h?.unref?.(); return h; },
  clearTimer = handle => clearTimeout(handle),
  turnDuckSafetyMs = 15_000,
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
  let overlayCurrentMeta = null;
  let musicDucked = false;
  let duckLevel = 0.2;
  let activeDuckLevel = 1;
  let musicDuckOwner = null;
  let activeTurnDuckLease = null;
  let lastTrackSignature = null;
  let unsubscribeStore = null;
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
    'user-stopped',
    'user-voice-switch',
    'track-switched',
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

  function activeTrackSignature() {
    const rt = state().runtimeState;
    const queueItemId = rt?.txn?.queueItemId
      || rt?.queue?.[rt?.currentIndex]?.queueItemId
      || '';
    return `${rt?.activeListeningSessionId || ''}|${rt?.currentSongId ?? ''}|${queueItemId}`;
  }

  function shouldHoldLease(metaOrItem) {
    return Boolean(metaOrItem?.turnDuckLeaseId && metaOrItem?.holdDuckLease === true && metaOrItem?.isLastBeat !== true);
  }

  function itemMatchesLease(entry, cleanId) {
    if (!entry || !cleanId) return false;
    return String(entry.turnDuckLeaseId || '') === cleanId
      || String(entry.sourceTurnId || '') === cleanId;
  }

  function releaseTurnDuckLease(leaseId = null) {
    if (!activeTurnDuckLease) return false;
    const targetId = leaseId == null ? null : String(leaseId);
    if (targetId && activeTurnDuckLease.leaseId !== targetId) return false;
    const { owner, timer } = activeTurnDuckLease;
    if (timer != null) clearTimer(timer);
    activeTurnDuckLease = null;
    restoreMusic(0, owner);
    notify.onChanged(getSnapshot());
    return true;
  }

  function acquireOrRefreshTurnDuckLease(leaseId, { hold = false } = {}) {
    const cleanId = String(leaseId || '').trim();
    if (!cleanId) return null;
    if (activeTurnDuckLease && activeTurnDuckLease.leaseId !== cleanId) {
      releaseTurnDuckLease(activeTurnDuckLease.leaseId);
    }
    if (activeTurnDuckLease?.timer != null) {
      clearTimer(activeTurnDuckLease.timer);
    }
    const owner = `turn-duck:${cleanId}`;
    if (hasRealMusicPlaying() || musicDucked) {
      duckMusic(duckLevel, 0, owner);
    }
    const timer = setTimer(() => {
      releaseTurnDuckLease(cleanId);
    }, turnDuckSafetyMs);
    activeTurnDuckLease = { leaseId: cleanId, owner, hold: Boolean(hold), timer };
    return owner;
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

  /**
   * 统一从用户音量偏好落盘与驱动音频通道：有 WebAudio 图时 GainNode 承担压低比例，
   * 跨源降级或无图回退时显式把偏好与当前 duck 比例相乘，避免混音拖满破坏压低。
   */
  function applyMusicVolume(nextValue) {
    const pref = setMusicVolumePreference(nextValue);
    const targetGain = musicDucked ? activeDuckLevel : 1;
    if (!getAudioGraph()?.setMusicGain?.(targetGain, 0)) {
      musicAudio.volume = Math.min(1, pref * targetGain);
    } else {
      musicAudio.volume = pref;
    }
    return pref;
  }

  function runtimeDuckOwner(task) {
    const command = task?.meta?.command || {};
    return `runtime-narration:${command.queueItemId || ''}:${command.correlationId || ''}:${command.outputGeneration ?? ''}`;
  }

  function onNarrationLifecycle(event) {
    const task = event?.task;
    const command = task?.meta?.command;
    if (task?.lane === 'runtime' && command?.type === 'PLAY_TRACK_NARRATION') {
      const owner = runtimeDuckOwner(task);
      if (event.type === 'runtime-audible') {
        if (activeTurnDuckLease) releaseTurnDuckLease();
        duckMusic(command.duckLevel, command.duckRampMs, owner);
      } else if (['finished', 'error', 'cancelled'].includes(event.type)) {
        restoreMusic(command.restoreRampMs, owner);
      }
      return;
    }
    const leaseId = task?.meta?.turnDuckLeaseId;
    if (task?.lane === 'foreground' && task?.meta?.owner !== overlayOwner && leaseId) {
      const hold = shouldHoldLease(task.meta);
      if (event.type === 'started') {
        acquireOrRefreshTurnDuckLease(leaseId, { hold });
      } else if (event.type === 'finished') {
        if (hold) acquireOrRefreshTurnDuckLease(leaseId, { hold: true });
        else releaseTurnDuckLease(leaseId);
      } else if (event.type === 'cancelled' || event.type === 'error') {
        releaseTurnDuckLease(leaseId);
      }
    }
  }

  function playNextOverlayNarration() {
    const item = overlayQueue.shift();
    if (!item) return finishOverlayNarrations();
    overlayActive = true;
    overlayCurrent = item;
    const leaseId = item.turnDuckLeaseId ? String(item.turnDuckLeaseId) : null;
    const taskMeta = {
      owner: overlayOwner,
      item,
      sourceTurnId: item.sourceTurnId || null,
      beatIndex: Number.isInteger(item.beatIndex) ? item.beatIndex : null,
      beatCount: Number.isInteger(item.beatCount) ? item.beatCount : null,
      isLastBeat: item.isLastBeat === true ? true : item.isLastBeat === false ? false : null,
      turnDuckLeaseId: leaseId,
      holdDuckLease: Boolean(item.holdDuckLease),
    };
    overlayCurrentMeta = taskMeta;
    notify.onChanged(getSnapshot());
    const token = narrator.enqueue({
      id: item.correlationId || `overlay:${Date.now()}:${overlayQueue.length}`,
      lane: 'foreground',
      url: item.url,
      delayBeforeMs: item.delayBeforeMs,
      meta: taskMeta,
      beforeStart: () => {
        if (overlayCurrent !== item) return false;
        const hold = shouldHoldLease(item);
        if (leaseId) {
          acquireOrRefreshTurnDuckLease(leaseId, { hold });
        } else if (hasRealMusicPlaying()) {
          duckMusic(duckLevel, 0, overlayOwner);
        }
        return true;
      },
      onStart: () => {
        if (overlayCurrent !== item) return;
        const hold = shouldHoldLease(item);
        if (leaseId) {
          acquireOrRefreshTurnDuckLease(leaseId, { hold });
        } else if (hasRealMusicPlaying()) {
          duckMusic(duckLevel, 0, overlayOwner);
        }
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
        if (leaseId) {
          overlayQueue = overlayQueue.filter(queued => !itemMatchesLease(queued, leaseId));
          releaseTurnDuckLease(leaseId);
        }
        if (overlayCurrent === item) {
          if (leaseId) {
            overlayCurrent = null;
            overlayCurrentMeta = null;
            if (overlayQueue.length) playNextOverlayNarration();
            else finishOverlayNarrations();
          } else {
            handleNarrationEnded();
          }
        }
      },
      onCancel: reason => {
        if (leaseId) {
          overlayQueue = overlayQueue.filter(queued => !itemMatchesLease(queued, leaseId));
          releaseTurnDuckLease(leaseId);
        }
        if (overlayCurrent !== item) return;
        if (leaseId || terminalCancelReasons.has(String(reason || ''))) {
          if (terminalCancelReasons.has(String(reason || ''))) overlayQueue = [];
          if (overlayQueue.length) {
            overlayCurrent = null;
            overlayCurrentMeta = null;
            playNextOverlayNarration();
          } else {
            finishOverlayNarrations();
          }
          return;
        }
        handleNarrationEnded();
      },
    });
    if (token == null) {
      if (leaseId && !shouldHoldLease(item)) releaseTurnDuckLease(leaseId);
      overlayCurrent = null;
      overlayCurrentMeta = null;
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

  function hasOverlayForTurn(turnId) {
    const cleanId = String(turnId || '').trim();
    if (!cleanId) return false;
    return itemMatchesLease(overlayCurrent, cleanId) || overlayQueue.some(item => itemMatchesLease(item, cleanId));
  }

  function sealTurnDuckLease(leaseId) {
    const cleanId = String(leaseId || '').trim();
    if (!cleanId) return false;
    for (let i = overlayQueue.length - 1; i >= 0; i -= 1) {
      if (itemMatchesLease(overlayQueue[i], cleanId)) {
        overlayQueue[i] = { ...overlayQueue[i], holdDuckLease: false, isLastBeat: true };
        notify.onChanged(getSnapshot());
        return true;
      }
    }
    if (itemMatchesLease(overlayCurrent, cleanId)) {
      overlayCurrent.holdDuckLease = false;
      overlayCurrent.isLastBeat = true;
      if (overlayCurrentMeta && itemMatchesLease(overlayCurrentMeta, cleanId)) {
        overlayCurrentMeta.holdDuckLease = false;
        overlayCurrentMeta.isLastBeat = true;
      }
      if (activeTurnDuckLease?.leaseId === cleanId) {
        activeTurnDuckLease.hold = false;
      }
      notify.onChanged(getSnapshot());
      return true;
    }
    if (activeTurnDuckLease?.leaseId === cleanId) {
      releaseTurnDuckLease(cleanId);
      if (!overlayActive && overlayQueue.length === 0) {
        finishOverlayNarrations();
      }
      return true;
    }
    return false;
  }

  function finishOverlayNarrations() {
    overlayActive = false;
    overlayCurrent = null;
    overlayCurrentMeta = null;
    if (!activeTurnDuckLease) restoreMusic(0, overlayOwner);
    notify.onUnlock();
    notify.onStatus(hasRealMusicPlaying() ? 'playing' : 'Idle');
    notify.onChanged(getSnapshot());
    return true;
  }

  function stopOverlayNarrations() {
    const hadOverlayWork = overlayActive || overlayQueue.length > 0;
    const hadLease = Boolean(activeTurnDuckLease);
    if (!hadOverlayWork && !hadLease) return false;
    const wasActive = overlayActive;
    overlayQueue = [];
    releaseTurnDuckLease();
    narrator.cancel(task => task.meta?.owner === overlayOwner, 'user-stopped');
    if (overlayActive || (!wasActive && (hadLease || hadOverlayWork))) {
      finishOverlayNarrations();
    }
    return true;
  }

  function handleNarrationEnded() {
    if (!overlayActive) return false;
    const finished = overlayCurrent;
    overlayCurrent = null;
    overlayCurrentMeta = null;
    const leaseId = finished?.turnDuckLeaseId ? String(finished.turnDuckLeaseId) : null;
    const hold = shouldHoldLease(finished);
    if (overlayQueue.length) {
      if (leaseId && hold) {
        acquireOrRefreshTurnDuckLease(leaseId, { hold: true });
      } else if (leaseId && !hold) {
        releaseTurnDuckLease(leaseId);
      }
      playNextOverlayNarration();
      return true;
    }
    if (leaseId && hold) {
      // 流水线多拍中间：本拍播完但下一拍还在合成途中，保持音乐闪避不抬回，依赖租约与兜底计时器。
      overlayActive = false;
      acquireOrRefreshTurnDuckLease(leaseId, { hold: true });
      notify.onChanged(getSnapshot());
      return true;
    }
    if (leaseId && !hold) {
      releaseTurnDuckLease(leaseId);
    }
    if (finished?.keepThinkingOnEnd) {
      overlayActive = false;
      narrationAudio.src = '';
      if (!activeTurnDuckLease) restoreMusic(0, overlayOwner);
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
      turnDuckLeaseId: activeTurnDuckLease?.leaseId || null,
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
    lastTrackSignature = activeTrackSignature();
    unsubscribeStore = store.subscribe?.(() => {
      const nextSig = activeTrackSignature();
      if (nextSig !== lastTrackSignature) {
        lastTrackSignature = nextSig;
        if (activeTurnDuckLease) {
          const leaseId = activeTurnDuckLease.leaseId;
          overlayQueue = overlayQueue.filter(item => !itemMatchesLease(item, leaseId));
          releaseTurnDuckLease(leaseId);
          narrator.cancel(task => task?.meta?.turnDuckLeaseId === leaseId, 'track-switched');
        }
      }
    }) || null;
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
    unsubscribeStore?.();
    unsubscribeStore = null;
    overlayQueue = [];
    overlayActive = false;
    overlayCurrent = null;
    overlayCurrentMeta = null;
    releaseTurnDuckLease();
    if (ownsNarrationCoordinator) narrator.destroy();
    restoreMusic(0, overlayOwner);
  }

  const api = Object.freeze({
    init,
    destroy,
    playOverlayNarrations,
    finishOverlayNarrations,
    stopOverlayNarrations,
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
    releaseTurnDuckLease,
    sealTurnDuckLease,
    hasOverlayForTurn,
    applyMusicVolume,
    resetOutcomeLatch,
    setDuckLevel,
    cancelAllNarrations: reason => {
      overlayQueue = [];
      releaseTurnDuckLease();
      return narrator.cancelAll(reason || 'playback-reset');
    },
  });
  return api;
}
