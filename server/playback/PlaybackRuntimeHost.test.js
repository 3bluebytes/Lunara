import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackRuntimeHost } from './PlaybackRuntimeHost.js';
import { createPlaybackRuntimeState, reducePlayback } from './PlaybackRuntime.js';
import { PlaybackCommandType, PlaybackEventType, PlaybackPhase } from './playbackRuntimeTypes.js';

function track(songId, overrides = {}) {
  return {
    songId, programId: overrides.programId || 'program', requestId: overrides.requestId || 'request',
    title: `Title ${songId}`, artist: `Artist ${songId}`, url: `/${songId}.mp3`,
    intro: overrides.intro || { text: `Intro ${songId}`, url: `/${songId}-tts.mp3` },
  };
}

function commitEvent(eventId, tracks, overrides = {}) {
  return {
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId,
    delivery: overrides.delivery || 'replace_now',
    source: overrides.source || 'user',
    tracks,
  };
}

test('host serializes concurrent submissions, persists before commands, and publishes immutable snapshots', async () => {
  const order = [];
  const snapshots = [];
  const host = new PlaybackRuntimeHost({
    persistence: {
      async load() { return null; },
      async save(snapshot) { order.push(`persist:${snapshot.version}`); },
    },
    commandSink: async command => { order.push(`command:${command.type}`); },
  });
  host.subscribe(snapshot => snapshots.push(snapshot));

  const [first, second] = await Promise.all([
    host.submit(commitEvent('commit-a', [track('a')])),
    host.submit(commitEvent('commit-b', [track('b', { programId: 'program-b', requestId: 'request-b' })])),
  ]);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(host.snapshot().currentSongId, 'b');
  assert.equal(host.snapshot().version, 2);
  assert.equal(snapshots.length, 2);
  assert.equal(Object.isFrozen(snapshots[0]), true);
  assert.equal(order[0], 'persist:1');
  assert.equal(order[1], `command:${PlaybackCommandType.PLAY_TRACK}`);
});

test('host restart resumes an unfinished track-load phase with its stable queue identity', async () => {
  const loading = reducePlayback(createPlaybackRuntimeState({ companionModeId: null }), commitEvent('commit', [track('one')])).state;
  const commands = [];
  const host = new PlaybackRuntimeHost({
    persistence: { async load() { return JSON.parse(JSON.stringify(loading)); } },
    commandSink: async command => commands.push(command),
  });
  await host.ready;

  assert.equal(host.snapshot().phase, PlaybackPhase.LOADING);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, PlaybackCommandType.PLAY_TRACK);
  assert.equal(commands[0].correlationId, loading.txn.correlationId);
  assert.equal(commands[0].queueItemId, loading.txn.queueItemId);
  assert.equal(commands[0].resume, true);
});

test('corrupt persistence recovers to safe idle and reports the restore error', async () => {
  const errors = [];
  const host = new PlaybackRuntimeHost({
    persistence: { async load() { throw new Error('corrupt json'); } },
    onError: (error, context) => errors.push([error.message, context.type]),
  });
  await host.ready;

  assert.equal(host.snapshot().phase, PlaybackPhase.IDLE);
  assert.equal(host.snapshot().currentSongId, null);
  assert.deepEqual(errors, [['corrupt json', 'restore']]);
});

