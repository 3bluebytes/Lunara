import assert from 'node:assert/strict';
import test from 'node:test';
import { CompanionHeartbeat, HEARTBEAT_REASONS } from './CompanionHeartbeat.js';
import { resolvePresencePolicy } from './presenceTemperament.js';

const MIN = 60_000;
// 2026-09-03 12:00 Asia/Shanghai
const NOON = Date.parse('2026-09-03T04:00:00.000Z');
const flush = () => new Promise(resolve => setImmediate(resolve));

function createClock(start) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms), fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
    set(ms) { now = ms; },
    get timerCount() { return timers.size; },
  };
}

const playing = (over = {}) => ({
  activeListeningSessionId: 'chat-a', phase: 'playing', companionModeId: null, modeRevision: 1, currentIndex: 0,
  queue: [{ provider: 'qq', songId: 's1', queueItemId: 'q1', virtualPersonId: 'lunara', title: '夜航星' }],
  ...over,
});

function harness({ start = NOON, random = () => 0.5, result = () => ({ outcome: 'quiet' }), limits, voiceOf, pacing, followups, cadence, quietFor } = {}) {
  const clock = createClock(start);
  const state = {
    snapshot: playing(), clients: 1, enabled: true, temperament: 'balanced', budget: false,
    activity: { busy: false, lastUserTurnAtMs: null }, voice: { lastVoiceAtMs: null, presenceLog: [] },
  };
  const wakes = [];
  const traces = [];
  const spoken = [];
  const heartbeat = new CompanionHeartbeat({
    now: clock.now, random, setTimer: clock.setTimer, clearTimer: clock.clearTimer, timeZone: 'Asia/Shanghai',
    trace: (sessionId, entry) => traces.push({ sessionId, ...entry }),
    isEnabled: () => state.enabled,
    getSnapshot: () => state.snapshot,
    clientCount: () => state.clients,
    getActivity: () => state.activity,
    getVoiceEntry: () => state.voice,
    pacing: { afterSpoken: () => spoken.push(clock.now()), ...pacing },
    temperamentFor: () => state.temperament,
    llmBudgetExhausted: () => state.budget,
    onWake: async wake => { wakes.push(wake); return result(wake); },
    ...(limits ? { limits } : {}),
    ...(cadence ? { cadenceFactor: cadence } : {}),
    ...(quietFor ? { listenerQuiet: quietFor } : {}),
    ...(voiceOf ? { voiceOf } : {}),
    ...(followups ? { followupsFor: sessionId => followups.filter(item => item.sessionId === sessionId) } : {}),
  });
  return { clock, state, wakes, traces, spoken, heartbeat };
}

const reasons = traces => traces.filter(entry => entry.reason && entry.type !== 'ambient_result').map(entry => entry.reason);

// ---- 2.1 上弦与撤弦 ----

test('arms one wake for the active listening session when every condition holds', () => {
  const h = harness();
  h.heartbeat.refresh();
  assert.deepEqual(h.heartbeat.pending(), { sessionId: 'chat-a', personId: 'lunara', dueAtMs: NOON + 15 * MIN, reason: 'heartbeat' });
  assert.equal(h.clock.timerCount, 1);
});

test('any failing arm condition leaves nothing armed', () => {
  const cases = [
    ['not listening anywhere', s => { s.snapshot = playing({ activeListeningSessionId: null }); }, 'not-listening'],
    ['paused', s => { s.snapshot = playing({ phase: 'paused' }); }, 'not-listening'],
    ['idle', s => { s.snapshot = playing({ phase: 'idle' }); }, 'not-listening'],
    ['error', s => { s.snapshot = playing({ phase: 'error' }); }, 'not-listening'],
    ['exhausted without its moment', s => { s.snapshot = playing({ phase: 'exhausted' }); }, 'not-listening'],
    ['no client', s => { s.clients = 0; }, 'no-client'],
    ['switch off', s => { s.enabled = false; }, 'disabled'],
    ['music only', s => { s.snapshot = playing({ companionModeId: 'music_only' }); }, 'mode-silent'],
  ];
  for (const [label, mutate, reason] of cases) {
    const h = harness();
    mutate(h.state);
    h.heartbeat.refresh();
    assert.equal(h.heartbeat.pending(), null, label);
    assert.equal(h.clock.timerCount, 0, label);
    assert.equal(h.heartbeat.blocker(), reason, label);
  }
});

