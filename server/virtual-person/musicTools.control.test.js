import assert from 'node:assert/strict';
import test from 'node:test';

import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { registerMusicTools } from './musicTools.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';

test('resume control returns a terminal natural acknowledgement for an exhausted listening session', async () => {
  const submitted = [];
  const state = {
    version: 18, outputGeneration: 4, activeListeningSessionId: 'conversation:a',
    currentSongId: 'song-a',
  };
  const service = {
    playbackRuntime: {
      snapshot: () => state,
      listeningSnapshot: () => ({ phase: 'exhausted', currentSongId: 'song-a', queue: [{ songId: 'song-a' }],
        pendingContinuation: { status: 'requested' } }),
      async submit(event) { submitted.push(event); return { accepted: true, commands: [], effects: [{ type: 'REQUEST_CONTINUATION' }] }; },
    },
    mutate: async (_context, run) => run(() => {}),
  };
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => service);

  const outcome = await registry.execute('control_listening', { action: 'resume' }, {
    capabilities: [MUSIC_MUTATION_CAPABILITY], correlationId: 'request-a', requestId: 'request-a',
    sessionId: 'conversation:a', isCurrent: () => true,
  });

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].type, 'RESUME_REQUESTED');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.code, 'LISTENING_CONTROLLED');
  assert.equal(outcome.presentation.displayText, '好，我接着续上音乐。');
});

function controlService(listening, overrides = {}) {
  const submitted = [];
  const service = {
    playbackRuntime: {
      snapshot: () => ({ version: 7, outputGeneration: 2, activeListeningSessionId: 'conversation:a', currentSongId: 'song-last' }),
      listeningSnapshot: () => listening,
      async submit(event) { submitted.push(event); return { accepted: true, commands: [], effects: [] }; },
      ...overrides,
    },
    mutate: async (_context, run) => run(() => {}),
  };
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => service);
  return { registry, submitted };
}

const controlContext = {
  capabilities: [MUSIC_MUTATION_CAPABILITY], correlationId: 'request-next', requestId: 'request-next',
  sessionId: 'conversation:a', isCurrent: () => true,
};

test('next at the last track reports the follow-up selection when the runtime requested a continuation', async () => {
  const { registry, submitted } = controlService({
    phase: 'exhausted', queue: [{ songId: 'song-last' }], currentIndex: 0,
    pendingContinuation: { status: 'requested' },
  });
  const outcome = await registry.execute('control_listening', { action: 'next' }, controlContext);
  assert.equal(submitted[0].type, 'NEXT_REQUESTED');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.presentation.displayText, '好，这首跳过，我接着选几首新的。');
});

test('next at an exhausted boundary without continuation states the queue finished instead of claiming a switch', async () => {
  const { registry } = controlService({
    phase: 'exhausted', queue: [{ songId: 'song-last' }], currentIndex: 0,
    pendingContinuation: null,
  });
  const outcome = await registry.execute('control_listening', { action: 'next' }, controlContext);
  assert.equal(outcome.terminal, true);
  assert.match(outcome.presentation.displayText, /队列到这里放完了/u);
  assert.doesNotMatch(outcome.presentation.displayText, /下一首/u);
});

test('resume without possible continuation no longer claims the music continues', async () => {
  const { registry } = controlService({
    phase: 'exhausted', queue: [{ songId: 'song-last' }], currentIndex: 0,
    pendingContinuation: null,
  });
  const outcome = await registry.execute('control_listening', { action: 'resume' }, controlContext);
  assert.equal(outcome.terminal, true);
  assert.match(outcome.presentation.displayText, /队列到这里放完了/u);
  assert.doesNotMatch(outcome.presentation.displayText, /续上音乐/u);
});

