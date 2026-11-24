import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppState } from '../../core/appState.js';
import { STORAGE_KEYS } from '../../core/storageKeys.js';
import { createPlaybackController } from './playbackController.js';
import { resetMusicVolumePreferenceForTest, setMusicVolumePreference } from './musicVolumePreference.js';

class FakeAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.ended = false;
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 1;
    this.playCount = 0;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type) {
    if (type === 'ended') this.ended = true;
    for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, currentTarget: this });
  }
  play() {
    this.paused = false;
    this.ended = false;
    this.playCount += 1;
    this.emit('play');
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.emit('pause');
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function track(id) {
  return { kind: 'track', song_id: id, title: `Song ${id}`, artist: 'Radiohost', url: `/${id}.mp3` };
}

function setup({ currentSongId = 'one', apiPost = async () => ({ ok: true }), callbacks = {} } = {}) {
  const queue = currentSongId ? [track(currentSongId)] : [];
  const store = createAppState({
    queue,
    cursor: currentSongId ? 0 : -1,
    runtimeState: {
      version: 3,
      currentSongId,
      currentIndex: currentSongId ? 0 : -1,
      phase: currentSongId ? 'playing' : 'idle',
      queue: [],
    },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  const storage = memoryStorage();
  const gains = [];
  const controller = createPlaybackController({
    store,
    narrationAudio,
    musicAudio,
    apiClient: { post: apiPost },
    storage,
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: value => { gains.push(value); return true; } },
    callbacks,
  });
  controller.init();
  return { controller, store, narrationAudio, musicAudio, storage, gains };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('ordinary chat narration plays once while runtime-owned music remains selected', async () => {
  let unlocks = 0;
  const fixture = setup({ callbacks: { onUnlock: () => { unlocks += 1; } } });
  fixture.musicAudio.src = '/one.mp3';
  await fixture.musicAudio.play();

  assert.equal(fixture.controller.playOverlayNarrations([{ url: '/voice.mp3', text: '晚上好' }]), true);
  await settle();
  assert.equal(fixture.narrationAudio.src, '/voice.mp3');
  assert.equal(fixture.narrationAudio.playCount, 1);
  assert.deepEqual(fixture.gains, [0.2]);
  assert.equal(fixture.store.getState().runtimeState.currentSongId, 'one');

  fixture.narrationAudio.emit('ended');
  assert.equal(unlocks, 1);
  assert.deepEqual(fixture.gains, [0.2, 1]);
  assert.equal(fixture.store.getState().runtimeState.currentSongId, 'one');
  fixture.controller.destroy();
});

test('overlay narration never feeds the waveform analyser', async () => {
  const analysed = [];
  const fixture = setup({ callbacks: { onAnalyser: el => analysed.push(el) } });
  fixture.controller.playOverlayNarrations([{ url: '/voice.mp3', text: '晚上好' }]);
  await settle();
  fixture.narrationAudio.emit('ended');
  await settle();
  assert.deepEqual(analysed, [], 'voice must not take the waveform');
  fixture.controller.destroy();
});

test('multiple non-track narrations are serialized without touching queue or cursor', async () => {
  const fixture = setup();
  const before = fixture.store.getState();
  fixture.controller.playOverlayNarrations([
    { url: '/one-voice.mp3', text: '一' },
    { url: '/two-voice.mp3', text: '二' },
  ]);
  await settle();
  fixture.narrationAudio.emit('ended');
  await settle();
  assert.equal(fixture.narrationAudio.src, '/two-voice.mp3');
  assert.equal(fixture.narrationAudio.playCount, 2);
  fixture.narrationAudio.emit('ended');
  assert.equal(fixture.store.getState().queue, before.queue);
  assert.equal(fixture.store.getState().cursor, before.cursor);
  fixture.controller.destroy();
});

test('search interstitial returns to thinking without prematurely unlocking input', async () => {
  let unlocks = 0;
  const statuses = [];
  const fixture = setup({
    callbacks: {
      onUnlock: () => { unlocks += 1; },
      onStatus: status => statuses.push(status),
    },
  });
  fixture.controller.playOverlayNarrations([{
    url: '/interstitial.mp3', text: '翻翻片库', keepThinkingOnEnd: true,
  }]);
  await settle();
  fixture.narrationAudio.emit('ended');
  await settle();
  assert.equal(unlocks, 0);
  assert.equal(statuses.at(-1), 'thinking');
  assert.equal(fixture.controller.getSnapshot().overlayActive, false);
  fixture.controller.destroy();
});

test('outcome telemetry uses the authoritative runtime target and retries durably', async () => {
  let fail = true;
  const calls = [];
  const fixture = setup({
    currentSongId: 'runtime-song',
    apiPost: async (path, body) => {
      calls.push([path, body]);
      if (fail) throw new Error('offline');
      return { ok: true };
    },
  });
  await fixture.controller.reportOutcomeForCurrent('completed', 30);
  assert.deepEqual(calls[0], ['/api/play-outcome', {
    song_id: 'runtime-song', outcome: 'completed', played_seconds: 30,
  }]);
  assert.equal(JSON.parse(fixture.storage.getItem(STORAGE_KEYS.outcomeQueue)).length, 1);
  fail = false;
  await fixture.controller.flushOutcomeQueue();
  assert.deepEqual(JSON.parse(fixture.storage.getItem(STORAGE_KEYS.outcomeQueue)), []);
  fixture.controller.destroy();
});

test('duplicate songs resolve the exact active queue occurrence', () => {
  const fixture = setup({ currentSongId: 'same-song' });
  const queue = [
    { ...track('same-song'), queueItemId: 'queue:first', url: '/first.mp3' },
    { ...track('same-song'), queueItemId: 'queue:second', url: '/second.mp3' },
  ];
  fixture.store.update({
    queue,
    cursor: 1,
    runtimeState: {
      version: 4,
      currentSongId: 'same-song',
      currentIndex: 1,
      phase: 'playing',
      queue: [
        { queueItemId: 'queue:first', songId: 'same-song' },
        { queueItemId: 'queue:second', songId: 'same-song' },
      ],
      txn: { queueItemId: 'queue:second' },
    },
  });

  assert.equal(fixture.controller.currentTrackItem().queueItemId, 'queue:second');
  assert.equal(fixture.controller.currentTrackItem().url, '/second.mp3');
  fixture.controller.destroy();
});

test('legacy music ended and error listeners are absent', () => {
  const fixture = setup();
  assert.equal(fixture.musicAudio.listeners.has('ended'), false);
  assert.equal(fixture.musicAudio.listeners.has('error'), false);
  fixture.musicAudio.emit('ended');
  fixture.musicAudio.emit('error');
  assert.equal(fixture.store.getState().cursor, 0);
  fixture.controller.destroy();
});

test('without a web-audio graph, duck and restore respect the music volume preference', async () => {
  resetMusicVolumePreferenceForTest();
  setMusicVolumePreference(0.5);
  const store = createAppState({
    queue: [track('one')], cursor: 0,
    runtimeState: { version: 3, currentSongId: 'one', currentIndex: 0, phase: 'playing', queue: [] },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  const controller = createPlaybackController({
    store, narrationAudio, musicAudio,
    apiClient: { post: async () => ({ ok: true }) },
    storage: memoryStorage(),
    locationHref: 'http://localhost/',
    // setMusicGain 返回 false = Web Audio 图不可用：压低/恢复走 element volume 回退。
    audioGraph: { setMusicGain: () => false },
  });
  controller.init();
  musicAudio.src = '/one.mp3';
  await musicAudio.play();

  assert.equal(controller.playOverlayNarrations([{ url: '/voice.mp3', text: '晚上好' }]), true);
  await settle();
  assert.equal(musicAudio.volume, 0.1, '压低 = 偏好 × duckLevel，不覆写成固定值');
  narrationAudio.emit('ended');
  await settle();
  assert.equal(musicAudio.volume, 0.5, '恢复回到用户偏好，而不是固定 1');
  controller.destroy();
  resetMusicVolumePreferenceForTest();
});

test('finishOverlayNarrations keeps runtime narration ducking intact when runtime owns the duck', async () => {
  const { createNarrationCoordinator } = await import('./narrationCoordinator.js');
  const store = createAppState({
    queue: [track('one')], cursor: 0,
    runtimeState: { version: 3, currentSongId: 'one', currentIndex: 0, phase: 'playing', queue: [] },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  const coordinator = createNarrationCoordinator({ audio: narrationAudio, locationHref: 'http://localhost/' }).init();
  const gains = [];
  const controller = createPlaybackController({
    store, narrationAudio, musicAudio, narrationCoordinator: coordinator,
    apiClient: { post: async () => ({ ok: true }) },
    storage: memoryStorage(),
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: value => { gains.push(value); return true; } },
  }).init();

  let activeTask;
  coordinator.enqueue({
    id: 'runtime-intro-1',
    lane: 'runtime',
    url: '/intro.mp3',
    meta: { command: { type: 'PLAY_TRACK_NARRATION', queueItemId: 'q1', correlationId: 'c1', outputGeneration: 1, duckLevel: 0.25, duckRampMs: 300, restoreRampMs: 500 } },
    onStart: task => {
      activeTask = task;
      coordinator.publishLifecycle('runtime-audible', task, task.meta.command);
    },
  });
  await settle();
  assert.equal(activeTask?.lane, 'runtime');
  assert.equal(controller.getSnapshot().musicDucked, true);
  assert.deepEqual(gains, [0.25]);

  controller.finishOverlayNarrations();
  assert.equal(controller.getSnapshot().musicDucked, true, 'runtime 拥有 duck 时 overlay 收尾不得误恢复');
  assert.deepEqual(gains, [0.25]);

  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.deepEqual(gains, [0.25, 1]);
  controller.destroy();
  coordinator.destroy();
});

test('applyMusicVolume respects active ducking fallback and stopOverlayNarrations cancels foreground speech', async () => {
  resetMusicVolumePreferenceForTest();
  setMusicVolumePreference(0.5);
  const store = createAppState({
    queue: [track('one')], cursor: 0,
    runtimeState: { version: 3, currentSongId: 'one', currentIndex: 0, phase: 'playing', queue: [] },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  const controller = createPlaybackController({
    store, narrationAudio, musicAudio,
    apiClient: { post: async () => ({ ok: true }) },
    storage: memoryStorage(),
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: () => false },
  });
  controller.init();
  musicAudio.src = '/one.mp3';
  await musicAudio.play();

  assert.equal(controller.playOverlayNarrations([
    { url: '/voice-1.mp3', text: '第一段' },
    { url: '/voice-2.mp3', text: '第二段' },
  ]), true);
  await settle();
  assert.equal(controller.getSnapshot().overlayActive, true);
  assert.equal(controller.applyMusicVolume(0.8), 0.8);
  assert.ok(Math.abs(musicAudio.volume - 0.16) < 1e-6, 'duck 期间修改音量应按 duck 比例折算');

  assert.equal(controller.stopOverlayNarrations(), true);
  assert.equal(controller.getSnapshot().overlayActive, false);
  assert.equal(controller.getSnapshot().overlayQueueLength, 0);
  assert.equal(musicAudio.volume, 0.8, '停止人声后音乐恢复到最新音量偏好');
  controller.destroy();
  resetMusicVolumePreferenceForTest();
});

test('Turn Ducking Lease holds continuous ducking across pipelined radio beats and delayBeforeMs pauses, releasing only on final beat', async () => {
  const { createNarrationCoordinator } = await import('./narrationCoordinator.js');
  const timers = [];
  const store = createAppState({
    queue: [track('one')],
    cursor: 0,
    runtimeState: { version: 3, activeListeningSessionId: 'room-1', currentSongId: 'one', currentIndex: 0, phase: 'playing', queue: [{ queueItemId: 'q1', songId: 'one' }] },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  musicAudio.src = '/one.mp3';
  await musicAudio.play();

  const coordinator = createNarrationCoordinator({
    audio: narrationAudio,
    locationHref: 'http://localhost/',
    setTimer: (fn, ms) => { const entry = { kind: 'delay', fn, ms, cleared: false }; timers.push(entry); return entry; },
    clearTimer: entry => { if (entry) entry.cleared = true; },
  }).init();
  const gains = [];
  const controller = createPlaybackController({
    store,
    narrationAudio,
    musicAudio,
    narrationCoordinator: coordinator,
    apiClient: { post: async () => ({ ok: true }) },
    storage: memoryStorage(),
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: value => { gains.push(value); return true; } },
    setTimer: (fn, ms) => { const entry = { kind: 'safety', fn, ms, cleared: false }; timers.push(entry); return entry; },
    clearTimer: entry => { if (entry) entry.cleared = true; },
  }).init();

  // 第 1 拍先到（流水线后续拍还在合成途中）
  controller.playOverlayNarrations([{
    url: '/b0.mp3',
    sourceTurnId: 'turn_pipe_1',
    beatIndex: 0,
    beatCount: 3,
    isLastBeat: false,
    delayBeforeMs: 0,
    turnDuckLeaseId: 'turn_pipe_1',
    holdDuckLease: true,
  }]);
  await settle();
  assert.deepEqual(gains, [0.2]);
  assert.equal(controller.getSnapshot().musicDucked, true);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 'turn_pipe_1');

  // 第 1 拍播完时队列暂时为空，但 holdDuckLease=true，音乐必须继续保持压低不抬回
  narrationAudio.emit('ended');
  await settle();
  assert.deepEqual(gains, [0.2], '拍间等待下一拍期间音乐不得抬回');
  assert.equal(controller.getSnapshot().musicDucked, true);

  // 第 2 拍（带 delayBeforeMs: 500）与第 3 拍（末拍 holdDuckLease=false）相继到达
  controller.playOverlayNarrations([{
    url: '/b1.mp3',
    sourceTurnId: 'turn_pipe_1',
    beatIndex: 1,
    beatCount: 3,
    isLastBeat: false,
    delayBeforeMs: 500,
    turnDuckLeaseId: 'turn_pipe_1',
    holdDuckLease: true,
  }, {
    url: '/b2.mp3',
    sourceTurnId: 'turn_pipe_1',
    beatIndex: 2,
    beatCount: 3,
    isLastBeat: true,
    delayBeforeMs: 650,
    turnDuckLeaseId: 'turn_pipe_1',
    holdDuckLease: false,
  }]);
  await settle();
  const delay1 = timers.find(t => t.kind === 'delay' && !t.cleared && t.ms === 500);
  assert.ok(delay1);
  assert.deepEqual(gains, [0.2], 'delayBeforeMs 停顿期间仍保持压低');
  delay1.fn();
  await settle();
  assert.equal(narrationAudio.src, '/b1.mp3');

  narrationAudio.emit('ended');
  await settle();
  const delay2 = timers.find(t => t.kind === 'delay' && !t.cleared && t.ms === 650);
  assert.ok(delay2);
  delay2.fn();
  await settle();
  assert.equal(narrationAudio.src, '/b2.mp3');
  assert.deepEqual(gains, [0.2]);

  // 末拍播完后才统一释放租约并恢复音乐音量
  narrationAudio.emit('ended');
  await settle();
  assert.deepEqual(gains, [0.2, 1]);
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);

  controller.destroy();
  coordinator.destroy();
});

test('Turn Ducking Lease releases immediately on user stop, track switch, and 15_000ms safety timeout', async () => {
  const { createNarrationCoordinator } = await import('./narrationCoordinator.js');
  const safetyTimers = [];
  const store = createAppState({
    queue: [track('one'), track('two')],
    cursor: 0,
    runtimeState: { version: 3, activeListeningSessionId: 'room-1', currentSongId: 'one', currentIndex: 0, phase: 'playing', queue: [{ queueItemId: 'q1', songId: 'one' }, { queueItemId: 'q2', songId: 'two' }], txn: { queueItemId: 'q1' } },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  musicAudio.src = '/one.mp3';
  await musicAudio.play();

  const coordinator = createNarrationCoordinator({ audio: narrationAudio, locationHref: 'http://localhost/' }).init();
  const gains = [];
  const controller = createPlaybackController({
    store,
    narrationAudio,
    musicAudio,
    narrationCoordinator: coordinator,
    apiClient: { post: async () => ({ ok: true }) },
    storage: memoryStorage(),
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: value => { gains.push(value); return true; } },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; safetyTimers.push(t); return t; },
    clearTimer: t => { if (t) t.cleared = true; },
  }).init();

  // 1) 切歌打断释放租约
  controller.playOverlayNarrations([{
    url: '/b0.mp3', sourceTurnId: 'turn_cut', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 'turn_cut', holdDuckLease: true,
  }]);
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, true);
  store.update(prev => ({ runtimeState: { ...prev.runtimeState, currentSongId: 'two', currentIndex: 1, txn: { queueItemId: 'q2' } } }));
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);
  assert.equal(gains.at(-1), 1);

  // 2) 丢包未发末拍时 15_000ms 安全兜底定时器释放租约
  controller.playOverlayNarrations([{
    url: '/lost0.mp3', sourceTurnId: 'turn_lost', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 'turn_lost', holdDuckLease: true,
  }]);
  await settle();
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, true);
  const safety = safetyTimers.at(-1);
  assert.equal(safety.ms, 15_000);
  assert.equal(safety.cleared, false);
  safety.fn();
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);
  assert.equal(gains.at(-1), 1);

  // 3) 前台组级 turn_voice（非 overlayOwner）共享 turnDuckLeaseId 并在取消时恢复
  coordinator.enqueue({
    id: 'tv-0', lane: 'foreground', url: '/tv0.mp3',
    meta: { kind: 'turn_voice', sourceTurnId: 'turn_rp_g', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 'turn_rp_g', holdDuckLease: true },
  });
  coordinator.enqueue({
    id: 'tv-1', lane: 'foreground', url: '/tv1.mp3',
    meta: { kind: 'turn_voice', sourceTurnId: 'turn_rp_g', beatIndex: 1, isLastBeat: true, turnDuckLeaseId: 'turn_rp_g', holdDuckLease: false },
  });
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, true);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 'turn_rp_g');
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, true, '组级第 0 拍结束保持压低直到末拍');
  coordinator.cancel(task => task.meta?.turnDuckLeaseId === 'turn_rp_g', 'user-stopped');
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);

  controller.destroy();
  coordinator.destroy();
});

