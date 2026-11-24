// 播放中断后的时间感：停得够久再接着放，停下之前写好、没说出口的串词作废并交给 host 重写。
import assert from 'node:assert/strict';
import test from 'node:test';

import { PLAYBACK_GAP_MS, createPlaybackRuntimeState, hydratePlaybackRuntimeState, reducePlayback } from './PlaybackRuntime.js';
import { PlaybackEffectType, PlaybackEventType, PlaybackPhase } from './playbackRuntimeTypes.js';

const HOUR = 60 * 60 * 1000;
const T0 = 10 * HOUR;

function track(songId, { writtenAt = T0 - 60_000, status = 'ready' } = {}) {
  return { songId, programId: 'program-a', requestId: 'request-a', title: `Title ${songId}`, artist: `Artist ${songId}`,
    url: `/${songId}.mp3`, duration: 200,
    narration: status === 'ready'
      ? { status, assetStatus: 'missing', text: `《Title ${songId}》这首。`, about: `想说 ${songId}`, generationRevision: 1, writtenAt }
      : { status, generationRevision: 1 } };
}

function identity(state) {
  if (!state.txn) return { songId: state.currentSongId, listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration };
  return { songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
    queueItemId: state.txn.queueItemId, listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration };
}

let seq = 0;
function reduce(state, event, nowMs) {
  seq += 1;
  const result = reducePlayback(state, { eventId: `gap-${seq}`, runtimeVersion: state.version, ...event }, { nowMs });
  assert.equal(result.accepted, true, result.reason);
  return result;
}

function playing(tracks, nowMs = T0) {
  const committed = reduce(createPlaybackRuntimeState({ companionModeId: null }),
    { type: PlaybackEventType.PROGRAM_COMMITTED, delivery: 'replace_now', source: 'user', tracks }, nowMs);
  return reduce(committed.state, { type: PlaybackEventType.TRACK_STARTED, ...identity(committed.state) }, nowMs + 1_000).state;
}

const pause = (state, nowMs, positionSeconds = 40) => reduce(state,
  { type: PlaybackEventType.PAUSE_REQUESTED, ...identity(state), positionSeconds }, nowMs).state;
const resume = (state, nowMs) => reduce(state, { type: PlaybackEventType.RESUME_REQUESTED, ...identity(state) }, nowMs);
const rewrites = result => result.effects.filter(effect => effect.type === PlaybackEffectType.REWRITE_TRACK_LINES);

test('确认出声、播放中的进度回报和暂停都记下最后出声时间', () => {
  let state = playing([track('one'), track('two')]);
  assert.equal(state.lastAudibleAtMs, T0 + 1_000);
  state = reduce(state, { type: PlaybackEventType.POSITION_REPORTED, ...identity(state), positionSeconds: 20 }, T0 + 21_000).state;
  assert.equal(state.lastAudibleAtMs, T0 + 21_000);
  state = pause(state, T0 + 40_000);
  assert.equal(state.lastAudibleAtMs, T0 + 40_000);
  state = reduce(state, { type: PlaybackEventType.POSITION_REPORTED, ...identity(state), positionSeconds: 40 }, T0 + 90_000).state;
  assert.equal(state.lastAudibleAtMs, T0 + 40_000, '暂停中的进度回报不算出声');
});

test('暂停不到一小时：写好的串词原样保留', () => {
  const state = pause(playing([track('one'), track('two')]), T0 + 40_000);
  const resumed = resume(state, T0 + 40_000 + 20 * 60_000);
  assert.deepEqual(rewrites(resumed), []);
  assert.equal(resumed.state.queue[1].narration.status, 'ready');
  assert.equal(resumed.state.queue[1].narration.text, '《Title two》这首。');
  assert.equal(resumed.state.queue[1].narration.about, '想说 two', '要点备忘跟着串词留下');
});

test('停了一夜再继续：中途接着放的这首不补说，后面的旧串词作废并开新代次交给 host 重写', () => {
  const state = pause(playing([track('one'), track('two'), track('three')]), T0 + 40_000);
  const resumedAt = T0 + 40_000 + 9 * HOUR;
  const resumed = resume(state, resumedAt);
  const [one, two, three] = resumed.state.queue;
  assert.equal(resumed.state.phase, PlaybackPhase.PLAYING, '音乐照常接着放');
  assert.equal(one.narration.status, 'absent', '从中途接着放的这首只作废');
  assert.equal(two.narration.status, 'preparing');
  assert.equal(one.narration.about, null, '作废的串词连要点备忘一起清掉');
  assert.equal(two.narration.about, null);
  assert.equal(two.narration.generationRevision, 2);
  assert.equal(two.narration.text, '');
  assert.equal(three.narration.status, 'preparing');
  assert.deepEqual(rewrites(resumed).map(effect => ({ ...effect })), [{ type: PlaybackEffectType.REWRITE_TRACK_LINES,
    listeningSessionId: resumed.state.activeListeningSessionId, outputGeneration: resumed.state.outputGeneration,
    queueItemIds: [two.queueItemId, three.queueItemId], stoppedAtMs: T0 + 40_000, resumedAtMs: resumedAt,
    runtimeVersion: resumed.state.version }]);
  assert.ok(resumed.state.diagnostics.some(item => item.type === 'track-line-dropped' && item.reason === 'playback-gap'));

  const again = resume(pause(resumed.state, resumedAt + 1_000), resumedAt + 2_000);
  assert.deepEqual(rewrites(again), [], '同一次停顿只处理一次');
});

