import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlaybackRuntimeState,
  hydratePlaybackRuntimeState,
  reducePlayback,
  resumeCommandsForState,
  resumeEffectsForState,
  MAX_CONTINUATION_ATTEMPTS,
} from './PlaybackRuntime.js';
import {
  PlaybackCommandType,
  PlaybackEffectType,
  PlaybackEventType,
  PlaybackPhase,
} from './playbackRuntimeTypes.js';

const { ListeningReflectionBridge } = await import('../station/ListeningReflectionBridge.js');

function track(songId, overrides = {}) {
  return {
    songId,
    programId: overrides.programId || 'program-a',
    requestId: overrides.requestId || 'request-a',
    title: overrides.title || `Title ${songId}`,
    artist: overrides.artist || `Artist ${songId}`,
    url: overrides.url || `/${songId}.mp3`,
    duration: overrides.duration || 200,
    intro: overrides.intro === null
      ? { text: `Intro ${songId}` }
      : (overrides.intro || { text: `Intro ${songId}`, url: `/${songId}-tts.mp3` }),
  };
}

function commit(state, tracks, overrides = {}) {
  return reducePlayback(state, {
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: overrides.eventId || `commit-${state.version}`,
    delivery: overrides.delivery || 'replace_now',
    source: overrides.source || 'user',
    continuationBoundaryKey: overrides.continuationBoundaryKey,
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

function narrationIdentity(state, type, eventId, overrides = {}) {
  const track = state.queue.find(item => item.queueItemId === (overrides.queueItemId || state.txn?.queueItemId));
  return {
    type,
    eventId,
    runtimeVersion: state.version,
    queueItemId: track.queueItemId,
    songId: track.songId,
    programId: track.programId,
    generationRevision: track.narration.generationRevision,
    correlationId: state.txn?.correlationId || 'old-correlation',
    listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
    ...overrides,
  };
}

function narrationContextTrack(songId, overrides = {}) {
  return track(songId, {
    ...overrides,
    intro: { text: `Narration ${songId}`, context: { transition: 'next' } },
  });
}

test('initial activation starts the committed track immediately and confirms playback', () => {
  const result = commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one'), track('two')]);
  assert.equal(result.state.currentSongId, 'one');
  assert.equal(result.state.phase, PlaybackPhase.LOADING);
  assert.deepEqual(result.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
  assert.equal(result.commands[0].songId, 'one');
  assert.equal(result.commands[0].queueItemId, result.state.queue[0].queueItemId);
  assert.equal(result.commands[0].correlationId, result.state.txn.correlationId);
  assert.equal(finishActivation(result).currentSongId, 'one');
});

test('manual next, natural next, and card selection use the same activation transaction', () => {
  let state = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one'), track('two'), track('three')]), 'initial');
  let result = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED,
    eventId: 'next-one', runtimeVersion: state.version, songId: 'one',
  });
  assert.equal(result.state.currentSongId, 'two');
  assert.equal(result.state.txn.reason, 'manual_next');
  state = finishActivation(result, 'manual');

  result = reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'ended-two', runtimeVersion: state.version, songId: 'two', natural: true, deliveredDuration: 200,
  });
  assert.equal(result.state.currentSongId, 'three');
  assert.equal(result.state.txn.reason, 'natural_next');
  state = finishActivation(result, 'natural');

  result = reducePlayback(state, {
    type: PlaybackEventType.CARD_SELECTED,
    eventId: 'card-one', runtimeVersion: state.version, songId: 'one',
  });
  assert.equal(result.state.currentSongId, 'one');
  assert.equal(result.state.txn.reason, 'card_selected');
});

test('immediate replacement atomically preserves history and activates the new first target', () => {
  let state = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('old-one'), track('old-two')]), 'old');
  state = finishActivation(reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'old-next', runtimeVersion: state.version, songId: 'old-one',
  }), 'old-two');
  const result = commit(state, [
    track('new-one', { programId: 'program-new', requestId: 'request-new' }),
    track('new-two', { programId: 'program-new', requestId: 'request-new' }),
  ], { eventId: 'replace-new' });

  assert.deepEqual(result.state.queue.map(item => item.songId), ['old-one', 'new-one', 'new-two']);
  assert.equal(result.state.currentSongId, 'new-one');
  assert.deepEqual(result.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
});

test('verified exhaustion requests one continuation and immediately activates its first committed track', () => {
  let state = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('last')]), 'last');
  const ended = reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'last-ended', runtimeVersion: state.version, songId: 'last', natural: true, deliveredDuration: 30,
  });
  assert.equal(ended.state.phase, PlaybackPhase.EXHAUSTED);
  // 单曲队列在激活时就提前发起续选；自然播完不重建边界，耗尽只是等同一个提交。
  const exhaustedBoundary = ended.state.pendingContinuation?.boundaryKey;
  assert.ok(exhaustedBoundary, '激活最后一首时已创建续选边界');
  assert.equal(ended.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), false);
  assert.equal(ended.state.diagnostics[0].type, 'duration-mismatch');

  const continued = commit(ended.state, [track('fresh', { programId: 'auto-program', requestId: 'auto-request' })], {
    eventId: 'auto-commit', delivery: 'append', source: 'auto_continue',
    continuationBoundaryKey: exhaustedBoundary,
  });
  assert.equal(continued.state.currentSongId, 'fresh');
  assert.deepEqual(continued.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
  assert.equal(continued.state.phase, PlaybackPhase.LOADING);
});

test('manual next at the last committed track requests the same continuation boundary as a natural end', () => {
  let state = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('last')]), 'manual-end');
  const skipped = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED,
    eventId: 'manual-end-next', runtimeVersion: state.version, songId: 'last',
  });
  assert.equal(skipped.state.phase, PlaybackPhase.EXHAUSTED);
  // 激活队尾最后一首时已提前续选；队尾手动跳过沿用同一边界，不重建。
  const manualBoundary = skipped.state.pendingContinuation?.boundaryKey;
  assert.ok(manualBoundary, '激活最后一首时已创建续选边界');
  assert.equal(skipped.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), false);

  const continued = commit(skipped.state, [track('fresh', { programId: 'auto-program', requestId: 'auto-request' })], {
    eventId: 'auto-commit-manual', delivery: 'append', source: 'auto_continue',
    continuationBoundaryKey: manualBoundary,
  });
  assert.equal(continued.state.currentSongId, 'fresh');
  assert.deepEqual(continued.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
  assert.equal(continued.state.phase, PlaybackPhase.LOADING);
});

test('look-ahead fires only when the margin drops to the threshold, and an accepted batch restores it', () => {
  const base = createPlaybackRuntimeState({ companionModeId: null });
  const fiveTracks = ['one', 'two', 'three', 'four', 'five'].map(songId => track(songId));
  // 激活第一首时后面还有 4 首，余量在提前量之上：不预取。
  const first = commit(base, fiveTracks);
  assert.equal(first.accepted, true, first.reason);
  assert.equal(first.state.currentSongId, 'one');
  assert.ok(!first.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), '余量 4 首时不预取');
  let state = finishActivation(first, 'first');

  // 换到第二、第三首：余量仍有 3、2 首，仍不预取。
  const second = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'lookahead-next-1', runtimeVersion: state.version, songId: 'one',
  });
  assert.equal(second.state.currentSongId, 'two');
  assert.ok(!second.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), '余量 3 首时不预取');
  state = finishActivation(second, 'second');
  const third = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'lookahead-next-2', runtimeVersion: state.version, songId: 'two',
  });
  assert.equal(third.state.currentSongId, 'three');
  assert.ok(!third.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), '余量 2 首时不预取');
  state = finishActivation(third, 'third');

  // 换到第四首：之后只剩 1 首（= 提前量），激活即提前续选；当前激活事务本身不被打断。
  const fourth = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'lookahead-next-3', runtimeVersion: state.version, songId: 'three',
  });
  assert.equal(fourth.state.currentSongId, 'four');
  assert.equal(fourth.state.phase, PlaybackPhase.LOADING);
  assert.deepEqual(fourth.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK], '预取不追加播放命令');
  const preRequest = fourth.effects.find(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION);
  assert.ok(preRequest, '余量降到提前量时激活即请求续选');
  assert.equal(preRequest.songId, 'four');
  state = finishActivation(fourth, 'fourth');

  // 提前续选提交：只追加队列，当前歌继续播。
  const appended = commit(state, ['fresh-a', 'fresh-b', 'fresh-c'].map(songId =>
    track(songId, { programId: 'auto-program', requestId: 'auto-request' })), {
    eventId: 'lookahead-commit', delivery: 'append', source: 'auto_continue',
    continuationBoundaryKey: state.pendingContinuation.boundaryKey,
  });
  assert.equal(appended.accepted, true, appended.reason);
  assert.equal(appended.state.currentSongId, 'four');
  assert.equal(appended.state.phase, PlaybackPhase.PLAYING);
  assert.deepEqual(appended.commands, [], '追加提交不发播放命令');
  assert.deepEqual(appended.state.queue.map(item => item.songId),
    ['one', 'two', 'three', 'four', 'five', 'fresh-a', 'fresh-b', 'fresh-c']);

  // 补进的 3 首把余量抬回提前量之上，因此接下来每一次换歌都不再触发，
  // 直到第三次换歌（fresh-b）时余量重新降到提前量。
  const afterFour = reducePlayback(appended.state, {
    type: PlaybackEventType.TRACK_ENDED, eventId: 'four-ended', runtimeVersion: appended.state.version,
    songId: 'four', natural: true, deliveredDuration: 200,
  });
  assert.equal(afterFour.state.currentSongId, 'five', '自然推进到原队列下一首，不是预取新歌');
  assert.ok(!afterFour.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), '补货后余量 3 首，不重复预取');
  state = finishActivation(afterFour, 'fifth');
  const afterFive = reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED, eventId: 'five-ended', runtimeVersion: state.version,
    songId: 'five', natural: true, deliveredDuration: 200,
  });
  assert.equal(afterFive.state.currentSongId, 'fresh-a');
  assert.ok(!afterFive.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), '余量 2 首时不预取');
  state = finishActivation(afterFive, 'fresh-a');
  const afterFreshA = reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED, eventId: 'fresh-a-ended', runtimeVersion: state.version,
    songId: 'fresh-a', natural: true, deliveredDuration: 200,
  });
  assert.equal(afterFreshA.state.currentSongId, 'fresh-b');
  assert.ok(afterFreshA.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION),
    '消费到本批末尾时余量重新降到提前量，滚动预取下一批');
});

test('look-ahead continuation is skipped when effective radio mode is off', () => {
  const off = createPlaybackRuntimeState({ companionModeId: null, radioMode: false });
  let result = commit(off, [track('one'), track('two'), track('three'), track('four')]);
  assert.ok(!result.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), 'radio 关闭时初始激活不预取');
  let state = finishActivation(result, 'off-first');
  result = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'off-next', runtimeVersion: state.version, songId: 'one',
  });
  assert.ok(!result.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), 'radio 关闭时不预取');
  assert.equal(result.state.pendingContinuation, null);
});

