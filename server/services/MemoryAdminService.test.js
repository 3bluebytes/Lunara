import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryAdminService } from './MemoryAdminService.js';

function fixture() {
  const calls = [];
  const memory = {
    namespace: 'radiohost:radiohost-1',
    stats: () => ({ working: 1, episodic: 2, semantic: 3 }),
    searchMemory: () => [{ createdAt: Date.UTC(2026, 7, 10) }],
  };
  const station = {
    listRadioHosts: () => [{ id: 'radiohost-1', name: 'Nono' }],
    getRadioHostMemoryService: async id => { calls.push(['memory', id]); return memory; },
    getRadiohostMetadata: id => id === 'radiohost-1' ? { id, name: 'Nono' } : null,
    stationStats: () => ({ semantic: 4 }),
    getActiveRadiohost: () => ({ id: 'radiohost-1' }),
    getRadiohostRegistrySummary: () => [{ id: 'radiohost-1', name: 'Nono' }],
    getStationMemory: input => { calls.push(['station.list', input]); return [{ id: 'm1' }]; },
    addStationMemory: (...args) => { calls.push(['station.add', ...args]); return { ok: true, id: 'm2' }; },
    stationMemory: { id: 'station-memory' },
  };
  const service = new MemoryAdminService({
    getStation: () => station,
    now: () => Date.UTC(2026, 7, 12),
    generateDailySummary: async input => { calls.push(['summary', input.date]); return { id: 'sum-1' }; },
    consolidateStation: input => { calls.push(['consolidate', input.id]); return { promoted: 1, merged: 0, pruned: 0 }; },
    env: { MEMORY_CONSOLIDATION_AUTO: '1', MEMORY_SUMMARY_AUTO: '0' },
  });
  return { service, calls };
}

test('memory status exposes per-radiohost memory counts without leaking stores to routes', async () => {
  const { service } = fixture();
  const status = await service.status();
  assert.equal(status.enabled, true);
  assert.equal(status.consolidationAuto, true);
  assert.equal(status.summaryAuto, false);
  assert.deepEqual(status.radiohosts[0], {
    id: 'radiohost-1',
    name: 'Nono',
    namespace: 'radiohost:radiohost-1',
    counts: { working: 1, episodic: 2, semantic: 3 },
    oldestAgeDays: 2,
  });
});

test('summary, station reads, writes, and consolidation are delegated through one service', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.summarize({ radiohostId: 'radiohost-1', date: '2026-08-11' }), {
    ok: true,
    results: [{ radiohostId: 'radiohost-1', date: '2026-08-11', written: true, memoryId: 'sum-1' }],
  });
  assert.deepEqual(await service.stationStatus(), {
    ok: true,
    stationMemory: { semantic: 4 },
    activeRadiohost: { id: 'radiohost-1' },
    radiohostCount: 1,
    radiohosts: [{ id: 'radiohost-1', name: 'Nono' }],
  });
  assert.deepEqual(await service.listStationMemory({ type: 'episodic', limit: '5' }), {
    ok: true, memories: [{ id: 'm1', evidence: {} }],
  });
  assert.deepEqual(await service.addStationMemory({ content: 'likes rain', source: 'user', tags: ['taste'] }), {
    ok: true, id: 'm2',
  });
  assert.deepEqual(await service.consolidateStation(), {
    ok: true, promoted: 1, merged: 0, pruned: 0,
  });
  assert.deepEqual(calls.filter(call => call[0] !== 'memory'), [
    ['summary', '2026-08-11'],
    ['station.list', { type: 'episodic', limit: 5 }],
    ['station.add', 'likes rain', 'user', ['taste']],
    ['consolidate', 'station-memory'],
  ]);
});

test('station memory write validates content in the service boundary', () => {
  const { service } = fixture();
  assert.throws(() => service.addStationMemory({}), error => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});
