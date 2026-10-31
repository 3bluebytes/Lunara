import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlaybackRuntimeComposition } from './createPlaybackRuntimeComposition.js';
import { QueueService } from './QueueService.js';
import { PlaybackEventType, PlaybackPhase } from './playbackRuntimeTypes.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function track(songId) {
  return {
    songId,
    programId: 'program',
    requestId: 'request',
    title: `Title ${songId}`,
    artist: `Artist ${songId}`,
    url: `/${songId}.mp3`,
    duration: 30,
    intro: { text: `Intro ${songId}`, ttsUrl: null },
  };
}

function fixture(options = {}) {
  const prefs = new Map();
  const messages = [];
  const projected = [];
  const queueService = new QueueService({ publish: message => messages.push(message) });
  const project = queueService.projectRuntimeSnapshot.bind(queueService);
  queueService.projectRuntimeSnapshot = (snapshot, extra) => {
    projected.push({ snapshot, extra });
    return project(snapshot, extra);
  };
  const runtime = createPlaybackRuntimeComposition({
    prefs: { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value) },
    queueService,
    publish: message => messages.push(message),
    ...options,
  });
  return { runtime, messages, projected, prefs };
}

test('zero-track continuation result closes the pending boundary as recoverable failure', async () => {
  const prefs = new Map();
  const runtime = createPlaybackRuntimeComposition({
    prefs: {
      getPref: key => prefs.get(key),
      setPref: (key, value) => prefs.set(key, value),
    },
    queueService: {
      projectRuntimeSnapshot() {},
    },
    publish() {},
    getRadioRequestService: () => ({
      handleContinue: async () => ({ ok: true, tracks: 0, added: 0, narration: 0 }),
    }),
  });

  await runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'program:last',
    delivery: 'replace_now',
    source: 'user',
    tracks: [track('last')],
  });
  const loading = runtime.snapshot();
  await runtime.submit({
    type: PlaybackEventType.TRACK_STARTED,
    eventId: 'track:last:started',
    runtimeVersion: loading.version,
    songId: 'last',
    programId: 'program',
    correlationId: loading.txn.correlationId,
  });
  const playing = runtime.snapshot();
  await runtime.submit({
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'track:last:ended',
    runtimeVersion: playing.version,
    songId: 'last',
    programId: 'program',
    correlationId: playing.txn.correlationId,
    natural: true,
    deliveredDuration: 30,
  });
  await settle();
  await settle();

  const exhausted = runtime.snapshot();
  assert.equal(exhausted.phase, PlaybackPhase.EXHAUSTED);
  assert.equal(exhausted.pendingContinuation?.status, 'failed');
  assert.equal(exhausted.lastError?.type, 'continuation-failed');
  assert.match(exhausted.lastError?.message || '', /no tracks committed/i);
});

test('narration preparation clips the current automatic task to its delivery window but gives upcoming work its task budget', async t => {
  const calls = [];
  const h = fixture({ now: () => 1_000,
    prepareTrackNarration: async (effect, options) => {
      calls.push({ effect, options });
      return { text: 'Prepared intro.', ttsUrl: '/intro.mp3', voiceProfileId: 'voice' };
    } });
  t.after(() => h.runtime.stop());
  const tracks = ['one', 'two', 'three', 'four'].map(id => ({ ...track(id),
    narration: { status: 'absent', context: { origin: 'live' } } }));
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'budget-commit', delivery: 'replace_now', source: 'user', tracks });
  await settle();
  assert.equal(calls[0].options.deadlineMs, 61_000, '当前自动口播用六十秒开口窗口');
  assert.equal(typeof calls[0].options.isCurrent, 'function');
  for (const [i, songId] of ['one', 'two'].entries()) {
    const state = h.runtime.snapshot();
    await h.runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: `budget-start-${i}`,
      runtimeVersion: state.version, songId, programId: 'program', correlationId: state.txn.correlationId });
    await h.runtime.submit({ type: PlaybackEventType.NEXT_REQUESTED, eventId: `budget-next-${i}`,
      runtimeVersion: h.runtime.snapshot().version, songId });
    await settle();
  }
  const upcoming = calls.find(call => call.effect.track.songId === 'four');
  assert.ok(upcoming, 'eligible fourth track is prepared while third is current');
  assert.equal(upcoming.options.deadlineMs, null);
  assert.equal(h.runtime.snapshot().currentSongId, 'three');
});

