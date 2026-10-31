import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackRuntimeHost } from '../../../server/playback/PlaybackRuntimeHost.js';
import { createPlaybackRuntimeState, resumeCommandsForState } from '../../../server/playback/PlaybackRuntime.js';
import { reduceServerMessage, createAppState } from '../../core/appState.js';
import { createPlaybackController } from './playbackController.js';
import { createNarrationCoordinator } from './narrationCoordinator.js';
import { createPlaybackRuntimeClient } from './playbackRuntimeClient.js';
import { createConversationController } from '../conversations/conversationController.js';

class FakeAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.ended = false;
    this.duration = 0;
    this.error = null;
    this.listeners = new Map();
    this.playCalls = 0;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  pause() { this.paused = true; }
  async play() { this.playCalls += 1; this.paused = false; this.ended = false; }
  emit(type) {
    if (type === 'ended') this.ended = true;
    for (const listener of this.listeners.get(type) || []) listener({ type, currentTarget: this });
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('browsing keeps audio unchanged until an explicit listening switch restores the target queue', async t => {
  const store = createAppState({ sessionId: 'a' });
  const music = new FakeAudio(), narration = new FakeAudio();
  let client;
  let deliver = true;
  const host = new PlaybackRuntimeHost({ commandSink: command => deliver ? client.execute(command) : undefined });
  host.subscribe(state => { if (deliver) reduceServerMessage(store, { type: 'runtime-state', state }); });
  const apiClient = {
    post: (_path, event) => host.submit(event),
    get: async path => path === '/api/now' ? { runtime: host.snapshot() }
      : path.includes('?archived') ? { conversations: ['a', 'b', 'empty'].map(sessionId => ({ sessionId, memberIds: [] })) }
      : { sessionId: path.split('/')[3], turns: [] },
  };
  client = createPlaybackRuntimeClient({ store, musicAudio: music, narrationAudio: narration, apiClient }).init();
  t.after(() => client.destroy());
  const controller = createConversationController({ store, apiClient,
    onError: error => { throw error; } });
  await controller.refresh();
  for (const session of ['a', 'b']) {
    await host.submit({ type: 'PROGRAM_COMMITTED', eventId: `queue:${session}`, listeningSessionId: session,
      delivery: session === 'a' ? 'replace_now' : 'append',
      tracks: [{ ...track(session, session, session), intro: { text: session } }] });
  }
  music.emit('playing'); await settle();
  music.currentTime = 42;
  await controller.select('b');
  assert.equal(music.src, '/a.mp3');
  assert.equal(music.paused, false);
  assert.equal(host.snapshot().activeListeningSessionId, 'a');
  await client.listenWith('b');
  assert.equal(music.src, '/b.mp3');
  assert.equal(music.paused, false);
  assert.equal(store.getState().queue[0].song_id, 'b');
  assert.equal(host.listeningSnapshot('a').positionSeconds, 42);
  music.emit('playing'); await settle();
  music.currentTime = 17;
  // Lose WebSocket delivery: the accepted HTTP response still switches the real media.
  deliver = false;
  await controller.select('a');
  assert.equal(music.src, '/b.mp3');
  await client.listenWith('a');
  assert.equal(music.src, '/a.mp3');
  assert.equal(music.currentTime, 42);
  assert.equal(host.listeningSnapshot('b').positionSeconds, 17);
  await controller.select('empty');
  assert.equal(music.src, '/a.mp3');
  await client.listenWith('empty');
  assert.equal(music.src, '');
  assert.equal(music.paused, true);
  assert.deepEqual(store.getState().queue, []);
  // A concurrent server update must be refreshed and retried, not silently rejected.
  await host.submit({ type: 'RADIO_MODE_CHANGED', eventId: 'concurrent-mode', enabled: false });
  await Promise.all([controller.select('b'), controller.select('a')]);
  assert.equal(music.src, '');
  await Promise.all([client.listenWith('b'), client.listenWith('a')]);
  assert.equal(host.snapshot().activeListeningSessionId, 'a');
  assert.equal(music.src, '/a.mp3');
  assert.equal(store.getState().sessionId, 'a');
  assert.equal(store.getState().queue[0].song_id, 'a');
});

function track(songId, title, artist) {
  return {
    songId, programId: 'program', requestId: 'request', title, artist,
    url: `/${songId}.mp3`, duration: 30,
    intro: { text: `接下来是${artist}的《${title}》。`, ttsUrl: `/${songId}-tts.mp3` },
  };
}

test('committed music starts immediately and runtime narration uses preflight then audible acknowledgement', async t => {
  const store = createAppState();
  const narration = new FakeAudio();
  const music = new FakeAudio();
  music.currentTime = 1;
  music.duration = 30;
  const events = [];
  const timeline = [];
  const gains = [];
  const narrations = [];
  const coordinator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  let client;
  const controller = createPlaybackController({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: coordinator,
    locationHref: 'http://localhost/', apiClient: { post: async () => ({ ok: true }) },
    audioGraph: { setMusicGain: (level, duration) => { gains.push([level, duration]); return true; } },
  }).init();
  const host = new PlaybackRuntimeHost({
    commandSink: command => client.execute(command),
    initialState: createPlaybackRuntimeState({ narrationPolicy: {
      settlingDelayMs: 0, maxStartOffsetMs: 20_000, minRemainingMs: 15_000,
      duckLevel: 0.27, duckRampMs: 250, restoreRampMs: 450,
    } }),
  });
  host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
  client = createPlaybackRuntimeClient({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: coordinator,
    locationHref: 'http://localhost/',
    apiClient: { post: async (_path, event) => {
      events.push({ ...event });
      timeline.push(`event:${event.type}`);
      return host.submit(event);
    } },
    callbacks: {
      onNarration: (command, options) => narrations.push({ command, options }),
    },
  }).init();
  t.after(() => { client.destroy(); controller.destroy(); coordinator.destroy(); });
  const originalVoicePlay = narration.play.bind(narration);
  narration.play = () => { timeline.push('narration.play'); return originalVoicePlay(); };

  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'program:commit', delivery: 'replace_now', source: 'user',
    tracks: [{
      ...track('street', '街灯晚餐', '卫兰'),
      narration: { status: 'preparing', assetStatus: 'missing', generationRevision: 1,
        text: '接下来是卫兰的《街灯晚餐》。', context: { predecessor: null } },
    }],
  });
  assert.equal(music.src, '/street.mp3');
  assert.equal(music.paused, false);
  assert.equal(narration.src, '', 'track narration is not loaded before the track starts');
  const activation = host.snapshot();
  music.emit('playing');
  await settle();
  assert.equal(host.snapshot().phase, 'playing');
  const ready = await host.submit({
    type: 'TRACK_NARRATION_READY', eventId: 'voice-ready', queueItemId: activation.txn.queueItemId,
    generationRevision: activation.txn.narrationGenerationRevision,
    listeningSessionId: activation.activeListeningSessionId, outputGeneration: activation.outputGeneration,
    text: '接下来是卫兰的《街灯晚餐》。', ttsUrl: '/street-tts.mp3', contentHash: 'voice-hash',
  });
  assert.equal(ready.commands[0].type, 'PLAY_TRACK_NARRATION');
  for (let attempt = 0; attempt < 8 && host.snapshot().txn?.narrationDelivery !== 'speaking'; attempt += 1) await settle();
  assert.equal(host.snapshot().txn.narrationDelivery, 'speaking');
  assert.equal(narration.src, '/street-tts.mp3');
  assert.deepEqual(narrations.map(item => item.options), [{ overlay: true }]);
  assert.equal(gains[0][0], 0.27);
  assert.equal(gains[0][1], 250);
  assert.equal(music.src, '/street.mp3', 'voice does not replace the music source');
  assert.equal(music.paused, false, 'voice does not pause music');
  const startedIndex = events.findIndex(event => event.type === 'NARRATION_DELIVERY_STARTED');
  const audibleIndex = events.findIndex(event => event.type === 'NARRATION_DELIVERY_AUDIBLE');
  assert.ok(startedIndex >= 0 && startedIndex < audibleIndex);
  const preflightTimelineIndex = timeline.indexOf('event:NARRATION_DELIVERY_STARTED');
  const narrationPlayTimelineIndex = timeline.indexOf('narration.play');
  const audibleTimelineIndex = timeline.indexOf('event:NARRATION_DELIVERY_AUDIBLE');
  assert.ok(preflightTimelineIndex < narrationPlayTimelineIndex, 'preflight reaches the server before audio.play');
  assert.ok(narrationPlayTimelineIndex < audibleTimelineIndex, 'audible acknowledgement follows audio.play');
  assert.equal(events[startedIndex].queueItemId, activation.txn.queueItemId);
  assert.equal(events[startedIndex].correlationId, activation.txn.correlationId);
  assert.equal(events[startedIndex].listeningSessionId, activation.activeListeningSessionId);
  assert.equal(events[startedIndex].outputGeneration, activation.outputGeneration);

  narration.emit('ended');
  for (let attempt = 0; attempt < 6 && host.snapshot().txn?.narrationDelivery !== 'delivered'; attempt += 1) await settle();
  assert.equal(host.snapshot().txn.narrationDelivery, 'delivered');
  assert.deepEqual(gains.map(([level]) => level), [0.27, 1]);
  assert.equal(gains[1][1], 450);
  assert.equal(music.src, '/street.mp3');
  assert.equal(music.paused, false);
});

