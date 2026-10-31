import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatController } from './chatController.js';

function fakeElement() {
  const listeners = {};
  const buttons = [];
  const classes = new Set();
  const element = {
    className: '', dataset: {}, listeners, buttons,
    classList: { toggle: name => (classes.has(name) ? classes.delete(name) : classes.add(name), classes.has(name)), contains: name => classes.has(name) },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelectorAll: () => [],
    querySelector: selector => selector === '.chat-msg-actions' && /chat-msg-actions/.test(element.innerHTML)
      ? { querySelectorAll: () => buttons } : null,
  };
  let html = '';
  Object.defineProperty(element, 'innerHTML', { get: () => html, set: value => {
    html = value;
    buttons.length = 0;
    for (const [, action] of value.matchAll(/data-msg-action="(\w+)"/g)) {
      const button = { dataset: { msgAction: action }, addEventListener: (type, fn) => { button.click = fn; } };
      buttons.push(button);
    }
  } });
  return element;
}

function fixture(options = {}) {
  const children = [];
  const chatList = { appendChild: node => children.push(node), querySelector: () => null, querySelectorAll: () => [], innerHTML: '' };
  const calls = [];
  const controller = createChatController({ chatList, documentLike: { createElement: fakeElement }, requestFrame: null,
    onEditMessage: turnId => calls.push(['edit', turnId]), onForkMessage: turnId => calls.push(['fork', turnId]),
    onQuoteMessage: quoteText => calls.push(['quote', quoteText]), ...options });
  return { controller, children, calls };
}

test('committed messages get a quote action; user messages also get edit and fork; optimistic ones get none', () => {
  const h = fixture();
  h.controller.replaceTranscript([
    { turnId: 'turn_u1', role: 'user', text: '第1句', sequence: 1 },
    { turnId: 'turn_a1', role: 'assistant', text: '回应1', sequence: 2 },
    { turnId: 'chat:pending', role: 'user', text: '还在路上', sequence: 3 },
  ]);
  const [user, assistant, optimistic] = h.children.filter(child => /chat-msg/.test(child.className));
  assert.deepEqual(user.buttons.map(button => button.dataset.msgAction), ['quote', 'edit', 'fork']);
  // 伙伴的消息只能引用，不能被改写或分叉。
  assert.deepEqual(assistant.buttons.map(button => button.dataset.msgAction), ['quote']);
  assert.doesNotMatch(optimistic.innerHTML, /chat-msg-actions/);

  user.buttons[0].click({ stopPropagation() {} });
  user.buttons[1].click({ stopPropagation() {} });
  user.buttons[2].click({ stopPropagation() {} });
  assistant.buttons[0].click({ stopPropagation() {} });
  // 引用只带那条消息的摘要；说话人来自账本里的 speaker，不从文本猜。
  assert.deepEqual(h.calls, [
    ['quote', '引用 我：第1句'],
    ['edit', 'turn_u1'],
    ['fork', 'turn_u1'],
    ['quote', '引用 Lunara：回应1'],
  ]);

  // 触屏轻触气泡切换显示。
  user.listeners.click();
  assert.equal(user.classList.contains('actions-open'), true);
});

test('without callbacks no message actions are rendered', () => {
  const h = fixture({ onEditMessage: null, onForkMessage: null, onQuoteMessage: null });
  h.controller.replaceTranscript([
    { turnId: 'turn_u1', role: 'user', text: '第1句', sequence: 1 },
    { turnId: 'turn_a1', role: 'assistant', text: '回应1', sequence: 2 },
  ]);
  assert.doesNotMatch(h.children[0].innerHTML, /chat-msg-actions/);
  assert.doesNotMatch(h.children[1].innerHTML, /chat-msg-actions/);
});

test('a message with nothing to quote gets no quote button', () => {
  const h = fixture();
  h.controller.replaceTranscript([{ turnId: 'turn_a1', role: 'assistant', text: '   ', sequence: 1 }]);
  assert.doesNotMatch(h.children[0].innerHTML, /data-msg-action="quote"/);
});

test('splitting: the quote callback does not touch edit or fork', () => {
  const h = fixture({ onEditMessage: null, onForkMessage: null });
  h.controller.replaceTranscript([{ turnId: 'turn_a1', role: 'assistant', text: '回应1', sequence: 1 }]);
  assert.deepEqual(h.children[0].buttons.map(button => button.dataset.msgAction), ['quote']);
});
