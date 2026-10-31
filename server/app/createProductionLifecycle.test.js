import assert from 'node:assert/strict';
import test from 'node:test';
import { createProductionLifecycle } from './createProductionLifecycle.js';

test('production lifecycle orders dependencies and reverses them on stop', async () => {
  const calls = [];
  const component = name => ({
    start: async () => calls.push(`${name}:start`),
    stop: async () => calls.push(`${name}:stop`),
  });
  const lifecycle = createProductionLifecycle({
    realtime: component('realtime'),
    lifeContext: component('lifeContext'),
    station: component('station'),
    virtualPerson: component('virtualPerson'),
    dreaming: component('dreaming'),
    scheduler: component('scheduler'),
    playback: component('playback'),
    maintenance: component('maintenance'),
  });

  for (const entry of lifecycle) await entry.start();
  for (const entry of [...lifecycle].reverse()) await entry.stop();
  assert.deepEqual(calls, [
    'realtime:start',
    'lifeContext:start',
    'station:start',
    'virtualPerson:start',
    'dreaming:start',
    'scheduler:start',
    'playback:start',
    'maintenance:start',
    'maintenance:stop',
    'playback:stop',
    'scheduler:stop',
    'dreaming:stop',
    'virtualPerson:stop',
    'station:stop',
    'lifeContext:stop',
    'realtime:stop',
  ]);
});

test('missing optional components are omitted instead of becoming hidden no-ops', () => {
  const lifecycle = createProductionLifecycle({ station: { start() {}, stop() {} } });
  assert.deepEqual(lifecycle.map(entry => entry.name), ['station']);
});
