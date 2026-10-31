import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibraryStore } from './libraryStore.js';

const COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000001bkv9c0gpIvm.jpg';

async function tempLibrary(artworkStore) {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-library-artwork-'));
  const store = new LibraryStore({ dbPath: join(dir, 'state.db'), now: () => 1000, artworkStore }).initialize();
  return { store, dir, close: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('importing a playlist seeds the covers the provider already supplied', async () => {
  const seeded = [];
  const ctx = await tempLibrary(() => ({ seed: (provider, tracks) => { seeded.push({ provider, tracks }); } }));
  try {
    ctx.store.ensureSource('qq', 'U');
    ctx.store.reconcilePlaylistSet('qq', 'U', [{ id: 'p1', name: '侧耳倾听', trackCount: 2 }], { complete: true });
    ctx.store.reconcileTracks('qq', 'U', { id: 'p1', name: '侧耳倾听', trackCount: 2 }, [
      { song_id: 'A', title: 'Moon River', artist: '曹思义', pic_url: COVER },
      { song_id: 'B', title: 'No cover', artist: 'X' },
    ], { complete: true });
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].provider, 'qq');
    assert.deepEqual(seeded[0].tracks.map(track => track.song_id), ['A', 'B']);
    // 曲库表结构保持不变：封面不进 library_tracks。
    const columns = ctx.store.db.prepare(`PRAGMA table_info(library_tracks)`).all().map(row => row.name);
    assert.equal(columns.includes('artwork'), false);
    assert.equal(columns.includes('pic_url'), false);
  } finally { await ctx.close(); }
});

test('a failing artwork seed never fails the import itself', async () => {
  const ctx = await tempLibrary(() => { throw new Error('artwork db unavailable'); });
  try {
    ctx.store.ensureSource('qq', 'U');
    ctx.store.reconcilePlaylistSet('qq', 'U', [{ id: 'p1', name: 'L', trackCount: 1 }], { complete: true });
    const rows = ctx.store.reconcileTracks('qq', 'U', { id: 'p1', name: 'L', trackCount: 1 }, [
      { song_id: 'A', title: 'T', artist: 'A' },
    ], { complete: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].song_id, 'A');
  } finally { await ctx.close(); }
});