test('停下之后才写好的串词不算旧的；没说出口才处理，最多重写 5 首', () => {
  const tracks = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
    .map((id, index) => track(id, { writtenAt: index === 1 ? T0 + 2 * HOUR : T0 - 60_000 }));
  const state = pause(playing(tracks), T0 + 40_000);
  const resumed = resume(state, T0 + 5 * HOUR);
  const statuses = resumed.state.queue.map(item => item.narration.status);
  assert.deepEqual(statuses, ['absent', 'ready', 'preparing', 'preparing', 'preparing', 'preparing', 'preparing', 'absent']);
  assert.equal(rewrites(resumed)[0].queueItemIds.length, 5);
});

test('迟到的旧代次结果被挡掉，新代次的重写正常入账', () => {
  const state = pause(playing([track('one'), track('two')]), T0 + 40_000);
  const resumed = resume(state, T0 + 3 * HOUR).state;
  const two = resumed.queue[1];
  const line = generationRevision => ({ type: PlaybackEventType.TRACK_NARRATION_READY, queueItemId: two.queueItemId,
    songId: 'two', programId: 'program-a', generationRevision, listeningSessionId: resumed.activeListeningSessionId,
    text: '《Title two》，早上好。', writtenAt: T0 + 3 * HOUR + 5_000 });
  const stale = reducePlayback(resumed, { eventId: 'stale-line', runtimeVersion: resumed.version, ...line(1) }, { nowMs: T0 + 3 * HOUR + 5_000 });
  assert.equal(stale.accepted, false);
  const fresh = reduce(resumed, line(2), T0 + 3 * HOUR + 6_000);
  assert.equal(fresh.state.queue[1].narration.status, 'ready');
  assert.equal(fresh.state.queue[1].narration.text, '《Title two》，早上好。');
});

test('暂停中歌放完、隔久再继续：从头开始的这首也一起重写', () => {
  const state = playing([track('one'), track('two'), track('three')]);
  const endedIdentity = identity(state);
  let paused = pause(state, T0 + 40_000);
  paused = reduce(paused, { type: PlaybackEventType.TRACK_ENDED, ...endedIdentity, natural: true, deliveredDuration: 200 }, T0 + 41_000).state;
  assert.equal(paused.currentSongId, 'two');
  const resumed = resume(paused, T0 + 4 * HOUR);
  assert.deepEqual(rewrites(resumed)[0].queueItemIds, [resumed.state.queue[1].queueItemId, resumed.state.queue[2].queueItemId]);
  assert.equal(resumed.state.txn.narrationGenerationRevision, resumed.state.queue[1].narration.generationRevision);
});

test('重启后重新接上：按保存下来的最后出声时间判断', () => {
  let state = playing([track('one'), track('two')]);
  state = reduce(state, { type: PlaybackEventType.POSITION_REPORTED, ...identity(state), positionSeconds: 60 }, T0 + 61_000).state;
  const restored = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.phase, PlaybackPhase.LOADING);
  assert.equal(restored.lastAudibleAtMs, T0 + 61_000);
  const reattached = reduce(restored, { type: PlaybackEventType.TRACK_REATTACHED, ...identity(restored), positionSeconds: 60 }, T0 + 2 * HOUR);
  assert.deepEqual(rewrites(reattached)[0].queueItemIds, [reattached.state.queue[1].queueItemId]);
  assert.equal(reattached.state.queue[0].narration.status, 'absent');
  assert.equal(reattached.state.lastAudibleAtMs, T0 + 2 * HOUR, '重新出声后再记');
});

test('切到别的聊天听了几小时再切回：按原会话自己的最后出声时间判断', () => {
  const state = playing([track('one'), track('two')]);
  const away = reduce(state, { type: PlaybackEventType.LISTENING_SESSION_SWITCH_REQUESTED, listeningSessionId: 'conversation:other', positionSeconds: 30 }, T0 + 30_000).state;
  assert.equal(away.suspendedSessions['conversation:primary'].lastAudibleAtMs, T0 + 30_000);
  const back = reduce(away, { type: PlaybackEventType.LISTENING_SESSION_SWITCH_REQUESTED, listeningSessionId: 'conversation:primary' }, T0 + 3 * HOUR);
  assert.deepEqual(rewrites(back)[0].queueItemIds, [back.state.queue[1].queueItemId]);
});

test('旧快照没有或带着非法的最后出声时间：归一为 null，不凭空制造停顿', () => {
  const state = playing([track('one'), track('two')]);
  const restored = hydratePlaybackRuntimeState({ ...JSON.parse(JSON.stringify(state)), lastAudibleAtMs: 'soon' });
  assert.equal(restored.lastAudibleAtMs, null);
  assert.equal(PLAYBACK_GAP_MS, HOUR);
});