test('replacing a queue cancels removed narration work without cancelling retained background items', async t => {
  const signals = [];
  const h = fixture({ prepareTrackNarration: async (effect, options) => {
    signals.push({ songId: effect.track.songId, signal: options.signal });
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(null), { once: true }));
  } });
  t.after(() => h.runtime.stop());
  for (const id of ['removed', 'replacement']) {
    await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: `cancel-${id}`,
      delivery: 'replace_now', source: 'user', tracks: [{ ...track(id), narration: { status: 'absent', context: {} } }] });
    await settle();
  }
  assert.equal(signals[0].signal.aborted, true);
  assert.equal(signals[1].signal.aborted, false);
});

test('narration work failures stay closed: no raw error reaches diagnostics or trace', async t => {
  const traces = [];
  let now = 1_000;
  const h = fixture({ now: () => now, trace: entry => traces.push(entry),
    prepareTrackNarration: async () => {
      now = 4_000;
      const error = new Error('synthesis exploded with key sk-secret');
      error.name = 'SynthesisError';
      throw error;
    } });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'closed-failure-commit',
    delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('failed'), narration: { status: 'absent', context: {} } }] });
  await settle();
  await settle();
  const state = h.runtime.snapshot();
  const failed = state.diagnostics.find(entry => entry.type === 'track-narration-failed');
  assert.equal(failed?.reason, 'failed', '封闭原因');
  assert.equal(failed?.elapsedMs >= 3_000, true, '耗时进诊断');
  assert.equal(JSON.stringify({ state, traces }).includes('sk-secret'), false, '原始错误不得外泄');
  const traced = traces.find(entry => entry.event === 'track-narration-work-failed');
  assert.equal(traced?.synthesisReason, 'failed');
  assert.equal(traced?.elapsedMs, 3_000);
});

test('missing narration work is reported as not-configured instead of an empty ready', async t => {
  const h = fixture({});
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'unwired-commit',
    delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('unwired'), narration: { status: 'absent', context: {} } }] });
  await settle();
  await settle();
  const state = h.runtime.snapshot();
  const failed = state.diagnostics.find(entry => entry.type === 'track-narration-failed');
  assert.equal(failed?.reason, 'not-configured');
  assert.equal(state.queue[0].narration.status, 'failed');
});

test('cancelled narration work releases the worker even when the work promise never settles', async t => {
  const seen = [];
  let releaseFirst;
  const h = fixture({ maxPreparationConcurrency: 1,
    prepareTrackNarration: effect => {
      seen.push(effect.track.songId);
      if (effect.track.songId === 'first') return new Promise(resolve => { releaseFirst = resolve; });
      return Promise.resolve({ text: 'Second intro.', ttsUrl: '/second.mp3', voiceProfileId: 'voice' });
    } });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'abort-commit',
    delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('first'), narration: { status: 'absent', context: {} } },
      { ...track('second'), narration: { status: 'absent', context: {} } }] });
  await settle();
  await settle();
  assert.deepEqual(seen, ['first'], '单个准备位被未完成的准备占用');
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'abort-replace',
    delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('second'), narration: { status: 'absent', context: {} } },
      { ...track('third'), narration: { status: 'absent', context: {} } }] });
  for (let i = 0; i < 20 && !seen.includes('second'); i += 1) await settle();
  assert.equal(seen.includes('second'), true, '已取消的准备必须尽快释放准备位');
  releaseFirst?.({ text: 'Late first intro.', ttsUrl: '/late.mp3' });
  await settle();
  await settle();
  assert.equal(h.runtime.snapshot().queue.some(item => item.songId === 'first'), false);
});

