import assert from 'node:assert/strict';
import test from 'node:test';
import { registerOperationsRoutes } from './operationsRoutes.js';

function harness(services) {
  const routes = new Map();
  const app = { get: (path, h) => routes.set(`GET ${path}`, h), post: () => {}, patch: () => {} };
  registerOperationsRoutes(app, services);
  const call = () => { const res = { statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
  routes.get('GET /api/presence/status')({}, res); return res; };
  return { call };
}

test('presence status returns the observer product facts only', () => {
  const status = { enabled: true, phase: 'observing', level: 'sparse', quietHours: { start: '23:30', end: '08:00' },
    today: { spoken: 0, ignored: 0 }, lastResult: null };
  const res = harness({ presence: { status: () => status } }).call();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true, ...status });
});

test('presence status without an observer reports it as disabled instead of failing', () => {
  const res = harness({}).call();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true, enabled: false, phase: 'off' });
});

// ── 「一起听歌时伙伴会主动说话」开关（add-companion-heartbeat 4.2） ──
function prefsHarness(presence) {
  const routes = new Map();
  const app = { get: (path, h) => routes.set(`GET ${path}`, h), post: (path, h) => routes.set(`POST ${path}`, h), patch: () => {} };
  registerOperationsRoutes(app, { presence });
  const call = async (method, body) => { const res = { statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
  await routes.get(`${method} /api/presence/preferences`)({ body }, res); return res; };
  return { call };
}

test('presence preferences read and write through the presence service', async () => {
  let value = { ambientEnabled: true, available: true };
  const writes = [];
  const h = prefsHarness({ preferences: () => value,
    setPreferences: input => { writes.push(input); value = { ...value, ambientEnabled: input.ambientEnabled }; return value; } });
  assert.deepEqual((await h.call('GET')).payload, { ok: true, ambientEnabled: true, available: true });
  const res = await h.call('POST', { ambientEnabled: false, extra: 'ignored' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ok: true, ambientEnabled: false, available: true });
  assert.deepEqual(writes, [{ ambientEnabled: false }]);
});

test('presence preferences reject a non-boolean and report write failures without internals', async () => {
  const h = prefsHarness({ preferences: () => ({ ambientEnabled: true, available: true }),
    setPreferences: () => { const error = new Error('没能保存这个开关'); error.code = 'PRESENCE_PREFS_WRITE_FAILED'; throw error; } });
  const bad = await h.call('POST', { ambientEnabled: 'no' });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.payload.code, 'invalid_presence_preferences');
  const failed = await h.call('POST', { ambientEnabled: false });
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.payload, { ok: false, error: '没能保存这个开关', code: 'presence_preferences_write_failed' });
});

test('presence preferences without a presence service report it unavailable', async () => {
  const h = prefsHarness(undefined);
  assert.deepEqual((await h.call('GET')).payload, { ok: true, ambientEnabled: false, greetingEnabled: false, available: false });
  assert.equal((await h.call('POST', { ambientEnabled: true })).statusCode, 503);
});

test('the app-open greeting switch is written on its own; an empty or mixed-bad body is rejected', async () => {
  const writes = [];
  const h = prefsHarness({ preferences: () => ({}), setPreferences: input => { writes.push(input); return { ambientEnabled: true, greetingEnabled: false, available: true }; } });
  const res = await h.call('POST', { greetingEnabled: false });
  assert.deepEqual(res.payload, { ok: true, ambientEnabled: true, greetingEnabled: false, available: true });
  assert.deepEqual(writes, [{ greetingEnabled: false }]);
  assert.equal((await h.call('POST', {})).statusCode, 400);
  assert.equal((await h.call('POST', { greetingEnabled: false, ambientEnabled: 'x' })).statusCode, 400);
  assert.equal(writes.length, 1);
});

// ── 「安静点」一键恢复（add-companion-expression-and-reception 3.3） ──
test('listener-quiet restore validates the session id and clears only through the presence service', async () => {
  const routes = new Map();
  const app = { get: () => {}, post: (path, h) => routes.set(path, h), patch: () => {} };
  const calls = [];
  registerOperationsRoutes(app, { presence: { restoreListenerQuiet: id => { calls.push(id); return { restored: true, listenerQuietSessionId: null }; } } });
  const call = body => { const res = { statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return this; } };
  routes.get('/api/presence/listener-quiet/restore')({ body }, res); return res; };
  assert.equal(call({ sessionId: '../x' }).statusCode, 400);
  assert.deepEqual(call({ sessionId: 'room' }).payload, { ok: true, restored: true, listenerQuietSessionId: null });
  assert.deepEqual(calls, ['room']);
});
