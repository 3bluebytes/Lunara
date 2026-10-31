import test from 'node:test';
import assert from 'node:assert/strict';
import { searchArtistTracks } from './artistCatalog.js';

const row = (song_id, title, artist) => ({ song_id, title, artist });

test('only rows actually credited to the named artist survive the search', async () => {
  const sources = [
    { name: 'qq', provider: { search: async () => [
      row('1', '我不难过', '孙燕姿'),
      row('2', '别人的歌', '别的歌手'),
      row('3', '合唱', '群星 / 孙燕姿'),
      row('', '没有稳定 ID', '孙燕姿'),
      row('4', '', '孙燕姿'),
    ] } },
    { name: 'ncm', provider: { search: async () => { throw new Error('ncm down'); } } },
  ];
  const found = await searchArtistTracks('孙燕姿', { limit: 10, sources });
  assert.deepEqual(found.map(item => `${item.source}:${item.song_id}`), ['qq:search:1', 'qq:search:3']);
  assert.equal(found[0].artist, '孙燕姿');
});

test('results from different providers are deduplicated by provider and song id', async () => {
  const sources = [
    { name: 'qq', provider: { search: async () => [row('7', '同一首', '孙燕姿'), row('7', '同一首', '孙燕姿')] } },
    { name: 'ncm', provider: { search: async () => [row('7', '另一源的同一 ID', '孙燕姿')] } },
  ];
  const found = await searchArtistTracks('孙燕姿', { limit: 10, sources });
  assert.deepEqual(found.map(item => `${item.source}:${item.song_id}`), ['qq:search:7', 'ncm:search:7']);
});

test('a failing, throwing or hanging provider degrades to an empty result instead of failing', async () => {
  const sources = [
    { name: 'qq', provider: { search: async () => { throw new Error('qq down'); } } },
    { name: 'ncm', provider: { search: () => new Promise(() => {}) } },
    { name: 'broken', provider: {} },
  ];
  const found = await searchArtistTracks('孙燕姿', { limit: 5, sources, timeoutMs: 20 });
  assert.deepEqual(found, []);
});

test('an empty artist name performs no provider call at all', async () => {
  let calls = 0;
  const sources = [{ name: 'qq', provider: { search: async () => { calls += 1; return [row('1', '歌', '孙燕姿')]; } } }];
  assert.deepEqual(await searchArtistTracks('   ', { sources }), []);
  assert.deepEqual(await searchArtistTracks(null, { sources }), []);
  assert.equal(calls, 0);
});

test('the requested limit caps the returned catalog window', async () => {
  const rows = Array.from({ length: 30 }, (_value, index) => row(String(index + 1), `歌${index + 1}`, '孙燕姿'));
  const sources = [{ name: 'qq', provider: { search: async () => rows } }];
  const found = await searchArtistTracks('孙燕姿', { limit: 4, sources });
  assert.equal(found.length, 4);
  assert.deepEqual(found.map(item => item.song_id), ['1', '2', '3', '4']);
});
