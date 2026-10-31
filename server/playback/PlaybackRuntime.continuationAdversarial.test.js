import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlaybackRuntimeState,
  hydratePlaybackRuntimeState,
  reducePlayback,
  resumeEffectsForState,
} from './PlaybackRuntime.js';
import {
  PlaybackCommandType,
  PlaybackEffectType,
  PlaybackEventType,
  PlaybackPhase,
} from './playbackRuntimeTypes.js';

// Adversarial continuation coverage: every test here replays a hostile or
// racing client against the continuation boundary — duplicated ends, delayed
// commits, toggle flips mid-flight, superseded failures, exhausted retries —
// and asserts the fail-closed guarantees of the auto-continue spec.

function track(songId, overrides = {}) {
  return {
    songId,
    programId: overrides.programId || 'program-a',
    requestId: overrides.requestId || 'request-a',
    title: overrides.title || `Title ${songId}`,
    artist: overrides.artist || `Artist ${songId}`,
    url: overrides.url || `/${songId}.mp3`,
    duration: overrides.duration || 200,
  };
}

function commit(state, tracks, overrides = {}) {
  return reducePlayback(state, {
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: overrides.eventId || `commit-${state.version}`,
    delivery: overrides.delivery || 'replace_now',
    source: overrides.source || 'user',
    continuationBoundaryKey: overrides.continuationBoundaryKey,
    listeningPlan: overrides.listeningPlan,
    listeningSessionId: overrides.listeningSessionId,
    tracks,
  }, { nowMs: overrides.nowMs ?? 1_000 });
}

function finishActivation(result, eventPrefix = 'activation') {
  const state = result.state;
  const started = reducePlayback(state, {
    type: PlaybackEventType.TRACK_STARTED,
    eventId: `${eventPrefix}-started`, runtimeVersion: state.version,
    songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
    queueItemId: state.txn.queueItemId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  }, { nowMs: Math.max(Date.now(), state.txn.activatedAtMs || 0) + 2_000 });
  assert.equal(started.accepted, true, started.reason);
  assert.equal(started.state.phase, PlaybackPhase.PLAYING);
  return started.state;
}

function mediaIdentity(state) {
  const active = state.txn || {};
  const item = state.queue[state.currentIndex] || {};
  return {
    songId: state.currentSongId,
    programId: active.programId || item.programId,
    correlationId: active.correlationId || null,
    queueItemId: active.queueItemId || item.queueItemId,
    listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  };
}

function naturalEnd(state, eventPrefix = 'ended') {
  return reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: `${eventPrefix}-${state.version}`,
    runtimeVersion: state.version,
    ...mediaIdentity(state),
    natural: true,
    deliveredDuration: 200,
  });
}

function radioMode(state, enabled, eventPrefix = 'radio') {
  return reducePlayback(state, {
    type: PlaybackEventType.RADIO_MODE_CHANGED,
    eventId: `${eventPrefix}-${state.version}-${enabled}`,
    enabled,
  });
}

function continuationEffects(result) {
  return result.effects.filter(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION);
}

function continuationFailed(state, boundaryKey, eventPrefix = 'continuation-failed') {
  return reducePlayback(state, {
    type: PlaybackEventType.CONTINUATION_FAILED,
    eventId: `${eventPrefix}-${state.version}-${boundaryKey}`,
    boundaryKey,
    listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
    error: 'selection unavailable',
  });
}

function exhaustedRadioSession() {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'exhaust');
  const identity = mediaIdentity(playing);
  const ended = naturalEnd(playing, 'exhaust-end');
  assert.equal(ended.accepted, true, ended.reason);
  assert.equal(ended.state.phase, PlaybackPhase.EXHAUSTED);
  assert.equal(ended.state.pendingContinuation.status, 'requested');
  return { state: ended.state, identity };
}

test('disabling radio cancels the pending boundary and rejects its delayed commit', () => {
  const { state, identity } = exhaustedRadioSession();
  const boundaryKey = state.pendingContinuation.boundaryKey;

  const off = radioMode(state, false, 'radio-off');
  assert.equal(off.state.radioMode, false);
  assert.equal(off.state.pendingContinuation, null);
  assert.equal(continuationEffects(off).length, 0);

  const lateCommit = commit(off.state, [track('late')], {
    eventId: 'late-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: boundaryKey,
  });
  assert.equal(lateCommit.accepted, false);
  assert.equal(lateCommit.reason, 'stale continuation boundary');
  assert.equal(lateCommit.state.queue.length, 1);
  assert.equal(lateCommit.state.phase, PlaybackPhase.EXHAUSTED);
  assert.equal(continuationEffects(lateCommit).length, 0);

  const duplicateEnd = reducePlayback(off.state, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'late-end-after-off',
    runtimeVersion: off.state.version,
    ...identity,
    natural: true,
    deliveredDuration: 200,
  });
  assert.equal(duplicateEnd.accepted, false);
  assert.equal(duplicateEnd.state.pendingContinuation, null);
});

