import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createChatInputView } from './chatInputView.js';

function fixture() {
  const { document, window } = parseHTML('<div id="compose"><textarea></textarea><button>发送</button></div>');
  const compose = document.querySelector('#compose');
  const input = document.querySelector('textarea');
  const button = document.querySelector('button');
  const sent = [];
  const view = createChatInputView({ compose, input, sendButton: button, onSubmit: text => sent.push(text) }).init();
  view.setMentionCandidates([{ id: 'lunara', name: 'Lunara', color: '#abc' }, { id: 'mio', name: '小满', color: '#def' }]);
  return { document, window, input, button, view, sent };
}

function type(input, window, value) {
  input.value = value;
  input.setSelectionRange?.(value.length, value.length);
  input.dispatchEvent(new window.Event('input'));
}

test('typing @ opens a filtered listbox and Enter inserts the exact name', () => {
  const h = fixture();
  type(h.input, h.window, '@Lu');
  const menu = h.document.querySelector('.compose-suggest');
  assert.equal(menu.hidden, false);
  assert.equal(menu.querySelectorAll('[role="option"]').length, 1);
  assert.match(menu.textContent, /Lunara/);
  const enter = new h.window.Event('keydown');
  Object.defineProperty(enter, 'key', { value: 'Enter' });
  h.input.dispatchEvent(enter);
  assert.equal(h.input.value, '@Lunara ');
  assert.equal(menu.hidden, true);
});

test('Escape closes the listbox, no-match hides it and composition does not trigger it', () => {
  const h = fixture();
  type(h.input, h.window, '@');
  const menu = h.document.querySelector('.compose-suggest');
  assert.equal(menu.hidden, false);
  const escape = new h.window.Event('keydown');
  Object.defineProperty(escape, 'key', { value: 'Escape' });
  h.input.dispatchEvent(escape);
  assert.equal(menu.hidden, true);
  type(h.input, h.window, '@nobody');
  assert.equal(menu.hidden, true);
  type(h.input, h.window, '@');
  h.input.dispatchEvent(new h.window.Event('compositionstart'));
  type(h.input, h.window, '@小');
  assert.equal(menu.hidden, true);
});

test('clicking a mention inserts at the caret and emits one input change', () => {
  const h = fixture();
  type(h.input, h.window, '晚安 @');
  let inputs = 0;
  h.input.addEventListener('input', () => { inputs += 1; });
  const option = h.document.querySelector('.compose-suggest [role="option"]');
  option.dispatchEvent(new h.window.Event('click'));
  assert.equal(h.input.value, '晚安 @Lunara ');
  assert.equal(inputs, 1);
});
