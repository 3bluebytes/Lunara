import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppState, reduceServerMessage } from '../../core/appState.js';
import { createNarrationCoordinator } from './narrationCoordinator.js';
import { createPlaybackRuntimeClient } from './playbackRuntimeClient.js';
import { resetMusicVolumePreferenceForTest, setMusicVolumePreference } from './musicVolumePreference.js';

class FakeAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.ended = false;
    this.duration = 0;
    this.error = null;
    this.listeners = new Map();
    this.playError = null;
    this.playCalls = 0;
  }
  // 真实 DOM 允许同一元素对同一事件注册多个监听器。
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    const list = (this.listeners.get(type) || []).filter(item => item !== listener);
    if (list.length) this.listeners.set(type, list); else this.listeners.delete(type);
  }
  pause() { this.paused = true; }
  async play() { this.playCalls += 1; if (this.playError) throw this.playError; this.paused = false; }
  emit(type) { for (const listener of [...(this.listeners.get(type) || [])]) listener({ type }); }
}

function runtimeState(overrides = {}) {
  return {
    version: 1,
    currentIndex: 0,
    currentSongId: 'one',
    phase: 'loading',
    txn: { correlationId: 'runtime-1-one', programId: 'program' },
    queue: [{ songId: 'one', programId: 'program', requestId: 'request', url: '/one.mp3' }],
    ...overrides,
  };
}

function fixture() {
  const calls = [];
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const store = createAppState({
    runtimeState: runtimeState(),
    queue: [{ kind: 'track', song_id: 'one', programId: 'program', title: 'One', artist: 'A', url: '/one.mp3' }],
    cursor: 0,
  });
  const client = createPlaybackRuntimeClient({
    store,
    narrationAudio: narration,
    musicAudio: music,
    locationHref: 'http://localhost/',
    apiClient: { post: async (path, body) => { calls.push([path, body]); return { ok: true }; } },
    callbacks: {
      onIntro: command => calls.push(['intro', command]),
      onTrack: item => calls.push(['track', item]),
    },
    eventIdFactory: prefix => `${prefix}-event`,
  });
  client.init();
  return { client, calls, narration, music, store };
}

test('dismissal pins the clicked occurrence and retries with the same id, never the new song', async () => {
  const f = fixture();
  try {
    f.store.update({ runtimeState: runtimeState({ activeListeningSessionId: 'room', outputGeneration: 2,
      queue: [{ queueItemId: 'q-new', songId: 'new', source: 'qq', programId: 'program' }] }) });
    const target = { queueItemId: 'q-old', songId: 'old', source: 'qq', listeningSessionId: 'room', outputGeneration: 1 };
    await f.client.dismissTrack(target);
    await f.client.dismissTrack(target);
    const posted = f.calls.filter(([path]) => path === '/api/pb-event');
    assert.equal(posted.length, 1, 'same request stays deduplicated in this client');
    assert.equal(posted[0][1].queueItemId, 'q-old');
    assert.equal(posted[0][1].songId, 'old');
    assert.equal(posted[0][1].outputGeneration, 1);
    assert.equal(posted[0][1].provider, 'qq');
    assert.equal(posted[0][1].type, 'TRACK_DISMISS_REQUESTED');
    assert.equal(posted[0][1].eventId, 'dismiss:room:q-old');
  } finally { f.client.destroy(); }
});

test('listening switch survives two consecutive stale runtime races without surfacing transient errors', async () => {
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const store = createAppState({
    runtimeState: runtimeState({
      activeListeningSessionId: 'conversation:a', outputGeneration: 1,
    }),
  });
  const calls = [];
  const errors = [];
  let postAttempt = 0;
  let refreshVersion = 1;
  const apiClient = {
    async post(path, body) {
      calls.push([path, body]);
      postAttempt += 1;
      if (postAttempt === 1) throw new Error('stale runtime version');
      if (postAttempt === 2) throw new Error('stale output generation');
      return {
        ok: true,
        state: runtimeState({
          version: 4, activeListeningSessionId: 'conversation:b', outputGeneration: 2,
        }),
      };
    },
    async get(path) {
      calls.push([path]);
      refreshVersion += 1;
      return {
        runtime: runtimeState({
          version: refreshVersion,
          activeListeningSessionId: 'conversation:a',
          outputGeneration: refreshVersion === 2 ? 1 : 2,
        }),
      };
    },
  };
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music, apiClient,
    callbacks: { onError: error => errors.push(error.message) },
  }).init();

  await client.listenWith('conversation:b', 'now');

  assert.equal(calls.filter(([path]) => path === '/api/pb-event').length, 3);
  assert.equal(calls.filter(([path]) => path === '/api/now').length, 2);
  assert.equal(store.getState().runtimeState.activeListeningSessionId, 'conversation:b');
  assert.deepEqual(errors, []);
  client.destroy();
});

const settle = () => new Promise(resolve => setImmediate(resolve));

