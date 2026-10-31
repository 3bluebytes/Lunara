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
