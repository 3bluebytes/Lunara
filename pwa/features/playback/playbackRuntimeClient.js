import { createNarrationCoordinator } from './narrationCoordinator.js';
import { getMusicVolumePreference } from './musicVolumePreference.js';
import { reduceServerMessage } from '../../core/appState.js';

const COMMAND_TYPES = new Set([
  'SHOW_TRACK_INTRO',
  'PLAY_TTS',
  'PLAY_TRACK_NARRATION',
  'PLAY_TRACK',
  'PAUSE_TRACK',
  'RESUME_TRACK',
  'STOP_PLAYBACK',
  'CANCEL_TRACK_NARRATION',
]);
const MEDIA_FACT_TYPES = new Set([
  'TRACK_STARTED', 'TRACK_REATTACHED', 'TRACK_ENDED', 'TRACK_FAILED', 'TTS_FINISHED', 'TTS_FAILED',
  'POSITION_REPORTED', 'NARRATION_DELIVERY_STARTED', 'NARRATION_DELIVERY_AUDIBLE',
  'NARRATION_DELIVERY_FINISHED', 'NARRATION_DELIVERY_FAILED', 'NARRATION_DELIVERY_CANCELLED',
]);

/**
 * 媒体失败 → 封闭分类。浏览器给的 message 里可能带直链或上游报文，既不该进日志
 * 也不该进 runtime 状态；这里只保留「大概是哪一类」，让「是否值得同源刷新重取」
 * 有得可量（change 8.6）。
 */
const MEDIA_ERROR_KINDS = Object.freeze({ 1: 'aborted', 2: 'network', 3: 'decode', 4: 'unsupported' });

function trackFailureKind(error) {
  const code = Number(error?.code ?? error?.target?.error?.code);
  if (MEDIA_ERROR_KINDS[code]) return MEDIA_ERROR_KINDS[code];
  const name = String(error?.name || '');
  if (name === 'NotSupportedError') return 'unsupported';
  if (name === 'AbortError') return 'aborted';
  return 'unknown';
}

function sourceMatches(actual, expected, locationHref) {
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  try { return new URL(expected, locationHref).href === actual; } catch { return false; }
}

// The runtime's settle timer and the media clock disagree by milliseconds; a queued
// introduction waits this long (and this much per step) to reach the bound.
const NARRATION_PREFLIGHT_WAIT_MS = 1_500;
const NARRATION_PREFLIGHT_STEP_MS = 100;

function commandKey(command) {
  return `${command.runtimeVersion}:${command.queueItemId || command.correlationId || command.songId || 'runtime'}:${command.correlationId || ''}:${command.type}`;
}

