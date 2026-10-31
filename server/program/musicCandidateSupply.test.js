import assert from 'node:assert/strict';
import test from 'node:test';
import { MusicCandidateSupply, loadOnlineCandidates, mergeCandidateSources } from './musicCandidateSupply.js';

const local = Array.from({ length: 100 }, (_, index) => ({
  source: 'qq:library', song_id: `local-${index}`, title: `旧歌 ${index}`, artist: '歌手',
}));
const live = [{ source: 'qq:daily', song_id: 'new-1', title: '新歌', artist: '新歌手' }];

test('mixed supply keeps live discoveries inside the first 60 and preserves provider-native identity', () => {
  const rows = mergeCandidateSources(local, [
    ...live,
    { source: 'qq:daily', song_id: 'local-1', title: '旧歌 1', artist: '歌手' },
    { source: 'ncm:daily', song_id: 'new-1', title: '新歌', artist: '新歌手' },
  ]);
  assert.ok(rows.slice(0, 60).some(row => row.song_id === 'new-1' && row.source === 'qq:daily'));
  assert.ok(rows.some(row => row.song_id === 'new-1' && row.source === 'ncm:daily'));
  assert.equal(rows.filter(row => row.song_id === 'local-1' && row.source.startsWith('qq:')).length, 1);
  assert.equal(rows.find(row => row.song_id === 'local-1').collectionOrigin, 'qq:library');
  assert.equal(rows.length, 102);
});

test('public discovery remains visible ahead of a large healthy liked-song feed', () => {
  const liked = Array.from({ length: 100 }, (_, index) => ({
    source: 'qq:liked', song_id: `liked-${index}`, title: `喜欢 ${index}`, artist: '歌手',
  }));
  const rows = mergeCandidateSources(local, [...liked,
    { source: 'qq:discovery', song_id: 'fresh-public', title: '新歌', artist: '新人' }]);
  assert.ok(rows.slice(0, 60).some(row => row.song_id === 'fresh-public'));
});

test('local candidates survive a failed online refresh and foreground and continuation use the same supply', async () => {
  const supply = new MusicCandidateSupply({ readLocal: () => local.slice(0, 2),
    loadOnline: async () => { throw new Error('playlist failed'); }, waitMs: 1 });
  const foreground = await supply.getCandidates({ reason: 'user_request' });
  const continuation = await supply.getCandidates({ reason: 'auto_continue' });
  assert.deepEqual(foreground.map(row => row.song_id), ['local-0', 'local-1']);
  assert.deepEqual(continuation.map(row => row.song_id), foreground.map(row => row.song_id));
});

test('slow refresh is coalesced and does not block available local music', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let loads = 0;
  const supply = new MusicCandidateSupply({ readLocal: () => local.slice(0, 1),
    loadOnline: async () => { loads++; return gate; }, waitMs: 1 });
  const [first, second] = await Promise.all([supply.getCandidates(), supply.getCandidates()]);
  assert.equal(loads, 1);
  assert.equal(first[0].song_id, 'local-0');
  assert.equal(second[0].song_id, 'local-0');
  release(live);
  await supply.refresh();
  const later = await supply.getCandidates();
  assert.ok(later.some(row => row.song_id === 'new-1'));
});

