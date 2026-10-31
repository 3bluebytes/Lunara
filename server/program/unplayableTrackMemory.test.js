import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnplayableTrackMemory, isConfirmedUnplayable } from './unplayableTrackMemory.js';

test('只有 canonical-resource-unavailable + not-playable 算确认放不了', () => {
  assert.equal(isConfirmedUnplayable({ ok: false, error: 'canonical-resource-unavailable', code: 'not-playable' }), true);
  for (const code of ['timeout', 'unavailable', 'rate-limited', 'requires-auth', 'internal', undefined]) {
    assert.equal(isConfirmedUnplayable({ ok: false, error: 'canonical-resource-unavailable', code }), false, code);
  }
  assert.equal(isConfirmedUnplayable({ ok: false, error: 'all-sources-failed', code: 'not-playable' }), false);
  assert.equal(isConfirmedUnplayable({ ok: true, code: 'not-playable' }), false);
  assert.equal(isConfirmedUnplayable(null), false);
});

test('按 (provider, songId) 记录，同一 songId 不同供应商互不影响，过期后恢复', () => {
  let now = 1_000;
  const memory = new UnplayableTrackMemory({ now: () => now, ttlMs: 60_000 });
  memory.mark('qq', '001');
  assert.equal(memory.has('qq', '001'), true);
  assert.equal(memory.has('netease', '001'), false);
  now += 59_999;
  assert.equal(memory.has('qq', '001'), true);
  now += 1;
  assert.equal(memory.has('qq', '001'), false);
});

test('记录期内重复标记不延长冷却', () => {
  let now = 0;
  const memory = new UnplayableTrackMemory({ now: () => now, ttlMs: 10_000 });
  memory.mark('qq', 'a');
  now = 9_000;
  memory.mark('qq', 'a');
  now = 10_000;
  assert.equal(memory.has('qq', 'a'), false);
});

test('缺供应商或 songId 不记录；超出上限淘汰最旧', () => {
  const memory = new UnplayableTrackMemory({ now: () => 0, ttlMs: 10_000, maxItems: 2 });
  memory.mark('', 'x');
  memory.mark('qq', '');
  assert.equal(memory.size, 0);
  memory.mark('qq', '1');
  memory.mark('qq', '2');
  memory.mark('qq', '3');
  assert.equal(memory.size, 2);
  assert.equal(memory.has('qq', '1'), false);
  assert.equal(memory.has('qq', '3'), true);
});

test('clearProvider 只清这个源的记录', () => {
  const memory = new UnplayableTrackMemory({ now: () => 0, ttlMs: 10_000 });
  memory.mark('ncm', 'a');
  memory.mark('ncm', 'b');
  memory.mark('qq', 'a');
  assert.equal(memory.clearProvider('ncm'), 2);
  assert.equal(memory.has('ncm', 'a'), false);
  assert.equal(memory.has('ncm', 'b'), false);
  assert.equal(memory.has('qq', 'a'), true);
  assert.equal(memory.clearProvider(''), 0);
});
