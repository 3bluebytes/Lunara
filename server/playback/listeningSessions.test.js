import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackRuntimeState, reducePlayback, hydratePlaybackRuntimeState, listeningSnapshot,
  resumeCommandsForState } from './PlaybackRuntime.js';
import { PlaybackRuntimeHost } from './PlaybackRuntimeHost.js';

const song = id => ({ songId: id, programId: `program-${id}`, requestId: `request-${id}`, title: id,
  artist: 'artist', url: `/${id}.mp3`, duration: 200, intro: { text: `这是 ${id}` } });
let seq = 0;
function send(state, type, values = {}) {
  return reducePlayback(state, { type, eventId: `test-${++seq}`, ...values });
}
function identity(state) {
  return { runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, songId: state.currentSongId,
    programId: state.txn?.programId, correlationId: state.txn?.correlationId };
}
function play(state, id, songs) {
  const committed = send(state, 'PROGRAM_COMMITTED', { listeningSessionId: id, delivery: 'replace_now', tracks: songs.map(song) });
  assert.equal(committed.accepted, true);
  return send(committed.state, 'TRACK_STARTED', identity(committed.state)).state;
}

test('A and B have separate queues and positions; returning to A resumes without repeating its intro', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['rnb-1', 'rnb-2']);
  const aEvent = identity(state);
  state = send(state, 'POSITION_REPORTED', { ...aEvent, positionSeconds: 42 }).state;
  state = play(state, 'conversation:b', ['rap-1', 'rap-2']);
  assert.deepEqual(state.queue.map(item => item.songId), ['rap-1', 'rap-2']);
  const a = listeningSnapshot(state, 'conversation:a');
  assert.deepEqual(a.queue.map(item => item.songId), ['rnb-1', 'rnb-2']);
  assert.equal(a.positionSeconds, 42);
  assert.equal(a.phase, 'paused');
  assert.doesNotMatch(JSON.stringify(a), /rap-/);
  const late = send(state, 'TRACK_ENDED', { ...aEvent, runtimeVersion: state.version, natural: true });
  assert.equal(late.accepted, false);
  assert.equal(late.state.currentSongId, 'rap-1');
  const returned = send(state, 'LISTENING_SESSION_SWITCH_REQUESTED', {
    listeningSessionId: 'conversation:a', outputGeneration: state.outputGeneration, positionSeconds: 18,
  });
  assert.equal(returned.state.currentSongId, 'rnb-1');
  assert.equal(returned.state.positionSeconds, 42);
  assert.equal(returned.state.suspendedSessions['conversation:b'].positionSeconds, 18);
  assert.deepEqual(returned.commands.map(command => command.type), ['STOP_PLAYBACK', 'PLAY_TRACK']);
  assert.equal(returned.commands[1].positionSeconds, 42);
  assert.equal(returned.effects.length, 0);
});

test('an after-current switch wins over A next track and continuation, and can be cancelled', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['rnb-1', 'rnb-2']);
  state = send(state, 'PROGRAM_COMMITTED', { listeningSessionId: 'conversation:b', delivery: 'append', tracks: [song('rap-1')] }).state;
  const scheduled = send(state, 'LISTENING_SESSION_SWITCH_REQUESTED', { listeningSessionId: 'conversation:b', delivery: 'after_current' });
  assert.equal(scheduled.commands.length, 0);
  assert.equal(scheduled.state.currentSongId, 'rnb-1');
  const ended = send(scheduled.state, 'TRACK_ENDED', { ...identity(scheduled.state), natural: true });
  assert.equal(ended.state.activeListeningSessionId, 'conversation:b');
  assert.equal(ended.state.currentSongId, 'rap-1');
  // 激活 rap-1 顺带预取 B 自己的下一批；不得出现 A 的续播请求。
  assert.ok(ended.effects.every(effect => effect.listeningSessionId === 'conversation:b'),
    JSON.stringify(ended.effects));
  assert.equal(ended.state.suspendedSessions['conversation:a'].currentSongId, 'rnb-2');
  const cancelled = send(scheduled.state, 'LISTENING_SWITCH_CANCELLED');
  const stay = send(cancelled.state, 'TRACK_ENDED', { ...identity(cancelled.state), natural: true });
  assert.equal(stay.state.currentSongId, 'rnb-2');
  assert.equal(stay.state.activeListeningSessionId, 'conversation:a');
});