test('track transitions keep the armed wake instead of restarting the heartbeat', () => {
  const h = harness();
  h.heartbeat.refresh();
  h.clock.set(NOON + 5 * MIN);
  for (const phase of ['loading', 'awaiting_intro', 'speaking', 'playing']) {
    h.state.snapshot = playing({ phase });
    h.heartbeat.refresh();
    assert.equal(h.heartbeat.pending().dueAtMs, NOON + 15 * MIN, phase);
  }
});

test('pausing disarms; resuming arms a fresh heartbeat without replaying the skipped interval', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(5 * MIN);
  h.state.snapshot = playing({ phase: 'paused' });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending(), null);
  await h.clock.advance(20 * MIN);
  assert.equal(h.wakes.length, 0);
  h.state.snapshot = playing();
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 25 * MIN + 15 * MIN);
  assert.ok(h.traces.some(entry => entry.type === 'ambient_wake_disarmed' && entry.reason === 'not-listening'));
});

test('closing the app disarms until a client reconnects while listening', async () => {
  const h = harness();
  h.heartbeat.refresh();
  h.state.clients = 0;
  h.heartbeat.refresh();
  await h.clock.advance(60 * MIN);
  assert.equal(h.wakes.length, 0);
  h.state.clients = 1;
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 75 * MIN);
});

// ---- 10.1 短暂断线 ----

test('a reconnect within sixty seconds keeps the heartbeat anchor and jitter', async () => {
  const draws = [0, 1];
  const h = harness({ random: () => (draws.length ? draws.shift() : 0.5) });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 12 * MIN, 'jitter 0.8');
  await h.clock.advance(11 * MIN + 50_000);
  h.state.clients = 0;
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending(), null, '断开即撤弦');
  await h.clock.advance(30_000);
  assert.equal(h.wakes.length, 0, '断线期间不触发');
  h.state.clients = 1;
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 12 * MIN + 20_000 + 30_000,
    '原本 12 分钟到点，断线期间已过：重连后 30 秒触发，不从重连时刻重新算、也不重新抽抖动');
  await h.clock.advance(30_000);
  assert.equal(h.wakes.length, 1);
});

test('a reconnect before the due time keeps the original due time', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(10 * MIN);
  h.state.clients = 0;
  h.heartbeat.refresh();
  await h.clock.advance(59_000);
  h.state.clients = 1;
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 15 * MIN);
});

test('a reconnect after more than sixty seconds or to another source arms fresh', async () => {
  const late = harness();
  late.heartbeat.refresh();
  await late.clock.advance(10 * MIN);
  late.state.clients = 0;
  late.heartbeat.refresh();
  await late.clock.advance(61_000);
  late.state.clients = 1;
  late.heartbeat.refresh();
  assert.equal(late.heartbeat.pending().dueAtMs, NOON + 11 * MIN + 1_000 + 15 * MIN);

  const moved = harness();
  moved.heartbeat.refresh();
  await moved.clock.advance(10 * MIN);
  moved.state.clients = 0;
  moved.heartbeat.refresh();
  await moved.clock.advance(2_000);
  moved.state.clients = 1;
  moved.state.snapshot = playing({ activeListeningSessionId: 'chat-b' });
  moved.heartbeat.refresh();
  assert.deepEqual(moved.heartbeat.pending(), { sessionId: 'chat-b', personId: 'lunara',
    dueAtMs: NOON + 10 * MIN + 2_000 + 15 * MIN, reason: 'heartbeat' });
});

test('other disarm reasons never resume: a quick pause and resume still starts fresh', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(10 * MIN);
  h.state.snapshot = playing({ phase: 'paused' });
  h.heartbeat.refresh();
  await h.clock.advance(5_000);
  h.state.snapshot = playing();
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 10 * MIN + 5_000 + 15 * MIN);
});