test('background narration remains useful after a track switch and is not projected to queue UI', async () => {
  let releasePreparation;
  let preparationStarted;
  const started = new Promise(resolve => { preparationStarted = resolve; });
  const h = fixture({
    prepareTrackNarration: effect => {
      preparationStarted(effect);
      return new Promise(resolve => { releasePreparation = resolve; });
    },
  });
  await h.runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'background-commit', delivery: 'replace_now', source: 'user',
    tracks: [
      { ...track('first'), intro: { text: 'First', context: { transition: 'from-prev' } } },
      track('second'), track('third'), track('fourth'), track('fifth'),
    ],
  });
  const effect = await started;
  assert.equal(h.runtime.snapshot().phase, PlaybackPhase.LOADING);
  assert.equal(h.runtime.snapshot().queue[0].narration.status, 'preparing');
  assert.equal(h.runtime.snapshot().queue[1].narration.status, 'absent');

  const firstVersion = h.runtime.snapshot().version;
  await h.runtime.submit({ type: PlaybackEventType.NEXT_REQUESTED, eventId: 'background-next',
    runtimeVersion: firstVersion, songId: 'first' });
  assert.equal(h.runtime.snapshot().currentSongId, 'second');
  releasePreparation({ text: 'First canonical narration.', ttsUrl: '/first.mp3', contentHash: 'first-hash', voiceProfileId: 'voice-a' });
  await settle();
  await settle();

  const state = h.runtime.snapshot();
  assert.equal(state.currentSongId, 'second');
  assert.equal(state.queue[0].queueItemId, effect.queueItemId);
  assert.equal(state.queue[0].narration.status, 'ready');
  assert.equal(state.queue[0].narration.contentHash, 'first-hash');
  assert.equal(h.messages.some(message => message.type === 'runtime-command'
    && message.command.type === 'PLAY_TRACK_NARRATION' && message.command.queueItemId === effect.queueItemId), false);
  const queueMessage = h.messages.find(message => message.type === 'queue-update');
  assert.equal(Object.hasOwn(queueMessage.queue[0], 'narration'), false);
  assert.equal(Object.hasOwn(queueMessage.queue[0], 'intro'), false);
});

test('historical cached narration is resolved in the background without another model preparation', async () => {
  const resolved = [];
  const h = fixture({
    resolveTrackNarrationAsset: async effect => {
      resolved.push({ queueItemId: effect.queueItemId, text: effect.track.narration.text,
        voice: effect.track.narration.voiceProfileId });
      return { ttsUrl: '/restored.mp3', contentHash: 'restored-hash' };
    },
  });
  await h.runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'cached-commit', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('cached'), narration: { status: 'ready', assetStatus: 'unknown', generationRevision: 7,
      text: 'Persisted words.', ttsUrl: '/missing.mp3', contentHash: 'old-hash', voiceProfileId: 'stored-voice' } }],
  });
  await settle();
  await settle();
  const state = h.runtime.snapshot();
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].text, 'Persisted words.');
  assert.equal(resolved[0].voice, 'stored-voice');
  assert.equal(state.queue[0].narration.assetStatus, 'ready');
  assert.equal(state.queue[0].narration.ttsUrl, '/restored.mp3');
  assert.equal(state.queue[0].narration.contentHash, 'restored-hash');
  assert.equal(h.messages.some(message => message.command?.type === 'PLAY_TRACK_NARRATION'), false);
  assert.equal(state.phase, PlaybackPhase.LOADING);
  assert.equal(h.messages.some(message => message.type === 'runtime-command' && message.command.type === 'PLAY_TRACK'), true);
});

test('settling timer opens one correlated narration window and persists visible delivery only on start acceptance', async () => {
  let now = 1_000;
  const scheduled = [];
  const cancellations = [];
  const started = [];
  const h = fixture({
    now: () => now,
    schedule: (callback, delayMs) => { const timer = { callback, delayMs }; scheduled.push(timer); return timer; },
    cancelSchedule: timer => cancellations.push(timer),
    resolveTrackNarrationAsset: async () => ({ ttsUrl: '/timer.mp3', contentHash: 'timer-hash' }),
    onTrackNarrationStarted: (snapshot, event, item) => started.push({ queueItemId: item.queueItemId, event }),
  });
  await h.runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'timer-commit', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('timer'), narration: { status: 'ready', assetStatus: 'ready', generationRevision: 1,
      text: 'A short intro.', ttsUrl: '/timer.mp3', contentHash: 'timer-hash', voiceProfileId: 'voice-a' } }],
  });
  await settle();
  await settle();
  const loading = h.runtime.snapshot();
  await h.runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: 'timer-track-started',
    runtimeVersion: loading.version, queueItemId: loading.txn.queueItemId,
    songId: loading.currentSongId, programId: loading.txn.programId,
    correlationId: loading.txn.correlationId, listeningSessionId: loading.activeListeningSessionId,
    outputGeneration: loading.outputGeneration, positionSeconds: 0 });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delayMs, 1_000);
  now = 2_200;
  scheduled[0].callback();
  await settle();
  await settle();
  const overlay = h.messages.find(message => message.type === 'runtime-command' && message.command.type === 'PLAY_TRACK_NARRATION');
  assert.ok(overlay);
  assert.equal(overlay.command.queueItemId, loading.txn.queueItemId);
  assert.equal(overlay.command.correlationId, loading.txn.correlationId);
  assert.equal(started.length, 0);

  const current = h.runtime.snapshot();
  await h.runtime.submit({ type: PlaybackEventType.NARRATION_DELIVERY_STARTED, eventId: 'timer-overlay-started',
    runtimeVersion: current.version, queueItemId: current.txn.queueItemId,
    songId: current.currentSongId, programId: current.txn.programId, correlationId: current.txn.correlationId,
    listeningSessionId: current.activeListeningSessionId, outputGeneration: current.outputGeneration,
    positionSeconds: 1.2, durationSeconds: 30 });
  assert.equal(started.length, 0, 'preflight authorization does not create a visible intro before audio starts');
  const authorized = h.runtime.snapshot();
  await h.runtime.submit({ type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE, eventId: 'timer-overlay-audible',
    runtimeVersion: authorized.version, queueItemId: authorized.txn.queueItemId,
    songId: authorized.currentSongId, programId: authorized.txn.programId, correlationId: authorized.txn.correlationId,
    listeningSessionId: authorized.activeListeningSessionId, outputGeneration: authorized.outputGeneration,
    positionSeconds: 1.3, durationSeconds: 30 });
  assert.equal(started.length, 1);
  assert.equal(started[0].queueItemId, current.txn.queueItemId);
});