test('a look-ahead failure keeps the current track playing and retry re-requests it', () => {
  const base = createPlaybackRuntimeState({ companionModeId: null });
  const first = commit(base, [track('one'), track('two')]);
  // 两首队列激活 one 时只剩 1 首，立即预取。
  assert.ok(first.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), '小队列初始激活即提前续选');
  const state = finishActivation(first, 'fail-first');

  const failed = reducePlayback(state, {
    type: PlaybackEventType.CONTINUATION_FAILED, eventId: 'lookahead-failed',
    boundaryKey: state.pendingContinuation.boundaryKey,
  });
  assert.equal(failed.accepted, true, failed.reason);
  assert.equal(failed.state.phase, PlaybackPhase.PLAYING, '播放中的预取失败不打断当前歌');
  assert.equal(failed.state.pendingContinuation.status, 'failed');
  assert.equal(failed.state.lastError.type, 'continuation-failed');

  const retried = reducePlayback(failed.state, {
    type: PlaybackEventType.RETRY_REQUESTED, eventId: 'lookahead-retry', runtimeVersion: failed.state.version,
  });
  assert.equal(retried.accepted, true, retried.reason);
  assert.ok(retried.effects.some(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION), '重试重新发起续选');
  assert.equal(retried.state.pendingContinuation.status, 'requested');
  assert.equal(retried.state.phase, PlaybackPhase.PLAYING);
});

test('a look-ahead commit that arrives after the next activation is a stale boundary', () => {
  const base = createPlaybackRuntimeState({ companionModeId: null });
  const first = commit(base, [track('one'), track('two')]);
  const state = finishActivation(first, 'stale-first');
  const staleBoundary = state.pendingContinuation.boundaryKey;

  // 预选还没回来就换歌：激活清除旧边界；剩余 0 首立即发起新预取。
  const nexted = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'stale-next', runtimeVersion: state.version, songId: 'one',
  });
  const newBoundary = nexted.state.pendingContinuation?.boundaryKey;
  assert.ok(newBoundary && newBoundary !== staleBoundary, '换歌清除旧边界并发起新预取');

  const late = commit(nexted.state, [track('stale-auto', { programId: 'auto-program', requestId: 'auto-request' })], {
    eventId: 'late-lookahead-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: staleBoundary,
  });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'stale continuation boundary');
  assert.deepEqual(late.state.queue.map(item => item.songId), ['one', 'two']);

  const fresh = commit(nexted.state, [track('fresh', { programId: 'auto-program', requestId: 'auto-request' })], {
    eventId: 'fresh-lookahead-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: newBoundary,
  });
  assert.equal(fresh.accepted, true, fresh.reason);
  assert.equal(fresh.state.currentSongId, 'two', '追加不切换当前歌');
  assert.deepEqual(fresh.state.queue.map(item => item.songId), ['one', 'two', 'fresh']);
  assert.deepEqual(fresh.commands, []);
  assert.equal(fresh.state.pendingContinuation, null, '提交接受即消费边界');

  // 同一 boundary 的第二个不同 eventId 提交不得再次消费：不接受就不重复加歌。
  const replayed = commit(fresh.state, [track('again', { programId: 'auto-program', requestId: 'auto-request' })], {
    eventId: 'replayed-lookahead-commit', delivery: 'append', source: 'auto_continue', continuationBoundaryKey: newBoundary,
  });
  assert.equal(replayed.accepted, false);
  assert.equal(replayed.reason, 'stale continuation boundary');
  assert.deepEqual(replayed.state.queue.map(item => item.songId), ['one', 'two', 'fresh']);
});

test('manual next at the last committed track stays honestly exhausted when radio mode is off', () => {
  let state = createPlaybackRuntimeState({ companionModeId: null, radioMode: false });
  state = finishActivation(commit(state, [track('last')]), 'manual-end-off');
  const skipped = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED,
    eventId: 'manual-end-off-next', runtimeVersion: state.version, songId: 'last',
  });
  assert.equal(skipped.state.phase, PlaybackPhase.EXHAUSTED);
  assert.deepEqual(skipped.effects.map(effect => effect.type), [], 'radio 关闭时手动跳过队尾不请求续播');
});

test('a user replacement invalidates an in-flight automatic continuation commit', () => {
  let state = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('last')]), 'race-last');
  const ended = reducePlayback(state, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'race-ended', runtimeVersion: state.version,
    songId: 'last', natural: true, deliveredDuration: 200,
  });
  // 单曲队列激活时已提前续选；自然播完沿用同一个 in-flight 边界。
  const staleBoundary = ended.state.pendingContinuation.boundaryKey;
  const replaced = commit(ended.state, [
    track('user-target', { programId: 'user-program', requestId: 'user-request' }),
  ], { eventId: 'user-replacement', delivery: 'replace_now' });

  const lateContinuation = commit(replaced.state, [
    track('stale-auto', { programId: 'auto-program', requestId: `runtime-continuation:${staleBoundary}` }),
  ], {
    eventId: 'late-auto-commit', delivery: 'append', source: 'auto_continue',
    continuationBoundaryKey: staleBoundary,
  });

  assert.equal(lateContinuation.accepted, false);
  assert.equal(lateContinuation.reason, 'stale continuation boundary');
  assert.equal(lateContinuation.state.currentSongId, 'user-target');
  assert.deepEqual(lateContinuation.state.queue.map(item => item.songId), ['user-target']);
  assert.deepEqual(lateContinuation.commands, []);
});

test('duplicate next and ended events cannot double advance or request continuation twice', () => {
  let state = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one'), track('two')]), 'base');
  const event = { type: PlaybackEventType.NEXT_REQUESTED, eventId: 'same-next', runtimeVersion: state.version, songId: 'one' };
  const first = reducePlayback(state, event);
  const duplicate = reducePlayback(first.state, event);
  assert.equal(first.state.currentSongId, 'two');
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.state, first.state);

  state = finishActivation(first, 'second');
  const endedEvent = { type: PlaybackEventType.TRACK_ENDED, eventId: 'same-ended', runtimeVersion: state.version, songId: 'two', natural: true };
  const ended = reducePlayback(state, endedEvent);
  const endedAgain = reducePlayback(ended.state, endedEvent);
  // 激活队尾最后一首时已提前发起续选；重复耗尽事件沿用同一边界，不重建。
  assert.equal(ended.state.pendingContinuation?.status, 'requested');
  assert.equal(endedAgain.accepted, false);
  assert.equal(endedAgain.state, ended.state);
  assert.equal(endedAgain.state.pendingContinuation?.status, 'requested');
});

test('late replaced-media events and stale runtime versions do not mutate current playback', () => {
  const old = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('old')]), 'old');
  const replaced = commit(old, [track('new', { programId: 'new-program', requestId: 'new-request' })], { eventId: 'replace' }).state;
  const late = reducePlayback(replaced, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'late-old', runtimeVersion: replaced.version, songId: 'old', natural: true,
  });
  assert.equal(late.state.currentSongId, 'new');
  assert.equal(late.effects.length, 0);

  const stale = reducePlayback(late.state, {
    type: PlaybackEventType.NEXT_REQUESTED,
    eventId: 'stale-version', runtimeVersion: old.version, songId: 'new',
  });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale runtime version');
});

test('media failure is recoverable and narration failure never changes the playing track', () => {
  const activated = commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]);
  const failed = reducePlayback(activated.state, {
    type: PlaybackEventType.TRACK_FAILED,
    eventId: 'track-failed', runtimeVersion: activated.state.version,
    songId: 'one', programId: activated.state.txn.programId,
    correlationId: activated.state.txn.correlationId, error: 'decode error',
  });
  assert.equal(failed.state.phase, PlaybackPhase.ERROR);
  assert.equal(failed.effects.length, 0);

  const retry = reducePlayback(failed.state, {
    type: PlaybackEventType.RETRY_REQUESTED,
    eventId: 'retry', runtimeVersion: failed.state.version, songId: 'one',
  });
  assert.equal(retry.state.currentSongId, 'one');
  // A retry re-attaches the occurrence that is already current, so it keeps the same
  // transaction identity (a client that still holds the media must not be restarted)
  // and never rewrites the introduction it already owns.
  assert.equal(retry.state.txn.correlationId, failed.state.txn.correlationId);
  assert.equal(retry.state.txn.queueItemId, failed.state.txn.queueItemId);
  assert.equal(retry.commands[0].type, PlaybackCommandType.PLAY_TRACK);
  assert.deepEqual(retry.effects, []);
});

test('idempotency history is bounded and hydrated active media re-attaches its confirmed target', () => {
  let state = createPlaybackRuntimeState({ radioMode: false, companionModeId: null });
  for (let index = 0; index < 20; index += 1) {
    state = reducePlayback(state, {
      type: PlaybackEventType.RADIO_MODE_CHANGED,
      eventId: `radio-${index}`,
      enabled: index % 2 === 0,
    }, { idempotencyWindow: 16 }).state;
  }
  assert.equal(state.processedEventIds.length, 16);

  const active = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'hydrate');
  const hydrated = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(active)));
  assert.equal(hydrated.phase, PlaybackPhase.LOADING);
  assert.equal(hydrated.currentSongId, 'one');
  const commands = resumeCommandsForState(hydrated);
  assert.deepEqual(commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
  assert.equal(commands[0].url, '/one.mp3');
});

test('recovery preserves the confirmed position and transaction identity of a playing track', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one'), track('two')]), 'recover-media');
  const reported = reducePlayback(playing, {
    type: PlaybackEventType.POSITION_REPORTED, eventId: 'recover-media-position', runtimeVersion: playing.version,
    songId: playing.currentSongId, programId: playing.txn.programId, correlationId: playing.txn.correlationId,
    queueItemId: playing.txn.queueItemId, listeningSessionId: playing.activeListeningSessionId,
    outputGeneration: playing.outputGeneration, positionSeconds: 42,
  }, { nowMs: 5_000 });
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(reported.state)));
  assert.equal(restored.phase, PlaybackPhase.LOADING);
  assert.equal(restored.currentSongId, 'one');
  assert.equal(restored.positionSeconds, 42);
  assert.equal(restored.currentIndex, reported.state.currentIndex);
  assert.equal(restored.txn.correlationId, reported.state.txn.correlationId);
  assert.equal(restored.txn.queueItemId, reported.state.txn.queueItemId);
  assert.equal(restored.queue.map(item => item.songId).join(','), 'one,two');
  const [command] = resumeCommandsForState(restored);
  assert.equal(command.type, PlaybackCommandType.PLAY_TRACK);
  assert.equal(command.url, '/one.mp3');
  assert.equal(command.positionSeconds, 42);
  assert.equal(command.resume, true);
  assert.equal(command.correlationId, restored.txn.correlationId);
  assert.equal(command.queueItemId, restored.txn.queueItemId);
});

test('a client that connects while a track is confirmed playing is told to re-attach it', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'live-reconnect');
  const [command] = resumeCommandsForState(playing);
  assert.equal(playing.phase, PlaybackPhase.PLAYING);
  assert.equal(command.type, PlaybackCommandType.PLAY_TRACK);
  assert.equal(command.url, '/one.mp3');
  assert.equal(command.correlationId, playing.txn.correlationId);
  assert.equal(command.queueItemId, playing.txn.queueItemId);
});

test('recovery keeps an explicit pause paused and never starts output on its own', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'keep-paused');
  const paused = reducePlayback(playing, {
    type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'keep-paused-request', runtimeVersion: playing.version,
    songId: playing.currentSongId, programId: playing.txn.programId, correlationId: playing.txn.correlationId,
    queueItemId: playing.txn.queueItemId, listeningSessionId: playing.activeListeningSessionId,
    outputGeneration: playing.outputGeneration, positionSeconds: 12,
  }, { nowMs: 5_000 });
  assert.equal(paused.state.phase, PlaybackPhase.PAUSED);
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(paused.state)));
  assert.equal(restored.phase, PlaybackPhase.PAUSED);
  assert.deepEqual(resumeCommandsForState(restored), []);
  const resumed = reducePlayback(restored, {
    type: PlaybackEventType.RESUME_REQUESTED, eventId: 'keep-paused-resume', runtimeVersion: restored.version,
    songId: restored.currentSongId, programId: restored.txn.programId, correlationId: restored.txn.correlationId,
    queueItemId: restored.txn.queueItemId, listeningSessionId: restored.activeListeningSessionId,
    outputGeneration: restored.outputGeneration,
  }, { nowMs: 6_000 });
  assert.deepEqual(resumed.commands.map(command => command.type), [PlaybackCommandType.RESUME_TRACK]);
  assert.equal(resumed.commands[0].url, '/one.mp3');
  assert.equal(resumed.commands[0].positionSeconds, 12);
});

