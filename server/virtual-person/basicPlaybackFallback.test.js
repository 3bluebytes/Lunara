import assert from 'node:assert/strict';
import test from 'node:test';
import { tryBasicPlaybackFallback } from './basicPlaybackFallback.js';
import { MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';

function fixture({ text = '继续播放', phase = 'paused', receipt = null, next = true,
  active = true, errorCode = 'EMPTY_ASSISTANT_RESPONSE', owner = 'lunara' } = {}) {
  const calls = [];
  const queue = next ? [{ songId: 'a' }, { songId: 'b' }] : [{ songId: 'a' }];
  const service = {
    musicActionStatus: () => receipt,
    playbackRuntime: {
      snapshot: () => ({ activeListeningSessionId: active ? 'room' : 'other' }),
      listeningSnapshot: () => ({ active, phase, currentIndex: 0, queue, currentSongId: 'a' }),
    },
  };
  const toolRegistry = { async execute(name, args, context) {
    calls.push({ name, args, context });
    return { ok: true, terminal: true, code: 'LISTENING_CONTROLLED', presentation: { displayText: '好，继续播放。' } };
  } };
  const input = {
    error: { code: errorCode }, userText: text, sessionId: 'room', requestId: 'request',
    roundId: 'round', virtualPersonId: 'lunara', userTurnId: 'user-turn',
    groupAction: { ownerId: owner }, capabilities: [MUSIC_MUTATION_CAPABILITY],
    isCurrent: () => true,
  };
  return { calls, input, deps: { getMusicService: () => service, toolRegistry } };
}

test('fallback resumes a paused current occurrence after agent failure through the typed tool', async () => {
  const { calls, input, deps } = fixture();
  const result = await tryBasicPlaybackFallback(input, deps);
  assert.equal(result.finalText, '好，继续播放。');
  assert.equal(result.outcomes[0].code, 'LISTENING_CONTROLLED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'control_listening');
  assert.deepEqual(calls[0].args, { action: 'resume' });
  assert.equal(calls[0].context.requestId, 'request');
});

test('a malformed assistant response can use the same bounded basic fallback', async () => {
  const { calls, input, deps } = fixture({ errorCode: 'LLM_INVALID_RESPONSE' });
  assert.ok(await tryBasicPlaybackFallback(input, deps));
  assert.equal(calls.length, 1);
});

test('a model attempt timeout (LLM_TIMEOUT) can use the same bounded basic fallback', async () => {
  const { calls, input, deps } = fixture({ errorCode: 'LLM_TIMEOUT' });
  assert.ok(await tryBasicPlaybackFallback(input, deps));
  assert.equal(calls.length, 1);
});

test('fallback skips only to an already queued next item', async () => {
  const yes = fixture({ text: '切歌' });
  const heard = { listeningSessionId: 'room', queueItemId: 'q-a', songId: 'a' };
  assert.ok(await tryBasicPlaybackFallback({ ...yes.input, clientState: { playbackIdentity: heard } }, yes.deps));
  assert.equal(yes.calls[0].args.action, 'next');
  // 降级路径同样只对用户发话时听到的那一首动手。
  assert.deepEqual(yes.calls[0].context.clientState, { playbackIdentity: heard });
  const noNext = fixture({ text: '切歌', next: false });
  assert.equal(await tryBasicPlaybackFallback(noNext.input, noNext.deps), null);
  assert.equal(noNext.calls.length, 0);
});

test('fallback never interprets feedback, compound text, or ambiguous play state', async () => {
  for (const options of [
    { text: '陌生歌手少放些' },
    { text: '继续播放，顺便换首歌' },
    { text: '播放新歌' },
    { text: '播放', phase: 'idle' },
    { text: '继续播放', phase: 'exhausted' },
    { text: '继续播放', active: false },
  ]) {
    const { calls, input, deps } = fixture(options);
    assert.equal(await tryBasicPlaybackFallback(input, deps), null, JSON.stringify(options));
    assert.equal(calls.length, 0);
  }
});

test('fallback does not run on business failure, non-owner, cancellation, or a possible prior mutation', async () => {
  for (const options of [
    { errorCode: 'NO_MATCHING_CANDIDATES' },
    { owner: 'other' },
    { receipt: 'running' },
    { receipt: 'uncertain' },
    { receipt: 'committed' },
  ]) {
    const { calls, input, deps } = fixture(options);
    assert.equal(await tryBasicPlaybackFallback(input, deps), null, JSON.stringify(options));
    assert.equal(calls.length, 0);
  }
  const cancelled = fixture();
  cancelled.input.isCurrent = () => false;
  assert.equal(await tryBasicPlaybackFallback(cancelled.input, cancelled.deps), null);
});
