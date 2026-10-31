import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { runServerEntrypoint } from './runServerEntrypoint.js';
import { installElectronShutdown } from '../../electron/shutdown.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('CLI signals wait for startup, stop once, and never force-exit on clean shutdown', async () => {
  const host = new EventEmitter();
  const exits = [];
  host.exit = code => exits.push(code);
  let release, stops = 0;
  const entry = runServerEntrypoint({ process: host, port: 0,
    start: () => new Promise(resolve => { release = resolve; }), stop: async () => { stops++; } });
  await settle();
  host.emit('SIGINT');
  release(); await entry.shutdown();
  host.emit('SIGTERM'); // 停机已完成后的重复信号不应触发强杀路径
  await settle();
  assert.equal(stops, 1);
  assert.deepEqual(exits, []);
});

test('second Ctrl-C during a hung graceful shutdown force-exits immediately', async () => {
  const host = new EventEmitter();
  const exits = [];
  host.exit = code => exits.push(code);
  const entry = runServerEntrypoint({ process: host, port: 0,
    start: async () => {}, stop: () => new Promise(() => {}) }); // stop 永不完成
  await settle();
  host.emit('SIGINT');
  await settle();
  host.emit('SIGINT');
  await settle();
  assert.deepEqual(exits, [130]);
});

test('graceful shutdown deadline force-exits when stop never settles', async () => {
  const host = new EventEmitter();
  const exits = [];
  host.exit = code => exits.push(code);
  const entry = runServerEntrypoint({ process: host, port: 0, shutdownTimeoutMs: 30,
    start: async () => {}, stop: () => new Promise(() => {}) }); // stop 永不完成
  await settle();
  host.emit('SIGTERM');
  await sleep(120);
  assert.deepEqual(exits, [1]);
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('CLI startup failure cleans up and reports failure without raw diagnostics', async () => {
  const host = new EventEmitter(), messages = [];
  let stops = 0;
  const entry = runServerEntrypoint({ process: host,
    start: async () => { throw new Error('private diagnostic'); },
    stop: async () => { stops++; }, report: message => messages.push(message) });
  await entry.shutdown();
  assert.equal(stops, 1); assert.equal(host.exitCode, 1);
  assert.ok(messages.every(message => !message.includes('private diagnostic')));
});

test('Electron waits for cleanup before quit and does not repeat cleanup on re-entry', async () => {
  const app = new EventEmitter();
  let release, stops = 0, exits = 0;
  app.quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    if (!prevented) exits++;
  };
  installElectronShutdown(app, () => { stops++; return new Promise(resolve => { release = resolve; }); });
  app.quit(); app.quit(); await settle();
  assert.equal(stops, 1); assert.equal(exits, 0);
  release(); await settle();
  assert.equal(stops, 1); assert.equal(exits, 1);
});
