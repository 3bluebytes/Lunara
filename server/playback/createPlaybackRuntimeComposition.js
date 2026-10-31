import { PlaybackRuntimeHost } from './PlaybackRuntimeHost.js';
import { PlaybackEffectType, PlaybackEventType, PlaybackPhase } from './playbackRuntimeTypes.js';
import { getTrackArtworkStore } from '../media/sharedTrackArtwork.js';
import { synthesisReason, synthesisElapsed } from '../tts/boundedSynthesis.js';

// 即使第三方准备器忽略 signal，也不能永久占住并发位。
async function abortable(work, signal) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', onAbort); }
}

const NARRATION_WORK_TYPES = new Set([
  PlaybackEffectType.PREPARE_TRACK_NARRATION,
  PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET,
]);

export function createPlaybackRuntimeComposition({
  prefs,
  queueService,
  publish,
  trace = () => {},
  getRadioRequestService = () => null,
  prepareTrackNarration = null,
  resolveTrackNarrationAsset = null,
  onTrackNarrationStarted = null,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelSchedule = timer => globalThis.clearTimeout(timer),
  maxPreparationConcurrency = null,
  // 封面补全依赖：不传时用进程内封面缓存；显式传 null 可关闭（评估/离线场景）。
  artwork = undefined,
  now = () => Date.now(),
} = {}) {
  const narrationWorkQueue = [];
  const narrationWork = new Map();
  const narrationTimers = new Map();
  const controllers = new Set();
  let stopped = false;
  let generation = 0;
  let activeNarrationWork = 0;
  let timerSequence = 0;
  let runtime;

  function findNarrationTarget(effect) {
    const scoped = runtime.listeningSnapshot(effect.listeningSessionId);
    return scoped.queue.find(track => track.queueItemId === effect.queueItemId) || null;
  }

  function expectedNarrationState(effect, track) {
    if (!track || track.narration.generationRevision !== effect.generationRevision) return false;
    return effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
      ? track.narration.status === 'preparing'
      : track.narration.status === 'ready' && track.narration.assetStatus === 'resolving';
  }

  function preparationLimit() {
    const configured = maxPreparationConcurrency
      ?? runtime.snapshot().narrationPolicy?.maxPreparationConcurrency;
    return Math.max(1, Math.min(8, Number(configured) || 2));
  }

  function queueNarrationWork(effect) {
    const key = `${effect.type}:${effect.listeningSessionId}:${effect.queueItemId}:${effect.generationRevision}`;
    if (narrationWork.has(key)) return;
    const entry = { key, effect, generation };
    narrationWork.set(key, entry);
    narrationWorkQueue.push(entry);
    pumpNarrationWork();
  }

  async function runNarrationWork(entry) {
    if (stopped || entry.generation !== generation) return;
    const { effect } = entry;
    const track = findNarrationTarget(effect);
    if (!expectedNarrationState(effect, track)) return;
    const startedAt = now();
    const controller = new AbortController();
    entry.controller = controller;
    controllers.add(controller);
    const isCurrent = () => !stopped && entry.generation === generation && !controller.signal.aborted
      && expectedNarrationState(effect, findNarrationTarget(effect));
    const snapshot = runtime.snapshot();
    const currentAutomatic = snapshot.activeListeningSessionId === effect.listeningSessionId
      && snapshot.queue[snapshot.currentIndex]?.queueItemId === effect.queueItemId
      && snapshot.txn?.narrationUserRequested !== true;
    // 当前自动口播只用现有开始窗口；下一首提前准备不受当前曲窗口截断。
    const deadlineMs = currentAutomatic
      ? (snapshot.txn?.startedAtMs ?? now()) + Math.max(0, Number(snapshot.narrationPolicy?.maxStartOffsetMs) || 0)
      : null;
    try {
      const work = effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION ? prepareTrackNarration : resolveTrackNarrationAsset;
      if (typeof work !== 'function') throw Object.assign(new Error('narration not configured'), { code: 'NARRATION_NOT_CONFIGURED' });
      const result = await abortable(() => work(effect, { signal: controller.signal, isCurrent, deadlineMs }), controller.signal);
      if (!isCurrent()) return;
      const { narrationSource, narrationRejection, narrationFinishReason, narrationDimensions, narrationBrief } = result || {};
      // 只映射受控资产字段，诊断不作为任意字段散传进状态事件。
      const narration = Object.fromEntries(['text', 'spokenText', 'performance', 'ttsUrl', 'contentHash',
        'voiceProfileId', 'previousSongId'].map(key => [key, result?.[key]]));
      const synthReason = synthesisReason(result?.narrationSynthesisReason);
      const synthElapsedMs = synthesisElapsed(result?.narrationSynthesisElapsedMs);
      const eventType = effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
        ? PlaybackEventType.TRACK_NARRATION_READY
        : PlaybackEventType.TRACK_NARRATION_ASSET_READY;
      const accepted = await runtime.submit({
        type: eventType,
        eventId: `narration:${eventType}:${effect.queueItemId}:${effect.generationRevision}`,
        queueItemId: effect.queueItemId,
        generationRevision: effect.generationRevision,
        listeningSessionId: effect.listeningSessionId,
        songId: effect.songId,
        programId: effect.programId,
        ...narration, synthesisReason: synthReason, synthesisElapsedMs: synthElapsedMs,
      });
      trace({ event: 'track-narration-work-finished', workType: effect.type,
        listeningSessionId: effect.listeningSessionId,
        queueItemId: effect.queueItemId, generationRevision: effect.generationRevision,
        elapsedMs: Math.max(0, now() - startedAt), accepted: accepted.accepted,
        staleReason: accepted.accepted ? null : accepted.reason,
        narrationSource, narrationRejection, narrationFinishReason, narrationDimensions, narrationBrief,
        synthesisReason: synthReason, synthesisElapsedMs: synthElapsedMs });
    } catch (error) {
      if (!isCurrent()) return;
      const reason = error?.code === 'NARRATION_NOT_CONFIGURED' ? 'not-configured'
        : error?.name === 'TimeoutError' ? 'timeout' : 'failed';
      const elapsedMs = Math.max(0, now() - startedAt);
      const eventType = effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
        ? PlaybackEventType.TRACK_NARRATION_FAILED
        : PlaybackEventType.TRACK_NARRATION_ASSET_FAILED;
      const accepted = await runtime.submit({
        type: eventType,
        eventId: `narration:${eventType}:${effect.queueItemId}:${effect.generationRevision}`,
        queueItemId: effect.queueItemId,
        generationRevision: effect.generationRevision,
        listeningSessionId: effect.listeningSessionId,
        songId: effect.songId,
        programId: effect.programId,
        synthesisReason: reason, synthesisElapsedMs: elapsedMs,
      });
      trace({ event: 'track-narration-work-failed', workType: effect.type,
        listeningSessionId: effect.listeningSessionId,
        queueItemId: effect.queueItemId, generationRevision: effect.generationRevision,
        elapsedMs, accepted: accepted.accepted, synthesisReason: reason });
    } finally {
      controllers.delete(controller);
    }
  }

  function pumpNarrationWork() {
    while (!stopped && activeNarrationWork < preparationLimit() && narrationWorkQueue.length) {
      const entry = narrationWorkQueue.shift();
      activeNarrationWork += 1;
      Promise.resolve().then(() => runNarrationWork(entry)).catch(error => {
        trace({ event: 'track-narration-scheduler-failed', listeningSessionId: entry.effect.listeningSessionId,
          queueItemId: entry.effect.queueItemId, error: String(error?.message || error) });
      }).finally(() => {
        if (entry.generation !== generation) return;
        activeNarrationWork = Math.max(0, activeNarrationWork - 1);
        narrationWork.delete(entry.key);
        pumpNarrationWork();
      });
    }
  }

  function clearNarrationTimer(key, timer) {
    cancelSchedule(timer.handle);
    narrationTimers.delete(key);
  }

  function scheduleNarrationWindow(effect) {
    const key = [effect.listeningSessionId, effect.queueItemId, effect.correlationId, effect.outputGeneration].join(':');
    const previous = narrationTimers.get(key);
    if (previous) clearNarrationTimer(key, previous);
    const entry = { effect, handle: null, generation };
    entry.handle = schedule(() => {
      if (stopped || entry.generation !== generation) return;
      narrationTimers.delete(key);
      const current = runtime.snapshot();
      const currentTrack = current.queue[current.currentIndex];
      if (current.phase !== PlaybackPhase.PLAYING
        || current.activeListeningSessionId !== effect.listeningSessionId
        || current.outputGeneration !== effect.outputGeneration
        || current.txn?.queueItemId !== effect.queueItemId
        || current.txn?.correlationId !== effect.correlationId
        || currentTrack?.queueItemId !== effect.queueItemId) return;
      void runtime.submit({
        type: PlaybackEventType.NARRATION_WINDOW_OPENED,
        eventId: `narration-window:${effect.queueItemId}:${effect.correlationId}:${++timerSequence}`,
        runtimeVersion: current.version,
        queueItemId: effect.queueItemId,
        correlationId: effect.correlationId,
        listeningSessionId: effect.listeningSessionId,
        outputGeneration: effect.outputGeneration,
        songId: currentTrack.songId,
        programId: currentTrack.programId,
        durationSeconds: currentTrack.duration,
      });
    }, Math.max(0, Number(effect.delayMs) || 0));
    narrationTimers.set(key, entry);
  }

  runtime = new PlaybackRuntimeHost({
    persistence: {
      load: () => {
        const raw = prefs.getPref('playback_runtime_state');
        if (!raw) return null;
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
      },
      save: snapshot => prefs.setPref('playback_runtime_state', JSON.stringify(snapshot)),
    },
    now,
    // 惰性门面：组合根构造时不开库、不建表。数据根迁移要求目标库在迁移前为空，
    // 所以封面缓存必须等到第一次真正补全时才初始化。
    artwork: artwork === undefined ? {
      peek: (provider, songId) => getTrackArtworkStore().peek(provider, songId),
      resolve: (provider, songId, options) => getTrackArtworkStore().resolve(provider, songId, options),
    } : artwork,
    commandSink: command => publish({ type: 'runtime-command', command }),
    effectSink: async effect => {
      if (stopped) return;
      if (NARRATION_WORK_TYPES.has(effect.type)) {
        queueNarrationWork(effect);
        return;
      }
      if (effect.type === PlaybackEffectType.SCHEDULE_NARRATION_WINDOW) {
        scheduleNarrationWindow(effect);
        return;
      }
      if (effect.type !== PlaybackEffectType.REQUEST_CONTINUATION) return;
      const controller = new AbortController();
      controllers.add(controller);
      const effectGeneration = generation;
      const isCurrent = () => !stopped && effectGeneration === generation && !controller.signal.aborted;
      try {
        const radio = getRadioRequestService();
        if (!radio) throw new Error('radio request service unavailable for continuation');
        const current = runtime.snapshot();
        if (current.activeListeningSessionId !== effect.listeningSessionId || current.outputGeneration !== effect.outputGeneration
          || !current.radioMode || current.pendingContinuation?.boundaryKey !== effect.boundaryKey) return;
        // 权威预热触发点：这个边界由实时任务处理，同时为“下一个边界”挂起一批
        // 已备好的歌（只登记、不播放）；命中时下个边界零模型调用地采用。
        // boundaryInFlight 明确告诉预热：不要绑定正在被实时任务解析的这个边界。
        if (typeof radio.prepareContinuation === 'function') {
          void Promise.resolve(radio.prepareContinuation({ signal: controller.signal, isCurrent,
            boundaryInFlight: effect.boundaryKey })).catch(() => {});
        }
        const result = await radio.handleContinue({ requestId: `runtime-continuation:${effect.boundaryKey}`,
          sessionId: effect.listeningSessionId, outputGeneration: effect.outputGeneration,
          signal: controller.signal, isCurrent });
        if (!isCurrent()) return;
        if (result?.ok === false) {
          // Keep the concrete failure code and its reason diagnosable; the player copy stays non-technical.
          const reason = String(result.error || result.reason || result.message || 'continuation failed');
          const code = result.code ? String(result.code) : '';
          throw new Error(code && !reason.includes(code) ? `${code}: ${reason}` : reason);
        }
        const committedTracks = Array.isArray(result?.tracks)
          ? result.tracks.length
          : Number(result?.tracks ?? result?.added ?? 0);
        if (!Number.isFinite(committedTracks) || committedTracks < 1) {
          throw new Error('continuation produced no tracks committed');
        }
      } catch (error) {
        if (!isCurrent()) return;
        await runtime.submit({
          type: PlaybackEventType.CONTINUATION_FAILED,
          // Scoped by attempt: a recovered failure for the same boundary is a new fact,
          // while a duplicated report of one attempt is still ignored.
          eventId: `continuation-failed:${effect.boundaryKey}:${effect.attempt ?? 1}`,
          boundaryKey: effect.boundaryKey,
          listeningSessionId: effect.listeningSessionId,
          outputGeneration: effect.outputGeneration,
          error: error.message,
        });
      } finally {
        controllers.delete(controller);
      }
    },
    onError: (error, context) => trace(`[playback-runtime] ${context?.type || 'error'}: ${error.message}`),
  });

  runtime.subscribe((snapshot, event) => {
    // 队列替换或素材 revision 失效后立即取消模型工作；仍在队列的后台准备可继续复用。
    for (const entry of narrationWork.values()) {
      if (entry.controller && !expectedNarrationState(entry.effect, findNarrationTarget(entry.effect))) {
        entry.controller.abort(new DOMException('narration occurrence invalidated', 'AbortError'));
      }
    }
    for (const [key, timer] of narrationTimers) {
      const { effect } = timer;
      const stillEligible = snapshot.phase === PlaybackPhase.PLAYING
        && snapshot.activeListeningSessionId === effect.listeningSessionId
        && snapshot.outputGeneration === effect.outputGeneration
        && snapshot.txn?.queueItemId === effect.queueItemId
        && snapshot.txn?.correlationId === effect.correlationId
        && ['waiting', 'eligible'].includes(snapshot.txn?.narrationDelivery);
      if (!stillEligible) clearNarrationTimer(key, timer);
    }
    if (event.type === PlaybackEventType.NARRATION_DELIVERY_AUDIBLE
      && snapshot.txn?.narrationDelivery === 'speaking') {
      const track = snapshot.queue.find(item => item.queueItemId === event.queueItemId);
      if (track) onTrackNarrationStarted?.(snapshot, event, track);
    }
    if (event.type === PlaybackEventType.TRACK_NARRATION_READY) {
      trace({ event: 'track-narration-prepared', queueItemId: event.queueItemId,
        generationRevision: event.generationRevision });
    }
    if ([PlaybackEventType.NARRATION_DELIVERY_FINISHED, PlaybackEventType.NARRATION_DELIVERY_FAILED,
      PlaybackEventType.NARRATION_DELIVERY_CANCELLED].includes(event.type)) {
      trace({ event: 'track-narration-terminal', outcome: event.type,
        queueItemId: event.queueItemId, correlationId: event.correlationId });
    }
    const presentation = event?.type === PlaybackEventType.PROGRAM_COMMITTED
      ? event.presentation || {}
      : {};
    queueService.projectRuntimeSnapshot(snapshot, presentation);
    publish({ type: 'runtime-state', state: snapshot });
  });
  void runtime.ready.then(snapshot => queueService.projectRuntimeSnapshot(snapshot, { publish: false }));
  const stopHost = runtime.stop.bind(runtime);
  runtime.stop = async () => {
    stopped = true;
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    for (const [key, timer] of narrationTimers) clearNarrationTimer(key, timer);
    narrationWork.clear();
    narrationWorkQueue.length = 0;
    activeNarrationWork = 0;
    return stopHost();
  };
  const startHost = runtime.startRecovery.bind(runtime);
  runtime.startRecovery = async () => {
    stopped = false;
    return startHost();
  };
  return runtime;
}
