import assert from 'node:assert/strict';
import test from 'node:test';
import { createListeningShellController, formatListeningMoment } from './listeningShellController.js';

test('listening moment uses a compact Chinese date and stable minute clock', () => {
  assert.deepEqual(formatListeningMoment(new Date(2026, 8, 14, 9, 7)), {
    time: '09:07',
    date: '9月14日 星期一 · 把这一刻留给音乐',
  });
});

function fixture(narrow = true) {
  const nodes = new Map();
  let activeElement = null;
  const makeElement = () => {
    const classes = new Set();
    const attributes = new Map();
    const listeners = new Map();
    return {
      hidden: false,
      isConnected: true,
      style: {},
      parentElement: null,
      appendChild(child) { child.parentElement = this; activeElement = null; return child; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      classList: {
        toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      addEventListener(type, fn) { listeners.set(type, fn); },
      removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
      setAttribute(name, value) { attributes.set(name, value); },
      getAttribute(name) { return attributes.get(name); },
      focus() { activeElement = this; },
      click() { listeners.get('click')?.({ preventDefault() {}, stopPropagation() {} }); },
      keydown(event) { listeners.get('keydown')?.(event); },
      classes,
      attributes,
    };
  };
  const app = makeElement();
  for (const selector of ['#mobile-pane-switch', '#mobile-pane-listen', '#mobile-pane-chat',
    '#focus-mode-enter', '#focus-mode-actions', '#focus-mode-chat', '#listening-weather',
    '#chat-focus-toggle', '#chat-focus-exit', '.conversation-main', '.listening-panel', '#chat-door', '#listening-door',
    '#compose-input', '#chat-focus-label', '#player-mixer-details', '#mixer-summary', '#episode-mixer']) {
    nodes.set(selector, makeElement());
  }
  const documentLike = {
    get activeElement() { return activeElement; },
    querySelector: selector => nodes.get(selector) || null,
    addEventListener: makeElement().addEventListener,
  };
  const documentListeners = new Map();
  documentLike.addEventListener = (type, fn) => documentListeners.set(type, fn);
  documentLike.removeEventListener = (type, fn) => { if (documentListeners.get(type) === fn) documentListeners.delete(type); };
  documentLike.dispatchKey = event => documentListeners.get('keydown')?.(event);
  documentLike.dispatchPointer = event => documentListeners.get('pointerdown')?.(event);
  const mediaListeners = new Map();
  const media = { matches: narrow, addEventListener(type, fn) { mediaListeners.set(type, fn); }, removeEventListener(type) { mediaListeners.delete(type); }, change(matches) { this.matches = matches; mediaListeners.get('change')?.(); } };
  const windowLike = { matchMedia: () => media };
  return { app, nodes, documentLike, windowLike, makeElement };
}

test('mobile pane switching and focus mode only change presentation state', () => {
  const h = fixture(true);
  const chatInput = h.nodes.get('#mobile-pane-chat');
  const checkpoints = [];
  const shell = createListeningShellController({
    appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike,
    beforePresentationChange: () => checkpoints.push('saved'),
  }).init();

  assert.equal(h.nodes.get('#mobile-pane-switch').hidden, false);
  assert.equal(h.app.classes.has('mobile-listen-pane'), true);
  chatInput.click();
  assert.equal(h.app.classes.has('mobile-chat-pane'), true);
  assert.equal(h.nodes.get('#mobile-pane-chat').getAttribute('aria-pressed'), 'true');

  h.nodes.get('#focus-mode-enter').click();
  assert.equal(h.app.classes.has('focus-mode'), true);
  assert.equal(h.nodes.get('#focus-mode-enter').hidden, true);
  assert.equal(h.nodes.get('#focus-mode-actions').hidden, false);
  assert.equal(shell.getSnapshot().mobilePane, 'listen');

  let prevented = false;
  h.documentLike.dispatchKey({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(h.app.classes.has('focus-mode'), false);
  assert.equal(h.app.classes.has('mobile-chat-pane'), true);
  assert.ok(checkpoints.length >= 3);
  shell.destroy();
});

test('desktop hides pane controls and focus return can explicitly open chat', () => {
  const h = fixture(false);
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  const compose = { isConnected: true, focused: false, focus() { this.focused = true; } };
  // Simulate an existing conversation input as the return target.
  Object.defineProperty(h.documentLike, 'activeElement', { configurable: true, value: compose });
  h.nodes.get('#focus-mode-enter').click();
  h.nodes.get('#focus-mode-chat').click();
  assert.equal(h.nodes.get('#mobile-pane-switch').hidden, true);
  assert.equal(h.app.classes.has('focus-mode'), false);
  assert.equal(h.app.classes.has('mobile-chat-pane'), true);
  assert.equal(compose.focused, true);
  shell.destroy();
});

test('chat focus collapses the listening column as pure presentation and restores focus to the handle', () => {
  const h = fixture(false);
  const checkpoints = [];
  const shell = createListeningShellController({
    appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike,
    beforePresentationChange: () => checkpoints.push('saved'),
  }).init();
  const toggle = h.nodes.get('#chat-focus-toggle');

  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(shell.setChatFocus(true), true);
  assert.equal(h.app.classes.has('chat-focus'), true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), '展开听歌列');
  assert.equal(checkpoints.length, 1, 'presentation saved before switching');
  // 专注聆听未被波及：切换聚焦态不改 focus-mode / mobile pane 状态。
  assert.equal(h.app.classes.has('focus-mode'), false);
  assert.equal(shell.getSnapshot().focusMode, false);

  // 封面条按钮退出：焦点回把手，aria 状态同步。
  h.nodes.get('#chat-focus-exit').click();
  assert.equal(h.app.classes.has('chat-focus'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(toggle.getAttribute('aria-label'), '收起听歌列，进入聊天聚焦');
  assert.equal(h.documentLike.activeElement, toggle);
  shell.destroy();
});

test('chat focus is refused on narrow viewports and while focus listening is active', () => {
  const h = fixture(true);
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  const toggle = h.nodes.get('#chat-focus-toggle');

  assert.equal(shell.setChatFocus(true), false);
  assert.equal(h.app.classes.has('chat-focus'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');

  // 专注聆听优先：进入后拒绝再开聚焦态。
  h.nodes.get('#focus-mode-enter').click();
  assert.equal(shell.setChatFocus(true), false);
  assert.equal(h.app.classes.has('chat-focus'), false);
  shell.destroy();
});

test('entering focus listening clears chat focus and it does not survive the exit', () => {
  const h = fixture(false);
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  const toggle = h.nodes.get('#chat-focus-toggle');

  assert.equal(shell.setChatFocus(true), true);
  h.nodes.get('#focus-mode-enter').click();
  assert.equal(h.app.classes.has('chat-focus'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');

  h.nodes.get('#focus-mode-chat').click();
  assert.equal(h.app.classes.has('focus-mode'), false);
  assert.equal(h.app.classes.has('chat-focus'), false, 'chat focus must not come back after focus mode exits');
  shell.destroy();
});

test('narrowing the viewport deactivates chat focus without residue', () => {
  const h = fixture(false);
  let narrowMatches = false;
  const listeners = new Map();
  const media = {
    get matches() { return narrowMatches; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {},
  };
  h.windowLike.matchMedia = () => media;
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  const toggle = h.nodes.get('#chat-focus-toggle');

  assert.equal(shell.setChatFocus(true), true);
  assert.equal(h.app.classes.has('chat-focus'), true);

  narrowMatches = true;
  listeners.get('change')?.();
  assert.equal(h.app.classes.has('chat-focus'), false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  shell.destroy();
});

test('one handle belongs to the right door normally and the left door in expanded chat, preserving keyboard focus', () => {
  const h = fixture(false);
  const toggle = h.nodes.get('#chat-focus-toggle');
  const chat = h.nodes.get('#chat-door');
  const listen = h.nodes.get('#listening-door');
  // No geometry may be read for the handle: CSS owns all local positioning.
  for (const node of [h.app, h.nodes.get('.conversation-main'), h.nodes.get('.listening-panel')]) {
    node.getBoundingClientRect = () => { throw new Error('no app-level seam measurement'); };
  }
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  assert.equal(toggle.parentElement, chat);
  toggle.focus();
  toggle.click();
  assert.equal(toggle.parentElement, listen);
  assert.equal(h.documentLike.activeElement, toggle, 'moving a focused button restores focus');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  toggle.click();
  assert.equal(toggle.parentElement, chat);
  assert.equal(h.documentLike.activeElement, toggle);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(toggle.style, {}, 'no stale global pixel coordinates');
  shell.render();
  assert.equal(h.documentLike.activeElement, toggle, 'no unnecessary reparent on render');
  shell.enterFocusMode();
  shell.exitFocusMode();
  assert.equal(toggle.parentElement, chat);
  shell.destroy();
});

test('environment event renders the weather badge beside the clock', () => {
  const h = fixture(false);
  const shell = createListeningShellController({
    appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike,
  }).init();
  const badge = h.nodes.get('#listening-weather');

  shell.syncEnvironment({ available: true, cityName: '上海', summaryZh: '雨', tempC: 23.6 });
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '上海 · 雨 · 24°');

  // 温度缺失时只显示城市与摘要，不出现 NaN
  shell.syncEnvironment({ available: true, cityName: '杭州', summaryZh: '晴', tempC: null });
  assert.equal(badge.textContent, '杭州 · 晴');
});

test('unavailable environment hides the badge without stale residue', () => {
  const h = fixture(false);
  const shell = createListeningShellController({
    appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike,
  }).init();
  const badge = h.nodes.get('#listening-weather');

  shell.syncEnvironment({ available: true, cityName: '上海', summaryZh: '雨', tempC: 24 });
  assert.equal(badge.hidden, false);

  shell.syncEnvironment({ available: false, cityName: null, summaryZh: null, tempC: null });
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, '');

  shell.syncEnvironment(null);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, '');
});

test('player reserve follows the real player height and cleans up on destroy', () => {
  const h = fixture(false);
  // 播放栏高度随推荐语/恢复提示变化：面板底部预留必须跟随真实高度，
  // 否则队列最后一首会被播放栏压住拖不出来。
  let playerHeight = 174;
  const player = h.makeElement();
  player.getBoundingClientRect = () => ({ height: playerHeight, top: 0, bottom: playerHeight, left: 0, right: 0, width: 100, x: 0, y: 0 });
  h.nodes.set('.persistent-player', player);
  const properties = new Map();
  h.app.style = {
    setProperty(name, value) { properties.set(name, value); },
    removeProperty(name) { properties.delete(name); },
  };
  let observerCallback = null;
  let disconnected = false;
  h.windowLike.ResizeObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() { disconnected = true; }
  };

  const shell = createListeningShellController({
    appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike,
  }).init();
  assert.equal(properties.get('--player-actual-height'), '174px');
  assert.equal(typeof observerCallback, 'function');

  // 播放栏长高（如恢复提示出现）→ 预留高度跟着更新
  playerHeight = 209;
  observerCallback([], h.windowLike);
  assert.equal(properties.get('--player-actual-height'), '209px');

  shell.destroy();
  assert.equal(disconnected, true);
  assert.equal(properties.has('--player-actual-height'), false);
});

test('player reserve is skipped when the player or style API is missing', () => {
  const h = fixture(false);
  h.windowLike.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const shell = createListeningShellController({
    appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike,
  }).init();
  // fixture 的 app 没有 style，也没有 .persistent-player：不抛错即可。
  shell.destroy();
  assert.equal(h.app.classes.has('focus-mode'), false);
});

test('聊天聚焦态：输入框为空时 Esc 收起并把焦点还给把手；有草稿时不收起', () => {
  const h = fixture(false);
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  const toggle = h.nodes.get('#chat-focus-toggle');
  const label = h.nodes.get('#chat-focus-label');
  assert.equal(label.textContent, '展开看全部');
  assert.equal(shell.setChatFocus(true), true);
  assert.equal(label.textContent, '收起　ESC');

  h.nodes.get('#compose-input').value = '还没写完';
  h.documentLike.dispatchKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.app.classes.has('chat-focus'), true, '草稿非空时 Esc 不收起');

  h.nodes.get('#compose-input').value = '  ';
  h.documentLike.dispatchKey({ key: 'Escape', defaultPrevented: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(h.app.classes.has('chat-focus'), true, '别的弹层已处理 Esc 时不抢');

  let prevented = false;
  h.documentLike.dispatchKey({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.equal(h.app.classes.has('chat-focus'), false);
  assert.equal(h.documentLike.activeElement, toggle);
  assert.equal(label.textContent, '展开看全部');
  shell.destroy();
});

test('软键盘：可视区比窗口矮出一截时标 keyboard-open，收起后去掉', () => {
  const h = fixture(true);
  h.app.style = { setProperty() {}, removeProperty() {} };
  const listeners = new Map();
  const viewport = { height: 480, offsetTop: 0, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener() {} };
  Object.assign(h.windowLike, { innerHeight: 844, visualViewport: viewport });
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  assert.equal(h.app.classes.has('keyboard-open'), true);
  viewport.height = 830; // 地址栏伸缩这类小幅变化不算键盘
  listeners.get('resize')();
  assert.equal(h.app.classes.has('keyboard-open'), false);
  shell.destroy();
});

function mixerShellFixture(narrow) {
  const h = fixture(narrow);
  const details = h.nodes.get('#player-mixer-details');
  const summary = h.nodes.get('#mixer-summary');
  const slider = h.makeElement();
  details.open = true;
  details.contains = node => [details, summary, slider].includes(node);
  const shell = createListeningShellController({ appElement: h.app, documentLike: h.documentLike, windowLike: h.windowLike }).init();
  return { ...h, details, summary, slider, shell };
}

test('mixer uses the same native details: collapsed on narrow, inline on wide and reset on breakpoint', () => {
  const h = mixerShellFixture(true);
  assert.equal(h.details.open, false);
  h.windowLike.matchMedia().change(false);
  assert.equal(h.details.open, true);
  h.slider.focus();
  h.windowLike.matchMedia().change(true);
  assert.equal(h.details.open, false);
  assert.equal(h.documentLike.activeElement, h.summary, 'no focused slider left hidden after resize');
  h.shell.destroy();
});

test('Escape dismisses the narrow mixer before focus listening and restores its summary', () => {
  const h = mixerShellFixture(true);
  h.shell.enterFocusMode();
  h.details.open = true;
  h.slider.focus();
  let prevented = false;
  h.documentLike.dispatchKey({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(h.details.open, false);
  assert.equal(prevented, true);
  assert.equal(h.documentLike.activeElement, h.summary);
  assert.equal(h.app.classes.has('focus-mode'), true, 'first Esc must not also leave fullscreen');
  h.documentLike.dispatchKey({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(h.app.classes.has('focus-mode'), false);
  h.shell.destroy();
});

test('narrow mixer ignores internal pointer events and closes outside without touching values', () => {
  const h = mixerShellFixture(true);
  h.slider.value = '0.65';
  h.details.open = true;
  h.slider.focus();
  h.documentLike.dispatchPointer({ target: h.slider });
  assert.equal(h.details.open, true);
  h.documentLike.dispatchPointer({ target: h.nodes.get('#compose-input') });
  assert.equal(h.details.open, false);
  assert.equal(h.documentLike.activeElement, h.summary);
  assert.equal(h.slider.value, '0.65');
  h.shell.destroy();
});
