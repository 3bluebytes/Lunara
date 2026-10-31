import test from 'node:test';
import assert from 'node:assert/strict';
import * as resolver from './musicResolver.js';

function fixture({ url = null, remembered = null, throws = false, artwork = null } = {}) {
  const calls = [], traces = [];
  const provider = name => ({
    songUrl: async id => { calls.push([name, 'url', id]); if (throws) throw new Error('https://secret.test?cookie=private'); return url; },
    lyric: async id => { calls.push([name, 'lyric', id]); return { lrc: '' }; },
    cacheAudio: async (id, value) => { calls.push([name, 'cache', id]); return { url: value }; },
    resolveQuery: async () => { calls.push([name, 'search']); return { ok: true, song_id: 'other', title: '替换版', artist: '歌手', url: '/other.mp3' }; },
  });
  assert.equal(typeof resolver.createMusicResolver, 'function');
  const resolve = resolver.createMusicResolver({ providers: { qq: provider('qq'), ncm: provider('ncm') },
    findRememberedIdentity: () => remembered, findRememberedTrack: () => null,
    rememberTracks: () => {}, maybeAutoTag: () => {}, trace: event => traces.push(event),
    // 封面补全默认用替身，测试不碰真实封面缓存与网络。
    resolveArtwork: async () => artwork });
  return { resolve, calls, traces };
}
const candidate = { sourceSongId: 'locked', evidence: { source: 'qq' },
  orderedTarget: { songId: 'locked', source: 'qq', title: '原版', artist: '歌手' } };

test('locked canonical resolution directly requests the selected identity without a remembered cache hit', async () => {
  const h = fixture({ url: '/locked.mp3' });
  const result = await h.resolve('歌手 — 原版', { candidate, primarySource: 'ncm' });
  assert.equal(result.ok, true);
  assert.equal(result.song_id, 'locked');
  assert.equal(result.source, 'qq');
  assert.equal(result.title, '原版');
  assert.deepEqual(h.calls, [['qq', 'url', 'locked'], ['qq', 'lyric', 'locked'], ['qq', 'cache', 'locked']]);
});

test('locked URL failures never search for replacement versions and never expose raw errors', async () => {
  for (const throws of [false, true]) {
    const h = fixture({ throws, remembered: { provider: 'qq', song_id: 'locked', title: '原版', artist: '歌手' } });
    const result = await h.resolve('歌手 — 原版', { candidate });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'canonical-resource-unavailable');
    assert.equal(h.calls.some(call => call[1] === 'search'), false);
    assert.doesNotMatch(JSON.stringify({ result, traces: h.traces }), /secret|cookie|private|https:/);
  }
});

test('locked resolution keeps authoritative remembered metadata when a candidate names a different version', async () => {
  const h = fixture({ url: '/locked.mp3', remembered: {
    provider: 'qq', song_id: 'locked', title: '原版 (Live)', artist: '真实歌手', album: 'Live',
  } });
  const result = await h.resolve('歌手 — 原版', { candidate });
  assert.equal(result.title, '原版 (Live)');
  assert.equal(result.artist, '真实歌手');
  assert.equal(result.album, 'Live');
  assert.equal(h.calls.some(call => call[1] === 'search'), false);
});

