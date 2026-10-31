// 「回来了」打招呼（add-app-open-greeting）：回来的判定、门槛、上限与作废。
// 依赖全部注入：时钟、prefs KV、房间列表、心里话、轮次执行器都是替身。
import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_OPEN_LIMITS, APP_OPEN_STATE_KEY, createAppOpenGreeter } from './AppOpenGreeter.js';

const HOUR = 3_600_000;
const NOON = Date.UTC(2026, 9, 20, 4, 0); // 12:00 Asia/Shanghai

function harness({ prefs = {}, rooms = null, notes = [], enabled = true, quietHours = false, budget = false,
  listenerQuiet = () => false, heartbeatRoom = () => false, runTurn = null } = {}) {
  let nowMs = NOON;
  const store = new Map(Object.entries(prefs).map(([key, value]) => [key, JSON.stringify(value)]));
  const state = { getPref: key => store.get(key) ?? null,
    setPref: (key, value) => store.set(key, typeof value === 'string' ? value : JSON.stringify(value)) };
  const timers = [];
  const wakes = [], traces = [], noteQueries = [];
  const roomList = rooms || [
    { sessionId: 'older', activeVirtualPersonId: 'mika', memberIds: ['mika'], lastTurnAt: NOON - 30 * HOUR, archivedAt: null },
    { sessionId: 'recent', activeVirtualPersonId: 'lunara', memberIds: ['lunara', 'mika'], lastTurnAt: NOON - 20 * HOUR, archivedAt: null },
  ];
  const greeter = createAppOpenGreeter({
    state, now: () => nowMs, timeZone: 'Asia/Shanghai',
    isEnabled: () => enabled,
    inQuietHours: () => quietHours,
    budgetExhausted: () => budget,
    listenerQuiet,
    isHeartbeatRoom: heartbeatRoom,
    listRooms: () => roomList,
    notesFor: query => { noteQueries.push(query); return notes; },
    runTurn: runTurn || (async wake => { wakes.push(wake); return { outcome: 'text-only', lines: 1 }; }),
    trace: (sessionId, event) => traces.push({ sessionId, ...event }),
    setTimer: (fn, ms) => { const timer = { fn, at: nowMs + ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
    logger: { warn() {} },
  });
  const saved = () => JSON.parse(store.get(APP_OPEN_STATE_KEY) || 'null');
  const advance = ms => {
    const until = nowMs + ms;
    for (;;) {
      const next = timers.filter(t => !t.cleared && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.cleared = true;
      nowMs = next.at;
      next.fn();
    }
    nowMs = until;
  };
  return { greeter, wakes, traces, noteQueries, saved, advance, timers, set: ms => { nowMs = ms; }, now: () => nowMs,
    show: () => greeter.updateClients({ visible: 1, typing: false }),
    hide: () => greeter.updateClients({ visible: 0, typing: false }) };
}

const lastSeen = ms => ({ [APP_OPEN_STATE_KEY]: { version: 1, lastVisibleAt: ms, greeted: {} } });
const thought = [{ noteId: 'n1', kind: 'thought', text: '那首歌的尾奏', due: true }];

test('back after the night: one wake in the most recently active room, spoken by its host, text only', async () => {
  const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought });
  h.show();
  await h.greeter.settled();
  assert.equal(h.wakes.length, 1);
  const [wake] = h.wakes;
  assert.equal(wake.reason, 'app_open');
  assert.equal(wake.sessionId, 'recent', '最近活跃的聊天，群聊也可以');
  assert.equal(wake.personId, 'lunara', '主持伙伴说话');
  assert.deepEqual(wake.followerIds, [], '群聊 v1 不追加跟话者');
  assert.equal(wake.awayMs, 10 * HOUR);
  assert.equal(wake.firedAtMs, NOON);
  assert.ok(wake.signal && wake.signal.aborted === false);
  assert.equal(h.saved().lastVisibleAt, NOON, '回来即记录可见时刻');
  assert.deepEqual(h.traces.map(t => t.type), ['app_open_wake', 'app_open_result']);
  assert.equal(h.traces[0].awayBucket, 'overnight');
});

test('short absences, reconnects and background windows are not a return', async () => {
  const h = harness({ prefs: lastSeen(NOON - 30 * 60_000), notes: thought });
  h.show();
  await h.greeter.settled();
  assert.equal(h.wakes.length, 0, '离开不到 1 小时');
  h.advance(10 * HOUR); // 一直可见（后台挂着的窗口也算可见连接）
  h.greeter.updateClients({ visible: 2, typing: false }); // 另一台设备连上
  h.hide();
  h.advance(60_000);
  h.show(); // 断线一分钟又回来
  await h.greeter.settled();
  assert.equal(h.wakes.length, 0);
});

test('lastVisibleAt is refreshed while visible and stamped on hide, so a restart measures the real absence', async () => {
  const h = harness({ prefs: lastSeen(NOON - 30 * 60_000) });
  h.show();
  h.advance(APP_OPEN_LIMITS.refreshMs + 1);
  assert.equal(h.saved().lastVisibleAt, NOON + APP_OPEN_LIMITS.refreshMs, '可见期间定期刷新');
  h.advance(60_000);
  h.hide();
  assert.equal(h.saved().lastVisibleAt, h.now());
  assert.equal(h.timers.filter(t => !t.cleared).length, 0, '不可见时不留定时器');
});

test('first run only records; nothing to say after a couple of hours stays silent; overnight may greet plainly', async () => {
  const first = harness();
  first.show();
  await first.greeter.settled();
  assert.equal(first.wakes.length, 0);
  assert.equal(first.saved().lastVisibleAt, NOON);

  const shortAway = harness({ prefs: lastSeen(NOON - 2 * HOUR) });
  shortAway.show();
  await shortAway.greeter.settled();
  assert.equal(shortAway.wakes.length, 0);
  assert.deepEqual(shortAway.traces.map(t => [t.sessionId, t.type, t.reason]), [['recent', 'app_open_skipped', 'nothing-to-say']]);
  assert.deepEqual(shortAway.noteQueries, [{ personId: 'lunara', sessionId: 'recent', isGroup: true, mode: 'ambient',
    wake: { reason: 'app_open' } }], '用 ambient 心里话过滤器看主持伙伴有没有可提的事');

  const overnight = harness({ prefs: lastSeen(NOON - APP_OPEN_LIMITS.longAwayMs) });
  overnight.show();
  await overnight.greeter.settled();
  assert.equal(overnight.wakes.length, 1, '隔夜没有心事也可以简单打招呼');
});

test('gates: setting, quiet hours, budget, no room, listener quiet, heartbeat-owned room — closed reason codes, no model call', async () => {
  const cases = [
    [{ enabled: false }, 'disabled'],
    [{ quietHours: true }, 'quiet-hours'],
    [{ budget: true }, 'llm-budget'],
    [{ rooms: [{ sessionId: 'gone', activeVirtualPersonId: 'lunara', memberIds: ['lunara'], lastTurnAt: 1, archivedAt: 5 }] }, 'no-room'],
    [{ listenerQuiet: sid => sid === 'recent' }, 'listener-quiet'],
    [{ heartbeatRoom: sid => sid === 'recent' }, 'heartbeat-owns'],
  ];
  for (const [options, reason] of cases) {
    const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought, ...options });
    h.show();
    const result = await h.greeter.settled();
    assert.equal(h.wakes.length, 0, reason);
    assert.equal(result.reason, reason);
  }
});

