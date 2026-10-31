// receptionSignals.test.js — 接收信号只收已接受事实；cadenceFactor 有界、衰减
// （add-companion-expression-and-reception 3.1 / 3.2）。
//
// Run: node --test server/presence/receptionSignals.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { cadenceFactor, createReceptionSignals, RECEPTION_LIMITS } from './receptionSignals.js';

const MIN = 60_000;
const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
};

test('a user turn within 5 minutes after her line counts once as replied; later or without a line it does not', () => {
  const c = clock();
  const rs = createReceptionSignals({ now: c.now });
  assert.equal(rs.noteUserTurn('s1'), null, '她没说过话，你开口不是信号');
  rs.noteLine('s1', { voiced: false });
  c.advance(4 * MIN);
  assert.equal(rs.noteUserTurn('s1'), 'replied');
  assert.equal(rs.noteUserTurn('s1'), null, '同一句只算一次');
  rs.noteLine('s1', { voiced: false });
  c.advance(6 * MIN);
  assert.equal(rs.noteUserTurn('s1'), null, '超过 5 分钟不算');
  assert.equal(rs.noteUserTurn('other'), null, '别的聊天不算');
  assert.deepEqual(rs.signals().map(s => s.kind), ['replied']);
});

test('a skip within 30 seconds counts only after a voiced line, once', () => {
  const c = clock();
  const rs = createReceptionSignals({ now: c.now });
  rs.noteLine('s1', { voiced: false });
  c.advance(5_000);
  assert.equal(rs.noteSkip('s1'), null, '只出文字的那句后切歌不算');
  rs.noteLine('s1', { voiced: true });
  c.advance(20_000);
  assert.equal(rs.noteSkip('s1'), 'skipped_after_line');
  assert.equal(rs.noteSkip('s1'), null);
  rs.noteLine('s1', { voiced: true });
  c.advance(31_000);
  assert.equal(rs.noteSkip('s1'), null, '30 秒之后的切歌不算');
});

test('cadenceFactor starts at 1, follows the weights, halves every 2 hours and stays within 0.75–2.0', () => {
  const c = clock();
  const traces = [];
  const rs = createReceptionSignals({ now: c.now, trace: (sessionId, event) => traces.push({ sessionId, ...event }) });
  assert.equal(rs.cadenceFactor('s1'), 1);
  rs.askMore('s1');
  assert.equal(rs.cadenceFactor('s1'), 0.75, '1 − 0.3 = 0.7 → 下限 0.75');
  assert.equal(rs.cadenceFactor('s2'), 1, '信号按聊天记，不跨聊天');
  assert.deepEqual(traces, [{ sessionId: 's1', type: 'reception_signal', kind: 'asked_more', cadenceFactor: 0.75 }], 'trace 可观察系数，不含原话');
  c.advance(RECEPTION_LIMITS.halfLifeMs);
  assert.ok(Math.abs(rs.cadenceFactor('s1') - 0.85) < 1e-9, '两小时后权重减半');
  const now = 10 * 60 * MIN;
  const many = Array.from({ length: 20 }, () => ({ weight: 0.15, atMs: now }));
  assert.equal(cadenceFactor(many, now), 2.0, '上限 2.0');
  assert.ok(Math.abs(cadenceFactor([{ weight: 0.15, atMs: now }], now) - 1.15) < 1e-9);
});

test('asked quiet holds for that listening source only; restore, a source change or a new listening clears it', () => {
  const c = clock();
  const changes = [];
  const rs = createReceptionSignals({ now: c.now, onChange: change => changes.push(change) });
  rs.askQuiet('a');
  assert.equal(rs.isQuiet('a'), true);
  assert.equal(rs.isQuiet('b'), false);
  rs.noteSource(null);
  assert.equal(rs.isQuiet('a'), true, '暂停/停止不清');
  rs.noteSource('a');
  assert.equal(rs.isQuiet('a'), true);
  rs.noteSource('b');
  assert.equal(rs.quietSessionId(), null, '换了来源就恢复');

  rs.askQuiet('a');
  rs.noteSessionOpen('a');
  assert.equal(rs.isQuiet('a'), true, '同一时刻的开场不算「下次」');
  c.advance(1000);
  rs.noteSessionOpen('b');
  assert.equal(rs.isQuiet('a'), true);
  rs.noteSessionOpen('a');
  assert.equal(rs.isQuiet('a'), false, '下次一起听恢复');

  rs.askQuiet('a');
  assert.equal(rs.restore('b'), false);
  assert.equal(rs.restore('a'), true);
  assert.deepEqual(changes.filter(x => x.type === 'quiet').map(x => x.quiet), [true, false, true, false, true, false]);
  assert.equal(rs.cadenceFactor('a'), 1, '安静点不改节奏系数');
});