function strictActivationFixture({ playError = null, callbacks = {}, coordinator = null } = {}) {
  const queueItemId = 'queue:one-occurrence';
  const correlationId = 'runtime-one-occurrence';
  const listeningSessionId = 'conversation:listener';
  const current = {
    queueItemId, songId: 'one', programId: 'program', requestId: 'request',
    title: 'One', artist: 'Artist', url: '/one.mp3', duration: 30,
  };
  const state = {
    version: 4, currentIndex: 0, currentSongId: 'one', phase: 'loading',
    activeListeningSessionId: listeningSessionId, outputGeneration: 2,
    txn: { queueItemId, correlationId, songId: 'one', programId: 'program', narrationDelivery: 'waiting' },
    queue: [current],
  };
  const store = createAppState({ runtimeState: state, queue: [{ ...current, kind: 'track', song_id: 'one' }], cursor: 0 });
  const calls = [];
  const narration = new FakeAudio();
  const music = new FakeAudio();
  music.playError = playError;
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music,
    narrationCoordinator: coordinator,
    locationHref: 'http://localhost/',
    apiClient: { post: async (path, body) => { calls.push([path, body]); return { ok: true }; } },
    callbacks,
  }).init();
  const command = {
    type: 'PLAY_TRACK', runtimeVersion: 4, queueItemId, correlationId,
    listeningSessionId, outputGeneration: 2, songId: 'one', programId: 'program', url: '/one.mp3',
  };
  return { client, calls, narration, music, store, command, queueItemId, correlationId, listeningSessionId };
}

test('duplicate runtime commands render, speak, and load each phase at most once', async () => {
  const { client, calls, narration, music } = fixture();
  const identity = {
    runtimeVersion: 1, songId: 'one', programId: 'program', correlationId: 'runtime-1-one',
  };
  const show = { type: 'SHOW_TRACK_INTRO', ...identity, text: '第一首。' };
  const tts = { type: 'PLAY_TTS', ...identity, text: '第一首。', url: '/one-tts.mp3' };
  const play = { type: 'PLAY_TRACK', ...identity, url: '/one.mp3' };

  assert.equal(await client.execute(show), true);
  assert.equal(await client.execute(show), false);
  assert.equal(await client.execute(tts), true);
  assert.equal(await client.execute(tts), false);
  narration.ended = true;
  narration.emit('ended');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await client.execute(play), true);
  assert.equal(await client.execute(play), false);
  music.emit('playing');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.filter(([type]) => type === 'intro').length, 1);
  assert.equal(calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TTS_FINISHED').length, 1);
  assert.equal(calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_STARTED').length, 1);
});

test('media error reports failure and never reports natural completion', async () => {
  const { client, calls, music } = fixture();
  const command = {
    type: 'PLAY_TRACK', runtimeVersion: 1, songId: 'one', programId: 'program',
    correlationId: 'runtime-1-one', url: '/one.mp3',
  };
  await client.execute(command);
  music.error = new Error('decode');
  music.emit('error');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(calls.some(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_FAILED'), true);
  assert.equal(calls.some(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_ENDED'), false);
});

test('natural end carries exact command identity and delivered duration once', async () => {
  const { client, calls, music } = fixture();
  const command = {
    type: 'PLAY_TRACK', runtimeVersion: 1, songId: 'one', programId: 'program',
    correlationId: 'runtime-1-one', url: '/one.mp3',
  };
  await client.execute(command);
  music.duration = 30;
  music.ended = true;
  music.emit('ended');
  music.emit('ended');
  await new Promise(resolve => setImmediate(resolve));

  const ended = calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_ENDED');
  assert.equal(ended.length, 1);
  assert.equal(ended[0][1].songId, 'one');
  assert.equal(ended[0][1].correlationId, 'runtime-1-one');
  assert.equal(ended[0][1].deliveredDuration, 30);
});

test('user next and card selection are reported as runtime events without local cursor mutation', async () => {
  const { client, calls, store } = fixture();
  await client.requestNext();
  await client.selectSong('two');

  assert.equal(store.getState().cursor, 0);
  assert.deepEqual(calls.filter(([path]) => path === '/api/pb-event').map(([, body]) => body.type), [
    'NEXT_REQUESTED', 'CARD_SELECTED',
  ]);
  assert.equal(calls.at(-1)[1].songId, 'two');
});

test('queue selection carries the stable occurrence id, including duplicate songs', async () => {
  const { client, calls } = fixture();
  await client.selectQueueItem('queue:second-occurrence');
  const [, event] = calls.at(-1);
  assert.equal(event.type, 'CARD_SELECTED');
  assert.equal(event.queueItemId, 'queue:second-occurrence');
  // The current song's id must not ride along with an explicit target: the runtime
  // resolves the named occurrence, and a stray songId can only confuse that choice.
  assert.equal(event.songId, undefined);
});

test('music starts without waiting for a foreground narration turn', async () => {
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const coordinator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  coordinator.beginForegroundTurn('chat-answer');
  const store = createAppState({ runtimeState: runtimeState(), queue: [], cursor: 0 });
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: coordinator,
    locationHref: 'http://localhost/', apiClient: { post: async () => ({ ok: true }) },
  }).init();

  await client.execute({
    type: 'PLAY_TRACK', runtimeVersion: 1, songId: 'one', programId: 'program',
    correlationId: 'runtime-1-one', url: '/one.mp3',
  });
  assert.equal(music.src, '/one.mp3');
  assert.equal(music.paused, false);
  assert.equal(music.playCalls, 1);
  assert.equal(narration.src, '');
  client.destroy();
  coordinator.destroy();
});

test('autoplay denial retains the confirmed occurrence and retry calls play synchronously without a runtime request', async () => {
  const blocked = Object.assign(new Error('gesture required'), { name: 'NotAllowedError' });
  const callbacks = [];
  const f = strictActivationFixture({
    playError: blocked,
    callbacks: { onAutoplayBlocked: (error, command) => callbacks.push([error, command]) },
  });
  await f.client.execute(f.command);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0][0].name, 'NotAllowedError');
  assert.equal(callbacks[0][1].queueItemId, f.queueItemId);
  assert.equal(f.client.getActiveTrack().queueItemId, f.queueItemId);
  assert.equal(f.calls.some(([, event]) => event.type === 'TRACK_FAILED'), false);
  assert.equal(f.music.src, f.command.url);

  f.music.playError = null;
  const callsBeforeRetry = f.calls.length;
  const playCallsBeforeRetry = f.music.playCalls;
  const retryResult = f.client.retry();
  assert.equal(f.music.playCalls, playCallsBeforeRetry + 1, 'play() was invoked in the synchronous click stack');
  assert.equal(f.calls.length, callsBeforeRetry, 'retry does not post next/retry or start a new program');
  assert.equal(f.client.getActiveTrack().correlationId, f.correlationId);
  assert.deepEqual(await retryResult, { accepted: true });
  f.client.destroy();
});

