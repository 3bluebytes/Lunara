import assert from 'node:assert/strict';
import test from 'node:test';
import { createMusicResolver } from '../server/musicResolver.js';
import { createSourceHealthWiring } from '../server/app/createSourceHealthWiring.js';
import { resetSourceHealthReporter, setSourceHealthReporter } from '../server/music/sourceHealthSignal.js';
import { SOURCE_FAILURE } from '../server/music/sourceFailure.js';

const quiet = () => {};
const provider = (resolveQuery) => ({ resolveQuery, songUrl: async () => 'http://x/a.mp3', lyric: async () => '', cacheAudio: async () => null });

function resolverWith(providers) {
  return createMusicResolver({
    providers,
    findRememberedIdentity: () => null,
    findRememberedTrack: () => null,
    rememberTracks: quiet,
    maybeAutoTag: quiet,
    resolveArtwork: async () => '',
    trace: quiet,
  });
}

test('a failed search records the classified reason, not a ready state', async () => {
  resetSourceHealthReporter();
  const reported = [];
  setSourceHealthReporter((id, code) => reported.push([id, code]));
  const resolve = resolverWith({
    qq: provider(async () => ({ ok: false, code: SOURCE_FAILURE.REQUIRES_MEMBER })),
    ncm: provider(async () => ({ ok: true, url: 'http://x/n.mp3', song_id: 'n1', title: 'T', artist: 'A' })),
  });
  const result = await resolve('T A', { primarySource: 'qq' });
  assert.equal(result.ok, true);
  assert.deepEqual(reported, [['qq', SOURCE_FAILURE.REQUIRES_MEMBER], ['ncm', null]]);
  resetSourceHealthReporter();
});

test('a thrown provider error is attributed without leaking its text', async () => {
  resetSourceHealthReporter();
  const reported = [];
  setSourceHealthReporter((id, code) => reported.push([id, code]));
  const resolve = resolverWith({
    qq: provider(async () => { throw new Error('cookie=SECRET 401'); }),
    ncm: provider(async () => ({ ok: false, code: SOURCE_FAILURE.NOT_FOUND })),
  });
  await resolve('T A', { primarySource: 'qq' });
  assert.deepEqual(reported, [['qq', SOURCE_FAILURE.REQUIRES_AUTH], ['ncm', SOURCE_FAILURE.NOT_FOUND]]);
  resetSourceHealthReporter();
});

test('an unwired or non-playable provider is a wiring bug, not source unhealth', async () => {
  resetSourceHealthReporter();
  const reported = [];
  setSourceHealthReporter((id, code) => reported.push([id, code]));
  const resolve = resolverWith({ ncm: provider(async () => ({ ok: false, code: SOURCE_FAILURE.NOT_FOUND })) });
  await resolve('T A', { primarySource: 'qq' });
  assert.deepEqual(reported, [['ncm', SOURCE_FAILURE.NOT_FOUND]], 'qq 缺实现不应被记成该源不可用');
  resetSourceHealthReporter();
});

test('a reporting failure never changes the resolution result', async () => {
  resetSourceHealthReporter();
  setSourceHealthReporter(() => { throw new Error('boom'); });
  const resolve = resolverWith({ qq: provider(async () => ({ ok: true, url: 'http://x/a.mp3', song_id: 'q1', title: 'T', artist: 'A' })) });
  const result = await resolve('T A', { primarySource: 'qq' });
  assert.equal(result.ok, true);
  resetSourceHealthReporter();
});

test('the settings snapshot stops claiming ready once a real attempt failed', async () => {
  resetSourceHealthReporter();
  const wiring = createSourceHealthWiring({ providers: {} });
  const resolve = resolverWith({ qq: provider(async () => { throw new Error('ECONNREFUSED 127.0.0.1:3300'); }) });
  await resolve('T A', { primarySource: 'qq' });
  const snapshot = await wiring.snapshot();
  const qq = snapshot.find(row => row.id === 'qq');
  // state 直接就是封闭原因码：界面据此决定「去登录 / 去订阅 / 稍后重试」。
  assert.equal(qq.state, SOURCE_FAILURE.UNAVAILABLE);
  assert.equal(typeof qq.since, 'number');
  assert.doesNotMatch(JSON.stringify(snapshot), /3300|ECONNREFUSED/, 'snapshot keeps no raw diagnostics');
  // 一次成功就恢复：用户的下一步操作应当立刻看到效果。
  const recovered = resolverWith({ qq: provider(async () => ({ ok: true, url: 'http://x/a.mp3', song_id: 'q1', title: 'T', artist: 'A' })) });
  await recovered('T A', { primarySource: 'qq' });
  const after = await wiring.snapshot();
  assert.equal(after.find(row => row.id === 'qq').state, 'ready');
  resetSourceHealthReporter();
});
