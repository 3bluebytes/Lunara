import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LibraryStore } from './libraryStore.js';
import { LibrarySyncCoordinator } from './librarySync.js';

const dir = mkdtempSync(resolve(tmpdir(), 'lunara-library-sync-'));
const store = new LibraryStore({ dbPath: resolve(dir, 'state.db') }).initialize();
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}

const state = {
  uid: { ncm: 'U', qq: null },
  playlists: { items: [], complete: true, reportedCount: 0, fetchedCount: 0, error: null },
  tracks: new Map(),
  playlistCalls: 0,
  trackCalls: [],
  delay: null,
};
const adapters = {
  async resolveAccountIdentity(provider) {
    const accountUid = state.uid[provider];
    return { provider, accountUid, error: accountUid ? null : 'not logged in' };
  },
  async fetchPlaylistsSnapshot() {
    state.playlistCalls += 1;
    if (state.delay) await state.delay;
    return structuredClone(state.playlists);
  },
  async fetchPlaylistTracksSnapshot(_provider, playlist) {
    state.trackCalls.push(String(playlist.id));
    const value = state.tracks.get(String(playlist.id));
    if (value instanceof Error) throw value;
    return structuredClone(value || { items: [], complete: true, reportedCount: 0, fetchedCount: 0, error: null });
  },
};
const tasteRequests = [];
const tasteBootstrap = {
  recoverStaleRuns: () => 0,
  request(provider, accountUid, { reason }) {
    tasteRequests.push({ provider, accountUid, reason, sourceState: store.getSource(provider, accountUid)?.import_status });
    return { promise: Promise.resolve() };
  },
};
const coordinator = new LibrarySyncCoordinator({ store, adapters, tasteBootstrap });

function playlist(id, name, trackCount) {
  return { id, name, trackCount };
}
function snapshot(items, complete = true, error = null, reportedCount = items.length) {
  return { items, complete, reportedCount, fetchedCount: items.length, error };
}

console.log('\n--- identity matrix and partial import recovery ---');
const missing = await coordinator.discover('qq', { trigger: 'startup' });
assert(missing.skipped === 'no-verified-uid' && store.listSources().length === 0, 'invalid identity creates no source');

state.playlists = snapshot([playlist('good', 'Good', 1), playlist('bad', 'Bad', 2)]);
state.tracks.set('good', snapshot([{ song_id: 'a', title: 'A', artist: 'X' }]));
state.tracks.set('bad', snapshot([{ song_id: 'b', title: 'B', artist: 'Y' }], false, 'truncated', 2));
const first = await coordinator.discover('ncm', { trigger: 'startup' });
await first.promise;
let source = store.getSource('ncm', 'U');
assert(source.import_status === 'partial' && source.first_imported_at == null, 'one incomplete playlist leaves first import partial');
assert(store.activeMembershipCount('ncm', 'U', 'good') === 1, 'successful playlist commits despite another failure');
assert(store.activeMembershipCount('ncm', 'U', 'bad') === 1, 'incomplete playlist applies observed additive rows');
assert(tasteRequests.length === 0, 'partial import never starts taste enrichment');

state.tracks.set('bad', snapshot([
  { song_id: 'b', title: 'B', artist: 'Y' },
  { song_id: 'c', title: 'C', artist: 'Z' },
]));
const resumed = await coordinator.discover('ncm', { trigger: 'cookie' });
await resumed.promise;
source = store.getSource('ncm', 'U');
assert(source.import_status === 'complete' && source.first_imported_at != null, 're-login resumes partial import to complete');
assert(tasteRequests[0]?.sourceState === 'complete' && tasteRequests[0]?.reason === 'import-complete', 'taste bootstrap is requested only after complete import commit');
const firstImportedAt = source.first_imported_at;
const relogin = await coordinator.discover('ncm', { trigger: 'cookie' });
assert(relogin.skipped === 'already-imported', 're-login after complete import does not repeat full import');
assert(store.getSource('ncm', 'U').first_imported_at === firstImportedAt, 'completed import timestamp remains stable');

console.log('\n--- stale run and non-overlap guard ---');
store.setSourceState('ncm', 'U', { import_status: 'importing', run_started_at: 1 });
const stale = await coordinator.discover('ncm', { trigger: 'startup' });
await stale.promise;
assert(store.getSource('ncm', 'U').import_status === 'complete', 'persisted importing without live run is resumed');