test('foreground narration delays only the runtime voice overlay, never the confirmed music track', async t => {
  const store = createAppState();
  const narration = new FakeAudio();
  const music = new FakeAudio();
  music.duration = 30;
  music.currentTime = 1;
  const coordinator = createNarrationCoordinator({
    audio: narration,
    locationHref: 'http://localhost/',
  }).init();
  coordinator.beginForegroundTurn('chat-near-track-end');

  let client;
  const host = new PlaybackRuntimeHost({
    commandSink: command => client.execute(command),
    initialState: createPlaybackRuntimeState({ narrationPolicy: {
      settlingDelayMs: 0, maxStartOffsetMs: 20_000, minRemainingMs: 15_000,
    } }),
  });
  host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
  const controller = createPlaybackController({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: coordinator,
    locationHref: 'http://localhost/',
    apiClient: { post: async () => ({ ok: true }) },
    callbacks: {
      onUnlock: () => coordinator.endForegroundTurn('chat-near-track-end'),
    },
  }).init();
  client = createPlaybackRuntimeClient({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: coordinator,
    locationHref: 'http://localhost/',
    apiClient: { post: (_path, event) => host.submit(event) },
  }).init();
  t.after(() => { client.destroy(); controller.destroy(); coordinator.destroy(); });

  controller.playOverlayNarrations([{ url: '/chat-reply.mp3', text: '我先回答你。' }]);
  await settle();
  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'program:continued', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('continued', '下一首', '歌手'), narration: {
      status: 'preparing', assetStatus: 'missing', generationRevision: 1,
      text: '接下来是歌手的《下一首》。', context: {},
    } }],
  });
  await settle();
  assert.equal(narration.src, '/chat-reply.mp3', 'runtime intro cannot replace the active chat reply');
  assert.equal(music.src, '/continued.mp3', 'confirmed music starts while the reply still owns the voice lane');
  assert.equal(music.paused, false);
  const activation = host.snapshot();
  music.emit('playing');
  await settle();
  await host.submit({
    type: 'TRACK_NARRATION_READY', eventId: 'continued-voice-ready', queueItemId: activation.txn.queueItemId,
    generationRevision: activation.txn.narrationGenerationRevision,
    listeningSessionId: activation.activeListeningSessionId, outputGeneration: activation.outputGeneration,
    text: '接下来是歌手的《下一首》。', ttsUrl: '/continued-tts.mp3',
  });
  await settle();
  assert.equal(narration.src, '/chat-reply.mp3', 'runtime overlay remains queued behind the foreground answer');
  assert.equal(music.src, '/continued.mp3');

  narration.emit('ended');
  for (let attempt = 0; attempt < 8 && narration.src !== '/continued-tts.mp3'; attempt += 1) await settle();
  assert.equal(narration.src, '/continued-tts.mp3', 'runtime overlay begins after foreground answer finishes');
  for (let attempt = 0; attempt < 8 && host.snapshot().txn?.narrationDelivery !== 'speaking'; attempt += 1) await settle();
  assert.equal(host.snapshot().txn.narrationDelivery, 'speaking');
  assert.equal(music.src, '/continued.mp3');
  assert.equal(music.paused, false);
  narration.emit('ended');
  await settle();
  assert.equal(host.snapshot().txn.narrationDelivery, 'delivered');
});

