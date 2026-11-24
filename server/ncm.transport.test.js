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

for (const authenticated of [false, true]) {
  test(`songUrl explicitly uses same-provider WEAPI (${authenticated ? 'authenticated' : 'anonymous'})`, async () => {
    const calls = [];
    if (authenticated) ncm.setCookie('MUSIC_U=protocol-fixture-secret');
    globalThis.fetch = async (url, init) => {
      const query = init.body ? new URLSearchParams(String(init.body)) : new URL(String(url)).searchParams;
      calls.push({ url: String(url), query });
      assert.equal(query.get('crypto'), 'weapi');
      assert.equal(query.get('id'), '901');
      assert.equal(query.get('level'), 'hires');
      assert.equal(new URL(String(url)).pathname, '/song/url/v1');
      if (authenticated) {
        assert.equal(query.get('cookie'), 'MUSIC_U=protocol-fixture-secret');
        assert.equal(String(url).includes('protocol-fixture-secret'), false);
      }
      return new Response(JSON.stringify({ data: [{ id: 901, url: 'https://audio.test/901.flac' }] }));
    };
    assert.equal(await ncm.songUrl('901'), 'https://audio.test/901.flac');
    assert.equal(calls.length, 1, 'no additional protocol attempt');
  });
}

for (const metadata of ['lyric', 'coverArt']) {
  test(`${metadata} throttling cannot arm stream backoff or claim the playback source is throttled`, async () => {
    const events = [];
    setSourceHealthReporter((source, code) => events.push({ source, code }));
    const calls = [];
    globalThis.fetch = async url => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return path === '/song/url/v1'
        ? new Response(JSON.stringify({ data: [{ id: 901, url: 'https://audio.test/901.mp3' }] }))
        : new Response(JSON.stringify({ code: -460, message: 'private-metadata-rejection' }), { status: 400 });
    };
    await ncm[metadata]('901');
    assert.equal(ncm.isStreamBackoffActive(), false);
    assert.deepEqual(events, [], 'optional metadata is not audio-resource failure evidence');
    assert.equal(await ncm.songUrl('901'), 'https://audio.test/901.mp3');
    assert.equal(calls.at(-1), '/song/url/v1');
  });
}

// —— 风控不得当作单曲不可播，也不得以降音质继续放大请求 ——
for (const [status, code] of [[400, -460], [200, -460], [429, 429], [200, 429]]) {
  test(`NCM risk response ${status}/${code} is sanitized and stops quality fallback`, async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ code, message: 'provider-private-text', cookie: 'MUSIC_U=secret' }), { status });
    };
    await assert.rejects(ncm.songUrl('risk-track'), error => {
      assert.equal(error.code, 'rate-limited');
      assert.equal(error.message, 'rate-limited');
      assert.doesNotMatch(JSON.stringify(error), /secret|provider-private-text/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('stream backoff covers other songs, does not slide, and expires without automatic requests', async t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ code: -460 }), { status: 400 })
      : new Response(JSON.stringify({ data: [{ url: 'https://audio.test/recovered' }] }));
  };
  await assert.rejects(ncm.songUrl('first'), { code: 'rate-limited' });
  now += 29_999;
  await assert.rejects(ncm.songUrl('another'), { code: 'rate-limited' });
  assert.equal(calls, 1);
  now += 1;
  assert.equal(calls, 1, 'expiry does not schedule work');
  assert.equal(await ncm.songUrl('another'), 'https://audio.test/recovered');
  assert.equal(calls, 2, 'blocked calls must not extend the original deadline');
});

test('stream backoff leaves login and metadata usable and never claims expired credentials', async () => {
  const events = [];
  setSourceHealthReporter((source, code) => events.push({ source, code }));
  globalThis.fetch = async url => String(url).includes('/song/url/v1')
    ? new Response(JSON.stringify({ code: -460 }), { status: 400 })
    : new Response(JSON.stringify({ result: { songs: [] }, data: { account: { id: 1 }, profile: {} } }));
  ncm.setCookie('MUSIC_U=fixture');
  await assert.rejects(ncm.songUrl('first'), { code: 'rate-limited' });
  assert.deepEqual(await ncm.search('query'), []);
  assert.equal((await ncm.loginStatus()).loggedIn, true);
  assert.ok(events.some(event => event.code === 'rate-limited'));
  assert.ok(events.every(event => event.code !== 'requires-auth'));
  await assert.rejects(ncm.songUrl('still-blocked'), { code: 'rate-limited' });
});

test('unrelated HTTP 400 keeps existing fallback rather than claiming risk', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ code: 400, message: 'invalid request' }), { status: 400 });
  };
  await assert.rejects(ncm.songUrl('bad-request'), error => error.code !== 'rate-limited');
  assert.equal(calls, 4);
});

for (const replace of ['cookie', 'base']) {
  test(`late risk response cannot arm replacement ${replace} backoff`, async () => {
    const previousBase = ncm.getBaseUrl();
    let finish;
    ncm.setCookie('MUSIC_U=old');
    globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
    const pending = ncm.songUrl('old-track');
    const rejected = assert.rejects(pending);
    try {
      if (replace === 'cookie') ncm.setCookie('MUSIC_U=new');
      else ncm.setBaseUrl('http://127.0.0.1:3019');
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ url: 'https://audio.test/new' }] }));
      finish(new Response(JSON.stringify({ code: -460 }), { status: 400 }));
      await rejected;
      assert.equal(await ncm.songUrl('new-track'), 'https://audio.test/new');
    } finally {
      ncm.setBaseUrl(previousBase);
    }
  });
}

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
