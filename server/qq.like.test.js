import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeAG1Request } from '@jixun/qmweb-sign';

// QQ「我喜欢」双向写入契约。2026-03 在真实账号上逐条回读确认过的事实：
//   · 「我喜欢」= dirId 201，加歌/删歌是同一 module 的两个 method，都幂等；
//   · 明文 musicu.fcg 能读、能改普通歌单，但往 201 加歌一律 80105；
//   · 同一请求走签名通道（musics.fcg + ag-1 + zzc sign）就成功并被读回 true。
// 所以这里断言的是「写走签名通道、读走明文」，且 fake transport 不联网。
// 真实账号的双向验收见 scripts/verify-track-like.mjs。
import {
  createQqMusicProvider,
  buildQqMusicuComm,
  qqGtkFromPSkey,
  QQ_LIKED_DIRID,
  QQ_SONG_TYPE_NORMAL,
} from './qq.js';
import { QQ_SIGNED_ENDPOINT } from './music/qqWebSign.js';

const COOKIE = 'uin=1234567890; qm_keyst=SECRET-AUTHST; qqmusic_key=SECRET-ALIAS; p_skey=SECRET-PSKEY';
const MID = '0039MnYb0qxYhV';

function detailResponse({ id = 97773, type = 0 } = {}) {
  return { code: 0, data: [{ id, mid: MID, type, name: '晴天' }] };
}

function providerWith({ signed, musicu, detail = detailResponse(), cookie = COOKIE, allowLikeWrite } = {}) {
  const writes = [];
  const reads = [];
  const provider = createQqMusicProvider({
    getCookieValue: () => cookie,
    songDetailApi: async () => detail,
    ...(allowLikeWrite === undefined ? {} : { allowLikeWrite }),
    signedMusicuFetch: async request => {
      writes.push(request);
      return signed ? signed(request) : { code: 0, req_1: { code: 0 } };
    },
    musicuFetch: async request => {
      reads.push(request);
      return musicu ? musicu(request) : { code: 0, req_1: { code: 0, data: { m_fan: {} } } };
    },
  });
  return { provider, writes, reads };
}

test('liking writes to dirId 201 through the signed transport', async () => {
  const { provider, writes, reads } = providerWith();

  assert.deepEqual(await provider.setSongLiked(MID, true), { ok: true, state: 'liked' });
  assert.equal(reads.length, 0, '写不走明文通道');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].module, 'music.musicasset.PlaylistDetailWrite');
  assert.equal(writes[0].method, 'AddSonglist');
  // songType 就是正常单曲的 0：502 首真实收藏逐条打出来都是 0。
  assert.deepEqual(writes[0].param, { dirId: 201, v_songInfo: [{ songType: 0, songId: 97773 }] });
  assert.equal(QQ_LIKED_DIRID, 201);
  assert.equal(QQ_SONG_TYPE_NORMAL, 0);
});

test('unliking is the same request with DelSonglist — the remove path exists', async () => {
  const { provider, writes } = providerWith();

  assert.deepEqual(await provider.setSongLiked(MID, false), { ok: true, state: 'unliked' });
  assert.equal(writes[0].method, 'DelSonglist');
  assert.deepEqual(writes[0].param, { dirId: 201, v_songInfo: [{ songType: 0, songId: 97773 }] });
});

test('like write is on by default and can be killed by env/config', async () => {
  const defaultOn = providerWith();
  assert.equal((await defaultOn.provider.setSongLiked(MID, true)).ok, true);

  const killed = providerWith({ allowLikeWrite: false });
  assert.deepEqual(await killed.provider.setSongLiked(MID, true), {
    ok: false, reason: 'unsupported', detail: 'qq-like-write-disabled', code: null,
  });
  assert.equal(killed.writes.length, 0);
  // 只读状态不受影响：它不走写通道。
  assert.deepEqual(await killed.provider.isSongLiked(MID), { ok: true, liked: false });
});

test('writes require a login and never call the transport when the cookie is missing', async () => {
  const { provider, writes, reads } = providerWith({ cookie: '' });

  assert.deepEqual(await provider.setSongLiked(MID, true), { ok: false, reason: 'not_logged_in' });
  assert.deepEqual(await provider.isSongLiked(MID), { ok: false, reason: 'not_logged_in' });
  assert.equal(writes.length + reads.length, 0);
});

test('an unresolved numeric identity fails closed instead of guessing a songId', async () => {
  const { provider, writes } = providerWith({ detail: { code: 0, data: [] } });

  assert.deepEqual(await provider.setSongLiked(MID, true), { ok: false, reason: 'unresolved_song' });
  assert.equal(writes.length, 0);
});

test('the SDK-shaped { response: { data } } detail payload still resolves', async () => {
  const { provider, writes } = providerWith({ detail: { code: 0, response: detailResponse({ id: 42, type: 0 }) } });

  assert.deepEqual(await provider.setSongLiked(MID, true), { ok: true, state: 'liked' });
  assert.deepEqual(writes[0].param.v_songInfo, [{ songType: 0, songId: 42 }]);
});

test('a non-zero song type from metadata is preserved instead of forced to 0', async () => {
  const { provider, writes } = providerWith({ detail: detailResponse({ id: 42, type: 11 }) });

  await provider.setSongLiked(MID, true);
  assert.deepEqual(writes[0].param.v_songInfo, [{ songType: 11, songId: 42 }]);
});

