import assert from 'node:assert/strict';
import test from 'node:test';
import { createQqMusicProvider, parseUinFromCookie } from './qq.js';
import { resetSourceHealthReporter, setSourceHealthReporter } from './music/sourceHealthSignal.js';

function response(payload, { wrapper = 'response', status = 200 } = {}) {
  return { status, body: { [wrapper]: payload } };
}

const encodeLyric = text => Buffer.from(text).toString('base64');

test('QQ decodes translated LRC without decoding readable original twice', async () => {
  const lrc = '[00:01]中文 / 日本語 / café';
  const translated = '[00:01]translated text';
  const provider = createQqMusicProvider({ lyricApi: async () => response({ lyric: lrc, trans: encodeLyric(translated) }),
    musicuFetch: async () => { throw new Error('must not recover valid LRC'); } });
  assert.deepEqual(await provider.lyric('mid'), { lrc, tlyric: translated });
});

test('QQ recovers SDK ciphertext once using crypt:0 and the same song identity', async () => {
  const calls = [];
  const lrc = '[00:01]合成原词';
  const translated = '[00:01]合成译词';
  const provider = createQqMusicProvider({
    getCookieValue: () => 'uin=42; qqmusic_key=test-only',
    lyricApi: async () => response({ crypt: 1, lyric: Buffer.from('deadbeef'.repeat(50), 'base64').toString('utf8') }),
    musicuFetch: async input => {
      calls.push(input);
      return { code: 0, req_1: { code: 0, data: { crypt: 0, lyric: encodeLyric(lrc), trans: encodeLyric(translated) } } };
    },
  });
  assert.deepEqual(await provider.lyric('same-mid'), { lrc, tlyric: translated });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].module, 'music.musichallSong.PlayLyricInfo');
  assert.equal(calls[0].method, 'GetPlayLyricInfo');
  assert.equal(calls[0].param.songMID, 'same-mid');
  assert.equal(calls[0].param.crypt, 0);
  assert.equal(calls[0].cookie, 'uin=42; qqmusic_key=test-only');
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test('QQ recovery failures omit damaged fields but preserve independently valid fields', async () => {
  const lrc = '[00:01]valid original';
  for (const action of [
    () => { throw new Error('PRIVATE_UPSTREAM'); },
    () => ({ code: 1000, req_1: { code: 0, data: { lyric: encodeLyric('[00:01]wrong') } } }),
    () => ({ code: 0, req_1: { code: -1, data: { lyric: encodeLyric('[00:01]wrong') } } }),
    () => ({ code: 0, req_1: { code: 0, data: { crypt: 1, lyric: 'deadbeef'.repeat(50) } } }),
    () => ({ code: 0, req_1: { code: 0, data: { retcode: -1, lyric: encodeLyric('[00:01]wrong') } } }),
  ]) {
    let attempts = 0;
    const provider = createQqMusicProvider({
      lyricApi: async () => response({ lyric: lrc, trans: 'bad�translation' }),
      musicuFetch: async () => { attempts++; return action(); },
    });
    assert.deepEqual(await provider.lyric('mid'), { lrc, tlyric: '' });
    assert.equal(attempts, 1);
  }
});

test('QQ recovery preserves readable translation when the original cannot be recovered', async () => {
  const provider = createQqMusicProvider({
    lyricApi: async () => response({ lyric: 'bad�original', translyric: '[00:01]合成译词' }),
    musicuFetch: async () => { throw new Error('unavailable'); },
  });
  assert.deepEqual(await provider.lyric('mid'), { lrc: '', tlyric: '[00:01]合成译词' });
});

test('QQ missing lyrics do not retry, whereas an SDK error gets one recovery attempt', async () => {
  let attempts = 0;
  const musicuFetch = async () => { attempts++; throw new Error('private'); };
  assert.deepEqual(await createQqMusicProvider({ lyricApi: async () => response({ lyric: '' }), musicuFetch }).lyric('mid'), { lrc: '', tlyric: '' });
  assert.equal(attempts, 0);
  assert.deepEqual(await createQqMusicProvider({ lyricApi: async () => { throw new Error('private'); }, musicuFetch }).lyric('mid'), { lrc: '', tlyric: '' });
  assert.equal(attempts, 1);
});