test('a refresh from an earlier account cannot populate a later account snapshot', async () => {
  let version = 'account-a';
  let releaseOld;
  const old = new Promise(resolve => { releaseOld = resolve; });
  let loads = 0;
  const supply = new MusicCandidateSupply({ readLocal: () => [], sourceVersion: () => version,
    loadOnline: async () => ++loads === 1 ? old : [{ source: 'qq:daily', song_id: 'account-b-song', title: 'B', artist: 'B' }],
    coldWaitMs: 1,
  });
  await supply.getCandidates();
  version = 'account-b';
  const current = await supply.getCandidates();
  assert.deepEqual(current.map(row => row.song_id), ['account-b-song']);
  releaseOld([{ source: 'qq:daily', song_id: 'account-a-song', title: 'A', artist: 'A' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await supply.getCandidates()).map(row => row.song_id), ['account-b-song']);
});

test('an NCM login probe failure cannot suppress an independent daily recommendation', async () => {
  const rows = await loadOnlineCandidates({
    qqProvider: { getUid: () => '', recommend: async () => [] },
    ncmProvider: { getCookie: () => 'present', loginStatus: async () => { throw new Error('status unavailable'); },
      recommend: async () => [{ song_id: 'public-1', title: '公开推荐', artist: '歌手' }] },
    loadProviderCandidates: async () => { throw new Error('playlist unavailable'); },
  });
  assert.deepEqual(rows.map(row => [row.source, row.song_id]), [['ncm:daily', 'public-1']]);
});

test('QQ public discovery remains available when the private playlist candidate loader fails', async () => {
  const rows = await loadOnlineCandidates({
    qqProvider: { getUid: () => '42', recommend: async () => [],
      discover: async () => [{ song_id: 'online-new', title: '新歌', artist: '新歌手' }] },
    ncmProvider: { getCookie: () => '', recommend: async () => [] },
    loadProviderCandidates: async () => { throw new Error('playlist unavailable'); },
  });
  assert.ok(rows.some(row => row.song_id === 'online-new' && row.source === 'qq:discovery'));
});

const COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000001bkv9c0gpIvm.jpg';

test('library candidates carry the cover the cache already knows', async () => {
  const { readLocalLibraryCandidates } = await import('./musicCandidateSupply.js');
  const rows = [
    { provider: 'qq', song_id: 'A', title: 'Moon River', artist: '曹思义', album: 'Songs of Yesterday', duration: 234 },
    { provider: 'qq', song_id: 'B', title: 'Unknown', artist: 'X', album: null, duration: 100 },
  ];
  const asked = [];
  const candidates = readLocalLibraryCandidates({
    store: { listActiveSongs: () => rows },
    artworkStore: {
      peekMany: (provider, songIds) => { asked.push([provider, songIds]); return new Map([['A', COVER], ['B', null]]); },
    },
  });
  assert.deepEqual(asked, [['qq', ['A', 'B']]]);
  assert.equal(candidates[0].artwork, COVER);
  assert.equal(candidates[1].artwork, '');
  assert.equal(candidates[1].source, 'qq:library');
});

test('library candidate projection never triggers a network artwork query', async () => {
  const { readLocalLibraryCandidates } = await import('./musicCandidateSupply.js');
  const candidates = readLocalLibraryCandidates({
    store: { listActiveSongs: () => [{ provider: 'ncm', song_id: '9', title: 'T', artist: 'A' }] },
    artworkStore: { peekMany: () => new Map() },
  });
  assert.equal(candidates[0].artwork, '');
});

// ---- ground-music-selection-in-taste 2.1：本地曲库全量进入候选 ----
const libraryRows = count => Array.from({ length: count }, (_, index) => ({
  provider: 'qq', song_id: `s${index}`, title: `T${index}`, artist: `A${index % 50}`, album: '', duration: 200 }));

test('local library candidates are no longer cut at 1000 rows', async () => {
  const { readLocalLibraryCandidates } = await import('./musicCandidateSupply.js');
  const rows = libraryRows(1845);
  const traces = [];
  const candidates = readLocalLibraryCandidates({ store: { listCollectionTracks: () => rows },
    artworkStore: { peekMany: () => new Map() }, trace: event => traces.push(event) });
  assert.equal(candidates.length, 1845, '最久没出现过的那一批也进入候选');
  assert.equal(candidates.at(-1).song_id, 's1844');
  assert.deepEqual(traces, [], '没超上限不记 trace');
});

test('MUSIC_LOCAL_CANDIDATE_LIMIT bounds the projection and records a count-only trace', async t => {
  const { readLocalLibraryCandidates, localCandidateLimit } = await import('./musicCandidateSupply.js');
  const previous = process.env.MUSIC_LOCAL_CANDIDATE_LIMIT;
  t.after(() => { if (previous == null) delete process.env.MUSIC_LOCAL_CANDIDATE_LIMIT; else process.env.MUSIC_LOCAL_CANDIDATE_LIMIT = previous; });
  delete process.env.MUSIC_LOCAL_CANDIDATE_LIMIT;
  assert.equal(localCandidateLimit(), 10000);
  process.env.MUSIC_LOCAL_CANDIDATE_LIMIT = 'nonsense';
  assert.equal(localCandidateLimit(), 10000, '非法值回到默认');
  process.env.MUSIC_LOCAL_CANDIDATE_LIMIT = '300';
  assert.equal(localCandidateLimit(), 300);

  const traces = [];
  const collection = readLocalLibraryCandidates({ store: { listCollectionTracks: () => libraryRows(500) },
    artworkStore: { peekMany: () => new Map() }, trace: event => traces.push(event) });
  assert.equal(collection.length, 300);
  const asked = [];
  const active = readLocalLibraryCandidates({
    store: { listActiveSongs: ({ limit }) => { asked.push(limit); return libraryRows(limit); } },
    artworkStore: { peekMany: () => new Map() }, trace: event => traces.push(event) });
  assert.equal(active.length, 300);
  assert.deepEqual(asked, [301], '多取一行只用来判断是否超限');
  assert.deepEqual(traces, [
    { event: 'music-local-candidates-truncated', total: 500, limit: 300 },
    { event: 'music-local-candidates-truncated', total: null, limit: 300 },
  ]);
  for (const event of traces) assert.deepEqual(Object.keys(event).sort(), ['event', 'limit', 'total'], 'trace 只含计数');
});
