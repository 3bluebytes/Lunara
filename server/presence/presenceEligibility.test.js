import test from 'node:test';
import assert from 'node:assert/strict';
import { decidePresence, PRESENCE_REASONS } from './presenceEligibility.js';
import { resolvePresencePolicy } from './presenceTemperament.js';

const MIN = 60_000;
const NOON = Date.UTC(2026, 9, 18, 4, 0); // 12:00 Asia/Shanghai
const ctx = (overrides = {}) => ({ nowMs: NOON, enabled: true, modeId: 'occasional', timeZone: 'Asia/Shanghai',
  userActive: false, ...overrides });
const entry = (overrides = {}) => ({ sessionId: 'room', activations: 4, consecutiveSkips: 0, completedCount: 0,
  skipCount: 0, lastVoiceAtMs: null, presenceLog: [], momentCounters: {}, ...overrides });
const moment = (kind, evidence = {}) => ({ kind, triggerKey: `room/lunara/${kind}/x`, personId: 'lunara', evidence });

test('session_open and queue_exhausted are eligible by default; once per session', () => {
  assert.deepEqual(decidePresence(moment('session_open'), entry(), ctx()), { decision: 'speak', reason: 'eligible' });
  assert.deepEqual(decidePresence(moment('queue_exhausted'), entry(), ctx()), { decision: 'speak', reason: 'eligible' });
  const spoke = entry({ momentCounters: { session_open: { spoken: 1 } } });
  assert.equal(decidePresence(moment('session_open'), spoke, ctx()).reason, 'moment-cap');
});

test('a boundary is structurally eligible once per three occurrences; whether there is anything to say is the hook gate', () => {
  // 有没有话可说（选歌理由、刚才的聊天、同歌手……）由 PresenceRuntime 的钩子判定，不在这里。
  const plain = moment('boundary_without_intro', {});
  assert.equal(decidePresence(plain, entry(), ctx()).decision, 'speak');
  const recent = entry({ momentCounters: { boundary_without_intro: { spoken: 1, sinceSpoken: 2 } } });
  assert.equal(decidePresence(plain, recent, ctx()).reason, 'moment-cap');
  const later = entry({ momentCounters: { boundary_without_intro: { spoken: 1, sinceSpoken: 3 } } });
  assert.equal(decidePresence(plain, later, ctx()).decision, 'speak');
});

test('the speaking companion\'s temperament sets open moments, budgets and caps; hard floors never move', () => {
  const quiet = resolvePresencePolicy({ modeId: 'conversational', temperament: 'quiet' });
  const lively = resolvePresencePolicy({ modeId: 'conversational', temperament: 'lively' });
  assert.equal(decidePresence(moment('track_completed'), entry(), ctx({ policy: quiet })).reason, 'temperament-closed');
  assert.equal(decidePresence(moment('session_open'), entry(), ctx({ policy: quiet })).decision, 'speak');
  assert.equal(decidePresence(moment('session_open'), entry({ presenceLog: [NOON - 3 * MIN] }), ctx({ policy: quiet })).reason,
    'budget-exhausted', 'quiet：15 分钟 1 次');
  const twoRecent = entry({ presenceLog: [NOON - 10 * MIN, NOON - 3 * MIN] });
  assert.equal(decidePresence(moment('queue_exhausted'), twoRecent, ctx({ policy: lively })).decision, 'speak', 'lively：15 分钟 3 次');
  const doneThree = entry({ momentCounters: { track_completed: { spoken: 1, sinceSpoken: 3 } } });
  assert.equal(decidePresence(moment('track_completed'), doneThree, ctx({ policy: lively })).decision, 'speak');
  assert.equal(decidePresence(moment('track_completed'), doneThree, ctx()).reason, 'moment-cap', 'balanced 仍是每 5 首一次');
  assert.equal(decidePresence(moment('session_open'), entry({ lastVoiceAtMs: NOON - 60_000 }), ctx({ policy: lively })).reason,
    'too-soon', '120 秒人声间隔不随性格变化');
  assert.equal(decidePresence(moment('session_open'), entry(), ctx({ policy: null })).reason, 'mode-silent');
});

