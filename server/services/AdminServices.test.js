import assert from 'node:assert/strict';
import test from 'node:test';

import { WarmPoolAdminService } from './WarmPoolAdminService.js';
import { ReflectionAdminService } from './ReflectionAdminService.js';
import { LibraryAdminService } from './LibraryAdminService.js';
import { SongTagAdminService, sanitizeTagPatch } from './SongTagAdminService.js';
import { TasteAdminService } from './TasteAdminService.js';

test('warm-pool admin refreshes only the current listening demand', async () => {
  const calls = [];
  const pool = {
    getStatusSnapshot: () => ({ enabled: true, sets: 2 }),
    refresh: async id => { calls.push(id); },
  };
  const station = {
    getWarmPoolService: () => pool,
    listRadioHosts: () => [{ id: 'a' }, { id: 'b' }],
  };
  const service = new WarmPoolAdminService({ getStation: () => station });
  assert.deepEqual(service.status(), { enabled: true, sets: 2 });
  assert.deepEqual(await service.refresh({}), { ok: true });
  assert.deepEqual(calls, [undefined]);
});

test('reflection admin validates requests and returns bounded cross-radiohost insights', async () => {
  const reflection = {
    getStatusSnapshot: () => ({ enabled: true }),
    isInflight: () => false,
    runManual: async () => ({ id: 'new' }),
  };
  const memory = {
    namespace: 'radiohost:a',
    searchMemory: () => [{
      id: 'i1', tags: 'reflection-insight,reflection-short', confidence: 0.8,
      createdAt: 5, content: '用户学习时偏好轻声人声',
    }],
  };
  const station = {
    getReflectionAgent: () => reflection,
    listRadioHosts: () => [{ id: 'a' }],
    getRadioHostMemoryService: async () => memory,
    getRadiohostMetadata: id => id === 'a' ? { id } : null,
  };
  const service = new ReflectionAdminService({ getStation: () => station, logger: null });
  const status = await service.status();
  assert.equal(status.recentInsights[0].window, 'short');
  await assert.rejects(service.run({ radiohostId: 'a', window: 'bad' }), error => error.statusCode === 400);
  assert.deepEqual(await service.run({ radiohostId: 'a', window: 'short' }), {
    ok: true, ran: true, insight: { id: 'new' },
  });
});

test('library admin preserves the logged-out empty candidate shape', async () => {
  const service = new LibraryAdminService({
    providers: {
      ncm: { loginStatus: async () => ({ loggedIn: false }) },
      qq: { loginStatus: async () => ({ loggedIn: false }) },
    },
    candidates: {},
    state: {},
  });
  assert.deepEqual(await service.snapshot(), {
    ok: true,
    candidates: [],
    counts: { ncm: { liked: 0, playlist: 0, daily: 0 }, qq: { liked: 0, playlist: 0, daily: 0 } },
    loggedIn: { ncm: false, qq: false },
    primarySource: 'qq',
    cachedAt: 0,
  });
});

test('song-tag inspector lists, updates and removes rows through the store', async () => {
  const store = {
    listTags: input => ({ items: [{ song_id: 'a', source: 'llm' }], total: 1, ...input }),
    patchTags: (songId, patch, provider) => ({ songId, patch, provider, source: patch.source }),
    deleteTags: (songId, provider) => (songId === 'gone' ? 1 : 0),
  };
  const service = new SongTagAdminService({ getStore: () => store });

  const list = service.list({ search: 'eason', limit: '50', offset: '10' });
  assert.equal(list.ok, true);
  assert.equal(list.total, 1);
  assert.equal(list.search, 'eason');

  const updated = service.update({ provider: 'NCM', songId: ' a ', patch: {
    language: 'Cantonese ', energy: '0.8', has_vocal: 'true', tempo: 'slow',
    themes: ' 夜晚, 雨 ', year: '1998', confidence: 0.1, title: 'hack',
  } });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.tags.patch, {
    language: 'Cantonese', energy: 0.8, has_vocal: true, tempo: 'slow',
    themes: ['夜晚', '雨'], year: 1998,
    source: 'user', confidence: 1, source_text: '手动修改',
  }, 'whitelist survives, provenance is forced, non-editable fields are dropped');
  assert.equal(updated.tags.source, 'user', 'manual edit is marked authoritative');
  assert.equal(updated.tags.provider, 'ncm');

  assert.deepEqual(service.remove({ provider: 'qq', songId: 'gone' }), { ok: true, deleted: 1 });
  assert.deepEqual(service.remove({ provider: 'qq', songId: 'absent' }), { ok: true, deleted: 0 });
});