test('background queue edits cannot emit playback, continuation, or consume another room queue revision', () => {
  const a = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['rnb']);
  const prepared = send(a, 'PROGRAM_COMMITTED', { listeningSessionId: 'conversation:b', delivery: 'append', tracks: [song('rap')] });
  assert.equal(prepared.state.currentSongId, 'rnb');
  assert.equal(prepared.commands.length, 0);
  assert.equal(prepared.effects.length, 0);
  const changed = send(prepared.state, 'LISTENING_PLAN_CHANGED', { listeningSessionId: 'conversation:b', plan: { genre: 'Rap' } }).state;
  const stale = send(changed, 'PROGRAM_COMMITTED', { listeningSessionId: 'conversation:b', delivery: 'append',
    expectedQueueVersion: 0, tracks: [song('stale')] });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale listening queue version');
  assert.equal(listeningSnapshot(changed, 'conversation:a').listeningPlan, null);
  const late = send(changed, 'PROGRAM_COMMITTED', { listeningSessionId: 'conversation:b', delivery: 'append', source: 'auto_continue',
    continuationBoundaryKey: 'old', tracks: [song('wrong-auto')] });
  assert.equal(late.accepted, false);
});

test('restart preserves every listening position and restores the active one as an unconfirmed activation', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['rnb']);
  state = send(state, 'POSITION_REPORTED', { ...identity(state), positionSeconds: 36 }).state;
  state = play(state, 'conversation:b', ['rap']);
  state = send(state, 'POSITION_REPORTED', { ...identity(state), positionSeconds: 64 }).state;
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.phase, 'loading');
  assert.equal(restored.currentSongId, 'rap');
  assert.equal(restored.positionSeconds, 64);
  assert.equal(listeningSnapshot(restored, 'conversation:a').positionSeconds, 36);
  assert.equal(listeningSnapshot(restored, 'conversation:a').phase, 'paused');
  const [reattach] = resumeCommandsForState(restored);
  assert.equal(reattach.type, 'PLAY_TRACK');
  assert.equal(reattach.url, '/rap.mp3');
  assert.equal(reattach.positionSeconds, 64);
  assert.equal(reattach.queueItemId, restored.txn.queueItemId);
  assert.equal(reattach.correlationId, restored.txn.correlationId);
  const resumed = send(restored, 'RESUME_REQUESTED', identity(restored));
  assert.equal(resumed.commands[0].type, 'PLAY_TRACK');
  assert.equal(resumed.commands[0].positionSeconds, 64);
  assert.equal(resumed.commands[0].queueItemId, restored.txn.queueItemId);
  assert.equal(resumed.commands[0].correlationId, restored.txn.correlationId);
  const pausedAfterRestart = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(
    send(state, 'PAUSE_REQUESTED', { ...identity(state), positionSeconds: 64 }).state)));
  assert.equal(pausedAfterRestart.phase, 'paused');
  assert.deepEqual(resumeCommandsForState(pausedAfterRestart), []);
  const explicit = send(pausedAfterRestart, 'RESUME_REQUESTED', identity(pausedAfterRestart));
  assert.equal(explicit.commands[0].type, 'RESUME_TRACK');
  assert.equal(explicit.commands[0].url, '/rap.mp3');
  assert.equal(explicit.commands[0].positionSeconds, 64);
  assert.equal(explicit.commands[0].queueItemId, pausedAfterRestart.txn.queueItemId);
  assert.equal(explicit.commands[0].correlationId, pausedAfterRestart.txn.correlationId);
  assert.equal(explicit.commands[0].narrationGenerationRevision, pausedAfterRestart.txn.narrationGenerationRevision);
});

test('failed durable playback write cannot switch output or publish an uncommitted queue', async () => {
  const commands = [];
  const host = new PlaybackRuntimeHost({ persistence: { save() { throw new Error('disk full'); } },
    commandSink: command => commands.push(command) });
  const result = await host.submit({ type: 'PROGRAM_COMMITTED', eventId: 'disk', listeningSessionId: 'conversation:a',
    delivery: 'replace_now', tracks: [song('rnb')] });
  assert.equal(result.accepted, false);
  assert.equal(host.snapshot().queue.length, 0);
  assert.equal(commands.length, 0);
});

