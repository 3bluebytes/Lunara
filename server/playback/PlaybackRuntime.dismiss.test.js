import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackRuntimeState, reducePlayback, hydratePlaybackRuntimeState } from './PlaybackRuntime.js';
import { PlaybackRuntimeHost } from './PlaybackRuntimeHost.js';
import { PlaybackOperationsService } from '../services/PlaybackOperationsService.js';

const song = (id, source = 'qq', occurrence = id) => ({ songId: id, source, queueItemId: occurrence,
  programId: 'program', requestId: 'request', title: id, artist: 'Artist', url: `/${occurrence}.wav` });
function fixture(items = [song('a'), song('b'), song('c')], options = {}) {
  return reducePlayback(createPlaybackRuntimeState({ radioMode: false, ...options }), {
    type: 'PROGRAM_COMMITTED', eventId: 'commit', delivery: 'replace_now', tracks: items,
  }).state;
}
function dismiss(state, changes = {}) {
  const item = state.queue[state.currentIndex];
  return { type: 'TRACK_DISMISS_REQUESTED', eventId: `dismiss:${state.activeListeningSessionId}:${item.queueItemId}`,
    runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, queueItemId: item.queueItemId, songId: item.songId,
    provider: item.source.split(':')[0], ...changes };
}

test('dismiss atomically removes canonical duplicates including history, keeps other providers and successor order', () => {
  let state = fixture([song('b', 'qq', 'old-b'), song('a'), song('b', 'qq', 'current-b'),
    song('b', 'qq', 'future-b'), song('c'), song('b', 'ncm', 'other-source')]);
  state = reducePlayback(state, { type: 'CARD_SELECTED', eventId: 'select-b', runtimeVersion: state.version,
    queueItemId: 'current-b' }).state;
  const result = reducePlayback(state, dismiss(state));
  assert.equal(result.accepted, true, result.reason);
  assert.deepEqual(result.state.queue.map(item => item.queueItemId), ['a', 'c', 'other-source']);
  assert.equal(result.state.currentSongId, 'c');
  assert.deepEqual(result.commands.map(command => command.type), ['STOP_PLAYBACK', 'PLAY_TRACK']);
  assert.equal(result.commands[1].queueItemId, 'c');
  const rewind = reducePlayback(result.state, { type: 'CARD_SELECTED', eventId: 'rewind', runtimeVersion: result.state.version,
    queueItemId: 'a' });
  const next = reducePlayback(rewind.state, { type: 'NEXT_REQUESTED', eventId: 'forward', runtimeVersion: rewind.state.version });
  assert.equal(next.state.currentSongId, 'c');
  const oldFact = reducePlayback(result.state, { ...dismiss(state), type: 'TRACK_ENDED', eventId: 'late-ended', natural: true,
    runtimeVersion: result.state.version, correlationId: state.txn.correlationId });
  assert.equal(oldFact.accepted, false);
  assert.equal(oldFact.state, result.state);
  assert.equal(hydratePlaybackRuntimeState(result.state).queue.some(item => item.queueItemId === 'current-b'), false);
});

test('dismiss rejects missing/stale identity, another source/session', () => {
  const state = fixture();
  for (const changes of [{ queueItemId: 'b' }, { provider: 'ncm' }, { songId: 'b' },
    { listeningSessionId: 'other' }, { outputGeneration: state.outputGeneration + 1 },
    { runtimeVersion: state.version - 1 }, { queueItemId: null }, { provider: '' }, { listeningSessionId: null }, { outputGeneration: undefined }]) {
    const result = reducePlayback(state, dismiss(state, changes));
    assert.equal(result.accepted, false, JSON.stringify(changes));
    assert.equal(result.state, state);
  }
});

test('tail or single-song dismissal stops output and respects continuation policy', () => {
  for (const radioMode of [false, true]) {
    const state = fixture([song('a')], { radioMode });
    const result = reducePlayback(state, dismiss(state));
    assert.equal(result.accepted, true, result.reason);
    assert.deepEqual(result.state.queue, []);
    assert.equal(result.state.currentIndex, -1);
    assert.equal(result.state.txn, null);
    assert.equal(result.state.phase, 'exhausted');
    assert.deepEqual(result.commands.map(command => command.type), ['STOP_PLAYBACK']);
    assert.equal(result.effects.some(effect => effect.type === 'REQUEST_CONTINUATION'), radioMode);
  }
  let state = fixture();
  state = reducePlayback(state, { type: 'CARD_SELECTED', eventId: 'tail', runtimeVersion: state.version, queueItemId: 'c' }).state;
  const result = reducePlayback(state, dismiss(state));
  assert.deepEqual(result.state.queue.map(item => item.songId), ['a', 'b']);
  assert.equal(result.state.phase, 'exhausted');
  assert.equal(result.commands.some(command => command.type === 'PLAY_TRACK'), false);
});

test('persistence failure does not publish dismissal or remove tracks', async () => {
  const state = fixture();
  const commands = [];
  const host = new PlaybackRuntimeHost({ initialState: state,
    persistence: { save: () => { throw new Error('disk failure'); } }, commandSink: command => commands.push(command) });
  try {
    await host.ready;
    const before = host.snapshot();
    const result = await host.submit(dismiss(before));
    assert.equal(result.accepted, false);
    assert.deepEqual(host.snapshot(), before);
    assert.deepEqual(commands, []);
  } finally { await host.stop(); }
});

test('wire retries return authoritative state without replay and removal survives host persistence', async () => {
  let saved;
  const host = new PlaybackRuntimeHost({ initialState: fixture(), persistence: { save: state => { saved = state; } } });
  const service = new PlaybackOperationsService({ playbackRuntime: host });
  try {
    const event = dismiss(host.snapshot());
    const first = await service.dispatch(event);
    assert.equal(first.ok, true);
    const retry = await service.dispatch(event);
    assert.equal(retry.ok, true);
    assert.equal(retry.idempotent, true);
    assert.deepEqual(retry.commands, []);
    assert.equal(retry.state.currentSongId, 'b');
    const restored = new PlaybackRuntimeHost({ initialState: saved });
    try { assert.deepEqual(restored.snapshot().queue.map(item => item.songId), ['b', 'c']); }
    finally { await restored.stop(); }
  } finally { await host.stop(); }
});