test('re-enabling radio opens a new boundary; the superseded boundary stays rejected', () => {
  const { state } = exhaustedRadioSession();
  const staleKey = state.pendingContinuation.boundaryKey;
  const off = radioMode(state, false, 'cycle-off');
  const on = radioMode(off.state, true, 'cycle-on');

  assert.equal(on.accepted, true, on.reason);
  assert.equal(on.state.radioMode, true);
  assert.equal(continuationEffects(on).length, 1);

  const requested = on.state.pendingContinuation;
  assert.equal(requested.status, 'requested');
  assert.equal(requested.attempts, 1);
  assert.notEqual(requested.boundaryKey, staleKey);

  const staleCommit = commit(on.state, [track('stale')], {
    eventId: 'stale-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: staleKey,
  });
  assert.equal(staleCommit.accepted, false);
  assert.equal(staleCommit.reason, 'stale continuation boundary');

  const freshCommit = commit(on.state, [track('fresh')], {
    eventId: 'fresh-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: requested.boundaryKey,
  });
  assert.equal(freshCommit.accepted, true, freshCommit.reason);
  assert.equal(freshCommit.state.phase, PlaybackPhase.LOADING);
  assert.equal(freshCommit.state.currentSongId, 'fresh');
  assert.equal(freshCommit.state.txn.reason, 'auto_continue');
  // 旧边界在激活时被消费；激活队列尾部新歌会立刻滚动预取下一个边界。
  assert.equal(freshCommit.state.pendingContinuation?.status, 'requested');
  assert.notEqual(freshCommit.state.pendingContinuation?.boundaryKey, requested.boundaryKey);
  assert.ok(freshCommit.commands.some(command => command.type === PlaybackCommandType.PLAY_TRACK));

  const duplicateCommit = commit(freshCommit.state, [track('again')], {
    eventId: 'duplicate-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: requested.boundaryKey,
  });
  assert.equal(duplicateCommit.accepted, false);
  assert.equal(duplicateCommit.reason, 'stale continuation boundary');
  assert.equal(duplicateCommit.state.queue.filter(item => item.songId === 'again').length, 0);
});

test('a duplicate natural end for the same exhaustion creates no second continuation effect', () => {
  const { state, identity } = exhaustedRadioSession();
  const boundaryKey = state.pendingContinuation.boundaryKey;

  const duplicate = reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'duplicate-end',
    runtimeVersion: state.version,
    ...identity,
    natural: true,
    deliveredDuration: 200,
  });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'stale media identity');
  assert.equal(continuationEffects(duplicate).length, 0);
  assert.equal(duplicate.state.pendingContinuation.status, 'requested');
  assert.equal(duplicate.state.pendingContinuation.boundaryKey, boundaryKey);
  assert.equal(duplicate.state.pendingContinuation.attempts, 1);
});

test('a continuation failure for a superseded boundary cannot poison the live request', () => {
  const { state } = exhaustedRadioSession();
  const firstKey = state.pendingContinuation.boundaryKey;

  const failed = continuationFailed(state, firstKey, 'first-failure');
  assert.equal(failed.state.pendingContinuation.status, 'failed');
  assert.equal(failed.state.lastError.type, 'continuation-failed');

  const retried = reducePlayback(failed.state, {
    type: PlaybackEventType.RESUME_REQUESTED,
    eventId: 'manual-resume-retry',
    runtimeVersion: failed.state.version,
  });
  assert.equal(retried.accepted, true, retried.reason);
  assert.equal(retried.state.pendingContinuation.status, 'requested');
  assert.notEqual(retried.state.pendingContinuation.boundaryKey, firstKey);
  assert.equal(continuationEffects(retried).length, 1);
  const liveKey = retried.state.pendingContinuation.boundaryKey;

  const lateFailure = continuationFailed(retried.state, firstKey, 'late-failure');
  assert.equal(lateFailure.state.pendingContinuation.status, 'requested');
  assert.equal(lateFailure.state.pendingContinuation.boundaryKey, liveKey);
  assert.equal(lateFailure.state.lastError, null);

  const liveFailure = continuationFailed(lateFailure.state, liveKey, 'live-failure');
  assert.equal(liveFailure.state.pendingContinuation.status, 'failed');
  assert.equal(liveFailure.state.lastError.message, 'selection unavailable');
});

