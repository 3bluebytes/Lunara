import assert from 'node:assert/strict';
import test from 'node:test';
import { initMemoryView } from './memoryView.js';

function harness() {
  const nodes = new Map();
  const node = selector => {
    if (!nodes.has(selector)) {
      const listeners = new Map();
      nodes.set(selector, {
        value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
        classList: { add() {}, remove() {} },
        addEventListener(type, fn) { listeners.set(type, fn); },
        removeEventListener(type) { listeners.delete(type); },
        async trigger(type, extra = {}) { await listeners.get(type)?.({ target: this, currentTarget: this, ...extra }); },
        querySelector() { return node(selector + ' span'); },
        setAttribute() {},
      });
    }
    return nodes.get(selector);
  };
  let snapshot = { memories: [], candidates: [], total: 0 };
  let loads = 0;
  let fail = false;
  let listener;
  const toasts = [];
  const controller = {
    getSnapshot: () => snapshot,
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    async load() {
      loads++;
      if (fail) throw new Error('PRIVATE_DETAIL');
      snapshot = { memories: [{ id: 'm1', content: '<script>雨声</script>', tags: 'rain', createdAt: Date.now() }], candidates: [], total: 1 };
      listener?.(snapshot);
    },
    async add() { if (fail) throw new Error('PRIVATE_DETAIL'); },
  };
  const view = initMemoryView({ controller, documentLike: { querySelector: node },
    schedule: () => 1, cancelSchedule() {}, onToast: (...args) => toasts.push(args) });
  return { view, node, toasts, get loads() { return loads; }, fail: value => { fail = value; } };
}

test('inline memory activates lazily, escapes content, and ignores hidden notifications', async () => {
  const h = harness();
  assert.equal(h.loads, 0);
  assert.equal(h.view.handleServerEvent({ type: 'STATION_MEMORY_UPDATED' }), false);
  await h.view.setActive(true);
  assert.equal(h.loads, 1);
  assert.match(h.node('#mem-list').innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(h.node('#mem-list').innerHTML, /<script>/);
  await h.view.setActive(true);
  assert.equal(h.loads, 1, '激活幂等');
  h.node('#mem-search').value = '不匹配';
  await h.node('#mem-search').trigger('input');
  assert.match(h.node('#mem-list').innerHTML, /没有匹配/);
  await h.view.setActive(false);
  assert.equal(h.view.handleServerEvent({ type: 'STATION_MEMORY_UPDATED' }), false);
  await h.view.setActive(true);
  assert.equal(h.loads, 2);
  h.view.destroy();
});

test('failed load offers retry without leaking raw errors; failed write preserves draft', async () => {
  const h = harness();
  h.fail(true);
  await h.view.setActive(true);
  assert.equal(h.node('#mem-retry').hidden, false);
  assert.match(h.node('#mem-status').textContent, /加载失败/);
  assert.doesNotMatch(JSON.stringify(h.toasts), /PRIVATE_DETAIL/);
  h.node('#mem-input').value = '喜欢雨声';
  h.node('#mem-tags').value = 'rain';
  await h.node('#mem-add').trigger('click');
  assert.equal(h.node('#mem-input').value, '喜欢雨声');
  assert.equal(h.node('#mem-tags').value, 'rain');
  assert.equal(h.node('#mem-add').disabled, false);
  assert.doesNotMatch(JSON.stringify(h.toasts), /PRIVATE_DETAIL/);
  h.fail(false);
  await h.node('#mem-retry').trigger('click');
  assert.equal(h.node('#mem-retry').hidden, true);
  assert.equal(h.loads, 2);
  h.view.destroy();
});

test('visible update notification refreshes once and destroy ignores later events', async () => {
  const h = harness();
  await h.view.setActive(true);
  assert.equal(h.view.handleServerEvent({ type: 'STATION_MEMORY_UPDATED', payload: { memoryIds: ['m1'] } }), true);
  await h.view.load();
  assert.equal(h.loads, 2, '同时刷新合并到在途请求');
  h.view.destroy();
  assert.equal(h.view.handleServerEvent({ type: 'STATION_MEMORY_UPDATED' }), false);
});
