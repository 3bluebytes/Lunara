// 「回来了」打招呼（add-app-open-greeting）：回来的判定、门槛、上限与作废。
// 依赖全部注入：时钟、prefs KV、房间列表、心里话、轮次执行器都是替身。
import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_OPEN_LIMITS, APP_OPEN_STATE_KEY, createAppOpenGreeter } from './AppOpenGreeter.js';

const HOUR = 3_600_000;
const NOON = Date.UTC(2026, 9, 20, 4, 0); // 12:00 Asia/Shanghai

function harness({ prefs = {}, rooms = null, notes = [], enabled = true, quietHours = false, budget = false,
  listenerQuiet = () => false, runTurn = null, reserveHost = null } = {}) {
  let nowMs = NOON;
  const store = new Map(Object.entries(prefs).map(([key, value]) => [key, JSON.stringify(value)]));
  const state = { getPref: key => store.get(key) ?? null,
    setPref: (key, value) => store.set(key, typeof value === 'string' ? value : JSON.stringify(value)) };
  const timers = [];
  const wakes = [], traces = [];
  const roomList = rooms || [
    { sessionId: 'older', activeVirtualPersonId: 'mika', memberIds: ['mika'], lastTurnAt: NOON - 30 * HOUR, archivedAt: null },
    { sessionId: 'recent', activeVirtualPersonId: 'lunara', memberIds: ['lunara', 'mika'], lastTurnAt: NOON - 20 * HOUR, archivedAt: null },
  ];
  const greeter = createAppOpenGreeter({
    state, now: () => nowMs, timeZone: 'Asia/Shanghai',
    isEnabled: () => typeof enabled === 'function' ? enabled() : enabled,
    inQuietHours: () => typeof quietHours === 'function' ? quietHours() : quietHours,
    budgetExhausted: () => typeof budget === 'function' ? budget() : budget,
    listenerQuiet, reserveHost,
    listRooms: () => roomList,
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
  return { greeter, wakes, traces, saved, advance, timers, set: ms => { nowMs = ms; }, now: () => nowMs,
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

test('reconnects and background windows are not a return', async () => {
  const h = harness({ prefs: lastSeen(NOON - 4 * 60_000), notes: thought });
  h.show();
  await h.greeter.settled();
  assert.equal(h.wakes.length, 0, '四分钟内重连');
  h.advance(10 * HOUR); // 一直可见（后台挂着的窗口也算可见连接）
  h.greeter.updateClients({ visible: 2, typing: false }); // 另一台设备连上
  h.hide();
  h.advance(4 * 60_000);
  h.show(); // 断线四分钟又回来
  await h.greeter.settled();
  assert.equal(h.wakes.length, 0);
  h.hide();
  h.advance(5 * 60_000);
  h.show(); // 满五分钟才算回来
  await h.greeter.settled();
  assert.equal(h.wakes.length, 1);
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

test('first run only records; every return wakes her, notes or not, and she decides whether to speak', async () => {
  const first = harness();
  first.show();
  await first.greeter.settled();
  assert.equal(first.wakes.length, 0);
  assert.equal(first.saved().lastVisibleAt, NOON);

  const shortAway = harness({ prefs: lastSeen(NOON - 2 * HOUR) });
  shortAway.show();
  await shortAway.greeter.settled();
  assert.equal(shortAway.wakes.length, 1, '没有心里话、离开两小时也叫醒');
  assert.deepEqual(shortAway.traces.map(t => t.type), ['app_open_wake', 'app_open_result']);

  const reopened = harness({ prefs: lastSeen(NOON - 20 * 60_000) });
  reopened.show();
  await reopened.greeter.settled();
  assert.equal(reopened.wakes.length, 1, '关了窗口二十分钟再打开也算回来');

  const overnight = harness({ prefs: lastSeen(NOON - 8 * HOUR) });
  overnight.show();
  await overnight.greeter.settled();
  assert.equal(overnight.wakes.length, 1, '隔夜没有心事也可以简单打招呼');
});

test('gates: setting, quiet hours, budget, no room, listener quiet — closed reason codes, no model call', async () => {
  const cases = [
    [{ enabled: false }, 'disabled'],
    [{ quietHours: true }, 'quiet-hours'],
    [{ budget: true }, 'llm-budget'],
    [{ rooms: [{ sessionId: 'gone', activeVirtualPersonId: 'lunara', memberIds: ['lunara'], lastTurnAt: 1, archivedAt: 5 }] }, 'no-room'],
    [{ listenerQuiet: sid => sid === 'recent' }, 'listener-quiet'],
  ];
  for (const [options, reason] of cases) {
    const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought, ...options });
    h.show();
    const result = await h.greeter.settled();
    assert.equal(h.wakes.length, 0, reason);
    assert.equal(result.reason, reason);
  }
});

test('no daily limit: every return the same day wakes her, and a timed-out greeting does not use anything up', async () => {
  let calls = 0;
  const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought,
    runTurn: async wake => { h.wakes.push(wake); calls += 1; return calls === 1 ? { outcome: 'silent', reason: 'deadline' } : { outcome: 'quiet', lines: 0 }; } });
  h.show();
  await h.greeter.settled();
  for (let index = 0; index < 2; index += 1) {
    h.hide();
    h.advance(3 * HOUR);
    h.show();
    await h.greeter.settled();
  }
  assert.equal(h.wakes.length, 3);
  assert.ok(!h.traces.some(t => t.type === 'app_open_skipped'));
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

test('startup admission transfers synchronously to the greeting, then releases after delivery', async () => {
  const events = [];
  const h = harness({ prefs: lastSeen(NOON - HOUR), reserveHost: (sid, options) => {
    events.push(['hold', sid]);
    if (sid) assert.equal(options.signal.aborted, false);
    return () => events.push(['release', sid]);
  } });
  assert.deepEqual(events, [['hold', null]], '恢复播放前已有全局保留');
  h.show();
  await h.greeter.settled();
  assert.deepEqual(events, [['hold', null], ['hold', 'recent'], ['release', null], ['release', 'recent']]);
});

test('no-client startup waits at most twenty seconds; disabled, quiet, first-run and budget gates never hold', async () => {
  for (const options of [{}, { enabled: false }, { quietHours: true }, { budget: true }, { first: true }]) {
    const events = [];
    const h = harness({ prefs: options.first ? {} : lastSeen(NOON - HOUR), ...options,
      reserveHost: sid => { events.push(['hold', sid]); return () => events.push(['release', sid]); } });
    if (!Object.keys(options).length) {
      assert.deepEqual(events, [['hold', null]]);
      h.advance(APP_OPEN_LIMITS.deadlineMs);
      assert.deepEqual(events, [['hold', null], ['release', null]]);
      assert.equal(h.wakes.length, 0);
    } else assert.deepEqual(events, [], JSON.stringify(options));
    h.greeter.stop();
    assert.equal(h.timers.filter(t => !t.cleared).length, 0);
  }
});

test('turning off or shutting down before the first visible client releases startup admission', () => {
  for (const cancel of ['abort', 'stop', 'noteUserTurn']) {
    let released = 0;
    const h = harness({ prefs: lastSeen(NOON - HOUR), reserveHost: () => () => { released += 1; } });
    h.greeter[cancel]();
    h.greeter.stop();
    h.advance(APP_OPEN_LIMITS.deadlineMs);
    assert.equal(released, 1, cancel);
  }
});

const flush = () => new Promise(setImmediate);
const RETRY_MS = 250;

test('busy retries are serial, bounded, and reuse one wake; duplicate visibility does not start another greeting', async () => {
  const rooms = [{ sessionId: 'recent', activeVirtualPersonId: 'lunara', memberIds: ['lunara'], lastTurnAt: 1 }];
  const h = harness({ prefs: lastSeen(NOON - HOUR), rooms, runTurn: async wake => {
    h.wakes.push(wake);
    return h.wakes.length <= 3 ? { outcome: 'silent', reason: 'turn-busy' } : { outcome: 'text-only', lines: 1 };
  } });
  h.show();
  await flush();
  h.greeter.updateClients({ visible: 2, typing: false });
  rooms.push({ sessionId: 'newest', activeVirtualPersonId: 'mika', memberIds: ['mika'], lastTurnAt: NOON });
  assert.equal(h.wakes.length, 1);
  for (let index = 0; index < 3; index += 1) {
    h.advance(RETRY_MS - 1);
    await flush();
    assert.equal(h.wakes.length, index + 1, 'busy 不能立即自旋重试');
    h.advance(1);
    await flush();
  }
  assert.deepEqual(await h.greeter.settled(), { outcome: 'text-only', reason: 'text-only' });
  assert.equal(h.wakes.length, 4);
  assert.equal(h.wakes.at(-1).sessionId, 'recent', '有更新的聊天也不重定向成功问候');
  assert.ok(h.wakes.every(wake => wake === h.wakes[0]), '同一 wake、signal、主持人和回来时刻');
  assert.deepEqual(h.traces.map(t => t.type), ['app_open_wake', 'app_open_result']);
  h.hide();
  assert.equal(h.timers.filter(t => !t.cleared).length, 0, '完成后不留等待或截止定时器');
});

test('waiting for a busy host is immediately cancelled by typing, user turns, hide, switch-off or shutdown', async () => {
  const triggers = {
    typing: h => h.greeter.updateClients({ visible: 1, typing: true }),
    userTurn: h => h.greeter.noteUserTurn('older'),
    hide: h => h.hide(),
    switchOff: h => h.greeter.abort(),
    shutdown: h => h.greeter.stop(),
  };
  for (const [name, fire] of Object.entries(triggers)) {
    const h = harness({ prefs: lastSeen(NOON - HOUR), runTurn: async wake => {
      h.wakes.push(wake);
      return { outcome: 'silent', reason: 'turn-busy' };
    } });
    h.show();
    await flush();
    fire(h);
    assert.deepEqual(await h.greeter.settled(), { outcome: 'silent', reason: 'interrupted' }, name);
    h.advance(APP_OPEN_LIMITS.deadlineMs + RETRY_MS);
    await flush();
    assert.equal(h.wakes.length, 1, `${name}: 取消后不能补试`);
    h.greeter.stop();
    assert.equal(h.timers.filter(t => !t.cleared).length, 0, name);
  }
});

test('busy waits and generation share the original twenty-second deadline, with no late retry', async () => {
  const h = harness({ prefs: lastSeen(NOON - HOUR), runTurn: async wake => {
    h.wakes.push(wake);
    if (h.wakes.length === 1) return { outcome: 'silent', reason: 'turn-busy' };
    return new Promise(resolve => wake.signal.addEventListener('abort', () => resolve({ outcome: 'silent' }), { once: true }));
  } });
  h.show();
  await flush();
  h.advance(APP_OPEN_LIMITS.deadlineMs - RETRY_MS);
  await flush();
  assert.equal(h.wakes.length, 2);
  h.advance(RETRY_MS);
  assert.deepEqual(await h.greeter.settled(), { outcome: 'silent', reason: 'deadline' });
  assert.equal(h.now(), NOON + APP_OPEN_LIMITS.deadlineMs, '等待后生成不能再拿新的 20 秒');

  const busy = harness({ prefs: lastSeen(NOON - HOUR), runTurn: async wake => {
    busy.wakes.push(wake);
    return { outcome: 'silent', reason: 'turn-busy' };
  } });
  busy.show();
  await flush();
  busy.advance(APP_OPEN_LIMITS.deadlineMs);
  assert.deepEqual(await busy.greeter.settled(), { outcome: 'silent', reason: 'deadline' });
  assert.equal(busy.wakes.length, 1, '事件循环晚醒时不可越过截止补试');
});

test('retry revalidates gates and the original room/host instead of retargeting', async () => {
  for (const reason of ['disabled', 'quiet-hours', 'llm-budget', 'listener-quiet', 'archived', 'host-changed', 'host-left']) {
    let blocked = false;
    const room = { sessionId: 'chat', activeVirtualPersonId: 'lunara', memberIds: ['lunara', 'mika'], lastTurnAt: 1 };
    const rooms = [room];
    const h = harness({ prefs: lastSeen(NOON - HOUR), rooms,
      enabled: () => !(blocked && reason === 'disabled'),
      quietHours: () => blocked && reason === 'quiet-hours',
      budget: () => blocked && reason === 'llm-budget',
      listenerQuiet: () => blocked && reason === 'listener-quiet',
      runTurn: async wake => { h.wakes.push(wake); return { outcome: 'silent', reason: 'turn-busy' }; } });
    h.show();
    await flush();
    blocked = true;
    if (reason === 'archived') room.archivedAt = NOON;
    if (reason === 'host-changed') room.activeVirtualPersonId = 'mika';
    if (reason === 'host-left') room.memberIds = ['mika'];
    rooms.push({ sessionId: 'newest', activeVirtualPersonId: 'mika', memberIds: ['mika'], lastTurnAt: NOON });
    h.advance(RETRY_MS);
    await flush();
    const result = await h.greeter.settled();
    assert.equal(result.reason, ['archived', 'host-changed', 'host-left'].includes(reason) ? 'stale' : reason);
    assert.equal(h.wakes.length, 1, reason);
  }
});

test('delivered, deliberate quiet and non-busy failures never retry', async () => {
  for (const result of [{ outcome: 'text-only', lines: 1 }, { outcome: 'quiet' },
    { outcome: 'silent', reason: 'error' }, { outcome: 'silent', reason: 'stale' }]) {
    const h = harness({ prefs: lastSeen(NOON - HOUR), runTurn: async wake => { h.wakes.push(wake); return result; } });
    h.show();
    await h.greeter.settled();
    h.advance(APP_OPEN_LIMITS.deadlineMs);
    await flush();
    assert.equal(h.wakes.length, 1);
  }
});

test('returning with an existing typing draft does not start a greeting after it is cleared', async () => {
  const h = harness({ prefs: lastSeen(NOON - HOUR) });
  h.greeter.updateClients({ visible: 1, typing: true });
  await h.greeter.settled();
  h.show();
  await h.greeter.settled();
  assert.equal(h.wakes.length, 0);
});

test('a failing turn runner is contained and traced as error', async () => {
  const h = harness({ prefs: lastSeen(NOON - 10 * HOUR), notes: thought, runTurn: async () => { throw new Error('boom'); } });
  h.show();
  const result = await h.greeter.settled();
  assert.equal(result.outcome, 'silent');
  assert.equal(h.traces.at(-1).reason, 'error');
  assert.equal(JSON.stringify(h.traces).includes('boom'), false);
});

test('desktop idleReturn (>= 25m) wakes targeted idle room while visible; ignores <25m and skips archived target', async () => {
  const rooms = [
    { sessionId: 'older', activeVirtualPersonId: 'mika', memberIds: ['mika'], lastTurnAt: NOON - 50 * HOUR, archivedAt: null },
    { sessionId: 'recent', activeVirtualPersonId: 'lunara', memberIds: ['lunara'], lastTurnAt: NOON - 2 * HOUR, archivedAt: null },
    { sessionId: 'archived', activeVirtualPersonId: 'lunara', memberIds: ['lunara'], lastTurnAt: NOON - HOUR, archivedAt: NOON - 10_000 },
  ];
  const h = harness({ prefs: lastSeen(NOON), rooms });
  h.show();
  await h.greeter.settled();
  assert.equal(h.wakes.length, 0);

  // Too short (< 25m) is ignored.
  h.greeter.updateClients({
    visible: 1,
    typing: false,
    idleReturn: { sessionId: 'older', awayMs: 24 * 60_000, firedAtMs: NOON + 24 * 60_000 },
  });
  await h.greeter.settled();
  assert.equal(h.wakes.length, 0);

  // Archived targeted room is skipped with no-room rather than greeting another room.
  h.greeter.updateClients({
    visible: 1,
    typing: false,
    idleReturn: { sessionId: 'archived', awayMs: 30 * 60_000, firedAtMs: NOON + 30 * 60_000 },
  });
  const archivedRes = await h.greeter.settled();
  assert.equal(archivedRes.reason, 'no-room');
  assert.equal(h.wakes.length, 0);

  // Valid >=25m idleReturn targets the focused room ('older') even if 'recent' had a newer lastTurnAt.
  h.greeter.updateClients({
    visible: 1,
    typing: false,
    idleReturn: { sessionId: 'older', awayMs: 30 * 60_000, firedAtMs: NOON + 30 * 60_000 },
  });
  const wakeRes = await h.greeter.settled();
  assert.equal(wakeRes.outcome, 'text-only');
  assert.equal(h.wakes.length, 1);
  assert.equal(h.wakes[0].sessionId, 'older');
  assert.equal(h.wakes[0].personId, 'mika');
  assert.equal(h.wakes[0].awayMs, 30 * 60_000);
});

test('lastUserTurnId idempotency lock advances only on spoken/text-only/quiet and resets on a new user turn; silent outcomes never consume it', async () => {
  const room = {
    sessionId: 'chat',
    activeVirtualPersonId: 'lunara',
    memberIds: ['lunara'],
    lastTurnAt: NOON - HOUR,
    archivedAt: null,
    lastUserTurnId: 'u-1',
    returnGreetedTurnId: null,
  };
  let nextResult = { outcome: 'silent', reason: 'error' };
  const marked = [];
  let nowMs = NOON;
  const timers = [];
  const store = new Map([[APP_OPEN_STATE_KEY, JSON.stringify({ version: 1, lastVisibleAt: NOON - HOUR })]]);
  const wakes = [];
  let release;
  const greeter = createAppOpenGreeter({
    state: { getPref: k => store.get(k) ?? null, setPref: (k, v) => store.set(k, JSON.stringify(v)) },
    now: () => nowMs,
    listRooms: () => [room],
    markReturnGreeted: (sid, tid) => {
      marked.push([sid, tid]);
      room.returnGreetedTurnId = tid;
    },
    runTurn: async wake => {
      wakes.push(wake);
      if (nextResult === 'block') {
        return new Promise(resolve => { release = () => resolve({ outcome: 'silent', reason: 'interrupted' }); });
      }
      return nextResult;
    },
    setTimer: (fn, ms) => { const timer = { fn, at: nowMs + ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { if (timer) timer.cleared = true; },
    logger: { warn() {} },
  });

  // 1. Error / silent failure does NOT advance lock.
  greeter.updateClients({ visible: 1, typing: false });
  assert.equal((await greeter.settled()).outcome, 'silent');
  assert.deepEqual(marked, []);
  assert.equal(room.returnGreetedTurnId, null);

  // 2. Typing abort does NOT advance lock.
  greeter.updateClients({ visible: 0, typing: false });
  nowMs += HOUR;
  nextResult = 'block';
  greeter.updateClients({ visible: 1, typing: false });
  await new Promise(setImmediate);
  greeter.updateClients({ visible: 1, typing: true });
  release();
  assert.equal((await greeter.settled()).reason, 'interrupted');
  assert.deepEqual(marked, []);

  // 3. Successful quiet advances lock.
  greeter.updateClients({ visible: 0, typing: false });
  nowMs += HOUR;
  nextResult = { outcome: 'quiet', lines: 0 };
  greeter.updateClients({ visible: 1, typing: false });
  assert.equal((await greeter.settled()).outcome, 'quiet');
  assert.deepEqual(marked, [['chat', 'u-1']]);

  // 4. Same lastUserTurnId skips subsequent reopen with already-greeted.
  greeter.updateClients({ visible: 0, typing: false });
  nowMs += HOUR;
  const wakesBeforeSkip = wakes.length;
  greeter.updateClients({ visible: 1, typing: false });
  const skipped = await greeter.settled();
  assert.deepEqual(skipped, { outcome: 'skipped', reason: 'already-greeted' });
  assert.equal(wakes.length, wakesBeforeSkip);

  // 5. New lastUserTurnId unlocks and advances on spoken.
  room.lastUserTurnId = 'u-2';
  greeter.updateClients({ visible: 0, typing: false });
  nowMs += HOUR;
  nextResult = { outcome: 'spoken', lines: 1 };
  greeter.updateClients({ visible: 1, typing: false });
  assert.equal((await greeter.settled()).outcome, 'spoken');
  assert.deepEqual(marked, [['chat', 'u-1'], ['chat', 'u-2']]);
  greeter.stop();
});

test('short reopen (<25m) quiet does not consume markReturnGreeted lock; >=25m quiet and <25m spoken/text-only do; idleReturn validates lastTurnAt and empty rooms', async () => {
  const room = {
    sessionId: 'chat',
    activeVirtualPersonId: 'lunara',
    memberIds: ['lunara'],
    interactionMode: 'radio',
    lastTurnAt: NOON - 60 * 60_000,
    archivedAt: null,
    lastUserTurnId: 'u-10',
    returnGreetedTurnId: null,
  };
  let nowMs = NOON;
  const marked = [];
  let nextResult = { outcome: 'quiet', lines: 0 };
  const store = new Map([[APP_OPEN_STATE_KEY, JSON.stringify({ version: 1, lastVisibleAt: NOON - 10 * 60_000 })]]);
  const wakes = [];
  const greeter = createAppOpenGreeter({
    state: { getPref: k => store.get(k) ?? null, setPref: (k, v) => store.set(k, JSON.stringify(v)) },
    now: () => nowMs,
    listRooms: () => [room],
    markReturnGreeted: (sid, tid) => {
      marked.push([sid, tid]);
      room.returnGreetedTurnId = tid;
    },
    runTurn: async wake => {
      wakes.push(wake);
      return nextResult;
    },
    logger: { warn() {} },
  });

  // 1. Short reopen (10m < 25m) returning quiet must NOT consume returnGreetedTurnId.
  greeter.updateClients({ visible: 1, typing: false });
  assert.equal((await greeter.settled()).outcome, 'quiet');
  assert.deepEqual(marked, []);
  assert.equal(room.returnGreetedTurnId, null);

  // 2. Subsequent >=25m return (30m) wakes again on the same lastUserTurnId and quiet now locks it.
  greeter.updateClients({ visible: 0, typing: false });
  nowMs += 30 * 60_000;
  greeter.updateClients({ visible: 1, typing: false });
  assert.equal((await greeter.settled()).outcome, 'quiet');
  assert.deepEqual(marked, [['chat', 'u-10']]);

  // 3. New user turn: <25m reopen (10m) returning text-only or spoken DOES lock immediately.
  for (const [tid, outcome] of [['u-11', 'text-only'], ['u-12', 'spoken']]) {
    room.lastUserTurnId = tid;
    greeter.updateClients({ visible: 0, typing: false });
    nowMs += 10 * 60_000;
    nextResult = { outcome, lines: 1 };
    greeter.updateClients({ visible: 1, typing: false });
    assert.equal((await greeter.settled()).outcome, outcome);
    assert.equal(room.returnGreetedTurnId, tid);
  }

  // 4. idleReturn with stale client reporting >=25m while room.lastTurnAt was only 10m ago skips as recent-turn.
  room.lastUserTurnId = 'u-13';
  room.lastTurnAt = nowMs - 10 * 60_000;
  const wakesBeforeRecent = wakes.length;
  greeter.updateClients({
    visible: 1,
    typing: false,
    idleReturn: { sessionId: 'chat', awayMs: 30 * 60_000, firedAtMs: nowMs },
  });
  assert.deepEqual(await greeter.settled(), { outcome: 'skipped', reason: 'recent-turn' });
  assert.equal(wakes.length, wakesBeforeRecent);

  // 5. Empty room (lastUserTurnId === null) skips with no-user-turn on idleReturn and in roleplay app_open.
  room.lastUserTurnId = null;
  room.lastTurnAt = nowMs - 60 * 60_000;
  greeter.updateClients({
    visible: 1,
    typing: false,
    idleReturn: { sessionId: 'chat', awayMs: 30 * 60_000, firedAtMs: nowMs },
  });
  assert.deepEqual(await greeter.settled(), { outcome: 'skipped', reason: 'no-user-turn' });

  room.interactionMode = 'roleplay';
  greeter.updateClients({ visible: 0, typing: false });
  nowMs += 30 * 60_000;
  greeter.updateClients({ visible: 1, typing: false });
  assert.deepEqual(await greeter.settled(), { outcome: 'skipped', reason: 'no-user-turn' });
  assert.equal(wakes.length, wakesBeforeRecent);

  greeter.stop();
});
