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