test('the explicit auto-continue switch survives new plans and stays scoped to its listening session', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['one']);
  state = send(state, 'RADIO_MODE_CHANGED', { enabled: false }).state;
  state = send(state, 'PROGRAM_COMMITTED', { delivery: 'replace_now', tracks: [song('two')],
    listeningPlan: { request: { mode: 'discovery', continueMode: 'same' } } }).state;
  assert.equal(state.radioMode, false);
  state = play(state, 'conversation:b', ['three']);
  assert.equal(state.radioMode, true);
  state = send(state, 'LISTENING_SESSION_SWITCH_REQUESTED', { listeningSessionId: 'conversation:a' }).state;
  assert.equal(state.radioMode, false);
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.radioModeOverride, false);
});

test('enabling auto-continue after exhaustion starts once; disabling cancels the pending result', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['one']);
  state = send(state, 'RADIO_MODE_CHANGED', { enabled: false }).state;
  const ended = send(state, 'TRACK_ENDED', { ...identity(state), natural: true });
  assert.equal(ended.effects.length, 0);
  const enabled = send(ended.state, 'RADIO_MODE_CHANGED', { enabled: true });
  assert.equal(enabled.effects[0].type, 'REQUEST_CONTINUATION');
  const pendingKey = enabled.state.pendingContinuation.boundaryKey;
  const repeated = send(enabled.state, 'RADIO_MODE_CHANGED', { enabled: true });
  assert.equal(repeated.effects.length, 0);
  const disabled = send(repeated.state, 'RADIO_MODE_CHANGED', { enabled: false });
  const late = send(disabled.state, 'PROGRAM_COMMITTED', { source: 'auto_continue', delivery: 'append',
    continuationBoundaryKey: pendingKey, tracks: [song('late')] });
  assert.equal(late.accepted, false);
  assert.equal(late.state.queue.length, 1);
  const retry = send(disabled.state, 'RADIO_MODE_CHANGED', { enabled: true });
  assert.equal(retry.effects.length, 1);
  assert.notEqual(retry.state.pendingContinuation.boundaryKey, pendingKey);
});

test('a failed continuation can be explicitly retried without replaying the finished song', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['one']);
  state = send(state, 'TRACK_ENDED', { ...identity(state), natural: true }).state;
  state = send(state, 'CONTINUATION_FAILED', { boundaryKey: state.pendingContinuation.boundaryKey, error: 'unavailable' }).state;
  const retry = send(state, 'RADIO_MODE_CHANGED', { enabled: true });
  assert.equal(retry.state.pendingContinuation.status, 'requested');
  assert.equal(retry.state.lastError, null);
  assert.equal(retry.effects.length, 1);
  assert.equal(retry.commands.length, 0);
});

test('continue controls recover an exhausted radio session instead of becoming accepted no-ops', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['one']);
  state = send(state, 'TRACK_ENDED', { ...identity(state), natural: true }).state;
  state = send(state, 'CONTINUATION_FAILED', { boundaryKey: state.pendingContinuation.boundaryKey, error: 'unavailable' }).state;

  for (const type of ['RESUME_REQUESTED', 'RETRY_REQUESTED', 'LISTENING_SESSION_SWITCH_REQUESTED']) {
    const result = send(state, type, type === 'LISTENING_SESSION_SWITCH_REQUESTED'
      ? { listeningSessionId: 'conversation:a' }
      : identity(state));
    assert.equal(result.accepted, true, type);
    assert.equal(result.state.pendingContinuation.status, 'requested', type);
    assert.equal(result.effects.length, 1, type);
    assert.equal(result.effects[0].type, 'REQUEST_CONTINUATION', type);
    assert.equal(result.commands.length, 0, type);
  }
});

test('a memory change invalidates a suspended session prepared narration without emitting effects', () => {
  const narrated = id => ({ ...song(id), intro: { text: `这是 ${id}`, context: { transition: 'next' } } });
  const playNarrated = (state, id, ids) => {
    const committed = send(state, 'PROGRAM_COMMITTED', { listeningSessionId: id, delivery: 'replace_now', tracks: ids.map(narrated) });
    assert.equal(committed.accepted, true, committed.reason);
    return send(committed.state, 'TRACK_STARTED', identity(committed.state)).state;
  };
  // 显式选择逐首模式，继续验证指定会话的模式更新与准备边界。
  let state = send(createPlaybackRuntimeState(), 'COMPANION_MODE_CHANGED',
    { listeningSessionId: 'conversation:a', modeId: 'conversational', requestId: 'mode-a' }).state;
  state = playNarrated(state, 'conversation:a', ['rnb-1', 'rnb-2']);
  const ready = send(state, 'TRACK_NARRATION_READY', {
    queueItemId: state.queue[1].queueItemId, songId: 'rnb-2', programId: 'program-rnb-2',
    generationRevision: state.queue[1].narration.generationRevision,
    listeningSessionId: 'conversation:a',
    text: '接下来是 artist 的《rnb-2》。这首歌可以安静听下去。', ttsUrl: '/rnb-2-tts.mp3', previousSongId: 'rnb-1',
  });
  assert.equal(ready.accepted, true, ready.reason);
  assert.equal(ready.state.queue[1].narration.status, 'ready');
  // 挂起 a：切到 b 播放。
  state = play(ready.state, 'conversation:b', ['rap-1']);
  assert.equal(state.suspendedSessions['conversation:a'].queue[1].narration.status, 'ready');
  const stale = send(state, 'NARRATION_CONTEXT_STALE_REQUESTED', { listeningSessionId: 'conversation:a' });
  assert.equal(stale.accepted, true, stale.reason);
  assert.equal(stale.effects.length, 0, '挂起会话的失效不得触发任何效果');
  assert.equal(stale.commands.length, 0);
  assert.equal(stale.state.suspendedSessions['conversation:a'].queue[1].narration.status, 'absent');
  assert.equal(stale.state.currentSongId, 'rap-1');
});

