// 客户端在场上报（add-app-open-greeting D1）：只发可见与是否在输入两个布尔值，变化才发，连上时补发一次。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createClientPresence } from './clientPresence.js';

function target() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)),
    fire: type => (listeners.get(type) || []).forEach(fn => fn()),
  };
}

function harness() {
  const doc = Object.assign(target(), { visibilityState: 'visible' });
  const input = Object.assign(target(), { value: '' });
  const sent = [];
  const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  let current = socket;
  const presence = createClientPresence({ getSocket: () => current, documentLike: doc, input });
  return { doc, input, sent, socket, presence, setSocket: value => { current = value; } };
}

test('reports on open, then only on change; the draft text itself is never sent', () => {
  const h = harness();
  h.presence.init();
  h.presence.connected();
  assert.deepEqual(h.sent, [{ type: 'client-presence', visible: true, typing: false }]);
  h.input.value = '我今天';
  h.input.fire('input');
  h.input.value = '我今天面试';
  h.input.fire('input');
  assert.deepEqual(h.sent.at(-1), { type: 'client-presence', visible: true, typing: true });
  assert.equal(h.sent.length, 2, '还在打字不重复发');
  h.input.value = '';
  h.input.fire('keyup'); // 回车发送后输入框被清空
  h.doc.visibilityState = 'hidden';
  h.doc.fire('visibilitychange');
  assert.deepEqual(h.sent.slice(2), [
    { type: 'client-presence', visible: true, typing: false },
    { type: 'client-presence', visible: false, typing: false },
  ]);
  assert.equal(JSON.stringify(h.sent).includes('面试'), false);
});

test('a closed socket drops the report; reconnecting re-sends the current state; destroy unsubscribes', () => {
  const h = harness();
  h.presence.init();
  h.setSocket({ readyState: 3, send: () => assert.fail('closed socket') });
  h.doc.visibilityState = 'hidden';
  h.doc.fire('visibilitychange');
  h.setSocket(h.socket);
  h.presence.connected();
  assert.deepEqual(h.sent, [{ type: 'client-presence', visible: false, typing: false }]);
  h.presence.destroy();
  assert.equal(h.doc.listeners.get('visibilitychange').length, 0);
  assert.equal(h.input.listeners.get('input').length, 0);
});

test('desktop idle-to-active room focus sends one-shot idleReturn after threshold and prevents duplicate triggers', () => {
  const doc = Object.assign(target(), { visibilityState: 'visible' });
  const input = Object.assign(target(), { value: '' });
  const sent = [];
  let nowMs = 1_000_000;
  let activeSid = 'room-a';
  const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  const presence = createClientPresence({
    getSocket: () => socket,
    documentLike: doc,
    input,
    getActiveSessionId: () => activeSid,
    now: () => nowMs,
  });
  presence.init();
  presence.connected();
  assert.deepEqual(sent, [{ type: 'client-presence', visible: true, typing: false, activeSessionId: 'room-a' }]);

  nowMs += 25 * 60_000;
  activeSid = 'room-b';
  assert.equal(presence.notifyRoomFocus('room-b'), true);
  assert.deepEqual(sent.at(-1), {
    type: 'client-presence',
    visible: true,
    typing: false,
    activeSessionId: 'room-b',
    idleReturn: { sessionId: 'room-b', awayMs: 25 * 60_000, firedAtMs: nowMs },
  });

  // Immediately focusing the same room again without a new idle gap does not re-emit idleReturn.
  nowMs += 5_000;
  assert.equal(presence.notifyRoomFocus('room-b'), false);
  assert.equal(sent.at(-1).idleReturn?.sessionId, 'room-b');

  // Switching back to room-a (untouched for 25m+5s) fires room-a's independent idleReturn once,
  // and immediately focusing room-a again does not re-emit.
  activeSid = 'room-a';
  assert.equal(presence.notifyRoomFocus('room-a'), true);
  assert.deepEqual(sent.at(-1), {
    type: 'client-presence',
    visible: true,
    typing: false,
    activeSessionId: 'room-a',
    idleReturn: { sessionId: 'room-a', awayMs: 25 * 60_000 + 5_000, firedAtMs: nowMs },
  });
  nowMs += 5_000;
  assert.equal(presence.notifyRoomFocus('room-a'), false);

  presence.destroy();
  assert.equal(doc.listeners.get('keydown').length, 0);
  assert.equal(doc.listeners.get('pointerdown').length, 0);
});