test('foreground wait revalidates the delivery window and drops a narration that became late', async t => {
  const store = createAppState();
  const narration = new FakeAudio();
  const music = new FakeAudio();
  music.currentTime = 1;
  music.duration = 30;
  const events = [];
  const coordinator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  coordinator.beginForegroundTurn('long-answer');
  let client;
  const host = new PlaybackRuntimeHost({
    commandSink: command => client.execute(command),
    initialState: createPlaybackRuntimeState({ narrationPolicy: {
      settlingDelayMs: 0, maxStartOffsetMs: 19_000, minRemainingMs: 5_000,
    } }),
  });
  host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
  client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: coordinator,
    locationHref: 'http://localhost/',
    apiClient: { post: async (_path, event) => { events.push({ ...event }); return host.submit(event); } },
  }).init();
  t.after(() => { client.destroy(); coordinator.destroy(); });

  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'long-answer-program', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('late', '等候', '歌手'), narration: {
      status: 'preparing', assetStatus: 'missing', generationRevision: 1,
      text: '接下来是歌手的《等候》。', context: {},
    } }],
  });
  music.emit('playing');
  await settle();
  const activation = host.snapshot();
  await host.submit({
    type: 'TRACK_NARRATION_READY', eventId: 'late-voice-ready', queueItemId: activation.txn.queueItemId,
    generationRevision: activation.txn.narrationGenerationRevision,
    listeningSessionId: activation.activeListeningSessionId, outputGeneration: activation.outputGeneration,
    text: '接下来是歌手的《等候》。', ttsUrl: '/late-tts.mp3',
  });
  assert.equal(host.snapshot().txn.narrationDelivery, 'queued');
  music.currentTime = 21;
  coordinator.endForegroundTurn('long-answer');
  for (let attempt = 0; attempt < 8 && host.snapshot().txn?.narrationDelivery !== 'skipped'; attempt += 1) await settle();

  assert.equal(host.snapshot().txn.narrationDelivery, 'skipped');
  assert.equal(narration.playCalls || 0, 0);
  assert.equal(narration.src, '');
  assert.equal(events.some(event => event.type === 'NARRATION_DELIVERY_STARTED'), false);
  assert.equal(events.some(event => event.type === 'NARRATION_DELIVERY_CANCELLED'), true);
  assert.equal(music.src, '/late.mp3');
  assert.equal(music.paused, false);
});

