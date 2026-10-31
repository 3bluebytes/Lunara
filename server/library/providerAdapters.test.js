import { ProviderAdapters } from './providerAdapters.js';
import * as ncm from '../ncm.js';
import * as qq from '../qq.js';

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}

console.log('\n--- adapter preserves empty, errors, counts, and identity ---');
const adapter = new ProviderAdapters({
  providers: {
    ncm: {
      loginStatus: async () => ({ loggedIn: false, reason: 'cookie expired' }),
      libraryPlaylistsSnapshot: async () => ({ items: [], complete: true, reportedCount: 0, fetchedCount: 0 }),
      libraryTracksSnapshot: async () => { throw new Error('transport timeout'); },
    },
    qq: {
      loginStatus: async () => ({ loggedIn: true, userId: 42 }),
      libraryPlaylistsSnapshot: async () => ({ items: [{ id: 'p' }], complete: true, reportedCount: 2, fetchedCount: 1 }),
      libraryTracksSnapshot: async () => ({ nope: true }),
    },
  },
});
const noIdentity = await adapter.resolveAccountIdentity('ncm');
assert(noIdentity.accountUid == null && /cookie expired/.test(noIdentity.error), 'cookie without verified UID does not produce identity');
const identity = await adapter.resolveAccountIdentity('qq');
assert(identity.accountUid === '42', 'verified UID is normalized to string');
const empty = await adapter.fetchPlaylistsSnapshot('ncm', 'U');
assert(empty.complete && empty.reportedCount === 0 && empty.fetchedCount === 0, 'valid empty playlist list remains complete');
const transport = await adapter.fetchPlaylistTracksSnapshot('ncm', { id: 'p', trackCount: 3 }, 'U');
assert(!transport.complete && transport.fetchedCount === 0 && /timeout/.test(transport.error), 'transport failure is incomplete, not successful empty');
const mismatch = await adapter.fetchPlaylistsSnapshot('qq', '42');
assert(!mismatch.complete && mismatch.reportedCount === 2 && mismatch.fetchedCount === 1, 'reported/fetched mismatch forces incomplete');
const parse = await adapter.fetchPlaylistTracksSnapshot('qq', { id: 'p', trackCount: 0 }, '42');
assert(!parse.complete && /invalid snapshot shape/.test(parse.error), 'invalid parsed shape is incomplete');

console.log('\n--- production NCM true pagination ---');
const originalFetch = globalThis.fetch;
ncm.setCookie('MUSIC_U=test');
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const parsed = new URL(String(url));
  const params = init.body instanceof URLSearchParams
    ? init.body
    : new URLSearchParams(String(init.body || parsed.search));
  calls.push(`${parsed.pathname}:${params.get('offset')}`);
  if (parsed.pathname === '/user/playlist') {
    const offset = Number(params.get('offset') || 0);
    return new Response(JSON.stringify(offset === 0
      ? { playlist: [{ id: 1, name: 'A', trackCount: 1 }, { id: 2, name: 'B', trackCount: 1 }], more: true, total: 3 }
      : { playlist: [{ id: 3, name: 'C', trackCount: 1 }], more: false, total: 3 }), { status: 200 });
  }
  if (parsed.pathname === '/playlist/track/all') {
    const offset = Number(params.get('offset') || 0);
    const songs = offset === 0
      ? [{ id: 1, name: 'A', ar: [], al: {}, dt: 1000 }, { id: 2, name: 'B', ar: [], al: {}, dt: 1000 }]
      : [{ id: 3, name: 'C', ar: [], al: {}, dt: 1000 }];
    return new Response(JSON.stringify({ songs }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
const ncmPlaylists = await ncm.libraryPlaylistsSnapshot('U', { pageSize: 2 });
assert(ncmPlaylists.complete && ncmPlaylists.items.length === 3, 'NCM playlist enumeration follows pagination to reported total');
const ncmTracks = await ncm.libraryTracksSnapshot('p', { reportedCount: 3, pageSize: 2 });
assert(ncmTracks.complete && ncmTracks.items.length === 3, 'NCM track snapshot follows pagination to reported count');
assert(calls.includes('/user/playlist:2') && calls.includes('/playlist/track/all:2'), 'NCM requested subsequent offsets');

console.log('\n--- production QQ truncation is explicit ---');
const qqSdkProvider = qq.createQqMusicProvider({
  getCookieValue: () => 'uin=42; qm_keyst=test',
  userPlaylistsApi: async () => ({
    status: 200,
    body: { response: { code: 0, data: { playlists: [] } } },
  }),
  playlistDetailApi: async () => ({
    status: 200,
    body: { response: { cdlist: [{ songnum: 2, songlist: [{ mid: 'one', name: 'Only one', singer: [] }] }] } },
  }),
});
const qqEmpty = await qqSdkProvider.libraryPlaylistsSnapshot('42');
assert(qqEmpty.complete && qqEmpty.items.length === 0, 'QQ valid empty playlist list is complete');
const qqTracks = await qqSdkProvider.libraryTracksSnapshot('p', { reportedCount: 2 });
assert(!qqTracks.complete && qqTracks.fetchedCount === 1 && qqTracks.reportedCount === 2, 'QQ upstream truncation is marked incomplete');

globalThis.fetch = originalFetch;
ncm.clearCookie();
qq.clearCookie();

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