test('invalid locked provider fails closed while an unlocked query retains search fallback', async () => {
  const h = fixture();
  const rejected = await h.resolve('歌手 — 原版', { candidate: { ...candidate, evidence: { source: 'unknown' } } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'canonical-provider-invalid');
  assert.deepEqual(h.calls, []);
  const found = await h.resolve('歌手 — 原版', { primarySource: 'ncm' });
  assert.equal(found.song_id, 'other');
  assert.deepEqual(h.calls, [['ncm', 'search']]);
});

test('known track duration is forwarded to the media asset cache for integrity checks', async () => {
  const cached = [];
  const providers = {
    qq: {
      songUrl: async () => 'https://provider.test/stream',
      lyric: async () => ({ lrc: '' }),
      cacheAudio: async (id, url, options) => { cached.push([id, url, options]); return { url: '/audio/x.mp3' }; },
      resolveQuery: async () => ({ ok: false }),
    },
    ncm: { songUrl: async () => null, lyric: async () => ({}), cacheAudio: async () => null, resolveQuery: async () => ({ ok: false }) },
  };
  const resolve = resolver.createMusicResolver({
    providers,
    findRememberedIdentity: () => null,
    findRememberedTrack: () => null,
    rememberTracks: () => {},
    maybeAutoTag: () => {},
    trace: () => {},
  });
  const result = await resolve('歌手 — 歌名', {
    candidate: { sourceSongId: 'locked', evidence: { source: 'qq' }, orderedTarget: { songId: 'locked', source: 'qq' } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(cached, [['locked', 'https://provider.test/stream', { expectedDurationSeconds: 0 }]]);
});

const COVER = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000001bkv9c0gpIvm.jpg';

test('canonical resolution fills a missing cover for a library-sourced track', async () => {
  const h = fixture({ url: '/locked.mp3', artwork: COVER });
  const result = await h.resolve('歌手 — 原版', { candidate });
  assert.equal(result.ok, true);
  assert.equal(result.artwork, COVER);
});

test('a cover lookup failure never changes playability', async () => {
  const calls = [];
  const provider = name => ({
    songUrl: async () => '/locked.mp3',
    lyric: async () => ({ lrc: '' }),
    cacheAudio: async (id, value) => ({ url: value }),
    resolveQuery: async () => ({ ok: false }),
  });
  const resolve = resolver.createMusicResolver({
    providers: { qq: provider('qq'), ncm: provider('ncm') },
    findRememberedIdentity: () => null, findRememberedTrack: () => null,
    rememberTracks: () => {}, maybeAutoTag: () => {}, trace: () => {},
    resolveArtwork: async (providerName, songId) => { calls.push([providerName, songId]); throw new Error('timeout'); },
  });
  const result = await resolve('歌手 — 原版', { candidate });
  assert.equal(result.ok, true);
  assert.equal(result.artwork, '');
  assert.deepEqual(calls, [['qq', 'locked']]);
});

test('an existing cover is never re-queried', async () => {
  const seen = [];
  const provider = name => ({
    songUrl: async () => '/locked.mp3',
    lyric: async () => ({ lrc: '' }),
    cacheAudio: async (id, value) => ({ url: value }),
    resolveQuery: async () => ({ ok: false }),
  });
  const resolve = resolver.createMusicResolver({
    providers: { qq: provider('qq'), ncm: provider('ncm') },
    findRememberedIdentity: () => null, findRememberedTrack: () => null,
    rememberTracks: () => {}, maybeAutoTag: () => {}, trace: () => {},
    resolveArtwork: async (providerName, songId) => { seen.push([providerName, songId]); return COVER; },
  });
  const result = await resolve('歌手 — 原版', { candidate: {
    ...candidate, orderedTarget: { ...candidate.orderedTarget, artwork: COVER } } });
  assert.equal(result.artwork, COVER);
  assert.deepEqual(seen, []);
});

test('every source failure keeps its own reason code instead of collapsing into one sentence', async () => {
  const providers = {
    qq: { resolveQuery: async () => ({ ok: false, code: 'requires-member', source: 'qq' }) },
    ncm: { resolveQuery: async () => ({ ok: false, code: 'not-found', source: 'ncm' }) },
  };
  const resolve = resolver.createMusicResolver({
    providers, findRememberedIdentity: () => null, findRememberedTrack: () => null,
    rememberTracks: () => {}, maybeAutoTag: () => {}, trace: () => {},
  });
  const result = await resolve('周杰伦 — 晴天', { primarySource: 'qq' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'all-sources-failed');
  // 主源说需要会员、次源说没有 —— 这首歌其实存在，顶层原因是「需要会员」。
  assert.equal(result.code, 'requires-member');
  assert.deepEqual(result.failures, [
    { source: 'qq', code: 'requires-member' },
    { source: 'ncm', code: 'not-found' },
  ]);
  assert.deepEqual(result.tried, ['qq', 'ncm']);
});

test('a thrown provider error is classified, and its raw text never reaches the result', async () => {
  const leak = 'https://provider.test/x?cookie=SID%3Dsecret /Users/me/.lunara';
  const providers = {
    qq: { resolveQuery: async () => { throw new Error(`login required ${leak}`); } },
    ncm: { resolveQuery: async () => { throw new Error('unexpected upstream shape'); } },
  };
  const traces = [];
  const resolve = resolver.createMusicResolver({
    providers, findRememberedIdentity: () => null, findRememberedTrack: () => null,
    rememberTracks: () => {}, maybeAutoTag: () => {}, trace: event => traces.push(event),
  });
  const result = await resolve('歌名', { primarySource: 'qq' });
  assert.equal(result.code, 'requires-auth');
  assert.deepEqual(result.failures, [
    { source: 'qq', code: 'requires-auth' },
    { source: 'ncm', code: 'internal' },
  ]);
  assert.doesNotMatch(JSON.stringify({ result, traces }), /cookie|secret|https?:|\/Users\//i);
});

test('absent candidates end as not-found rather than as a guess', async () => {
  const providers = {
    qq: { resolveQuery: async () => ({ ok: false, code: 'not-found' }) },
    ncm: { resolveQuery: async () => ({ ok: false, code: 'not-found' }) },
  };
  const resolve = resolver.createMusicResolver({
    providers, findRememberedIdentity: () => null, findRememberedTrack: () => null,
    rememberTracks: () => {}, maybeAutoTag: () => {}, trace: () => {},
  });
  const result = await resolve('不存在的歌', { primarySource: 'qq' });
  assert.equal(result.code, 'not-found');
});

test('a thrown URL request reports its transient category instead of not-playable', async () => {
  const h = fixture({ throws: true });
  const result = await h.resolve('歌手 — 原版', { candidate });
  assert.equal(result.error, 'canonical-resource-unavailable');
  assert.notEqual(result.code, 'not-playable');
  const empty = await fixture({ url: null }).resolve('歌手 — 原版', { candidate });
  assert.equal(empty.code, 'not-playable');
});

test('a failed media cache hands the player a same-origin relay, never the vendor url', async () => {
  const providers = {
    qq: {
      songUrl: async () => 'https://aqqmusic.tc.qq.com/x.flac?vkey=SECRET&uin=1002195734',
      lyric: async () => ({ lrc: '' }),
      // 缓存失败：跨源直链一旦交给播放器，Web Audio 图会把它静音播完。
      cacheAudio: async () => null,
      resolveQuery: async () => ({ ok: false }),
    },
    ncm: { songUrl: async () => null, lyric: async () => ({}), cacheAudio: async () => null, resolveQuery: async () => ({ ok: false }) },
  };
  const resolve = resolver.createMusicResolver({
    providers,
    findRememberedIdentity: () => null,
    findRememberedTrack: () => null,
    rememberTracks: () => {},
    maybeAutoTag: () => {},
    trace: () => {},
    resolveArtwork: async () => '',
  });
  const result = await resolve('周杰伦 — 你比从前快乐', {
    candidate: { sourceSongId: 'locked', evidence: { source: 'qq' }, orderedTarget: { songId: 'locked', source: 'qq' } },
  });
  assert.equal(result.ok, true);
  assert.match(result.url, /^\/remote-audio\/[A-Za-z0-9_-]+\.mp3$/);
  assert.doesNotMatch(result.url, /vkey|uin=|aqqmusic|https?:/);
  assert.equal(result.cached, false);
});