test('autoplay recovery refuses a target after its queue occurrence is replaced', async () => {
  const blocked = Object.assign(new Error('gesture required'), { name: 'NotAllowedError' });
  const f = strictActivationFixture({ playError: blocked });
  await f.client.execute(f.command);
  const replacement = runtimeState({
    version: 5,
    queue: [{ queueItemId: 'queue:replacement', songId: 'one', programId: 'program' }],
    txn: { queueItemId: 'queue:replacement', correlationId: 'new-correlation', songId: 'one', programId: 'program' },
  });
  f.store.update({ runtimeState: replacement });
  const callsBeforeRetry = f.music.playCalls;
  const result = await f.client.retry();
  assert.equal(result.accepted, false);
  assert.equal(f.music.playCalls, callsBeforeRetry);
  f.client.destroy();
});

test('a delayed PLAY_TRACK command cannot start its URL after the runtime selects a replacement occurrence', async () => {
  const f = strictActivationFixture();
  const previous = f.store.getState().runtimeState;
  const replacementQueueItemId = 'queue:replacement';
  f.store.update({ runtimeState: {
    ...previous,
    version: previous.version + 1,
    phase: 'loading',
    currentIndex: 0,
    currentSongId: 'one',
    queue: [{ ...previous.queue[0], queueItemId: replacementQueueItemId, url: '/replacement.mp3' }],
    txn: { ...previous.txn, queueItemId: replacementQueueItemId, correlationId: 'runtime-replacement' },
  } });
  f.music.src = '/replacement.mp3';
  f.music.paused = false;

  assert.equal(await f.client.execute(f.command), false);
  assert.equal(f.music.playCalls, 0);
  assert.equal(f.music.src, '/replacement.mp3');
  assert.equal(f.client.getActiveTrack(), null);
  f.client.destroy();
});

test('PLAY_TRACK requires a non-empty URL matching the selected queue occurrence', async () => {
  const f = strictActivationFixture();
  assert.equal(await f.client.execute({ ...f.command, url: '/stale.mp3' }), false);
  assert.equal(f.music.playCalls, 0);
  assert.equal(f.music.src, '');

  const missingUrl = {
    ...f.store.getState().runtimeState,
    queue: [{ ...f.store.getState().runtimeState.queue[0], url: '' }],
  };
  f.store.update({ runtimeState: missingUrl });
  assert.equal(await f.client.execute(f.command), false);
  assert.equal(f.music.playCalls, 0);
  f.client.destroy();
});

