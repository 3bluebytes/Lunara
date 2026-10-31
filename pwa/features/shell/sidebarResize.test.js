import assert from 'node:assert/strict';
import test from 'node:test';
import { createSidebarResize, clampSidebarWidth, SIDEBAR_WIDTH } from './sidebarResize.js';
import { STORAGE_KEYS } from '../../core/storageKeys.js';

function fakeHandle(parentWidth = 220) {
  const listeners = new Map();
  const attrs = new Map();
  return {
    attrs,
    captured: null,
    parentElement: { getBoundingClientRect: () => ({ width: parentWidth }) },
    setAttribute(name, value) { attrs.set(name, value); },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    setPointerCapture(id) { this.captured = id; },
    releasePointerCapture() { this.captured = null; },
    fire(type, event = {}) { listeners.get(type)?.({ preventDefault() { this.prevented = true; }, ...event }); },
    listenerCount: () => listeners.size,
  };
}

function harness({ stored, desktop = true, parentWidth } = {}) {
  const props = new Map();
  const classes = new Set();
  const values = new Map(stored == null ? [] : [[STORAGE_KEYS.sidebarWidth, stored]]);
  const root = {
    style: { setProperty: (k, v) => props.set(k, v), removeProperty: k => props.delete(k) },
    classList: { add: c => classes.add(c), remove: c => classes.delete(c) },
  };
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const windowLike = { matchMedia: () => ({ matches: desktop }) };
  const handle = fakeHandle(parentWidth);
  const resize = createSidebarResize({ handle, root, storage, windowLike }).init();
  return { resize, handle, props, classes, values };
}

test('widths are clamped to 200–320 and garbage is rejected', () => {
  assert.equal(clampSidebarWidth(150), 200);
  assert.equal(clampSidebarWidth(999), 320);
  assert.equal(clampSidebarWidth('260.4'), 260);
  assert.equal(clampSidebarWidth('wide'), null);
});

test('a remembered width is restored and announced on the separator', () => {
  const h = harness({ stored: '280' });
  assert.equal(h.props.get('--sidebar-user-width'), '280px');
  assert.equal(h.handle.attrs.get('aria-valuenow'), '280');
  assert.equal(h.handle.attrs.get('aria-valuemin'), String(SIDEBAR_WIDTH.min));
  assert.equal(h.handle.attrs.get('aria-valuemax'), String(SIDEBAR_WIDTH.max));
});

test('without a remembered width the theme default stays in charge', () => {
  const h = harness({ stored: 'nonsense' });
  assert.equal(h.props.has('--sidebar-user-width'), false);
  assert.equal(h.handle.attrs.get('aria-valuenow'), String(SIDEBAR_WIDTH.fallback));
});

test('dragging follows the pointer, stays in range and is saved on release', () => {
  const h = harness({ parentWidth: 220 });
  h.handle.fire('pointerdown', { button: 0, pointerId: 7, clientX: 220 });
  assert.equal(h.handle.captured, 7);
  assert.ok(h.classes.has('sidebar-resizing'));
  h.handle.fire('pointermove', { pointerId: 7, clientX: 270 });
  assert.equal(h.props.get('--sidebar-user-width'), '270px');
  assert.equal(h.values.has(STORAGE_KEYS.sidebarWidth), false, '拖动中不写存储');
  h.handle.fire('pointermove', { pointerId: 7, clientX: 600 });
  assert.equal(h.props.get('--sidebar-user-width'), '320px');
  h.handle.fire('pointerup', { pointerId: 7 });
  assert.equal(h.values.get(STORAGE_KEYS.sidebarWidth), '320');
  assert.equal(h.classes.has('sidebar-resizing'), false);
  h.handle.fire('pointermove', { pointerId: 7, clientX: 100 });
  assert.equal(h.props.get('--sidebar-user-width'), '320px', '松手后移动不再改宽度');
});

test('arrow keys step by 16px, Home/End jump to the limits', () => {
  const h = harness();
  h.handle.fire('keydown', { key: 'ArrowRight' });
  assert.equal(h.props.get('--sidebar-user-width'), '236px');
  h.handle.fire('keydown', { key: 'Home' });
  h.handle.fire('keydown', { key: 'ArrowLeft' });
  assert.equal(h.props.get('--sidebar-user-width'), '200px');
  h.handle.fire('keydown', { key: 'End' });
  assert.equal(h.values.get(STORAGE_KEYS.sidebarWidth), '320');
});

test('double-click resets to the theme default and forgets the width', () => {
  const h = harness({ stored: '300' });
  h.handle.fire('dblclick');
  assert.equal(h.props.has('--sidebar-user-width'), false);
  assert.equal(h.values.has(STORAGE_KEYS.sidebarWidth), false);
  assert.equal(h.handle.attrs.get('aria-valuenow'), String(SIDEBAR_WIDTH.fallback));
});

test('narrow screens ignore drags and keys; destroy removes listeners', () => {
  const h = harness({ desktop: false });
  h.handle.fire('pointerdown', { button: 0, pointerId: 1, clientX: 0 });
  h.handle.fire('pointermove', { pointerId: 1, clientX: 80 });
  h.handle.fire('keydown', { key: 'ArrowRight' });
  assert.equal(h.props.has('--sidebar-user-width'), false);
  h.resize.destroy();
  assert.equal(h.handle.listenerCount(), 0);
});