test('only the active listening session can hold a wake; switching sources moves it and starts fresh', () => {
  const h = harness();
  h.heartbeat.refresh();
  h.clock.set(NOON + 4 * MIN);
  h.state.snapshot = playing({ activeListeningSessionId: 'chat-b' });
  h.heartbeat.refresh();
  assert.deepEqual(h.heartbeat.pending(), { sessionId: 'chat-b', personId: 'lunara', dueAtMs: NOON + 19 * MIN, reason: 'heartbeat' });
});

test('an exhausted queue allows exactly one queue_exhausted wake and then disarms', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(2 * MIN);
  h.state.snapshot = playing({ phase: 'exhausted' });
  h.heartbeat.noteMoment({ kind: 'queue_exhausted', sessionId: 'chat-a', personId: 'lunara' });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().reason, 'queue_exhausted');
  await h.clock.advance(MIN);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0].reason, 'queue_exhausted');
  assert.equal(h.heartbeat.pending(), null);
  await h.clock.advance(60 * MIN);
  assert.equal(h.wakes.length, 1);
});

// ---- 2.2 心跳节奏 ----

test('heartbeat interval follows temperament and mode ceiling', () => {
  for (const [temperament, modeId, minutes] of [['quiet', null, 30], ['balanced', null, 15], ['lively', null, 8],
    ['lively', 'occasional', 15]]) {
    const h = harness();
    h.state.temperament = temperament;
    h.state.snapshot = playing({ companionModeId: modeId });
    h.heartbeat.refresh();
    assert.equal(h.heartbeat.pending().dueAtMs, NOON + minutes * MIN, `${temperament}/${modeId}`);
  }
});

test('jitter stays within ±20%', () => {
  const low = harness({ random: () => 0 });
  low.heartbeat.refresh();
  assert.equal(low.heartbeat.pending().dueAtMs, NOON + 12 * MIN);
  const high = harness({ random: () => 0.999999 });
  high.heartbeat.refresh();
  assert.ok(high.heartbeat.pending().dueAtMs <= NOON + 18 * MIN);
  assert.ok(high.heartbeat.pending().dueAtMs > NOON + 17.9 * MIN);
});

test('the heartbeat is measured from the latest of arming, the previous wake and the listener turn', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 30 * MIN);
  await h.clock.advance(5 * MIN);
  h.state.activity = { busy: false, lastUserTurnAtMs: h.clock.now() };
  h.heartbeat.noteUserTurn('chat-a');
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 35 * MIN);
});

// ---- 10.2 不降档 ----

test('unanswered lines never slow the heartbeat, restrict nudges or pause the day', async () => {
  // 旧的降档钩子即使还在也不读：心跳不再做降档。
  const h = harness({ result: () => ({ outcome: 'spoken' }),
    pacing: { level: () => 2, beforeWake: () => { throw new Error('beforeWake must not be called'); } } });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.blocker(), null);
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 15 * MIN);
  await h.clock.advance(45 * MIN);
  assert.equal(h.wakes.length, 3, '三句都没人接话，仍按 15 分钟一拍');
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 60 * MIN);
  h.heartbeat.noteMoment({ kind: 'track_completed', sessionId: 'chat-a', personId: 'lunara' });
  assert.equal(h.heartbeat.pending().reason, 'track_completed', '歌放完仍可提前');
  assert.equal(h.traces.some(entry => entry.reason === 'paused-today' || entry.reason === 'degraded'), false);
});

// ---- 2.3 事件提前 ----

test('a completed track only brings the wake earlier, never before min spacing after the previous wake', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 1);
  await h.clock.advance(2 * MIN);
  h.heartbeat.noteMoment({ kind: 'track_completed', sessionId: 'chat-a', personId: 'lunara' });
  assert.deepEqual(h.heartbeat.pending(), { sessionId: 'chat-a', personId: 'lunara', dueAtMs: NOON + 21 * MIN, reason: 'track_completed' });
  assert.equal(h.wakes.length, 1, 'no model call at the completion itself');
});