test('only NotAllowedError is treated as autoplay recovery; media errors fail the track', async () => {
  const f = strictActivationFixture({ playError: new Error('network/decode failure') });
  let blockedCount = 0;
  // Wrap the initialized callback for this fixture through a dedicated client.
  f.client.destroy();
  const music = new FakeAudio();
  music.playError = new Error('network/decode failure');
  const narration = new FakeAudio();
  const calls = [];
  const client = createPlaybackRuntimeClient({
    store: f.store, narrationAudio: narration, musicAudio: music, locationHref: 'http://localhost/',
    apiClient: { post: async (path, event) => { calls.push([path, event]); return { ok: true }; } },
    callbacks: { onAutoplayBlocked: () => { blockedCount += 1; } },
  }).init();
  await client.execute(f.command);
  assert.equal(blockedCount, 0);
  assert.equal(calls.some(([, event]) => event.type === 'TRACK_FAILED'), true);
  client.destroy();
});

test('track end uses the version returned by start confirmation', async () => {
  const calls = [];
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const client = createPlaybackRuntimeClient({
    store: createAppState({ runtimeState: runtimeState(), queue: [], cursor: 0 }),
    narrationAudio: narration,
    musicAudio: music,
    locationHref: 'http://localhost/',
    apiClient: {
      post: async (path, body) => {
        calls.push([path, body]);
        return body.type === 'TRACK_STARTED' ? { ok: true, state: { version: 2 } } : { ok: true };
      },
    },
  });
  client.init();
  await client.execute({
    type: 'PLAY_TRACK', runtimeVersion: 1, songId: 'one', programId: 'program',
    correlationId: 'runtime-1-one', url: '/one.mp3',
  });
  music.emit('playing');
  await new Promise(resolve => setImmediate(resolve));
  music.ended = true;
  music.duration = 20;
  music.emit('ended');
  await new Promise(resolve => setImmediate(resolve));

  const ended = calls.find(([, body]) => body.type === 'TRACK_ENDED');
  assert.equal(ended[1].runtimeVersion, 2);
  client.destroy();
});

test('TTS and media loading timeouts report explicit failures without implicit advance', async () => {
  const calls = [];
  const timers = [];
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const client = createPlaybackRuntimeClient({
    store: createAppState({ runtimeState: runtimeState(), queue: [], cursor: 0 }),
    narrationAudio: narration,
    musicAudio: music,
    locationHref: 'http://localhost/',
    apiClient: { post: async (path, body) => { calls.push([path, body]); return { ok: true }; } },
    schedule: callback => { timers.push(callback); return timers.length; },
    cancelSchedule: () => {},
  });
  client.init();
  await client.execute({
    type: 'PLAY_TTS', runtimeVersion: 1, songId: 'one', programId: 'program',
    correlationId: 'runtime-1-one', text: 'Intro', url: '/intro.mp3',
  });
  await settle();
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(([, body]) => body.type === 'TTS_FAILED' && body.error === 'tts timeout'), true);

  await client.execute({
    type: 'PLAY_TRACK', runtimeVersion: 2, songId: 'one', programId: 'program',
    correlationId: 'runtime-1-one', url: '/one.mp3',
  });
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  // 线上只传封闭分类：浏览器原文可能带直链，进日志或 runtime 状态都不合适。
  assert.equal(calls.some(([, body]) => body.type === 'TRACK_FAILED'
    && body.failureKind === 'timeout' && body.error === 'timeout'), true);
  assert.equal(calls.some(([, body]) => body.type === 'TRACK_ENDED'), false);
  client.destroy();
});

test('runtime reset stops and clears both media channels', async () => {
  const { client, narration, music } = fixture();
  narration.src = '/speech.mp3';
  music.src = '/one.mp3';
  narration.paused = false;
  music.paused = false;

  assert.equal(await client.execute({ type: 'STOP_PLAYBACK', runtimeVersion: 8 }), true);
  assert.equal(narration.paused, true);
  assert.equal(narration.src, '');
  assert.equal(music.paused, true);
  assert.equal(music.src, '');
  client.destroy();
});

for (const changedField of ['songId', 'programId', 'correlationId']) {
  test(`media version refresh requires a matching ${changedField}`, async () => {
    const { client, calls, music, store } = fixture();
    const original = {
      type: 'PLAY_TRACK', runtimeVersion: 1, songId: 'one', programId: 'program',
      correlationId: 'runtime-1-one', url: '/one.mp3',
    };
    await client.execute(original);
    const latest = runtimeState({ version: 9 });
    if (changedField === 'correlationId') latest.txn.correlationId = 'different-transaction';
    else latest.queue[0][changedField] = 'different-value';
    store.update({ runtimeState: latest });
    music.ended = true;
    music.emit('ended');
    await new Promise(resolve => setImmediate(resolve));
    const ended = calls.find(([, body]) => body.type === 'TRACK_ENDED')[1];
    assert.equal(ended.runtimeVersion, 1, 'unrelated state cannot make an old media fact current');
    assert.equal(ended.songId, original.songId);
    assert.equal(ended.programId, original.programId);
    assert.equal(ended.correlationId, original.correlationId);
    client.destroy();
  });
}