test('[P0-2] queued overlay waits until beforeStart/onStart to take turnDuckLease, preserving active turn_voice ducking', async () => {
  const { createNarrationCoordinator } = await import('./narrationCoordinator.js');
  const store = createAppState({
    queue: [track('one')],
    cursor: 0,
    runtimeState: { version: 3, activeListeningSessionId: 'room-1', currentSongId: 'one', currentIndex: 0, phase: 'playing', queue: [{ queueItemId: 'q1', songId: 'one' }] },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  musicAudio.src = '/one.mp3';
  await musicAudio.play();

  const coordinator = createNarrationCoordinator({ audio: narrationAudio, locationHref: 'http://localhost/' }).init();
  const gains = [];
  const controller = createPlaybackController({
    store,
    narrationAudio,
    musicAudio,
    narrationCoordinator: coordinator,
    apiClient: { post: async () => ({ ok: true }) },
    storage: memoryStorage(),
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: v => { gains.push(v); return true; } },
  }).init();

  coordinator.enqueue({
    id: 'tv-active',
    lane: 'foreground',
    url: '/tv0.mp3',
    meta: { kind: 'turn_voice', sourceTurnId: 'turn_voice_1', beatIndex: 0, isLastBeat: true, turnDuckLeaseId: 'turn_voice_1', holdDuckLease: false },
  });
  await settle();
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 'turn_voice_1');
  assert.deepEqual(gains, [0.2]);

  // Overlay arrives while turn_voice is still playing: must NOT steal turn_voice_1's lease on enqueue.
  controller.playOverlayNarrations([{
    url: '/overlay0.mp3',
    sourceTurnId: 'turn_overlay_1',
    beatIndex: 0,
    isLastBeat: true,
    turnDuckLeaseId: 'turn_overlay_1',
    holdDuckLease: false,
  }]);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 'turn_voice_1');
  assert.deepEqual(gains, [0.2]);

  // Once turn_voice finishes, overlay takes its lease and plays seamlessly.
  narrationAudio.emit('ended');
  await settle();
  assert.equal(narrationAudio.src, '/overlay0.mp3');
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 'turn_overlay_1');
  assert.equal(controller.getSnapshot().musicDucked, true);

  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);
  assert.equal(controller.getSnapshot().musicDucked, false);

  controller.destroy();
  coordinator.destroy();
});