test('a nudge is never earlier than thirty seconds after the event', () => {
  const h = harness();
  h.heartbeat.refresh();
  h.heartbeat.noteMoment({ kind: 'session_open', sessionId: 'chat-a', personId: 'lunara' });
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 30_000);
});

test('a nudge never pushes an earlier wake later', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(14 * MIN + 40_000);
  h.heartbeat.noteMoment({ kind: 'track_completed', sessionId: 'chat-a', personId: 'lunara' });
  assert.deepEqual(h.heartbeat.pending(), { sessionId: 'chat-a', personId: 'lunara', dueAtMs: NOON + 15 * MIN, reason: 'heartbeat' });
});

test('a single skip does not nudge; two consecutive skips do', () => {
  const h = harness();
  h.heartbeat.refresh();
  h.heartbeat.noteMoment({ kind: 'track_skipped', sessionId: 'chat-a', personId: 'lunara', evidence: { consecutiveSkips: 1 } });
  assert.equal(h.heartbeat.pending().reason, 'heartbeat');
  h.heartbeat.noteMoment({ kind: 'track_skipped', sessionId: 'chat-a', personId: 'lunara', evidence: { consecutiveSkips: 2 } });
  assert.equal(h.heartbeat.pending().reason, 'track_skipped');
});

test('five skips within a minute produce at most one wake within min spacing and are summarized', async () => {
  const h = harness();
  h.heartbeat.refresh();
  for (let index = 1; index <= 5; index += 1) {
    h.heartbeat.noteMoment({ kind: 'track_skipped', sessionId: 'chat-a', personId: 'lunara', evidence: { consecutiveSkips: index } });
    await h.clock.advance(5_000);
  }
  await h.clock.advance(5 * MIN);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0].sinceLastWake.skipped, 5);
});

test('moments outside the nudge set and moments of other sessions do not nudge', () => {
  const h = harness();
  h.heartbeat.refresh();
  h.heartbeat.noteMoment({ kind: 'boundary_without_intro', sessionId: 'chat-a', personId: 'lunara' });
  h.heartbeat.noteMoment({ kind: 'track_failed', sessionId: 'chat-a', personId: 'lunara' });
  h.heartbeat.noteMoment({ kind: 'track_completed', sessionId: 'chat-b', personId: 'lunara' });
  assert.equal(h.heartbeat.pending().reason, 'heartbeat');
});

test('a wake carries elapsed time, events since the previous wake and the policy, never text', async () => {
  const h = harness();
  h.heartbeat.refresh();
  h.heartbeat.noteMoment({ kind: 'track_completed', sessionId: 'chat-a', personId: 'lunara' });
  await h.clock.advance(MIN);
  const [wake] = h.wakes;
  assert.equal(wake.sessionId, 'chat-a');
  assert.equal(wake.personId, 'lunara');
  assert.equal(wake.reason, 'track_completed');
  assert.equal(wake.firedAtMs, NOON + 30_000);
  assert.equal(wake.previousWakeAtMs, null);
  assert.deepEqual(wake.sinceLastWake, { completed: 1, skipped: 0 });
  assert.equal(wake.modeRevision, 1);
  assert.equal(wake.policy.id, 'balanced');
  assert.ok(wake.signal instanceof AbortSignal);
  assert.match(wake.id, /^ambient:chat-a:lunara:\d+$/);
});

// ---- 2.4 硬门控 ----

test('quiet hours skip the wake without a model call and without compensation', async () => {
  const h = harness({ start: Date.parse('2026-09-03T15:40:00.000Z') }); // 23:40 Shanghai
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 0);
  assert.deepEqual(reasons(h.traces), ['quiet-hours']);
  assert.equal(h.heartbeat.pending().dueAtMs, h.clock.now() + 15 * MIN);
});

test('a recent narration reschedules to the end of the voice interval', async () => {
  const h = harness();
  h.heartbeat.refresh();
  h.state.voice = { lastVoiceAtMs: NOON + 14 * MIN, presenceLog: [] };
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 0);
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 16 * MIN);
  await h.clock.advance(MIN);
  assert.equal(h.wakes.length, 1);
  assert.deepEqual(reasons(h.traces).slice(0, 1), ['too-soon']);
});