test('a reissued activation for media this client already owns does not restart it', async () => {
  const { client, calls, music, command } = strictActivationFixture();
  await client.execute(command);
  music.emit('playing');
  await settle();
  music.currentTime = 26;

  // A reconnect reissues the phase command for the occurrence this client is already
  // playing. Restarting it would replay the song from the beginning on every blip.
  assert.equal(await client.execute({ ...command, runtimeVersion: 5 }), true);
  assert.equal(music.src, '/one.mp3');
  assert.equal(music.currentTime, 26);
  assert.equal(music.playCalls, 1);
  assert.equal(calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_STARTED').length, 1);
  assert.equal(calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_FAILED').length, 0);
  client.destroy();
});

test('a resume command rebuilds the media when this client holds none', async () => {
  const { client, calls, music, queueItemId, correlationId, listeningSessionId } = strictActivationFixture();
  const resume = { type: 'RESUME_TRACK', runtimeVersion: 4, queueItemId, correlationId,
    listeningSessionId, outputGeneration: 2, songId: 'one', programId: 'program',
    url: '/one.mp3', positionSeconds: 12 };

  assert.equal(await client.execute(resume), true);
  assert.equal(music.src, '/one.mp3');
  assert.equal(music.currentTime, 12);
  assert.equal(music.paused, false);
  assert.equal(client.getActiveTrack()?.queueItemId, queueItemId);
  assert.equal(client.getActiveTrack()?.correlationId, correlationId);
  assert.equal(calls.some(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_STARTED'), false);
  client.destroy();
});

test('a resume command for media this client already holds only resumes playback', async () => {
  const { client, calls, music, command, queueItemId, correlationId, listeningSessionId } = strictActivationFixture();
  await client.execute(command);
  music.emit('playing');
  await settle();
  music.pause();
  music.currentTime = 12;

  const resume = { type: 'RESUME_TRACK', runtimeVersion: 6, queueItemId, correlationId,
    listeningSessionId, outputGeneration: 2, songId: 'one', programId: 'program',
    url: '/one.mp3', positionSeconds: 12 };
  assert.equal(await client.execute(resume), true);
  assert.equal(music.src, '/one.mp3');
  assert.equal(music.playCalls, 2);
  assert.equal(music.paused, false);
  assert.equal(calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_STARTED').length, 1);
  client.destroy();
});

test('start confirmation reports the position the media actually started at', async () => {
  const { client, calls, music, command } = strictActivationFixture();
  await client.execute(command);
  music.currentTime = 17;
  music.emit('playing');
  await settle();

  const started = calls.find(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_STARTED');
  assert.equal(started[1].positionSeconds, 17);
  assert.equal(started[1].queueItemId, command.queueItemId);
  assert.equal(started[1].correlationId, command.correlationId);
  client.destroy();
});

test('a pause reports the position the listener is actually at', async () => {
  const { client, calls, music, command } = strictActivationFixture();
  await client.execute(command);
  music.emit('playing');
  await settle();
  music.currentTime = 37.25;

  await client.pause();
  await settle();

  const paused = calls.find(([path, body]) => path === '/api/pb-event' && body.type === 'PAUSE_REQUESTED');
  assert.equal(paused[1].positionSeconds, 37.25);
  assert.equal(paused[1].queueItemId, command.queueItemId);
  assert.equal(paused[1].correlationId, command.correlationId);
  client.destroy();
});

test('a pause without local media does not invent a position for the runtime', async () => {
  const { client, calls } = strictActivationFixture();
  await client.pause();
  await settle();

  const paused = calls.find(([path, body]) => path === '/api/pb-event' && body.type === 'PAUSE_REQUESTED');
  assert.equal(paused[1].positionSeconds, undefined);
  client.destroy();
});

test('a reissued activation for owned media confirms the attachment instead of restarting it', async () => {
  const { client, calls, music, command, store } = strictActivationFixture();
  await client.execute(command);
  music.emit('playing');
  await settle();
  music.currentTime = 19.5;
  const playCalls = music.playCalls;

  // The runtime restarted and restored the same activation as unconfirmed.
  store.update(next => ({ ...next, runtimeState: { ...next.runtimeState, version: 9, phase: 'loading' } }));
  const reissued = { ...command, runtimeVersion: 9, resume: true, positionSeconds: 19.5 };
  assert.equal(await client.execute(reissued), true);
  await settle();

  const reattached = calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_REATTACHED');
  assert.equal(reattached.length, 1, 'the attachment is confirmed exactly once');
  assert.equal(reattached[0][1].positionSeconds, 19.5);
  assert.equal(reattached[0][1].queueItemId, command.queueItemId);
  assert.equal(reattached[0][1].correlationId, command.correlationId);
  assert.equal(reattached[0][1].outputGeneration, command.outputGeneration);
  assert.equal(calls.filter(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_STARTED').length, 1,
    'no second track-start fact is invented');
  assert.equal(music.src, '/one.mp3');
  assert.equal(music.playCalls, playCalls, 'the media is never restarted');
  assert.equal(music.paused, false);
  client.destroy();
});

test('a reissued activation for owned media stays silent while the runtime already plays it', async () => {
  const { client, calls, music, command, store } = strictActivationFixture();
  await client.execute(command);
  music.emit('playing');
  await settle();
  music.currentTime = 12;

  store.update(next => ({ ...next, runtimeState: { ...next.runtimeState, version: 9, phase: 'playing' } }));
  assert.equal(await client.execute({ ...command, runtimeVersion: 9, resume: true, positionSeconds: 12 }), true);
  await settle();

  assert.equal(calls.some(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_REATTACHED'), false);
  assert.equal(music.playCalls, 1);
  client.destroy();
});

test('a reissued activation does not confirm media the client is not playing', async () => {
  const { client, calls, music, command } = strictActivationFixture();
  await client.execute(command);
  music.emit('playing');
  await settle();
  music.pause();

  assert.equal(await client.execute({ ...command, runtimeVersion: 9, resume: true }), true);
  await settle();

  assert.equal(calls.some(([path, body]) => path === '/api/pb-event' && body.type === 'TRACK_REATTACHED'), false);
  client.destroy();
});

test('a control that names another song does not carry the occurrence that is playing', async () => {
  const { client, calls, command } = strictActivationFixture();
  await client.execute(command);
  await client.selectSong('two');
  await settle();

  const card = calls.find(([path, body]) => path === '/api/pb-event' && body.type === 'CARD_SELECTED');
  assert.equal(card[1].songId, 'two');
  assert.equal(card[1].queueItemId, undefined,
    'the playing occurrence must not hijack the requested song');
  client.destroy();
});

test('a control that names a queue occurrence keeps the target it was given', async () => {
  const { client, calls, command } = strictActivationFixture();
  await client.execute(command);
  await client.selectQueueItem('queue:two-occurrence');
  await settle();

  const selected = calls.find(([path, body]) => path === '/api/pb-event' && body.type === 'CARD_SELECTED');
  assert.equal(selected[1].queueItemId, 'queue:two-occurrence');
  assert.equal(selected[1].songId, undefined);
  client.destroy();
});

test('a pause still names the occurrence the listener is hearing', async () => {
  const { client, calls, command } = strictActivationFixture();
  await client.execute(command);
  await client.pause();
  await settle();

  const paused = calls.find(([path, body]) => path === '/api/pb-event' && body.type === 'PAUSE_REQUESTED');
  assert.equal(paused[1].queueItemId, command.queueItemId);
  assert.equal(paused[1].songId, command.songId);
  client.destroy();
});

test('a narration command that is a hair early waits for the settle instead of being dropped', async () => {
  // The runtime arms its window from when it received the track-start fact, while this
  // client measures the media clock, so the first confirmation can land just before the
  // settle. It must be retried, not cancelled.
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const coordinator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  const queueItemId = 'queue:settle-occurrence';
  const correlationId = 'runtime-settle-occurrence';
  const state = {
    version: 5, currentIndex: 0, currentSongId: 'one', phase: 'playing',
    activeListeningSessionId: 'conversation:a', outputGeneration: 0,
    txn: { queueItemId, correlationId, songId: 'one', programId: 'program', narrationDelivery: 'queued' },
    queue: [{ queueItemId, songId: 'one', programId: 'program', requestId: 'r', title: 'One', artist: 'A',
      url: '/one.mp3', duration: 200 }],
  };
  const withDelivery = delivery => ({ ...state, txn: { ...state.txn, narrationDelivery: delivery } });
  const store = createAppState({ runtimeState: withDelivery('queued'), queue: [], cursor: 0 });
  const posted = [];
  let position = 0.9;                                 // 100ms short of the 1s settle
  Object.defineProperty(music, 'currentTime', { configurable: true, get: () => position, set: () => {} });
  music.duration = 200;
  music.paused = false;
  music.src = 'http://localhost/one.mp3';
  const waits = [];
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: coordinator,
    locationHref: 'http://localhost/',
    // The narration window wait is virtualised (and moves the media clock); every other
    // timer, including the media load timeout, keeps its real delay.
    schedule: (callback, delay) => {
      if (delay <= 1_000) { waits.push(delay); position = 1.2; return setTimeout(callback, 0); }
      return setTimeout(callback, delay);
    },
    apiClient: { post: async (_path, body) => {
      posted.push(body);
      if (body.type === 'NARRATION_DELIVERY_STARTED') {
        // The runtime authorizes only once the media has really reached the settle.
        return { ok: true, state: withDelivery(body.positionSeconds < 1 ? 'queued' : 'starting') };
      }
      if (body.type === 'NARRATION_DELIVERY_AUDIBLE') return { ok: true, state: withDelivery('speaking') };
      return { ok: true, state: withDelivery('queued') };
    } },
  }).init();

  await client.execute({ type: 'PLAY_TRACK', runtimeVersion: 5, songId: 'one', programId: 'program',
    correlationId, queueItemId, listeningSessionId: 'conversation:a', outputGeneration: 0, url: '/one.mp3' });
  music.emit('playing');
  await settle();

  assert.equal(await client.execute({ type: 'PLAY_TRACK_NARRATION', runtimeVersion: 5, songId: 'one',
    programId: 'program', correlationId, queueItemId, listeningSessionId: 'conversation:a',
    outputGeneration: 0, url: '/one-tts.mp3', text: '介绍', contentHash: 'h',
    settlingDelayMs: 1_000, maxStartOffsetMs: 20_000, minRemainingMs: 15_000 }), true);
  // The wait is a real (virtualised) macrotask, so let the coordination chain run.
  await new Promise(resolve => setTimeout(resolve, 30));

  const attempts = posted.filter(body => body.type === 'NARRATION_DELIVERY_STARTED');
  assert.equal(attempts.length, 1, 'the confirmation is sent once, after the media reached the settle');
  assert.equal(attempts[0].positionSeconds, 1.2);
  assert.deepEqual(waits, [100], 'the wait matches exactly how early the media was');
  assert.equal(posted.some(body => body.type === 'NARRATION_DELIVERY_CANCELLED'), false,
    'an early window never cancels the introduction');
  assert.equal(narration.src, '/one-tts.mp3', 'the introduction really starts playing');
  client.destroy();
  coordinator.destroy();
});

test('a narration command gives up at once when the runtime drops the delivery', async () => {
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const coordinator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  const queueItemId = 'queue:dropped-occurrence';
  const correlationId = 'runtime-dropped-occurrence';
  const state = {
    version: 5, currentIndex: 0, currentSongId: 'one', phase: 'playing',
    activeListeningSessionId: 'conversation:a', outputGeneration: 0,
    txn: { queueItemId, correlationId, songId: 'one', programId: 'program', narrationDelivery: 'queued' },
    queue: [{ queueItemId, songId: 'one', programId: 'program', requestId: 'r', title: 'One', artist: 'A',
      url: '/one.mp3', duration: 200 }],
  };
  const store = createAppState({ runtimeState: state, queue: [], cursor: 0 });
  const posted = [];
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: coordinator,
    locationHref: 'http://localhost/',
    apiClient: { post: async (_path, body) => {
      posted.push(body);
      // The runtime decided the window has passed: this delivery is no longer queued.
      const delivery = body.type === 'TRACK_STARTED' ? 'queued' : 'skipped';
      return { ok: true, state: { ...state, txn: { ...state.txn, narrationDelivery: delivery } } };
    } },
  }).init();
  music.duration = 200;
  music.paused = false;
  music.src = 'http://localhost/one.mp3';
  music.currentTime = 5;                              // past the settle, so the client posts at once

  await client.execute({ type: 'PLAY_TRACK', runtimeVersion: 5, songId: 'one', programId: 'program',
    correlationId, queueItemId, listeningSessionId: 'conversation:a', outputGeneration: 0, url: '/one.mp3' });
  music.emit('playing');
  await settle();
  await client.execute({ type: 'PLAY_TRACK_NARRATION', runtimeVersion: 5, songId: 'one',
    programId: 'program', correlationId, queueItemId, listeningSessionId: 'conversation:a',
    outputGeneration: 0, url: '/one-tts.mp3', text: '介绍', contentHash: 'h',
    settlingDelayMs: 1_000, maxStartOffsetMs: 20_000, minRemainingMs: 15_000 });
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(posted.filter(body => body.type === 'NARRATION_DELIVERY_STARTED').length, 1,
    'a dropped delivery is not retried');
  assert.equal(narration.src, '', 'nothing is played for a dropped delivery');
  client.destroy();
  coordinator.destroy();
});

test('setCompanionMode patches the validated route with revision and idempotent requestId', async () => {
  const store = createAppState({
    runtimeState: runtimeState({ activeListeningSessionId: 'conversation:a', modeRevision: 2 }),
    queue: [], cursor: -1,
  });
  const calls = [];
  const errors = [];
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: new FakeAudio(), musicAudio: new FakeAudio(),
    locationHref: 'http://localhost/',
    apiClient: {
      async post() { return { ok: true }; },
      async patch(path, body) {
        calls.push(['patch', path, body]);
        return { ok: true, runtime: runtimeState({ activeListeningSessionId: 'conversation:a', companionModeId: body.modeId, modeRevision: 3 }),
          snapshot: { listeningSessionId: 'conversation:a', active: true, runtimeVersion: 1,
            queue: [], companionModeId: body.modeId, modeRevision: 3 } };
      },
    },
    callbacks: { onError: error => errors.push(error) },
    eventIdFactory: prefix => `${prefix}-1`,
  });
  const result = await client.setCompanionMode('music_only');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const [, path, body] = calls[0];
  assert.equal(path, '/api/listening-sessions/conversation%3Aa/companion-mode');
  assert.equal(body.modeId, 'music_only');
  assert.equal(body.expectedRevision, 2);
  assert.equal(body.requestId, 'companion-mode-1');
  assert.equal(store.getState().runtimeState.companionModeId, 'music_only');
  assert.deepEqual(errors, []);
});

test('a late mode response cannot replace a newer listening source', async () => {
  const store = createAppState({ runtimeState: runtimeState({
    version: 10, activeListeningSessionId: 'conversation:a', modeRevision: 2, outputGeneration: 3,
  }) });
  let respond;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: new FakeAudio(), musicAudio: new FakeAudio(),
    apiClient: {
      async post() { throw new Error('mode saves must not issue playback controls'); },
      patch() { requested(); return new Promise(resolve => { respond = resolve; }); },
    },
  });
  const saving = client.setCompanionMode('conversational');
  await started;
  const newer = runtimeState({ version: 12, activeListeningSessionId: 'conversation:b',
    outputGeneration: 4, queue: [{ songId: 'two', queueItemId: 'q:two' }] });
  reduceServerMessage(store, { type: 'runtime-state', state: newer });
  const before = store.getState();
  respond({ ok: true,
    runtime: runtimeState({ version: 11, activeListeningSessionId: 'conversation:a', outputGeneration: 3 }),
    snapshot: { listeningSessionId: 'conversation:a', active: true, runtimeVersion: 11,
      queue: [{ songId: 'one' }], companionModeId: 'conversational' },
  });
  await saving;
  assert.strictEqual(store.getState(), before, 'the newer global source and version stay intact');
  client.destroy();
});

test('setCompanionMode failure refreshes the authoritative state and surfaces the error', async () => {
  const store = createAppState({
    runtimeState: runtimeState({ activeListeningSessionId: 'conversation:a', modeRevision: 0, companionModeId: 'occasional' }),
    queue: [], cursor: -1,
  });
  const errors = [];
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: new FakeAudio(), musicAudio: new FakeAudio(),
    locationHref: 'http://localhost/',
    apiClient: {
      async post() { return { ok: true }; },
      async patch() { const error = new Error('stale'); error.status = 409; throw error; },
      async get(path) { assert.equal(path, '/api/now'); return { runtime: runtimeState({ companionModeId: 'conversational', modeRevision: 5 }) }; },
    },
    callbacks: { onError: error => errors.push(error) },
    eventIdFactory: prefix => `${prefix}-1`,
  });
  await assert.rejects(() => client.setCompanionMode('music_only'), /stale/);
  assert.equal(store.getState().runtimeState.companionModeId, 'conversational',
    '失败后以服务端权威值回显，不乐观保留错误选择');
  assert.equal(errors.length, 1);
});