test('replacing the active track cancels its narration overlay and restores music gain', async t => {
  const store = createAppState();
  const narration = new FakeAudio();
  const music = new FakeAudio();
  music.currentTime = 1;
  music.duration = 30;
  const gains = [];
  const coordinator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  let client;
  const controller = createPlaybackController({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: coordinator,
    locationHref: 'http://localhost/', apiClient: { post: async () => ({ ok: true }) },
    audioGraph: { setMusicGain: (level, duration) => { gains.push([level, duration]); return true; } },
  }).init();
  const host = new PlaybackRuntimeHost({
    commandSink: command => client.execute(command),
    initialState: createPlaybackRuntimeState({ narrationPolicy: {
      settlingDelayMs: 0, maxStartOffsetMs: 20_000, minRemainingMs: 5_000,
      duckLevel: 0.3, duckRampMs: 200, restoreRampMs: 300,
    } }),
  });
  host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
  client = createPlaybackRuntimeClient({
    store, narrationAudio: narration, musicAudio: music, narrationCoordinator: coordinator,
    locationHref: 'http://localhost/', apiClient: { post: (_path, event) => host.submit(event) },
  }).init();
  t.after(() => { client.destroy(); controller.destroy(); coordinator.destroy(); });

  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'replaceable-program', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('old', '旧歌', '歌手'), narration: {
      status: 'preparing', assetStatus: 'missing', generationRevision: 1, text: '旧歌介绍。', context: {},
    } }],
  });
  music.emit('playing');
  await settle();
  const oldActivation = host.snapshot();
  await host.submit({
    type: 'TRACK_NARRATION_READY', eventId: 'replaceable-voice-ready', queueItemId: oldActivation.txn.queueItemId,
    generationRevision: oldActivation.txn.narrationGenerationRevision,
    listeningSessionId: oldActivation.activeListeningSessionId, outputGeneration: oldActivation.outputGeneration,
    text: '旧歌介绍。', ttsUrl: '/old-tts.mp3',
  });
  for (let attempt = 0; attempt < 8 && host.snapshot().txn?.narrationDelivery !== 'speaking'; attempt += 1) await settle();
  assert.equal(host.snapshot().txn.narrationDelivery, 'speaking');
  assert.deepEqual(gains.map(([level]) => level), [0.3]);

  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'replace-old-track', delivery: 'replace_now', source: 'user',
    tracks: [track('new', '新歌', '歌手')],
  });
  await settle();
  assert.equal(host.snapshot().currentSongId, 'new');
  assert.equal(narration.src, '');
  assert.equal(music.src, '/new.mp3');
  assert.equal(music.paused, false);
  assert.deepEqual(gains.map(([level]) => level), [0.3, 1]);
  assert.equal(gains[1][1], 300);
});

