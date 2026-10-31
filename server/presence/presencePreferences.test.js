// 「一起听歌时伙伴会主动说话」开关：独立 prefs key、默认开、写入成功才算数、环境总开关优先
// （add-companion-heartbeat 4.2 / D7）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPresencePreferences, PRESENCE_PREFS_KEY } from './presencePreferences.js';

function memoryState(initial = {}) {
  const prefs = new Map(Object.entries(initial));
  return { prefs, failWrites: false,
    getPref(key) { return prefs.get(key) ?? null; },
    setPref(key, value) { if (this.failWrites) throw new Error('disk full'); prefs.set(key, typeof value === 'string' ? value : JSON.stringify(value)); } };
}

test('defaults to on and lives under its own prefs key', () => {
  const state = memoryState();
  const prefs = createPresencePreferences({ state, env: {} });
  assert.equal(PRESENCE_PREFS_KEY, 'presence_prefs_v1');
  assert.deepEqual(prefs.get(), { ambientEnabled: true, greetingEnabled: true, available: true });
  assert.equal(prefs.ambientEnabled(), true);
  assert.equal(prefs.greetingEnabled(), true);
  assert.deepEqual(prefs.set({ ambientEnabled: false }), { ambientEnabled: false, greetingEnabled: true, available: true });
  assert.deepEqual(JSON.parse(state.prefs.get('presence_prefs_v1')), { version: 1, ambientEnabled: false, greetingEnabled: true });
  assert.equal(prefs.ambientEnabled(), false);
  // 重启后读回同一个值。
  assert.equal(createPresencePreferences({ state, env: {} }).ambientEnabled(), false);
});

test('a failed write keeps the previous value and surfaces a recoverable error', () => {
  const state = memoryState();
  const prefs = createPresencePreferences({ state, env: {} });
  state.failWrites = true;
  assert.throws(() => prefs.set({ ambientEnabled: false }), error => error.code === 'PRESENCE_PREFS_WRITE_FAILED'
    && !/disk full/.test(error.message));
  assert.equal(prefs.ambientEnabled(), true);
});

test('only booleans are accepted; at least one switch must be given', () => {
  const prefs = createPresencePreferences({ state: memoryState(), env: {} });
  for (const value of ['false', 0, null]) {
    assert.throws(() => prefs.set({ ambientEnabled: value }), error => error.code === 'INVALID_PRESENCE_PREFS');
    assert.throws(() => prefs.set({ greetingEnabled: value }), error => error.code === 'INVALID_PRESENCE_PREFS');
  }
  assert.throws(() => prefs.set({}), error => error.code === 'INVALID_PRESENCE_PREFS');
  assert.equal(prefs.ambientEnabled(), true);
});

test('the app-open greeting switch is independent of the listening one (add-app-open-greeting D7)', () => {
  const state = memoryState({ presence_prefs_v1: JSON.stringify({ version: 1, ambientEnabled: false }) });
  const prefs = createPresencePreferences({ state, env: {} });
  assert.deepEqual(prefs.get(), { ambientEnabled: false, greetingEnabled: true, available: true }, '旧数据没有这个字段时默认开');
  assert.deepEqual(prefs.set({ greetingEnabled: false }), { ambientEnabled: false, greetingEnabled: false, available: true });
  assert.equal(prefs.greetingEnabled(), false);
  assert.equal(createPresencePreferences({ state, env: {} }).greetingEnabled(), false);
});

test('PRESENCE_AUTO=0 wins over the stored preference', () => {
  const state = memoryState({ presence_prefs_v1: JSON.stringify({ version: 1, ambientEnabled: true }) });
  const prefs = createPresencePreferences({ state, env: { PRESENCE_AUTO: '0' } });
  assert.deepEqual(prefs.get(), { ambientEnabled: true, greetingEnabled: true, available: false });
  assert.equal(prefs.ambientEnabled(), false);
  assert.equal(prefs.greetingEnabled(), false);
});

test('a corrupt or unreadable stored value falls back to the default', () => {
  assert.equal(createPresencePreferences({ state: memoryState({ presence_prefs_v1: '{oops' }), env: {} }).ambientEnabled(), true);
  const broken = { getPref() { throw new Error('locked'); }, setPref() {} };
  assert.equal(createPresencePreferences({ state: broken, env: {} }).ambientEnabled(), true);
});