test('click gesture bridge preserves >=25m idle across pointerdown->click, while genuine prior activity resets it', () => {
  const doc = Object.assign(target(), { visibilityState: 'visible' });
  const input = Object.assign(target(), { value: '' });
  const sent = [];
  let nowMs = 10_000_000;
  const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  const presence = createClientPresence({
    getSocket: () => socket,
    documentLike: doc,
    input,
    getActiveSessionId: () => 'room-1',
    now: () => nowMs,
  });
  presence.init();
  presence.connected();

  // Real activity at +20m resets the idle timer so +26m is only 6m idle.
  nowMs += 20 * 60_000;
  doc.fire('keydown');
  nowMs += 6 * 60_000;
  assert.equal(presence.notifyRoomFocus('room-1'), false, 'same state and <25m since keydown');
  assert.equal(sent.length, 1);

  // Idle for 25m, then pointerdown right before click -> notifyRoomFocus still carries idleReturn.
  nowMs += 25 * 60_000;
  doc.fire('pointerdown');
  nowMs += 50;
  assert.equal(presence.notifyRoomFocus('room-1'), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].idleReturn.sessionId, 'room-1');
  assert.equal(sent[1].idleReturn.awayMs, 25 * 60_000 + 50);

  // Visibility transition hidden -> visible refreshes lastActiveAt so immediate notifyRoomFocus does not double-fire.
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  nowMs += 30 * 60_000;
  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  assert.equal(presence.notifyRoomFocus('room-1'), false);
  assert.equal(sent.at(-1).idleReturn, undefined);

  // Typing or hidden state suppresses idleReturn.
  nowMs += 30 * 60_000;
  input.value = '草稿';
  presence.notifyRoomFocus('room-1');
  assert.equal(sent.some(msg => msg.idleReturn && msg.idleReturn.firedAtMs === nowMs), false);
  input.value = '';
  doc.visibilityState = 'hidden';
  assert.equal(presence.notifyRoomFocus('room-1'), false);

  presence.destroy();
});

test('per-room lastRoomActiveAt: chatting in room-b does not erase room-a long idle gap', () => {
  const doc = Object.assign(target(), { visibilityState: 'visible' });
  const input = Object.assign(target(), { value: '' });
  const sent = [];
  let nowMs = 1_000_000;
  let activeSid = 'room-a';
  const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  const presence = createClientPresence({
    getSocket: () => socket,
    documentLike: doc,
    input,
    getActiveSessionId: () => activeSid,
    now: () => nowMs,
  });
  presence.init();
  presence.connected();

  // Switch to room-b at +5m and actively chat there through +24m.
  nowMs += 5 * 60_000;
  activeSid = 'room-b';
  presence.notifyRoomFocus('room-b');
  nowMs += 19 * 60_000;
  input.value = '在 room-b 聊天';
  input.fire('input');
  input.value = '';
  input.fire('keyup');

  // Switch back to room-a at +26m: room-a was untouched for 26m so it must emit idleReturn.
  nowMs += 2 * 60_000;
  activeSid = 'room-a';
  assert.equal(presence.notifyRoomFocus('room-a'), true);
  assert.deepEqual(sent.at(-1).idleReturn, {
    sessionId: 'room-a',
    awayMs: 26 * 60_000,
    firedAtMs: nowMs,
  });

  presence.destroy();
});

