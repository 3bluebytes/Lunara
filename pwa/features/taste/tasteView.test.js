import assert from 'node:assert/strict';
import test from 'node:test';
import { initTasteView, relativeTime } from './tasteView.js';

function createClassList() {
  const set = new Set();
  return {
    add: name => set.add(name),
    remove: name => set.delete(name),
    contains: name => set.has(name),
  };
}

function createTarget() {
  const listeners = new Map();
  return {
    style: {},
    title: '',
    textContent: '',
    innerHTML: '',
    classList: createClassList(),
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, event = {}) {
      for (const fn of listeners.get(type) || []) fn(event);
    },
    listenerCount() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

test('relativeTime formats empty, sub-minute, minute, hour, and day deltas', () => {
  const base = 1_700_000_000_000;
  assert.equal(relativeTime(0, base), '—');
  assert.equal(relativeTime(base - 15_000, base), '刚刚');
  assert.equal(relativeTime(base - 5 * 60_000, base), '5 分钟前');
  assert.equal(relativeTime(base - 3 * 3600_000, base), '3 小时前');
  assert.equal(relativeTime(base - 2 * 86_400_000, base), '2 天前');
});

test('initTasteView short-circuits polling, initial status fetch, and global listeners when #sb-taste-status is absent', async () => {
  const doc = createTarget();
  doc.querySelector = () => null;
  let statusCalls = 0;
  const intervals = [];

  const view = initTasteView({
    controller: {
      status: async () => { statusCalls += 1; return { lastFinishedAt: 1000 }; },
      history: async () => ({ log: [] }),
    },
    documentLike: doc,
    scheduleInterval: fn => { intervals.push(fn); return intervals.length; },
    cancelInterval() {},
  });

  assert.equal(intervals.length, 0, '无挂载容器时不启动 setInterval');
  assert.equal(statusCalls, 0, '无挂载容器时不发初始状态请求');
  assert.equal(doc.listenerCount(), 0, '无挂载容器时不挂全局 click/keydown 监听');
  assert.equal(await view.refresh(), null);
  await view.open();
  view.close();
  view.destroy();
});

test('initTasteView starts polling, opens/closes popover, and cleans up when #sb-taste-status is mounted', async () => {
  const baseNow = 1_700_000_000_000;
  const statusEl = createTarget();
  const timeEl = createTarget();
  const closeBtn = createTarget();
  const popoverEl = createTarget();
  popoverEl.querySelector = selector => (selector === '#sb-taste-popover-close' ? closeBtn : null);
  statusEl.querySelector = selector => {
    if (selector === '#sb-taste-time') return timeEl;
    if (selector === '#sb-taste-popover') return popoverEl;
    return null;
  };

  const doc = createTarget();
  doc.querySelector = selector => {
    if (selector === '#sb-taste-status') return statusEl;
    if (selector === '#sb-taste-time') return timeEl;
    if (selector === '#sb-taste-popover') return popoverEl;
    return null;
  };

  const activeIntervals = new Map();
  let nextId = 0;
  let statusCalls = 0;

  const view = initTasteView({
    controller: {
      status: async () => {
        statusCalls += 1;
        return { lastFinishedAt: baseNow - 10 * 60_000, running: true, lastSummary: '偏好已更新' };
      },
      history: async () => ({
        log: [{ finished_at: baseNow - 120_000, status: 'done', dry_run: false, summary: '常听 <jazz>' }],
      }),
    },
    documentLike: doc,
    scheduleInterval: fn => { const id = ++nextId; activeIntervals.set(id, fn); return id; },
    cancelInterval: id => activeIntervals.delete(id),
    now: () => baseNow,
  });

  await Promise.resolve();
  assert.equal(statusCalls, 1);
  assert.equal(activeIntervals.size, 1);
  assert.equal(timeEl.textContent, '10 分钟前 · 整理中');
  assert.equal(statusEl.title, '偏好已更新');

  await view.open();
  assert.equal(popoverEl.classList.contains('visible'), true);
  assert.match(popoverEl.innerHTML, /2 分钟前 · done/);
  assert.match(popoverEl.innerHTML, /常听 &lt;jazz&gt;/);

  doc.emit('keydown', { key: 'Escape' });
  assert.equal(popoverEl.classList.contains('visible'), false);

  view.destroy();
  assert.equal(activeIntervals.size, 0, 'destroy 取消轮询定时器');
  assert.equal(doc.listenerCount(), 0, 'destroy 移除全局监听');
  assert.equal(statusEl.listenerCount(), 0, 'destroy 移除状态节点监听');
});