test('resume with a requested continuation still announces the follow-up music', async () => {
  const { registry, submitted } = controlService({
    phase: 'exhausted', queue: [{ songId: 'song-last' }], currentIndex: 0,
    pendingContinuation: { status: 'requested' },
  });
  const outcome = await registry.execute('control_listening', { action: 'resume' }, controlContext);
  assert.equal(submitted[0].type, 'RESUME_REQUESTED');
  assert.equal(outcome.presentation.displayText, '好，我接着续上音乐。');
});

function narrationService(overrides = {}) {
  const submitted = [];
  const playing = {
    activeListeningSessionId: 'conversation:a', runtimeVersion: 18, outputGeneration: 4,
    phase: 'playing', currentIndex: 0, currentSongId: 'song-a',
    txn: { correlationId: 'runtime-1-queue-a', queueItemId: 'queue-a' },
    queue: [{ queueItemId: 'queue-a', songId: 'song-a', programId: 'program-a', title: '歌 A', artist: '歌手 A' }],
    ...overrides,
  };
  const service = {
    playbackRuntime: {
      snapshot: () => playing,
      listeningSnapshot: () => playing,
      async submit(event) { submitted.push(event); return { accepted: true, commands: [], effects: [] }; },
    },
    mutate: async (_context, run) => run(() => {}),
  };
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => service);
  return { registry, submitted, playing };
}

const narrationContext = {
  capabilities: ['music'], correlationId: 'request-narrate', requestId: 'request-narrate',
  sessionId: 'conversation:a', isCurrent: () => true,
};

test('narrate_current_track asks the runtime for the playing occurrence without consuming a music action slot', async () => {
  const { registry, submitted } = narrationService();
  const outcome = await registry.execute('narrate_current_track', {}, narrationContext);

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].type, 'NARRATION_REQUESTED');
  assert.equal(submitted[0].queueItemId, 'queue-a');
  assert.equal(submitted[0].correlationId, 'runtime-1-queue-a');
  assert.equal(submitted[0].outputGeneration, 4);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.code, 'NARRATION_REQUESTED');
  assert.match(outcome.presentation.displayText, /我来说说这一首/u);
  assert.doesNotMatch(outcome.presentation.displayText, /确认之前|不要/u);
  assert.match(outcome.modelContext, /确认之前不要说已经讲过了/u);
});

test('failed music selection keeps the operation status model-only', async () => {
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => ({
    execute: async () => ({ ok: false, code: 'MUSIC_NOT_COMMITTED',
      message: '提交被拒绝：播放状态已经变化，本轮没有提交任何歌曲。' }),
    playbackRuntime: { listeningSnapshot: () => ({ phase: 'idle', queue: [], currentIndex: -1 }) },
  }));
  const outcome = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' },
    { capabilities: [MUSIC_CAPABILITY], correlationId: 'request-fail', sessionId: 'conversation:a', isCurrent: () => true });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'MUSIC_NOT_COMMITTED');
  assert.doesNotMatch(outcome.presentation.displayText, /播放状态已经变化|提交被拒绝/u);
  assert.match(outcome.presentation.displayText, /队列/u);
  assert.match(outcome.modelContext, /播放状态已经变化/u);
});

test('a punctuation-only follow-up can inspect state but cannot replay music actions', async () => {
  const calls = [];
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => ({
    execute: async () => { calls.push('select'); return { ok: true, code: 'MUSIC_COMMITTED' }; },
    mutate: async () => { calls.push('mutate'); return { ok: true }; },
    playbackRuntime: { listeningSnapshot: () => ({ phase: 'exhausted', queue: [], currentIndex: -1 }) },
  }));
  const context = { userText: '？', capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
    sessionId: 'conversation:a', requestId: 'question', isCurrent: () => true };
  const state = await registry.execute('get_listening_state', {}, context);
  const selection = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' }, context);
  const control = await registry.execute('control_listening', { action: 'retry' }, context);
  const feedback = await registry.execute('record_music_feedback', {
    songId: 'song-a', sentiment: 'dislike', sourceQuote: '？',
  }, context);
  assert.equal(state.ok, true);
  for (const outcome of [selection, control, feedback]) {
    assert.equal(outcome.code, 'NO_FRESH_MUSIC_REQUEST');
    assert.equal(outcome.ok, false);
    assert.match(outcome.presentation.displayText, /明确/u);
  }
  assert.deepEqual(calls, []);
});