test('resume on an unconfirmed activation reissues the phase command for the same occurrence', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'loading-resume');
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(playing)));
  const resumed = reducePlayback(restored, {
    type: PlaybackEventType.RESUME_REQUESTED, eventId: 'loading-resume-request', runtimeVersion: restored.version,
    songId: restored.currentSongId, programId: restored.txn.programId, correlationId: restored.txn.correlationId,
    queueItemId: restored.txn.queueItemId, listeningSessionId: restored.activeListeningSessionId,
    outputGeneration: restored.outputGeneration,
  }, { nowMs: 6_000 });
  assert.equal(resumed.accepted, true, resumed.reason);
  assert.deepEqual(resumed.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
  assert.equal(resumed.commands[0].url, '/one.mp3');
  assert.equal(resumed.commands[0].queueItemId, restored.txn.queueItemId);
  assert.equal(resumed.commands[0].correlationId, restored.txn.correlationId);
});

test('recovery retries a failed continuation within a bounded number of attempts', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'bounded-recovery');
  const ended = reducePlayback(playing, {
    type: PlaybackEventType.TRACK_ENDED, eventId: 'bounded-recovery-ended', runtimeVersion: playing.version,
    songId: playing.currentSongId, programId: playing.txn.programId, correlationId: playing.txn.correlationId,
    queueItemId: playing.txn.queueItemId, listeningSessionId: playing.activeListeningSessionId,
    outputGeneration: playing.outputGeneration, natural: true,
  });
  assert.equal(ended.state.phase, PlaybackPhase.EXHAUSTED);
  const boundaryKey = ended.state.pendingContinuation.boundaryKey;
  const fail = state => reducePlayback(state, {
    type: PlaybackEventType.CONTINUATION_FAILED, eventId: `bounded-recovery-failed-${state.version}`,
    runtimeVersion: state.version, boundaryKey, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, error: 'NO_MATCHING_CANDIDATES',
  });
  const firstFailure = fail(ended.state);
  assert.equal(firstFailure.state.pendingContinuation.status, 'failed');
  assert.equal(firstFailure.state.lastError.message, 'NO_MATCHING_CANDIDATES');

  const recovered = [];
  let snapshot = firstFailure.state;
  for (let attempt = 0; attempt < MAX_CONTINUATION_ATTEMPTS + 1; attempt += 1) {
    const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(snapshot)));
    const effects = resumeEffectsForState(restored).filter(effect => effect.type === PlaybackEffectType.REQUEST_CONTINUATION);
    recovered.push({ status: restored.pendingContinuation.status, attempts: restored.pendingContinuation.attempts,
      boundaryKey: effects[0]?.boundaryKey ?? null, effects: effects.length });
    if (!effects.length) break;
    snapshot = fail(restored).state;
  }
  assert.deepEqual(recovered.map(entry => entry.attempts), [2, 3, 3]);
  assert.deepEqual(recovered.map(entry => entry.effects), [1, 1, 0]);
  assert.deepEqual(recovered.map(entry => entry.status), ['requested', 'requested', 'failed']);
  assert.deepEqual(recovered.filter(entry => entry.boundaryKey).map(entry => entry.boundaryKey), [boundaryKey, boundaryKey]);
});

test('restart replays an in-flight continuation effect without changing its boundary', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'restart-continuation');
  const ended = reducePlayback(playing, {
    type: PlaybackEventType.TRACK_ENDED,
    eventId: 'restart-continuation-ended',
    runtimeVersion: playing.version,
    songId: playing.currentSongId,
    programId: playing.txn.programId,
    correlationId: playing.txn.correlationId,
    queueItemId: playing.txn.queueItemId,
    listeningSessionId: playing.activeListeningSessionId,
    outputGeneration: playing.outputGeneration,
    natural: true,
  });
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(ended.state)));
  const effects = resumeEffectsForState(restored);
  assert.equal(effects[0].type, PlaybackEffectType.REQUEST_CONTINUATION);
  assert.equal(effects[0].boundaryKey, restored.pendingContinuation.boundaryKey);
  assert.equal(effects[0].listeningSessionId, restored.activeListeningSessionId);
  assert.equal(effects[0].recovered, true);
});

test('invalid snapshots preserve individually valid committed facts at safe idle', () => {
  const recovered = hydratePlaybackRuntimeState({
    schemaVersion: 999,
    queue: [track('safe'), { songId: 'broken' }],
    currentIndex: 0,
    currentSongId: 'safe',
    phase: 'playing',
  });
  assert.equal(recovered.phase, 'idle');
  assert.equal(recovered.currentIndex, -1);
  assert.equal(recovered.currentSongId, null);
  assert.deepEqual(recovered.queue.map(item => item.songId), ['safe']);
  assert.equal(recovered.lastError.type, 'invalid-snapshot-safe-idle');
});

test('Radiohost reset clears runtime ownership atomically and commands media stop', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one')]), 'reset');
  const reset = reducePlayback(playing, {
    type: PlaybackEventType.RESET_REQUESTED,
    eventId: 'radiohost-reset:luna',
  });
  assert.equal(reset.state.phase, PlaybackPhase.IDLE);
  assert.equal(reset.state.currentIndex, -1);
  assert.equal(reset.state.currentSongId, null);
  assert.deepEqual(reset.state.queue, []);
  assert.deepEqual(reset.commands.map(command => command.type), [PlaybackCommandType.STOP_PLAYBACK]);
});

test('activating a track prepares the following committed occurrence without speaking it', () => {
  const committed = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('one'), narrationContextTrack('two')], { nowMs: 1_000 });
  const upcoming = committed.state.queue[1];
  // 预取 effect 排在串词准备之后：两首队列激活即提前续选。
  assert.deepEqual(committed.effects.map(effect => effect.type),
    [PlaybackEffectType.PREPARE_TRACK_NARRATION, PlaybackEffectType.PREPARE_TRACK_NARRATION,
      PlaybackEffectType.REQUEST_CONTINUATION]);
  assert.equal(committed.effects[1].queueItemId, upcoming.queueItemId);
  assert.equal(committed.effects[1].previousTrack.songId, 'one');
  assert.equal(committed.state.queue[1].narration.status, 'preparing');
  // Preparing ahead is not playback: only the activated track is commanded.
  assert.deepEqual(committed.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
  assert.equal(committed.commands[0].queueItemId, committed.state.queue[0].queueItemId);

  const playing = finishActivation(committed, 'first-of-two');
  const ready = reducePlayback(playing, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'upcoming-narration-ready',
    queueItemId: upcoming.queueItemId, songId: 'two', programId: 'program-a',
    generationRevision: playing.queue[1].narration.generationRevision,
    listeningSessionId: playing.activeListeningSessionId,
    text: '接下来是 Artist two 的《Title two》。这首歌可以安静听下去。', ttsUrl: '/two-tts.mp3',
    previousSongId: 'one',
  }, { nowMs: 12_000 });
  assert.equal(ready.accepted, true, ready.reason);
  assert.equal(ready.state.queue[1].narration.status, 'ready');
  assert.equal(ready.state.queue[1].narration.previousSongId, 'one');
  assert.deepEqual(ready.commands, []);
  assert.equal(ready.state.currentSongId, 'one');
  assert.equal(ready.state.txn.narrationDelivery, 'waiting');

  // Sequential playback reuses it without another preparation or revision bump.
  const next = reducePlayback(ready.state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'natural-next-after-ready',
    runtimeVersion: ready.state.version, songId: 'one',
  }, { nowMs: 13_000 });
  assert.equal(next.state.currentSongId, 'two');
  assert.deepEqual(next.effects.map(effect => effect.type),
    [PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET, PlaybackEffectType.REQUEST_CONTINUATION]);
  assert.equal(next.state.queue[1].narration.generationRevision, ready.state.queue[1].narration.generationRevision);
});

test('narration prepared for a different predecessor is regenerated instead of delivered', () => {
  const committed = commit(createPlaybackRuntimeState({ companionModeId: null }),
    [narrationContextTrack('one'), narrationContextTrack('two'), narrationContextTrack('three')], { nowMs: 1_000 });
  const two = committed.state.queue[1];
  let state = finishActivation(committed, 'first-of-three');
  state = reducePlayback(state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'two-prepared-for-one',
    queueItemId: two.queueItemId, songId: 'two', programId: 'program-a',
    generationRevision: state.queue[1].narration.generationRevision,
    listeningSessionId: state.activeListeningSessionId,
    text: '接下来是 Artist two 的《Title two》。这首歌可以安静听下去。', ttsUrl: '/two-tts.mp3',
    previousSongId: 'one',
  }, { nowMs: 12_000 }).state;
  assert.equal(state.queue[1].narration.status, 'ready');
  const preparedRevision = state.queue[1].narration.generationRevision;

  // The user jumps to the third occurrence and it actually plays, so 'three' is
  // the confirmed output before 'two'.
  state = finishActivation(reducePlayback(state, {
    type: PlaybackEventType.CARD_SELECTED, eventId: 'jump-to-three',
    runtimeVersion: state.version, queueItemId: state.queue[2].queueItemId,
  }, { nowMs: 14_000 }), 'jump-three');
  const back = reducePlayback(state, {
    type: PlaybackEventType.CARD_SELECTED, eventId: 'jump-back-to-two',
    runtimeVersion: state.version, queueItemId: two.queueItemId,
  }, { nowMs: 15_000 });

  assert.equal(back.state.currentSongId, 'two');
  assert.ok(back.state.diagnostics.some(entry => entry.type === 'track-narration-predecessor-changed'
    && entry.preparedFor === 'one' && entry.actual === 'three'));
  assert.deepEqual(back.effects.map(effect => effect.type),
    [PlaybackEffectType.PREPARE_TRACK_NARRATION, PlaybackEffectType.REQUEST_CONTINUATION]);
  assert.equal(back.effects[0].previousTrack.songId, 'three');
  assert.ok(back.state.queue[1].narration.generationRevision > preparedRevision);

  const stale = reducePlayback(back.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'stale-two-ready',
    queueItemId: two.queueItemId, songId: 'two', programId: 'program-a',
    generationRevision: preparedRevision, listeningSessionId: back.state.activeListeningSessionId,
    text: '过期的串词。', ttsUrl: '/stale-two-tts.mp3', previousSongId: 'one',
  }, { nowMs: 16_000 });
  assert.equal(stale.accepted, false);
});

test('upcoming narration is skipped without a candidate, context, or a retryable artifact', () => {
  const solo = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('solo')], { nowMs: 1_000 });
  assert.deepEqual(solo.effects.map(effect => effect.type),
    [PlaybackEffectType.PREPARE_TRACK_NARRATION, PlaybackEffectType.REQUEST_CONTINUATION]);

  const contextless = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('one'),
    { ...track('two'), intro: { text: '第一首，卫兰的《街灯晚餐》。' } }], { nowMs: 1_000 });
  assert.deepEqual(contextless.effects.map(effect => effect.type),
    [PlaybackEffectType.PREPARE_TRACK_NARRATION, PlaybackEffectType.REQUEST_CONTINUATION]);
  assert.equal(contextless.state.queue[1].narration.status, 'absent');

  const committed = commit(createPlaybackRuntimeState({ companionModeId: null }),
    [narrationContextTrack('one'), narrationContextTrack('two')], { nowMs: 1_000 });
  const failed = reducePlayback(committed.state, {
    type: PlaybackEventType.TRACK_NARRATION_FAILED, eventId: 'two-preparation-failed',
    queueItemId: committed.state.queue[1].queueItemId, songId: 'two', programId: 'program-a',
    generationRevision: committed.state.queue[1].narration.generationRevision,
    listeningSessionId: committed.state.activeListeningSessionId, error: 'tts unavailable',
  }, { nowMs: 11_000 });
  assert.equal(failed.state.queue[1].narration.status, 'failed');
  const playing = finishActivation(failed, 'after-upcoming-failure');
  const next = reducePlayback(playing, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'next-after-upcoming-failure',
    runtimeVersion: playing.version, songId: 'one',
  }, { nowMs: 13_000 });
  // Activation is what decides; background work is not restarted on its own.
  assert.deepEqual(next.effects.map(effect => effect.type),
    [PlaybackEffectType.PREPARE_TRACK_NARRATION, PlaybackEffectType.REQUEST_CONTINUATION]);
});

