import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedTaskGroup } from './ManagedTaskGroup.js';

test('ManagedTaskGroup owns timeouts, intervals, and cleanup callbacks', async () => {
  const calls = [];
  const clock = {
    setTimeout: (_fn, ms) => ({ type: 'timeout', ms }),
    clearTimeout: handle => calls.push(['clear-timeout', handle.ms]),
    setInterval: (_fn, ms) => ({ type: 'interval', ms }),
    clearInterval: handle => calls.push(['clear-interval', handle.ms]),
  };
  const tasks = new ManagedTaskGroup({ clock });
  tasks.timeout(() => {}, 2000);
  tasks.interval(() => {}, 60000);
  tasks.addCleanup(async () => calls.push(['cleanup']));

  assert.equal(tasks.size, 3);
  await tasks.stop();
  assert.deepEqual(calls, [
    ['cleanup'],
    ['clear-interval', 60000],
    ['clear-timeout', 2000],
  ]);
  assert.equal(tasks.size, 0);

  await tasks.stop();
  assert.equal(calls.length, 3, 'stop is idempotent');
});

test('a fired timeout removes itself from ownership', async () => {
  let callback;
  const calls = [];
  const tasks = new ManagedTaskGroup({
    clock: {
      setTimeout: fn => { callback = fn; return { id: 1 }; },
      clearTimeout: () => calls.push('cleared'),
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    },
  });
  tasks.timeout(() => calls.push('fired'), 1);
  assert.equal(tasks.size, 1);
  await callback();
  assert.equal(tasks.size, 0);
  await tasks.stop();
  assert.deepEqual(calls, ['fired']);
});
