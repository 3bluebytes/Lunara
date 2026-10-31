import assert from 'node:assert/strict';
import test from 'node:test';
import cron from 'node-cron';
import * as scheduler from './scheduler.js';

test('scheduler start/stop owns cron tasks idempotently', async () => {
  const originalSchedule = cron.schedule;
  const tasks = [];
  let weeklyCalls = 0;
  cron.schedule = (expression, callback) => {
    const task = {
      expression,
      callback,
      stopped: 0,
      destroyed: 0,
      stop() { this.stopped += 1; },
      destroy() { this.destroyed += 1; },
    };
    tasks.push(task);
    return task;
  };

  scheduler.attach({
    listRadioHosts: () => [],
  }, {
    librarySyncService: {
      start: () => { tasks.libraryStarts = (tasks.libraryStarts || 0) + 1; },
      stop: () => { tasks.libraryStops = (tasks.libraryStops || 0) + 1; },
      periodic: async () => {},
      weekly: async () => {
        weeklyCalls += 1;
        if (weeklyCalls === 1) throw new Error('temporary provider outage');
      },
    },
  });

  try {
    scheduler.start();
    const firstTaskCount = tasks.length;
    assert.ok(firstTaskCount > 0);
    assert.equal(tasks.libraryStarts, 1);
    const weeklyTask = tasks.find(task => task.expression === '0 4 * * 0');
    weeklyTask.callback();
    weeklyTask.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(weeklyCalls, 2, 'a failed cron run does not disable the next run');

    scheduler.start();
    assert.equal(tasks.length, firstTaskCount, 'second start must not duplicate cron tasks');

    scheduler.stop();
    assert.equal(tasks.filter(task => task.stopped === 1).length, firstTaskCount);
    assert.equal(tasks.filter(task => task.destroyed === 1).length, firstTaskCount);
    assert.equal(tasks.libraryStops, 1);

    scheduler.stop();
  } finally {
    scheduler.stop?.();
    cron.schedule = originalSchedule;
    scheduler.detach?.();
  }
});
