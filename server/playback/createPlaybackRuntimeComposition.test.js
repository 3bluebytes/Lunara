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
  return { runtime, messages, projected, prefs, queueService };
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

// 串词已经写好的歌：到点要做的只剩合成声音。
function written(songId) {
  return { ...track(songId), intro: undefined,
    narration: { status: 'ready', assetStatus: 'missing', generationRevision: 1, text: `《Title ${songId}》这首可以听下去。` } };
}

test('narration audio clips the current automatic task to its delivery window but gives upcoming work its task budget', async t => {
  const calls = [];
  const h = fixture({ now: () => 1_000,
    resolveTrackNarrationAsset: async (effect, options) => {
      calls.push({ effect, options });
      return { ttsUrl: `/intro-${effect.songId}.mp3`, voiceProfileId: 'voice' };
    } });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'budget-commit', delivery: 'replace_now', source: 'user', tracks: ['one', 'two', 'three', 'four'].map(written) });
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
  const h = fixture({ resolveTrackNarrationAsset: async (effect, options) => {
    signals.push({ songId: effect.track.songId, signal: options.signal });
    return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(null), { once: true }));
  } });
  t.after(() => h.runtime.stop());
  for (const id of ['removed', 'replacement']) {
    await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: `cancel-${id}`,
      delivery: 'replace_now', source: 'user', tracks: [written(id)] });
    await settle();
  }
  assert.equal(signals[0].signal.aborted, true);
  assert.equal(signals[1].signal.aborted, false);
});

test('narration work failures stay closed: no raw error reaches diagnostics or trace', async t => {
  const traces = [];
  let now = 1_000;
  const h = fixture({ now: () => now, trace: entry => traces.push(entry),
    resolveTrackNarrationAsset: async () => {
      now = 4_000;
      const error = new Error('synthesis exploded with key sk-secret');
      error.name = 'SynthesisError';
      throw error;
    } });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'closed-failure-commit',
    delivery: 'replace_now', source: 'user', tracks: [written('failed')] });
  await settle();
  await settle();
  const state = h.runtime.snapshot();
  const failed = state.diagnostics.find(entry => entry.type === 'track-narration-asset-failed');
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
    delivery: 'replace_now', source: 'user', tracks: [written('unwired')] });
  await settle();
  await settle();
  const state = h.runtime.snapshot();
  const failed = state.diagnostics.find(entry => entry.type === 'track-narration-asset-failed');
  assert.equal(failed?.reason, 'not-configured');
  assert.equal(state.queue[0].narration.assetStatus, 'failed');
});

test('cancelled narration work releases the worker even when the work promise never settles', async t => {
  const seen = [];
  let releaseFirst;
  const h = fixture({ maxPreparationConcurrency: 1,
    resolveTrackNarrationAsset: effect => {
      seen.push(effect.track.songId);
      if (effect.track.songId === 'first') return new Promise(resolve => { releaseFirst = resolve; });
      return Promise.resolve({ ttsUrl: '/second.mp3', voiceProfileId: 'voice' });
    } });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'abort-commit',
    delivery: 'replace_now', source: 'user', tracks: [written('first'), written('second')] });
  await settle();
  await settle();
  assert.deepEqual(seen, ['first'], '单个准备位被未完成的合成占用');
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'abort-replace',
    delivery: 'replace_now', source: 'user', tracks: [written('second'), written('third')] });
  for (let i = 0; i < 20 && !seen.includes('second'); i += 1) await settle();
  assert.equal(seen.includes('second'), true, '已取消的合成必须尽快释放准备位');
  releaseFirst?.({ ttsUrl: '/late.mp3' });
  await settle();
  await settle();
  assert.equal(h.runtime.snapshot().queue.some(item => item.songId === 'first'), false);
});