export function createPlaybackRuntimeClient({
  store,
  narrationAudio,
  musicAudio,
  narrationCoordinator = null,
  apiClient,
  locationHref = globalThis.location?.href || '',
  ttsTimeoutMs = 30_000,
  trackLoadTimeoutMs = 20_000,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelSchedule = timer => globalThis.clearTimeout(timer),
  // A fresh page is a new media owner: its facts must be distinguishable from the
  // window that closed, while staying stable for dedupe within this instance.
  clientId = globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random()}`,
  eventIdFactory = (() => {
    let seq = 0;
    return prefix => `${prefix}:${clientId}:${++seq}`;
  })(),
  callbacks = {},
} = {}) {
  if (!store?.getState || !narrationAudio || !musicAudio || !apiClient?.post) {
    throw new TypeError('runtime playback client dependencies are required');
  }
  const handledCommands = new Set();
  const postedFacts = new Set();
  const dismissalRequests = new Map();
  let activeTts = null;
  let activeTrack = null;
  let activeRuntimeNarration = null;
  let autoplayBlockedCommand = null;
  let trackStartConfirmation = Promise.resolve();
  let ttsTimer = null;
  let trackTimer = null;
  let initialized = false;
  let lastPositionReported = 0;
  let listeningSwitch = Promise.resolve();
  const ownsNarrationCoordinator = !narrationCoordinator;
  const narrator = narrationCoordinator || createNarrationCoordinator({
    audio: narrationAudio,
    locationHref,
  });

  const notify = {
    onIntro: callbacks.onIntro || (() => {}),
    onNarration: callbacks.onNarration || (() => {}),
    onTrack: callbacks.onTrack || (() => {}),
    onStatus: callbacks.onStatus || (() => {}),
    onChanged: callbacks.onChanged || (() => {}),
    onError: callbacks.onError || (() => {}),
    onTrackEnded: callbacks.onTrackEnded || (() => {}),
    onAutoplayBlocked: callbacks.onAutoplayBlocked || (() => {}),
  };

  function runtimeState() {
    return store.getState().runtimeState || null;
  }

  function identityFrom(command = {}) {
    return {
      runtimeVersion: command.runtimeVersion,
      songId: command.songId,
      programId: command.programId,
      correlationId: command.correlationId,
      ...(command.queueItemId ? { queueItemId: command.queueItemId } : {}),
      ...(command.listeningSessionId ? { listeningSessionId: command.listeningSessionId } : {}),
      ...(command.outputGeneration != null ? { outputGeneration: command.outputGeneration } : {}),
    };
  }

  function mediaFactIdentity(command) {
    const identity = identityFrom(command);
    const snapshot = runtimeState();
    const track = snapshot?.queue?.[snapshot.currentIndex];
    // Unrelated transitions (pause/resume, radio mode, queue append) advance
    // the version without replacing the media. Refresh only that exact txn:
    // an old callback must never borrow the version of a different playback.
    if (command.songId && command.programId && command.correlationId
      && track?.songId === command.songId && track.programId === command.programId
      && snapshot.txn?.correlationId === command.correlationId
      && (!command.queueItemId || (track.queueItemId === command.queueItemId
        && snapshot.txn?.queueItemId === command.queueItemId))
      && (!command.listeningSessionId || snapshot.activeListeningSessionId === command.listeningSessionId)
      && (command.outputGeneration == null || snapshot.outputGeneration === command.outputGeneration)
      && Number.isInteger(snapshot.version) && snapshot.version >= command.runtimeVersion) {
      identity.runtimeVersion = snapshot.version;
    }
    return identity;
  }

  async function postFact(type, command, details = {}, { notifyFailure = true } = {}) {
    // Media facts a reopened or reloaded client must be able to re-assert for the
    // activation it just re-attached are scoped to this client instance, so a fresh
    // page is not rejected as a duplicate of the window that closed. Repeated facts
    // from the same instance still dedupe in this page and on the runtime.
    const eventId = details.eventId
      || `${clientId}:${command.queueItemId || command.correlationId || command.songId}:${command.correlationId || ''}:${type}`;
    if (postedFacts.has(eventId)) return { accepted: false, duplicate: true };
    postedFacts.add(eventId);
    try {
      const result = await apiClient.post('/api/pb-event', {
        type,
        eventId,
        ...(MEDIA_FACT_TYPES.has(type) ? mediaFactIdentity(command) : identityFrom(command)),
        ...details,
      });
      if (result.state) reduceServerMessage(store, { type: 'runtime-state', state: result.state });
      for (const nextCommand of result.commands || []) await execute(nextCommand);
      return result;
    } catch (error) {
      postedFacts.delete(eventId);
      if (notifyFailure) notify.onError(error, command);
      return { accepted: false, error };
    }
  }

  async function postControl(type, details = {}, options = {}) {
    const snapshot = runtimeState();
    if (!snapshot) return { accepted: false, error: new Error('runtime state unavailable') };
    const current = snapshot.queue?.[snapshot.currentIndex] || {};
    // A control that names its own target — a song card, a queue row — must not also
    // carry the current occurrence's identity: the runtime resolves an explicit
    // queueItemId/songId first, so sending the current one would act on the song that is
    // already playing instead of the requested one.
    const namesTarget = details.queueItemId != null || details.songId != null;
    return postFact(type, {
      runtimeVersion: snapshot.version,
      ...(namesTarget ? {} : {
        songId: current.songId || snapshot.currentSongId,
        queueItemId: current.queueItemId || snapshot.txn?.queueItemId || null,
      }),
      programId: current.programId || snapshot.txn?.programId,
      correlationId: snapshot.txn?.correlationId || null,
      listeningSessionId: snapshot.activeListeningSessionId,
      outputGeneration: snapshot.outputGeneration,
    }, { ...details, eventId: eventIdFactory(type.toLowerCase()) }, options);
  }

  function narrationActivationMatches(command, snapshot = runtimeState()) {
    const track = snapshot?.queue?.[snapshot.currentIndex];
    const txn = snapshot?.txn;
    return Boolean(command?.queueItemId && command?.correlationId && command?.listeningSessionId
      && Number.isInteger(command.outputGeneration)
      && snapshot?.activeListeningSessionId === command.listeningSessionId
      && snapshot?.outputGeneration === command.outputGeneration
      && track?.queueItemId === command.queueItemId
      && track?.songId === command.songId
      && track?.programId === command.programId
      && txn?.queueItemId === command.queueItemId
      && txn?.correlationId === command.correlationId
      && txn?.programId === command.programId
      && txn?.songId === command.songId);
  }

  function playTrackActivationMatches(command, snapshot = runtimeState()) {
    const track = snapshot?.queue?.[snapshot.currentIndex];
    const txn = snapshot?.txn;
    const currentSongId = track?.songId ?? snapshot?.currentSongId;
    const currentProgramId = track?.programId ?? txn?.programId;
    const trackUrl = String(track?.url || '').trim();
    const commandUrl = String(command?.url || '').trim();
    if (!snapshot || !track || !['loading', 'playing'].includes(snapshot.phase)
      || currentSongId !== command.songId || currentProgramId !== command.programId
      || (txn?.songId != null && txn.songId !== command.songId)
      || (txn?.programId != null && txn.programId !== command.programId)
      || txn?.correlationId !== command.correlationId
      || !trackUrl || !commandUrl || !sourceMatches(trackUrl, commandUrl, locationHref)) return false;
    if (!command.queueItemId) {
      return (!command.listeningSessionId || snapshot.activeListeningSessionId === command.listeningSessionId)
        && (command.outputGeneration == null || snapshot.outputGeneration === command.outputGeneration);
    }
    return track.queueItemId === command.queueItemId
      && txn.queueItemId === command.queueItemId
      && command.listeningSessionId === snapshot.activeListeningSessionId
      && command.outputGeneration === snapshot.outputGeneration;
  }

  /**
   * Why a narration command cannot be delivered right now. `early` is the one reason
   * that is worth waiting for: the runtime arms its insertion window when it receives
   * the track-start fact, while the browser measures the media's own clock, so those two
   * clocks routinely disagree by a few dozen milliseconds. Treating that disagreement as
   * an expired window silently threw away most introductions.
   */
  function narrationPreflight(command) {
    const snapshot = runtimeState();
    if (!narrationActivationMatches(command, snapshot) || snapshot.phase !== 'playing'
      || !activeTrack || activeTrack.queueItemId !== command.queueItemId
      || activeTrack.correlationId !== command.correlationId
      || !sourceMatches(musicAudio.src, activeTrack.url, locationHref)
      || musicAudio.paused) return { reason: 'not-attached' };
    const track = snapshot.queue[snapshot.currentIndex];
    const positionSeconds = Number(musicAudio.currentTime);
    const durationSeconds = Number(musicAudio.duration) > 0
      ? Number(musicAudio.duration) : Number(track?.duration);
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0
      || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return { reason: 'invalid-media' };
    const settlingDelayMs = Math.max(0, Number(command.settlingDelayMs) || 0);
    const maxStartOffsetMs = Math.max(settlingDelayMs, Number(command.maxStartOffsetMs) || 0);
    const minRemainingMs = Math.max(0, Number(command.minRemainingMs) || 0);
    if (positionSeconds * 1000 > maxStartOffsetMs
      || (durationSeconds - positionSeconds) * 1000 < minRemainingMs) return { reason: 'expired' };
    if (positionSeconds * 1000 < settlingDelayMs) {
      return { reason: 'early', waitMs: Math.ceil(settlingDelayMs - positionSeconds * 1000) };
    }
    return { measurement: { positionSeconds, durationSeconds } };
  }

  /** Evidence that the introduction is sounding, used for the audible acknowledgement. */
  function narrationMeasurement(command) {
    const preflight = narrationPreflight(command);
    return preflight.measurement || null;
  }

  function deliveryStateIs(result, command, status) {
    const snapshot = result?.state || runtimeState();
    return narrationActivationMatches(command, snapshot)
      && snapshot.txn?.narrationDelivery === status;
  }

  function resultAccepted(result) {
    return Boolean(result && result.accepted !== false && result.ok !== false && !result.error);
  }

  function postDeliveryFact(type, command, details = {}) {
    return postFact(type, command, {
      ...details,
      eventId: `${type}:${command.queueItemId}:${command.correlationId}:${command.outputGeneration}`,
    });
  }

  function queuedControl(type, details) {
    const run = async () => {
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const result = await postControl(type, details(), { notifyFailure: false });
        const reason = result.error?.message || result.reason || '';
        if ((result.error || result.accepted === false) && attempt < maxAttempts - 1
          && /stale (runtime version|output generation)/.test(reason) && apiClient.get) {
          const current = await apiClient.get('/api/now');
          reduceServerMessage(store, { type: 'runtime-state', state: current.runtime });
          continue;
        }
        if (result.error || result.accepted === false || result.ok === false) {
          throw result.error || new Error(reason || '播放操作未完成，请重试。');
        }
        // HTTP confirms the switch even if WebSocket delivery is late or interrupted.
        // Both transports share command deduplication and monotonic state versions.
        if (result.state) reduceServerMessage(store, { type: 'runtime-state', state: result.state });
        for (const command of result.commands || []) await execute(command);
        notify.onChanged();
        return result;
      }
    };
    const result = listeningSwitch.then(run, run);
    listeningSwitch = result.catch(() => {});
    return result;
  }

  function executeTrackNarration(command) {
    if (!command.url || !narrationActivationMatches(command)) return false;
    clearTtsTimer();
    narrator.cancel(task => task.lane === 'runtime'
      && task.meta?.command?.type === 'PLAY_TRACK_NARRATION'
      && task.meta.command.queueItemId !== command.queueItemId, 'narration-replaced');
    activeRuntimeNarration = command;

    narrator.enqueue({
      id: commandKey(command),
      lane: 'runtime',
      url: command.url,
      meta: { command },
      beforeStart: async () => {
        const deadline = Date.now() + NARRATION_PREFLIGHT_WAIT_MS;
        for (;;) {
          if (activeRuntimeNarration !== command
            || runtimeState()?.txn?.narrationDelivery !== 'queued') {
            return false;
          }
          const preflight = narrationPreflight(command);
          if (preflight.measurement) {
            const result = await postDeliveryFact('NARRATION_DELIVERY_STARTED', command, preflight.measurement);
            if (resultAccepted(result) && deliveryStateIs(result, command, 'starting')) return true;
          } else if (preflight.reason !== 'early') {
            return false;
          }
          // Still early, or the runtime answered that its window has not settled yet:
          // wait for the media to reach the bound, but only while the runtime still holds
          // this delivery as queued and within a bounded window.
          const waitMs = Math.min(NARRATION_PREFLIGHT_STEP_MS, Math.max(20, preflight.waitMs || NARRATION_PREFLIGHT_STEP_MS));
          if (Date.now() >= deadline) return false;
          await waitFor(waitMs);
        }
      },
      onStart: async task => {
        if (activeRuntimeNarration !== command) return false;
        const measurement = narrationMeasurement(command);
        if (!measurement) return false;
        const result = await postDeliveryFact('NARRATION_DELIVERY_AUDIBLE', command, measurement);
        if (!resultAccepted(result) || !deliveryStateIs(result, command, 'speaking')) return false;
        clearTtsTimer();
        ttsTimer = schedule(() => {
          if (activeRuntimeNarration !== command) return;
          ttsTimer = null;
          void postDeliveryFact('NARRATION_DELIVERY_FAILED', command, { error: 'narration timeout' });
          narrator.cancel(candidate => candidate.meta?.command === command, 'tts-timeout');
        }, Math.max(1, Number(ttsTimeoutMs) || 30_000));
        notify.onNarration(command, { overlay: true });
        notify.onStatus('speaking');
        notify.onChanged();
        narrator.publishLifecycle('runtime-audible', task, command);
        return true;
      },
      onFinish: () => {
        if (activeRuntimeNarration !== command) return;
        clearTtsTimer();
        activeRuntimeNarration = null;
        void postDeliveryFact('NARRATION_DELIVERY_FINISHED', command);
        notify.onStatus('playing');
        notify.onChanged();
      },
      onError: error => {
        if (activeRuntimeNarration !== command) return;
        clearTtsTimer();
        activeRuntimeNarration = null;
        void postDeliveryFact('NARRATION_DELIVERY_FAILED', command, { error: error?.message || 'narration media error' });
        notify.onError(error, command);
        notify.onChanged();
      },
      onCancel: reason => {
        if (activeRuntimeNarration !== command) return;
        clearTtsTimer();
        activeRuntimeNarration = null;
        if (reason !== 'tts-timeout') {
          void postDeliveryFact('NARRATION_DELIVERY_CANCELLED', command, { reason: String(reason || 'cancelled') });
        }
        notify.onChanged();
      },
    });
    return true;
  }

  function listenWith(listeningSessionId, delivery = 'now') {
    return queuedControl('LISTENING_SESSION_SWITCH_REQUESTED', () => ({
      listeningSessionId, delivery, positionSeconds: Number(musicAudio.currentTime) || 0,
    }));
  }

  /** The media this client holds for the runtime's current occurrence, if any. */
  function attachedCurrentTrack() {
    if (!activeTrack || musicAudio.paused) return null;
    const snapshot = runtimeState();
    const track = snapshot?.queue?.[snapshot.currentIndex];
    if (!track || !activeTrack.queueItemId || activeTrack.queueItemId !== track.queueItemId
      || activeTrack.correlationId !== snapshot.txn?.correlationId
      || !sourceMatches(musicAudio.src, activeTrack.url, locationHref)) return null;
    return { track, command: activeTrack, positionSeconds: Math.max(0, Number(musicAudio.currentTime) || 0) };
  }

  /**
   * A reissued activation must never restart media this client already owns. When the
   * runtime still holds that activation as unconfirmed there is no second start fact
   * to report, so the attachment itself is confirmed once, with the real position.
   * The media source, position and playback state are left untouched.
   */
  function confirmReattachedActivation(command) {
    const attached = attachedCurrentTrack();
    if (!attached || attached.command !== activeTrack) return false;
    if (runtimeState()?.phase !== 'loading') return false;
    if (attached.track.queueItemId !== command.queueItemId
      || attached.command.correlationId !== command.correlationId) return false;
    void postFact('TRACK_REATTACHED', command, {
      positionSeconds: attached.positionSeconds,
      // Scoped by the reissued command's version: one confirmation per reissue, still
      // idempotent on the runtime, and never mistaken for a duplicate start fact.
      eventId: `${clientId}:${command.queueItemId}:${command.correlationId}:TRACK_REATTACHED:${command.runtimeVersion}`,
    });
    return true;
  }

  function currentQueueTrack(songId, queueItemId = null) {
    const queue = store.getState().queue || [];
    if (queueItemId) return queue.find(item => item?.queueItemId === queueItemId) || null;
    const matches = queue.filter(item => String(item?.song_id || '') === String(songId || ''));
    return matches.length === 1 ? matches[0] : null;
  }

  function clearTtsTimer() {
    if (ttsTimer != null) cancelSchedule(ttsTimer);
    ttsTimer = null;
  }

  /** A short, cancellable wait used while a narration command waits for its window. */
  function waitFor(ms) {
    return new Promise(resolve => { schedule(resolve, Math.max(0, Number(ms) || 0)); });
  }

  function clearTrackTimer() {
    if (trackTimer != null) cancelSchedule(trackTimer);
    trackTimer = null;
  }

  async function startActivation(command) {
    clearTtsTimer();
    clearTrackTimer();
    activeTts = null;
    const activeCommand = { ...command };
    if (activeRuntimeNarration && (activeRuntimeNarration.queueItemId !== activeCommand.queueItemId
      || activeRuntimeNarration.correlationId !== activeCommand.correlationId)) {
      narrator.cancel(task => task.lane === 'runtime'
        && task.meta?.command?.type === 'PLAY_TRACK_NARRATION', 'track-replaced');
    }
    musicAudio.pause();
    activeTrack = activeCommand;
    autoplayBlockedCommand = null;
    trackStartConfirmation = Promise.resolve();
    // 歌曲按用户自己的音乐音量偏好（本地设备级）播放。
    musicAudio.volume = getMusicVolumePreference();
    musicAudio.src = command.url;
    lastPositionReported = Date.now();
    if (command.positionSeconds > 0) {
      try { musicAudio.currentTime = command.positionSeconds; } catch { /* metadata listener retries after loading */ }
    }
    trackTimer = schedule(() => {
      if (activeTrack !== activeCommand) return;
      activeTrack = null;
      trackTimer = null;
      musicAudio.pause();
      void postFact('TRACK_FAILED', activeCommand, { error: 'timeout', failureKind: 'timeout' });
    }, Math.max(1, Number(trackLoadTimeoutMs) || 20_000));
    let playPromise;
    try {
      // Start the music lane before UI callbacks can release another voice
      // task; track playback must not wait for the narration lane.
      playPromise = musicAudio.play();
    } catch (error) {
      playPromise = Promise.reject(error);
    }
    notify.onTrack(currentQueueTrack(command.songId, command.queueItemId) || command);
    notify.onStatus('loading');
    notify.onChanged();
    try {
      await playPromise;
    } catch (error) {
      if (activeTrack !== activeCommand) return true;
      clearTrackTimer();
      if (error?.name === 'NotAllowedError') {
        autoplayBlockedCommand = activeCommand;
        notify.onStatus('autoplay-blocked');
        notify.onAutoplayBlocked(error, activeCommand);
      } else {
        activeTrack = null;
        autoplayBlockedCommand = null;
        await postFact('TRACK_FAILED', activeCommand, { error: trackFailureKind(error), failureKind: trackFailureKind(error) });
      }
    }
    return true;
  }

  async function execute(command) {
    if (!command || !COMMAND_TYPES.has(command.type)) return false;
    const snapshot = runtimeState();
    if (command.outputGeneration != null && snapshot?.outputGeneration != null
      && command.outputGeneration < snapshot.outputGeneration) return false;
    const key = commandKey(command);
    if (handledCommands.has(key)) return false;
    handledCommands.add(key);

    if (command.type === 'SHOW_TRACK_INTRO') {
      notify.onIntro(command);
      notify.onChanged();
      return true;
    }

    if (command.type === 'PLAY_TRACK_NARRATION') {
      return executeTrackNarration(command);
    }

    if (command.type === 'PLAY_TTS') {
      clearTtsTimer();
      narrator.cancel(task => task.lane === 'runtime', 'runtime-tts-superseded');
      activeTts = command;
      narrator.enqueue({
        id: commandKey(command),
        lane: 'runtime',
        url: command.url,
        meta: { command },
        onStart: () => {
          if (activeTts !== command) return;
          ttsTimer = schedule(() => {
            if (activeTts !== command) return;
            narrator.cancel(task => task.meta?.command === command, 'tts-timeout');
            activeTts = null;
            ttsTimer = null;
            void postFact('TTS_FAILED', command, { error: 'tts timeout' });
          }, Math.max(1, Number(ttsTimeoutMs) || 30_000));
          notify.onNarration(command);
          notify.onStatus('speaking');
          notify.onChanged();
        },
        onFinish: () => {
          if (activeTts !== command) return;
          clearTtsTimer();
          activeTts = null;
          void postFact('TTS_FINISHED', command);
        },
        onError: error => {
          if (activeTts !== command) return;
          clearTtsTimer();
          activeTts = null;
          void postFact('TTS_FAILED', command, { error: error?.message || 'tts media error' });
        },
        onCancel: () => {
          if (activeTts !== command) return;
          clearTtsTimer();
          activeTts = null;
        },
      });
      return true;
    }

    if (command.type === 'PLAY_TRACK') {
      if (!playTrackActivationMatches(command)) return false;
      // A reissued activation for media this client already owns is already satisfied.
      // Restarting it would turn every reconnect into a replay from the beginning.
      if (command.queueItemId && activeTrack?.queueItemId === command.queueItemId
        && activeTrack.correlationId === command.correlationId
        && sourceMatches(musicAudio.src, command.url, locationHref)) {
        confirmReattachedActivation(command);
        return true;
      }
      return startActivation(command);
    }

    if (command.type === 'PAUSE_TRACK') {
      musicAudio.pause();
      notify.onStatus('paused');
      return true;
    }

    if (command.type === 'RESUME_TRACK') {
      const attached = activeTrack
        && (!command.queueItemId || activeTrack.queueItemId === command.queueItemId)
        && (!command.correlationId || activeTrack.correlationId === command.correlationId)
        && sourceMatches(musicAudio.src, activeTrack.url, locationHref);
      // A reloaded, reopened, or restarted client has no media for this activation.
      // Rebuild the authoritative target instead of reporting a resume that cannot
      // produce any audio.
      if (!attached && command.url) return startActivation(command);
      try { await musicAudio.play(); } catch (error) { notify.onError(error, command); }
      return true;
    }
    if (command.type === 'CANCEL_TRACK_NARRATION') {
      // Bounded cancellation of the in-flight automatic introduction (switching to
      // music-only): stop the voice; the coordinator lifecycle restores the music gain.
      narrator.cancel(task => task.lane === 'runtime'
        && task.meta?.command?.type === 'PLAY_TRACK_NARRATION', String(command.reason || 'companion-mode-changed'));
      return true;
    }

    if (command.type === 'STOP_PLAYBACK') {
      clearTtsTimer();
      clearTrackTimer();
      activeTts = null;
      activeTrack = null;
      autoplayBlockedCommand = null;
      narrator.cancelAll('playback-stopped');
      musicAudio.pause();
      musicAudio.src = '';
      notify.onStatus('Idle');
      notify.onChanged();
      return true;
    }
    return false;
  }

  const listeners = {
    trackMetadata: () => {
      const command = activeTrack;
      if (command?.positionSeconds > 0 && sourceMatches(musicAudio.src, command.url, locationHref)) {
        musicAudio.currentTime = Number.isFinite(musicAudio.duration)
          ? Math.min(command.positionSeconds, Math.max(0, musicAudio.duration - 0.2)) : command.positionSeconds;
        command.positionSeconds = 0;
      }
    },
    trackProgress: () => {
      if (!activeTrack || Date.now() - lastPositionReported < 15_000 || musicAudio.paused) return;
      lastPositionReported = Date.now();
      void postFact('POSITION_REPORTED', activeTrack, { positionSeconds: Number(musicAudio.currentTime) || 0,
        eventId: eventIdFactory('position') });
    },
    trackPlaying: () => {
      const command = activeTrack;
      if (!command || !sourceMatches(musicAudio.src, command.url, locationHref)) return;
      clearTrackTimer();
      autoplayBlockedCommand = null;
      notify.onStatus('playing');
      trackStartConfirmation = postFact('TRACK_STARTED', command,
        { positionSeconds: Number(musicAudio.currentTime) || 0 }).then(result => {
        // TRACK_STARTED is itself a state transition. Keep the media identity
        // on the returned version so its later ended/error fact is not stale.
        if (Number.isInteger(result?.state?.version)) {
          command.runtimeVersion = result.state.version;
        }
        return result;
      });
    },
    trackEnded: () => {
      const command = activeTrack;
      if (!command || !sourceMatches(musicAudio.src, command.url, locationHref)) return;
      if (musicAudio.ended !== true) return;
      clearTrackTimer();
      activeTrack = null;
      autoplayBlockedCommand = null;
      notify.onTrackEnded(command, musicAudio.duration || 0);
      void trackStartConfirmation.then(() => postFact('TRACK_ENDED', command, {
          natural: true,
          deliveredDuration: Number(musicAudio.duration) || 0,
        }));
    },
    trackError: () => {
      const command = activeTrack;
      if (!command || !sourceMatches(musicAudio.src, command.url, locationHref)) return;
      clearTrackTimer();
      activeTrack = null;
      autoplayBlockedCommand = null;
      void trackStartConfirmation.then(() => {
        const kind = trackFailureKind(musicAudio.error);
        return postFact('TRACK_FAILED', command, { error: kind, failureKind: kind });
      });
    },
  };

  function init() {
    if (initialized) return api;
    initialized = true;
    narrator.init();
    musicAudio.addEventListener('playing', listeners.trackPlaying);
    musicAudio.addEventListener('ended', listeners.trackEnded);
    musicAudio.addEventListener('error', listeners.trackError);
    musicAudio.addEventListener('loadedmetadata', listeners.trackMetadata);
    musicAudio.addEventListener('timeupdate', listeners.trackProgress);
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    clearTtsTimer();
    clearTrackTimer();
    activeRuntimeNarration = null;
    autoplayBlockedCommand = null;
    narrator.cancel(task => task.lane === 'runtime', 'runtime-client-destroyed');
    musicAudio.removeEventListener('playing', listeners.trackPlaying);
    musicAudio.removeEventListener('ended', listeners.trackEnded);
    musicAudio.removeEventListener('error', listeners.trackError);
    musicAudio.removeEventListener('loadedmetadata', listeners.trackMetadata);
    musicAudio.removeEventListener('timeupdate', listeners.trackProgress);
    if (ownsNarrationCoordinator) narrator.destroy();
  }

  function retry() {
    const command = autoplayBlockedCommand;
    if (!command) return postControl('RETRY_REQUESTED');
    const snapshot = runtimeState();
    const track = snapshot?.queue?.[snapshot.currentIndex];
    const confirmed = activeTrack === command
      && command.queueItemId && command.correlationId && command.listeningSessionId
      && track?.queueItemId === command.queueItemId
      && snapshot.txn?.queueItemId === command.queueItemId
      && snapshot.txn?.correlationId === command.correlationId
      && snapshot.activeListeningSessionId === command.listeningSessionId
      && snapshot.outputGeneration === command.outputGeneration
      && sourceMatches(musicAudio.src, command.url, locationHref);
    if (!confirmed) {
      autoplayBlockedCommand = null;
      return Promise.resolve({ accepted: false, reason: 'confirmed track is no longer current' });
    }

    // Invoke play synchronously before constructing or awaiting any request so
    // the browser user-activation token from the recovery button is retained.
    let playPromise;
    try {
      playPromise = musicAudio.play();
    } catch (error) {
      playPromise = Promise.reject(error);
    }
    return Promise.resolve(playPromise).then(() => {
      if (activeTrack !== command) return { accepted: false, reason: 'track changed during retry' };
      autoplayBlockedCommand = null;
      notify.onStatus('loading');
      notify.onChanged();
      return { accepted: true };
    }, async error => {
      if (activeTrack !== command) return { accepted: false, reason: 'track changed during retry' };
      if (error?.name === 'NotAllowedError') {
        autoplayBlockedCommand = command;
        notify.onStatus('autoplay-blocked');
        notify.onAutoplayBlocked(error, command);
        return { accepted: false, autoplayBlocked: true, error };
      }
      clearTrackTimer();
      activeTrack = null;
      autoplayBlockedCommand = null;
      await postFact('TRACK_FAILED', command, { error: trackFailureKind(error), failureKind: trackFailureKind(error) });
      return { accepted: false, error };
    });
  }

  const api = Object.freeze({
    init,
    destroy,
    execute,
    requestNext: () => postControl('NEXT_REQUESTED'),
    dismissTrack: target => {
      const snapshot = runtimeState();
      const songId = String(target?.songId ?? target?.song_id ?? '');
      const provider = String(target?.source || target?.provider || '').split(':')[0].toLowerCase();
      if (!snapshot || !target?.queueItemId || !target?.listeningSessionId || !songId || !provider) {
        return Promise.resolve({ accepted: false });
      }
      // 所有目标字段取自被点的 occurrence，不借用异步期间新当前曲目的身份。
      const eventId = `dismiss:${target.listeningSessionId}:${target.queueItemId}`;
      if (dismissalRequests.has(eventId)) {
        return dismissalRequests.get(eventId).then(result => result?.ok
          ? { ok: true, idempotent: true, state: runtimeState(), commands: [], effects: [] } : result);
      }
      const request = postFact('TRACK_DISMISS_REQUESTED', {
        runtimeVersion: snapshot.version, listeningSessionId: target.listeningSessionId,
        outputGeneration: target.outputGeneration ?? snapshot.outputGeneration,
        queueItemId: target.queueItemId, songId,
      }, { provider, eventId }, { notifyFailure: false }).then(result => {
        if (!result?.ok) dismissalRequests.delete(eventId);
        return result;
      });
      dismissalRequests.set(eventId, request);
      if (dismissalRequests.size > 256) dismissalRequests.delete(dismissalRequests.keys().next().value);
      return request;
    },
    selectSong: songId => postControl('CARD_SELECTED', { songId: String(songId) }),
    selectQueueItem: queueItemId => postControl('CARD_SELECTED', { queueItemId: String(queueItemId) }),
    // The position the listener was actually at belongs in the pause fact: the runtime
    // cannot estimate it while the activation is still unconfirmed.
    pause: () => {
      const attached = attachedCurrentTrack();
      return postControl('PAUSE_REQUESTED', attached ? { positionSeconds: attached.positionSeconds } : {});
    },
    resume: () => postControl('RESUME_REQUESTED'),
    retry,
    setRadioMode: enabled => queuedControl('RADIO_MODE_CHANGED', () => ({ enabled: enabled === true })),
    /**
     * 陪伴模式修改走专用校验路由：封闭枚举 + requestId 幂等 + expectedRevision。
     * 失败（含迟到 revision）返回错误与当前权威状态，由视图恢复显示。
     */
    setCompanionMode: modeId => {
      const snapshot = runtimeState();
      if (!snapshot) return Promise.reject(new Error('runtime state unavailable'));
      const sessionId = snapshot.activeListeningSessionId;
      const run = async () => {
        const current = runtimeState() || snapshot;
        try {
          const result = await apiClient.patch(
            `/api/listening-sessions/${encodeURIComponent(sessionId)}/companion-mode`,
            {
              modeId: modeId === undefined ? null : modeId,
              expectedRevision: current.modeRevision ?? 0,
              requestId: eventIdFactory('companion-mode'),
            });
          // snapshot is scoped to the edited session, which may no longer own
          // playback. Only the full runtime can update the global source/queue.
          if (result?.runtime) reduceServerMessage(store, { type: 'runtime-state', state: result.runtime });
          notify.onChanged();
          return result || { ok: true };
        } catch (error) {
          notify.onError(error, { type: 'companion-mode', sessionId, modeId });
          // 恢复权威值：失败时以服务端当前状态为准回显，不乐观保留错误选择。
          if (apiClient.get) {
            try {
              const now = await apiClient.get('/api/now');
              if (now?.runtime) reduceServerMessage(store, { type: 'runtime-state', state: now.runtime });
            } catch { /* keep local state; next snapshot will reconcile */ }
          }
          throw error;
        }
      };
      const result = listeningSwitch.then(run, run);
      listeningSwitch = result.catch(() => {});
      return result;
    },
    listenWith,
    cancelListeningSwitch: () => postControl('LISTENING_SWITCH_CANCELLED'),
    getActiveTrack: () => activeTrack,
    getActiveTts: () => activeTts,
  });
  return api;
}
