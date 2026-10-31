import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresenceEntry, pickOrigin, reducePresence } from './presenceState.js';

// 夹具只模拟 runtime 已接受的快照差分：(previous, event, next)。
const track = (n, extra = {}) => ({ queueItemId: `q${n}`, songId: `s${n}`, provider: 'qq', title: `歌${n}`,
  artist: extra.artist || `歌手${n}`, album: extra.album || `专辑${n}`, duration: 200, virtualPersonId: 'lunara', ...extra });
function snap(overrides = {}) {
  const queue = overrides.queue || [track(1), track(2), track(3)];
  const currentIndex = overrides.currentIndex ?? 0;
  return { activeListeningSessionId: 'room', outputGeneration: 1, radioMode: true, companionModeId: 'occasional',
    phase: 'playing', queue, currentIndex, positionSeconds: 0, modeCountedOccurrences: [],
    txn: { correlationId: `c${currentIndex}`, queueItemId: queue[currentIndex]?.queueItemId, startedAtMs: 0, startedPositionSeconds: 0 },
    listeningPlan: { curatorId: 'lunara' }, ...overrides };
}
const loading = (index, extra = {}) => snap({ currentIndex: index, phase: 'loading',
  txn: { correlationId: `c${index}`, queueItemId: `q${index + 1}`, startedAtMs: null, startedPositionSeconds: 0 }, ...extra });
const playing = (index, nowMs, extra = {}) => snap({ currentIndex: index, phase: 'playing',
  txn: { correlationId: `c${index}`, queueItemId: `q${index + 1}`, startedAtMs: nowMs, startedPositionSeconds: 0 }, ...extra });

function run(steps, entry = createPresenceEntry({ sessionId: 'room' })) {
  const moments = [];
  for (const [previous, event, next, nowMs] of steps) {
    const result = reducePresence(entry, { previous, event, next, nowMs });
    entry = result.entry; moments.push(...result.moments);
  }
  return { entry, moments };
}

test('a confirmed activation starts the session and counts real listening time, excluding pauses', () => {
  const { entry } = run([
    [loading(0), { type: 'TRACK_STARTED' }, playing(0, 1_000), 1_000],
    [playing(0, 1_000), { type: 'PAUSE_REQUESTED' }, snap({ phase: 'paused', txn: { correlationId: 'c0', queueItemId: 'q1', startedAtMs: null } }), 61_000],
    [snap({ phase: 'paused' }), { type: 'RESUME_REQUESTED' }, playing(0, 301_000), 301_000],
    [playing(0, 301_000), { type: 'POSITION_REPORTED' }, playing(0, 331_000), 331_000],
  ]);
  assert.equal(entry.sessionStartedAtMs, 1_000);
  assert.equal(entry.listenedMs, 90_000, '暂停的 240 秒不计入');
  assert.equal(entry.activations, 1, '暂停/恢复不是新激活');
  assert.equal(entry.lastOutputTrack.songId, 's1');
});

test('reattach, restore and duplicate start facts do not count a second activation', () => {
  const { entry, moments } = run([
    [loading(0), { type: 'TRACK_STARTED' }, playing(0, 1_000), 1_000],
    [playing(0, 1_000), { type: 'TRACK_STARTED' }, playing(0, 1_000), 2_000],
    [loading(0), { type: 'TRACK_REATTACHED' }, playing(0, 3_000), 3_000],
  ]);
  assert.equal(entry.activations, 1);
  assert.equal(moments.filter(m => m.kind === 'session_open').length, 1);
});

test('natural completion and user skips are counted deterministically from position', () => {
  const { entry, moments } = run([
    [loading(0), { type: 'TRACK_STARTED' }, playing(0, 0), 0],
    // 播到 190/200 秒自然结束 → 听完
    [snap({ positionSeconds: 190 }), { type: 'TRACK_ENDED', natural: true, songId: 's1', correlationId: 'c0', playedSeconds: 190 }, loading(1), 190_000],
    [loading(1), { type: 'TRACK_STARTED' }, playing(1, 191_000), 191_000],
    // 第 10 秒用户切歌 → 跳过（覆盖 <20%）
    [playing(1, 191_000), { type: 'NEXT_REQUESTED', positionSeconds: 10 }, loading(2), 201_000],
  ]);
  assert.equal(entry.completedCount, 1);
  assert.equal(entry.consecutiveSkips, 1);
  assert.equal(entry.consecutiveCompletions, 0);
  assert.deepEqual(moments.map(m => m.kind), ['session_open', 'track_completed', 'boundary_without_intro', 'track_skipped']);
});

test('unknown duration or a late skip creates no completed/skipped moment', () => {
  const noDuration = [track(1, { duration: null }), track(2)];
  const { moments } = run([
    [snap({ queue: noDuration, positionSeconds: 180 }), { type: 'TRACK_ENDED', natural: true, songId: 's1', correlationId: 'c0' }, loading(1, { queue: noDuration }), 1],
    [playing(1, 0), { type: 'NEXT_REQUESTED', positionSeconds: 120 }, loading(2), 120_000],
  ], { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0 });
  assert.deepEqual(moments, []);
});

test('technical failures and source switches create no moments', () => {
  const { moments, entry } = run([
    [playing(0, 0), { type: 'TRACK_FAILED', songId: 's1', correlationId: 'c0' }, snap({ phase: 'error' }), 5_000],
    [playing(0, 0), { type: 'LISTENING_SESSION_SWITCH_REQUESTED', positionSeconds: 5 }, { ...loading(0), activeListeningSessionId: 'other' }, 6_000],
  ], { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0 });
  assert.deepEqual(moments, []);
  assert.equal(entry.consecutiveSkips, 0, '切换来源不是跳过');
});