test('once per room per local day, counted at wake even when she stayed quiet', async () => {
  const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought,
    runTurn: async wake => { h.wakes.push(wake); return { outcome: 'quiet', lines: 0 }; } });
  h.show();
  await h.greeter.settled();
  h.hide();
  h.advance(2 * HOUR);
  h.show();
  assert.equal((await h.greeter.settled()).reason, 'already-today');
  assert.equal(h.wakes.length, 1);
  h.hide();
  h.advance(20 * HOUR); // 第二天早上
  h.show();
  await h.greeter.settled();
  assert.equal(h.wakes.length, 2);
  assert.deepEqual(Object.keys(h.saved().greeted), ['recent'], '只保留当天的记录');
});

test('typing, any user turn, all clients hidden or the 20 s deadline abort the greeting', async () => {
  const triggers = {
    typing: h => h.greeter.updateClients({ visible: 1, typing: true }),
    userTurn: h => h.greeter.noteUserTurn('older'),
    hidden: h => h.hide(),
    deadline: h => h.advance(APP_OPEN_LIMITS.deadlineMs),
  };
  for (const [name, fire] of Object.entries(triggers)) {
    let release;
    const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought,
      runTurn: wake => new Promise(resolve => { h.wakes.push(wake); release = () => resolve({ outcome: 'silent', reason: 'interrupted' }); }) });
    h.show();
    await new Promise(setImmediate);
    assert.equal(h.wakes.length, 1, name);
    fire(h);
    assert.equal(h.wakes[0].signal.aborted, true, name);
    assert.equal(h.wakes[0].signal.reason, name === 'deadline' ? 'deadline' : 'interrupted');
    release();
    await h.greeter.settled();
  }
});

test('a failing turn runner is contained and traced as error', async () => {
  const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought, runTurn: async () => { throw new Error('boom'); } });
  h.show();
  const result = await h.greeter.settled();
  assert.equal(result.outcome, 'silent');
  assert.equal(h.traces.at(-1).reason, 'error');
  assert.equal(JSON.stringify(h.traces).includes('boom'), false);
});