test('background narration audio remains useful after a track switch and is not projected to queue UI', async () => {
  let releaseAudio;
  let audioStarted;
  const started = new Promise(resolve => { audioStarted = resolve; });
  const h = fixture({
    resolveTrackNarrationAsset: effect => {
      audioStarted(effect);
      return new Promise(resolve => { releaseAudio = resolve; });
    },
  });
  await h.runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'background-commit', delivery: 'replace_now', source: 'user',
    tracks: [written('first'), track('second'), track('third'), track('fourth'), track('fifth')],
  });
  const effect = await started;
  assert.equal(h.runtime.snapshot().phase, PlaybackPhase.LOADING);
  assert.equal(h.runtime.snapshot().queue[0].narration.assetStatus, 'resolving');
  assert.equal(h.runtime.snapshot().queue[1].narration.status, 'absent');

  const firstVersion = h.runtime.snapshot().version;
  await h.runtime.submit({ type: PlaybackEventType.NEXT_REQUESTED, eventId: 'background-next',
    runtimeVersion: firstVersion, songId: 'first' });
  assert.equal(h.runtime.snapshot().currentSongId, 'second');
  releaseAudio({ ttsUrl: '/first.mp3', contentHash: 'first-hash', voiceProfileId: 'voice-a' });
  await settle();
  await settle();

  const state = h.runtime.snapshot();
  assert.equal(state.currentSongId, 'second');
  assert.equal(state.queue[0].queueItemId, effect.queueItemId);
  assert.equal(state.queue[0].narration.assetStatus, 'ready');
  assert.equal(state.queue[0].narration.contentHash, 'first-hash');
  assert.equal(h.messages.some(message => message.type === 'runtime-command'
    && message.command.type === 'PLAY_TRACK_NARRATION' && message.command.queueItemId === effect.queueItemId), false);
  const queueMessage = h.messages.find(message => message.type === 'queue-update');
  assert.equal(Object.hasOwn(queueMessage.queue[0], 'narration'), false);
  assert.equal(Object.hasOwn(queueMessage.queue[0], 'intro'), false);
  h.runtime.stop();
});

test('a line that no longer holds is dropped before any audio: no TTS, the song keeps playing', async t => {
  const traces = [];
  let resolved = 0;
  const h = fixture({ trace: entry => traces.push(entry),
    lineDropReason: track => (track.songId === 'one' ? 'too-old' : null),
    resolveTrackNarrationAsset: async () => { resolved += 1; return { ttsUrl: '/x.mp3' }; } });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'drop-commit',
    delivery: 'replace_now', source: 'user', tracks: [written('one')] });
  await settle();
  await settle();
  const state = h.runtime.snapshot();
  assert.equal(resolved, 0, '作废的串词不花 TTS');
  assert.equal(state.queue[0].narration.status, 'absent');
  assert.equal(state.queue[0].narration.text, '');
  assert.equal(state.currentSongId, 'one', '音乐不受影响');
  assert.equal(state.diagnostics.find(entry => entry.type === 'track-narration-dropped')?.reason, 'too-old');
  assert.equal(h.messages.some(message => message.command?.type === 'PLAY_TRACK_NARRATION'), false);
});

test('audio resolved ahead and again at activation is not rejected as a duplicate event', async t => {
  const calls = [];
  const h = fixture({ resolveTrackNarrationAsset: async effect => {
    calls.push(effect.songId);
    return { ttsUrl: `/${effect.songId}-${calls.length}.mp3`, contentHash: `hash-${calls.length}` };
  } });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.COMPANION_MODE_CHANGED, eventId: 'twice-mode', modeId: 'conversational', requestId: 'twice-mode' });
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'twice-commit',
    delivery: 'replace_now', source: 'user', tracks: [written('one'), written('two')] });
  await settle();
  await settle();
  const ahead = h.runtime.snapshot().queue[1].narration;
  assert.equal(ahead.assetStatus, 'ready', '提前一首合成好');
  await h.runtime.submit({ type: PlaybackEventType.NEXT_REQUESTED, eventId: 'twice-next',
    runtimeVersion: h.runtime.snapshot().version, songId: 'one' });
  await settle();
  await settle();
  const narration = h.runtime.snapshot().queue[1].narration;
  assert.equal(narration.assetStatus, 'ready');
  assert.equal(narration.text, ahead.text);
  const rejected = h.runtime.snapshot().diagnostics.filter(entry => /duplicate/i.test(String(entry.reason || '')));
  assert.deepEqual(rejected, []);
  assert.equal(calls.filter(id => id === 'two').length >= 1, true);
});