async function mediaFactFixture(t) {
  const store = createAppState();
  const music = new FakeAudio();
  const narration = new FakeAudio();
  const reported = [];
  let client;
  let deliverCommands = true;
  const host = new PlaybackRuntimeHost({
    commandSink: command => deliverCommands ? client.execute(command) : undefined,
  });
  host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
  client = createPlaybackRuntimeClient({
    store, musicAudio: music, narrationAudio: narration, locationHref: 'http://localhost/',
    apiClient: { post: async (_path, event) => {
      const result = await host.submit(event);
      reported.push({ event, result });
      return deliverCommands ? result : { ...result, commands: [] };
    } },
  }).init();
  t.after(() => client.destroy());
  const noIntro = id => ({ ...track(id, id, 'Artist'), intro: { text: id } });
  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'initial', delivery: 'replace_now', source: 'user',
    tracks: [noIntro('one'), noIntro('two')],
  });
  music.emit('playing');
  await settle();
  assert.equal(host.snapshot().phase, 'playing');
  return { host, client, music, reported, noIntro,
    delayCommands: () => { deliverCommands = false; } };
}

for (const transition of ['radio-mode', 'pause-resume', 'append', 'after_current']) {
  test(`natural completion remains valid after ${transition} advances the runtime version`, async t => {
    const f = await mediaFactFixture(t);
    const originalVersion = f.client.getActiveTrack().runtimeVersion;
    if (transition === 'radio-mode') {
      await f.client.setRadioMode(false);
    } else if (transition === 'pause-resume') {
      await f.client.pause();
      await f.client.resume();
      // Real HTMLAudioElement fires playing again after resume. The duplicate
      // start fact must not be needed to refresh the media's later end fact.
      f.music.emit('playing');
      await settle();
    } else {
      await f.host.submit({
        type: 'PROGRAM_COMMITTED', eventId: 'more-music', delivery: transition, source: 'user',
        tracks: [{ ...f.noIntro('three'), programId: 'another-program', requestId: 'another-request' }],
      });
    }
    const beforeEnd = f.host.snapshot();
    assert.ok(beforeEnd.version > originalVersion);
    f.music.ended = true;
    f.music.duration = 30;
    f.music.emit('ended');
    await settle();
    await settle();
    const ended = f.reported.find(item => item.event.type === 'TRACK_ENDED');
    assert.equal(ended.event.runtimeVersion, beforeEnd.version);
    assert.equal(ended.result.accepted, true);
    assert.equal(f.host.snapshot().currentSongId, transition === 'after_current' ? 'three' : 'two');
  });
}

for (const replacement of ['different-program', 'different-transaction']) {
  test(`old media completion cannot borrow the version of ${replacement}`, async t => {
    const f = await mediaFactFixture(t);
    const oldIdentity = { ...f.client.getActiveTrack() };
    // Model the interval between receiving a new runtime-state and executing
    // its media command. The old audio can still dispatch its ended callback.
    f.delayCommands();
    if (replacement === 'different-program') {
      await f.host.submit({
        type: 'PROGRAM_COMMITTED', eventId: 'replacement', delivery: 'replace_now', source: 'user',
        tracks: [{ ...f.noIntro('one'), programId: 'new-program', requestId: 'new-request' }],
      });
    } else {
      // A different occurrence, so this really is a replacement transaction.
      await f.client.selectSong('two');
    }
    const replacementState = f.host.snapshot();
    if (replacement === 'different-transaction') {
      assert.equal(replacementState.currentSongId, 'two', 'selecting another song really plays that song');
    }
    f.music.ended = true;
    f.music.emit('ended');
    await settle();
    await settle();
    const ended = f.reported.find(item => item.event.type === 'TRACK_ENDED');
    assert.equal(ended.event.runtimeVersion, oldIdentity.runtimeVersion);
    assert.equal(ended.event.programId, oldIdentity.programId);
    assert.equal(ended.event.correlationId, oldIdentity.correlationId);
    assert.equal(ended.result.accepted, false);
    assert.equal(ended.result.reason, 'stale runtime version');
    assert.deepEqual(f.host.snapshot(), replacementState);
  });
}

