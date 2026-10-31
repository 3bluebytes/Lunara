import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createChatInputView } from './chatInputView.js';

test('pending replies keep the editor enabled while room and media locks remain independent', () => {
  const { document, window } = parseHTML('<div id="compose"><textarea></textarea><button>发送</button></div><div id="hint"><span></span></div>');
  const compose = document.querySelector('#compose'), input = document.querySelector('textarea'), button = document.querySelector('button');
  const sent = []; let cancelled = 0;
  const view = createChatInputView({ compose, input, sendButton: button, hint: document.querySelector('#hint'),
    hintText: document.querySelector('#hint span'), onSubmit: text => sent.push(text), onCancel: () => { cancelled += 1; } }).init();
  view.setPending(true, 'Lunara 正在输入…');
  assert.equal(input.disabled, false);
  assert.equal(button.getAttribute('aria-label'), '停止回复');
  button.dispatchEvent(new window.Event('click'));
  assert.equal(cancelled, 1);
  assert.deepEqual(sent, []);
  input.value = '插话'; const enter = new window.Event('keydown'); Object.defineProperty(enter, 'key', { value: 'Enter' });
  input.dispatchEvent(enter);
  assert.deepEqual(sent, ['插话']);
  view.setLocked(true, '媒体交付中');
  view.setLocked(false, '', { source: 'room' });
  assert.equal(view.isLocked(), true);
  view.setLocked(false);
  assert.equal(view.isLocked(), false);
  view.destroy();
});
