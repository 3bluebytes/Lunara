import assert from 'node:assert/strict';
import test from 'node:test';

import { createTooltipLayer } from './tooltip.js';

function bubbleNode() {
  return {
    className: '', id: '', hidden: true, textContent: '', style: {}, isConnected: false, parentNode: null,
    classList: { values: new Set(), add(name) { this.values.add(name); }, remove(name) { this.values.delete(name); } },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    remove() { this.isConnected = false; this.parentNode = null; },
  };
}

function fakeDom({ width = 1200, height = 800 } = {}) {
  const listeners = new Map();
  const viewListeners = new Map();
  const created = [];
  const doc = {
    activeElement: null,
    body: {
      appendChild(node) { node.isConnected = true; node.parentNode = doc.body; return node; },
    },
    createElement: () => { const node = bubbleNode(); created.push(node); return node; },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    querySelector: () => null,
    defaultView: {
      innerWidth: width,
      innerHeight: height,
      addEventListener(type, listener) {
        if (!viewListeners.has(type)) viewListeners.set(type, new Set());
        viewListeners.get(type).add(listener);
      },
      removeEventListener(type, listener) { viewListeners.get(type)?.delete(listener); },
    },
  };
  return {
    doc,
    bubble: () => created[0] || null,
    fire(type, event = {}) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
    fireView(type) {
      for (const listener of viewListeners.get(type) || []) listener({});
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

function tipElement(tip, rect = { left: 100, top: 200, width: 80, height: 20, right: 180, bottom: 220 }) {
  const attrs = {};
  const element = {
    dataset: tip === undefined ? {} : { tip },
    attrs,
    getBoundingClientRect: () => rect,
    getAttribute(name) { return attrs[name] ?? null; },
    setAttribute(name, value) { attrs[name] = value; },
    removeAttribute(name) { delete attrs[name]; },
    contains: () => false,
    closest: () => element,
  };
  return element;
}

const tick = () => new Promise(done => setTimeout(done, 5));

test('hovering a data-tip element shows its text in one shared bubble', async () => {
  const f = fakeDom();
  const layer = createTooltipLayer({ documentLike: f.doc, delayMs: 0 }).init();
  try {
    const anchor = tipElement('只影响推荐候选，不保证播放比例');
    f.fire('pointerover', { target: anchor });
    await tick();
    const bubble = f.bubble();
    assert.ok(bubble, '气泡必须挂到 body 上，而不是塞进设置面板内部');
    assert.equal(bubble.textContent, '只影响推荐候选，不保证播放比例');
    assert.equal(bubble.hidden, false);
    assert.equal(bubble.parentNode, f.doc.body);
    assert.match(bubble.style.left, /px$/);
    assert.match(bubble.style.top, /px$/);
    assert.equal(anchor.attrs['data-tip-open'], 'true');
  } finally { layer.destroy(); }
});

test('a bubble near the top of the viewport flips below the element instead of clipping', async () => {
  const f = fakeDom();
  const layer = createTooltipLayer({ documentLike: f.doc, delayMs: 0 }).init();
  try {
    const anchor = tipElement('靠近顶端', { left: 600, top: 4, width: 60, height: 18, right: 660, bottom: 22 });
    f.fire('pointerover', { target: anchor });
    await tick();
    assert.equal(Number.parseFloat(f.bubble().style.top) >= 22, true, '上方放不下就翻到下方');
  } finally { layer.destroy(); }
});

test('keyboard focus announces the same sentence through aria-describedby', async () => {
  const f = fakeDom();
  const layer = createTooltipLayer({ documentLike: f.doc, delayMs: 0 }).init();
  try {
    const anchor = tipElement('手动城市不会被 IP 覆盖');
    f.doc.activeElement = anchor;
    f.fire('focusin', { target: anchor });
    assert.equal(anchor.attrs['aria-describedby'], 'ui-tip-bubble');
    assert.equal(f.bubble().textContent, '手动城市不会被 IP 覆盖');

    f.doc.activeElement = null;
    f.fire('focusout', { target: anchor });
    assert.equal(anchor.attrs['aria-describedby'], undefined, '离开后必须撤掉描述，否则读屏软件会一直念旧提示');
    assert.equal(anchor.attrs['data-tip-open'], undefined);
    assert.equal(f.bubble().hidden, true);
  } finally { layer.destroy(); }
});

test('an existing aria-describedby is extended and then restored, never thrown away', () => {
  const f = fakeDom();
  const layer = createTooltipLayer({ documentLike: f.doc, delayMs: 0 }).init();
  try {
    // 勾选框自己已经有一条「现在是开还是关」的描述：提示只能追加，不能顶掉它。
    const anchor = tipElement('关掉后只在你说话时开口');
    const input = tipElement(undefined);
    input.attrs['aria-describedby'] = 'presence-ambient-note';
    input.closest = () => anchor;
    anchor.contains = candidate => candidate === input;
    f.doc.activeElement = input;
    f.fire('focusin', { target: input });
    assert.equal(input.attrs['aria-describedby'], 'presence-ambient-note ui-tip-bubble');

    f.fire('focusout', { target: input });
    assert.equal(input.attrs['aria-describedby'], 'presence-ambient-note', '离焦后必须原样还回去');
  } finally { layer.destroy(); }
});

test('Escape and scrolling close the bubble immediately', async () => {
  const f = fakeDom();
  const layer = createTooltipLayer({ documentLike: f.doc, delayMs: 0 }).init();
  try {
    const anchor = tipElement('曲名或歌词');
    f.fire('pointerover', { target: anchor });
    await tick();
    assert.equal(f.bubble().hidden, false);
    f.fire('keydown', { key: 'Escape' });
    assert.equal(f.bubble().hidden, true);

    f.fire('pointerover', { target: anchor });
    await tick();
    assert.equal(f.bubble().hidden, false);
    f.fireView('scroll');
    assert.equal(f.bubble().hidden, true, '滚动后旧坐标会错位，宁可先收起');
  } finally { layer.destroy(); }
});

test('elements without a tip are left alone, and blank tips never open a bubble', async () => {
  const f = fakeDom();
  const layer = createTooltipLayer({ documentLike: f.doc, delayMs: 0 }).init();
  try {
    f.fire('pointerover', { target: { closest: () => null } });
    await tick();
    assert.equal(f.bubble(), null);

    const blank = tipElement('   ');
    f.fire('pointerover', { target: blank });
    await tick();
    assert.equal(f.bubble(), null);
    assert.equal(blank.attrs['data-tip-open'], undefined);
  } finally { layer.destroy(); }
});

test('destroy unbinds every listener and removes the bubble', () => {
  const f = fakeDom();
  const layer = createTooltipLayer({ documentLike: f.doc, delayMs: 0 }).init();
  assert.ok(f.listenerCount() > 0);
  layer.destroy();
  assert.equal(f.listenerCount(), 0);
});
