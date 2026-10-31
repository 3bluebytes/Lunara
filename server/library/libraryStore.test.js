import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LibraryStore } from './libraryStore.js';
import { dedupKey } from './dedupKey.js';

const dir = mkdtempSync(resolve(tmpdir(), 'lunara-library-store-'));
let clock = 1_000;
const store = new LibraryStore({ dbPath: resolve(dir, 'state.db'), now: () => ++clock }).initialize();
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}

console.log('\n--- schema and account isolation ---');
const tables = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(row => row.name);
for (const name of ['library_sources', 'library_playlists', 'library_tracks']) {
  assert(tables.includes(name), `${name} exists`);
}
const indexes = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all().map(row => row.name);
for (const name of ['idx_library_playlists_active', 'idx_library_tracks_song', 'idx_library_tracks_dedup', 'idx_library_tracks_playlist_active']) {
  assert(indexes.includes(name), `${name} exists`);
}

store.ensureSource('ncm', 'U');
store.ensureSource('ncm', 'V');
store.reconcilePlaylistSet('ncm', 'U', [{ id: 'p1', name: 'U-list', trackCount: 1 }], { complete: true });
store.reconcilePlaylistSet('ncm', 'V', [{ id: 'p1', name: 'V-list', trackCount: 1 }], { complete: true });
store.reconcileTracks('ncm', 'U', { id: 'p1', name: 'U-list', trackCount: 1 }, [{ song_id: 's1', title: 'Song', artist: 'A' }], { complete: true });
store.reconcileTracks('ncm', 'V', { id: 'p1', name: 'V-list', trackCount: 1 }, [{ song_id: 's2', title: 'Other', artist: 'B' }], { complete: true });
assert(store.sourceStatus('ncm', 'U').active_memberships === 1, 'account U owns one membership');
assert(store.sourceStatus('ncm', 'V').active_memberships === 1, 'account V owns one membership');

console.log('\n--- membership identity, fuzzy collision, and revive ---');
store.reconcilePlaylistSet('ncm', 'U', [
  { id: 'p1', name: 'One', trackCount: 1 },
  { id: 'p2', name: 'Two', trackCount: 1 },
  { id: 'p3', name: 'Three', trackCount: 1 },
], { complete: true });
for (const id of ['p1', 'p2', 'p3']) {
  store.reconcileTracks('ncm', 'U', { id, name: id, trackCount: 1 }, [
    { song_id: 'shared', title: 'Same (Live)', artist: 'Singer' },
  ], { complete: true });
}
assert(store.sourceStatus('ncm', 'U').active_memberships === 3, 'one song in three playlists remains three rows');

store.reconcileTracks('ncm', 'U', { id: 'p1', name: 'One', trackCount: 2 }, [
  { song_id: 'live', title: 'Song (Live)', artist: 'Singer' },
  { song_id: 'studio', title: 'Song Live', artist: 'Singer' },
], { complete: true });
const collisionRows = store.db.prepare(`
  SELECT song_id, dedup_key FROM library_tracks
  WHERE provider='ncm' AND account_uid='U' AND playlist_id='p1' AND removed_at IS NULL
`).all();
assert(collisionRows.length === 2, 'provider-native songs are not merged on fuzzy collision');
assert(dedupKey('Song (Live)', 'Singer') === dedupKey('Song Live', 'Singer'), 'test fixture really collides');

store.reconcileTracks('ncm', 'U', { id: 'p1', name: 'One', trackCount: 0 }, [], { complete: true });
assert(store.activeMembershipCount('ncm', 'U', 'p1') === 0, 'complete empty snapshot tombstones tracks');
const firstSeen = store.db.prepare(`SELECT first_seen_at FROM library_tracks WHERE provider='ncm' AND account_uid='U' AND playlist_id='p1' AND song_id='live'`).get().first_seen_at;
store.reconcileTracks('ncm', 'U', { id: 'p1', name: 'Renamed', trackCount: 1 }, [
  { song_id: 'live', title: 'Song (Live)', artist: 'Singer' },
], { complete: true });
const revived = store.db.prepare(`SELECT * FROM library_tracks WHERE provider='ncm' AND account_uid='U' AND playlist_id='p1' AND song_id='live'`).get();
assert(revived.removed_at == null && revived.first_seen_at === firstSeen, 'track revive preserves first_seen_at');