test('a requested narration reuses the ready artifact even after the automatic window closed', () => {
  let result = commit(createPlaybackRuntimeState({
    narrationPolicy: { settlingDelayMs: 0, maxStartOffsetMs: 1_000, minRemainingMs: 0 },
  }), [narrationContextTrack('one')], { nowMs: 1_000 });
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'request-track-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 2_000 });
  // The artifact only lands after the automatic insertion window has closed.
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'request-narration-ready',
    queueItemId, songId: 'one', programId: 'program-a', generationRevision: 1,
    listeningSessionId: result.state.activeListeningSessionId,
    text: '接下来是 Artist one 的《Title one》。可以安静听下去。', ttsUrl: '/request-one.mp3',
  }, { nowMs: 5_000 });
  assert.equal(result.state.txn.narrationDelivery, 'skipped');
  const revision = result.state.queue[0].narration.generationRevision;

  // 90 seconds in: the automatic window is long gone, the artifact is not.
  const requested = reducePlayback(result.state, {
    type: PlaybackEventType.NARRATION_REQUESTED, eventId: 'listener-asks-to-narrate',
    runtimeVersion: result.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration,
  }, { nowMs: 92_000 });
  assert.equal(requested.accepted, true, requested.reason);
  assert.deepEqual(requested.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK_NARRATION]);
  assert.equal(requested.commands[0].url, '/request-one.mp3');
  assert.equal(requested.commands[0].maxStartOffsetMs > 20_000, true);
  assert.equal(requested.state.txn.narrationDelivery, 'queued');
  assert.equal(requested.state.queue[0].narration.generationRevision, revision);
  assert.deepEqual(requested.effects, []);

  // A second request while it is already queued does not speak twice.
  const again = reducePlayback(requested.state, {
    type: PlaybackEventType.NARRATION_REQUESTED, eventId: 'listener-asks-again',
    runtimeVersion: requested.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: requested.state.activeListeningSessionId,
    outputGeneration: requested.state.outputGeneration,
  }, { nowMs: 93_000 });
  assert.deepEqual(again.commands, []);
});

test('an automatic narration still skips once the insertion window has passed', () => {
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('one')], { nowMs: 1_000 });
  const queueItemId = result.state.queue[0].queueItemId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'late-track-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId: result.state.txn.correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 2_000 });
  result = reducePlayback(result.state, narrationIdentity(result.state,
    PlaybackEventType.NARRATION_WINDOW_OPENED, 'late-window-opened', {
      positionSeconds: 90, durationSeconds: 200,
    }), { nowMs: 92_000 });
  assert.deepEqual(result.commands, []);
  assert.equal(result.state.txn.narrationDelivery, 'skipped');
  assert.ok(result.state.diagnostics.some(entry => entry.type === 'track-narration-skipped' && entry.reason === 'late'));
});

test('a requested narration prepares the current occurrence once when it is missing or failed', () => {
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('one')], { nowMs: 1_000 });
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'prepare-on-request-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 2_000 });
  const failed = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_FAILED, eventId: 'request-target-failed',
    queueItemId, songId: 'one', programId: 'program-a', generationRevision: 1,
    listeningSessionId: result.state.activeListeningSessionId, error: 'tts unavailable',
  }, { nowMs: 40_000 });
  assert.equal(failed.state.queue[0].narration.status, 'failed');

  const requested = reducePlayback(failed.state, {
    type: PlaybackEventType.NARRATION_REQUESTED, eventId: 'listener-asks-after-failure',
    runtimeVersion: failed.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: failed.state.activeListeningSessionId,
    outputGeneration: failed.state.outputGeneration,
  }, { nowMs: 60_000 });
  assert.deepEqual(requested.effects.map(effect => effect.type), [PlaybackEffectType.PREPARE_TRACK_NARRATION]);
  assert.equal(requested.state.queue[0].narration.status, 'preparing');
  assert.equal(requested.state.txn.narrationGenerationRevision, 2);
  assert.deepEqual(requested.commands, []);

  // The failed first attempt can never attach afterwards.
  const stale = reducePlayback(requested.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'stale-first-attempt',
    queueItemId, songId: 'one', programId: 'program-a', generationRevision: 1,
    listeningSessionId: requested.state.activeListeningSessionId,
    text: '过期的串词。', ttsUrl: '/stale-one.mp3',
  }, { nowMs: 61_000 });
  assert.equal(stale.accepted, false);
});

test('a narration request cannot act on another occurrence, another session, or a non-playing track', () => {
  let state = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }),
    [narrationContextTrack('one'), narrationContextTrack('two')]), 'request-scope');
  const other = state.queue[1];
  const identity = {
    runtimeVersion: state.version, songId: 'one', programId: 'program-a',
    correlationId: state.txn.correlationId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  };

  const wrongItem = reducePlayback(state, {
    ...identity, type: PlaybackEventType.NARRATION_REQUESTED, eventId: 'ask-for-other-track',
    queueItemId: other.queueItemId,
  }, { nowMs: 30_000 });
  assert.equal(wrongItem.accepted, false);
  assert.deepEqual(wrongItem.commands, []);
  assert.deepEqual(wrongItem.effects, []);
  assert.equal(wrongItem.state.txn.narrationUserRequested, undefined);

  const otherSession = reducePlayback(state, {
    ...identity, type: PlaybackEventType.NARRATION_REQUESTED, eventId: 'ask-in-other-session',
    queueItemId: state.queue[0].queueItemId, listeningSessionId: 'conversation:somewhere-else',
  }, { nowMs: 30_000 });
  assert.equal(otherSession.accepted, false);

  const paused = reducePlayback(state, {
    type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'pause-before-ask',
    runtimeVersion: state.version, songId: 'one', listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  }, { nowMs: 30_000 });
  const notPlaying = reducePlayback(paused.state, {
    ...identity, runtimeVersion: paused.state.version, type: PlaybackEventType.NARRATION_REQUESTED,
    eventId: 'ask-while-paused', queueItemId: paused.state.queue[0].queueItemId,
  }, { nowMs: 31_000 });
  assert.equal(notPlaying.accepted, false);
  assert.deepEqual(notPlaying.commands, []);
  assert.deepEqual(notPlaying.effects, []);
});

test('narration preparation is independent and READY before settling waits for the correlated window', () => {
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('one')], { nowMs: 1_000 });
  assert.deepEqual(result.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK]);
  assert.equal(result.effects[0].type, PlaybackEffectType.PREPARE_TRACK_NARRATION);
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;

  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'window-track-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 2_000 });
  assert.equal(result.state.phase, PlaybackPhase.PLAYING);
  assert.equal(result.effects[0].type, PlaybackEffectType.SCHEDULE_NARRATION_WINDOW);

  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'narration-ready-before-window',
    queueItemId, songId: 'one', programId: 'program-a', generationRevision: 1,
    listeningSessionId: result.state.activeListeningSessionId,
    text: '卫兰的新歌。', ttsUrl: '/narration-one.mp3', contentHash: 'abc123', voiceProfileId: 'luna-zh',
  }, { nowMs: 2_500 });
  assert.deepEqual(result.commands, []);
  assert.equal(result.state.queue[0].narration.status, 'ready');
  assert.equal(result.state.txn.narrationDelivery, 'waiting');

  result = reducePlayback(result.state, narrationIdentity(result.state,
    PlaybackEventType.NARRATION_WINDOW_OPENED, 'narration-window-opened', {
      positionSeconds: 1.1, durationSeconds: 200,
    }), { nowMs: 3_100 });
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].type, PlaybackCommandType.PLAY_TRACK_NARRATION);
  assert.equal(result.commands[0].queueItemId, queueItemId);
  assert.equal(result.commands[0].correlationId, correlationId);
  assert.equal(result.state.txn.narrationDelivery, 'queued');
});

test('READY that races after the settling timer still queues once inside the delivery window', () => {
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('race')], { nowMs: 1_000 });
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'race-track-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'race', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 2_000 });

  const ready = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'race-narration-ready',
    queueItemId, songId: 'race', programId: 'program-a', generationRevision: 1,
    listeningSessionId: result.state.activeListeningSessionId,
    text: '刚好赶上。', ttsUrl: '/race.mp3',
  }, { nowMs: 4_500 });
  assert.equal(ready.commands.length, 1);
  assert.equal(ready.commands[0].type, PlaybackCommandType.PLAY_TRACK_NARRATION);
  assert.equal(ready.state.txn.narrationDelivery, 'queued');
});

test('late or malformed narration is retained as failed/skipped and cannot interrupt music', () => {
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('late')], { nowMs: 0 });
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'late-track-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'late', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 0 });
  const late = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'late-narration-ready',
    queueItemId, songId: 'late', programId: 'program-a', generationRevision: 1,
    listeningSessionId: result.state.activeListeningSessionId,
    text: '迟到的介绍。', ttsUrl: '/late.mp3',
  }, { nowMs: 65_000 });
  assert.deepEqual(late.commands, []);
  assert.equal(late.state.phase, PlaybackPhase.PLAYING);
  assert.equal(late.state.queue[0].narration.status, 'ready');
  assert.equal(late.state.txn.narrationDelivery, 'skipped');

  let malformed = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('malformed')], { nowMs: 1_000 });
  const malformedTrack = malformed.state.queue[0];
  malformed = reducePlayback(malformed.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'malformed-ready',
    queueItemId: malformedTrack.queueItemId, songId: 'malformed', programId: 'program-a',
    generationRevision: 1, listeningSessionId: malformed.state.activeListeningSessionId,
    text: '', ttsUrl: '',
  }, { nowMs: 1_000 });
  assert.equal(malformed.state.queue[0].narration.status, 'failed');
  assert.equal(malformed.state.txn.narrationDelivery, 'skipped');
  assert.equal(malformed.state.phase, PlaybackPhase.LOADING);
  assert.deepEqual(malformed.commands, []);
});

test('background completion remains attached to a skipped queue item after next track starts', () => {
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('first'), track('second')], { nowMs: 1_000 });
  const firstItemId = result.state.queue[0].queueItemId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'skip-first',
    runtimeVersion: result.state.version, songId: 'first',
  }, { nowMs: 1_100 });
  assert.equal(result.state.currentSongId, 'second');
  const ready = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'first-ready-after-skip',
    queueItemId: firstItemId, songId: 'first', programId: 'program-a', generationRevision: 1,
    listeningSessionId: result.state.activeListeningSessionId,
    text: '保留给第一首。', ttsUrl: '/first.mp3',
  }, { nowMs: 1_200 });
  assert.equal(ready.accepted, true);
  assert.equal(ready.state.currentSongId, 'second');
  assert.equal(ready.state.queue[0].narration.text, '保留给第一首。');
  assert.equal(ready.state.txn.queueItemId, ready.state.queue[1].queueItemId);
  assert.deepEqual(ready.commands, []);
});

