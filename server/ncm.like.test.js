import assert from 'node:assert/strict';
import test from 'node:test';

// 「喜欢」写入的双向契约：/like 一个端点加删合一，未登录时必须 fail closed
// 且不触网。这里全部用 fake fetch，不碰真实账号。
const originalFetch = globalThis.fetch;
const ncm = await import('./ncm.js');
const SECRET = 'MUSIC_U=private-secret';

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  ncm.clearCookie();
});

function fakeResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('not logged in: refuses to write and never touches the network', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };

  assert.deepEqual(await ncm.setSongLiked('186016', true), { ok: false, reason: 'not_logged_in' });
  assert.deepEqual(await ncm.setSongLiked('186016', false), { ok: false, reason: 'not_logged_in' });
  assert.equal(called, false);
});

test('empty song id is rejected before any account check', async () => {
  ncm.setCookie(SECRET);
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not fetch'); };

  assert.deepEqual(await ncm.setSongLiked('', true), { ok: false, reason: 'invalid_song' });
  assert.equal(called, false);
});

test('like and unlike share /like and differ only by the like flag', async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return fakeResponse({ code: 200 });
  };
  ncm.setCookie(SECRET);

  assert.deepEqual(await ncm.setSongLiked('186016', true), { ok: true, state: 'liked' });
  assert.deepEqual(await ncm.setSongLiked('186016', false), { ok: true, state: 'unliked' });

  assert.equal(requests.length, 2);
  for (const { url, init } of requests) {
    // 凭据只走表单体：URL 上出现 cookie/uid 就会进上游访问日志。
    assert.equal(url, 'http://127.0.0.1:3000/like');
    assert.ok(!url.includes(SECRET));
    assert.equal(init.method, 'POST');
  }
  const first = new URLSearchParams(requests[0].init.body.toString());
  const second = new URLSearchParams(requests[1].init.body.toString());
  assert.equal(first.get('id'), '186016');
  assert.equal(first.get('like'), 'true');
  assert.equal(second.get('like'), 'false');
  assert.equal(first.get('cookie'), SECRET);
});

test('expired cookie (code 301) surfaces as not_logged_in, not success', async () => {
  globalThis.fetch = async () => fakeResponse({ code: 301, msg: '需要登录' });
  ncm.setCookie(SECRET);

  assert.deepEqual(await ncm.setSongLiked('186016', true), { ok: false, reason: 'not_logged_in', code: 301 });
});

test('a delisted song surfaces as not_collectable, not as a network failure', async () => {
  // 真机证据：已下架曲目被 /like 以 HTTP 500 + body.code 500 拒绝，
  // /playlist/tracks 侧同因给的是 code 401「下架歌曲无法收藏」。
  globalThis.fetch = async () => fakeResponse({ songs: [], playlistId: 546934160, code: 500 }, 500);
  ncm.setCookie(SECRET);
  assert.deepEqual(await ncm.setSongLiked('186016', true), { ok: false, reason: 'not_collectable', code: 500 });

  globalThis.fetch = async () => fakeResponse({ code: 401, message: '下架歌曲无法收藏' }, 401);
  assert.deepEqual(await ncm.setSongLiked('186016', true), { ok: false, reason: 'not_collectable', code: 401 });
});

test('an unparsable error body still fails closed', async () => {
  globalThis.fetch = async () => new Response('<html>gateway</html>', { status: 502 });
  ncm.setCookie(SECRET);
  assert.deepEqual(await ncm.setSongLiked('186016', true), { ok: false, reason: 'request_failed', code: 502 });
});

test('upstream failure is attributed without leaking the response body', async () => {
  globalThis.fetch = async () => fakeResponse({ code: 503, msg: `boom ${SECRET}` });
  ncm.setCookie(SECRET);

  const result = await ncm.setSongLiked('186016', true);
  assert.deepEqual(result, { ok: false, reason: 'request_failed', code: 503 });
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('transport errors are reported as request_failed instead of throwing', async () => {
  globalThis.fetch = async () => { throw new Error(`socket hang up ${SECRET}`); };
  ncm.setCookie(SECRET);

  const result = await ncm.setSongLiked('186016', true);
  assert.deepEqual(result, { ok: false, reason: 'request_failed', code: null });
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('likedSongIds distinguishes an empty list from an unreadable one', async () => {
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return fakeResponse({ code: 200, ids: [186016, 20231012] });
  };
  ncm.setCookie(SECRET);

  assert.deepEqual(await ncm.likedSongIds(42), { ok: true, ids: ['186016', '20231012'], reason: null });
  assert.equal(captured.url, 'http://127.0.0.1:3000/likelist');
  assert.equal(new URLSearchParams(captured.init.body.toString()).get('uid'), '42');

  // 真的空列表：读到了，只是没有收藏。
  globalThis.fetch = async () => fakeResponse({ code: 200, ids: [] });
  assert.deepEqual(await ncm.likedSongIds(42), { ok: true, ids: [], reason: null });

  // 读到失败：绝不能伪装成「没有收藏」。
  globalThis.fetch = async () => fakeResponse({ code: 500 });
  assert.deepEqual(await ncm.likedSongIds(42), { ok: false, ids: [], reason: 'request_failed' });

  ncm.clearCookie();
  assert.deepEqual(await ncm.likedSongIds(42), { ok: false, ids: [], reason: 'not_logged_in' });
});