test('listener activity reschedules at most three times, then falls back to the heartbeat', async () => {
  const h = harness();
  h.heartbeat.refresh();
  h.state.activity = { busy: true, lastUserTurnAtMs: null };
  await h.clock.advance(15 * MIN);
  await h.clock.advance(3 * MIN);
  assert.equal(h.wakes.length, 0);
  assert.deepEqual(reasons(h.traces), ['turn-busy', 'turn-busy', 'turn-busy', 'turn-busy']);
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 18 * MIN + 15 * MIN);
});

test('a just-sent listener message counts as user-active', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN - 3_000);
  h.state.activity = { busy: false, lastUserTurnAtMs: h.clock.now() };
  await h.clock.advance(3_000);
  assert.deepEqual(reasons(h.traces), ['user-active']);
});

test('a transition in progress reschedules', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN - 1);
  h.state.snapshot = playing({ phase: 'loading' });
  await h.clock.advance(1);
  assert.equal(h.wakes.length, 0);
  assert.deepEqual(reasons(h.traces), ['transition-busy']);
  h.state.snapshot = playing();
  await h.clock.advance(MIN);
  assert.equal(h.wakes.length, 1);
});

test('the per-hour cap holds regardless of nudges, and reschedules do not count', async () => {
  const h = harness();
  h.state.temperament = 'lively';
  h.heartbeat.refresh();
  h.state.activity = { busy: true, lastUserTurnAtMs: null };
  h.heartbeat.noteMoment({ kind: 'session_open', sessionId: 'chat-a', personId: 'lunara' });
  await h.clock.advance(MIN + 30_000);
  h.state.activity = { busy: false, lastUserTurnAtMs: null };
  for (let index = 0; index < 9; index += 1) {
    h.heartbeat.noteMoment({ kind: 'track_completed', sessionId: 'chat-a', personId: 'lunara' });
    await h.clock.advance(3 * MIN);
  }
  assert.equal(h.wakes.length, 8);
  assert.ok(reasons(h.traces).includes('hourly-cap'));
});

test('the daily cap skips further wakes for the day', async () => {
  const h = harness({ limits: { dailyCap: 2 } });
  h.heartbeat.refresh();
  await h.clock.advance(45 * MIN);
  assert.equal(h.wakes.length, 2);
  assert.ok(reasons(h.traces).includes('daily-cap'));
});

test('the speech budget of the temperament skips the wake', async () => {
  const h = harness();
  h.heartbeat.refresh();
  h.state.voice = { lastVoiceAtMs: NOON + 5 * MIN, presenceLog: [NOON + 4 * MIN, NOON + 5 * MIN] };
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 0);
  assert.deepEqual(reasons(h.traces), ['budget-exhausted']);
});

test('an exhausted LLM budget skips and keeps the heartbeat off for the rest of the day', async () => {
  const h = harness();
  h.heartbeat.refresh();
  h.state.budget = true;
  await h.clock.advance(15 * MIN);
  assert.deepEqual(reasons(h.traces), ['llm-budget']);
  assert.equal(h.heartbeat.pending(), null);
  h.state.budget = false;
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending(), null);
  assert.equal(h.heartbeat.blocker(), 'llm-budget');
  h.clock.set(Date.parse('2026-09-04T04:00:00.000Z'));
  h.heartbeat.refresh();
  assert.ok(h.heartbeat.pending());
});

// ---- 10.3 没有单场上限 ----

test('a long listening session has no lifetime line budget, only the speech window', async () => {
  const h = harness();
  h.heartbeat.refresh();
  // 这一场已经说了 12 句（超过 balanced 旧的单场 8 句），但最近 15 分钟一句都没有。
  h.state.voice = { lastVoiceAtMs: NOON - 20 * MIN, presenceLog: Array.from({ length: 12 }, (_, i) => NOON - (120 - i * 8) * MIN) };
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 1);
  assert.deepEqual(reasons(h.traces), []);
});