// ---- QQ playUrl 失败分类（见 openspec change surface-source-auth-failures） ----
const SECRET_COOKIE = 'uin=42; qqmusic_key=must-not-leak';
const RAW_UPSTREAM = 'RAW-UPSTREAM-DETAIL';

function transportError(code, message = `${code} while requesting upstream`) {
  return Object.assign(new Error(message), { code });
}

function playSuccess(songmid, url) {
  return { status: 200, body: { data: { playUrl: { [songmid]: { url } } } } };
}

// 上游 getMusicPlay 在「这一档没拿到 purl」时回 200 + 空 URL，并在 entry 上附一句
// 由 allUnauthenticated 推断出来的提示。它**不是**登录码，所以不能当 auth 证据。
function playEmpty(songmid, error = '暂无播放链接') {
  return { status: 200, body: { data: { playUrl: { [songmid]: { url: '', error } } } } };
}

function playApiFrom(behaviour) {
  const calls = [];
  const playApi = async input => {
    calls.push(input.quality);
    const action = behaviour[input.quality];
    if (typeof action === 'function') return action(input);
    throw Object.assign(new Error(`unexpected quality ${input.quality}`), { code: 'ECONNREFUSED' });
  };
  playApi.calls = calls;
  return playApi;
}

function providerWith(playApi, cookie = SECRET_COOKIE) {
  return createQqMusicProvider({ getCookieValue: () => cookie, playApi });
}

async function assertFailureCode(promise, code) {
  await assert.rejects(() => promise, error => {
    assert.equal(error.code, code);
    const surface = `${error.message}\n${error.stack || ''}`;
    assert.equal(surface.includes(SECRET_COOKIE), false, 'cookie must not leak into the error');
    assert.equal(surface.includes(RAW_UPSTREAM), false, 'raw upstream text must not leak into the error');
    return true;
  });
}

test('QQ playUrl returns the first playable quality without probing the rest', async () => {
  const playApi = playApiFrom({
    flac: () => playSuccess('mid', 'https://audio.test/flac.flac'),
    '320': () => playSuccess('mid', 'https://audio.test/320.mp3'),
  });
  assert.equal(await providerWith(playApi).songUrl('mid'), 'https://audio.test/flac.flac');
  assert.deepEqual(playApi.calls, ['flac']);
});

test('QQ playUrl reports timeout when every quality times out', async () => {
  const provider = providerWith(async () => { throw transportError('ETIMEDOUT'); });
  await assertFailureCode(provider.songUrl('mid'), 'timeout');
});

test('QQ playUrl reports unavailable when every quality is refused', async () => {
  // 传输层 errno 优先于文本：即使 message 里出现 unauthorized 字样也不编造 auth。
  const provider = providerWith(async () => { throw transportError('ECONNREFUSED', 'unauthorized: connect refused'); });
  await assertFailureCode(provider.songUrl('mid'), 'unavailable');
});

test('QQ playUrl prefers unavailable over timeout when transport failures are mixed', async () => {
  const playApi = playApiFrom({
    flac: () => { throw transportError('ETIMEDOUT'); },
    '320': () => { throw transportError('ECONNREFUSED'); },
    '128': () => { throw transportError('ETIMEDOUT'); },
    m4a: () => { throw transportError('ECONNREFUSED'); },
  });
  await assertFailureCode(providerWith(playApi).songUrl('mid'), 'unavailable');
});

test('QQ playUrl treats an explicit QQ login code in the body as requires-auth', async () => {
  const provider = providerWith(async () => ({ status: 200, body: { code: 1000, message: RAW_UPSTREAM } }));
  await assertFailureCode(provider.songUrl('mid'), 'requires-auth');
});

test('QQ playUrl treats an explicit negative QQ login code as requires-auth', async () => {
  const provider = providerWith(async () => ({ status: 200, body: { data: { code: -1000, message: RAW_UPSTREAM } } }));
  await assertFailureCode(provider.songUrl('mid'), 'requires-auth');
});

test('QQ playUrl recognizes a confirmed auth code in the SDK response wrapper', async () => {
  const provider = providerWith(async () => response({ code: 1000 }));
  await assertFailureCode(provider.songUrl('mid'), 'requires-auth');
});

test('QQ playUrl treats an HTTP 401 as confirmed requires-auth', async () => {
  const provider = providerWith(async () => ({ status: 401, body: { message: RAW_UPSTREAM } }));
  await assertFailureCode(provider.songUrl('mid'), 'requires-auth');
});

