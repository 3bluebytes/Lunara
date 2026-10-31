import assert from 'node:assert/strict';
import test from 'node:test';

import { createQqMusicProvider } from './qq.js';

const song = (mid, name, albummid) => ({
  songmid: mid, songname: name, singer: [{ name: '甲' }], albumname: '整专', albumid: 7, albummid,
  interval: 180,
});

test('QQ album tracks accept both native album id forms and keep album order', async () => {
  const seen = [];
  const provider = createQqMusicProvider({
    albumSongsApi: async request => {
      seen.push(request);
      return { status: 200, body: { albumSonglist: { data: { songList: [
        song('m1', '第一首', 'mid-1'), song('m2', '第二首', 'mid-1'),
      ] } } } };
    },
    getCookieValue: () => '',
  });
  const tracks = await provider.albumTracks('mid-1', { limit: 10, offset: 0 });
  assert.deepEqual(tracks.map(track => [track.song_id, track.title]), [['m1', '第一首'], ['m2', '第二首']]);
  assert.equal(tracks[0].album, '整专');
  assert.equal(seen[0].params.albummid, 'mid-1');
  assert.equal(seen[0].params.albumid, 'mid-1', '数字形态的专辑 id 同样能传');
  assert.equal(seen[0].params.num, 10);
});

test('a failing QQ album read returns no tracks instead of another album', async () => {
  const failing = createQqMusicProvider({
    albumSongsApi: async () => { throw new Error('upstream down'); },
    getCookieValue: () => '',
  });
  assert.deepEqual(await failing.albumTracks('mid-1'), []);

  const empty = createQqMusicProvider({
    albumSongsApi: async () => ({ status: 200, body: { albumSonglist: { data: { songList: [] } } } }),
    getCookieValue: () => '',
  });
  assert.deepEqual(await empty.albumTracks('mid-1'), []);
  assert.deepEqual(await empty.albumTracks(''), [], '空专辑 id 不发请求');
});