test('each due wake that yields no line records exactly one closed reason code', async () => {
  const h = harness({ result: () => ({ outcome: 'silent', reason: 'stale' }) });
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  const results = h.traces.filter(entry => entry.type === 'ambient_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].reason, 'stale');
  for (const entry of h.traces) if (entry.reason) assert.ok(HEARTBEAT_REASONS.includes(entry.reason), entry.reason);
  assert.equal(JSON.stringify(h.traces).includes('夜航星'), false, 'trace carries no titles or text');
});

test('spoken results feed pacing and status counts; status shows only product facts', async () => {
  let call = 0;
  const h = harness({ result: () => (++call === 1 ? { outcome: 'spoken' } : { outcome: 'quiet' }) });
  h.heartbeat.refresh();
  await h.clock.advance(30 * MIN);
  assert.equal(h.spoken.length, 1);
  assert.deepEqual(h.heartbeat.status(), { enabled: true, today: { wakes: 2, spoken: 1, quiet: 1, lines: 1 }, lastResult: 'quiet' });
  assert.equal(HEARTBEAT_REASONS.includes('paused-today'), false, '心跳不再有降档原因码');
  assert.equal(HEARTBEAT_REASONS.includes('degraded'), false);
});

test('turning the switch off disarms and aborts an in-flight wake', async () => {
  let release;
  const h = harness({ result: () => new Promise(resolve => { release = resolve; }) });
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  const [wake] = h.wakes;
  assert.equal(wake.signal.aborted, false);
  h.state.enabled = false;
  h.heartbeat.refresh();
  assert.equal(wake.signal.aborted, true);
  release({ outcome: 'silent', reason: 'interrupted' });
  await h.clock.advance(60 * MIN);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.heartbeat.pending(), null);
});

test('no new wake is armed while one is in flight; the next heartbeat anchors on that wake', async () => {
  let release;
  const h = harness({ result: () => new Promise(resolve => { release = resolve; }) });
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.equal(h.heartbeat.pending(), null);
  h.heartbeat.noteMoment({ kind: 'track_completed', sessionId: 'chat-a', personId: 'lunara' });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending(), null);
  await h.clock.advance(MIN);
  release({ outcome: 'quiet' });
  await h.heartbeat.settled();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 30 * MIN);
});

// ---- 2.5 重启不补发 ----

test('a restart arms one wake from the current time with no backlog', async () => {
  const h = harness({ start: NOON + 60 * MIN });
  h.heartbeat.refresh();
  assert.equal(h.wakes.length, 0);
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 75 * MIN);
  assert.equal(h.clock.timerCount, 1);
});

test('temperament profiles expose heartbeat cadence', () => {
  assert.deepEqual(['quiet', 'balanced', 'lively'].map(temperament => {
    const policy = resolvePresencePolicy({ temperament });
    return [policy.heartbeatMs / MIN, policy.minSpacingMs / MIN, policy.perHour];
  }), [[30, 12, 2], [15, 6, 4], [8, 3, 8]]);
});

// ---- 9. 阶段 A2：群聊的出声者与跟话顺序（D9） ----

test('a group wake names the voice holder and follow-up order resolved at the start of the tick', async () => {
  const room = { host: 'lunara' };
  const h = harness({ voiceOf: () => ({ holderId: room.host, followerIds: ['lunara', 'xiaoman', 'yehang'].filter(id => id !== room.host) }) });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().personId, 'lunara');
  // 设置里改了主持人：下一拍（这次到点时）就按新主持人。
  room.host = 'xiaoman';
  await h.clock.advance(15 * MIN);
  const [wake] = h.wakes;
  assert.equal(wake.personId, 'xiaoman');
  assert.deepEqual(wake.followerIds, ['lunara', 'yehang']);
  assert.ok(Object.isFrozen(wake.followerIds));
  assert.match(wake.id, /^ambient:chat-a:xiaoman:\d+$/);
});

test('a one-to-one wake has no followers', async () => {
  const h = harness();
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.deepEqual(h.wakes[0].followerIds, []);
});