test('QQ playUrl returns null for a valid response that carries no playable URL', async () => {
  const playApi = playApiFrom({ flac: () => playEmpty('mid'), '320': () => playEmpty('mid'), '128': () => playEmpty('mid'), m4a: () => playEmpty('mid') });
  assert.equal(await providerWith(playApi).songUrl('mid'), null);
  assert.deepEqual(playApi.calls, ['flac', '320', '128', 'm4a']);
});

test('QQ playUrl does not turn the SDK empty-URL login hint into requires-auth', async () => {
  const hint = 'Cookie 已失效或 uin 缺失，请重新获取有效的登录 Cookie';
  const playApi = playApiFrom({ '*': undefined, flac: () => playEmpty('mid', hint) });
  assert.equal(await providerWith(playApi).songUrl('mid'), null);
});

test('QQ playUrl keeps looking after an empty quality and returns a later URL', async () => {
  const playApi = playApiFrom({
    flac: () => { throw transportError('ETIMEDOUT'); },
    '320': () => playEmpty('mid'),
    '128': () => playSuccess('mid', 'https://audio.test/128.mp3'),
  });
  assert.equal(await providerWith(playApi).songUrl('mid'), 'https://audio.test/128.mp3');
});

test('QQ playUrl returns null when responses without URL mix with transport failures', async () => {
  const playApi = playApiFrom({
    flac: () => { throw transportError('ECONNREFUSED'); },
    '320': () => playEmpty('mid'),
    '128': () => { throw transportError('ETIMEDOUT'); },
    m4a: () => playEmpty('mid'),
  });
  assert.equal(await providerWith(playApi).songUrl('mid'), null);
});

test('QQ playUrl reports unavailable when every attempt returns an error response', async () => {
  const provider = providerWith(async () => ({ status: 502, body: { error: RAW_UPSTREAM } }));
  await assertFailureCode(provider.songUrl('mid'), 'unavailable');
});

test('QQ playUrl returns null when an error response mixes with a valid empty response', async () => {
  const playApi = playApiFrom({
    flac: () => ({ status: 502, body: { error: RAW_UPSTREAM } }),
    '320': () => playEmpty('mid'),
    '128': () => ({ status: 429, body: { message: RAW_UPSTREAM } }),
    m4a: () => playEmpty('mid'),
  });
  assert.equal(await providerWith(playApi).songUrl('mid'), null);
});

test('QQ playUrl lets a confirmed auth failure win over empty-URL responses', async () => {
  const playApi = playApiFrom({
    flac: () => playEmpty('mid'),
    '320': () => ({ status: 401, body: { message: RAW_UPSTREAM } }),
    '128': () => playEmpty('mid'),
    m4a: () => playEmpty('mid'),
  });
  await assertFailureCode(providerWith(playApi).songUrl('mid'), 'requires-auth');
});

test('QQ library snapshot surfaces a confirmed login code as requires-auth', async () => {
  const provider = createQqMusicProvider({
    getCookieValue: () => SECRET_COOKIE,
    userPlaylistsApi: async () => ({ status: 200, body: { code: 1000, message: RAW_UPSTREAM } }),
  });
  await assertFailureCode(provider.libraryPlaylistsSnapshot('42'), 'requires-auth');
});

test('QQ loginStatus reports a closed requires-auth code and reports it to source health', async () => {
  const reported = [];
  setSourceHealthReporter((source, code) => reported.push([source, code]));
  try {
    const provider = createQqMusicProvider({
      getCookieValue: () => SECRET_COOKIE,
      userPlaylistsApi: async () => ({ status: 401, body: { message: RAW_UPSTREAM } }),
    });
    const status = await provider.loginStatus();
    assert.equal(status.loggedIn, false);
    assert.equal(status.code, 'requires-auth');
    assert.equal(String(status.reason).includes(RAW_UPSTREAM), false);
    assert.deepEqual(reported, [['qq', 'requires-auth']]);
  } finally {
    resetSourceHealthReporter();
  }
});