test('code 1000 from the module means the login expired, not success', async () => {
  const { provider } = providerWith({ signed: async () => ({ code: 0, req_1: { code: 1000 } }) });

  assert.deepEqual(await provider.setSongLiked(MID, true), { ok: false, reason: 'not_logged_in', code: 1000 });
});

test('80105 means the song is not collectable — it is not retried with another type', async () => {
  const { provider, writes } = providerWith({ signed: async () => ({ code: 0, req_1: { code: 80105 } }) });

  assert.deepEqual(await provider.setSongLiked(MID, true), { ok: false, reason: 'not_collectable', code: 80105 });
  assert.equal(writes.length, 1);
});

test('other module codes and transport errors are attributed, never thrown', async () => {
  const failing = providerWith({ signed: async () => ({ code: 0, req_1: { code: 4 } }) });
  assert.deepEqual(await failing.provider.setSongLiked(MID, true), { ok: false, reason: 'request_failed', code: 4 });

  const throwing = providerWith({ signed: async () => { throw new Error('socket hang up'); } });
  assert.deepEqual(await throwing.provider.setSongLiked(MID, true), { ok: false, reason: 'request_failed', code: null });
});

test('batched likes travel in one request and stop at the server-side limit of 50', async () => {
  const mids = Array.from({ length: 60 }, (_, index) => `mid-${index}`);
  let nextId = 1000;
  const writes = [];
  const provider = createQqMusicProvider({
    getCookieValue: () => COOKIE,
    songDetailApi: async () => detailResponse({ id: (nextId += 1), type: 0 }),
    signedMusicuFetch: async request => {
      writes.push(request);
      return { code: 0, req_1: { code: 0 } };
    },
    musicuFetch: async () => ({ code: 0, req_1: { code: 0, data: { m_fan: {} } } }),
  });

  const result = await provider.setSongsLiked(mids, true);
  assert.equal(result.ok, true);
  assert.equal(result.songs, 50);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'AddSonglist');
  assert.equal(writes[0].param.v_songInfo.length, 50);

  // 身份解析不出来的曲目不会被编造进请求。
  const unresolved = createQqMusicProvider({
    getCookieValue: () => COOKIE,
    songDetailApi: async () => ({ code: 0, data: [] }),
    signedMusicuFetch: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(await unresolved.setSongsLiked(['mid-a'], true), { ok: false, reason: 'unresolved_song' });
});

test('isSongLiked and IsSongFanByMid stay on the plain read channel', async () => {
  const liked = providerWith({ musicu: async () => ({ code: 0, req_1: { code: 0, data: { m_fan: { [MID]: true } } } }) });
  assert.deepEqual(await liked.provider.isSongLiked(MID), { ok: true, liked: true });
  assert.equal(liked.reads[0].module, 'music.musicasset.SongFavRead');
  assert.equal(liked.reads[0].method, 'IsSongFanByMid');
  assert.deepEqual(liked.reads[0].param, { v_songMid: [MID] });
  assert.equal(liked.writes.length, 0);

  const batch = providerWith({ musicu: async () => ({ code: 0, req_1: { code: 0, data: { m_fan: { [MID]: false } } } }) });
  assert.deepEqual((await batch.provider.isSongLikedBatch([MID, MID])).liked.size, 0);
  assert.deepEqual(batch.reads[0].param.v_songMid, [MID], '重复 mid 去重后再问');
});

test('the default signed transport strips credentials from the URL and signs what it sends', async () => {
  const originalFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: 0, req_1: { code: 0 } }), { status: 200 });
  };
  try {
    const provider = createQqMusicProvider({
      getCookieValue: () => COOKIE,
      songDetailApi: async () => detailResponse(),
    });
    assert.deepEqual(await provider.setSongLiked(MID, true), { ok: true, state: 'liked' });

    const [{ url, init }] = captured;
    assert.ok(url.startsWith(QQ_SIGNED_ENDPOINT));
    assert.match(url, /encoding=ag-1&sign=zzc/);
    assert.ok(!url.includes('SECRET'));
    assert.ok(!url.includes('1234567890'));
    assert.equal(init.headers.cookie, COOKIE);
    assert.equal(init.headers['content-type'], 'text/plain');

    const payload = JSON.parse(await decodeAG1Request(String(init.body)));
    assert.equal(payload.req_1.module, 'music.musicasset.PlaylistDetailWrite');
    assert.equal(payload.req_1.method, 'AddSonglist');
    assert.equal(payload.comm.uin, '1234567890');
    assert.equal(payload.comm.authst, 'SECRET-AUTHST');
    assert.equal(payload.comm.g_tk, qqGtkFromPSkey('SECRET-AUTHST'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('comm takes authst and g_tk from qm_keyst, falling back to qqmusic_key/p_skey', () => {
  const comm = buildQqMusicuComm(COOKIE);
  assert.equal(comm.authst, 'SECRET-AUTHST');
  assert.equal(comm.g_tk, qqGtkFromPSkey('SECRET-AUTHST'));
  assert.equal(comm.g_tk_new_20200303, comm.g_tk);
  assert.equal(comm.uin, '1234567890');
  assert.equal(comm.needNewCode, 1);

  const legacy = buildQqMusicuComm('uin=1; qqmusic_key=ALIAS-ONLY; p_skey=PSKEY-ONLY');
  assert.equal(legacy.authst, 'ALIAS-ONLY');
  assert.equal(legacy.g_tk, qqGtkFromPSkey('PSKEY-ONLY'));
  assert.equal(qqGtkFromPSkey(''), 0);
});
