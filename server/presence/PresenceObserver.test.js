import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceObserver } from './PresenceObserver.js';

const NOON = Date.UTC(2026, 9, 18, 4, 0); // 12:00 Asia/Shanghai
const track = n => ({ queueItemId: `q${n}`, songId: `s${n}`, provider: 'qq', title: `歌${n}`, artist: `歌手${n}`,
  duration: 200, virtualPersonId: 'lunara' });
const queue = [track(1), track(2)];
const loading = i => ({ activeListeningSessionId: 'room', radioMode: true, companionModeId: 'occasional', phase: 'loading',
  queue, currentIndex: i, modeCountedOccurrences: [], txn: { correlationId: `c${i}`, queueItemId: `q${i + 1}`, startedAtMs: null } });
const playing = (i, at) => ({ ...loading(i), phase: 'playing', txn: { ...loading(i).txn, startedAtMs: at, startedPositionSeconds: 0 } });

function fakeRuntime(initial = loading(0)) {
  const listeners = new Set();
  let state = initial;
  return {
    snapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    emit(next, event) { const previous = state; state = next; for (const l of listeners) l(next, event, previous); },
    listenerCount: () => listeners.size,
  };
}

function harness(overrides = {}) {
  let nowMs = NOON;
  const traces = [], saved = [];
  const store = { data: overrides.persisted ?? null };
  const observer = new PresenceObserver({
    now: () => nowMs, timeZone: 'Asia/Shanghai',
    trace: (sessionId, event) => traces.push({ sessionId, ...event }),
    persistence: { load: () => store.data, save: data => { store.data = data; saved.push(data); } },
    getActivity: overrides.getActivity || (() => ({ busy: false, lastUserTurnAtMs: null })),
    logger: { warn: () => {} },
    ...overrides.options,
  });
  return { observer, traces, saved, store, setNow: ms => { nowMs = ms; } };
}

test('observes accepted transitions only and never writes playback state', () => {
  const h = harness(), runtime = fakeRuntime();
  const submit = () => assert.fail('presence must never submit playback events');
  runtime.submit = submit;
  const detach = h.observer.attach(runtime);
  runtime.emit(playing(0, NOON), { type: 'TRACK_STARTED' });
  assert.equal(runtime.snapshot().phase, 'playing');
  const decision = h.traces.find(t => t.type === 'presence_decision');
  assert.equal(decision.sessionId, 'room');
  assert.equal(decision.momentKind, 'session_open');
  assert.equal(decision.decision, 'speak');
  assert.equal(decision.reason, 'eligible');
  assert.equal(decision.shadow, true, 'P0 只记录「本来会开口」，不开口');
  assert.equal(JSON.stringify(h.traces).includes('歌1'), false, 'trace 不落歌名/原文');
  detach();
  assert.equal(runtime.listenerCount(), 0);
});

test('an observer failure never breaks the playback transition', () => {
  const h = harness({ getActivity: () => { throw new Error('boom'); } }), runtime = fakeRuntime();
  h.observer.attach(runtime);
  assert.doesNotThrow(() => runtime.emit(playing(0, NOON), { type: 'TRACK_STARTED' }));
});

test('the same trigger is decided once, including after a restart', () => {
  const h = harness(), runtime = fakeRuntime();
  h.observer.attach(runtime);
  runtime.emit(playing(0, NOON), { type: 'TRACK_STARTED' });
  const restarted = harness({ persisted: h.store.data }), again = fakeRuntime();
  restarted.observer.attach(again);
  // 同一触发键（同一会话起点）不可能重放；换成相同 occurrence 的重复激活也不再决策。
  again.emit(playing(0, NOON), { type: 'TRACK_STARTED' });
  assert.equal(restarted.traces.filter(t => t.type === 'presence_decision').length, 0);
  assert.ok(h.saved.length >= 1);
});

test('persisted pacing survives restart: shadow budget and last activity', () => {
  const h = harness(), runtime = fakeRuntime();
  h.observer.attach(runtime);
  runtime.emit(playing(0, NOON), { type: 'TRACK_STARTED' });
  const restored = harness({ persisted: h.store.data });
  const entry = restored.observer.entry('room');
  assert.equal(entry.sessionStartedAtMs, NOON);
  assert.equal(entry.lastActivityAtMs, NOON);
  assert.deepEqual(entry.presenceLog, [NOON]);
  assert.equal(entry.momentCounters.session_open.spoken, 1);
});