let release;
state.delay = new Promise(resolveDelay => { release = resolveDelay; });
store.setSourceState('ncm', 'U', { import_status: 'partial' });
const manual = coordinator.startImport('ncm', 'U', { trigger: 'manual' });
const cron = coordinator.startSync('ncm', 'U', { trigger: 'periodic' });
assert(manual.accepted && cron.joined && manual.promise === cron.promise, 'manual and cron triggers coalesce to one source run');
release();
await manual.promise;
state.delay = null;

console.log('\n--- periodic count gate, weekly swap, rename and deletion ---');
await coordinator.resolveCurrent('ncm');
state.trackCalls.length = 0;
state.playlists = snapshot([playlist('good', 'Good renamed', 1), playlist('bad', 'Bad', 2)]);
let periodic = await coordinator.runSync('ncm', 'U', { weekly: false });
assert(periodic.fetched === 0 && periodic.skippedByCount === 2, 'periodic sync skips track fetch when counts match');
assert(store.listActivePlaylists('ncm', 'U').find(row => row.playlist_id === 'good').playlist_name === 'Good renamed', 'playlist rename refreshes provenance');

state.tracks.set('good', snapshot([{ song_id: 'replacement', title: 'R', artist: 'X' }]));
state.trackCalls.length = 0;
const weekly = await coordinator.runSync('ncm', 'U', { weekly: true });
assert(weekly.fetched === 2 && state.trackCalls.includes('good'), 'weekly pass bypasses count gate');
assert(store.activeMembershipCount('ncm', 'U', 'good') === 1, 'same-count replacement retains one active membership');
const old = store.db.prepare(`SELECT removed_at FROM library_tracks WHERE provider='ncm' AND account_uid='U' AND playlist_id='good' AND song_id='a'`).get();
const replacement = store.db.prepare(`SELECT removed_at FROM library_tracks WHERE provider='ncm' AND account_uid='U' AND playlist_id='good' AND song_id='replacement'`).get();
assert(old.removed_at != null && replacement.removed_at == null, 'weekly snapshot applies remove and add sides of swap');

state.playlists = snapshot([playlist('good', 'Good renamed', 1)]);
await coordinator.runSync('ncm', 'U', { weekly: false });
assert(!store.listActivePlaylists('ncm', 'U').some(row => row.playlist_id === 'bad'), 'complete playlist set tombstones deleted playlist');
state.playlists = snapshot([playlist('good', 'Good renamed', 1), playlist('bad', 'Bad restored', 2)]);
await coordinator.runSync('ncm', 'U', { weekly: true });
assert(store.listActivePlaylists('ncm', 'U').some(row => row.playlist_id === 'bad'), 'returning playlist is revived');

console.log('\n--- incomplete snapshots are non-destructive and sync health is independent ---');
const tasteBeforePartial = tasteRequests.length;
const beforeBad = store.activeMembershipCount('ncm', 'U', 'bad');
state.playlists = snapshot([playlist('good', 'Good renamed', 1)], false, 'playlist timeout', 2);
state.tracks.set('good', snapshot([], false, 'track timeout', 1));
await coordinator.runSync('ncm', 'U', { weekly: true });
source = store.getSource('ncm', 'U');
assert(source.import_status === 'complete' && source.last_sync_status === 'partial', 'failed later sync does not regress complete import');
assert(store.listActivePlaylists('ncm', 'U').some(row => row.playlist_id === 'bad'), 'incomplete playlist list cannot delete unobserved playlist');
assert(store.activeMembershipCount('ncm', 'U', 'bad') === beforeBad, 'incomplete snapshot does not reduce active membership counts');
assert(tasteRequests.length === tasteBeforePartial, 'partial sync keeps last usable prior and does not request refresh');

console.log('\n--- account switch preserves history and only current UID syncs ---');
state.uid.ncm = 'V';
state.playlists = snapshot([]);
const switched = await coordinator.discover('ncm', { trigger: 'cookie' });
await switched.promise;
assert(store.getSource('ncm', 'V')?.import_status === 'complete', 'new UID receives an independent source');
const oldCount = store.sourceStatus('ncm', 'U').active_memberships;
const oldSync = await coordinator.runSync('ncm', 'U', { weekly: true });
assert(oldSync.skipped === 'not-current-account', 'old account is not network-synced while another UID is current');
assert(store.sourceStatus('ncm', 'U').active_memberships === oldCount, 'old account history remains unchanged');

store.close();
console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
