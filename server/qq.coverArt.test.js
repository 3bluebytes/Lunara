import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QQ_ALBUM_COVER_BASE, albumArtworkUrl, createQqMusicProvider,
} from './qq.js';

const COVER = `${QQ_ALBUM_COVER_BASE}001bkv9c0gpIvm.jpg`;

function providerWith(detail) {
  const calls = [];
  return {
    calls,
    provider: createQqMusicProvider({
      songDetailApi: async (songmid, { signal } = {}) => {
        calls.push({ songmid, hasSignal: Boolean(signal) });
        if (typeof detail === 'function') return detail(songmid);
        if (detail instanceof Error) throw detail;
        return detail;
      },
    }),
  };
}

test('album mid becomes the 300x300 cover URL', () => {
  assert.equal(albumArtworkUrl('001bkv9c0gpIvm'), COVER);
  assert.equal(albumArtworkUrl(''), '');
  assert.equal(albumArtworkUrl('../../etc/passwd'), '');
  assert.equal(albumArtworkUrl('mid with space'), '');
  assert.equal(albumArtworkUrl(null), '');
});

test('a song with an album mid resolves to its cover', async () => {
  const { provider, calls } = providerWith({ code: 0, data: [{ album: { mid: '001bkv9c0gpIvm', name: 'Songs of Yesterday' } }] });
  const result = await provider.coverArt('00045xOt1NVfsv');
  assert.deepEqual(result, { state: 'resolved', artwork: COVER });
  assert.deepEqual(calls, [{ songmid: '00045xOt1NVfsv', hasSignal: false }]);
  const controller = new AbortController();
  await provider.coverArt('00045xOt1NVfsv', { signal: controller.signal });
  assert.equal(calls.at(-1).hasSignal, true, 'caller signal must reach the provider query');
});

test('a song with neither album mid nor album name is confirmed absent', async () => {
  const { provider } = providerWith({ code: 0, data: [{ album: { mid: '', name: '' } }] });
  assert.deepEqual(await provider.coverArt('000xHZ6923phDB'), { state: 'absent' });
});

test('an album name without a mid is a lookup failure, not an absence', async () => {
  const { provider } = providerWith({ code: 0, data: [{ album: { mid: '', name: '钢琴心情101' } }] });
  assert.equal(await provider.coverArt('000ZEYuJ3joUZn'), null);
});

test('wrapped and unwrapped payload shapes both work', async () => {
  for (const detail of [
    { data: [{ album: { mid: '001bkv9c0gpIvm' } }] },
    { response: { code: 0, data: [{ album: { mid: '001bkv9c0gpIvm' } }] } },
  ]) {
    const { provider } = providerWith(detail);
    assert.deepEqual(await provider.coverArt('x'), { state: 'resolved', artwork: COVER });
  }
});

test('transport failures and unexpected payloads never claim absence', async () => {
  for (const detail of [
    new Error('socket hang up'),
    { code: 0, data: [] },
    { code: 500, data: null },
  ]) {
    const { provider } = providerWith(detail);
    assert.equal(await provider.coverArt('x'), null);
  }
  const { provider } = providerWith({ code: 0, data: [{ album: { mid: '001bkv9c0gpIvm' } }] });
  assert.equal(await provider.coverArt('   '), null, 'empty song id must not query');
});

test('the public detail endpoint is used without credentials', async () => {
  const { QQ_SONG_DETAIL_ENDPOINT } = await import('./qq.js');
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ code: 0, data: [{ album: { mid: '001bkv9c0gpIvm' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = createQqMusicProvider();
    assert.deepEqual(await provider.coverArt('00045xOt1NVfsv'), { state: 'resolved', artwork: COVER });
    assert.ok(captured.url.startsWith(QQ_SONG_DETAIL_ENDPOINT));
    assert.match(captured.url, /songmid=00045xOt1NVfsv/);
    const headers = JSON.stringify(captured.init?.headers || {});
    assert.doesNotMatch(headers, /cookie/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
