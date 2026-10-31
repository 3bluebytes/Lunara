import assert from 'node:assert/strict';
import test from 'node:test';

// A natural TRACK_ENDED whose POST is delayed behind the listener's
// PAUSE_REQUESTED must not start output or a continuation. The listener's
// latest decision is the pause; the runtime advances the cursor and waits for
// the listener to resume by their own hand.

import {
  createPlaybackRuntimeState,
  reducePlayback,
} from './PlaybackRuntime.js';
import {
  PlaybackCommandType,
  PlaybackEffectType,
  PlaybackEventType,
  PlaybackPhase,
} from './playbackRuntimeTypes.js';

function track(songId) {
  return { songId, programId: 'program-a', requestId: 'request-a', title: `Title ${songId}`,
    artist: `Artist ${songId}`, url: `/${songId}.mp3`, duration: 200 };
}

function identity(state) {
  return {
    songId: state.currentSongId,
    programId: state.txn.programId,
    correlationId: state.txn.correlationId,
    queueItemId: state.txn.queueItemId,
    listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  };
}

function playingSession(tracks) {
  const committed = reducePlayback(createPlaybackRuntimeState({ companionModeId: null }), {
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'pause-race-commit', delivery: 'replace_now', source: 'user', tracks,
  }, { nowMs: 1_000 });
  const started = reducePlayback(committed.state, {
    type: PlaybackEventType.TRACK_STARTED,
    eventId: 'pause-race-started', runtimeVersion: committed.state.version,
    ...identity(committed.state),
  }, { nowMs: 2_000 });
  assert.equal(started.state.phase, PlaybackPhase.PLAYING);
  return started.state;
}

function pause(state, positionSeconds) {
  const paused = reducePlayback(state, {
    type: PlaybackEventType.PAUSE_REQUESTED,
    eventId: `pause-race-pause-${state.version}`, runtimeVersion: state.version,
    ...identity(state), positionSeconds,
  }, { nowMs: 3_000 });
  assert.equal(paused.state.phase, PlaybackPhase.PAUSED);
  return paused.state;
}

function lateNaturalEnd(state, endedIdentity) {
  return reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: `pause-race-late-ended-${state.version}`, runtimeVersion: state.version,
    ...endedIdentity, natural: true, deliveredDuration: 200,
  }, { nowMs: 3_500 });
}

test('a late natural end while paused advances the cursor without starting output', () => {
  const state = playingSession([track('one'), track('two')]);
  const endedIdentity = identity(state);
  const paused = pause(state, 10);

  const lateEnded = lateNaturalEnd(paused, endedIdentity);
  assert.equal(lateEnded.accepted, true, lateEnded.reason);
  assert.deepEqual(
    lateEnded.commands.map(command => command.type).filter(type => type === PlaybackCommandType.PLAY_TRACK),
    [], 'paused session started output from a media fact');
  assert.equal(lateEnded.effects.filter(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION).length, 0);
  assert.equal(lateEnded.state.phase, PlaybackPhase.PAUSED);
  assert.equal(lateEnded.state.hasStarted, false);
  assert.equal(lateEnded.state.txn, null);
  assert.equal(lateEnded.state.positionSeconds, 0);
  // The ended track stays the logical predecessor, so the next introduction
  // knows what actually played before it.
  assert.equal(lateEnded.state.lastOutputTrack.songId, 'one');
  // The listener's own resume is what opens the next track.
  const resumed = reducePlayback(lateEnded.state, {
    type: PlaybackEventType.RESUME_REQUESTED,
    eventId: 'pause-race-resume', runtimeVersion: lateEnded.state.version,
    songId: lateEnded.state.currentSongId, programId: lateEnded.state.currentSongId && 'program-a',
    listeningSessionId: lateEnded.state.activeListeningSessionId,
    outputGeneration: lateEnded.state.outputGeneration,
  }, { nowMs: 4_000 });
  assert.equal(resumed.accepted, true, resumed.reason);
  assert.ok(resumed.commands.some(command => command.type === PlaybackCommandType.PLAY_TRACK
    && command.songId === 'two'));
});

test('a late natural end while paused must not request a continuation', () => {
  const state = playingSession([track('one')]);
  const endedIdentity = identity(state);
  const paused = pause(state, 190);

  const lateEnded = lateNaturalEnd(paused, endedIdentity);
  assert.equal(lateEnded.accepted, true, lateEnded.reason);
  assert.equal(lateEnded.effects.filter(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION).length, 0,
    'paused session requested a continuation on its own');
  // 激活时的提前续选边界仍在等待提交；迟到 end 只耗尽队列，不新增请求。
  assert.equal(lateEnded.state.pendingContinuation?.status, 'requested');
  assert.equal(lateEnded.state.phase, PlaybackPhase.EXHAUSTED);

  // Only the listener's explicit resume may open a continuation boundary.
  const resumed = reducePlayback(lateEnded.state, {
    type: PlaybackEventType.RESUME_REQUESTED,
    eventId: 'pause-race-resume-exhausted', runtimeVersion: lateEnded.state.version,
    listeningSessionId: lateEnded.state.activeListeningSessionId,
    outputGeneration: lateEnded.state.outputGeneration,
  }, { nowMs: 4_000 });
  assert.equal(resumed.accepted, true, resumed.reason);
  // 边界已在激活时提前开好：恢复播放不重建、不重复请求。
  assert.equal(resumed.effects.filter(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION).length, 0);
  assert.equal(resumed.state.pendingContinuation.status, 'requested');
});