test('effect failures are isolated from accepted runtime state', async () => {
  const errors = [];
  const host = new PlaybackRuntimeHost({
    effectSink: async effect => {
      if (effect.type === 'REQUEST_CONTINUATION') throw new Error('continuation unavailable');
    },
    onError: (error, context) => errors.push([error.message, context.type]),
  });
  await host.submit(commitEvent('commit-last', [track('last', { intro: { text: 'Last' } })]));
  const loading = host.snapshot();
  await host.submit({
    type: PlaybackEventType.TRACK_STARTED,
    eventId: 'started', runtimeVersion: loading.version,
    songId: 'last', programId: 'program', correlationId: loading.txn.correlationId,
  });
  const playing = host.snapshot();
  await host.submit({
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'ended', runtimeVersion: playing.version, songId: 'last', natural: true,
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(host.snapshot().phase, PlaybackPhase.EXHAUSTED);
  assert.deepEqual(errors, [['continuation unavailable', 'REQUEST_CONTINUATION']]);
});

// ---- 封面补全（历史队列项自愈） ----

const COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000001bkv9c0gpIvm.jpg';
const OTHER_COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000004XyVAD47pOpe.jpg';

function legacyState(ids = ['a', 'b']) {
  const committed = reducePlayback(createPlaybackRuntimeState({ companionModeId: null }),
    commitEvent('commit', ids.map(songId => ({ ...track(songId), source: 'qq' }))));
  assert.equal(committed.accepted, true, committed.reason);
  return JSON.parse(JSON.stringify(committed.state));
}

test('a restored queue with no covers is repaired without touching order, current track or phase', async () => {
  const state = legacyState(['a', 'b', 'c']);
  const before = JSON.parse(JSON.stringify(state));
  const looked = [];
  const host = new PlaybackRuntimeHost({
    persistence: { async load() { return state; } },
    artwork: {
      peek: () => null,
      resolve: async (provider, songId) => { looked.push([provider, songId]); return COVER; },
    },
    artworkBackfillDelayMs: 0,
  });
  await host.ready;
  const result = await host.backfillArtwork();
  assert.equal(result.repaired, 3);
  assert.deepEqual(looked.sort(), [['qq', 'a'], ['qq', 'b'], ['qq', 'c']]);

  const after = host.snapshot();
  assert.equal(after.queue.length, before.queue.length);
  assert.deepEqual(after.queue.map(item => item.songId), before.queue.map(item => item.songId));
  assert.equal(after.currentIndex, before.currentIndex);
  assert.equal(after.phase, before.phase);
  assert.equal(after.outputGeneration, before.outputGeneration);
  assert.deepEqual(after.queue.map(item => item.artwork), [COVER, COVER, COVER]);
  await host.stop();
});

test('covers already known to the cache are applied without a provider query', async () => {
  const state = legacyState(['a', 'b']);
  let queries = 0;
  const host = new PlaybackRuntimeHost({
    persistence: { async load() { return state; } },
    artwork: {
      peek: (provider, songId) => (songId === 'a' ? COVER : null),
      resolve: async () => { queries += 1; return OTHER_COVER; },
    },
    artworkBackfillDelayMs: 0,
  });
  await host.ready;
  await host.backfillArtwork();
  assert.equal(queries, 1, 'only the unknown cover may hit the provider');
  assert.equal(host.snapshot().queue[0].artwork, COVER);
  assert.equal(host.snapshot().queue[1].artwork, OTHER_COVER);
  await host.stop();
});

test('an unresolvable cover leaves the occurrence untouched and produces no visible error', async () => {
  const state = legacyState(['a']);
  const errors = [];
  const host = new PlaybackRuntimeHost({
    persistence: { async load() { return state; } },
    artwork: { peek: () => null, resolve: async () => { throw new Error('network down'); } },
    artworkBackfillDelayMs: 0,
    onError: (error, context) => errors.push([error.message, context?.type]),
  });
  await host.ready;
  const result = await host.backfillArtwork();
  assert.equal(result.repaired, 0);
  assert.equal(host.snapshot().queue[0].artwork, null);
  assert.deepEqual(errors, []);
  await host.stop();
});

test('a host without an artwork dependency keeps the legacy behaviour', async () => {
  const state = legacyState(['a']);
  const host = new PlaybackRuntimeHost({ persistence: { async load() { return state; } }, artworkBackfillDelayMs: 0 });
  await host.ready;
  assert.deepEqual(await host.backfillArtwork(), { repaired: 0, checked: 0 });
  assert.equal(host.snapshot().queue[0].artwork, null);
  await host.stop();
});

test('backfillArtwork batches concurrent repairs to minimize version bumps and drops repairs if session switched', async () => {
  const state = legacyState(['a', 'b', 'c']);
  const initialVersion = state.version;
  const host = new PlaybackRuntimeHost({
    persistence: { async load() { return state; } },
    artwork: {
      peek: () => null,
      resolve: async () => COVER,
    },
    artworkBackfillDelayMs: 60_000,
    artworkBackfillConcurrency: 3,
  });
  await host.ready;
  const result = await host.backfillArtwork();
  assert.equal(result.repaired, 3);
  assert.equal(host.snapshot().version, initialVersion + 1, '同波封面修补合并成 1 次提交');
  assert.deepEqual(host.snapshot().queue.map(item => item.artwork), [COVER, COVER, COVER]);
  await host.stop();

  const switchedState = legacyState(['x', 'y']);
  const resolvers = [];
  const switchHost = new PlaybackRuntimeHost({
    persistence: { async load() { return switchedState; } },
    artwork: {
      peek: () => null,
      resolve: () => new Promise(resolve => { resolvers.push(() => resolve(COVER)); }),
    },
    artworkBackfillDelayMs: 60_000,
  });
  await switchHost.ready;
  const inflight = switchHost.backfillArtwork();
  for (let i = 0; i < 10 && resolvers.length < 2; i += 1) await new Promise(resolve => setImmediate(resolve));
  const switched = await switchHost.submit({
    type: PlaybackEventType.LISTENING_SESSION_SWITCH_REQUESTED,
    eventId: 'switch-session-mid-artwork',
    listeningSessionId: 'conversation:other',
  });
  assert.equal(switched.accepted, true, switched.reason);
  resolvers.forEach(fn => fn());
  const switchedResult = await inflight;
  assert.equal(switchedResult.repaired, 0, '切走会话后过期封面不得写回');
  await switchHost.stop();
});

test('snapshot() returns the same frozen reference without cloning and rejects mutations', async t => {
  const host = new PlaybackRuntimeHost();
  t.after(() => host.stop());
  await host.submit(commitEvent('snap-commit', [track('a')]));

  const first = host.snapshot();
  const second = host.snapshot();
  assert.equal(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.queue), true);
  assert.equal(Object.isFrozen(first.queue[0]), true);
  assert.throws(() => { first.phase = 'mutated'; }, TypeError);
  assert.throws(() => { first.queue.push({}); }, TypeError);
});

test('invalidatePreparedNarrations and invalidateAllPreparedNarrations skip saves/broadcasts when nothing is prepared, yield between sessions, and cancel speaking current track when requested', async t => {
  const saves = [];
  const snapshots = [];
  const commands = [];
  const order = [];
  const host = new PlaybackRuntimeHost({
    persistence: {
      async load() { return null; },
      async save(snapshot) {
        saves.push(snapshot.version);
        order.push(`save:${snapshot.version}`);
      },
    },
    commandSink: async command => { commands.push(command); },
  });
  t.after(() => host.stop());
  host.subscribe(snapshot => snapshots.push(snapshot));

  // 1. 已播完/无待播串词（含已 spoken 的当前曲与挂起会话）：0 次持久化与 0 次广播。
  const spokenTrack = (songId, text = `Line ${songId}`) => ({
    songId,
    programId: 'program',
    requestId: 'request',
    title: `Title ${songId}`,
    artist: `Artist ${songId}`,
    url: `/${songId}.mp3`,
    duration: 200,
    narration: { status: 'ready', assetStatus: 'ready', text, ttsUrl: `/${songId}-tts.mp3`, spoken: true, generationRevision: 1 },
  });
  const silentTrack = songId => ({
    songId,
    programId: 'program',
    requestId: 'request',
    title: `Title ${songId}`,
    artist: `Artist ${songId}`,
    url: `/${songId}.mp3`,
    duration: 200,
    narration: { status: 'absent', assetStatus: 'missing', generationRevision: 1 },
  });

  const sessionCommit = (eventId, listeningSessionId, tracks) => ({
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId,
    listeningSessionId,
    delivery: 'replace_now',
    source: 'user',
    tracks,
  });

  await host.submit({
    type: PlaybackEventType.COMPANION_MODE_CHANGED,
    eventId: 'mode-a',
    listeningSessionId: 'conversation:a',
    modeId: 'conversational',
    requestId: 'mode-a',
  });
  await host.submit(sessionCommit('commit-spoken-a', 'conversation:a', [spokenTrack('a1'), silentTrack('a2')]));
  await host.submit(sessionCommit('commit-spoken-b', 'conversation:b', [spokenTrack('b1')]));
  // 让 b1 进入 playing（narrationDelivery 为 delivered，spoken: true）
  let state = host.snapshot();
  await host.submit({
    type: PlaybackEventType.TRACK_STARTED,
    eventId: 'b1-started',
    runtimeVersion: state.version,
    songId: 'b1',
    programId: 'program',
    correlationId: state.txn.correlationId,
    listeningSessionId: 'conversation:b',
    outputGeneration: state.outputGeneration,
  });

  saves.length = 0;
  snapshots.length = 0;
  commands.length = 0;

  const singleSkipped = await host.invalidatePreparedNarrations('conversation:a', { includeCurrent: true });
  assert.equal(singleSkipped.accepted, false);
  const activeSkipped = await host.invalidatePreparedNarrations('conversation:b', { includeCurrent: true });
  assert.equal(activeSkipped.accepted, false);
  const allSkipped = await host.invalidateAllPreparedNarrations({ includeCurrent: true });
  assert.deepEqual(allSkipped, []);
  assert.equal(saves.length, 0);
  assert.equal(snapshots.length, 0);
  assert.equal(host.snapshot().queue[0].narration.spoken, true);
  assert.equal(host.snapshot().suspendedSessions['conversation:a'].queue[0].narration.spoken, true);

  // 2. 多会话存在 ready / preparing 串词，且活动会话正在 speaking：仅失效匹配会话、会话间通过 setImmediate 让出、并取消正在说出口的串词。
  const readyUnspoken = songId => ({
    songId,
    programId: 'program',
    requestId: 'request',
    title: `Title ${songId}`,
    artist: `Artist ${songId}`,
    url: `/${songId}.mp3`,
    duration: 200,
    narration: { status: 'ready', assetStatus: 'ready', text: `Ready ${songId}`, ttsUrl: `/${songId}-tts.mp3`, spoken: false, generationRevision: 1 },
  });
  const preparingTrack = songId => ({
    songId,
    programId: 'program',
    requestId: 'request',
    title: `Title ${songId}`,
    artist: `Artist ${songId}`,
    url: `/${songId}.mp3`,
    duration: 200,
    narration: { status: 'preparing', assetStatus: 'missing', generationRevision: 1 },
  });

  // 会话 c 无串词（应被跳过）
  await host.submit(sessionCommit('commit-c', 'conversation:c', [silentTrack('c1')]));
  // 会话 a 挂起但有待播串词 a-next
  await host.submit(sessionCommit('commit-a-ready', 'conversation:a', [silentTrack('a-cur'), readyUnspoken('a-next')]));
  // 切到会话 b 并让当前曲处于 speaking 状态，同时下一首处于 preparing 状态
  await host.submit({
    type: PlaybackEventType.COMPANION_MODE_CHANGED,
    eventId: 'mode-b',
    listeningSessionId: 'conversation:b',
    modeId: 'conversational',
    requestId: 'mode-b',
  });
  await host.submit(sessionCommit('commit-b-speaking', 'conversation:b', [readyUnspoken('b-cur'), preparingTrack('b-next')]));
  state = host.snapshot();
  await host.submit({
    type: PlaybackEventType.TRACK_NARRATION_ASSET_READY,
    eventId: 'b-cur-asset-ready',
    queueItemId: state.queue[0].queueItemId,
    songId: 'b-cur',
    programId: 'program',
    generationRevision: state.queue[0].narration.generationRevision,
    listeningSessionId: 'conversation:b',
    ttsUrl: '/b-cur-tts.mp3',
  });
  state = host.snapshot();
  await host.submit({
    type: PlaybackEventType.TRACK_STARTED,
    eventId: 'b-cur-started',
    runtimeVersion: state.version,
    songId: 'b-cur',
    programId: 'program',
    correlationId: state.txn.correlationId,
    listeningSessionId: 'conversation:b',
    outputGeneration: state.outputGeneration,
  });
  state = host.snapshot();
  await host.submit({
    type: PlaybackEventType.NARRATION_WINDOW_OPENED,
    eventId: 'b-cur-win',
    runtimeVersion: state.version,
    queueItemId: state.txn.queueItemId,
    songId: 'b-cur',
    programId: 'program',
    correlationId: state.txn.correlationId,
    listeningSessionId: 'conversation:b',
    outputGeneration: state.outputGeneration,
    positionSeconds: 2,
    durationSeconds: 200,
  });
  state = host.snapshot();
  await host.submit({
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'b-cur-del-start',
    runtimeVersion: state.version,
    queueItemId: state.txn.queueItemId,
    songId: 'b-cur',
    programId: 'program',
    correlationId: state.txn.correlationId,
    listeningSessionId: 'conversation:b',
    outputGeneration: state.outputGeneration,
    positionSeconds: 2,
    durationSeconds: 200,
  });
  state = host.snapshot();
  await host.submit({
    type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    eventId: 'b-cur-audible',
    runtimeVersion: state.version,
    queueItemId: state.txn.queueItemId,
    songId: 'b-cur',
    programId: 'program',
    correlationId: state.txn.correlationId,
    listeningSessionId: 'conversation:b',
    outputGeneration: state.outputGeneration,
    positionSeconds: 2.1,
    durationSeconds: 200,
  });
  assert.equal(host.snapshot().txn.narrationDelivery, 'speaking');

  saves.length = 0;
  snapshots.length = 0;
  commands.length = 0;
  order.length = 0;

  setImmediate(() => order.push('setImmediate-yielded'));
  const results = await host.invalidateAllPreparedNarrations({ includeCurrent: true });

  assert.equal(results.length, 2, '仅对有已准备/准备中串词的两个会话执行失效，跳过 conversation:c');
  assert.equal(saves.length, 2);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(order, [`save:${saves[0]}`, 'setImmediate-yielded', `save:${saves[1]}`]);
  assert.equal(commands.some(cmd => cmd.type === PlaybackCommandType.CANCEL_TRACK_NARRATION && cmd.songId === 'b-cur'), true);
  assert.equal(host.snapshot().txn.narrationDelivery, 'skipped');
  assert.equal(host.snapshot().queue[1].narration.status, 'absent');
  assert.equal(host.snapshot().suspendedSessions['conversation:a'].queue[1].narration.status, 'absent');
});