test('media failure remains valid after a same-transaction mode change', async t => {  const f = await mediaFactFixture(t);
  await f.client.setRadioMode(false);
  const beforeFailure = f.host.snapshot();
  f.music.error = new Error('decode failed');
  f.music.emit('error');
  await settle();
  await settle();
  const failed = f.reported.find(item => item.event.type === 'TRACK_FAILED');
  assert.equal(failed.event.runtimeVersion, beforeFailure.version);
  assert.equal(failed.result.accepted, true);
  assert.equal(f.host.snapshot().phase, 'error');
});

test('a reopened client re-attaches the confirmed track instead of playing silence', async t => {
  const first = await mediaFactFixture(t);
  const beforeClose = first.host.snapshot();
  await first.host.submit({ type: 'POSITION_REPORTED', eventId: 'before-close-position',
    runtimeVersion: beforeClose.version, songId: beforeClose.currentSongId,
    programId: beforeClose.txn.programId, correlationId: beforeClose.txn.correlationId,
    queueItemId: beforeClose.txn.queueItemId, listeningSessionId: beforeClose.activeListeningSessionId,
    outputGeneration: beforeClose.outputGeneration, positionSeconds: 25 });
  const persisted = JSON.parse(JSON.stringify(first.host.snapshot()));

  // The old window is gone. A fresh page connects to the runtime restored from that
  // snapshot and receives the snapshot plus the replayable phase command.
  const store = createAppState();
  const music = new FakeAudio();
  const narration = new FakeAudio();
  const reported = [];
  let client;
  const host = new PlaybackRuntimeHost({
    initialState: persisted,
    commandSink: command => client.execute(command),
  });
  host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
  client = createPlaybackRuntimeClient({
    store, musicAudio: music, narrationAudio: narration, locationHref: 'http://localhost/',
    apiClient: { post: async (_path, event) => {
      const result = await host.submit(event);
      reported.push({ event, result });
      return result;
    } },
  }).init();
  t.after(() => client.destroy());

  assert.equal(host.snapshot().phase, 'loading');
  assert.equal(host.snapshot().positionSeconds, 25);
  // The WebSocket hub sends the authoritative snapshot before its commands.
  reduceServerMessage(store, { type: 'runtime-state', state: host.snapshot() });
  const replayed = resumeCommandsForState(host.snapshot());
  assert.deepEqual(replayed.map(command => command.type), ['PLAY_TRACK']);
  for (const command of replayed) await client.execute(command);

  assert.equal(music.src, '/one.mp3');
  assert.equal(music.currentTime, 25);
  assert.equal(music.paused, false);
  music.emit('playing');
  await settle();
  await settle();

  assert.equal(host.snapshot().phase, 'playing');
  assert.equal(host.snapshot().currentSongId, 'one');
  const started = reported.find(item => item.event.type === 'TRACK_STARTED');
  assert.equal(started.result.accepted, true);
  assert.equal(started.event.positionSeconds, 25);
  assert.equal(host.snapshot().positionSeconds, 25);
});

