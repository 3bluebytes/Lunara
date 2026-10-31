import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTWORK_STATE, MAX_ARTWORK_URL_LENGTH, TrackArtworkStore, normalizeArtworkUrl,
} from './trackArtworkStore.js';

const COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000001bkv9c0gpIvm.jpg';

async function tempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-track-artwork-'));
  const dbPath = join(dir, 'state.db');
  const store = new TrackArtworkStore({ dbPath, now: () => 1234, ...options }).initialize();
  return { store, dbPath, dir, close: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('the artwork table is created idempotently and never altered per restart', async () => {
  const first = await tempStore();
  try {
    first.store.put({ provider: 'qq', songId: 'A', artwork: COVER });
    const again = new TrackArtworkStore({ dbPath: first.dbPath, now: () => 5678 }).initialize();
    try {
      assert.equal(again.peek('qq', 'A'), COVER);
      const tables = again.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(row => row.name);
      assert.ok(tables.includes('track_artwork'));
    } finally { again.close(); }
  } finally { await first.close(); }
});

test('a resolved cover is served from the persistent table without any provider lookup', async () => {
  let lookups = 0;
  const ctx = await tempStore({ lookup: async () => { lookups += 1; return { state: ARTWORK_STATE.RESOLVED, artwork: COVER }; } });
  try {
    assert.equal(await ctx.store.resolve('qq', 'A'), COVER);
    assert.equal(lookups, 1);
    // 新进程：内存为空，但表里有值。
    const restarted = new TrackArtworkStore({ dbPath: ctx.dbPath, lookup: async () => { lookups += 1; return null; } }).initialize();
    try {
      assert.equal(await restarted.resolve('qq', 'A'), COVER);
      assert.equal(lookups, 1, 'second resolve must not hit the provider');
    } finally { restarted.close(); }
  } finally { await ctx.close(); }
});

test('confirmed absence is remembered and never re-queried', async () => {
  let lookups = 0;
  const ctx = await tempStore({ lookup: async () => { lookups += 1; return { state: ARTWORK_STATE.ABSENT, artwork: null }; } });
  try {
    assert.equal(await ctx.store.resolve('qq', 'B'), null);
    assert.equal(lookups, 1);
    assert.equal(ctx.store.peek('qq', 'B'), null);
    assert.equal(ctx.store.read('qq', 'B').state, ARTWORK_STATE.ABSENT);
    assert.equal(await ctx.store.resolve('qq', 'B'), null);
    assert.equal(lookups, 1, 'absent must not trigger another provider query');
  } finally { await ctx.close(); }
});

test('absence is a cache entry, not a permanent denial', async () => {
  const ctx = await tempStore({ lookup: async () => ({ state: ARTWORK_STATE.ABSENT }) });
  try {
    await ctx.store.resolve('qq', 'C');
    assert.equal(ctx.store.read('qq', 'C').state, ARTWORK_STATE.ABSENT);
    assert.equal(ctx.store.put({ provider: 'qq', songId: 'C', artwork: COVER }), COVER);
    assert.equal(ctx.store.read('qq', 'C').state, ARTWORK_STATE.RESOLVED);
    assert.equal(await ctx.store.resolve('qq', 'C'), COVER);
  } finally { await ctx.close(); }
});

test('query failures are not recorded as absence', async () => {
  for (const lookup of [
    async () => { throw new Error('network down'); },
    async () => null,
    async () => ({ state: ARTWORK_STATE.RESOLVED, artwork: 'not-a-url' }),
  ]) {
    const ctx = await tempStore({ lookup });
    try {
      assert.equal(await ctx.store.resolve('qq', 'D'), null);
      assert.equal(ctx.store.read('qq', 'D'), null, '失败不得写 absent');
    } finally { await ctx.close(); }
  }
});

test('a hanging provider query is bounded and leaves no row', async () => {
  const ctx = await tempStore({ timeoutMs: 30, lookup: () => new Promise(() => {}) });
  try {
    const started = Date.now();
    assert.equal(await ctx.store.resolve('qq', 'E'), null);
    assert.ok(Date.now() - started < 2000, 'lookup must be bounded');
    assert.equal(ctx.store.read('qq', 'E'), null);
  } finally { await ctx.close(); }
});

test('invalid artwork values are never stored', async () => {
  const ctx = await tempStore();
  try {
    assert.equal(ctx.store.put({ provider: 'qq', songId: 'F', artwork: 'javascript:alert(1)' }), null);
    assert.equal(ctx.store.put({ provider: 'qq', songId: 'F', artwork: `https://a/${'x'.repeat(MAX_ARTWORK_URL_LENGTH)}` }), null);
    assert.equal(ctx.store.put({ provider: '', songId: 'F', artwork: COVER }), null);
    assert.equal(ctx.store.put({ provider: 'qq', songId: '', artwork: COVER }), null);
    assert.equal(ctx.store.peek('qq', 'F'), null);
    assert.equal(normalizeArtworkUrl(`  ${COVER}  `), COVER);
  } finally { await ctx.close(); }
});

test('import seeding stores provider-supplied covers without a lookup', async () => {
  let lookups = 0;
  const ctx = await tempStore({ lookup: async () => { lookups += 1; return null; } });
  try {
    const written = ctx.store.seed('qq', [
      { song_id: 'G', pic_url: COVER },
      { song_id: 'H', artwork: '' },
      { song_id: 'I' },
      { pic_url: COVER },
    ]);
    assert.equal(written, 1);
    assert.equal(ctx.store.peek('qq', 'G'), COVER);
    assert.equal(lookups, 0);
  } finally { await ctx.close(); }
});

test('concurrent resolves for the same identity share one provider query', async () => {
  let lookups = 0;
  const ctx = await tempStore({
    lookup: async () => { lookups += 1; await new Promise(resolve => setTimeout(resolve, 10)); return { state: ARTWORK_STATE.RESOLVED, artwork: COVER }; },
  });
  try {
    const results = await Promise.all([
      ctx.store.resolve('qq', 'J'), ctx.store.resolve('qq', 'J'), ctx.store.resolve('qq', 'J'),
    ]);
    assert.deepEqual(results, [COVER, COVER, COVER]);
    assert.equal(lookups, 1);
  } finally { await ctx.close(); }
});