test('focused window idle >=25m settles on pointerdown/keydown after focusSettleMs, while typing cancels settle', () => {
  const doc = Object.assign(target(), { visibilityState: 'visible' });
  const win = target();
  const input = Object.assign(target(), { value: '' });
  const sent = [];
  const timers = [];
  let nowMs = 2_000_000;
  const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  const presence = createClientPresence({
    getSocket: () => socket,
    documentLike: doc,
    windowLike: win,
    input,
    getActiveSessionId: () => 'room-a',
    now: () => nowMs,
    focusSettleMs: 120,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { if (t) t.cleared = true; },
  });
  presence.init();
  presence.connected();
  assert.equal(sent.length, 1);

  // Stay visible & focused for 25m, then click in chat area (pointerdown without room switch).
  nowMs += 25 * 60_000;
  doc.fire('pointerdown');
  assert.equal(sent.length, 1, 'pointerdown itself waits for focusSettleMs');
  assert.equal(timers.at(-1).ms, 120);
  nowMs += 120;
  timers.at(-1).fn();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.at(-1).idleReturn, {
    sessionId: 'room-a',
    awayMs: 25 * 60_000 + 120,
    firedAtMs: nowMs,
  });

  // Idle another 25m, press a key to start typing -> input event cancels the settle timer without idleReturn.
  nowMs += 25 * 60_000;
  doc.fire('keydown');
  const pendingTimer = timers.at(-1);
  assert.equal(pendingTimer.cleared, false);
  input.value = '你好';
  input.fire('input');
  assert.equal(pendingTimer.cleared, true);
  assert.equal(sent.filter(msg => msg.idleReturn).length, 1);

  presence.destroy();
  assert.equal(win.listeners.get('focus').length, 0);
});

test('blurred window clicking sidebar room-b (window.focus -> pointerdown -> notifyRoomFocus room-b) wakes room-b only and never room-a', () => {
  const doc = Object.assign(target(), { visibilityState: 'visible' });
  const win = target();
  const input = Object.assign(target(), { value: '' });
  const sent = [];
  const timers = [];
  let nowMs = 3_000_000;
  let activeSid = 'room-a';
  const socket = { readyState: 1, send: raw => sent.push(JSON.parse(raw)) };
  const presence = createClientPresence({
    getSocket: () => socket,
    documentLike: doc,
    windowLike: win,
    input,
    getActiveSessionId: () => activeSid,
    now: () => nowMs,
    focusSettleMs: 120,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: t => { if (t) t.cleared = true; },
  });
  presence.init();
  presence.connected();

  // Leave window blurred (still visible) on room-a for 40m, then click sidebar room-b directly.
  nowMs += 40 * 60_000;
  win.fire('focus');
  const focusTimer = timers.at(-1);
  assert.equal(sent.filter(msg => msg.idleReturn).length, 0, 'window.focus must defer via settle timer');

  nowMs += 10;
  doc.fire('pointerdown');
  assert.equal(focusTimer.cleared, true);
  const pointerTimer = timers.at(-1);

  nowMs += 20;
  activeSid = 'room-b';
  assert.equal(presence.notifyRoomFocus('room-b'), true);
  assert.equal(pointerTimer.cleared, true, 'select(room-b) cancels pending room-a settle');

  const idleEvents = sent.filter(msg => msg.idleReturn);
  assert.equal(idleEvents.length, 1);
  assert.equal(idleEvents[0].activeSessionId, 'room-b');
  assert.equal(idleEvents[0].idleReturn.sessionId, 'room-b');
  assert.equal(idleEvents[0].idleReturn.awayMs, 40 * 60_000 + 30);

  // Confirm room-a was NOT clobbered or falsely woken up.
  nowMs += 100;
  activeSid = 'room-a';
  assert.equal(presence.notifyRoomFocus('room-a'), true);
  assert.equal(sent.at(-1).idleReturn.sessionId, 'room-a');

  presence.destroy();
  assert.equal(win.listeners.get('focus').length, 0);
});