test('user activity in the session silences the moment', () => {
  const h = harness({ getActivity: () => ({ busy: false, lastUserTurnAtMs: NOON - 5_000 }) }), runtime = fakeRuntime();
  h.observer.attach(runtime);
  runtime.emit(playing(0, NOON), { type: 'TRACK_STARTED' });
  assert.equal(h.traces.find(t => t.type === 'presence_decision').reason, 'user-active');
  const busy = harness({ getActivity: () => ({ busy: true, lastUserTurnAtMs: null }) }), r2 = fakeRuntime();
  busy.observer.attach(r2);
  r2.emit(playing(0, NOON), { type: 'TRACK_STARTED' });
  assert.equal(busy.traces.find(t => t.type === 'presence_decision').reason, 'user-active');
});

test('PRESENCE_AUTO=0 does not subscribe at all', () => {
  const h = harness({ options: { enabled: false } }), runtime = fakeRuntime();
  h.observer.attach(runtime);
  assert.equal(runtime.listenerCount(), 0);
  assert.equal(h.observer.status().enabled, false);
});

test('status reports only product facts', () => {
  const h = harness(), runtime = fakeRuntime();
  h.observer.attach(runtime);
  runtime.emit(playing(0, NOON), { type: 'TRACK_STARTED' });
  assert.deepEqual(h.observer.status(), { enabled: true, phase: 'observing', level: 'sparse',
    quietHours: { start: '23:30', end: '08:00' }, today: { spoken: 0, ignored: 0 }, lastResult: null });
});

const openIn = (sessionId, at) => ({ ...playing(0, at), activeListeningSessionId: sessionId });
const loadingIn = sessionId => ({ ...loading(0), activeListeningSessionId: sessionId });

test('with a speaker: speak decisions are handed off and only real lines are accounted', async () => {
  const spoken = [];
  let reply = { outcome: 'silent', reason: 'model-silence' };
  const speaker = { speak: async (moment, { isCurrent }) => { spoken.push({ moment, current: isCurrent() }); return reply; },
    interrupt: () => false };
  const h = harness({ options: { speaker } });
  const runtime = fakeRuntime(loadingIn('a'));
  h.observer.attach(runtime);
  runtime.emit(openIn('a', NOON), { type: 'TRACK_STARTED' });
  await h.observer.settled();
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].current, true);
  assert.equal(h.traces.find(t => t.type === 'presence_decision').shadow, undefined, 'P1 不再是影子决策');
  assert.equal(h.observer.entry('a').lastVoiceAtMs, null, '模型沉默：不记账');
  assert.equal(h.observer.status().today.spoken, 0);
  assert.equal(h.observer.status().lastResult, 'silent');

  reply = { outcome: 'text-only', reason: 'delivered' };
  runtime.emit(loadingIn('b'), { type: 'PROGRAM_COMMITTED' });
  runtime.emit(openIn('b', NOON), { type: 'TRACK_STARTED' });
  await h.observer.settled();
  assert.equal(h.observer.entry('b').lastVoiceAtMs, NOON, '真的说出口才记账');
  assert.equal(h.observer.status().today.spoken, 1);
  assert.equal(h.observer.status().phase, 'active');
  assert.equal(h.store.data.pacing.spoken, 1, '节奏账本持久化');
});

test('two ignored lines drop a level, two more pause for the day; the user speaking restores one level', async () => {
  const interrupted = [];
  const speaker = { speak: async () => ({ outcome: 'spoken', reason: 'delivered' }), interrupt: sid => interrupted.push(sid) };
  const h = harness({ options: { speaker } });
  const runtime = fakeRuntime(loadingIn('s0'));
  h.observer.attach(runtime);
  const open = async index => {
    runtime.emit(loadingIn(`s${index}`), { type: 'PROGRAM_COMMITTED' });
    runtime.emit(openIn(`s${index}`, NOON), { type: 'TRACK_STARTED' });
    await h.observer.settled();
    return h.traces.filter(t => t.type === 'presence_decision').at(-1);
  };
  assert.equal((await open(1)).decision, 'speak');
  assert.equal((await open(2)).decision, 'speak');
  assert.equal(h.observer.status().today.ignored, 1);
  assert.equal(h.observer.status().level, 'sparse');
  assert.equal((await open(3)).decision, 'speak', '降到 reduced 仍允许开场');
  assert.equal(h.observer.status().level, 'reduced');
  await open(4);
  const paused = await open(5);
  assert.equal(paused.reason, 'paused-today');
  assert.equal(h.observer.status().level, 'paused-today');
  h.observer.noteUserTurn('s5');
  assert.deepEqual(interrupted, ['s5']);
  assert.equal(h.observer.status().level, 'reduced');
  const restored = harness({ persisted: h.store.data, options: { speaker } });
  assert.equal(restored.observer.status().level, 'reduced', '降档当天重启后仍在');
  h.setNow(NOON + 24 * 60 * 60_000);
  assert.equal(h.observer.status().level, 'sparse', '跨过当地零点回到 sparse');
});