test('cadence follows the voice holder temperament', () => {
  const h = harness({ voiceOf: () => ({ holderId: 'xiaoman', followerIds: ['lunara'] }) });
  const seen = [];
  h.heartbeat.temperamentFor = id => { seen.push(id); return id === 'xiaoman' ? 'lively' : 'quiet'; };
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 8 * MIN);
  assert.ok(seen.every(id => id === 'xiaoman'));
});

test('a broken voice resolver falls back to the one-to-one speaker', async () => {
  const h = harness({ voiceOf: () => { throw new Error('room gone'); } });
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes[0].personId, 'lunara');
  assert.deepEqual(h.wakes[0].followerIds, []);
});

test('one tick counts once against caps and pacing; status separates ticks from visible lines', async () => {
  const h = harness({ result: () => ({ outcome: 'spoken', lines: 2 }) });
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.spoken.length, 1, 'pacing is fed once per tick');
  assert.deepEqual(h.heartbeat.status().today, { wakes: 1, spoken: 1, quiet: 0, lines: 2 });
});

// ---- 6.5 她自己约的 followup ----

const followup = (over = {}) => ({ sessionId: 'chat-a', noteId: 'note:f1', personId: 'lunara', about: '问问方案交了没',
  dueAtMs: null, condition: null, ...over });

test('an inMinutes follow-up brings the wake to its absolute due time and rides on the wake', async () => {
  const followups = [followup({ dueAtMs: NOON + 6 * MIN })];
  const h = harness({ followups });
  h.heartbeat.refresh();
  assert.deepEqual(h.heartbeat.pending(), { sessionId: 'chat-a', personId: 'lunara', dueAtMs: NOON + 6 * MIN, reason: 'followup' });
  await h.clock.advance(6 * MIN);
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0].reason, 'followup');
  assert.deepEqual(h.wakes[0].followups, [{ noteId: 'note:f1', personId: 'lunara', about: '问问方案交了没' }]);
  assert.deepEqual(h.wakes[0].followupNoteIds, ['note:f1']);
  assert.ok(!h.traces.some(entry => JSON.stringify(entry).includes('方案')), 'followup 正文不进 trace');
});

test('a follow-up never wakes before min spacing after the previous wake', async () => {
  const followups = [];
  const h = harness({ followups });
  h.heartbeat.refresh();
  await h.clock.advance(15 * MIN);
  assert.equal(h.wakes.length, 1);
  followups.push(followup({ dueAtMs: NOON + 16 * MIN }));
  h.heartbeat.refresh();
  const minSpacing = resolvePresencePolicy({ modeId: null, temperament: 'balanced' }).minSpacingMs;
  assert.equal(h.heartbeat.pending().dueAtMs, Math.max(NOON + 16 * MIN, NOON + 15 * MIN + minSpacing));
  assert.equal(h.heartbeat.pending().reason, 'followup');
});

test('a follow-up already due before arming is not replayed on its own', () => {
  const h = harness({ followups: [followup({ dueAtMs: NOON - 5 * MIN })] });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().reason, 'heartbeat');
  assert.equal(h.heartbeat.pending().dueAtMs, NOON + 15 * MIN);
});

test('an afterCurrentTrack follow-up nudges when its own occurrence completes or is skipped even once', async () => {
  for (const kind of ['track_completed', 'track_skipped']) {
    const h = harness({ followups: [followup({ condition: 'afterCurrentTrack:q1' })] });
    h.heartbeat.refresh();
    if (kind === 'track_skipped') {
      h.heartbeat.noteMoment({ sessionId: 'chat-a', kind, evidence: { track: { queueItemId: 'q9' }, consecutiveSkips: 1 } });
      assert.equal(h.heartbeat.pending().reason, 'heartbeat', 'a single skip of another occurrence does not nudge');
    }
    h.heartbeat.noteMoment({ sessionId: 'chat-a', kind, evidence: { track: { queueItemId: 'q1' }, consecutiveSkips: 1 } });
    assert.deepEqual(h.heartbeat.pending(), { sessionId: 'chat-a', personId: 'lunara', dueAtMs: NOON + 30_000, reason: kind });
    await h.clock.advance(30_000);
    assert.deepEqual(h.wakes[0].followupNoteIds, ['note:f1']);
  }
});

