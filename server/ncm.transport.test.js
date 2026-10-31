import assert from 'node:assert/strict';
import test from 'node:test';

const originalFetch = globalThis.fetch;
const ncm = await import('./ncm.js');
const { setSourceHealthReporter, resetSourceHealthReporter } = await import('./music/sourceHealthSignal.js');

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  ncm.clearCookie();
  resetSourceHealthReporter();
});

test('authenticated NCM requests keep cookie and identity fields out of the URL', async () => {
  const secret = 'MUSIC_U=private-secret';
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({
      data: {
        account: { id: 42, vipType: 0 },
        profile: { nickname: 'private-name', avatarUrl: '' },
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  ncm.setCookie(secret);
  const status = await ncm.loginStatus();

  assert.equal(status.loggedIn, true);
  assert.equal(captured.url, 'http://127.0.0.1:3000/login/status');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.url.includes(secret), false);
  assert.equal(captured.url.includes('42'), false);
  const body = new URLSearchParams(String(captured.init.body));
  assert.equal(body.get('cookie'), secret);
  assert.match(body.get('timestamp'), /^\d+$/);
});

test('Netease expiry emits the same closed auth fact, not provider-specific warning text', async () => {
  const events = [];
  setSourceHealthReporter((source, code) => events.push({ source, code }));
  ncm.setCookie('MUSIC_U=fixture-private');
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { code: 200, account: null, profile: null } }));
  assert.equal((await ncm.loginStatus()).code, 'requires-auth');
  assert.deepEqual(events, [{ source: 'ncm', code: 'requires-auth' }]);
});

test('Netease network failure or malformed status never claims expired credentials', async () => {
  const events = [];
  setSourceHealthReporter((source, code) => events.push({ source, code }));
  ncm.setCookie('MUSIC_U=fixture-private');
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  assert.equal((await ncm.loginStatus()).code, 'unavailable');
  globalThis.fetch = async () => new Response(JSON.stringify({ data: {} }));
  assert.equal((await ncm.loginStatus()).code, 'internal');
  globalThis.fetch = async () => new Response(JSON.stringify({ data: { code: 503, account: null, profile: null } }));
  assert.equal((await ncm.loginStatus()).code, 'unavailable');
  assert.deepEqual(events, []);
});

test('a late Netease status cannot invalidate replacement credentials', async () => {
  let finish;
  const events = [];
  setSourceHealthReporter((source, code) => events.push({ source, code }));
  ncm.setCookie('MUSIC_U=fixture-old');
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const pending = ncm.loginStatus();
  ncm.setCookie('MUSIC_U=fixture-new');
  finish(new Response(JSON.stringify({ data: { code: 200, account: null, profile: null } })));
  assert.equal((await pending).code, 'unavailable');
  assert.deepEqual(events, []);
});

test('public NCM requests remain GET requests without a cookie body', async () => {
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ result: { songs: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  await ncm.search('public query', 3);

  assert.match(captured.url, /\/cloudsearch\?/);
  assert.match(captured.url, /keywords=public\+query/);
  assert.equal(captured.init.method, undefined);
  assert.equal(captured.init.body, undefined);
});

// —— recover-unplayable-after-source-login ——
function songUrlFetch(itemsByLevel) {
  const levels = [];
  globalThis.fetch = async url => {
    const level = new URL(String(url)).searchParams.get('level');
    levels.push(level);
    const item = itemsByLevel[level];
    if (item instanceof Error) throw item;
    return new Response(JSON.stringify({ data: [item || { url: null }] }), {
      status: 200, headers: { 'content-type': 'application/json' } });
  };
  return levels;
}

test('songUrl skips trial-only streams and uses the first full-quality URL', async () => {
  songUrlFetch({ hires: { url: 'https://audio.test/trial.mp3', freeTrialInfo: { start: 0, end: 30 } },
    lossless: { url: 'https://audio.test/full.flac', freeTrialInfo: null } });
  assert.equal(await ncm.songUrl('1'), 'https://audio.test/full.flac');
});

test('songUrl returns null when every quality only offers a trial clip', async () => {
  const trial = { url: 'https://audio.test/trial.mp3', freeTrialInfo: { start: 0, end: 30 } };
  const levels = songUrlFetch({ hires: trial, lossless: trial, exhigh: trial, standard: trial });
  assert.equal(await ncm.songUrl('1'), null);
  assert.deepEqual(levels, ['hires', 'lossless', 'exhigh', 'standard']);
});

test('songUrl rethrows when every quality request fails, so outages are not "not playable"', async () => {
  const down = new Error('fetch failed');
  songUrlFetch({ hires: down, lossless: down, exhigh: down, standard: down });
  await assert.rejects(ncm.songUrl('1'), /fetch failed/);
});

test('songUrl returns null when one quality answers without audio and the others fail', async () => {
  const down = new Error('timeout');
  songUrlFetch({ hires: down, lossless: down, exhigh: { url: null }, standard: down });
  assert.equal(await ncm.songUrl('1'), null);
});

// —— NeteaseCloudMusicApi 的 2 分钟 apicache 只按 URL + header cookie 取 key ——
// 登录后参数在 POST body 里，不旁路缓存就会让不同歌曲拿到同一份歌词/直链。
test('authenticated per-song requests are not served from the shared NCM response cache', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const express = require('express');
  const apicache = require('NeteaseCloudMusicApi/util/apicache');
  const cache = apicache.middleware;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(cache('2 minutes', (_, res) => res.statusCode === 200));
  app.use('/lyric', (req, res) => res.json({ lrc: { lyric: `[00:01.00]lyric-of-${req.body.id ?? req.query.id}` } }));
  app.use('/song/url/v1', (req, res) => {
    const id = req.body.id ?? req.query.id;
    res.json({ data: [{ url: `https://audio.test/${id}.mp3`, freeTrialInfo: null }] });
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const previousBase = ncm.getBaseUrl();
  try {
    ncm.setBaseUrl(`http://127.0.0.1:${server.address().port}`);
    ncm.setCookie('MUSIC_U=private-secret');
    assert.match((await ncm.lyric('111')).lrc, /lyric-of-111/);
    assert.match((await ncm.lyric('222')).lrc, /lyric-of-222/);
    assert.equal(await ncm.songUrl('111'), 'https://audio.test/111.mp3');
    assert.equal(await ncm.songUrl('222'), 'https://audio.test/222.mp3');
  } finally {
    ncm.setBaseUrl(previousBase);
    apicache.clear(); // 释放缓存过期定时器，测试进程才能退出
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