test('song-tag inspector rejects invalid identities and patches with a client error', () => {
  const service = new SongTagAdminService({ getStore: () => ({}) });
  const badIdentity = [{ songId: 'a' }, { provider: 'spotify', songId: 'a' }, { provider: 'ncm' }, {}];
  for (const input of badIdentity) {
    let thrown = null;
    try { service.update(input); } catch (error) { thrown = error; }
    assert.equal(thrown?.statusCode, 400, `identity rejected: ${JSON.stringify(input)}`);
    try { service.remove(input); } catch (error) { thrown = error; }
    assert.equal(thrown?.statusCode, 400, 'remove validates identity too');
  }

  const badPatches = [
    { energy: 7 }, { energy: 'abc' }, { tempo: 'waltz' }, { has_vocal: 'maybe' },
    { year: 'nineties' }, { themes: Array(20).fill('x') },
    { mood: 'x'.repeat(80) }, {}, { confidence: 1 },
  ];
  for (const patch of badPatches) {
    let thrown = null;
    try { sanitizeTagPatch(patch); } catch (error) { thrown = error; }
    assert.equal(thrown?.statusCode, 400, `patch rejected: ${JSON.stringify(patch)}`);
  }

  const clean = sanitizeTagPatch({ mood: '', energy: null, tempo: '', themes: [], instruments: ['', '  '], scenes: 'a,b' });
  assert.deepEqual(clean, { mood: null, energy: null, tempo: null, themes: null, instruments: null, scenes: ['a', 'b'] },
    'empty values clear fields, strings split into lists');
});

test('song-tag admin computes candidate coverage and delegates backfill', async () => {
  const savedPatches = [];
  const tags = new Map([
    ['a', { confidence: 0.8 }],
    ['b', { confidence: 0 }],
  ]);
  const service = new SongTagAdminService({
    getStore: () => ({ stats: () => ({ total: 2 }), getTags: id => tags.get(id) }),
    getCandidates: () => [{ song_id: 'a' }, { song_id: 'b' }, { song_id: 'c' }],
    getQueueStats: () => ({ pending: 0 }),
    providers: {
      ncm: { loginStatus: async () => ({ loggedIn: false }) },
      qq: { loginStatus: async () => ({ loggedIn: false }) },
    },
    runBackfill: async input => ({ processed: 4, ...input }),
    env: {},
    activeModel: async () => ({ providerId: 'p1', model: 'deepseek/deepseek-flash' }),
    autoEnabled: () => true,
    configStore: { save: patch => { savedPatches.push(patch); } },
  });
  const status = await service.status();
  assert.deepEqual(status.coverage, { tagged: 1, placeholders: 1, untagged: 1, pct: 33 });
  assert.deepEqual(status.activeModel, { providerId: 'p1', model: 'deepseek/deepseek-flash' });
  assert.equal(status.auto, true);
  assert.equal((await service.backfill({ force: true })).processed, 4);
  const view = await service.config();
  assert.deepEqual(view, { ok: true, auto: true }, '打标配置只剩 auto 开关');
  await service.saveConfig({ auto: false });
  assert.deepEqual(savedPatches, [{ auto: false }]);
});

test('song-tag admin reports a missing endpoint honestly and keeps auto off by default', async () => {
  const service = new SongTagAdminService({
    getStore: () => ({ stats: () => ({ total: 0 }), getTags: () => null }),
    getCandidates: () => [],
    getQueueStats: () => ({ pending: 0 }),
    providers: {},
    runBackfill: async () => ({}),
    env: {},
    activeModel: async () => null,
    autoEnabled: () => false,
  });
  const status = await service.status();
  assert.equal(status.activeModel, null);
  assert.equal(status.model, null);
  assert.equal(status.auto, false);
});

test('taste admin bounds history and exposes profile files through one service', async () => {
  const service = new TasteAdminService({
    consolidator: { runConsolidation: async input => input, isRunning: () => false },
    state: {
      recentConsolidations: limit => [limit],
      lastConsolidation: () => ({ finished_at: 9, summary: 'ok' }),
      lastConsolidationAt: () => 8,
      playsCountSince: since => since + 2,
      loadPlan: key => ({ key }),
    },
    readText: async path => path.endsWith('taste.md') ? '# taste' : '',
    root: '/repo',
    environmentSnapshot: async () => ({ slot: 'night' }),
    now: () => new Date('2026-08-12T12:00:00Z'),
  });
  assert.deepEqual(service.log({ limit: 1000 }), { ok: true, log: [50] });
  assert.equal((await service.profile()).taste, '# taste');
  assert.deepEqual(service.today(), { date: '2026-08-12', plan: { key: '2026-08-12' } });
});

test('taste profile prefers the db schema record and labels the fallback', async () => {
  const base = {
    consolidator: { runConsolidation: async input => input, isRunning: () => false },
    state: { recentConsolidations: () => [], lastConsolidation: () => null, lastConsolidationAt: () => 0, playsCountSince: () => 0, loadPlan: () => null },
    readText: async path => path.endsWith('taste.md') ? '# taste' : '',
    root: '/repo',
    environmentSnapshot: async () => ({}),
  };
  const withSchema = new TasteAdminService({ ...base,
    getSchema: async () => [{ personId: 'lunara', memoryId: 7, content: '# DB 图式', revision: 3, source: 'db-schema' }] });
  const schemaProfile = await withSchema.profile();
  assert.equal(schemaProfile.taste, '# DB 图式');
  assert.equal(schemaProfile.tasteSource, 'db-schema');
  assert.equal(schemaProfile.schemas.length, 1);
  const fallback = new TasteAdminService({ ...base, getSchema: async () => [] });
  assert.equal((await fallback.profile()).taste, '# taste');
  assert.equal((await fallback.profile()).tasteSource, 'legacy-file');
});