test('track replacement cancels the old window timer and its callback cannot emit stale narration', async () => {
  let now = 1_000;
  const scheduled = [];
  const cancelled = [];
  const h = fixture({
    now: () => now,
    schedule: (callback, delayMs) => { const timer = { callback, delayMs }; scheduled.push(timer); return timer; },
    cancelSchedule: timer => cancelled.push(timer),
  });
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'cancel-commit', delivery: 'replace_now',
    source: 'user', tracks: [track('old'), track('new'), track('third'), track('fourth'), track('fifth')] });
  const loading = h.runtime.snapshot();
  await h.runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: 'cancel-started',
    runtimeVersion: loading.version, songId: loading.currentSongId, programId: loading.txn.programId,
    correlationId: loading.txn.correlationId, queueItemId: loading.txn.queueItemId,
    listeningSessionId: loading.activeListeningSessionId, outputGeneration: loading.outputGeneration });
  assert.equal(scheduled.length, 1);
  await h.runtime.submit({ type: PlaybackEventType.NEXT_REQUESTED, eventId: 'cancel-next',
    runtimeVersion: h.runtime.snapshot().version, songId: 'old' });
  assert.equal(cancelled.includes(scheduled[0]), true);
  now = 3_000;
  scheduled[0].callback();
  await settle();
  assert.equal(h.runtime.snapshot().currentSongId, 'new');
  assert.equal(h.messages.some(message => message.command?.type === 'PLAY_TRACK_NARRATION'), false);
});

test('a refused continuation keeps its concrete failure code in runtime state', async () => {
  const prefs = new Map();
  const runtime = createPlaybackRuntimeComposition({
    prefs: { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value) },
    queueService: { projectRuntimeSnapshot() {} },
    publish() {},
    getRadioRequestService: () => ({
      handleContinue: async () => ({ ok: false, code: 'NO_MATCHING_CANDIDATES' }),
    }),
  });
  await runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'program:refused', delivery: 'replace_now',
    source: 'user', tracks: [track('refused')],
  });
  const loading = runtime.snapshot();
  await runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: 'track:refused:started',
    runtimeVersion: loading.version, songId: 'refused', programId: 'program',
    correlationId: loading.txn.correlationId });
  const playing = runtime.snapshot();
  await runtime.submit({ type: PlaybackEventType.TRACK_ENDED, eventId: 'track:refused:ended',
    runtimeVersion: playing.version, songId: 'refused', programId: 'program',
    correlationId: playing.txn.correlationId, natural: true, deliveredDuration: 30 });
  await settle();
  await settle();

  const exhausted = runtime.snapshot();
  assert.equal(exhausted.pendingContinuation?.status, 'failed');
  assert.match(exhausted.lastError?.message || '', /NO_MATCHING_CANDIDATES/);
  assert.equal(exhausted.diagnostics.some(entry => entry.type === 'continuation-failed'), false);
});

