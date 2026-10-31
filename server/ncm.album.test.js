import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch = globalThis.fetch;
const ncm = await import('./ncm.js');

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  ncm.clearCookie();
});

const albumPayload = {
  album: { id: 9, name: '整专', picUrl: 'http://img/a.jpg' },
  songs: [
    { id: 101, name: '第一首', ar: [{ name: '甲' }], al: { id: 9, name: '整专', picUrl: 'http://img/a.jpg' }, dt: 181000 },
    { id: 102, name: '第二首', ar: [{ name: '甲' }], al: { id: 9, name: '整专' }, dt: 200000 },
  ],
};

test('NCM album tracks come from /album and keep the album order', async () => {
  let requested = '';
  globalThis.fetch = async url => {
    requested = String(url);
    return new Response(JSON.stringify(albumPayload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const tracks = await ncm.albumTracks('9', { limit: 10, offset: 0 });
  assert.match(requested, /\/album\?/);
  assert.match(requested, /id=9/);
  assert.deepEqual(tracks.map(track => [track.song_id, track.title, track.duration]), [
    ['101', '第一首', 181], ['102', '第二首', 200],
  ]);
  assert.deepEqual(tracks.map(track => track.album_id), ['9', '9']);
});

test('NCM album paging slices locally and failures return no tracks', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify(albumPayload), { status: 200,
    headers: { 'content-type': 'application/json' } });
  const page = await ncm.albumTracks('9', { limit: 1, offset: 1 });
  assert.deepEqual(page.map(track => track.song_id), ['102']);

  globalThis.fetch = async () => new Response('boom', { status: 500 });
  assert.deepEqual(await ncm.albumTracks('9'), []);
  assert.deepEqual(await ncm.albumTracks('  '), []);
});
