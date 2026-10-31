import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeToolOutcome } from './ToolOutcome.js';
import { createGetAlbumTracks, createGetPlaylistTracks, createGetUserPlaylists } from './musicTools.js';

function providers() {
  const remembered = [];
  return {
    remembered,
    ncm: {
      loginStatus: async () => ({ loggedIn: true, userId: 'n-user' }),
      userPlaylists: async () => [
        { id: 'n-1', name: '夜晚收藏', trackCount: 42 },
        { id: 'n-2', name: '钢琴', trackCount: 8 },
      ],
      playlistAllTracks: async (_id, { limit, offset }) => Array.from({ length: Math.min(limit, 3) }, (_, index) => ({
        song_id: `n-${offset + index}`, title: `N Song ${offset + index}`, artist: 'N Artist', album: 'N Album',
      })),
    },
    qq: {
      loginStatus: async () => ({ loggedIn: true, userId: 'q-user' }),
      getUid: () => 'q-user',
      userPlaylists: async () => [{ id: 'q-1', name: '我喜欢', trackCount: 30 }],
      playlistAllTracks: async (_id, { limit }) => Array.from({ length: limit }, (_, index) => ({
        song_id: `q-${index}`, title: `Q Song ${index}`, artist: 'Q Artist', album: 'Q Album',
      })),
    },
    rememberTracks: (tracks, source) => remembered.push({ tracks, source }),
  };
}

test('playlist listing honors the LLM-selected provider and returns stable references', async () => {
  const deps = providers();
  const outcome = normalizeToolOutcome(await createGetUserPlaylists(deps)({ source: 'ncm', limit: 10 }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.data.playlists.map(item => item.source), ['ncm', 'ncm']);
  assert.deepEqual(outcome.data.playlists.map(item => item.playlistId), ['n-1', 'n-2']);
  assert.doesNotMatch(outcome.content, /QQ/);
});

test('playlist listing does not present a missing upstream count as zero songs', async () => {
  const deps = providers();
  deps.qq.userPlaylists = async () => [{ id: 'q-unknown', name: '旧歌', trackCount: null }];
  const outcome = normalizeToolOutcome(await createGetUserPlaylists(deps)({ source: 'qq' }));
  assert.equal(outcome.data.playlists[0].trackCount, null);
  assert.match(outcome.content, /数量未知，请读取曲目确认/);
  assert.doesNotMatch(outcome.content, /0 首/);
});

test('playlist tracks use provider plus id and expose bounded pagination facts', async () => {
  const deps = providers();
  const outcome = normalizeToolOutcome(await createGetPlaylistTracks(deps)({
    source: 'ncm', playlistId: 'n-1', offset: 20, limit: 20,
  }));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.data.offset, 20);
  assert.equal(outcome.data.returned, 3);
  assert.equal(outcome.data.hasMore, true);
  assert.equal(outcome.data.matches[0].tracks[0].songId, 'n-20');
  assert.deepEqual(deps.remembered.map(item => item.source), ['ncm']);
  assert.equal(deps.remembered[0].tracks[0].source, 'ncm:playlist', 'cached playlist tracks retain collection provenance');
});

test('QQ pagination slices the provider result without inventing tracks', async () => {
  const deps = providers();
  const outcome = normalizeToolOutcome(await createGetPlaylistTracks(deps)({
    source: 'qq', playlistId: 'q-1', offset: 10, limit: 5,
  }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.data.matches[0].tracks.map(track => track.songId), ['q-10', 'q-11', 'q-12', 'q-13', 'q-14']);
});

test('provider/auth failure is a fact, not an empty preference inference', async () => {
  const deps = providers();
  deps.ncm.loginStatus = async () => ({ loggedIn: false, reason: 'expired' });
  const outcome = normalizeToolOutcome(await createGetUserPlaylists(deps)({ source: 'ncm' }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.data.reason, 'no_playlists');
  assert.deepEqual(outcome.data.providers, [{ source: 'ncm', ok: false, reason: 'expired' }]);
});

test('album tracks come from the declared source and carry stable ids', async () => {
  const calls = [];
  const qqStub = { albumTracks: async (albumId, { limit, offset }) => {
    calls.push({ albumId, limit, offset });
    return [{ song_id: 'mid-1', title: '第一首', artist: '甲', album: '整专', duration: 200 }];
  } };
  const result = await createGetAlbumTracks({ qq: qqStub, rememberTracks: () => {} })({ source: 'qq', albumId: 'alb-1', limit: 5 });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 200));
  assert.deepEqual(calls, [{ albumId: 'alb-1', limit: 5, offset: 0 }]);
  const match = result.data.matches[0];
  assert.deepEqual(match.album, { source: 'qq', albumId: 'alb-1' });
  assert.deepEqual(match.tracks.map(track => [track.songId, track.title]), [['mid-1', '第一首']]);
});

test('an unreadable album fails closed instead of returning another album or a same-titled song', async () => {
  const empty = await createGetAlbumTracks({ qq: { albumTracks: async () => [] }, rememberTracks: () => {} })(
    { source: 'qq', albumId: 'gone' });
  assert.equal(empty.ok, false);
  assert.equal(empty.data.reason, 'album_unavailable');

  const ambiguous = await createGetAlbumTracks({ rememberTracks: () => {} })({ source: 'all', albumId: 'x' });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.data.reason, 'invalid_source');
});