console.log('\n--- playlist atomic tombstone and incomplete additive behavior ---');
store.reconcilePlaylistSet('ncm', 'U', [{ id: 'p2', name: 'Two', trackCount: 1 }], { complete: false });
assert(store.listActivePlaylists('ncm', 'U').some(row => row.playlist_id === 'p3'), 'incomplete list does not tombstone missing playlist');
store.reconcilePlaylistSet('ncm', 'U', [{ id: 'p2', name: 'Two', trackCount: 1 }], { complete: true });
const removedPlaylist = store.db.prepare(`SELECT removed_at FROM library_playlists WHERE provider='ncm' AND account_uid='U' AND playlist_id='p3'`).get();
const removedMembership = store.db.prepare(`SELECT removed_at FROM library_tracks WHERE provider='ncm' AND account_uid='U' AND playlist_id='p3' AND song_id='shared'`).get();
assert(removedPlaylist.removed_at != null && removedMembership.removed_at === removedPlaylist.removed_at, 'playlist and memberships tombstone in one transaction/time');

store.reconcilePlaylistSet('ncm', 'U', [{ id: 'p3', name: 'Three restored', trackCount: 1 }], { complete: false });
store.reconcileTracks('ncm', 'U', { id: 'p3', name: 'Three restored', trackCount: 1 }, [{ song_id: 'shared', title: 'Same', artist: 'Singer' }], { complete: true });
assert(store.listActivePlaylists('ncm', 'U').some(row => row.playlist_id === 'p3'), 'playlist can be revived');

console.log('\n--- source state and counts ---');
store.beginRun('ncm', 'U', { kind: 'import' });
assert(store.getSource('ncm', 'U').import_status === 'importing', 'import and sync state are separate');
store.finishImport('ncm', 'U', { complete: true });
const importedAt = store.getSource('ncm', 'U').first_imported_at;
store.beginRun('ncm', 'U', { kind: 'sync' });
store.finishSync('ncm', 'U', { complete: false, error: 'partial' });
const source = store.getSource('ncm', 'U');
assert(source.import_status === 'complete' && source.last_sync_status === 'partial', 'later sync failure does not regress completed import');
store.finishImport('ncm', 'U', { complete: true, at: importedAt + 100 });
assert(store.getSource('ncm', 'U').first_imported_at === importedAt, 'first_imported_at is immutable after first complete import');
assert(store.listActiveSongs().some(row => row.provider === 'ncm' && row.song_id === 'shared'), 'active distinct provider/song query works');
store.reconcilePlaylistSet('ncm', 'U', [{ id: 'liked', name: '我喜欢的音乐', trackCount: 1 }], { complete: false });
store.reconcileTracks('ncm', 'U', { id: 'liked', name: '我喜欢的音乐', trackCount: 1 },
  [{ song_id: 'liked-song', title: 'Liked', artist: 'Familiar Artist' }], { complete: true });
assert(store.listLikedArtists().includes('Familiar Artist'), 'liked playlist artist is familiarity evidence');
assert(!store.listLikedArtists().includes('B'), 'ordinary imported playlist is not familiarity evidence');

store.setSourceState('ncm', 'V', { import_status: 'importing', run_started_at: 9 });
assert(store.recoverStaleRuns() === 1, 'stale persisted run is detected');
assert(store.getSource('ncm', 'V').import_status === 'partial' && store.getSource('ncm', 'V').run_started_at == null, 'stale import becomes resumable');

store.close();
console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