test('narration delivery requires the exact activation identity and is once per activation', () => {
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('spoken')], { nowMs: 1_000 });
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'spoken-track-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'spoken', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 2_000 });
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'spoken-ready',
    queueItemId, songId: 'spoken', programId: 'program-a', generationRevision: 1,
    listeningSessionId: result.state.activeListeningSessionId, text: '开始。', ttsUrl: '/spoken.mp3',
  }, { nowMs: 3_100 });
  assert.equal(result.commands[0].type, PlaybackCommandType.PLAY_TRACK_NARRATION);

  const stale = reducePlayback(result.state, narrationIdentity(result.state,
    PlaybackEventType.NARRATION_DELIVERY_STARTED, 'stale-overlay-start', {
      correlationId: 'superseded-correlation', positionSeconds: 1.1, durationSeconds: 200,
    }), { nowMs: 3_200 });
  assert.equal(stale.accepted, false);
  assert.equal(stale.state, result.state);

  const started = reducePlayback(result.state, narrationIdentity(result.state,
    PlaybackEventType.NARRATION_DELIVERY_STARTED, 'overlay-start', {
      positionSeconds: 1.2, durationSeconds: 200,
    }), { nowMs: 3_200 });
  assert.equal(started.accepted, true);
  assert.equal(started.state.txn.narrationDelivery, 'starting');
  const audible = reducePlayback(started.state, narrationIdentity(started.state,
    PlaybackEventType.NARRATION_DELIVERY_AUDIBLE, 'overlay-audible', {
      positionSeconds: 1.3, durationSeconds: 200,
    }), { nowMs: 3_250 });
  assert.equal(audible.accepted, true);
  assert.equal(audible.state.txn.narrationDelivery, 'speaking');
  const finished = reducePlayback(audible.state, narrationIdentity(audible.state,
    PlaybackEventType.NARRATION_DELIVERY_FINISHED, 'overlay-finished', {
      positionSeconds: 2, durationSeconds: 200,
    }), { nowMs: 3_500 });
  assert.equal(finished.state.txn.narrationDelivery, 'delivered');
  const replay = reducePlayback(finished.state, narrationIdentity(finished.state,
    PlaybackEventType.NARRATION_DELIVERY_STARTED, 'overlay-restarted', {
      positionSeconds: 2.5, durationSeconds: 200,
    }), { nowMs: 4_000 });
  assert.equal(replay.state.txn.narrationDelivery, 'delivered');
});

test('duplicate songs have distinct stable queue occurrence ids and card selection uses the exact item', () => {
  const repeated = track('same');
  const result = commit(createPlaybackRuntimeState({ companionModeId: null }), [repeated, { ...repeated }], { eventId: 'same-program-commit' });
  const [first, second] = result.state.queue;
  assert.notEqual(first.queueItemId, second.queueItemId);
  assert.match(first.queueItemId, /^queue:[a-f0-9]{32}$/);
  assert.equal(result.state.phase, PlaybackPhase.LOADING);

  const ambiguous = reducePlayback(result.state, {
    type: PlaybackEventType.CARD_SELECTED, eventId: 'ambiguous-card',
    runtimeVersion: result.state.version, songId: 'same',
  });
  assert.equal(ambiguous.accepted, false);
  assert.equal(ambiguous.reason, 'ambiguous song id; queueItemId required');

  const selected = reducePlayback(result.state, {
    type: PlaybackEventType.CARD_SELECTED, eventId: 'select-second-card',
    runtimeVersion: result.state.version, queueItemId: second.queueItemId,
  });
  assert.equal(selected.state.currentIndex, 1);
  assert.equal(selected.state.txn.queueItemId, second.queueItemId);
  assert.equal(selected.commands[0].queueItemId, second.queueItemId);
});

test('jumping from the fifth track back to a cached second occurrence starts music first and reuses its narration', () => {
  const tracks = [1, 2, 3, 4, 5].map(index => ({
    ...track(`song-${index}`, { intro: null }),
    ...(index === 2 ? { narration: {
      status: 'ready', assetStatus: 'ready', generationRevision: 3,
      text: '这是第二首的缓存介绍。', ttsUrl: '/cached-second.mp3',
      contentHash: 'cached-second-hash', voiceProfileId: 'voice-stable',
    } } : {}),
  }));
  let state = finishActivation(commit(createPlaybackRuntimeState({
    narrationPolicy: { settlingDelayMs: 0 }, companionModeId: null,
  }), tracks, { eventId: 'five-track-program' }), 'first-track');
  for (let index = 2; index <= 5; index += 1) {
    const next = reducePlayback(state, {
      type: PlaybackEventType.NEXT_REQUESTED, eventId: `advance-to-${index}`,
      runtimeVersion: state.version, songId: state.currentSongId,
    });
    assert.equal(next.commands[0].type, PlaybackCommandType.PLAY_TRACK);
    state = finishActivation(next, `track-${index}`);
    if (index === 2) {
      const cachedAsset = reducePlayback(state, narrationIdentity(state,
        PlaybackEventType.TRACK_NARRATION_ASSET_READY, 'second-track-asset-cached', {
          ttsUrl: '/cached-second.mp3', contentHash: 'cached-second-hash',
        }), { nowMs: 10_000 });
      assert.equal(cachedAsset.accepted, true, cachedAsset.reason);
      state = cachedAsset.state;
    }
  }
  assert.equal(state.currentSongId, 'song-5');

  const second = state.queue[1];
  const selected = reducePlayback(state, {
    type: PlaybackEventType.CARD_SELECTED, eventId: 'jump-back-to-second',
    runtimeVersion: state.version, queueItemId: second.queueItemId,
  }, { nowMs: 20_000 });
  assert.equal(selected.state.currentSongId, 'song-2');
  assert.equal(selected.commands[0].type, PlaybackCommandType.PLAY_TRACK);
  assert.equal(selected.commands[0].queueItemId, second.queueItemId);
  assert.deepEqual(selected.effects.map(effect => effect.type),
    [PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET],
    '跳回后仍有 3 首余量、高于提前量（且换歌前已有 in-flight 边界），不新建预取');

  const started = reducePlayback(selected.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'second-replay-started',
    runtimeVersion: selected.state.version, songId: 'song-2', programId: second.programId,
    queueItemId: second.queueItemId, correlationId: selected.state.txn.correlationId,
    listeningSessionId: selected.state.activeListeningSessionId,
    outputGeneration: selected.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 20_100 });
  assert.equal(started.state.txn.narrationDelivery, 'eligible');
  const assetReady = reducePlayback(started.state, {
    type: PlaybackEventType.TRACK_NARRATION_ASSET_READY, eventId: 'second-replay-asset-ready',
    runtimeVersion: started.state.version, songId: 'song-2', programId: second.programId,
    queueItemId: second.queueItemId, generationRevision: 3,
    listeningSessionId: started.state.activeListeningSessionId,
    outputGeneration: started.state.outputGeneration,
    ttsUrl: '/cached-second.mp3', contentHash: 'cached-second-hash',
  }, { nowMs: 20_200 });
  assert.equal(assetReady.commands[0].type, PlaybackCommandType.PLAY_TRACK_NARRATION);
  assert.equal(assetReady.commands[0].queueItemId, second.queueItemId);
  assert.equal(assetReady.commands[0].url, '/cached-second.mp3');
  assert.equal(assetReady.commands[0].text, '这是第二首的缓存介绍。');
});

test('schema v2 awaiting-intro snapshots migrate cached narration and duplicate song identities', () => {
  const legacyTrack = {
    ...track('legacy-same'),
    queueItemId: undefined,
    narration: undefined,
    intro: { text: '原有的介绍。', ttsUrl: '/legacy.mp3', context: { transition: 'legacy' } },
  };
  const legacy = {
    ...JSON.parse(JSON.stringify(createPlaybackRuntimeState({ companionModeId: null }))),
    schemaVersion: 2,
    activeListeningSessionId: 'conversation:legacy',
    queue: [{ ...legacyTrack }, { ...legacyTrack }],
    currentIndex: 0,
    currentSongId: 'legacy-same',
    phase: PlaybackPhase.AWAITING_INTRO,
    txn: { correlationId: 'legacy-corr', songId: 'legacy-same', programId: 'program-a', requestId: 'request-a' },
  };
  const migrated = hydratePlaybackRuntimeState(legacy);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.phase, PlaybackPhase.LOADING);
  assert.notEqual(migrated.queue[0].queueItemId, migrated.queue[1].queueItemId);
  assert.equal(migrated.queue[0].narration.status, 'ready');
  assert.equal(migrated.queue[0].narration.ttsUrl, '/legacy.mp3');
  assert.equal(migrated.txn.queueItemId, migrated.queue[0].queueItemId);
  const resume = resumeCommandsForState(migrated);
  assert.equal(resume[0].type, PlaybackCommandType.PLAY_TRACK);
  assert.equal(resume[0].queueItemId, migrated.queue[0].queueItemId);
  assert.equal(resume[0].narrationGenerationRevision, 1);
});

// A server restart restores a confirmed track as an unconfirmed `loading` activation.
// The browser that already holds that media keeps playing it, so the listener's pause
// and position facts must stay effective and the runtime must be able to conclude the
// activation from real media evidence again.
function restoredUnconfirmedActivation(prefix, tracks = [track('one')]) {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), tracks), prefix);
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(playing)));
  assert.equal(restored.phase, PlaybackPhase.LOADING);
  return restored;
}

function activationIdentity(state, overrides = {}) {
  const item = state.queue.find(entry => entry.queueItemId === (overrides.queueItemId || state.txn.queueItemId));
  return {
    runtimeVersion: state.version,
    songId: item.songId,
    programId: item.programId,
    correlationId: overrides.correlationId || state.txn.correlationId,
    queueItemId: item.queueItemId,
    listeningSessionId: overrides.listeningSessionId || state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
    ...overrides,
  };
}

test('the listener can pause a restored unconfirmed activation at the position the client holds', () => {
  const restored = restoredUnconfirmedActivation('pause-unconfirmed', [track('one'), track('two')]);
  const paused = reducePlayback(restored, {
    type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'pause-unconfirmed-request',
    ...activationIdentity(restored), positionSeconds: 37.5,
  }, { nowMs: 7_000 });
  assert.equal(paused.accepted, true, paused.reason);
  assert.equal(paused.state.phase, PlaybackPhase.PAUSED);
  assert.equal(paused.state.positionSeconds, 37.5);
  assert.deepEqual(paused.commands.map(command => command.type), [PlaybackCommandType.PAUSE_TRACK]);
  assert.deepEqual(paused.effects, []);

  // The paused snapshot stays paused across another restart and never starts on its own.
  const restoredAgain = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(paused.state)));
  assert.equal(restoredAgain.phase, PlaybackPhase.PAUSED);
  assert.deepEqual(resumeCommandsForState(restoredAgain), []);
  assert.equal(restoredAgain.positionSeconds, 37.5);

  const resumed = reducePlayback(restoredAgain, {
    type: PlaybackEventType.RESUME_REQUESTED, eventId: 'pause-unconfirmed-resume',
    ...activationIdentity(restoredAgain, { runtimeVersion: restoredAgain.version }),
  }, { nowMs: 8_000 });
  assert.equal(resumed.accepted, true, resumed.reason);
  assert.deepEqual(resumed.commands.map(command => command.type), [PlaybackCommandType.RESUME_TRACK]);
  assert.equal(resumed.commands[0].url, '/one.mp3');
  assert.equal(resumed.commands[0].positionSeconds, 37.5);
});