test('after automatic attempts are exhausted only an explicit request starts a new boundary', () => {
  const { state } = exhaustedRadioSession();
  const originalKey = state.pendingContinuation.boundaryKey;

  let snapshot = state;
  for (let round = 0; round < 3; round += 1) {
    const failed = continuationFailed(snapshot, originalKey, `bounded-${round}`);
    assert.equal(failed.state.pendingContinuation.status, 'failed');
    snapshot = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(failed.state)));
  }
  assert.equal(snapshot.pendingContinuation.attempts, 3);
  assert.equal(resumeEffectsForState(snapshot)
    .filter(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION).length, 0);

  const retry = reducePlayback(snapshot, {
    type: PlaybackEventType.RETRY_REQUESTED,
    eventId: 'manual-retry-after-cap',
    runtimeVersion: snapshot.version,
  });
  assert.equal(retry.accepted, true, retry.reason);
  assert.equal(retry.state.pendingContinuation.status, 'requested');
  assert.notEqual(retry.state.pendingContinuation.boundaryKey, originalKey);
  assert.equal(retry.state.pendingContinuation.attempts, 1);
  assert.equal(continuationEffects(retry).length, 1);
});

test('radio-off exhaustion stays honestly exhausted until the listener re-enables radio', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'off-before');
  const off = radioMode(playing, false, 'off-before');
  assert.equal(off.state.radioMode, false);

  const ended = naturalEnd(off.state, 'off-end');
  assert.equal(ended.accepted, true, ended.reason);
  assert.equal(ended.state.phase, PlaybackPhase.EXHAUSTED);
  assert.equal(ended.state.pendingContinuation, null);
  assert.equal(continuationEffects(ended).length, 0);

  const resume = reducePlayback(ended.state, {
    type: PlaybackEventType.RESUME_REQUESTED,
    eventId: 'off-resume',
    runtimeVersion: ended.state.version,
  });
  assert.equal(resume.accepted, true, resume.reason);
  assert.equal(resume.state.phase, PlaybackPhase.EXHAUSTED);
  assert.equal(continuationEffects(resume).length, 0);
  assert.deepEqual(resume.commands, []);

  const on = radioMode(resume.state, true, 'off-then-on');
  assert.equal(on.state.radioMode, true);
  assert.equal(on.state.pendingContinuation.status, 'requested');
  assert.equal(continuationEffects(on).length, 1);
});

test('a plan with continueMode off exhausts without continuation, and the toggle still wins later', () => {
  const planOff = { request: { mode: 'discovery', delivery: 'replace_now', count: 2, continueMode: 'off' }, curatorId: 'radiohost' };
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')], { listeningPlan: planOff }), 'plan-off');
  assert.equal(playing.radioMode, false);

  const ended = naturalEnd(playing, 'plan-off-end');
  assert.equal(ended.accepted, true, ended.reason);
  assert.equal(ended.state.phase, PlaybackPhase.EXHAUSTED);
  assert.equal(ended.state.pendingContinuation, null);
  assert.equal(continuationEffects(ended).length, 0);

  const on = radioMode(ended.state, true, 'plan-off-toggle');
  assert.equal(on.state.pendingContinuation.status, 'requested');
  assert.equal(continuationEffects(on).length, 1);
});

test('a delayed continuation commit for a session the listener left cannot touch the active session', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'switch-away');
  const ended = naturalEnd(playing, 'switch-away-end');
  assert.equal(ended.state.pendingContinuation.status, 'requested');
  const staleKey = ended.state.pendingContinuation.boundaryKey;

  const switched = reducePlayback(ended.state, {
    type: PlaybackEventType.LISTENING_SESSION_SWITCH_REQUESTED,
    eventId: 'switch-to-other',
    listeningSessionId: 'conversation:other',
  });
  assert.equal(switched.accepted, true, switched.reason);
  assert.equal(switched.state.activeListeningSessionId, 'conversation:other');
  assert.equal(switched.state.pendingContinuation, null);

  const lateCommit = commit(switched.state, [track('trespass')], {
    eventId: 'trespass-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: staleKey,
    listeningSessionId: 'conversation:primary',
  });
  assert.equal(lateCommit.accepted, false);
  assert.equal(lateCommit.reason, 'inactive continuation');
  assert.deepEqual(lateCommit.state.queue, []);
  assert.equal(lateCommit.state.phase, PlaybackPhase.IDLE);
});
