import assert from 'node:assert/strict';
import test from 'node:test';
import * as ncm from './ncm.js';
import { createMusicResolver } from './musicResolver.js';
import { createSourceHealthWiring } from './app/createSourceHealthWiring.js';
import { resetSourceHealthReporter } from './music/sourceHealthSignal.js';

test('real NCM risk handling reaches source warnings through canonical resolution, and recovers only on success', async t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const originalFetch = globalThis.fetch;
  const wiring = createSourceHealthWiring({ providers: {} });
  const events = [];
  const unsubscribe = wiring.subscribe(event => events.push(event));
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ code: -460, message: 'private-provider-text', cookie: 'private-cookie' }), { status: 400 })
      : new Response(JSON.stringify({ data: [{ url: 'https://audio.test/full.mp3' }] }));
  };
  const resolve = createMusicResolver({
    providers: { ncm: { ...ncm, lyric: async () => '', cacheAudio: async () => null } },
    getSourcePolicy: () => ({ mode: 'multi', sources: ['ncm', 'qq'] }),
    findRememberedIdentity: () => null,
    rememberTracks: () => {}, maybeAutoTag: () => {}, trace: () => {}, resolveArtwork: async () => '',
  });
  const candidate = id => ({ sourceSongId: id, evidence: { source: 'ncm' }, orderedTarget: { title: 'Fixture', artist: 'Artist' } });
  try {
    ncm.setCookie('MUSIC_U=fixture');
    const first = await resolve('Fixture', { candidate: candidate('1') });
    assert.equal(first.ok, false);
    assert.equal(first.code, 'rate-limited');
    assert.deepEqual(wiring.sourceIssues(), [{ source: 'ncm', displayName: '网易云音乐', code: 'rate-limited' }]);
    const second = await resolve('Fixture', { candidate: candidate('2') });
    assert.equal(second.code, 'rate-limited');
    assert.equal(calls, 1);
    assert.equal(events.length, 1, 'repeated errors produce one persistent source warning');
    assert.doesNotMatch(JSON.stringify({ first, second, events }), /private-/);
    now += 30_000;
    assert.equal(wiring.sourceIssues().length, 1, 'expiry alone cannot assert source recovery');
    const recovered = await resolve('Fixture', { candidate: candidate('2') });
    assert.equal(recovered.ok, true);
    assert.equal(calls, 2);
    assert.deepEqual(wiring.sourceIssues(), []);
    assert.equal(events.at(-1).code, null);
  } finally {
    ncm.clearCookie();
    globalThis.fetch = originalFetch;
    unsubscribe();
    resetSourceHealthReporter();
  }
});

test('optional lyric risk cannot poison canonical playback health when WEAPI audio succeeds', async () => {
  const originalFetch = globalThis.fetch;
  const wiring = createSourceHealthWiring({ providers: { ncm } });
  const events = [];
  const unsubscribe = wiring.subscribe(event => events.push(event.code));
  globalThis.fetch = async url => new URL(String(url)).pathname === '/lyric'
    ? new Response(JSON.stringify({ code: -460 }), { status: 400 })
    : new Response(JSON.stringify({ data: [{ id: 901, url: 'https://audio.test/901.mp3' }] }));
  const resolve = createMusicResolver({
    providers: { ncm: { ...ncm, cacheAudio: async () => null } },
    getSourcePolicy: () => ({ mode: 'single', sources: ['ncm'] }),
    findRememberedIdentity: () => null,
    rememberTracks() {}, maybeAutoTag() {}, trace() {}, resolveArtwork: async () => '',
  });
  try {
    ncm.setCookie('MUSIC_U=fixture');
    const result = await resolve('Fixture', { candidate: { sourceSongId: '901', evidence: { source: 'ncm' },
      orderedTarget: { title: 'Fixture', artist: 'Artist' } } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.lyric, { lrc: '', tlyric: '' });
    assert.equal(ncm.isStreamBackoffActive(), false);
    assert.deepEqual(wiring.sourceIssues(), []);
    assert.deepEqual(events, []);
  } finally {
    ncm.clearCookie(); globalThis.fetch = originalFetch;
    unsubscribe(); resetSourceHealthReporter();
  }
});

for (const path of ['canonical', 'search']) {
  test(`late ${path} success cannot clear newer risk, even after caching completes`, async t => {
    let now = 100_000;
    t.mock.method(Date, 'now', () => now);
    const originalFetch = globalThis.fetch;
    const wiring = createSourceHealthWiring({ providers: { ncm } });
    const events = [];
    const unsubscribe = wiring.subscribe(event => events.push(event.code));
    let finishCache, cacheStarted;
    const cacheWaiting = new Promise(resolve => { finishCache = resolve; });
    const ready = new Promise(resolve => { cacheStarted = resolve; });
    const cacheAudio = async () => { cacheStarted(); await cacheWaiting; return null; };
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 2
        ? new Response(JSON.stringify({ code: -460 }), { status: 400 })
        : new Response(JSON.stringify({ data: [{ url: 'https://audio.test/full.mp3' }] }));
    };
    const source = { ...ncm, lyric: async () => '', cacheAudio,
      resolveQuery: async () => {
        const url = await ncm.songUrl('old');
        await cacheAudio();
        return { ok: true, url, song_id: 'old', title: 'Fixture', artist: 'Artist' };
      },
    };
    const resolve = createMusicResolver({ providers: { ncm: source },
      getSourcePolicy: () => ({ mode: 'single', sources: ['ncm'] }),
      getCollectionTracks: () => [], getRememberedCollectionTracks: () => [],
      findRememberedTrack: () => null, findRememberedIdentity: () => null,
      rememberTracks() {}, maybeAutoTag() {}, trace() {}, resolveArtwork: async () => '',
    });
    const candidate = id => ({ sourceSongId: id, evidence: { source: 'ncm' }, orderedTarget: { title: 'Fixture', artist: 'Artist' } });
    let old;
    try {
      ncm.setCookie('MUSIC_U=race-fixture');
      old = resolve('Fixture', path === 'canonical' ? { candidate: candidate('old') } : {});
      await ready;
      assert.equal((await resolve('Fixture', { candidate: candidate('new') })).code, 'rate-limited');
      finishCache();
      assert.equal((await old).ok, true, 'valid old track remains usable');
      assert.deepEqual(events, ['rate-limited'], 'late success must not emit false recovery');
      assert.equal(wiring.sourceIssues()[0].code, 'rate-limited');
      assert.equal((await resolve('Fixture', { candidate: candidate('blocked') })).code, 'rate-limited');
      assert.equal(calls, 2, 'the blocked attempt did not call the provider');
      assert.deepEqual(events, ['rate-limited'], 'no restricted/recovered/restricted flicker');
      now += 30_000;
      assert.equal((await resolve('Fixture', { candidate: candidate('fresh') })).ok, true);
      assert.deepEqual(events, ['rate-limited', null], 'only fresh post-backoff evidence can recover');
    } finally {
      finishCache();
      await old;
      ncm.clearCookie();
      globalThis.fetch = originalFetch;
      unsubscribe();
      resetSourceHealthReporter();
    }
  });
}