test('a second moment while a line is being prepared is silenced as in-flight', async () => {
  let finish;
  const speaker = { speak: () => new Promise(resolve => { finish = () => resolve({ outcome: 'silent', reason: 'x' }); }), interrupt() {} };
  const h = harness({ options: { speaker } });
  const runtime = fakeRuntime(loadingIn('room'));
  h.observer.attach(runtime);
  runtime.emit(openIn('room', NOON), { type: 'TRACK_STARTED' });
  h.setNow(NOON + 5 * 60_000);
  // 同一会话直接放完：queue_exhausted 候选，此时上一句还在生成。
  runtime.emit({ ...openIn('room', NOON), phase: 'exhausted', radioMode: false, txn: null }, { type: 'QUEUE_EXHAUSTED' });
  const decisions = h.traces.filter(t => t.type === 'presence_decision');
  assert.equal(decisions.at(-1).reason, 'in-flight');
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await h.observer.settled();
});

test('a mode change or a switched listening session after the decision makes the line stale', async () => {
  const seen = [];
  const speaker = { speak: async (moment, { isCurrent }) => { seen.push(isCurrent); return { outcome: 'silent', reason: 'x' }; }, interrupt() {} };
  const h = harness({ options: { speaker } });
  const runtime = fakeRuntime({ ...loadingIn('room'), modeRevision: 3 });
  h.observer.attach(runtime);
  runtime.emit({ ...openIn('room', NOON), modeRevision: 3 }, { type: 'TRACK_STARTED' });
  await h.observer.settled();
  const [isCurrent] = seen;
  assert.equal(isCurrent(), true);
  runtime.emit({ ...openIn('room', NOON), modeRevision: 4 }, { type: 'COMPANION_MODE_CHANGED' });
  assert.equal(isCurrent(), false, '模式 revision 变了');
  runtime.emit({ ...openIn('other', NOON), modeRevision: 3 }, { type: 'LISTENING_SESSION_SWITCHED' });
  assert.equal(isCurrent(), false, '切了听歌来源');
});

test('the speaking companion\'s temperament decides cadence and travels with the speak call', async () => {
  const calls = [];
  const speaker = { speak: async (moment, options) => { calls.push({ kind: moment.kind, policy: options.policy }); return { outcome: 'silent', reason: 'no-hook' }; },
    interrupt: () => false };
  const asked = [];
  const h = harness({ options: { speaker, temperamentFor: personId => { asked.push(personId); return 'quiet'; } } });
  const runtime = fakeRuntime(loadingIn('a'));
  h.observer.attach(runtime);
  runtime.emit({ ...openIn('a', NOON), companionModeId: 'conversational' }, { type: 'TRACK_STARTED' });
  await h.observer.settled();
  assert.deepEqual(asked, ['lunara']);
  assert.equal(calls[0].kind, 'session_open');
  assert.equal(calls[0].policy.id, 'quiet');
  const occasional = harness({ options: { speaker, temperamentFor: () => 'lively' } });
  const second = fakeRuntime(loadingIn('b'));
  occasional.observer.attach(second);
  second.emit(openIn('b', NOON), { type: 'TRACK_STARTED' });
  await occasional.observer.settled();
  assert.equal(calls[1].policy.id, 'balanced', 'occasional 模式给上限');
});

// ── 心跳模式（add-companion-heartbeat 4.1）：时刻只转给心跳，观察者不再自己开口。 ──
function fakeHeartbeat() {
  const calls = { moments: [], refreshes: 0, userTurns: [] };
  return { calls,
    noteMoment: moment => calls.moments.push(moment),
    refresh: () => { calls.refreshes += 1; },
    noteUserTurn: sessionId => calls.userTurns.push(sessionId),
    status: () => ({ enabled: true, today: { wakes: 3, spoken: 1, quiet: 2 }, lastResult: 'quiet' }) };
}
const idle = () => ({ activeListeningSessionId: null, phase: 'idle', queue: [], currentIndex: -1 });