test('the boundary hook gives prewarm the in-flight boundary and reports the failure code with its reason', async () => {
  const prewarmCalls = [];
  const prefs = new Map();
  const runtime = createPlaybackRuntimeComposition({
    prefs: { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value) },
    queueService: { projectRuntimeSnapshot() {} },
    publish() {},
    getRadioRequestService: () => ({
      prepareContinuation: async options => { prewarmCalls.push(options); return { ok: true, prepared: true }; },
      handleContinue: async () => ({ ok: false, code: 'MUSIC_NOT_COMMITTED', message: 'resolution failed (qq)' }),
    }),
  });
  await runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'program:reason', delivery: 'replace_now',
    source: 'user', tracks: [track('reason')],
  });
  const loading = runtime.snapshot();
  await runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: 'track:reason:started',
    runtimeVersion: loading.version, songId: 'reason', programId: 'program',
    correlationId: loading.txn.correlationId });
  const playing = runtime.snapshot();
  await runtime.submit({ type: PlaybackEventType.TRACK_ENDED, eventId: 'track:reason:ended',
    runtimeVersion: playing.version, songId: 'reason', programId: 'program',
    correlationId: playing.txn.correlationId, natural: true, deliveredDuration: 30 });
  await settle();
  await settle();
  await settle();

  const exhausted = runtime.snapshot();
  assert.equal(exhausted.pendingContinuation?.status, 'failed');
  assert.equal(exhausted.lastError?.message, 'MUSIC_NOT_COMMITTED: resolution failed (qq)',
    'runtime 的 lastError 同时带上具体码与原因，而不是通用文案');
  assert.ok(prewarmCalls.length >= 1, '边界钩子同时发起下一个边界的预热');
  assert.ok(prewarmCalls.every(call => typeof call.boundaryInFlight === 'string' && /^\d+:.+:\d+$/.test(call.boundaryInFlight)),
    '每次预热都拿到当时的在飞边界，绝不绑定它');
  assert.equal(prewarmCalls.at(-1).boundaryInFlight, exhausted.pendingContinuation.boundaryKey,
    '最后一次预热与正在解析的边界同源');
});

test('a failed continuation is retried after restart within a bounded number of attempts', async () => {
  const prefs = new Map();
  const attempts = [];
  const build = () => createPlaybackRuntimeComposition({
    prefs: { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value) },
    queueService: { projectRuntimeSnapshot() {} },
    publish() {},
    getRadioRequestService: () => ({
      handleContinue: async ({ requestId }) => {
        attempts.push(requestId);
        return { ok: false, code: 'NO_MATCHING_CANDIDATES' };
      },
    }),
  });
  const runtime = build();
  await runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'program:bounded', delivery: 'replace_now',
    source: 'user', tracks: [track('bounded')],
  });
  const loading = runtime.snapshot();
  await runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: 'track:bounded:started',
    runtimeVersion: loading.version, songId: 'bounded', programId: 'program',
    correlationId: loading.txn.correlationId });
  const playing = runtime.snapshot();
  await runtime.submit({ type: PlaybackEventType.TRACK_ENDED, eventId: 'track:bounded:ended',
    runtimeVersion: playing.version, songId: 'bounded', programId: 'program',
    correlationId: playing.txn.correlationId, natural: true, deliveredDuration: 30 });
  await settle();
  await settle();
  // 单曲队列激活即提前预取（第 1 次，失败）；自然播完后耗尽边界重新发起（第 2 次，也失败）。
  assert.equal(attempts.length, 2);
  assert.equal(runtime.snapshot().pendingContinuation.attempts, 1);

  const observed = [];
  for (let restart = 0; restart < 3; restart += 1) {
    const recovered = build();
    // The runtime lifecycle recovers persisted work after the other subsystems start.
    await recovered.startRecovery();
    await settle();
    await settle();
    await settle();
    observed.push({ attempts: attempts.length, state: recovered.snapshot() });
  }
  assert.deepEqual(observed.map(entry => entry.attempts), [3, 4, 4]);
  assert.deepEqual(observed.map(entry => entry.state.pendingContinuation.attempts), [2, 3, 3]);
  assert.equal(observed[0].state.pendingContinuation.boundaryKey, observed[1].state.pendingContinuation.boundaryKey);
  assert.deepEqual(observed.map(entry => entry.state.phase), ['exhausted', 'exhausted', 'exhausted']);
});