test('a pause for another occurrence or session cannot stop the unconfirmed current one', () => {
  const restored = restoredUnconfirmedActivation('pause-unconfirmed-scope', [track('one'), track('two')]);
  const other = restored.queue[1];
  const wrongItem = reducePlayback(restored, {
    type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'pause-unconfirmed-other-item',
    ...activationIdentity(restored, { queueItemId: other.queueItemId, songId: other.songId,
      programId: other.programId }), positionSeconds: 5,
  }, { nowMs: 7_000 });
  assert.equal(wrongItem.accepted, false);
  assert.deepEqual(wrongItem.commands, []);
  assert.equal(wrongItem.state.phase, PlaybackPhase.LOADING);

  const wrongSession = reducePlayback(restored, {
    type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'pause-unconfirmed-other-session',
    ...activationIdentity(restored, { listeningSessionId: 'conversation:somewhere-else' }), positionSeconds: 5,
  }, { nowMs: 7_000 });
  assert.equal(wrongSession.accepted, false);
  assert.deepEqual(wrongSession.commands, []);
  assert.equal(wrongSession.state.phase, PlaybackPhase.LOADING);
});

test('a stale pause position is rejected instead of being recorded', () => {
  const restored = restoredUnconfirmedActivation('pause-unconfirmed-position', [track('one')]);
  const invalid = reducePlayback(restored, {
    type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'pause-unconfirmed-bad-position',
    ...activationIdentity(restored), positionSeconds: -3,
  }, { nowMs: 7_000 });
  assert.equal(invalid.accepted, false);
  assert.deepEqual(invalid.commands, []);
  assert.equal(invalid.state.phase, PlaybackPhase.LOADING);
  assert.equal(invalid.state.positionSeconds, 0);
});

test('positions reported for an unconfirmed activation stay effective without claiming playback', () => {
  const restored = restoredUnconfirmedActivation('position-unconfirmed', [track('one'), track('two')]);
  const reported = reducePlayback(restored, {
    type: PlaybackEventType.POSITION_REPORTED, eventId: 'position-unconfirmed-report',
    ...activationIdentity(restored), positionSeconds: 61.25,
  }, { nowMs: 7_000 });
  assert.equal(reported.accepted, true, reported.reason);
  assert.equal(reported.state.phase, PlaybackPhase.LOADING);
  assert.equal(reported.state.positionSeconds, 61.25);
  assert.deepEqual(reported.commands, []);
  assert.deepEqual(reported.effects, []);
  // A later re-attach of the same occurrence resumes there instead of replaying it.
  const [command] = resumeCommandsForState(reported.state);
  assert.equal(command.type, PlaybackCommandType.PLAY_TRACK);
  assert.equal(command.positionSeconds, 61.25);

  const other = reported.state.queue[1];
  const foreign = reducePlayback(reported.state, {
    type: PlaybackEventType.POSITION_REPORTED, eventId: 'position-unconfirmed-foreign',
    ...activationIdentity(reported.state, { queueItemId: other.queueItemId, songId: other.songId,
      programId: other.programId, runtimeVersion: reported.state.version }), positionSeconds: 12,
  }, { nowMs: 8_000 });
  assert.equal(foreign.accepted, false);
  assert.equal(foreign.state.positionSeconds, 61.25);
});

test('a re-attach confirmation concludes an unconfirmed activation without a second start fact', () => {
  const restored = restoredUnconfirmedActivation('reattach-confirm', [track('one')]);
  const confirmed = reducePlayback(restored, {
    type: PlaybackEventType.TRACK_REATTACHED, eventId: 'reattach-confirm-1',
    ...activationIdentity(restored), positionSeconds: 19.5,
  }, { nowMs: 9_000 });
  assert.equal(confirmed.accepted, true, confirmed.reason);
  assert.equal(confirmed.state.phase, PlaybackPhase.PLAYING);
  assert.equal(confirmed.state.positionSeconds, 19.5);
  assert.equal(confirmed.state.txn.startedPositionSeconds, 19.5);
  assert.deepEqual(confirmed.commands, []);
  assert.deepEqual(confirmed.state.diagnostics.filter(entry => entry.type === 'track-reattached').length, 1);

  // Repeating it while the activation is already concluded is a no-op.
  const again = reducePlayback(confirmed.state, {
    type: PlaybackEventType.TRACK_REATTACHED, eventId: 'reattach-confirm-2',
    ...activationIdentity(confirmed.state, { runtimeVersion: confirmed.state.version }),
    positionSeconds: 30,
  }, { nowMs: 10_000 });
  assert.equal(again.accepted, true, again.reason);
  assert.equal(again.state.phase, PlaybackPhase.PLAYING);
  assert.equal(again.state.positionSeconds, 19.5);
  assert.deepEqual(again.commands, []);
  assert.equal(again.state.diagnostics.filter(entry => entry.type === 'track-reattached').length, 1);
});

test('a re-attach confirmation cannot resurrect a listener pause or another occurrence', () => {
  const restored = restoredUnconfirmedActivation('reattach-scope', [track('one'), track('two')]);
  const paused = reducePlayback(restored, {
    type: PlaybackEventType.PAUSE_REQUESTED, eventId: 'reattach-scope-pause',
    ...activationIdentity(restored), positionSeconds: 11,
  }, { nowMs: 7_000 });
  assert.equal(paused.state.phase, PlaybackPhase.PAUSED);
  const confirmedWhilePaused = reducePlayback(paused.state, {
    type: PlaybackEventType.TRACK_REATTACHED, eventId: 'reattach-scope-while-paused',
    ...activationIdentity(paused.state, { runtimeVersion: paused.state.version }), positionSeconds: 12,
  }, { nowMs: 8_000 });
  assert.equal(confirmedWhilePaused.state.phase, PlaybackPhase.PAUSED);
  assert.equal(confirmedWhilePaused.state.positionSeconds, 11);
  assert.deepEqual(confirmedWhilePaused.commands, []);

  const other = restored.queue[1];
  const wrongItem = reducePlayback(restored, {
    type: PlaybackEventType.TRACK_REATTACHED, eventId: 'reattach-scope-other-item',
    ...activationIdentity(restored, { queueItemId: other.queueItemId, songId: other.songId,
      programId: other.programId }), positionSeconds: 12,
  }, { nowMs: 8_000 });
  assert.equal(wrongItem.accepted, false);
  assert.equal(wrongItem.state.phase, PlaybackPhase.LOADING);
});

test('a re-attach confirmation arms the narration window the track still owes', () => {
  const restored = restoredUnconfirmedActivation('reattach-narration',
    [narrationContextTrack('one'), narrationContextTrack('two')]);
  const ready = reducePlayback(restored, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'reattach-narration-ready',
    queueItemId: restored.queue[0].queueItemId, generationRevision: restored.queue[0].narration.generationRevision,
    songId: 'one', programId: 'program-a', listeningSessionId: restored.activeListeningSessionId,
    text: '接下来是 Artist one 的《Title one》。', ttsUrl: '/one-narration.mp3', contentHash: 'hash',
  }, { nowMs: 5_000 });
  assert.equal(ready.accepted, true, ready.reason);
  assert.equal(ready.state.queue[0].narration.status, 'ready');

  const confirmed = reducePlayback(ready.state, {
    type: PlaybackEventType.TRACK_REATTACHED, eventId: 'reattach-narration-confirm',
    ...activationIdentity(ready.state, { runtimeVersion: ready.state.version }), positionSeconds: 19.5,
  }, { nowMs: 9_000 });
  assert.equal(confirmed.state.phase, PlaybackPhase.PLAYING);
  assert.equal(confirmed.state.txn.narrationDelivery, 'waiting');
  assert.equal(confirmed.effects.length, 1);
  assert.equal(confirmed.effects[0].type, PlaybackEffectType.SCHEDULE_NARRATION_WINDOW);

  // A narration already delivered for this occurrence is never spoken again: the
  // armed window only ever delivers a narration the activation still owes.
  const delivered = {
    ...JSON.parse(JSON.stringify(confirmed.state)),
    txn: { ...confirmed.state.txn, narrationDelivery: 'delivered' },
  };
  const replayed = reducePlayback(hydratePlaybackRuntimeState(delivered), {
    type: PlaybackEventType.TRACK_REATTACHED, eventId: 'reattach-narration-delivered',
    ...activationIdentity(confirmed.state, { runtimeVersion: confirmed.state.version }), positionSeconds: 20,
  }, { nowMs: 11_000 });
  assert.equal(replayed.state.phase, PlaybackPhase.PLAYING);
  assert.equal(replayed.state.txn.narrationDelivery, 'delivered');
  assert.deepEqual(replayed.commands, []);
});

// Re-activating the occurrence that is already current is an idempotent re-attach. It
// must not restart the track, must not rewrite the introduction, and must not speak the
// same introduction twice (the three symptoms a listener reports as "点一下它就一直重播、
// 串词还被重新写、TTS 和歌曲抢播放栏").
function spokenActivation(prefix, tracks = [track('one')], position = 55) {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), tracks), prefix);
  const item = playing.queue[playing.currentIndex];
  // Stay inside the automatic delivery window: the runtime estimates the position from
  // the confirmed start, so a far-future timestamp would correctly be judged `late`.
  const base = playing.txn.startedAtMs + 1_500;
  let result = reducePlayback(playing, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: `${prefix}-narration-ready`,
    queueItemId: item.queueItemId, songId: item.songId, programId: item.programId,
    generationRevision: item.narration.generationRevision,
    listeningSessionId: playing.activeListeningSessionId,
    text: item.narration.text, ttsUrl: `/${item.songId}-tts.mp3`, contentHash: 'hash',
  }, { nowMs: base });
  assert.equal(result.accepted, true, result.reason);
  result = reducePlayback(result.state, narrationIdentity(result.state, PlaybackEventType.NARRATION_DELIVERY_STARTED,
    `${prefix}-narration-started`, { positionSeconds: 1.2, durationSeconds: 200, generationRevision: undefined }),
    { nowMs: base + 100 });
  assert.equal(result.accepted, true, result.reason);
  result = reducePlayback(result.state, narrationIdentity(result.state, PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    `${prefix}-narration-audible`, { positionSeconds: 1.3, durationSeconds: 200, generationRevision: undefined }),
    { nowMs: base + 200 });
  assert.equal(result.accepted, true, result.reason);
  assert.equal(result.state.txn.narrationDelivery, 'speaking');
  assert.equal(result.state.queue[result.state.currentIndex].narration.spoken, true);
  result = reducePlayback(result.state, narrationIdentity(result.state, PlaybackEventType.NARRATION_DELIVERY_FINISHED,
    `${prefix}-narration-finished`, { generationRevision: undefined }), { nowMs: base + 300 });
  assert.equal(result.state.txn.narrationDelivery, 'delivered');
  const positioned = reducePlayback(result.state, { type: PlaybackEventType.POSITION_REPORTED,
    eventId: `${prefix}-narration-position`, ...activationIdentity(result.state), positionSeconds: position }, { nowMs: base + 1_000 });
  return positioned.state;
}

test('re-activating the occurrence that is already current re-attaches it instead of restarting it', () => {
  const state = spokenActivation('self-reattach', [narrationContextTrack('one'), narrationContextTrack('two')]);
  const item = state.queue[state.currentIndex];
  const before = { positionSeconds: state.positionSeconds, revision: item.narration.generationRevision,
    ttsUrl: item.narration.ttsUrl, correlationId: state.txn.correlationId, lastOutput: state.lastOutputTrack?.songId ?? null };
  assert.equal(before.positionSeconds, 55);

  const again = reducePlayback(state, { type: PlaybackEventType.CARD_SELECTED, eventId: 'self-reattach-card',
    ...activationIdentity(state) }, { nowMs: 7_000 });
  assert.equal(again.accepted, true, again.reason);
  const after = again.state.queue[again.state.currentIndex];
  assert.equal(again.state.positionSeconds, 55, 'the confirmed position is not reset');
  assert.equal(again.commands[0].positionSeconds, 55, 'the re-attach carries the confirmed position');
  assert.equal(again.commands[0].resume, true);
  assert.equal(again.state.txn.correlationId, before.correlationId, 'the same transaction identity is kept');
  assert.equal(after.narration.status, 'ready');
  assert.equal(after.narration.generationRevision, before.revision, 'the introduction is not rewritten');
  assert.equal(after.narration.ttsUrl, before.ttsUrl);
  assert.deepEqual(again.effects, [], 'no prepare or asset resolution is started');
  assert.equal(again.state.txn.narrationDelivery, 'delivered', 'a spoken introduction is not owed again');
  assert.equal(again.state.lastOutputTrack?.songId ?? null, before.lastOutput,
    'the predecessor record is not overwritten with the track itself');
  assert.equal(again.state.diagnostics.some(entry => entry.type === 'track-narration-predecessor-changed'), false);
});