test('[P0-2] sealTurnDuckLease seals queued, active, and dangling-gap leases; stopOverlayNarrations & STOP_PLAYBACK clear dangling leases', async () => {
  const { createNarrationCoordinator } = await import('./narrationCoordinator.js');
  const { createPlaybackRuntimeClient } = await import('./playbackRuntimeClient.js');
  const store = createAppState({
    queue: [track('one')],
    cursor: 0,
    runtimeState: { version: 3, activeListeningSessionId: 'room-1', currentSongId: 'one', currentIndex: 0, phase: 'playing', queue: [{ queueItemId: 'q1', songId: 'one' }] },
  });
  const narrationAudio = new FakeAudio();
  const musicAudio = new FakeAudio();
  musicAudio.src = '/one.mp3';
  await musicAudio.play();

  const coordinator = createNarrationCoordinator({ audio: narrationAudio, locationHref: 'http://localhost/' }).init();
  let unlocks = 0;
  const gains = [];
  const controller = createPlaybackController({
    store,
    narrationAudio,
    musicAudio,
    narrationCoordinator: coordinator,
    apiClient: { post: async () => ({ ok: true }) },
    storage: memoryStorage(),
    locationHref: 'http://localhost/',
    audioGraph: { setMusicGain: v => { gains.push(v); return true; } },
    callbacks: { onUnlock: () => { unlocks += 1; } },
  }).init();

  // 1) Seal queued last beat in overlayQueue
  controller.playOverlayNarrations([
    { url: '/a0.mp3', sourceTurnId: 't_seal_q', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 't_seal_q', holdDuckLease: true },
    { url: '/a1.mp3', sourceTurnId: 't_seal_q', beatIndex: 1, isLastBeat: false, turnDuckLeaseId: 't_seal_q', holdDuckLease: true },
  ]);
  assert.equal(controller.sealTurnDuckLease('t_seal_q'), true);
  await settle();
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, true, '第0拍结束切入第1拍期间保持压低');
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, false, '被封口的第1拍结束后释放租约');
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);

  // 2) Seal currently playing overlayCurrent
  controller.playOverlayNarrations([
    { url: '/b0.mp3', sourceTurnId: 't_seal_cur', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 't_seal_cur', holdDuckLease: true },
  ]);
  await settle();
  assert.equal(controller.sealTurnDuckLease('t_seal_cur'), true);
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);

  // 3) Seal dangling lease in inter-beat gap (previous beat ended, final beat failed synthesis) -> immediate release + onUnlock
  const unlocksBefore = unlocks;
  controller.playOverlayNarrations([
    { url: '/c0.mp3', sourceTurnId: 't_seal_gap', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 't_seal_gap', holdDuckLease: true },
  ]);
  await settle();
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().overlayActive, false);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 't_seal_gap');
  assert.equal(controller.sealTurnDuckLease('t_seal_gap'), true);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.equal(unlocks, unlocksBefore + 1);

  // 4) stopOverlayNarrations in inter-beat gap clears dangling lease and unlocks
  controller.playOverlayNarrations([
    { url: '/d0.mp3', sourceTurnId: 't_stop_gap', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 't_stop_gap', holdDuckLease: true },
  ]);
  await settle();
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 't_stop_gap');
  assert.equal(controller.stopOverlayNarrations(), true);
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);
  assert.equal(controller.getSnapshot().musicDucked, false);
  assert.equal(unlocks, unlocksBefore + 2);

  // 5) STOP_PLAYBACK through playbackRuntimeClient invokes stopOverlayNarrations and clears dangling lease
  const runtimeClient = createPlaybackRuntimeClient({
    store,
    narrationAudio,
    musicAudio,
    narrationCoordinator: coordinator,
    playbackController: controller,
    apiClient: { post: async () => ({ ok: true }) },
    locationHref: 'http://localhost/',
  }).init();
  controller.playOverlayNarrations([
    { url: '/e0.mp3', sourceTurnId: 't_stop_pb', beatIndex: 0, isLastBeat: false, turnDuckLeaseId: 't_stop_pb', holdDuckLease: true },
  ]);
  await settle();
  narrationAudio.emit('ended');
  await settle();
  assert.equal(controller.getSnapshot().turnDuckLeaseId, 't_stop_pb');
  await runtimeClient.execute({ type: 'STOP_PLAYBACK', runtimeVersion: 4 });
  assert.equal(controller.getSnapshot().turnDuckLeaseId, null);
  assert.equal(controller.getSnapshot().musicDucked, false);

  runtimeClient.destroy();
  controller.destroy();
  coordinator.destroy();
});