test('nothing published to the PWA carries a line that has not been spoken', async t => {
  const h = fixture({ resolveTrackNarrationAsset: () => new Promise(() => {}) });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'private-commit',
    delivery: 'replace_now', source: 'user', tracks: [written('one'), written('two')] });
  await settle();
  assert.equal(h.runtime.snapshot().queue[1].narration.text.includes('Title two'), true, '后台存着');
  assert.equal(JSON.stringify(h.messages).includes('这首可以听下去'), false, '消息里没有');
  assert.equal(JSON.stringify(h.projected.map(item => item.snapshot)).includes('这首可以听下去'), false, '投影里没有');
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
      prepareAfterBoundary: async options => { prewarmCalls.push(options); return { ok: true, prepared: true }; },
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
  assert.equal(prewarmCalls.length, 0, '这个边界没落定，不预热下一个');
});

test('continuation commits first, then prewarm: the host never thinks about two batches at once', async () => {
  const order = [];
  const prefs = new Map();
  let prewarmSignal = null;
  let release;
  const runtime = createPlaybackRuntimeComposition({
    prefs: { getPref: key => prefs.get(key), setPref: (key, value) => prefs.set(key, value) },
    queueService: { projectRuntimeSnapshot() {} },
    publish() {},
    getRadioRequestService: () => ({
      handleContinue: async () => { order.push('live'); return { ok: true, tracks: [{}] }; },
      prepareAfterBoundary: options => {
        order.push('prewarm');
        prewarmSignal = options.signal;
        assert.equal(options.sessionId, 'conversation:primary');
        assert.equal(options.isCurrent(), true);
        return new Promise(resolve => { release = resolve; });
      },
    }),
  });
  await runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'program:order', delivery: 'replace_now',
    source: 'user', tracks: [track('order')] });
  const loading = runtime.snapshot();
  await runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: 'track:order:started',
    runtimeVersion: loading.version, songId: 'order', programId: 'program', correlationId: loading.txn.correlationId });
  await settle();
  await settle();
  assert.deepEqual(order, ['live', 'prewarm']);
  await runtime.stop();
  assert.equal(prewarmSignal.aborted, true, '停机时还在预热的 host 回合被取消');
  release({ ok: true });
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

// 停得够久再接着放：旧串词作废的几首交给原 host 重写；交不出去就按代次报失败，安静播放。
async function pausedForHours(options) {
  let clock = 1_000_000;
  const lined = songId => ({ ...track(songId), intro: undefined,
    narration: { status: 'ready', assetStatus: 'missing', text: `《Title ${songId}》。`, generationRevision: 1, writtenAt: clock - 1_000 } });
  const { runtime } = fixture({ now: () => clock, artwork: null, ...options });
  await runtime.ready;
  await runtime.submit({ type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'gap:commit', delivery: 'replace_now',
    source: 'user', tracks: [lined('one'), lined('two')] });
  // 串词资产解析没配置，会先报一个失败事件；等它落定再取版本。
  await settle();
  const ids = () => { const s = runtime.snapshot(); return { songId: s.currentSongId, programId: s.txn?.programId,
    correlationId: s.txn?.correlationId, queueItemId: s.txn?.queueItemId, listeningSessionId: s.activeListeningSessionId,
    outputGeneration: s.outputGeneration, runtimeVersion: s.version }; };
  await runtime.submit({ type: PlaybackEventType.TRACK_STARTED, eventId: 'gap:started', ...ids() });
  await settle();
  clock += 30_000;
  await runtime.submit({ type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'gap:pause', ...ids(), positionSeconds: 30 });
  clock += 3 * 60 * 60 * 1000;
  await runtime.submit({ type: PlaybackEventType.RESUME_REQUESTED, eventId: 'gap:resume', ...ids() });
  await settle();
  await settle();
  return runtime;
}

test('隔久恢复：把开了新代次的那几首交给 rewriteTrackLines', async () => {
  const calls = [];
  const runtime = await pausedForHours({ rewriteTrackLines: async input => { calls.push(input); } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].tracks.map(item => item.songId), ['two']);
  assert.equal(calls[0].resumedAtMs - calls[0].stoppedAtMs, 3 * 60 * 60 * 1000);
  assert.equal(runtime.listeningSnapshot().queue[1].narration.status, 'preparing');
  await runtime.stop();
});

test('没配置重写或重写出错：这几首按代次报失败，安静播放', async () => {
  for (const options of [{}, { rewriteTrackLines: async () => { throw new Error('no host'); } }]) {
    const runtime = await pausedForHours(options);
    const two = runtime.listeningSnapshot().queue[1];
    assert.equal(two.narration.status, 'absent');
    assert.equal(two.narration.generationRevision, 2);
    await runtime.stop();
  }
});

