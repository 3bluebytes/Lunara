import assert from 'node:assert/strict';
import test from 'node:test';

function countRuntimeHandles() {
  const relevant = new Set(['TCPSERVERWRAP', 'TCPWRAP', 'Timeout']);
  return process.getActiveResourcesInfo()
    .filter(name => relevant.has(name))
    .sort();
}

test('runtime modules import without starting network or timers', async () => {
  const before = countRuntimeHandles();

  const [{ createRuntime }, { createHttpApp }, lifecycle] = await Promise.all([
    import('./createRuntime.js'),
    import('./createHttpApp.js'),
    import('./startRuntime.js'),
  ]);

  assert.equal(typeof createRuntime, 'function');
  assert.equal(typeof createHttpApp, 'function');
  assert.equal(typeof lifecycle.startRuntime, 'function');
  assert.equal(typeof lifecycle.stopRuntime, 'function');
  assert.deepEqual(countRuntimeHandles(), before);
});

test('runtime start and stop are explicit and release owned resources', async () => {
  const [{ createRuntime }, { createHttpApp }, { startRuntime, stopRuntime }] = await Promise.all([
    import('./createRuntime.js'),
    import('./createHttpApp.js'),
    import('./startRuntime.js'),
  ]);

  const calls = [];
  const runtime = await createRuntime({
    services: {
      healthService: { snapshot: async () => ({ ok: true, source: 'fake' }) },
    },
    lifecycle: [{
      name: 'fake-background-service',
      start: async () => calls.push('start'),
      stop: async () => calls.push('stop'),
    }],
  });
  const app = createHttpApp({
    runtime,
    configure({ app: expressApp, services }) {
      expressApp.get('/api/health', async (_req, res) => {
        res.json(await services.healthService.snapshot());
      });
    },
  });

  const handle = await startRuntime({ runtime, app, port: 0 });
  assert.equal(handle.address.address, '127.0.0.1');
  assert.ok(handle.address.port > 0);
  assert.deepEqual(calls, ['start']);

  const response = await fetch(`http://127.0.0.1:${handle.address.port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, source: 'fake' });

  await stopRuntime(handle);
  assert.deepEqual(calls, ['start', 'stop']);
  assert.equal(runtime.status, 'stopped');
});

test('failed subsystem startup is named and cleans partial resources in reverse order', async () => {
  const [{ createRuntime }, { createHttpApp }, { startRuntime }] = await Promise.all([
    import('./createRuntime.js'),
    import('./createHttpApp.js'),
    import('./startRuntime.js'),
  ]);
  const calls = [];
  const runtime = await createRuntime({
    lifecycle: [
      {
        name: 'station',
        start: () => calls.push('station:start'),
        stop: () => calls.push('station:stop'),
      },
      {
        name: 'scheduler',
        start: () => {
          calls.push('scheduler:start');
          throw new Error('cron exploded');
        },
        stop: () => calls.push('scheduler:stop'),
      },
    ],
  });

  await assert.rejects(
    () => startRuntime({ runtime, app: createHttpApp(), port: 0 }),
    /runtime start failed in scheduler: cron exploded/,
  );
  assert.deepEqual(calls, [
    'station:start',
    'scheduler:start',
    'scheduler:stop',
    'station:stop',
  ]);
  assert.equal(runtime.status, 'failed');
  assert.equal(runtime.startedLifecycle.length, 0);
});