test('an exhausted queue with continuation off is a moment; with continuation on it is not', () => {
  const ended = { type: 'TRACK_ENDED', natural: true, songId: 's3', correlationId: 'c2', playedSeconds: 199 };
  const off = run([[playing(2, 0, { radioMode: false, positionSeconds: 199 }), ended,
    snap({ currentIndex: 2, phase: 'exhausted', radioMode: false, txn: null }), 199_000]],
  { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0 });
  assert.deepEqual(off.moments.map(m => m.kind), ['track_completed', 'queue_exhausted']);
  const on = run([[playing(2, 0, { positionSeconds: 199 }), ended, snap({ currentIndex: 2, phase: 'exhausted', txn: null }), 199_000]],
    { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0 });
  assert.deepEqual(on.moments.map(m => m.kind), ['track_completed']);
});

test('a boundary whose occurrence is granted an intro is not boundary_without_intro', () => {
  const granted = playing(1, 10, { modeCountedOccurrences: [{ queueItemId: 'q2', eligible: true }] });
  const { moments } = run([[loading(1), { type: 'TRACK_STARTED' }, granted, 10]],
    { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0, activations: 1 });
  assert.deepEqual(moments, []);
  const legacy = run([[loading(1), { type: 'TRACK_STARTED' }, playing(1, 10, { companionModeId: null }), 10]],
    { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0, activations: 1 });
  assert.deepEqual(legacy.moments, [], 'legacy 逐首串词，边界不算无介绍');
});

test('moment evidence carries canonical identity and adjacency, and trigger keys are stable', () => {
  const queue = [track(1, { artist: '陈绮贞' }), track(2, { artist: '陈绮贞' })];
  const steps = [[loading(1, { queue }), { type: 'TRACK_STARTED' }, playing(1, 10, { queue }), 10]];
  const base = { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0, activations: 1,
    lastOutputTrack: { provider: 'qq', songId: 's1', artist: '陈绮贞', album: '专辑1', queueItemId: 'q1' } };
  const first = run(steps, base).moments[0];
  const again = run(steps, base).moments[0];
  assert.equal(first.kind, 'boundary_without_intro');
  assert.equal(first.evidence.sameArtistAsPrevious, true);
  assert.deepEqual(first.evidence.track, { provider: 'qq', songId: 's2', title: '歌2', artist: '陈绮贞',
    album: '专辑2', queueItemId: 'q2', requestId: null, origin: null });
  assert.equal(first.personId, 'lunara');
  assert.equal(first.triggerKey, again.triggerKey);
  assert.match(first.triggerKey, /^room\/lunara\/boundary_without_intro\/q2:c1$/);
});

test('a session_open needs a 30 minute gap since the last activity in this session', () => {
  const recent = { ...createPresenceEntry({ sessionId: 'room' }), lastActivityAtMs: 0 };
  assert.deepEqual(run([[loading(0), { type: 'TRACK_STARTED' }, playing(0, 10 * 60_000), 10 * 60_000]], recent)
    .moments.filter(m => m.kind === 'session_open'), [], '重启后 10 分钟内重新开播不算新的一场');
  assert.deepEqual(run([[loading(0), { type: 'TRACK_STARTED' }, playing(0, 31 * 60_000), 31 * 60_000]], recent)
    .moments.map(m => m.kind), ['session_open']);
});

test('an audible track narration refreshes the shared automatic-voice clock', () => {
  const { entry } = run([[playing(0, 0), { type: 'NARRATION_DELIVERY_AUDIBLE' }, playing(0, 0), 42_000]]);
  assert.equal(entry.lastVoiceAtMs, 42_000);
});

test('track evidence names who picked it, from the committed narration context only', () => {
  const ctx = context => track(2, { narration: { context } });
  assert.equal(pickOrigin(ctx({ origin: 'live', reason: 'user_request', mode: 'exact' })), 'listener_request');
  assert.equal(pickOrigin(ctx({ origin: 'live', reason: 'user_request', mode: 'discovery' })), 'her_pick_for_request');
  assert.equal(pickOrigin(ctx({ origin: 'live', reason: 'auto_continue', mode: 'constrained' })), 'her_pick');
  assert.equal(pickOrigin(track(2)), null, 'no context → unknown, never guessed');
});

test('moments carry the request that queued the track and the plan direction she wrote, never more', () => {
  const queue = [track(1), track(2, { requestId: 'req-7' })];
  const plan = { curatorId: 'lunara', request: { softPreferences: '  晚上想安静一点，少一点鼓点  ' } };
  const steps = [[loading(1, { queue, listeningPlan: plan }), { type: 'TRACK_STARTED' }, playing(1, 10, { queue, listeningPlan: plan }), 10]];
  const base = { ...createPresenceEntry({ sessionId: 'room' }), sessionStartedAtMs: 0, activations: 1, lastActivityAtMs: 5,
    lastOutputTrack: { provider: 'qq', songId: 's1', artist: '歌手1', album: '专辑1', queueItemId: 'q1' } };
  const [moment] = run(steps, base).moments;
  assert.equal(moment.evidence.track.requestId, 'req-7');
  assert.equal(moment.evidence.planDirection, '晚上想安静一点，少一点鼓点');
  const [bare] = run([[loading(1, { queue }), { type: 'TRACK_STARTED' }, playing(1, 10, { queue }), 10]], base).moments;
  assert.equal(bare.evidence.planDirection, null);
});