test('a listener can still pause after a restart restored the track as unconfirmed media', async t => {
  const store = createAppState();
  const music = new FakeAudio();
  const narration = new FakeAudio();
  const reported = [];
  let client;
  const mountHost = initialState => {
    const host = new PlaybackRuntimeHost({
      initialState,
      commandSink: command => client.execute(command),
    });
    host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
    return host;
  };
  let host = mountHost(null);
  client = createPlaybackRuntimeClient({
    store, musicAudio: music, narrationAudio: narration, locationHref: 'http://localhost/',
    apiClient: { post: async (_path, event) => { const result = await host.submit(event); reported.push(event); return result; } },
  }).init();
  t.after(() => client.destroy());

  await host.submit({ type: 'PROGRAM_COMMITTED', eventId: 'restart-pause-commit', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('one', 'One', 'Artist'), duration: 200 }] });
  music.emit('playing');
  await settle();
  const playing = host.snapshot();
  await host.submit({ type: 'POSITION_REPORTED', eventId: 'restart-pause-position',
    runtimeVersion: playing.version, songId: 'one', programId: playing.txn.programId,
    correlationId: playing.txn.correlationId, queueItemId: playing.txn.queueItemId,
    listeningSessionId: playing.activeListeningSessionId, outputGeneration: playing.outputGeneration,
    positionSeconds: 47 });
  assert.equal(host.snapshot().phase, 'playing');
  assert.equal(host.snapshot().positionSeconds, 47);
  music.currentTime = 47;

  // The server process restarts. The page keeps the media it already plays, so the
  // restored activation is unconfirmed in the runtime while sounding in the browser.
  host = mountHost(JSON.parse(JSON.stringify(host.snapshot())));
  reduceServerMessage(store, { type: 'runtime-state', state: host.snapshot() });
  assert.equal(host.snapshot().phase, 'loading');
  const playCalls = music.playCalls;
  for (const command of resumeCommandsForState(host.snapshot())) await client.execute(command);
  await settle();
  await settle();

  assert.equal(host.snapshot().phase, 'playing', 'the attached client concludes the restored activation');
  assert.equal(host.snapshot().positionSeconds, 47);
  assert.equal(music.playCalls, playCalls, 'the already attached media is never restarted');
  assert.equal(music.src, '/one.mp3');
  assert.equal(reported.filter(event => event.type === 'TRACK_STARTED').length, 1,
    'the attachment is confirmed without inventing a second start fact');

  // The player button now really pauses the current occurrence at the real position.
  music.currentTime = 61.5;
  await client.pause();
  await settle();
  assert.equal(host.snapshot().phase, 'paused');
  assert.equal(host.snapshot().positionSeconds, 61.5);
  assert.equal(music.paused, true);

  // Resuming re-attaches the same occurrence at that paused position, not from zero.
  await client.resume();
  await settle();
  const resumed = reported.filter(event => event.type === 'RESUME_REQUESTED');
  assert.equal(host.snapshot().phase, 'playing');
  assert.equal(music.paused, false);
  assert.equal(resumed.length, 1);
});

test('a reload after a restart resumes the confirmed position instead of replaying from the beginning', async t => {
  const store = createAppState();
  const music = new FakeAudio();
  const narration = new FakeAudio();
  let client;
  const host = new PlaybackRuntimeHost({ commandSink: command => client.execute(command) });
  host.subscribe(snapshot => reduceServerMessage(store, { type: 'runtime-state', state: snapshot }));
  client = createPlaybackRuntimeClient({
    store, musicAudio: music, narrationAudio: narration, locationHref: 'http://localhost/',
    apiClient: { post: async (_path, event) => host.submit(event) },
  }).init();

  await host.submit({ type: 'PROGRAM_COMMITTED', eventId: 'reload-commit', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('one', 'One', 'Artist'), duration: 200 }] });
  music.emit('playing');
  await settle();
  const playing = host.snapshot();
  await host.submit({ type: 'POSITION_REPORTED', eventId: 'reload-position',
    runtimeVersion: playing.version, songId: 'one', programId: playing.txn.programId,
    correlationId: playing.txn.correlationId, queueItemId: playing.txn.queueItemId,
    listeningSessionId: playing.activeListeningSessionId, outputGeneration: playing.outputGeneration,
    positionSeconds: 88 });

  // A fresh window re-attaches the same occurrence: same url, confirmed position.
  const restored = new PlaybackRuntimeHost({ initialState: JSON.parse(JSON.stringify(host.snapshot())) });
  const fresh = new FakeAudio();
  fresh.duration = 200;
  const freshStore = createAppState();
  restored.subscribe(snapshot => reduceServerMessage(freshStore, { type: 'runtime-state', state: snapshot }));
  // The WebSocket hub sends the authoritative snapshot before its commands.
  reduceServerMessage(freshStore, { type: 'runtime-state', state: restored.snapshot() });
  const freshClient = createPlaybackRuntimeClient({
    store: freshStore, musicAudio: fresh, narrationAudio: new FakeAudio(), locationHref: 'http://localhost/',
    apiClient: { post: async (_path, event) => restored.submit(event) },
  }).init();
  t.after(() => { client.destroy(); freshClient.destroy(); });

  for (const command of resumeCommandsForState(restored.snapshot())) await freshClient.execute(command);
  fresh.emit('loadedmetadata');
  await settle();
  assert.equal(restored.snapshot().phase, 'loading');
  assert.equal(fresh.src, '/one.mp3');
  assert.equal(fresh.currentTime, 88, 'the re-attach lands on the confirmed position');
});