test('narrate_current_track fails closed for another song, another session, or a track that is not playing', async () => {
  const other = narrationService();
  const wrongSong = await other.registry.execute('narrate_current_track', { queueItemId: 'queue-other' }, narrationContext);
  assert.equal(wrongSong.ok, false);
  assert.equal(other.submitted.length, 0);
  assert.match(wrongSong.presentation.displayText, /没在播/u);

  const elsewhere = narrationService({ activeListeningSessionId: 'conversation:b' });
  const wrongSession = await elsewhere.registry.execute('narrate_current_track', {}, narrationContext);
  assert.equal(wrongSession.ok, false);
  assert.equal(elsewhere.submitted.length, 0);

  const paused = narrationService({ phase: 'paused' });
  const notPlaying = await paused.registry.execute('narrate_current_track', {}, narrationContext);
  assert.equal(notPlaying.ok, false);
  assert.equal(paused.submitted.length, 0);
  assert.match(notPlaying.presentation.displayText, /真正开始播放/u);
});

function identityService({ activeListeningSessionId = 'conversation:a', currentQueueItemId = 'q-b', currentSongId = 'song-b' } = {}) {
  const submitted = [];
  const state = { version: 9, outputGeneration: 3, activeListeningSessionId, currentSongId, currentIndex: 1,
    queue: [{ songId: 'song-a', queueItemId: 'q-a', title: 'A' }, { songId: currentSongId, queueItemId: currentQueueItemId, title: 'B' }],
    txn: { queueItemId: currentQueueItemId } };
  const service = {
    playbackRuntime: {
      snapshot: () => state,
      listeningSnapshot: () => ({ phase: 'playing', currentIndex: 1, queue: state.queue, currentSongId }),
      async submit(event) { submitted.push(event); return { accepted: true, commands: [], effects: [] }; },
    },
    mutate: async (_context, run) => run(() => {}),
  };
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => service);
  return { registry, submitted };
}

const heardA = { listeningSessionId: 'conversation:a', queueItemId: 'q-a', songId: 'song-a' };

for (const action of ['next', 'pause']) {
  test(`${action} for the song the listener heard fails closed once another song is playing`, async () => {
    const { registry, submitted } = identityService();
    const outcome = await registry.execute('control_listening', { action },
      { ...controlContext, clientState: { playbackIdentity: heardA } });
    assert.equal(submitted.length, 0);
    assert.equal(outcome.ok, false);
    assert.notEqual(outcome.terminal, true);
    assert.equal(outcome.code, 'LISTENING_TARGET_CHANGED');
    assert.match(outcome.modelContext, /现在在播的是《B》/u);
    assert.match(outcome.presentation.displayText, /《B》也要/u);
  });
}

test('next carries the heard occurrence so the runtime can reject a song change during commit', async () => {
  const { registry, submitted } = identityService({ currentQueueItemId: 'q-a', currentSongId: 'song-a' });
  const outcome = await registry.execute('control_listening', { action: 'next' },
    { ...controlContext, clientState: { playbackIdentity: heardA } });
  assert.equal(outcome.ok, true);
  assert.equal(submitted[0].type, 'NEXT_REQUESTED');
  assert.equal(submitted[0].queueItemId, 'q-a');
});

test('an identity from another chat or no identity at all keeps the current-song control', async () => {
  for (const clientState of [null, { playbackIdentity: { ...heardA, listeningSessionId: 'conversation:other' } }]) {
    const { registry, submitted } = identityService();
    const outcome = await registry.execute('control_listening', { action: 'next' }, { ...controlContext, clientState });
    assert.equal(outcome.ok, true);
    assert.equal(submitted[0].queueItemId, undefined);
  }
});