test('removing a deleted conversation drops its suspended playback state and never touches the active one', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['rnb-1', 'rnb-2']);
  state = play(state, 'conversation:b', ['rap-1']);
  assert.ok(state.suspendedSessions['conversation:a']);

  const removed = send(state, 'LISTENING_SESSION_REMOVED', { listeningSessionId: 'conversation:a' });
  assert.equal(removed.accepted, true, removed.reason);
  assert.equal('conversation:a' in removed.state.suspendedSessions, false);
  // 活动会话、当前歌曲、命令与效果都不受影响：删除挂起会话不是一次播放动作。
  assert.equal(removed.state.activeListeningSessionId, 'conversation:b');
  assert.equal(removed.state.currentSongId, 'rap-1');
  assert.equal(removed.commands.length, 0);
  assert.equal(removed.effects.length, 0);
  // 幂等：同一事件不重复生效，再次删除同一个会话是无害 no-op。
  assert.equal(send(removed.state, 'LISTENING_SESSION_REMOVED', { listeningSessionId: 'conversation:a' }).accepted, true);

  // 在听的那一个会话不能被删掉：必须先切走，否则等于静默停播。
  const active = send(removed.state, 'LISTENING_SESSION_REMOVED', { listeningSessionId: 'conversation:b' });
  assert.equal(active.accepted, false);
  assert.equal(active.reason, 'active listening session');
  assert.equal(active.state.activeListeningSessionId, 'conversation:b');
});

test('removing a pending switch target cancels the switch instead of resurrecting the deleted session', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['rnb-1', 'rnb-2']);
  const scheduled = send(state, 'LISTENING_SESSION_SWITCH_REQUESTED', {
    listeningSessionId: 'conversation:b', delivery: 'after_current',
  });
  assert.equal(scheduled.state.pendingSwitch.listeningSessionId, 'conversation:b');
  const removed = send(scheduled.state, 'LISTENING_SESSION_REMOVED', { listeningSessionId: 'conversation:b' });
  assert.equal(removed.accepted, true, removed.reason);
  assert.equal(removed.state.pendingSwitch, null);
  const ended = send(removed.state, 'TRACK_ENDED', { ...identity(removed.state), natural: true });
  assert.equal(ended.state.activeListeningSessionId, 'conversation:a');
  assert.equal(ended.state.currentSongId, 'rnb-2');
  assert.equal('conversation:b' in ended.state.suspendedSessions, false);
});

test('returning to a session starts its saved track without an old failure still attached', () => {
  let state = play(createPlaybackRuntimeState({ companionModeId: null }), 'conversation:a', ['rnb-1', 'rnb-2']);
  state = play(state, 'conversation:b', ['rap-1']);
  const snapshot = JSON.parse(JSON.stringify(state));
  snapshot.suspendedSessions['conversation:a'].lastError = { type: 'track-failed', message: 'old failure' };
  const returned = send(hydratePlaybackRuntimeState(snapshot), 'LISTENING_SESSION_SWITCH_REQUESTED',
    { listeningSessionId: 'conversation:a' });
  assert.equal(returned.accepted, true, returned.reason);
  assert.equal(returned.state.currentSongId, 'rnb-1');
  assert.ok(returned.commands.some(command => command.type === 'PLAY_TRACK'));
  assert.equal(returned.state.lastError, null, '重新起播的这一首不能挂着上一次的失败');
});