test('skips speak only after two in a row and at most once per two skips; completions once per five', () => {
  assert.equal(decidePresence(moment('track_skipped', { consecutiveSkips: 1 }), entry(), ctx()).reason, 'no-evidence');
  assert.equal(decidePresence(moment('track_skipped', { consecutiveSkips: 2 }), entry(), ctx()).decision, 'speak');
  const skipCap = entry({ momentCounters: { track_skipped: { spoken: 1, sinceSpoken: 1 } } });
  assert.equal(decidePresence(moment('track_skipped', { consecutiveSkips: 3 }), skipCap, ctx()).reason, 'moment-cap');
  const doneCap = entry({ momentCounters: { track_completed: { spoken: 1, sinceSpoken: 4 } } });
  assert.equal(decidePresence(moment('track_completed'), doneCap, ctx()).reason, 'moment-cap');
  const doneOk = entry({ momentCounters: { track_completed: { spoken: 1, sinceSpoken: 5 } } });
  assert.equal(decidePresence(moment('track_completed'), doneOk, ctx()).decision, 'speak');
});

test('gates: disabled, music-only, user activity, quiet hours, voice interval and budgets', () => {
  const m = moment('session_open');
  const reasonOf = (e, c) => decidePresence(m, entry(e), ctx(c)).reason;
  assert.equal(reasonOf({}, { enabled: false }), 'presence-disabled');
  assert.equal(reasonOf({}, { modeId: 'music_only' }), 'mode-silent');
  assert.equal(reasonOf({}, { userActive: true }), 'user-active');
  assert.equal(reasonOf({}, { nowMs: Date.UTC(2026, 9, 18, 16, 0) }), 'quiet-hours', '00:00 上海');
  assert.equal(reasonOf({}, { nowMs: Date.UTC(2026, 9, 18, 15, 29) }), 'eligible', '23:29 上海仍可');
  assert.equal(reasonOf({}, { nowMs: Date.UTC(2026, 9, 18, 0, 0) }), 'eligible', '08:00 上海可');
  assert.equal(reasonOf({ lastVoiceAtMs: NOON - 119_000 }), 'too-soon');
  assert.equal(reasonOf({ lastVoiceAtMs: NOON - 120_000 }), 'eligible');
  assert.equal(reasonOf({ presenceLog: [NOON - 14 * MIN, NOON - 3 * MIN] }), 'budget-exhausted', '15 分钟内已 2 次');
  assert.equal(reasonOf({ presenceLog: [NOON - 16 * MIN, NOON - 3 * MIN] }), 'eligible');
  assert.equal(reasonOf({ presenceLog: Array.from({ length: 8 }, (_, i) => NOON - (60 + i) * MIN) }), 'budget-exhausted', '每场 8 次');
  assert.equal(reasonOf({}, { modeId: null }), 'eligible', 'legacy 会话不额外静音 presence');
});

test('reasons are a closed set', () => {
  for (const reason of ['eligible', 'no-evidence', 'moment-cap', 'presence-disabled', 'mode-silent',
    'user-active', 'quiet-hours', 'too-soon', 'budget-exhausted', 'unknown-moment']) assert.ok(PRESENCE_REASONS.includes(reason), reason);
  assert.equal(decidePresence(moment('whatever'), entry(), ctx()).reason, 'unknown-moment');
});

test('in-flight generation and pacing levels gate before budgets; reduced keeps only open/exhausted', () => {
  assert.equal(decidePresence(moment('session_open'), entry(), ctx({ inFlight: true })).reason, 'in-flight');
  assert.equal(decidePresence(moment('session_open'), entry(), ctx({ pacingLevel: 2 })).reason, 'paused-today');
  assert.equal(decidePresence(moment('session_open'), entry(), ctx({ pacingLevel: 1 })).decision, 'speak');
  assert.equal(decidePresence(moment('queue_exhausted'), entry(), ctx({ pacingLevel: 1 })).decision, 'speak');
  assert.equal(decidePresence(moment('track_completed'), entry(), ctx({ pacingLevel: 1 })).reason, 'degraded');
  for (const reason of ['in-flight', 'degraded', 'paused-today']) assert.ok(PRESENCE_REASONS.includes(reason));
});