test('a nextListening follow-up rides on the next session_open, which keeps its own reason', async () => {
  const h = harness({ followups: [followup({ condition: 'nextListening' })] });
  h.heartbeat.refresh();
  h.heartbeat.noteMoment({ sessionId: 'chat-a', kind: 'session_open', evidence: {} });
  assert.equal(h.heartbeat.pending().reason, 'session_open');
  await h.clock.advance(30_000);
  assert.equal(h.wakes[0].reason, 'session_open');
  assert.deepEqual(h.wakes[0].followupNoteIds, ['note:f1']);
});

test('a follow-up settled before the wake fires falls back to a plain heartbeat wake', async () => {
  const followups = [followup({ dueAtMs: NOON + 6 * MIN })];
  const h = harness({ followups });
  h.heartbeat.refresh();
  followups.length = 0;
  await h.clock.advance(6 * MIN);
  assert.equal(h.wakes[0].reason, 'heartbeat');
  assert.deepEqual(h.wakes[0].followups, []);
});

test('a broken follow-up source never breaks scheduling', () => {
  const h = harness();
  h.heartbeat.followupsFor = () => { throw new Error('db closed'); };
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending().reason, 'heartbeat');
  h.heartbeat.noteMoment({ sessionId: 'chat-a', kind: 'track_completed', evidence: { track: { queueItemId: 'q1' } } });
});

test('reception cadence multiplies only the heartbeat interval; event nudges keep their timing (expression-and-reception 3.2)', async () => {
  const policy = resolvePresencePolicy({ modeId: null, temperament: 'balanced' });
  let factor = 2;
  const { heartbeat } = harness({ cadence: () => factor });
  heartbeat.refresh();
  assert.equal(heartbeat.pending().dueAtMs, NOON + policy.heartbeatMs * 2, '间隔 × 2（抖动 1.0）');
  factor = 9;
  heartbeat.noteUserTurn('other');
  assert.equal(heartbeat.pending().dueAtMs, NOON + policy.heartbeatMs * 2, '系数在心跳里再夹到 2.0');
  heartbeat.noteMoment({ sessionId: 'chat-a', kind: 'track_completed', evidence: {} });
  const nudged = heartbeat.pending();
  assert.equal(nudged.reason, 'track_completed');
  assert.equal(nudged.dueAtMs, NOON + 30_000, '事件提前不受节奏系数影响');

  factor = 0.1;
  const fast = harness({ cadence: () => factor });
  fast.heartbeat.refresh();
  assert.equal(fast.heartbeat.pending().dueAtMs, NOON + policy.heartbeatMs * 0.75, '下限 0.75');
  const broken = harness({ cadence: () => { throw new Error('boom'); } });
  broken.heartbeat.refresh();
  assert.equal(broken.heartbeat.pending().dueAtMs, NOON + policy.heartbeatMs, '读不到系数按 1');
});

test('listener asked quiet disarms for that listening source and aborts an in-flight ambient turn (3.3)', async () => {
  let quiet = null;
  let aborted = false;
  const h = harness({ quietFor: sessionId => sessionId === quiet,
    result: wake => new Promise(resolve => wake.signal.addEventListener('abort', () => { aborted = true; resolve({ outcome: 'silent', reason: 'interrupted' }); })) });
  h.heartbeat.refresh();
  await h.clock.advance(h.heartbeat.pending().dueAtMs - NOON);
  assert.equal(h.wakes.length, 1, '已经叫醒、正在生成');
  quiet = 'chat-a';
  h.heartbeat.refresh();
  await flush();
  assert.equal(aborted, true, '进行中的这一拍作废');
  assert.equal(h.heartbeat.pending(), null);
  assert.ok(HEARTBEAT_REASONS.includes('listener-asked-quiet'));

  h.state.snapshot = playing({ activeListeningSessionId: 'chat-b' });
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending()?.sessionId, 'chat-b', '别的来源照常上弦');
  quiet = null;
  h.state.snapshot = playing();
  h.heartbeat.refresh();
  assert.equal(h.heartbeat.pending()?.sessionId, 'chat-a', '恢复后重新上弦');
});
