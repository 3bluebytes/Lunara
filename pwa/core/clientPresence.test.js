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
