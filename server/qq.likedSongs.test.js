import assert from 'node:assert/strict';
import test from 'node:test';

// QQ「我喜欢」的读路径。这里锁的是一个真实 bug：`getUserPlaylists` 用的是
// user_created_diss，只返用户**自建**歌单，「我喜欢」（dirId 201）根本不在里面，
// 于是旧实现 `find(dirid===201) || lists[0]` 会默默把第一个自建歌单当成收藏，
// 把别的歌单内容喂进候选池和本地曲库。真机表现为：QQ 明明收藏了，Lunara 不认。
import { createQqMusicProvider } from './qq.js';

const COOKIE = 'uin=1234567890; qm_keyst=SECRET-AUTHST';

const FAVORITE_TID = '1840268153';
const playlistBase = (lists) => ({ code: 0, req_1: { code: 0, data: { v_playlist: lists } } });
const favoritesEntry = { dirId: 201, tid: Number(FAVORITE_TID), songNum: 2, dirName: '我喜欢' };
const ownedEntry = { dirId: 14, tid: 9330705204, songNum: 100, dirName: '旧歌' };

function songs(...rows) {
  return wrap({
    code: 0,
    cdlist: [{
      disstid: FAVORITE_TID,
      songnum: rows.length,
      songlist: rows.map(([mid, name]) => ({ songmid: mid, songname: name, singer: [{ name: '歌手' }] })),
    }],
  });
}

/** 供应商适配层吃的是 SDK 外壳 { status, body }，不是裸 payload。 */
function wrap(body) { return { status: 200, body }; }

function providerWith({ base = playlistBase([favoritesEntry, ownedEntry]), detail, baseThrows = false, cookie = COOKIE } = {}) {
  const detailCalls = [];
  const baseCalls = [];
  const provider = createQqMusicProvider({
    getCookieValue: () => cookie,
    musicuFetch: async request => {
      baseCalls.push(request);
      if (baseThrows) throw new Error('network down');
      return base;
    },
    playlistDetailApi: async request => {
      detailCalls.push(request);
      if (typeof detail === 'function') return detail(request);
      return detail ?? songs(['0039MnYb0qxYhV', '晴天']);
    },
    userPlaylistsApi: async () => wrap({
      code: 0,
      data: { mydiss: { list: [{ dissid: 9330705204, dissname: '旧歌', song_cnt: 100 }] } },
    }),
  });
  return { provider, detailCalls, baseCalls };
}

test('the liked playlist is resolved by dirId 201, not by "whichever list is first"', async () => {
  const { provider, baseCalls } = providerWith();

  const favorite = await provider.likedPlaylist('1234567890');
  assert.deepEqual(favorite, { tid: FAVORITE_TID, trackCount: 2 });
  assert.equal(baseCalls[0].module, 'music.musicasset.PlaylistBaseRead');
  assert.equal(baseCalls[0].method, 'GetPlaylistByUin');
  assert.equal(baseCalls[0].param.uin, '1234567890');
});

test('likedSongs reads the favorites tid and never substitutes an owned playlist', async () => {
  const { provider, detailCalls } = providerWith({
    detail: songs(['0039MnYb0qxYhV', '晴天'], ['000pdFKw0wlwNJ', '总结']),
  });

  const rows = await provider.likedSongs('1234567890', { limit: 100 });
  assert.deepEqual(rows.map(row => row.song_id), ['0039MnYb0qxYhV', '000pdFKw0wlwNJ']);
  assert.equal(detailCalls.length, 1);
  assert.equal(String(detailCalls[0].params.disstid), FAVORITE_TID);

  // 自建歌单不在候选里：即使收藏夹缺失，也不该退化成「第一个歌单」。
  const noFavorite = providerWith({ base: playlistBase([ownedEntry]) });
  assert.deepEqual(await noFavorite.provider.likedSongs('1234567890'), []);
  assert.equal(noFavorite.detailCalls.length, 0);
});

test('a read failure is reported, never sold as "nothing is liked"', async () => {
  const failing = providerWith({ baseThrows: true });
  assert.deepEqual(await failing.provider.likedSongIds('1234567890'), {
    ok: false, reason: 'liked_list_unavailable', ids: [],
  });

  const loggedOut = providerWith({ cookie: '' });
  assert.deepEqual(await loggedOut.provider.likedSongIds('1234567890'), {
    ok: false, reason: 'not_logged_in', ids: [],
  });
  assert.equal(loggedOut.baseCalls.length, 0);
});

test('likedSongIds returns the real membership ids so hydration can trust them', async () => {
  const { provider } = providerWith({ detail: songs(['0039MnYb0qxYhV', '晴天'], ['000pdFKw0wlwNJ', '总结']) });
  assert.deepEqual(await provider.likedSongIds('1234567890'), {
    ok: true, ids: ['0039MnYb0qxYhV', '000pdFKw0wlwNJ'],
  });
});

test('library sync includes the favorites as a playlist so its members can become collection references', async () => {
  const { provider } = providerWith();

  const snapshot = await provider.libraryPlaylistsSnapshot('1234567890');
  const favorite = snapshot.items[0];
  assert.equal(favorite.id, FAVORITE_TID, '收藏夹必须排在第一位，导入时先被看到');
  assert.equal(favorite.dirid, 201);
  assert.equal(favorite.name, '我喜欢');
  assert.equal(favorite.trackCount, 2);
  // 自建歌单仍然保留，只是不再冒充收藏。
  assert.ok(snapshot.items.some(item => item.name === '旧歌'));
});
