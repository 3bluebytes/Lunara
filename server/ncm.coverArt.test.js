import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch = globalThis.fetch;
const ncm = await import('./ncm.js');

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  ncm.clearCookie();
});

function respond(body) {
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('an http cover from the provider is upgraded to https', async () => {
  globalThis.fetch = respond({ songs: [{ al: { name: '专辑', picUrl: 'http://p1.music.126.net/abc.jpg' } }] });
  assert.deepEqual(await ncm.coverArt('1901371647'),
    { state: 'resolved', artwork: 'https://p1.music.126.net/abc.jpg' });
});

test('a protocol-relative cover is upgraded to https', () => {
  assert.equal(ncm.normalizeArtworkUrl('//p1.music.126.net/abc.jpg'), 'https://p1.music.126.net/abc.jpg');
  assert.equal(ncm.normalizeArtworkUrl('https://p1.music.126.net/abc.jpg'), 'https://p1.music.126.net/abc.jpg');
  assert.equal(ncm.normalizeArtworkUrl('not-a-url'), '');
  assert.equal(ncm.normalizeArtworkUrl(''), '');
});

test('a track with no album at all is confirmed absent', async () => {
  globalThis.fetch = respond({ songs: [{ al: { name: '', picUrl: '' } }] });
  assert.deepEqual(await ncm.coverArt('1'), { state: 'absent' });
});

test('an album name without a picture is a lookup failure', async () => {
  globalThis.fetch = respond({ songs: [{ al: { name: '专辑', picUrl: '' } }] });
  assert.equal(await ncm.coverArt('1'), null);
});

test('transport and payload failures never claim absence', async () => {
  globalThis.fetch = async () => new Response('boom', { status: 502 });
  assert.equal(await ncm.coverArt('1'), null);
  globalThis.fetch = respond({ songs: [] });
  assert.equal(await ncm.coverArt('1'), null);
  assert.equal(await ncm.coverArt(''), null);
});

test('the cover query carries no account cookie', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ songs: [{ al: { name: 'A', picUrl: 'https://p1.music.126.net/a.jpg' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  ncm.setCookie('MUSIC_U=private-secret');
  await ncm.coverArt('1901371647');
  assert.match(captured.url, /\/song\/detail/);
  assert.equal(captured.url.includes('private-secret'), false);
  assert.equal(String(captured.init?.body || '').includes('private-secret'), false);
});

test('search results carry an https pic_url', async () => {
  globalThis.fetch = respond({ result: { songs: [
    { id: 1, name: 'T', ar: [{ name: 'A' }], al: { id: 2, name: 'Al', picUrl: 'http://p1.music.126.net/x.jpg' }, dt: 1000 },
  ] } });
  const rows = await ncm.search('T');
  assert.equal(rows[0].pic_url, 'https://p1.music.126.net/x.jpg');
});
