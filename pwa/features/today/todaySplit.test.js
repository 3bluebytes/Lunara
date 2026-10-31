import assert from 'node:assert/strict';
import test from 'node:test';
import { createTodaySplit, clampTodayListWidth, TODAY_SPLIT } from './todaySplit.js';
import { STORAGE_KEYS } from '../../core/storageKeys.js';

function fakeHandle({ parentWidth = 1200 } = {}) {
  const attrs = new Map();
  return {
    attrs,
    captured: null,
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    closest(selector) {
      if (selector === '.today-split') return this;
      if (selector === '.today-workspace-body') return { getBoundingClientRect: () => ({ width: parentWidth }) };
      return null;
    },
    setPointerCapture(id) { this.captured = id; },
    releasePointerCapture() { this.captured = null; },
  };
}

function harness({ stored, desktop = true, handle } = {}) {
  const props = new Map();
  const listeners = new Map();
  const values = new Map(stored == null ? [] : [[STORAGE_KEYS.todayListWidth, stored]]);
  const rootClasses = new Set();
  const observers = [];
  let current = handle || fakeHandle();
  const panel = {
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) },
    ownerDocument: { documentElement: { classList: { add: c => rootClasses.add(c), remove: c => rootClasses.delete(c) } } },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const windowLike = {
    matchMedia: () => ({ matches: desktop }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {}
      disconnect() { this.disconnected = true; }
    },
  };
  const split = createTodaySplit({ panel, getHandle: () => current, storage, windowLike }).init();
  const fire = (type, event = {}) => listeners.get(type)?.({
    preventDefault() { this.prevented = true; },
    target: { closest: selector => (selector === '.today-split' ? current : null) },
    ...event,
  });
  return {
    split, panel, props, values, rootClasses, observers, fire,
    setHandle(next) { current = next; },
    listenerCount: () => listeners.size,
  };
}

test('widths clamp to 280–640 and stay clear of the editor minimum', () => {
  assert.equal(clampTodayListWidth(120), TODAY_SPLIT.min);
  assert.equal(clampTodayListWidth(999), TODAY_SPLIT.max);
  assert.equal(clampTodayListWidth('312.6'), 313);
  assert.equal(clampTodayListWidth('wide'), null);
  assert.equal(clampTodayListWidth(560, 900), 480, 'container cap keeps 420px for the editor');
  assert.equal(clampTodayListWidth(400, 600), 280, 'a tiny container still leaves the list at its minimum');
});

test('a remembered width is restored and announced on the separator', () => {
  const h = harness({ stored: '420' });
  assert.equal(h.props.get('--today-list-width'), '420px');
  assert.equal(h.split.width(), 420);
});

test('garbage or out-of-range stored values fall back to the theme default', () => {
  const h = harness({ stored: 'nonsense' });
  assert.equal(h.props.has('--today-list-width'), false);
  assert.equal(h.split.width(), null);
});

test('dragging follows the pointer, respects the editor minimum and saves on release', () => {
  const h = harness({ stored: '400' });
  h.fire('pointerdown', { button: 0, pointerId: 3, clientX: 400 });
  assert.ok(h.rootClasses.has('today-splitting'), 'drag state is global while dragging');
  h.fire('pointermove', { pointerId: 3, clientX: 500 });
  assert.equal(h.props.get('--today-list-width'), '500px');
  assert.equal(h.values.get(STORAGE_KEYS.todayListWidth), '400', 'no storage write mid-drag');
  h.fire('pointermove', { pointerId: 3, clientX: 2000 });
  assert.equal(h.props.get('--today-list-width'), '640px');
  h.fire('pointerup', { pointerId: 3 });
  assert.equal(h.values.get(STORAGE_KEYS.todayListWidth), '640');
  assert.equal(h.rootClasses.has('today-splitting'), false);
  h.fire('pointermove', { pointerId: 3, clientX: 100 });
  assert.equal(h.props.get('--today-list-width'), '640px', 'moving after release changes nothing');
});

test('narrow containers cap the drag so the editor keeps its floor', () => {
  const h = harness({ stored: '400', handle: fakeHandle({ parentWidth: 900 }) });
  h.fire('pointerdown', { button: 0, pointerId: 1, clientX: 400 });
  h.fire('pointermove', { pointerId: 1, clientX: 700 });
  assert.equal(h.props.get('--today-list-width'), '480px');
});

test('arrow keys step 16px, Home/End jump to the limits, double-click restores the default', () => {
  const h = harness({ stored: '400' });
  h.fire('keydown', { key: 'ArrowRight' });
  assert.equal(h.props.get('--today-list-width'), '416px');
  h.fire('keydown', { key: 'Home' });
  assert.equal(h.props.get('--today-list-width'), '280px');
  h.fire('keydown', { key: 'End' });
  assert.equal(h.values.get(STORAGE_KEYS.todayListWidth), '640');
  h.fire('dblclick');
  assert.equal(h.props.has('--today-list-width'), false);
  assert.equal(h.values.has(STORAGE_KEYS.todayListWidth), false);
});

test('re-render: the new separator gets the remembered aria value', () => {
  const h = harness({ stored: '460' });
  assert.equal(h.observers.length, 1, 'one observer watches re-renders');
  const fresh = fakeHandle();
  h.setHandle(fresh);
  h.observers[0].callback();
  assert.equal(fresh.attrs.get('aria-valuenow'), '460');
  assert.equal(fresh.attrs.get('aria-valuetext'), '列表 460 像素');
});

test('narrow screens ignore drags and keys; destroy releases listeners and drag state', () => {
  const h = harness({ desktop: false });
  h.fire('pointerdown', { button: 0, pointerId: 9, clientX: 0 });
  h.fire('pointermove', { pointerId: 9, clientX: 300 });
  h.fire('keydown', { key: 'ArrowRight' });
  assert.equal(h.props.has('--today-list-width'), false);
  h.split.destroy();
  assert.equal(h.listenerCount(), 0);
  assert.equal(h.rootClasses.has('today-splitting'), false);
  assert.equal(h.observers[0].disconnected, true);
});