test('late auth failure for replaced QQ credentials cannot invalidate the new login', async () => {
  let cookie = SECRET_COOKIE;
  let finish;
  const reported = [];
  setSourceHealthReporter((source, code) => reported.push([source, code]));
  try {
    const provider = createQqMusicProvider({ getCookieValue: () => cookie,
      userPlaylistsApi: () => new Promise(resolve => { finish = resolve; }),
      playApi: async () => { cookie = 'uin=43; qqmusic_key=new-private-key'; return { status: 401, body: {} }; } });
    const pending = provider.loginStatus();
    await new Promise(resolve => setImmediate(resolve));
    cookie = 'uin=43; qqmusic_key=new-private-key';
    finish({ status: 401, body: {} });
    const status = await pending;
    assert.equal(status.code, 'unavailable');
    assert.deepEqual(reported, []);
    cookie = SECRET_COOKIE;
    await assertFailureCode(provider.songUrl('song-mid'), 'unavailable');
  } finally { resetSourceHealthReporter(); }
});

test('QQ loginStatus keeps network failures out of the auth channel', async () => {
  const reported = [];
  setSourceHealthReporter((source, code) => reported.push([source, code]));
  try {
    const provider = createQqMusicProvider({
      getCookieValue: () => SECRET_COOKIE,
      userPlaylistsApi: async () => { throw transportError('ECONNREFUSED'); },
    });
    const status = await provider.loginStatus();
    assert.equal(status.loggedIn, false);
    assert.equal(status.code, 'unavailable');
    assert.deepEqual(reported, []);
  } finally {
    resetSourceHealthReporter();
  }
});

test('QQ loginStatus without a cookie does not claim an expired login', async () => {
  const reported = [];
  setSourceHealthReporter((source, code) => reported.push([source, code]));
  try {
    const provider = createQqMusicProvider({
      getCookieValue: () => '',
      userPlaylistsApi: async () => { throw new Error('must not be called without a cookie'); },
    });
    const status = await provider.loginStatus();
    assert.deepEqual(status, { loggedIn: false, reason: 'no cookie set' });
    assert.deepEqual(reported, []);
  } finally {
    resetSourceHealthReporter();
  }
});

test('QQ SDK adapter normalizes search, play, lyric and comments without a sidecar URL', async () => {
  const calls = [];
  const provider = createQqMusicProvider({
    getCookieValue: () => 'uin=o42; qqmusic_key=private-key',
    searchApi: async input => {
      calls.push(['search', input]);
      return response({ data: { song: { list: [{
        mid: 'song-mid', name: '晴天', singer: [{ name: '周杰伦' }],
        album: { id: 7, mid: 'album-mid', name: '叶惠美' }, interval: 269,
      }] } } });
    },
    playApi: async input => {
      calls.push(['play', input]);
      return { status: 200, body: { data: { playUrl: { 'song-mid': { url: 'https://audio.test/song.mp3' } } } } };
    },
    lyricApi: async input => {
      calls.push(['lyric', input]);
      return response({ lyric: '[00:00]晴天', trans: '[00:00]Sunny' });
    },
    commentsApi: async input => {
      calls.push(['comments', input]);
      return response({ hotComment: { commentlist: [{ rootcommentcontent: '很好听' }] } });
    },
  });

  assert.deepEqual(await provider.search('晴天', 1), [{
    song_id: 'song-mid', title: '晴天', artist: '周杰伦', album: '叶惠美',
    album_id: '7', pic_url: 'https://y.gtimg.cn/music/photo_new/T002R300x300M000album-mid.jpg', duration: 269,
  }]);
  assert.equal(await provider.songUrl('song-mid'), 'https://audio.test/song.mp3');
  assert.deepEqual(await provider.lyric('song-mid'), { lrc: '[00:00]晴天', tlyric: '[00:00]Sunny' });
  assert.deepEqual(await provider.comments('123', 3), ['很好听']);

  assert.equal(calls.find(([name]) => name === 'play')[1].cookie, 'uin=o42; qqmusic_key=private-key');
  assert.equal(calls.find(([name]) => name === 'lyric')[1].cookie, 'uin=o42; qqmusic_key=private-key');
  assert.equal(JSON.stringify(calls).includes('QQ_BASE_URL'), false);
  assert.equal(JSON.stringify(calls).includes('ownCookie'), false);
});