test('a retry after a media failure continues the same occurrence at its confirmed position', () => {
  const playing = finishActivation(commit(createPlaybackRuntimeState({ companionModeId: null }), [track('one'), track('two')]), 'retry-position');
  const atPosition = reducePlayback(playing, {
    type: PlaybackEventType.POSITION_REPORTED, eventId: 'retry-position-report', ...activationIdentity(playing),
    positionSeconds: 42,
  }, { nowMs: 5_000 });
  const failed = reducePlayback(atPosition.state, narrrationFailureIdentity(atPosition.state), { nowMs: 6_000 });
  assert.equal(failed.state.phase, PlaybackPhase.ERROR);

  const retried = reducePlayback(failed.state, { type: PlaybackEventType.RETRY_REQUESTED,
    eventId: 'retry-position-request', ...activationIdentity(failed.state, { runtimeVersion: failed.state.version }) },
    { nowMs: 7_000 });
  assert.equal(retried.accepted, true, retried.reason);
  assert.equal(retried.state.phase, PlaybackPhase.LOADING);
  assert.equal(retried.state.positionSeconds, 42);
  assert.equal(retried.commands[0].type, PlaybackCommandType.PLAY_TRACK);
  assert.equal(retried.commands[0].positionSeconds, 42);
  assert.equal(retried.state.txn.queueItemId, playing.txn.queueItemId);
});

function narrrationFailureIdentity(state) {
  return { type: PlaybackEventType.TRACK_FAILED, eventId: 'retry-position-failed', ...activationIdentity(state),
    error: 'media error' };
}

test('an introduction that was already heard is never rewritten or repeated when its occurrence returns', () => {
  let state = spokenActivation('spoken-return', [narrationContextTrack('one'), narrationContextTrack('two')]);
  const first = state.queue[state.currentIndex];
  const spokenText = first.narration.text;
  const spokenRevision = first.narration.generationRevision;

  // Move to the next track, then come back to the already heard one.
  const next = reducePlayback(state, { type: PlaybackEventType.NEXT_REQUESTED, eventId: 'spoken-return-next',
    ...activationIdentity(state) }, { nowMs: 7_000 });
  assert.equal(next.state.currentIndex, 1);
  const back = reducePlayback(next.state, { type: PlaybackEventType.CARD_SELECTED, eventId: 'spoken-return-back',
    ...activationIdentity(next.state, { runtimeVersion: next.state.version,
      queueItemId: first.queueItemId, songId: first.songId, programId: first.programId }) }, { nowMs: 8_000 });
  assert.equal(back.accepted, true, back.reason);
  const returned = back.state.queue[back.state.currentIndex];
  assert.equal(returned.queueItemId, first.queueItemId);
  assert.equal(returned.narration.text, spokenText, 'the heard introduction is kept as it was');
  assert.equal(returned.narration.generationRevision, spokenRevision);
  assert.equal(returned.narration.status, 'ready');
  assert.equal(back.state.txn.narrationDelivery, 'delivered', 'a heard introduction is not spoken again');
  // 回跳本身不发起串词工作；effects 里的预取是激活附带的滚动供歌，与串词无关。
  assert.deepEqual(back.effects.filter(effect => effect.type !== PlaybackEffectType.REQUEST_CONTINUATION), []);
  assert.equal(back.state.diagnostics.some(entry => entry.type === 'track-narration-predecessor-changed'), false);

  // The durable marker survives a restart.
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(back.state)));
  assert.equal(restored.queue[restored.currentIndex].narration.spoken, true);
});

test('a different occurrence still activates from its beginning', () => {
  const state = spokenActivation('fresh-occurrence', [narrationContextTrack('one'), narrationContextTrack('two')]);
  const other = state.queue[state.currentIndex + 1];
  const selected = reducePlayback(state, { type: PlaybackEventType.CARD_SELECTED, eventId: 'fresh-occurrence-card',
    ...activationIdentity(state, { queueItemId: other.queueItemId, songId: other.songId, programId: other.programId }) },
    { nowMs: 7_000 });
  assert.equal(selected.state.currentIndex, state.currentIndex + 1);
  assert.equal(selected.state.positionSeconds, 0);
  assert.equal(selected.commands[0].positionSeconds, undefined);
  assert.notEqual(selected.state.txn.correlationId, state.txn.correlationId);
  assert.equal(selected.state.lastOutputTrack.songId, 'one', 'the track that actually played is recorded');
});

test('an explicit request can still re-speak an introduction that was already heard', () => {
  const state = spokenActivation('spoken-request', [narrationContextTrack('one')]);
  const requested = reducePlayback(state, { type: PlaybackEventType.NARRATION_REQUESTED, eventId: 'spoken-request-ask',
    ...activationIdentity(state) }, { nowMs: 7_000 });
  assert.equal(requested.accepted, true, requested.reason);
  assert.equal(requested.state.txn.narrationUserRequested, true);
  assert.equal(requested.state.queue[requested.state.currentIndex].narration.spoken, true);
  assert.deepEqual(requested.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK_NARRATION],
    'an explicit listener request still re-opens a heard introduction');
});

// The runtime arms the insertion window when it receives the track-start fact, while the
// browser measures the media's own clock. Those clocks disagree by milliseconds, so a
// delivery confirmation routinely lands a hair before the settle; that must be waited for,
// never treated as an expired window (which silently discarded most introductions).
const SETTLE_POLICY = { settlingDelayMs: 1_000, maxStartOffsetMs: 20_000, minRemainingMs: 15_000 };

/** A track playing past its settle with a ready introduction queued for delivery. */
function queuedNarration(prefix) {
  const startMs = 2_000;
  let result = commit(createPlaybackRuntimeState({ narrationPolicy: SETTLE_POLICY, companionModeId: null }), [narrationContextTrack('one')],
    { nowMs: 1_000 });
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: `${prefix}-started`, runtimeVersion: result.state.version,
    queueItemId, songId: 'one', programId: 'program-a', correlationId,
    listeningSessionId: result.state.activeListeningSessionId, outputGeneration: result.state.outputGeneration,
    positionSeconds: 0,
  }, { nowMs: startMs });
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: `${prefix}-ready`, queueItemId, songId: 'one',
    programId: 'program-a', generationRevision: 1, listeningSessionId: result.state.activeListeningSessionId,
    text: '接下来是 Artist one 的《Title one》。', ttsUrl: '/one-narration.mp3', contentHash: 'hash',
  }, { nowMs: startMs + 500 });
  result = reducePlayback(result.state, narrationIdentity(result.state, PlaybackEventType.NARRATION_WINDOW_OPENED,
    `${prefix}-window`, { positionSeconds: 1.02, durationSeconds: 200, generationRevision: undefined }),
    { nowMs: startMs + 1_020 });
  assert.deepEqual(result.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK_NARRATION]);
  assert.equal(result.state.txn.narrationDelivery, 'queued');
  return { state: result.state, startMs, queueItemId, correlationId };
}

test('a narration confirmation that is a hair early waits for the settle instead of expiring', () => {
  const queued = queuedNarration('settle-race');
  const deliveryStarted = (state, eventId, positionSeconds, nowMs) => reducePlayback(state,
    narrationIdentity(state, PlaybackEventType.NARRATION_DELIVERY_STARTED, eventId, {
      positionSeconds, durationSeconds: 200, generationRevision: undefined }), { nowMs });

  // 945ms into the track: the runtime's own estimate says the window is open, the browser
  // is 55ms short of the settle.
  const early = deliveryStarted(queued.state, 'settle-race-early', 0.945, queued.startMs + 1_000);
  assert.equal(early.accepted, true, early.reason);
  assert.equal(early.state.txn.narrationDelivery, 'queued', 'an early confirmation is not expired');
  assert.equal(early.state.diagnostics.some(entry => entry.type === 'track-narration-skipped'), false);

  const settled = deliveryStarted(early.state, 'settle-race-settled', 1.05, queued.startMs + 1_100);
  assert.equal(settled.state.txn.narrationDelivery, 'starting', 'the retried confirmation is authorized');
  const audible = reducePlayback(settled.state, narrationIdentity(settled.state,
    PlaybackEventType.NARRATION_DELIVERY_AUDIBLE, 'settle-race-audible',
    { positionSeconds: 1.1, durationSeconds: 200, generationRevision: undefined }), { nowMs: queued.startMs + 1_200 });
  assert.equal(audible.state.txn.narrationDelivery, 'speaking');
  assert.equal(audible.state.queue[0].narration.spoken, true);
});

test('a merely early position report does not expire a queued narration, but a late one does', () => {
  const queued = queuedNarration('queue-expiry');
  const earlyPosition = reducePlayback(queued.state, {
    type: PlaybackEventType.POSITION_REPORTED, eventId: 'queue-expiry-early',
    ...activationIdentity(queued.state), positionSeconds: 0.6,
  }, { nowMs: queued.startMs + 600 });
  assert.equal(earlyPosition.state.txn.narrationDelivery, 'queued');

  const latePosition = reducePlayback(earlyPosition.state, {
    type: PlaybackEventType.POSITION_REPORTED, eventId: 'queue-expiry-late',
    ...activationIdentity(earlyPosition.state, { runtimeVersion: earlyPosition.state.version }), positionSeconds: 21,
  }, { nowMs: queued.startMs + 21_000 });
  assert.equal(latePosition.state.txn.narrationDelivery, 'skipped');
  assert.equal(latePosition.state.diagnostics.at(-1).reason, 'delivery-window-expired-before-start');
});

test('an audible introduction is kept even when the two clocks disagree', () => {
  const queued = queuedNarration('audible-race');
  const started = reducePlayback(queued.state, narrationIdentity(queued.state,
    PlaybackEventType.NARRATION_DELIVERY_STARTED, 'audible-race-authorized',
    { positionSeconds: 1.02, durationSeconds: 200, generationRevision: undefined }), { nowMs: queued.startMs + 1_050 });
  assert.equal(started.state.txn.narrationDelivery, 'starting');
  const audible = reducePlayback(started.state, narrationIdentity(started.state,
    PlaybackEventType.NARRATION_DELIVERY_AUDIBLE, 'audible-race-early',
    { positionSeconds: 0.99, durationSeconds: 200, generationRevision: undefined }), { nowMs: queued.startMs + 1_060 });
  assert.equal(audible.state.txn.narrationDelivery, 'speaking',
    'an already sounding introduction is not discarded over milliseconds');
  assert.equal(audible.state.queue[0].narration.spoken, true);
});