test('CANCEL_TRACK_NARRATION stops only runtime narration tasks', async () => {
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const store = createAppState({
    runtimeState: runtimeState({ phase: 'playing', activeListeningSessionId: 'conversation:a' }),
    queue: [], cursor: 0,
  });
  const cancelled = [];
  const narrator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' });
  narrator.enqueue({ id: 'pending-intro', lane: 'runtime', url: '/intro.mp3',
    meta: { command: { type: 'PLAY_TRACK_NARRATION', queueItemId: 'q1', correlationId: 'c1' } },
    onCancel: reason => cancelled.push(String(reason)) });
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: narrator,
    locationHref: 'http://localhost/',
    apiClient: { async post() { return { ok: true }; } },
    eventIdFactory: prefix => `${prefix}-1`,
  });
  client.init();
  const handled = await client.execute({ type: 'CANCEL_TRACK_NARRATION', runtimeVersion: 1,
    queueItemId: 'q1', correlationId: 'c1', songId: 'one', reason: 'companion-mode-music-only' });
  assert.equal(handled, true);
  assert.ok(cancelled.includes('companion-mode-music-only'));
  narrator.destroy();
  client.destroy();
});

test('a song activation applies the local music volume preference', async () => {
  resetMusicVolumePreferenceForTest();
  setMusicVolumePreference(0.6);
  const f = strictActivationFixture();
  f.music.volume = 0.15;
  assert.equal(await f.client.execute(f.command), true);
  assert.equal(f.music.volume, 0.6, 'songs apply the user music preference, not a fixed default');
  resetMusicVolumePreferenceForTest();
});

test('a song activation without a stored preference plays at full volume', async () => {
  resetMusicVolumePreferenceForTest();
  const f = strictActivationFixture();
  f.music.volume = 0.15;
  assert.equal(await f.client.execute(f.command), true);
  assert.equal(f.music.volume, 1);
});

test('a stale output generation is ignored instead of touching the media', async () => {
  const f = strictActivationFixture();
  assert.equal(await f.client.execute({ ...f.command, outputGeneration: 1 }), false);
  assert.equal(f.music.src, '', 'a stale command must not load anything');
  f.client.destroy();
});