test('already-expired automatic narration window skips TTS invocation and records timeout', async t => {
  let now = 1_000;
  let calls = 0;
  const h = fixture({
    now: () => now,
    resolveTrackNarrationAsset: async () => { calls += 1; return { ttsUrl: '/late.mp3' }; },
  });
  t.after(() => h.runtime.stop());
  await h.runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'expired-win-commit', delivery: 'replace_now',
    source: 'user', tracks: [{ ...track('one'), intro: undefined, narration: { status: 'preparing', generationRevision: 1 } }, track('two')],
  });
  await settle();
  await settle();
  const loading = h.runtime.snapshot();
  const started = await h.runtime.submit({
    type: PlaybackEventType.TRACK_STARTED, eventId: 'expired-win-started',
    runtimeVersion: loading.version, songId: 'one', programId: 'program',
    correlationId: loading.txn.correlationId, queueItemId: loading.txn.queueItemId,
    listeningSessionId: loading.activeListeningSessionId, outputGeneration: loading.outputGeneration,
  });
  assert.equal(started.accepted, true, started.reason);
  // 推进时钟跨过 60 秒 maxStartOffsetMs，再把串词送达 runtime。
  now += 65_000;
  const playing = h.runtime.snapshot();
  await h.runtime.submit({
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'expired-win-line',
    queueItemId: playing.txn.queueItemId, generationRevision: 1,
    listeningSessionId: playing.activeListeningSessionId, songId: 'one', programId: 'program',
    text: '《Title one》这一段已经过了开始窗口。',
  });
  await settle();
  await settle();
  assert.equal(calls, 0, '窗口已过不得再调 TTS');
  assert.equal(h.runtime.snapshot().queue[0].narration.assetStatus, 'failed');
  assert.equal(h.runtime.snapshot().queue[0].narration.synthesisReason, 'timeout');
});

test('POSITION_REPORTED publishes wire runtime-state without duplicate queue-update while updating QueueService runtimeVersion', async t => {
  const h = fixture({ artwork: null });
  t.after(() => h.runtime.stop());
  const withLyric = id => ({ ...track(id), lyric: `[00:00] lyric-${id}` });
  await h.runtime.submit({
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'pos-commit',
    delivery: 'replace_now',
    source: 'user',
    tracks: ['p0', 'p1', 'p2', 'p3'].map(withLyric),
  });
  const loading = h.runtime.snapshot();
  await h.runtime.submit({
    type: PlaybackEventType.TRACK_STARTED,
    eventId: 'pos-started',
    runtimeVersion: loading.version,
    songId: 'p0',
    programId: 'program',
    correlationId: loading.txn.correlationId,
    listeningSessionId: loading.activeListeningSessionId,
    outputGeneration: loading.outputGeneration,
  });

  h.messages.length = 0;
  h.projected.length = 0;

  const playing = h.runtime.snapshot();
  const reported = await h.runtime.submit({
    type: PlaybackEventType.POSITION_REPORTED,
    eventId: 'pos-report-1',
    runtimeVersion: playing.version,
    songId: 'p0',
    programId: 'program',
    correlationId: playing.txn.correlationId,
    listeningSessionId: playing.activeListeningSessionId,
    outputGeneration: playing.outputGeneration,
    positionSeconds: 12.5,
  });
  assert.equal(reported.accepted, true, reported.reason);

  const queueUpdates = h.messages.filter(m => m.type === 'queue-update');
  const runtimeStates = h.messages.filter(m => m.type === 'runtime-state');
  assert.equal(queueUpdates.length, 0, '进度上报不再重复广播 queue-update');
  assert.equal(runtimeStates.length, 1);
  assert.equal(runtimeStates[0].state.positionSeconds, 12.5);
  assert.equal(runtimeStates[0].state.queue[0].lyric, '[00:00] lyric-p0');
  assert.equal(runtimeStates[0].state.queue[1].lyric, '[00:00] lyric-p1');
  assert.equal(runtimeStates[0].state.queue[2].lyric, null);
  assert.equal(runtimeStates[0].state.queue[3].lyric, null);
  assert.deepEqual(h.projected.at(-1).extra, { publish: false });
  assert.equal(h.queueService.snapshot().runtimeVersion, h.runtime.snapshot().version);
});