test('narration synthesis failure (all providers) leaves queue/phase/generation untouched and records no listening observation', () => {
  // 复用按需串词的驱动方式：提交 → started → 串词准备失败（对应 synthesize 全 provider 失败
  // 被 composer 的 bounded 捕获后上报的 TRACK_NARRATION_FAILED）。
  let result = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('one', { virtualPersonId: 'vp-x' })], { nowMs: 1_000 });
  const queueItemId = result.state.queue[0].queueItemId;
  const correlationId = result.state.txn.correlationId;
  result = reducePlayback(result.state, {
    type: PlaybackEventType.TRACK_STARTED, eventId: 'all-failed-started',
    runtimeVersion: result.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: result.state.activeListeningSessionId,
    outputGeneration: result.state.outputGeneration, positionSeconds: 0,
  }, { nowMs: 2_000 });

  const before = result.state;
  const beforeQueueIdentity = before.queue.map(item => `${item.queueItemId}:${item.songId}`);
  const failed = reducePlayback(before, {
    type: PlaybackEventType.TRACK_NARRATION_FAILED, eventId: 'all-providers-failed',
    queueItemId, songId: 'one', programId: 'program-a', generationRevision: 1,
    listeningSessionId: before.activeListeningSessionId, error: 'TTS_ALL_PROVIDERS_FAILED',
  }, { nowMs: 40_000 });

  assert.equal(failed.state.queue[0].narration.status, 'failed');
  assert.equal(failed.state.phase, before.phase, '合成失败不得改变播放阶段');
  assert.equal(failed.state.outputGeneration, before.outputGeneration, '合成失败不得推进输出代次');
  assert.equal(failed.state.currentSongId, before.currentSongId, '合成失败不得切歌');
  assert.deepEqual(
    failed.state.queue.map(item => `${item.queueItemId}:${item.songId}`),
    beforeQueueIdentity,
    '合成失败不得增删或重排队列项',
  );

  // 观察契约：串词失败不是听歌观察。桥必须对这类事件零写入、零发布。
  const appended = [];
  const published = [];
  const reflection = {
    disabled: false,
    store: {
      db: {},
      append: record => { appended.push(record); return true; },
      programOwner: () => ({ personId: 'vp-x', sessionId: 'sess-x', requestId: 'request-a' }),
      requestOwner: () => null,
      rememberProgram() {},
      now: () => 0,
    },
    bus: { publishEvent: event => published.push(event) },
    _kick() {},
  };
  const bridge = new ListeningReflectionBridge({ reflection });
  bridge.observe(failed.state, {
    type: PlaybackEventType.TRACK_NARRATION_FAILED, eventId: 'all-providers-failed',
    queueItemId, songId: 'one', programId: 'program-a',
    listeningSessionId: failed.state.activeListeningSessionId, error: 'TTS_ALL_PROVIDERS_FAILED',
  }, before);
  assert.deepEqual(appended, [], '串词合成失败不得产生听歌观察');
  assert.deepEqual(published, [], '串词合成失败不得发布观察事件');

  // 对照组：同一状态下的 TRACK_ENDED 仍然产生 completed 观察，证明 spy 本身是通的。
  const ended = reducePlayback(failed.state, {
    type: PlaybackEventType.TRACK_ENDED, eventId: 'control-natural-end', natural: true,
    runtimeVersion: failed.state.version, queueItemId, songId: 'one', programId: 'program-a',
    correlationId, listeningSessionId: failed.state.activeListeningSessionId,
    outputGeneration: failed.state.outputGeneration,
  }, { nowMs: 50_000 });
  bridge.observe(ended.state, {
    type: PlaybackEventType.TRACK_ENDED, eventId: 'control-natural-end', natural: true,
    songId: 'one', programId: 'program-a', correlationId,
  }, failed.state);
  assert.equal(appended.length, 1, '对照组必须真的写入观察，否则断言无效');
});

test('a memory change invalidates prepared-but-unheard narration without touching current or spoken', () => {
  const committed = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('one'), narrationContextTrack('two')], { nowMs: 1_000 });
  const two = committed.state.queue[1];
  let state = finishActivation(committed, 'first-of-two');
  // 当前曲的串词已备好但尚未播（处于 delivery 窗口前），即将到来那一首的串词也备好了。
  state = reducePlayback(state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'current-ready',
    queueItemId: state.queue[0].queueItemId, songId: 'one', programId: 'program-a',
    generationRevision: state.queue[0].narration.generationRevision,
    listeningSessionId: state.activeListeningSessionId,
    text: '接下来是 Artist one 的《Title one》。这首歌可以安静听下去。', ttsUrl: '/one-tts.mp3',
    previousSongId: null,
  }, { nowMs: 5_000 }).state;
  state = reducePlayback(state, {
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'upcoming-ready',
    queueItemId: two.queueItemId, songId: 'two', programId: 'program-a',
    generationRevision: state.queue[1].narration.generationRevision,
    listeningSessionId: state.activeListeningSessionId,
    text: '接下来是 Artist two 的《Title two》。这首歌可以安静听下去。', ttsUrl: '/two-tts.mp3',
    previousSongId: 'one',
  }, { nowMs: 6_000 }).state;
  assert.equal(state.queue[1].narration.status, 'ready');

  const stale = reducePlayback(state, {
    type: PlaybackEventType.NARRATION_CONTEXT_STALE_REQUESTED, eventId: 'memory-changed',
    listeningSessionId: state.activeListeningSessionId,
  }, { nowMs: 7_000 });
  assert.equal(stale.accepted, true, stale.reason);
  // 未播的 prepared 串词失效并当场重备（status → preparing，旧音频与承接记录被清空）。
  assert.equal(stale.state.queue[1].narration.status, 'preparing');
  assert.ok(stale.state.queue[1].narration.generationRevision > state.queue[1].narration.generationRevision);
  assert.equal(stale.state.queue[1].narration.ttsUrl, null);
  assert.equal(stale.state.queue[1].narration.previousSongId, null);
  assert.ok(stale.state.diagnostics.some(entry => entry.type === 'track-narration-invalidated-by-memory'
    && entry.queueItemIds.includes(two.queueItemId)));
  assert.deepEqual(stale.effects.map(effect => effect.type), [PlaybackEffectType.PREPARE_TRACK_NARRATION]);
  assert.equal(stale.effects[0].queueItemId, two.queueItemId);
  // 正在播的当前曲不受影响：仍然 ready，可以被说出。
  assert.equal(stale.state.queue[0].narration.status, 'ready');
  assert.equal(stale.state.queue[0].narration.ttsUrl, '/one-tts.mp3');
  // 没有可失效内容时不空转。
  const again = reducePlayback(stale.state, {
    type: PlaybackEventType.NARRATION_CONTEXT_STALE_REQUESTED, eventId: 'memory-changed-again',
    listeningSessionId: stale.state.activeListeningSessionId,
  }, { nowMs: 8_000 });
  assert.equal(again.accepted, true);
  assert.equal(again.effects.length, 0);
  // 校验：必须携带 listeningSessionId。
  const invalid = reducePlayback(state, { type: PlaybackEventType.NARRATION_CONTEXT_STALE_REQUESTED, eventId: 'missing-session' });
  assert.equal(invalid.accepted, false);
});

test('life authorization change cancels the current ready introduction and rejects late preparation', () => {
  const committed = commit(createPlaybackRuntimeState({ companionModeId: null }), [narrationContextTrack('private')]);
  let state = finishActivation(committed, 'private');
  const identity = state.queue[0];
  const oldRevision = identity.narration.generationRevision;
  const stale = reducePlayback(state, { type: PlaybackEventType.NARRATION_CONTEXT_STALE_REQUESTED,
    eventId: 'life-revoked', listeningSessionId: state.activeListeningSessionId, includeCurrent: true });
  assert.equal(stale.state.txn.narrationDelivery, 'skipped');
  assert.equal(stale.state.queue[0].narration.status, 'absent');
  assert.ok(stale.state.queue[0].narration.generationRevision > oldRevision);
  const late = reducePlayback(stale.state, { type: PlaybackEventType.TRACK_NARRATION_READY,
    eventId: 'private-late', queueItemId: identity.queueItemId, songId: identity.songId,
    programId: identity.programId, generationRevision: oldRevision,
    listeningSessionId: state.activeListeningSessionId, text: 'private', ttsUrl: '/private.mp3' });
  assert.equal(late.state.queue[0].narration.status, 'absent');
  assert.equal(late.state.txn.narrationDelivery, 'skipped');
});

// ---- 封面元数据补全（metadata-only） ----

const ARTWORK = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000001bkv9c0gpIvm.jpg';

function artworkEvent(state, { eventId = 'artwork-1', queueItemId, artwork = ARTWORK, overrides = {} } = {}) {
  return {
    type: PlaybackEventType.TRACK_ARTWORK_RESOLVED,
    eventId,
    listeningSessionId: state.activeListeningSessionId,
    queueItemId: queueItemId || state.queue[0].queueItemId,
    artwork,
    ...overrides,
  };
}

test('artwork repair only changes the artwork field and the runtime version', () => {
  const committed = commit(createPlaybackRuntimeState(), [track('a'), track('b')]);
  assert.equal(committed.accepted, true, committed.reason);
  const before = committed.state;
  const target = before.queue[1].queueItemId;
  assert.equal(before.queue[1].artwork, null);

  const repaired = reducePlayback(before, artworkEvent(before, { queueItemId: target }), { nowMs: 2_000 });
  assert.equal(repaired.accepted, true, repaired.reason);
  assert.deepEqual(repaired.commands, []);
  assert.deepEqual(repaired.effects, []);
  assert.equal(repaired.state.version, before.version + 1);
  assert.equal(repaired.state.queue[1].artwork, ARTWORK);

  const normalize = value => JSON.parse(JSON.stringify(value));
  const strip = state => {
    const copy = normalize(state);
    delete copy.version;
    delete copy.processedEventIds;
    copy.queue.forEach(item => { delete item.artwork; });
    return copy;
  };
  assert.deepEqual(strip(repaired.state), strip(before), 'no other field may change');
});

test('artwork repair is idempotent and refuses to overwrite an existing cover', () => {
  const committed = commit(createPlaybackRuntimeState(), [track('a')]);
  const target = committed.state.queue[0].queueItemId;
  const first = reducePlayback(committed.state, artworkEvent(committed.state, { queueItemId: target }), { nowMs: 2_000 });
  assert.equal(first.accepted, true, first.reason);

  const duplicate = reducePlayback(first.state, artworkEvent(first.state, { queueItemId: target }), { nowMs: 3_000 });
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate event');

  const different = reducePlayback(first.state, artworkEvent(first.state, {
    eventId: 'artwork-2', queueItemId: target, artwork: 'https://example.test/other.jpg',
  }), { nowMs: 3_000 });
  assert.equal(different.accepted, false);
  assert.equal(different.reason, 'artwork already present');
  assert.equal(different.state.queue[0].artwork, ARTWORK);
});

test('artwork repair fails closed for unknown targets, inactive sessions, bad values and stale versions', () => {
  const committed = commit(createPlaybackRuntimeState(), [track('a'), track('b')]);
  const state = committed.state;
  const target = state.queue[0].queueItemId;

  const cases = [
    [{ queueItemId: 'queue:missing' }, 'artwork repair target is not in the queue'],
    [{ overrides: { listeningSessionId: 'other-session' } }, 'artwork repair targets an inactive listening session'],
    [{ overrides: { runtimeVersion: state.version - 1 } }, 'stale runtime version'],
    [{ artwork: '' }, 'artwork repair requires a bounded artwork URL'],
    [{ artwork: `https://a/${'x'.repeat(4096)}` }, 'artwork repair requires a bounded artwork URL'],
    [{ artwork: 42 }, 'artwork repair requires a bounded artwork URL'],
  ];
  for (const [options, reason] of cases) {
    const attempt = reducePlayback(state, artworkEvent(state, { queueItemId: target, ...options }), { nowMs: 2_000 });
    assert.equal(attempt.accepted, false, `expected rejection for ${reason}`);
    assert.equal(attempt.reason, reason);
    assert.equal(attempt.state, state, 'a rejected repair must not touch the snapshot');
  }
});
