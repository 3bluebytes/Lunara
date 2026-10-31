import test from 'node:test';
import assert from 'node:assert/strict';
import { WarmPoolService } from './WarmPoolService.js';
import { normalizeMusicSelection } from '../program/musicSelectionRequest.js';
const requests = [
  { mode: 'exact', targets: [{ title: '歌' }] }, { mode: 'artist', artist: 'A' },
  { mode: 'playlist', playlist: { source: 'qq', playlistId: 'list' } },
  { mode: 'constrained', constraints: { tags: { language: 'yue' } } }, { mode: 'discovery', delivery: 'recommend_only' },
];
test('all structured modes share preparation; reservations release on failure and consume once', async () => {
  for (const input of requests) {
    const request = normalizeMusicSelection({ delivery: 'append', ...input });
    const context = { sessionId: 'a', virtualPersonId: 'radiohost:a', sharedRevision: 1 };
    const pool = new WarmPoolService({ disabled: false, getActiveDemand: () => ({ request, context }),
      select: async () => ({ ok: true, request, candidates: [{ query: 'A — 歌' }] }) });
    await pool.refresh(); const reservation = pool.reserve(request, context);
    assert.ok(reservation); assert.equal(pool.reserve(request, context), null);
    pool.release(reservation.id); assert.ok(pool.reserve(request, context));
    assert.equal(pool.reserve(request, { ...context, sharedRevision: 2 }), null);
    pool.consume(reservation.id); pool.consume(reservation.id);
    assert.equal(pool.stats.consumed, 1); pool.shutdown();
  }
});
test('changing room or memory discards an in-flight preparation without effects', async () => {
  let resolve, signal;
  let demand = { request: normalizeMusicSelection({ mode: 'discovery', delivery: 'append' }), context: { sessionId: 'a', virtualPersonId: 'radiohost:a' } };
  const pool = new WarmPoolService({ disabled: false, getActiveDemand: () => demand,
    select: async (_request, context) => { signal = context.signal; return new Promise(done => { resolve = done; }); } });
  const first = pool.refresh(); demand = null; await pool.refresh();
  assert.equal(signal.aborted, true); resolve({ ok: true, request: {}, candidates: [{}] }); await first;
  assert.equal(pool.entries.size, 0); pool.shutdown();
});

// ---- 预热：定时/事件刷新的有界兜底（权威触发点是 runtime 低队列路径）----

const prewarmDemand = () => ({ request: normalizeMusicSelection({ mode: 'discovery', delivery: 'append' }),
  context: { sessionId: 'a', virtualPersonId: 'radiohost:a' } });

test('refresh runs the restricted preparation task once and stays bounded to one in-flight run', async () => {
  let release;
  let runs = 0;
  const pool = new WarmPoolService({ disabled: false, getActiveDemand: prewarmDemand,
    prepare: () => { runs += 1; return new Promise(resolve => { release = resolve; }); } });
  const first = pool.refresh();
  assert.equal((await pool.refresh()).skipped, 'already-preparing', '同一需求不并发第二个预热任务');
  release({ ok: true, preparedId: 'prepared:1', offerId: 'offer:1' });
  assert.deepEqual(await first, { ok: true, preparedId: 'prepared:1', offerId: 'offer:1' });
  assert.equal(runs, 1);
  assert.equal(pool.stats.selectionCalls, 1);
  assert.equal(pool.stats.modelCalls, 1, '一次受限任务 = 一次模型任务');
  assert.equal(pool.stats.generated, 1);
  pool.shutdown();
});

test('prewarm refresh needs demand and reports an honest failure without effects', async () => {
  let demand = null;
  const pool = new WarmPoolService({ disabled: false, getActiveDemand: () => demand,
    prepare: async () => ({ ok: false, code: 'NO_MATCHING_CANDIDATES' }) });
  assert.equal((await pool.refresh()).skipped, 'no-active-demand');
  demand = prewarmDemand();
  const failed = await pool.refresh();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'NO_MATCHING_CANDIDATES');
  assert.equal(pool.stats.failures, 1);
  assert.equal(pool.stats.generated, 0);
  pool.shutdown();
});

test('a prewarm already covered by a fresh hold or an in-flight task is a skip, not a failure', async () => {
  let code = 'PREPARATION_ALREADY_HELD';
  const pool = new WarmPoolService({ disabled: false, getActiveDemand: prewarmDemand,
    prepare: async () => (code === 'PREPARATION_ALREADY_HELD'
      ? { ok: false, code, preparedId: 'prepared:held' } : { ok: false, code }) });
  assert.deepEqual(await pool.refresh(), { skipped: 'already-held', preparedId: 'prepared:held' });
  code = 'PREPARATION_IN_FLIGHT';
  assert.deepEqual(await pool.refresh(), { skipped: 'already-preparing' });
  assert.equal(pool.stats.failures, 0, '去重/在跑不是失败');
  assert.equal(pool.stats.generated, 0);
  pool.shutdown();
});

test('pool.invalidate() aborts an in-flight prewarm and invalidates unadopted batches', async () => {
  let signal = null;
  const invalidations = [];
  const pool = new WarmPoolService({ disabled: false, getActiveDemand: prewarmDemand,
    prepare: ({ signal: taskSignal }) => { signal = taskSignal; return new Promise(() => {}); } });
  pool.attachPreparedSource({ stats: () => ({ prepared: 2, consumed: 0 }), invalidate: options => invalidations.push(options) });
  void pool.refresh();
  assert.ok(signal, '预热任务带取消信号');
  pool.invalidate();
  assert.equal(signal.aborted, true, '记忆/标签/曲库变化立即取消在跑的预热');
  assert.deepEqual(invalidations, [{ sessionId: null }]);
  const snapshot = pool.getStatusSnapshot();
  assert.equal(snapshot.stats.prepared.prepared, 2, '预热统计并入既有 status 形状');
  assert.equal(snapshot.preparingConversationId, 'a');
  pool.shutdown();
});

test('a prepare-only pool is enabled without a legacy candidate select', async () => {
  let runs = 0;
  const pool = await new WarmPoolService({ disabled: false, intervalMin: 0, getActiveDemand: prewarmDemand,
    prepare: async () => { runs += 1; return { ok: true, preparedId: 'prepared:x' }; } }).initialize();
  assert.equal(pool.timer, null, 'intervalMin=0 不建定时器（权威触发点不在定时器上）');
  await pool.refresh();
  assert.equal(runs, 1);
  pool.shutdown();
});
