import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { LibraryStore } from './libraryStore.js';
import { TasteBootstrapService, buildMetadataBaseline, rankCandidatesByTaste, selectRepresentativeSample } from './tasteBootstrap.js';

const dir = mkdtempSync(resolve(tmpdir(), 'lunara-taste-bootstrap-'));
let clock = 1_000;
const store = new LibraryStore({ dbPath: resolve(dir, 'state.db'), now: () => clock }).initialize();
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}

function seed(provider, uid, playlistCount, songsPerPlaylist) {
  const playlists = Array.from({ length: playlistCount }, (_, p) => ({
    id: `p${p}`, name: p === 0 ? '我喜欢的音乐' : `Playlist ${p}`, trackCount: songsPerPlaylist,
  }));
  store.reconcilePlaylistSet(provider, uid, playlists, { complete: true, at: clock++ });
  let index = 0;
  for (const playlist of playlists) {
    const tracks = Array.from({ length: songsPerPlaylist }, () => {
      const id = String(index++);
      return { song_id: id, title: `Song ${id}`, artist: `Artist ${Number(id) % 17}` };
    });
    store.reconcileTracks(provider, uid, playlist, tracks, { complete: true, at: clock++ });
  }
  store.finishImport(provider, uid, { complete: true, at: clock++ });
}

console.log('\n--- account-scoped storage and bounded JSON ---');
seed('ncm', 'U', 8, 100);
seed('ncm', 'V', 1, 1);
store.upsertTasteProfile('ncm', 'U', { profile_version: 'v1', profile: { marker: 'U' } });
store.upsertTasteProfile('ncm', 'V', { profile_version: 'v1', profile: { marker: 'V' } });
assert(store.getTasteProfile('ncm', 'U').profile.marker === 'U' && store.getTasteProfile('ncm', 'V').profile.marker === 'V',
  'same-provider accounts remain isolated');
// 账号归属不得被跨源「同一首歌」语义污染：同一 uid 在两个源上仍是两份独立画像。
store.upsertTasteProfile('qq', 'U', { profile_version: 'v1', profile: { marker: 'QQ-U' } });
assert(store.getTasteProfile('qq', 'U').profile.marker === 'QQ-U'
  && store.getTasteProfile('ncm', 'U').profile.marker === 'U',
  '同一账号在另一个源上是独立的画像，不被 recording 语义合并');
let rejected = false;
try { store.upsertTasteProfile('ncm', 'U', { profile_version: 'v1', profile: { value: 'x'.repeat(40_000) } }); } catch { rejected = true; }
assert(rejected, 'oversized profile JSON is rejected');

console.log('\n--- normalized metadata and deterministic representative sample ---');
const skewRows = [
  ...Array.from({ length: 100 }, (_, i) => ({ playlist_id: 'huge', playlist_name: 'Huge', song_id: `h${i}`, artist: 'Mega' })),
  { playlist_id: 'small', playlist_name: 'Small', song_id: 'indie', artist: 'Indie' },
];
const skew = buildMetadataBaseline(skewRows);
const mega = skew.artists.find(item => item.name === 'Mega')?.weight;
const indie = skew.artists.find(item => item.name === 'Indie')?.weight;
assert(mega === indie, 'one huge playlist cannot outweigh another playlist without bound');
const rows800 = store.listActiveMemberships('ncm', 'U').map(row => ({ ...row, provider: 'ncm' }));
const sampleA = selectRepresentativeSample(rows800, 40);
const sampleB = selectRepresentativeSample([...rows800].reverse(), 40);
assert(sampleA.length === 40, '800 songs produce only the default 40-song sample');
assert(selectRepresentativeSample(rows800, 999).length === 100, 'representative sample has a hard 100-song ceiling');
assert(JSON.stringify(sampleA) === JSON.stringify(sampleB), 'same library signature produces stable sample ordering');
assert(new Set(sampleA.flatMap(item => item.playlists)).size === 8, 'sample covers all playlists');

