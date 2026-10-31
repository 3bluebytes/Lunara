import assert from 'node:assert/strict';
import test from 'node:test';
import { installTransportShortcuts, resolveTransportShortcut } from './transportShortcuts.js';

/**
 * 极简元素替身：只实现本模块用到的选择器形状（tag / [href] / [role="x"] / [contenteditable="x"]），
 * 但保留 closest 的祖先语义——真实焦点可能在可编辑容器或按钮内部。
 */
function element(tag = 'div', attributes = {}, parent = null) {
  const self = {
    tagName: String(tag).toUpperCase(),
    parent,
    attributes,
    isContentEditable: attributes.contenteditable !== undefined && attributes.contenteditable !== 'false',
    matches(selector) {
      return selector.split(',').map(part => part.trim()).some(part => {
        const tagPart = part.match(/^[a-z]+/i)?.[0];
        if (tagPart && self.tagName !== tagPart.toUpperCase()) return false;
        if (/\[href\]/.test(part) && !attributes.href) return false;
        const role = part.match(/\[role="([^"]+)"\]/)?.[1];
        if (role && attributes.role !== role) return false;
        const editable = part.match(/\[contenteditable(?:="([^"]*)")?\]/);
        if (editable) {
          if (attributes.contenteditable === undefined) return false;
          if (editable[1] !== undefined && attributes.contenteditable !== editable[1]) return false;
        }
        return true;
      });
    },
    closest(selector) {
      let node = self;
      while (node) {
        if (node.matches(selector)) return node;
        node = node.parent;
      }
      return null;
    },
  };
  return self;
}

const BODY = element('div');

function keyEvent(key, extra = {}) {
  return { key, target: BODY, ...extra };
}

test('space toggles playback when the focus owns no space semantics', () => {
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space' })), 'toggle');
  assert.equal(resolveTransportShortcut(keyEvent('Spacebar')), 'toggle');
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', target: element('span') })), 'toggle');
});

test('the player invents no extra shortcuts', () => {
  // 用户要的是「识别系统媒体键」，不是应用内发明键位：方向键、Shift+方向键、媒体键
  // 都不在这里绑定（媒体键由系统媒体会话/快捷键通道负责）。
  assert.equal(resolveTransportShortcut(keyEvent('ArrowRight')), null);
  assert.equal(resolveTransportShortcut(keyEvent('ArrowRight', { shiftKey: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent('ArrowLeft', { shiftKey: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', shiftKey: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent('MediaPlayPause')), null);
  assert.equal(resolveTransportShortcut(keyEvent('MediaTrackNext')), null);
  assert.equal(resolveTransportShortcut(keyEvent('MediaTrackPrevious')), null);
});

test('text entry keeps space and shift + arrows for editing', () => {
  const editable = element('div', { contenteditable: 'true' });
  for (const target of [
    element('input'),
    element('textarea'),
    element('select'),
    element('div', { role: 'textbox' }),
    editable,
    element('b', {}, editable), // 可编辑容器里的子元素：closest 负责找到容器
  ]) {
    assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', target })), null, 'space must not toggle while typing');
    assert.equal(resolveTransportShortcut(keyEvent('ArrowRight', { shiftKey: true, target })), null, 'shift+arrow must stay with the selection');
  }
});

test('a focused control never steals the space key', () => {
  // 鼠标点过的元素会保留焦点。如果这些元素拥有空格，空格就退化成「再点一次它」：
  // 点过歌卡后按空格又点一次歌卡、点过推拉门把手后按空格把会话收起。播放器接管
  // 空格并 preventDefault，按钮的激活键仍是 Enter。
  for (const target of [
    element('button'),
    element('a', { href: '/x' }),
    element('summary'),
    element('div', { role: 'button' }),
    element('div', { role: 'switch' }),
    element('span', {}, element('button')), // 按钮内部的元素同样不等于「按钮拥有空格」
    element('button', { 'data-queue-item': 'queue:1' }), // 聊天气泡里的歌曲卡
  ]) {
    assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', target })), 'toggle');
  }
});

test('composition, repeats, system modifiers and unrelated keys are ignored', () => {
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', isComposing: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', keyCode: 229 })), null);
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', repeat: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', repeat: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', ctrlKey: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', metaKey: true })), null);
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', altKey: true })), null);
  assert.equal(resolveTransportShortcut(null), null);
});

test('an already handled key is never claimed twice', () => {
  assert.equal(resolveTransportShortcut(keyEvent(' ', { code: 'Space', defaultPrevented: true })), null);
});

function fakeDocument(activeElement = null) {
  const listeners = new Map();
  const key = (type, capture) => `${type}:${capture ? 'capture' : 'bubble'}`;
  return {
    activeElement,
    addEventListener(type, listener, capture = false) { listeners.set(key(type, capture), listener); },
    removeEventListener(type, listener, capture = false) { if (listeners.get(key(type, capture)) === listener) listeners.delete(key(type, capture)); },
    dispatch(event) {
      event.defaultPrevented = false;
      event.preventDefault = () => { event.defaultPrevented = true; };
      listeners.get(key('keydown', false))?.(event);
    },
    pointerdown(target) { listeners.get(key('pointerdown', true))?.({ type: 'pointerdown', target }); },
    listenerCount: () => listeners.size,
  };
}

