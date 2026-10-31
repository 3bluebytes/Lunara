import assert from 'node:assert/strict';
import test from 'node:test';

// 聊天里的「下一首」针对的是用户发话时听到的那一首。模型思考期间队列已经
// 前进时，带着旧 occurrence 的跳过不得把后来激活的歌也跳掉。

import { createPlaybackRuntimeState, reducePlayback } from './PlaybackRuntime.js';
import { PlaybackEventType, PlaybackPhase } from './playbackRuntimeTypes.js';

function track(songId) {
  return { songId, programId: 'program-a', requestId: 'request-a', title: `Title ${songId}`,
    artist: `Artist ${songId}`, url: `/${songId}.mp3`, duration: 200 };
}

function identity(state) {
  return { songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
    queueItemId: state.txn.queueItemId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration };
}

function playing(tracks) {
  const committed = reducePlayback(createPlaybackRuntimeState({ companionModeId: null }), {
    type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'target-commit', delivery: 'replace_now', source: 'user', tracks,
  }, { nowMs: 1_000 });
  return reducePlayback(committed.state, { type: PlaybackEventType.TRACK_STARTED, eventId: 'target-started',
    runtimeVersion: committed.state.version, ...identity(committed.state) }, { nowMs: 2_000 }).state;
}

test('a next request for an occurrence that already ended does not skip the one now playing', () => {
  const first = playing([track('a'), track('b'), track('c')]);
  const heardQueueItemId = first.txn.queueItemId;
  const ended = reducePlayback(first, { type: PlaybackEventType.TRACK_ENDED, eventId: 'target-ended', natural: true,
    runtimeVersion: first.version, ...identity(first) }, { nowMs: 3_000 });
  assert.equal(ended.state.currentSongId, 'b');

  const stale = reducePlayback(ended.state, { type: PlaybackEventType.NEXT_REQUESTED, eventId: 'target-next-stale',
    listeningSessionId: ended.state.activeListeningSessionId, runtimeVersion: ended.state.version,
    queueItemId: heardQueueItemId }, { nowMs: 4_000 });
  assert.equal(stale.accepted, false);
  assert.match(stale.reason, /non-current occurrence/u);
  assert.equal(stale.state.currentSongId, 'b');

  const current = reducePlayback(ended.state, { type: PlaybackEventType.NEXT_REQUESTED, eventId: 'target-next-current',
    listeningSessionId: ended.state.activeListeningSessionId, runtimeVersion: ended.state.version,
    queueItemId: ended.state.txn.queueItemId }, { nowMs: 4_000 });
  assert.equal(current.accepted, true);
  assert.equal(current.state.currentSongId, 'c');
  assert.equal(current.state.phase, PlaybackPhase.LOADING);
});