const rankingInput = [
  { source: 'ncm:daily', song_id: 'unknown', title: 'Unknown', artist: 'Other' },
  { source: 'ncm:daily', song_id: 'known', title: 'Known', artist: 'Artist 1' },
];
const ranking = rankCandidatesByTaste(rankingInput, {
  profiles: new Map([['ncm', { artists: [{ name: 'Artist 1', weight: 1 }] }]]),
  songTagStore: { getTags: () => null },
});
assert(ranking[0].song_id === 'known' && ranking.length === 2, 'prior soft-ranks a match without filtering unknown songs');
assert(rankCandidatesByTaste(rankingInput, {}).map(item => item.song_id).join(',') === 'unknown,known',
  'missing profile preserves original order');

console.log('\n--- async bootstrap, idempotency, enrichment and restart recovery ---');
const tagRows = new Map();
const songTagStore = {
  needsTagging: (id, provider) => !tagRows.has(`${provider}:${id}`),
  getTags: (id, provider) => tagRows.get(`${provider}:${id}`) || null,
};
const enqueued = [];
const projections = [];
const service = new TasteBootstrapService({
  store, songTagStore,
  enqueueTagging: song => { enqueued.push(song); return true; },
  projectProfile: value => { projections.push(value); },
  env: { SONG_TAG_AUTO: '1', TASTE_BOOTSTRAP_TAG_LIMIT: '40' },
  now: () => clock++,
});
const request = service.request('ncm', 'U');
assert(request.accepted && request.running, 'request returns before background bootstrap completes');
const result = await request.promise;
assert(result.sampleSize === 40 && result.enqueued === 40, 'bootstrap enqueues no more than persisted representative sample');
const repeated = service.request('ncm', 'U');
assert(repeated.skipped === 'fresh' && enqueued.length === 40, 'same version and signature is idempotent');
const firstSong = result.profile.representative_sample.items[0];
tagRows.set(`ncm:${firstSong.song_id}`, { confidence: 0.8, language: 'zh', genre: 'pop', energy: 0.7, valence: 0.7 });
await service.handleTagSettled({ provider: 'ncm', songId: firstSong.song_id });
assert(store.getTasteProfile('ncm', 'U').profile.coverage.taggedSongs === 1, 'settled sample tag incrementally refreshes prior');
assert(projections.length >= 2, 'profile projection refreshes without touching user preference files');

store.upsertTasteProfile('ncm', 'V', {
  profile_version: 'taste-profile-v1', bootstrap_status: 'running', enrichment_status: 'running',
  library_signature: store.librarySignature('ncm', 'V'), representative_sample: { items: [] },
  started_at: 1, updated_at: 1,
});
clock += 20 * 60 * 1000;
assert(service.recoverStaleRuns() === 1, 'restart recovery detects stale taste run');
assert(store.getTasteProfile('ncm', 'V').bootstrap_status === 'pending', 'stale run keeps persisted sample and becomes resumable');

const beforeDisabled = enqueued.length;
const disabledService = new TasteBootstrapService({
  store, songTagStore, enqueueTagging: song => { enqueued.push(song); return true; },
  env: { SONG_TAG_AUTO: '0' }, now: () => clock++,
});
await disabledService.request('ncm', 'V', { reason: 'llm-disabled' }).promise;
assert(store.getTasteProfile('ncm', 'V').bootstrap_status === 'complete' && enqueued.length === beforeDisabled,
  'LLM-disabled bootstrap still completes metadata baseline with zero enqueue');

const p0 = store.listActiveMemberships('ncm', 'U').filter(row => row.playlist_id === 'p0');
store.reconcileTracks('ncm', 'U', { id: 'p0', name: '我喜欢的音乐', trackCount: p0.length + 1 }, [
  ...p0.map(row => ({ song_id: row.song_id, title: row.title, artist: row.artist })),
  { song_id: 'new-after-sync', title: 'New', artist: 'New Artist' },
], { complete: true, at: clock++ });
const refreshed = service.request('ncm', 'U', { reason: 'sync-complete' });
assert(refreshed.accepted === true, 'complete sync with changed library signature coalesces a metadata refresh');
const refreshedResult = await refreshed.promise;
assert(refreshedResult.sampleSize <= 40 && enqueued.length - beforeDisabled <= 40,
  'signature refresh reuses fresh tags and never exceeds the bounded sample');

store.close();
console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