test('QQ public discovery provides canonical song metadata without a login cookie', async () => {
  const provider = createQqMusicProvider({ getCookieValue: () => '',
    newSongsApi: async () => response({ new_song: { code: 0, data: { songlist: [
      { mid: 'new-mid', title: '新歌', singer: [{ name: '新歌手' }], interval: 200 },
    ] } } }),
  });
  assert.deepEqual((await provider.discover(10)).map(row => [row.song_id, row.title, row.artist]),
    [['new-mid', '新歌', '新歌手']]);
});

test('QQ SDK adapter keeps library snapshots strict and detects truncated playlists', async () => {
  const provider = createQqMusicProvider({
    getCookieValue: () => 'uin=42; qqmusic_key=private-key',
    userPlaylistsApi: async input => {
      assert.equal(input.cookie, 'uin=42; qqmusic_key=private-key');
      return response({ code: 0, data: { playlists: [{ tid: 9, dirid: 201, diss_name: '我喜欢', song_cnt: 3 }] } });
    },
    playlistDetailApi: async input => {
      assert.deepEqual(input.params, { disstid: '9' });
      assert.equal(input.option.headers.Cookie, 'uin=42; qqmusic_key=private-key');
      return response({ cdlist: [{ songnum: 3, songlist: [
        { mid: 'a', name: 'A', singer: [{ name: 'Singer' }] },
        { mid: 'b', name: 'B', singer: [{ name: 'Singer' }] },
      ] }] });
    },
    userDetailApi: async () => response({ data: { creator: { nick: 'QQ 用户' } } }),
  });

  assert.deepEqual(await provider.libraryPlaylistsSnapshot('42'), {
    items: [{ id: '9', dirid: 201, name: '我喜欢', trackCount: 3, coverImgUrl: '' }],
    complete: true, reportedCount: 1, fetchedCount: 1, error: null,
  });
  const tracks = await provider.libraryTracksSnapshot('9', { reportedCount: 3 });
  assert.equal(tracks.complete, false);
  assert.equal(tracks.fetchedCount, 2);
  assert.match(tracks.error, /expected 3, fetched 2/);
  assert.deepEqual(await provider.loginStatus(), {
    loggedIn: true, userId: '42', nickname: 'QQ 用户',
    avatarUrl: 'https://q.qlogo.cn/headimg_dl?bs=qq&dst_uin=42&spec=100', vipType: 0,
  });
});

test('QQ SDK adapter rejects invalid strict payloads instead of treating them as complete', async () => {
  const provider = createQqMusicProvider({
    getCookieValue: () => 'uin=42; qqmusic_key=private-key',
    userPlaylistsApi: async () => response({ code: 0, data: {} }),
  });
  await assert.rejects(() => provider.libraryPlaylistsSnapshot('42'), /invalid payload/);
});

test('QQ playlist count stays unknown when upstream omits it', async () => {
  const provider = createQqMusicProvider({
    getCookieValue: () => 'uin=42; qqmusic_key=private-key',
    userPlaylistsApi: async () => response({
      code: 0,
      data: { playlists: [{ tid: 9, diss_name: '旧歌' }] },
    }),
  });

  assert.deepEqual(await provider.userPlaylists('42'), [{
    id: '9', dirid: undefined, name: '旧歌', trackCount: null, coverImgUrl: '',
  }]);
});

test('authenticated SDK failures redact Cookie-bearing error objects from console output', async () => {
  const secret = 'uin=42; qqmusic_key=must-not-leak';
  const originalError = console.error;
  const output = [];
  console.error = (...args) => output.push(args.map(String).join(' '));
  try {
    const provider = createQqMusicProvider({
      getCookieValue: () => secret,
      userPlaylistsApi: async () => {
        const error = new Error('network failed');
        error.config = { headers: { Cookie: secret } };
        error.request = { _header: `Cookie: ${secret}` };
        console.error('QQ upstream failed:', error);
        return { status: 502, body: { error: '服务器内部错误' } };
      },
    });
    await assert.rejects(() => provider.libraryPlaylistsSnapshot('42'), /服务器内部错误/);
  } finally {
    console.error = originalError;
  }
  assert.equal(output.join('\n').includes(secret), false);
  assert.match(output.join('\n'), /network failed/);
});

test('QQ identity accepts the leading-o uin format returned by QR login', () => {
  assert.equal(parseUinFromCookie('uin=o123456; qqmusic_key=private-key'), '123456');
  assert.equal(parseUinFromCookie('qqmusic_uin=654321; qqmusic_key=private-key'), '654321');
});
