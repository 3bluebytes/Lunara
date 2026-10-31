import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REACTION_CONFIRM_COPY,
  createReactionConfirm,
  reactionConfirmCopy,
  reactionTrackLine,
} from './reactionConfirm.js';

function node(extra = {}) {
  const listeners = new Map();
  return {
    textContent: '',
    dataset: {},
    open: false,
    focused: false,
    listeners,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    focus() { this.focused = true; },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    ...extra,
  };
}

function fakeDom({ withDialog = true } = {}) {
  const ok = node();
  const cancel = node();
  const close = node();
  const title = node();
  const copy = node();
  const track = node();
  const dialog = node({
    showModal() { this.open = true; },
    close() { if (!this.open) return; this.open = false; this.emit('close'); },
    querySelector(selector) { return selector === '[data-close-dialog]' ? close : null; },
  });
  const bySelector = new Map([
    ['#reaction-confirm', withDialog ? dialog : null],
    ['#reaction-confirm-ok', ok],
    ['#reaction-confirm-cancel', cancel],
    ['#reaction-confirm-title', title],
    ['#reaction-confirm-copy', copy],
    ['#reaction-confirm-track', track],
  ]);
  return {
    documentLike: { querySelector: selector => bySelector.get(selector) ?? null },
    dialog, ok, cancel, close, title, copy, track,
  };
}

test('the copy names the cloud fact instead of guessing', () => {
  assert.equal(reactionConfirmCopy({ kind: 'unlike', adopted: true }).title, '云端歌单里已有这首');
  assert.equal(reactionConfirmCopy({ kind: 'unlike', adopted: false }).title, '取消云端收藏');
  assert.equal(reactionConfirmCopy({ kind: 'dislike' }).title, '不喜欢这首歌');
  assert.equal(REACTION_CONFIRM_COPY.dislike.confirmLabel, '移出并跳过');
});

test('the track line only repeats what the queue item actually says', () => {
  assert.equal(reactionTrackLine({ title: '晴天', artist: '周杰伦' }), '《晴天》 · 周杰伦');
  assert.equal(reactionTrackLine({ title: '晴天' }), '《晴天》');
  assert.equal(reactionTrackLine(null), '');
});

test('a confirmed unlike resolves true and closes the dialog', async () => {
  const f = fakeDom();
  const confirm = createReactionConfirm({ documentLike: f.documentLike }).init();
  const answer = confirm.confirm({ kind: 'unlike', adopted: true, track: { title: '晴天' } });
  assert.equal(f.dialog.open, true);
  assert.equal(f.title.textContent, '云端歌单里已有这首');
  assert.equal(f.track.textContent, '《晴天》');
  assert.equal(f.ok.focused, true, '焦点落在确认动作上，键盘用户可以直接拒绝或确认');
  f.ok.emit('click');
  assert.equal(await answer, true);
  assert.equal(f.dialog.open, false);
});

test('cancel, Esc and the close button all mean "keep it"', async () => {
  const f = fakeDom();
  const confirm = createReactionConfirm({ documentLike: f.documentLike }).init();

  const cancelled = confirm.confirm({ kind: 'dislike' });
  f.cancel.emit('click');
  assert.equal(await cancelled, false);

  const escaped = confirm.confirm({ kind: 'dislike' });
  let prevented = false;
  f.dialog.emit('cancel', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'Esc 由弹层自己收尾，不让浏览器直接关掉而丢掉答案');
  assert.equal(await escaped, false);

  const closed = confirm.confirm({ kind: 'dislike' });
  f.close.emit('click');
  assert.equal(await closed, false);
});

test('without the dialog element nothing is silently confirmed', async () => {
  const f = fakeDom({ withDialog: false });
  const confirm = createReactionConfirm({ documentLike: f.documentLike }).init();
  assert.equal(await confirm.confirm({ kind: 'unlike', adopted: true }), false);
});

test('opening a second prompt settles the first one instead of leaving it hanging', async () => {
  const f = fakeDom();
  const confirm = createReactionConfirm({ documentLike: f.documentLike }).init();
  const first = confirm.confirm({ kind: 'unlike', adopted: true });
  const second = confirm.confirm({ kind: 'dislike' });
  assert.equal(await first, false);
  assert.equal(f.title.textContent, '不喜欢这首歌');
  f.cancel.emit('click');
  assert.equal(await second, false);
});