test('heartbeat mode: accepted moments go to the heartbeat once and the observer never decides or speaks itself', () => {
  const h = harness(), heartbeat = fakeHeartbeat();
  h.observer.useHeartbeat(heartbeat);
  const runtime = fakeRuntime(loadingIn('room'));
  h.observer.attach(runtime);
  runtime.emit(openIn('room', NOON), { type: 'TRACK_STARTED' });
  assert.deepEqual(heartbeat.calls.moments.map(m => [m.kind, m.sessionId]), [['session_open', 'room']]);
  assert.equal(h.traces.filter(t => t.type === 'presence_decision').length, 0, '不再走时刻级判定');
  const moment = h.traces.find(t => t.type === 'presence_moment');
  assert.deepEqual(Object.keys(moment).sort(), ['momentKind', 'personId', 'sessionId', 'triggerKey', 'type']);
  assert.equal(JSON.stringify(h.traces).includes('歌1'), false, 'trace 不落歌名/原文');
  assert.equal(h.observer.entry('room').lastVoiceAtMs, null, '没有影子记账');
  // 同一触发键只转一次（包括重启之后）。
  runtime.emit(openIn('room', NOON), { type: 'TRACK_STARTED' });
  const restarted = harness({ persisted: h.store.data }), again = fakeHeartbeat(), second = fakeRuntime(loadingIn('room'));
  restarted.observer.useHeartbeat(again);
  restarted.observer.attach(second);
  second.emit(openIn('room', NOON), { type: 'TRACK_STARTED' });
  assert.equal(heartbeat.calls.moments.length, 1);
  assert.equal(again.calls.moments.length, 0);
});

test('heartbeat mode: every accepted transition refreshes the heartbeat, including the start of listening', () => {
  const h = harness(), heartbeat = fakeHeartbeat();
  h.observer.useHeartbeat(heartbeat);
  const runtime = fakeRuntime(idle());
  h.observer.attach(runtime);
  runtime.emit(loadingIn('room'), { type: 'PROGRAM_COMMITTED' });
  assert.equal(heartbeat.calls.refreshes, 1, '从没在听到开始听：observe 提前返回也要刷新');
  runtime.emit(openIn('room', NOON), { type: 'TRACK_STARTED' });
  runtime.emit({ ...openIn('room', NOON), phase: 'paused' }, { type: 'PAUSED' });
  assert.ok(heartbeat.calls.refreshes >= 3);
  const throwing = harness(), broken = { ...fakeHeartbeat(), refresh: () => { throw new Error('boom'); },
    noteMoment: () => { throw new Error('boom'); } };
  throwing.observer.useHeartbeat(broken);
  const other = fakeRuntime(loadingIn('room'));
  throwing.observer.attach(other);
  assert.doesNotThrow(() => other.emit(openIn('room', NOON), { type: 'TRACK_STARTED' }), '心跳异常不影响播放迁移');
});

test('heartbeat mode pacing: spoken lines feed the voice ledger only, unanswered lines never degrade', () => {
  const h = harness(), heartbeat = fakeHeartbeat();
  const hooks = h.observer.useHeartbeat(heartbeat);
  const wake = { id: 'ambient:room:lunara:1', sessionId: 'room', personId: 'lunara', reason: 'heartbeat' };
  assert.deepEqual(Object.keys(hooks.pacing), ['afterSpoken'], '心跳不读降档');
  for (let i = 0; i < 5; i += 1) hooks.pacing.afterSpoken(wake);
  assert.equal(hooks.getVoiceEntry('room').lastVoiceAtMs, NOON, '心跳按她的人声账本算间隔与预算');
  assert.equal(hooks.getVoiceEntry('room').presenceLog.length, 5);
  assert.equal(h.store.data.sessions.room.lastVoiceAtMs, NOON, '人声账本持久化');
  assert.equal(h.store.data.pacing.awaitingReply, false, '没接话不等回应、不记被晾');
  assert.equal(h.store.data.pacing.level, 0);
  h.observer.noteUserTurn('room');
  assert.deepEqual(heartbeat.calls.userTurns, ['room'], '用户开口转给心跳（从这一刻重新算）');
});

test('heartbeat mode status adds only the heartbeat product facts', () => {
  const h = harness(), heartbeat = fakeHeartbeat();
  h.observer.useHeartbeat(heartbeat);
  // 心跳模式不报告降档与「被晾」计数（那是 P1 的节奏账本，今天早先残留的档位也不再生效）。
  assert.deepEqual(h.observer.status(), { enabled: true, phase: 'heartbeat',
    quietHours: { start: '23:30', end: '08:00' }, lastResult: null,
    ambient: { enabled: true, today: { wakes: 3, spoken: 1, quiet: 2 }, lastResult: 'quiet' } });
});

test('the P1 speaker and the heartbeat never run together', () => {
  const h = harness({ options: { speaker: { speak: async () => ({ outcome: 'silent' }), interrupt() {} } } });
  assert.throws(() => h.observer.useHeartbeat(fakeHeartbeat()), /speaker/);
});
