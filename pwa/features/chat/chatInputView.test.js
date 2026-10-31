import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatInputView } from './chatInputView.js';

function element() {
  const listeners = new Map();
  const classes = new Set();
  return {
    value: '',
    disabled: false,
    textContent: '',
    classList: {
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains: name => classes.has(name),
    },
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event = {}) {
      const payload = { currentTarget: this, target: this, preventDefault() {}, ...event };
      for (const listener of listeners.get(type) || []) listener(payload);
    },
    count: type => listeners.get(type)?.size || 0,
    focus() {},
  };
}

test('send button and Enter submit once while Shift+Enter and IME do not', () => {
  const input = element();
  const button = element();
  const submissions = [];
  const view = createChatInputView({
    compose: element(),
    input,
    sendButton: button,
    hint: element(),
    hintText: element(),
    onSubmit: value => submissions.push(value),
  });
  view.init();

  input.value = 'first';
  button.emit('click');
  input.value = 'line';
  input.emit('keydown', { key: 'Enter', shiftKey: true });
  input.emit('compositionstart');
  input.emit('keydown', { key: 'Enter', shiftKey: false });
  input.emit('compositionend');
  input.emit('keydown', { key: 'Enter', shiftKey: false });

  assert.deepEqual(submissions, ['first', 'line']);
});

test('lock state owns compose affordances and blocks keyboard submission', () => {
  const compose = element();
  const input = element();
  const button = element();
  const hint = element();
  const hintText = element();
  let submissions = 0;
  const view = createChatInputView({
    compose,
    input,
    sendButton: button,
    hint,
    hintText,
    onSubmit: () => { submissions += 1; },
  }).init();

  view.setLocked(true, '思考中');
  input.value = 'blocked';
  input.emit('keydown', { key: 'Enter' });
  assert.equal(submissions, 0);
  assert.equal(input.disabled, true);
  assert.equal(button.disabled, true);
  assert.equal(compose.classList.contains('locked'), true);
  assert.equal(hintText.textContent, '思考中');
  view.setLocked(false);
  assert.equal(view.isLocked(), false);
});

test('composer grows with a wrapped draft and collapses after sending', () => {
  const input = element();
  const button = element();
  const submissions = [];
  // 真实 textarea 会随内容/宽度给出新的 scrollHeight；替身用 value 模拟单行 ↔ 折行。
  input.style = {};
  Object.defineProperty(input, 'scrollHeight', { get: () => (input.value ? 72 : 34) });
  const view = createChatInputView({ input, sendButton: button, onSubmit: value => submissions.push(value) }).init();

  view.syncSize();
  assert.equal(input.style.height, '34px');

  input.value = '一段会折行的长草稿，第二行也不该被截掉';
  input.emit('input');
  assert.equal(input.style.height, '72px');

  button.emit('click');
  assert.deepEqual(submissions, ['一段会折行的长草稿，第二行也不该被截掉']);
  assert.equal(input.value, '');
  assert.equal(input.style.height, '34px');
});

test('init is idempotent and destroy releases owned listeners', () => {
  const input = element();
  const button = element();
  const view = createChatInputView({ input, sendButton: button, onSubmit() {} });
  view.init();
  view.init();
  assert.equal(input.count('keydown'), 1);
  assert.equal(button.count('click'), 1);
  view.destroy();
  assert.equal(input.count('keydown'), 0);
  assert.equal(button.count('click'), 0);
});

test('quoting a message writes the quote block above the draft and leaves the caret at the end', () => {
  const input = element();
  const button = element();
  const events = [];
  const caret = [];
  input.dispatchEvent = event => events.push(event.type);
  input.setSelectionRange = (start, end) => caret.push([start, end]);
  input.value = '我这两天有点累';
  const view = createChatInputView({ input, sendButton: button, onSubmit() {} });
  assert.equal(view.insertQuote('引用 Lunara：三小时过去了'), true);
  assert.equal(input.value, '> 引用 Lunara：三小时过去了\n\n我这两天有点累');
  assert.deepEqual(caret, [[input.value.length, input.value.length]]);
  // 外层（草稿保存）靠 input 事件得知内容变了。
  assert.deepEqual(events, ['input']);
  // 再引用另一条：替换旧引用块，正文不动。
  view.insertQuote('引用 我：刚才那句');
  assert.equal(input.value, '> 引用 我：刚才那句\n\n我这两天有点累');
  // 没有摘要就什么都不写。
  assert.equal(view.insertQuote(''), false);
  assert.equal(input.value, '> 引用 我：刚才那句\n\n我这两天有点累');
  // 媒体交付锁定时不写入。
  view.setLocked(true);
  assert.equal(view.insertQuote('引用 我：又来一句'), false);
  assert.equal(input.value, '> 引用 我：刚才那句\n\n我这两天有点累');
});