/** 焦点替身：记录自己被 blur 过，并能回答「是不是某个后代」。 */
function focusable(tag = 'div', { children = [] } = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    blurred: 0,
    isContentEditable: false,
    blur() { node.blurred += 1; },
    contains(other) { return children.includes(other); },
    closest(selector) { return selector.split(', ').some(part => part === tag) ? node : null; },
  };
  return node;
}

test('installing consumes exactly the keys it handles', () => {
  const documentLike = fakeDocument();
  const seen = [];
  const cleanup = installTransportShortcuts({
    documentLike,
    handlers: { toggle: () => seen.push('toggle') },
  });
  const space = keyEvent(' ', { code: 'Space' });
  documentLike.dispatch(space);
  assert.deepEqual(seen, ['toggle']);
  assert.equal(space.defaultPrevented, true, '空格必须拦下页面滚动与焦点按钮的二次激活');
  const onButton = keyEvent(' ', { code: 'Space', target: element('button') });
  documentLike.dispatch(onButton);
  assert.deepEqual(seen, ['toggle', 'toggle'], '焦点在按钮上也要暂停，并吃掉这次空格');
  assert.equal(onButton.defaultPrevented, true);
  const typing = keyEvent(' ', { code: 'Space', target: element('textarea') });
  documentLike.dispatch(typing);
  assert.deepEqual(seen, ['toggle', 'toggle']);
  assert.equal(typing.defaultPrevented, false, '输入框里的空格属于输入框');
  const arrows = keyEvent('ArrowRight', { shiftKey: true });
  documentLike.dispatch(arrows);
  assert.deepEqual(seen, ['toggle', 'toggle'], '没有绑定方向键');
  assert.equal(arrows.defaultPrevented, false);
  cleanup();
  documentLike.dispatch(keyEvent(' ', { code: 'Space' }));
  assert.deepEqual(seen, ['toggle', 'toggle'], '清理后不再响应');
  assert.equal(documentLike.listenerCount(), 0);
});

test('a disabled install leaves every key to the page', () => {
  const documentLike = fakeDocument();
  const seen = [];
  let presented = false;
  installTransportShortcuts({ documentLike, isEnabled: () => presented, handlers: { toggle: () => seen.push('toggle') } });
  const space = keyEvent(' ', { code: 'Space' });
  documentLike.dispatch(space);
  assert.deepEqual(seen, [], '播放条没呈现时空格属于页面滚动');
  assert.equal(space.defaultPrevented, false);
  presented = true;
  documentLike.dispatch(keyEvent(' ', { code: 'Space' }));
  assert.deepEqual(seen, ['toggle'], '播放条重新呈现后快捷键恢复');
});

test('a missing document is harmless', () => {
  assert.doesNotThrow(() => installTransportShortcuts({ documentLike: {} })());
});

test('space does not leave a keyboard focus ring on the element the mouse clicked', () => {
  // 真实症状：点一下听歌区/歌卡（焦点留在那个元素上），再按空格——浏览器把输入模态
  // 切回键盘，:focus-visible 就把那个框画出来了。空格属于播放器，不能留下这种痕迹。
  const hero = focusable('div');
  const documentLike = fakeDocument(hero);
  const seen = [];
  installTransportShortcuts({ documentLike, handlers: { toggle: () => seen.push('toggle') } });

  documentLike.pointerdown(hero);
  documentLike.dispatch(keyEvent(' ', { code: 'Space', target: hero }));
  assert.deepEqual(seen, ['toggle'], '空格照常暂停');
  assert.equal(hero.blurred, 1, '点过的容器在空格被消费时摘掉焦点，于是不会画出焦点框');
});

test('the ring stays for keyboard users and inside text fields', () => {
  const button = focusable('button');
  const documentLike = fakeDocument(button);
  installTransportShortcuts({ documentLike, handlers: { toggle: () => {} } });

  // 键盘 Tab 过来的焦点：没有 pointerdown 记录，不能被摘掉。
  documentLike.dispatch(keyEvent(' ', { code: 'Space', target: button }));
  assert.equal(button.blurred, 0, '键盘焦点环必须保留');

  // 文本输入里的空格根本不被消费，焦点更不能被摘掉。
  const field = { isContentEditable: false, blurred: 0, blur() { field.blurred += 1; },
    contains: () => false, closest: selector => (selector.includes('textarea') ? field : null) };
  const doc = fakeDocument(field);
  installTransportShortcuts({ documentLike: doc, handlers: { toggle: () => {} } });
  doc.pointerdown(field);
  doc.dispatch(keyEvent(' ', { code: 'Space', target: field }));
  assert.equal(field.blurred, 0);
});

test('clicking a child of a focusable container still clears the right element', () => {
  const image = focusable('img');
  const hero = focusable('div', { children: [image] });
  const documentLike = fakeDocument(hero);
  installTransportShortcuts({ documentLike, handlers: { toggle: () => {} } });
  documentLike.pointerdown(image); // 浏览器把焦点给可聚焦的祖先
  documentLike.dispatch(keyEvent(' ', { code: 'Space', target: hero }));
  assert.equal(hero.blurred, 1);
  assert.equal(image.blurred, 0);
});
