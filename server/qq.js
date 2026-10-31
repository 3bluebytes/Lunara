// qq.js — QQ Music 进程内 SDK 适配器
// 认证、搜索、播放、歌词、评论、推荐和曲库全部使用
// @sansenjian/qq-music-api 的函数式 exports；不启动额外 HTTP 服务或监听端口。
// 接口形态与 server/ncm.js 对齐，便于 musicResolver 统一处理。
//
// 失败容错：所有公开函数在网络/服务/接口异常时返回安全空值（[] / null /
// {ok:false}），决不抛错 —— 上层 musicResolver 看到失败即 fallback 到另一源。

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolveAudioCacheDir } from './runtimePaths.js';
import { getMediaAssetStore } from './media/sharedMediaAssets.js';
import { remoteAudioUrl } from './media/remoteAudioProxy.js';
import {
  checkLoginQr as checkQqLoginQr,
  getLoginQr as getQqLoginQr,
  getPlayUrl as sdkGetPlayUrl,
  lyric as sdkGetLyric,
  search as sdkSearch,
} from '@sansenjian/qq-music-api/sdk';
import {
  getComments as sdkGetComments,
  getDailyRecommend as sdkGetDailyRecommend,
  getNewSongs as sdkGetNewSongs,
  getPersonalRecommend as sdkGetPersonalRecommend,
  getUserDetail as sdkGetUserDetail,
  getUserPlaylists as sdkGetUserPlaylists,
  songListDetail as sdkSongListDetail,
  getAlbumSongs as sdkGetAlbumSongs,
} from '@sansenjian/qq-music-api/services';
import { SOURCE_FAILURE, classifySourceFailure, sourceFailure } from './music/sourceFailure.js';
import { reportSourceHealth } from './music/sourceHealthSignal.js';
import { postQqSigned } from './music/qqWebSign.js';
import { normalizeLyricText } from '../pwa/core/lyricText.js';

let COOKIE = process.env.QQ_COOKIE || '';
// 惰性建目录：import 期 mkdir 会先于 state.js 的 ensureDataRootReady 评估，
// 破坏「迁移目标为空」语义；目录在唯一写入点 cacheAudio 前创建。
let CACHE_DIR = null;
function ensureCacheDir() {
  if (!CACHE_DIR) {
    CACHE_DIR = resolveAudioCacheDir();
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  return CACHE_DIR;
}

const _cookieListeners = new Set();
export function onCookieChange(fn) { _cookieListeners.add(fn); return () => _cookieListeners.delete(fn); }
function _emitCookieChange() { for (const fn of _cookieListeners) { try { fn(COOKIE); } catch {} } }

export function parseUinFromCookie(cookie) {
  const m = String(cookie || '').match(/(?:^|;\s*)(?:uin|qqmusic_uin)=([^;]+)/);
  return m ? m[1].replace(/\D/g, '') : '';
}

export function setCookie(c) {
  COOKIE = (c || '').trim();
  process.env.QQ_COOKIE = COOKIE;
  _emitCookieChange();
}
export function getCookie() { return COOKIE; }
export function getUid() { return parseUinFromCookie(COOKIE); }
export function clearCookie() {
  COOKIE = '';
  process.env.QQ_COOKIE = '';
  _emitCookieChange();
}

const QQ_QR_TTL_MS = 180_000;

// ---- 「我喜欢（收藏）」写入 ----
// QQ 音乐没有独立的「喜欢单曲」API：官方 web 客户端把「我喜欢」当成一个特殊
// 歌单（dirId 201），收藏/取消收藏 = 往这个歌单加歌/删歌。契约取自 QQ 音乐自家
// 播放器打包代码（musicu.fcg 调用）：
//
//   module: 'music.musicasset.PlaylistDetailWrite'
//   method: 'AddSonglist' | 'DelSonglist'      ← 加与删是同一 param 的两个 method
//   param : { dirId: 201, v_songInfo: [{ songType, songId }] }
//
// 注意 songId 是 QQ 的**数字** id、songType 是曲目类型（普通单曲为 0），而 Lunara
// 里 QQ 的 canonical song_id 是 songmid 字符串，所以写入前必须先解析数字身份。
// 已收藏状态用 SongFavRead.IsSongFanByMid({ v_songMid }) → data.m_fan[mid]。
//
// 真机结论（2026-03，真实账号，逐条回读验证过）：
//   · 明文 musicu.fcg 能读（IsSongFanById / IsSongFanByMid / GetPlaylistByUin /
//     搜索都 code 0），也能往普通歌单（dirId≠201）加歌删歌（code 0）；
//   · 但往「我喜欢」（dirId 201）**加歌**一律 80105，删歌却是 0；
//   · 同一个加歌请求改走官方现在的签名通道（musics.fcg + encoding=ag-1 +
//     zzc sign，见 music/qqWebSign.js），code 0，IsSongFanById 立即读回 true。
//   所以 80105 既不是 songType 枚举（0 和 13 都一样拒）也不是登录态（同一分钟
//   明文读仍是 0），而是「我喜欢」写入要求签名+加密通道。此前把它当成 songType
//   问题、并把「写失败后整段会话全 1000」当成风控，都不成立——那次 1000 来自
//   当时 comm 里的 authst/g_tk 取自错误的 cookie（p_skey / qqmusic_key）。
// 改动这里前先跑 scripts/verify-track-like.mjs 拿新证据。
export const QQ_MUSICU_ENDPOINT = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
/** 「我喜欢」在 QQ 的固定目录 id。官方客户端同样硬编码 201，不按名字猜。 */
export const QQ_LIKED_DIRID = 201;
/**
 * 正常单曲在「我喜欢」里的类型就是 0：把 502 首真实收藏逐条打出来，type 全是 0。
 * 其他取值（1/5/7/11…）在真机上对应别的资源类别，别拿来凑数。
 */
export const QQ_SONG_TYPE_NORMAL = 0;

function cookieValue(cookie, name) {
  const match = String(cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? match[1].trim() : '';
}

/**
 * QQ 的 g_tk：5381 起始的左移累加哈希取低 31 位。
 * y.qq.com 用 **qm_keyst** 计算（不是 p_skey）；用 p_skey 算出来的值服务端不认，
 * 缺 g_tk 的 comm 会直接回 500026。
 */
export function qqGtkFromPSkey(pSkey) {
  const raw = String(pSkey || '');
  if (!raw) return 0;
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) hash = ((hash << 5) + hash + raw.charCodeAt(i)) & 0xFFFFFFFF;
  return hash & 0x7FFFFFFF;
}

/**
 * musicu.fcg 的 comm 块。凭据只从这里进请求体与 Cookie 头，绝不进 URL。
 */
export function buildQqMusicuComm(cookie) {
  const uin = parseUinFromCookie(cookie);
  // qm_keyst 才是 y.qq.com 的登录凭据；qqmusic_key 是同一会话的别名，
  // 老账号的 cookie 里可能只有后者，所以按顺序取第一个非空值。
  const authst = cookieValue(cookie, 'qm_keyst') || cookieValue(cookie, 'qqmusic_key');
  const gTk = qqGtkFromPSkey(cookieValue(cookie, 'qm_keyst') || cookieValue(cookie, 'p_skey'));
  return {
    uin,
    loginUin: uin,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: 0,
    ct: 24,
    cv: 4747474,
    platform: 'yqq.json',
    needNewCode: 1,
    ...(authst ? { authst } : {}),
    ...(gTk ? { g_tk: gTk, g_tk_new_20200303: gTk } : {}),
  };
}

async function defaultMusicuFetch({ module, method, param, cookie, signal } = {}) {
  const payload = { comm: buildQqMusicuComm(cookie), req_1: { module, method, param } };
  const response = await fetch(QQ_MUSICU_ENDPOINT, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      referer: 'https://y.qq.com/',
      cookie: String(cookie || ''),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`qq musicu → ${response.status}`);
  return response.json();
}

/** 写路径专用的签名通道；读路径继续用明文 musicu（更快、也不需要密钥动画）。 */
async function defaultSignedMusicuFetch({ module, method, param, cookie, signal } = {}) {
  return postQqSigned({
    payload: JSON.stringify({ comm: buildQqMusicuComm(cookie), req_1: { module, method, param } }),
    cookie,
    signal,
  });
}

function qrResponseBody(response) {
  return response?.body && typeof response.body === 'object' ? response.body : response;
}

/**
 * Keeps qrsig/ptqrtoken server-side. The renderer only receives an opaque,
 * short-lived key that addresses this in-memory session.
 */
export function createQqQrLogin({
  getLoginQr = getQqLoginQr,
  checkLoginQr = checkQqLoginQr,
  now = Date.now,
  createKey = randomUUID,
  ttlMs = QQ_QR_TTL_MS,
} = {}) {
  const sessions = new Map();

  function takeActive(key) {
    const normalized = String(key || '').trim();
    const session = sessions.get(normalized);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(normalized);
      return null;
    }
    return session;
  }

  async function qrKey() {
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(key);
    }
    const response = await getLoginQr();
    const body = qrResponseBody(response);
    if (Number(response?.status || 200) >= 400 || !body?.img || !body?.ptqrtoken || !body?.qrsig) {
      throw new Error(body?.error || body?.message || 'QQ 二维码生成失败');
    }
    const key = createKey();
    sessions.set(key, {
      qrimg: body.img,
      ptqrtoken: String(body.ptqrtoken),
      qrsig: String(body.qrsig),
      expiresAt: now() + ttlMs,
    });
    return key;
  }

  async function qrCreate(key) {
    const session = takeActive(key);
    if (!session) return { qrimg: '', qrurl: '' };
    return { qrimg: session.qrimg, qrurl: '' };
  }

  async function qrCheck(key) {
    const normalized = String(key || '').trim();
    const session = takeActive(normalized);
    if (!session) return { code: 800, cookie: '', message: '二维码已失效，请刷新后重试' };

    const response = await checkLoginQr({
      ptqrtoken: session.ptqrtoken,
      qrsig: session.qrsig,
    });
    const body = qrResponseBody(response);
    if (Number(response?.status || 200) >= 400) {
      return { code: 500, cookie: '', message: body?.error || body?.message || 'QQ 登录检查失败' };
    }
    if (body?.isOk && body?.session?.cookie) {
      sessions.delete(normalized);
      return { code: 803, cookie: String(body.session.cookie), message: body.message || '登录成功' };
    }
    if (body?.refresh) {
      sessions.delete(normalized);
      return { code: 800, cookie: '', message: body.message || '二维码已失效' };
    }
    return { code: 801, cookie: '', message: body?.message || '等待扫码' };
  }

  return Object.freeze({ qrKey, qrCreate, qrCheck });
}

const qqQrLogin = createQqQrLogin();

function readPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}

function findArray(value, paths) {
  for (const path of paths) {
    const candidate = readPath(value, path);
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function firstArray(value, paths) {
  return findArray(value, paths) || [];
}

// QQ musicu 明确表示「登录态缺失/失效」的 code。空 URL、空 purl 一律不在此列：
// 上游 getMusicPlay 用「purl 为空」推断登录态并给出提示文字，那只是推断，不是鉴权码。
const QQ_AUTH_CODES = new Set([1000, -1000]);
// 只有上游自己说出的明确登录失效文字才算 auth；「cookie」等泛词不回退成 auth。
const QQ_AUTH_TEXT = /(?:未登录|登录失效|登录态(?:已)?失效|请(?:先|重新)?登录|需要(?:重新)?登录|not\s*log(?:ged)?\s*in|login\s*required|unauthoriz)/i;

const TRANSPORT_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'ERR_NETWORK',
]);
const TRANSPORT_TIMEOUT_CODES = new Set([
  'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED', 'ERR_CANCELED', 'UND_ERR_CONNECT_TIMEOUT',
]);

/** 响应里可能承载 QQ code 的位置（顶层、body、body.data）。 */
function responseCodes(response) {
  const body = response?.body;
  return [response?.code, body?.code, body?.data?.code, body?.response?.code, body?.response?.data?.code]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(Number)
    .filter(Number.isFinite);
}

/**
 * 把一次 HTTP 状态/上游文字归到一个封闭 code。
 * auth 只在调用点用「可靠证据」（登录码/401/明确登录文字）单独判定；这里若泛化
 * 文本被判成 auth，一律降级为 internal，避免把「没拿到 URL」编造成「登录过期」。
 */
function transportFailureCode(status, message) {
  if (status === 408 || status === 504) return SOURCE_FAILURE.TIMEOUT;
  if (status === 429) return SOURCE_FAILURE.RATE_LIMITED;
  if (status >= 500) return SOURCE_FAILURE.UNAVAILABLE;
  const classified = classifySourceFailure(message);
  if (classified === SOURCE_FAILURE.REQUIRES_AUTH) return SOURCE_FAILURE.INTERNAL;
  return classified;
}

/**
 * 解析一次 SDK 响应。
 * @returns {{ message: string, code: string|null, auth: boolean }}
 *   auth=true 表示上游**确证**登录态缺失/失效（code 1000/-1000、HTTP 401、明确
 *   登录文字）。message 在 auth 时是固定文案，绝不回显上游原文或 cookie。
 */
function apiFailure(response, label) {
  const status = Number(response?.status || 200);
  const body = response?.body;
  const error = body?.error || body?.message || body?.data?.message
    || body?.response?.error || body?.response?.message || body?.response?.data?.message;
  const text = typeof error === 'string' ? error : error?.message;
  if (responseCodes(response).some(code => QQ_AUTH_CODES.has(code))) {
    return { message: `${label}: login required`, code: SOURCE_FAILURE.REQUIRES_AUTH, auth: true };
  }
  if (status === 401) {
    return { message: `${label}: login required`, code: SOURCE_FAILURE.REQUIRES_AUTH, auth: true };
  }
  if (status >= 400 || error) {
    const message = `${label}: ${text || `SDK status ${status}`}`;
    if (typeof text === 'string' && QQ_AUTH_TEXT.test(text)) {
      return { message: `${label}: login required`, code: SOURCE_FAILURE.REQUIRES_AUTH, auth: true };
    }
    return { message, code: transportFailureCode(status, message), auth: false };
  }
  return { message: '', code: null, auth: false };
}

function unwrapResponse(response, label) {
  const failure = apiFailure(response, label);
  if (failure.message) {
    const error = new Error(failure.message);
    if (failure.code) error.code = failure.code;
    throw error;
  }
  const body = response?.body;
  if (!body || typeof body !== 'object') throw new Error(`${label}: invalid SDK response`);
  return Object.hasOwn(body, 'response') ? body.response : body;
}

/** 脱敏后的 playUrl 失败：只带封闭 code，不带上游原文、URL 或 cookie。 */
function playFailure(code) {
  const error = new Error(`qq play: ${code}`);
  error.code = code;
  return error;
}

/** 传输层异常（未拿到响应）→ 封闭 code。errno 优先于文本，文本再兜底。 */
function transportFailureFromError(error) {
  const errno = String(error?.code || '').toUpperCase();
  if (TRANSPORT_TIMEOUT_CODES.has(errno)) return SOURCE_FAILURE.TIMEOUT;
  if (TRANSPORT_UNAVAILABLE_CODES.has(errno)) return SOURCE_FAILURE.UNAVAILABLE;
  const status = Number(error?.response?.status || 0);
  if (status) return transportFailureCode(status, String(error?.message || ''));
  const classified = classifySourceFailure(error);
  if (classified === SOURCE_FAILURE.REQUIRES_AUTH) return SOURCE_FAILURE.INTERNAL;
  return classified;
}

/** 每一档都传输失败时的聚合结论：确定的不可用优先于超时，全部超时才是超时。 */
function aggregateTransportFailure(codes) {
  const list = (Array.isArray(codes) ? codes : []).filter(Boolean);
  if (!list.length) return SOURCE_FAILURE.UNAVAILABLE;
  if (list.every(code => code === SOURCE_FAILURE.TIMEOUT)) return SOURCE_FAILURE.TIMEOUT;
  for (const code of [SOURCE_FAILURE.RATE_LIMITED, SOURCE_FAILURE.UNAVAILABLE,
    SOURCE_FAILURE.TIMEOUT, SOURCE_FAILURE.INTERNAL]) {
    if (list.includes(code)) return code;
  }
  return SOURCE_FAILURE.INTERNAL;
}

/** 从一次有效响应里取直链；空 URL / 空 purl 只代表这一档没有可播资源。 */
function playUrlFromResponse(response, songmid) {
  const body = response?.body || {};
  const entry = body?.data?.playUrl?.[songmid]
    ?? body?.response?.data?.playUrl?.[songmid]
    ?? body?.response?.playUrl?.[songmid];
  const url = typeof entry === 'string' ? entry : entry?.url;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

let credentialLogTail = Promise.resolve();

function redactCredentialLogArg(value, credential) {
  if (typeof value === 'string') return value.split(credential).join('[REDACTED]');
  if (!(value instanceof Error)) return value;
  const header = value?.config?.headers?.Cookie || value?.config?.headers?.cookie;
  const rawRequest = value?.request?._header;
  if (header !== credential && !(typeof rawRequest === 'string' && rawRequest.includes(credential))) return value;
  const safe = new Error(String(value.message || 'QQ SDK request failed').split(credential).join('[REDACTED]'));
  safe.name = value.name || 'Error';
  if (value.code) safe.code = value.code;
  if (value.stack) safe.stack = String(value.stack).split(credential).join('[REDACTED]');
  return safe;
}

/**
 * Some upstream service functions log their Axios error object before returning
 * an error response. Serialize only those authenticated calls and redact the
 * credential from console arguments so a failed request cannot print Cookie.
 */
function callAuthenticatedSdk(credential, operation) {
  if (!credential) return operation();
  const execute = async () => {
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => originalLog(...args.map(value => redactCredentialLogArg(value, credential)));
    console.error = (...args) => originalError(...args.map(value => redactCredentialLogArg(value, credential)));
    try {
      return await operation();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  };
  const result = credentialLogTail.then(execute, execute);
  credentialLogTail = result.catch(() => undefined);
  return result;
}

// ---- 基础元数据归一：QQ song → 与 NCM 一致 ----
export const QQ_ALBUM_COVER_BASE = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000';

/** albummid → 300×300 封面 URL。非法/缺失的 mid 一律返回空串，不拼半截 URL。 */
export function albumArtworkUrl(albummid) {
  const mid = String(albummid || '').trim();
  // albummid 是短标识符；只允许它可能出现的字符，挡住路径穿越和引号注入。
  return /^[A-Za-z0-9_-]+$/.test(mid) ? `${QQ_ALBUM_COVER_BASE}${mid}.jpg` : '';
}

// 公开元数据接口：不需要 cookie、不需要 Referer，只按 songmid 取专辑信息。
// 封面缺失时唯一的可靠补救途径 —— 搜索结果不带 albummid 的路径也靠它。
export const QQ_SONG_DETAIL_ENDPOINT = 'https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg';

async function defaultSongDetailFetch(songmid, { signal } = {}) {
  const url = `${QQ_SONG_DETAIL_ENDPOINT}?songmid=${encodeURIComponent(songmid)}&platform=yqq&format=json`;
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`qq song detail → ${response.status}`);
  return response.json();
}

export function normalizeQqSong(s) {
  if (!s || typeof s !== 'object') return null;
  const singers = (Array.isArray(s.singer) ? s.singer : Array.isArray(s.singers) ? s.singers : [])
    .map(x => typeof x === 'string' ? x : x?.name)
    .filter(Boolean)
    .join(' / ');
  const songmid = s.songmid || s.mid || s.song_mid || s.songMid || '';
  const albummid = s.albummid || s.albumMid || s.album?.mid || '';
  const albumid = s.albumid || s.albumId || s.album?.id || '';
  return {
    song_id: String(songmid || s.songid || s.id || ''),
    title: s.songname || s.name || s.title || '',
    artist: singers,
    album: s.albumname || s.albumName || s.album?.name || '',
    album_id: String(albumid),
    pic_url: albumArtworkUrl(albummid),
    duration: Math.round(Number(s.interval || s.duration || 0)),
  };
}

function normalizePlaylist(p) {
  if (!p || typeof p !== 'object') return null;
  const id = p.tid || p.dissid || p.disstid || p.diss_id || p.id;
  if (id === undefined || id === null || id === '') return null;
  const rawTrackCount = p.song_cnt ?? p.songnum ?? p.song_count ?? p.songCount ?? p.num0;
  const parsedTrackCount = rawTrackCount === undefined || rawTrackCount === null || rawTrackCount === ''
    ? null
    : Number(rawTrackCount);
  return {
    id: String(id),
    dirid: p.dirid ?? p.dir_id,
    name: p.diss_name || p.dissname || p.title || p.name || '',
    // Upstream playlist payloads do not always carry a count. Preserve that as
    // unknown instead of turning it into 0: a fabricated zero makes the radiohost
    // believe every playlist is empty and prevents candidate loading entirely.
    trackCount: Number.isFinite(parsedTrackCount) ? parsedTrackCount : null,
    coverImgUrl: p.diss_cover || p.logo || p.cover || p.cover_url_big || p.coverUrl || '',
  };
}

function playlistPayload(raw) {
  return Array.isArray(raw?.cdlist) ? raw.cdlist[0] : (raw?.data?.cdlist?.[0] || raw?.playlist || raw?.data || raw);
}

/**
 * Injectable adapter keeps SDK-specific response shapes out of Lunara's public
 * provider contract and lets tests verify the migration without network calls.
 */
export function createQqMusicProvider({
  searchApi = sdkSearch,
  playApi = sdkGetPlayUrl,
  lyricApi = sdkGetLyric,
  commentsApi = sdkGetComments,
  dailyRecommendApi = sdkGetDailyRecommend,
  newSongsApi = sdkGetNewSongs,
  personalRecommendApi = sdkGetPersonalRecommend,
  userDetailApi = sdkGetUserDetail,
  userPlaylistsApi = sdkGetUserPlaylists,
  playlistDetailApi = sdkSongListDetail,
  albumSongsApi = sdkGetAlbumSongs,
  songDetailApi = defaultSongDetailFetch,
  musicuFetch = defaultMusicuFetch,
  signedMusicuFetch = defaultSignedMusicuFetch,
  // 签名通道已验证双向可用，默认开启；保留 kill switch，方便上游变更时
  // 不重启代码就停掉账号写入（LUNARA_QQ_LIKE_WRITE=0）。
  allowLikeWrite = process.env.LUNARA_QQ_LIKE_WRITE !== '0',
  getCookieValue = () => COOKIE,
} = {}) {
  const cookie = () => String(getCookieValue() || '');

  async function searchMusic(keywords, limit = 10) {
    try {
      const raw = unwrapResponse(await searchApi({ key: keywords, limit, page: 1 }), 'qq search');
      const songs = firstArray(raw, ['data.song.list', 'data.list', 'song.list', 'list']);
      return songs.map(normalizeQqSong).filter(song => song?.song_id);
    } catch { return []; }
  }

  // 四档音质的失败不再一律吞成 null：
  //   · 成功 → 立刻返回直链；
  //   · 上游**确证**登录态缺失/失效（登录码、401、明确登录文字）→ 脱敏 requires-auth；
  //   · 四档**全部**传输失败（无任何有效响应）→ timeout/unavailable 等封闭 code；
  //   · 至少一次有效响应但这些响应都没有 URL → null（歌这一档不可播，不是登录问题）。
  // 上游「purl 为空」推断出的登录提示文字不算证据（见 apiFailure 注释）。
  async function playUrl(songmid) {
    const requestedCookie = cookie();
    let sawUsableResponse = false;
    const transportCodes = [];
    for (const quality of ['flac', '320', '128', 'm4a']) {
      let response;
      try {
        response = await playApi({ songmid, quality, cookie: requestedCookie });
      } catch (error) {
        transportCodes.push(transportFailureFromError(error));
        continue;
      }
      if (!response || typeof response !== 'object') {
        transportCodes.push(SOURCE_FAILURE.INTERNAL);
        continue;
      }
      const failure = apiFailure(response, 'qq play');
      // 已确认的 auth 优先于「这一档没有 URL」：某档碰巧回空 URL 不能让一次
      // 确证的登录失效降级成「歌不可播」。
      if (failure.auth) throw playFailure(cookie() === requestedCookie
        ? SOURCE_FAILURE.REQUIRES_AUTH : SOURCE_FAILURE.UNAVAILABLE);
      if (failure.message) {
        transportCodes.push(failure.code || SOURCE_FAILURE.INTERNAL);
        continue;
      }
      sawUsableResponse = true;
      const url = playUrlFromResponse(response, songmid);
      if (url) return url;
    }
    // 账号已切换时，旧凭据结果不能给新账号写不可播冷却。
    if (cookie() !== requestedCookie) throw playFailure(SOURCE_FAILURE.UNAVAILABLE);
    // 四档全是异常/错误响应 → 这是一次源失败，不能当成「歌不可播」去冷却。
    if (!sawUsableResponse) throw playFailure(aggregateTransportFailure(transportCodes));
    return null;
  }

  async function getLyric(songmid) {
    let lrc = '', tlyric = '';
    const requestedCookie = cookie();
    try {
      const raw = unwrapResponse(await lyricApi({ songmid, cookie: requestedCookie, isFormat: false }), 'qq lyric');
      const original = raw?.lyric || '';
      const translated = raw?.trans || raw?.translyric || '';
      lrc = normalizeLyricText(original);
      tlyric = normalizeLyricText(translated);
      if ((!original || lrc) && (!translated || tlyric)) return { lrc, tlyric };
    } catch { /* One same-song recovery; never expose upstream errors as lyrics. */ }
    try {
      // SDK 2.6.0's fallback requests crypt:1, then treats hex ciphertext as Base64.
      // Re-request plain LRC rather than guessing a charset for destroyed bytes.
      const result = await musicuFetch({
        module: 'music.musichallSong.PlayLyricInfo', method: 'GetPlayLyricInfo',
        param: { songMID: songmid, songID: 0, trans_t: 0, roma_t: 0, qrc_t: 0,
          crypt: 0, lrc_t: 0, interval: 0 },
        cookie: requestedCookie, signal: AbortSignal.timeout(8000),
      });
      const entry = result?.req_1;
      const raw = entry?.data;
      if (!raw || Number(result.code ?? 0) !== 0 || Number(entry.code ?? 0) !== 0
        || ['code', 'retcode', 'subcode'].some(key => Number(raw[key] ?? 0) !== 0)
        || Number(raw.crypt ?? 0) !== 0) return { lrc, tlyric };
      lrc ||= normalizeLyricText(raw.lyric);
      tlyric ||= normalizeLyricText(raw.trans || raw.translyric);
    } catch { /* Keep usable fields; missing lyrics must not block playback. */ }
    return { lrc, tlyric };
  }

  async function getComments(songId, limit = 10) {
    try {
      const raw = unwrapResponse(await commentsApi({
        method: 'get',
        params: { cid: 205360772, reqtype: 2, biztype: 1, topid: songId, cmd: 8, pagenum: 0, pagesize: limit, lasthotcommentid: '' },
        option: {},
      }), 'qq comments');
      const list = firstArray(raw, [
        'hotComment.commentlist', 'hot_comment.commentlist', 'hotcomment.commentlist',
        'comment.commentlist', 'comments', 'commentlist',
      ]);
      return list.slice(0, limit)
        .map(item => String(item?.rootcommentcontent || item?.content || item?.comment || '').trim())
        .filter(Boolean);
    } catch { return []; }
  }

  async function getUserPlaylists(uid, { strict = false } = {}) {
    if (!cookie() || !uid) {
      if (strict) throw new Error('qq user playlists: verified login required');
      return [];
    }
    try {
      const currentCookie = cookie();
      const response = await callAuthenticatedSdk(currentCookie, () => userPlaylistsApi({
        uin: String(uid), offset: 0, limit: 1000, cookie: currentCookie,
      }));
      const raw = unwrapResponse(response, 'qq user playlists');
      const lists = findArray(raw, ['data.playlists', 'data.mydiss.list', 'playlists', 'list']);
      if (!lists) throw new Error('qq user playlists: invalid payload');
      return lists.map(normalizePlaylist).filter(Boolean);
    } catch (error) {
      if (strict) throw error;
      return [];
    }
  }

  /**
   * 「我喜欢」不在 user_created_diss 里：`getUserPlaylists` 只返用户**自建**的歌单，
   * 所以以前 likedSongs() 的 `dirid===201` 永远匹配不到，退化成「拿第一个歌单当喜欢」，
   * 把别的歌单当成收藏喂给候选与曲库同步。这里改用官方的
   * `PlaylistBaseRead.GetPlaylistByUin`（与网页端同一个调用）取真实的收藏夹。
   * 返回 { tid, trackCount } 或 null（无登录/无此夹/请求失败）。
   */
  async function getLikedPlaylist(uid) {
    const owner = String(uid || '').trim();
    if (!cookie() || !owner) return null;
    try {
      const body = await callMusicu({
        module: 'music.musicasset.PlaylistBaseRead',
        method: 'GetPlaylistByUin',
        param: { uin: owner, bWithoutStatus: false },
      });
      if (Number(body?.req_1?.code) !== 0) return null;
      const lists = body?.req_1?.data?.v_playlist;
      if (!Array.isArray(lists)) return null;
      const liked = lists.find(row => Number(row?.dirId) === QQ_LIKED_DIRID);
      const tid = String(liked?.tid || '').trim();
      if (!tid) return null;
      return { tid, trackCount: Number.isFinite(Number(liked?.songNum)) ? Number(liked.songNum) : null };
    } catch { return null; }
  }

  async function likedSongs(uid, { limit = 100 } = {}) {
    const favorite = await getLikedPlaylist(uid);
    if (!favorite) return [];
    try {
      const currentCookie = cookie();
      const option = currentCookie ? { headers: { Cookie: currentCookie } } : {};
      const response = await callAuthenticatedSdk(currentCookie, () => playlistDetailApi({
        method: 'get', params: { disstid: favorite.tid }, option,
      }));
      const detail = playlistPayload(unwrapResponse(response, 'qq liked songs'));
      const songs = findArray(detail, ['songlist', 'song_list', 'tracks', 'songList']);
      if (!songs) return [];
      return songs.map(normalizeQqSong).filter(song => song?.song_id).slice(0, limit);
    } catch { return []; }
  }

  /**
   * 远端喜欢列表的 id 集合，形状与 `ncm.likedSongIds` 对齐：
   * 读失败必须有 `{ ok:false, reason }`，不能把失败当成「一首都没收藏」。
   */
  async function likedSongIds(uid, { limit = 2000 } = {}) {
    const favorite = await getLikedPlaylist(uid);
    if (!favorite) return { ok: false, reason: cookie() ? 'liked_list_unavailable' : 'not_logged_in', ids: [] };
    const songs = await likedSongs(uid, { limit });
    if (!songs.length) return { ok: false, reason: 'liked_list_unavailable', ids: [] };
    return { ok: true, ids: songs.map(song => String(song.song_id)) };
  }

  async function getPlaylistDetail(disstid, { strict = false } = {}) {
    try {
      const currentCookie = cookie();
      const option = currentCookie ? { headers: { Cookie: currentCookie } } : {};
      const response = await callAuthenticatedSdk(currentCookie, () => playlistDetailApi({
        method: 'get', params: { disstid }, option,
      }));
      const raw = unwrapResponse(response, 'qq playlist detail');
      const detail = playlistPayload(raw);
      const songs = findArray(detail, ['songlist', 'song_list', 'tracks', 'songList']);
      if (!songs) throw new Error('qq playlist detail: invalid payload');
      return { raw, detail, songs };
    } catch (error) {
      if (strict) throw error;
      return { raw: null, detail: null, songs: [] };
    }
  }

  async function getRecommendedSongs(limit = 30) {
    if (!cookie()) return [];
    try {
      const currentCookie = cookie();
      const raw = unwrapResponse(
        await callAuthenticatedSdk(currentCookie, () => dailyRecommendApi(currentCookie)),
        'qq daily recommend',
      );
      const songs = firstArray(raw, [
        'recommend.data.songlist', 'recommend.data.song_list', 'recommend.songlist',
        'data.songlist', 'data.song_list', 'songlist',
      ]);
      const normalized = songs.map(normalizeQqSong).filter(song => song?.song_id);
      if (normalized.length) return normalized.slice(0, limit);
    } catch {}

    try {
      const currentCookie = cookie();
      const raw = unwrapResponse(
        await callAuthenticatedSdk(currentCookie, () => personalRecommendApi(1, currentCookie)),
        'qq personal recommend',
      );
      const lists = firstArray(raw, [
        'recomPlaylist.data.v_hot', 'recomPlaylist.data.list', 'recomPlaylist.data.playlist',
        'data.list', 'list',
      ]);
      const first = lists.map(normalizePlaylist).find(Boolean);
      if (!first) return [];
      const { songs } = await getPlaylistDetail(first.id);
      return songs.slice(0, limit).map(normalizeQqSong).filter(song => song?.song_id);
    } catch { return []; }
  }

  /**
   * 专辑曲目（整专连播）。QQ 的专辑主键有两种形态：`albumid`（数字）与 `albummid`
   * （字符串 mid），SDK 两个都收；这里同时传，归一交给 SDK，不要求调用方知道是哪种。
   * 失败一律返回空数组，上层据此 fail closed，不跨源借同名专辑。
   */
  async function getAlbumTracks(albumId, { limit = 200, offset = 0 } = {}) {
    const key = String(albumId || '').trim();
    if (!key) return [];
    try {
      const raw = unwrapResponse(await albumSongsApi({
        method: 'get', params: { albummid: key, albumid: key, offset, num: limit },
      }), 'qq album songs');
      const songs = firstArray(raw, [
        'albumSonglist.data.songList', 'albumSonglist.songList', 'data.songList',
        'songList', 'data.songlist', 'songlist', 'data.list', 'list',
      ]);
      return songs.map(normalizeQqSong).filter(song => song?.song_id).slice(0, limit);
    } catch { return []; }
  }

  async function getDiscoverySongs(limit = 30) {
    try {
      const raw = unwrapResponse(await newSongsApi(0, limit), 'qq new songs');
      const songs = firstArray(raw, ['new_song.data.songlist']);
      return songs.map(normalizeQqSong).filter(song => song?.song_id && song.title && song.artist).slice(0, limit);
    } catch { return []; }
  }

  async function getLoginStatus() {
    // 本地事实（没设 cookie / cookie 里没有 uin）≠ 登录过期：不给 code，也不上报
    // auth，避免首次启动或未登录用户被提示「需要重新登录」。
    const requestedCookie = cookie();
    if (!requestedCookie) return { loggedIn: false, reason: 'no cookie set' };
    const uid = parseUinFromCookie(requestedCookie);
    if (!uid) return { loggedIn: false, reason: 'cookie missing uin' };
    try {
      await getUserPlaylists(uid, { strict: true });
      let nickname = '';
      try {
        const currentCookie = cookie();
        const detail = unwrapResponse(
          await callAuthenticatedSdk(currentCookie, () => userDetailApi({ uin: uid, cookie: currentCookie })),
          'qq user detail',
        );
        nickname = String(detail?.data?.creator?.nick || detail?.data?.creator?.nickname
          || detail?.data?.nick || detail?.data?.nickname || detail?.creator?.nick || '');
      } catch {}
      return {
        loggedIn: true,
        userId: uid,
        nickname,
        avatarUrl: `https://q.qlogo.cn/headimg_dl?bs=qq&dst_uin=${uid}&spec=100`,
        vipType: 0,
      };
    } catch (error) {
      // 只透出封闭 code（不回显上游原文/cookie）。确证 requires-auth 时顺手打到既有
      // 源健康信号：后台解析没走到歌曲、或初始 /api/health 直接问登录态时，
      // 这条事实也能进入既有的通知链。网络/超时不上报 auth。
      const code = cookie() === requestedCookie ? classifySourceFailure(error) : SOURCE_FAILURE.UNAVAILABLE;
      if (code === SOURCE_FAILURE.REQUIRES_AUTH) reportSourceHealth('qq', code);
      return { loggedIn: false, reason: code === SOURCE_FAILURE.REQUIRES_AUTH ? '需要重新登录 QQ 音乐' : 'QQ 音乐登录状态暂时无法核验', code };
    }
  }

  async function getLibraryPlaylistsSnapshot(uid) {
    const items = await getUserPlaylists(uid, { strict: true });
    // 「我喜欢」不是自建歌单，不会出现在 user_created_diss 里；不显式补进来，
    // 收藏就永远不会进入本地曲库，也就谈不上后续「收藏来源优先」。
    const favorite = await getLikedPlaylist(uid);
    if (favorite) {
      items.unshift({
        id: favorite.tid,
        dirid: QQ_LIKED_DIRID,
        name: '我喜欢',
        trackCount: favorite.trackCount,
        coverImgUrl: '',
      });
    }
    return { items, complete: true, reportedCount: items.length, fetchedCount: items.length, error: null };
  }

  async function getLibraryTracksSnapshot(disstid, { reportedCount = null } = {}) {
    if (!cookie()) throw new Error('qq library tracks: verified login required');
    const { detail, songs } = await getPlaylistDetail(disstid, { strict: true });
    const items = songs.map(normalizeQqSong).filter(song => song?.song_id);
    const payloadCount = [detail?.songnum, detail?.total_song_num, detail?.total, detail?.song_count]
      .map(Number).find(Number.isFinite);
    const expected = reportedCount !== null && reportedCount !== undefined && Number.isFinite(Number(reportedCount))
      ? Number(reportedCount)
      : (payloadCount ?? items.length);
    const complete = items.length === expected;
    return {
      items, complete, reportedCount: expected, fetchedCount: items.length,
      error: complete ? null : `qq snapshot truncated: expected ${expected}, fetched ${items.length}`,
    };
  }

  /**
   * 按 songId 取封面。返回值的三种含义必须区分清楚：
   *   { state: 'resolved', artwork } —— 已知封面；
   *   { state: 'absent' }           —— 供应商确认这条录音没有专辑（album.mid 与 album.name 都为空）；
   *   null                          —— 这次没查到（失败），不得记成 absent，下次还能重试。
   */
  async function getCoverArt(songId, { signal } = {}) {
    const songmid = String(songId || '').trim();
    if (!songmid) return null;
    try {
      const raw = await songDetailApi(songmid, { signal });
      const body = raw?.response && typeof raw.response === 'object' ? raw.response : raw;
      const first = Array.isArray(body?.data) ? body.data[0] : (Array.isArray(body) ? body[0] : null);
      if (!first) return null;
      const artwork = albumArtworkUrl(first?.album?.mid);
      if (artwork) return { state: 'resolved', artwork };
      // 没有 albummid 但有专辑名 = 数据形状变化，按失败处理，不写 absent。
      return String(first?.album?.name || '').trim() ? null : { state: 'absent' };
    } catch { return null; }
  }

  /**
   * songmid → 写入需要的数字身份 { id, type }。
   * QQ 的收藏接口不吃 songmid，而 Lunara 的 canonical id 恰是 songmid，所以这一步
   * 不能省；解析不出来就 fail closed，绝不拿 mid 顶上去猜数字 id。
   */
  async function resolveSongNumericIdentity(songmid) {
    try {
      const raw = await songDetailApi(songmid, {});
      const body = raw?.response && typeof raw.response === 'object' ? raw.response : raw;
      const first = Array.isArray(body?.data) ? body.data[0] : (Array.isArray(body) ? body[0] : null);
      const id = Number(first?.id);
      if (!Number.isFinite(id) || id <= 0) return null;
      const type = Number(first?.type);
      return { id, type: Number.isFinite(type) ? type : 0 };
    } catch { return null; }
  }

  async function callMusicu({ module, method, param }) {
    return musicuFetch({ module, method, param, cookie: cookie() });
  }

  async function callSignedMusicu({ module, method, param }) {
    return signedMusicuFetch({ module, method, param, cookie: cookie() });
  }

  /**
   * 「我喜欢」的写入只能走签名通道（见文件头结论）。加歌与删歌是同一个 module 的
   * 两个 method，且都幂等：加已在收藏里的歌、删不在收藏里的歌都回 code 0。
   * 返回 { ok, state } 或 { ok:false, reason, code }；不抛错。
   */
  function likeFailureReason(code) {
    if (code === 1000) return 'not_logged_in';
    // 80105 在签名通道上仍会出现，代表这首歌当前不可收藏（版权/下架/受限）。
    if (code === 80105) return 'not_collectable';
    return 'request_failed';
  }

  async function writeLikes(v_songInfo, desired) {
    if (!allowLikeWrite) return { ok: false, reason: 'unsupported', detail: 'qq-like-write-disabled', code: null };
    if (!v_songInfo.length) return { ok: true, state: desired ? 'liked' : 'unliked' };
    if (!cookie()) return { ok: false, reason: 'not_logged_in' };
    try {
      const body = await callSignedMusicu({
        module: 'music.musicasset.PlaylistDetailWrite',
        method: desired ? 'AddSonglist' : 'DelSonglist',
        param: { dirId: QQ_LIKED_DIRID, v_songInfo },
      });
      const code = Number(body?.req_1?.code);
      if (code === 0) return { ok: true, state: desired ? 'liked' : 'unliked' };
      return { ok: false, reason: likeFailureReason(code), code: Number.isFinite(code) ? code : null };
    } catch {
      return { ok: false, reason: 'request_failed', code: null };
    }
  }

  async function setSongLiked(songId, desired) {
    const songmid = String(songId || '').trim();
    if (!songmid) return { ok: false, reason: 'invalid_song' };
    if (!allowLikeWrite) return { ok: false, reason: 'unsupported', detail: 'qq-like-write-disabled', code: null };
    const identity = await resolveSongNumericIdentity(songmid);
    if (!identity) return { ok: false, reason: 'unresolved_song' };
    const songType = Number.isFinite(identity.type) ? identity.type : QQ_SONG_TYPE_NORMAL;
    return writeLikes([{ songType, songId: identity.id }], desired !== false);
  }

  /**
   * 批量收藏/取消收藏：一个请求最多 50 首（官方客户端同样的上限），
   * 用于「排歌后整批对齐远端」。返回 { ok, state, songs } 或失败原因。
   */
  async function setSongsLiked(songIds, desired) {
    const mids = [...new Set((Array.isArray(songIds) ? songIds : [songIds])
      .map(value => String(value ?? '').trim())
      .filter(Boolean))].slice(0, 50);
    if (!mids.length) return { ok: true, state: desired ? 'liked' : 'unliked', songs: 0 };
    const identities = await Promise.all(mids.map(mid => resolveSongNumericIdentity(mid)));
    const v_songInfo = identities.filter(Boolean)
      .map(row => ({ songType: Number.isFinite(row.type) ? row.type : QQ_SONG_TYPE_NORMAL, songId: row.id }));
    if (!v_songInfo.length) return { ok: false, reason: 'unresolved_song' };
    const result = await writeLikes(v_songInfo, desired !== false);
    return { ...result, songs: v_songInfo.length };
  }

  /**
   * 批量问「这些 mid 是否已在我喜欢」。排歌后一次性对齐整批曲目时用，
   * 官方 web 端也是这么发的（v_songMid 传数组）。
   * 返回 { ok, liked: Set<mid> } 或 { ok:false, reason, code }。
   */
  async function isSongLikedBatch(songIds) {
    const mids = [...new Set((Array.isArray(songIds) ? songIds : [])
      .map(value => String(value ?? '').trim())
      .filter(Boolean))];
    if (!mids.length) return { ok: true, liked: new Set() };
    if (!cookie()) return { ok: false, reason: 'not_logged_in' };
    try {
      const body = await callMusicu({
        module: 'music.musicasset.SongFavRead',
        method: 'IsSongFanByMid',
        param: { v_songMid: mids },
      });
      const code = Number(body?.req_1?.code);
      if (code === 1000) return { ok: false, reason: 'not_logged_in', code };
      if (code !== 0) return { ok: false, reason: 'request_failed', code: Number.isFinite(code) ? code : null };
      const mFan = body?.req_1?.data?.m_fan || {};
      return { ok: true, liked: new Set(mids.filter(mid => mFan[mid] === true)) };
    } catch {
      return { ok: false, reason: 'request_failed', code: null };
    }
  }

  /** 远端是否已在我喜欢。返回 { ok, liked } 或 { ok:false, reason, code }。 */
  async function isSongLiked(songId) {
    const songmid = String(songId || '').trim();
    if (!songmid) return { ok: false, reason: 'invalid_song' };
    if (!cookie()) return { ok: false, reason: 'not_logged_in' };
    try {
      const body = await callMusicu({
        module: 'music.musicasset.SongFavRead',
        method: 'IsSongFanByMid',
        param: { v_songMid: [songmid] },
      });
      const code = Number(body?.req_1?.code);
      if (code === 1000) return { ok: false, reason: 'not_logged_in', code };
      if (code !== 0) return { ok: false, reason: 'request_failed', code: Number.isFinite(code) ? code : null };
      const mFan = body?.req_1?.data?.m_fan;
      return { ok: true, liked: mFan?.[songmid] === true };
    } catch {
      return { ok: false, reason: 'request_failed', code: null };
    }
  }

  return Object.freeze({
    search: searchMusic,
    songUrl: playUrl,
    lyric: getLyric,
    coverArt: getCoverArt,
    comments: getComments,
    setSongLiked,
    setSongsLiked,
    isSongLiked,
    isSongLikedBatch,
    userPlaylists: getUserPlaylists,
    playlistDetail: getPlaylistDetail,
    albumTracks: getAlbumTracks,
    recommend: getRecommendedSongs,
    discover: getDiscoverySongs,
    loginStatus: getLoginStatus,
    libraryPlaylistsSnapshot: getLibraryPlaylistsSnapshot,
    libraryTracksSnapshot: getLibraryTracksSnapshot,
    likedSongs,
    likedSongIds,
    likedPlaylist: getLikedPlaylist,
  });
}

const qqMusicProvider = createQqMusicProvider();

export const search = (...args) => qqMusicProvider.search(...args);
export const albumTracks = (...args) => qqMusicProvider.albumTracks(...args);

// ---- pickMatch（与 NCM 同口径） ----
export function pickMatch(query, candidates) {
  if (!candidates.length) return null;
  const q = query.toLowerCase().trim();
  for (const c of candidates) {
    const t = (c.title || '').toLowerCase();
    const a = (c.artist || '').toLowerCase();
    if (t === q) { c.score = 100; return c; }
    if (t.includes(q)) { c.score = 85; return c; }
    if (q.includes(t) && t.length > 2) { c.score = 80; return c; }
    const parts = q.split(/\s+/);
    if (parts.length >= 2 && parts.every(p => t.includes(p) || a.includes(p))) {
      c.score = 75; return c;
    }
  }
  // 没有任何候选达到最低匹配度时**不猜**。
  // 以前这里返回 candidates[0] 并标 score=50，等于把抛硬币包装成结论：
  // 多源之后候选更多，猜错的代价是播出一首名字相近的别的歌。
  return null;
}

export const songUrl = (...args) => qqMusicProvider.songUrl(...args);
export const lyric = (...args) => qqMusicProvider.lyric(...args);
export const coverArt = (...args) => qqMusicProvider.coverArt(...args);
export const comments = (...args) => qqMusicProvider.comments(...args);
export const setSongLiked = (...args) => qqMusicProvider.setSongLiked(...args);
export const setSongsLiked = (...args) => qqMusicProvider.setSongsLiked(...args);
export const isSongLiked = (...args) => qqMusicProvider.isSongLiked(...args);
export const isSongLikedBatch = (...args) => qqMusicProvider.isSongLikedBatch(...args);
export const userPlaylists = (...args) => qqMusicProvider.userPlaylists(...args);

export async function libraryPlaylistsSnapshot(uid) {
  return qqMusicProvider.libraryPlaylistsSnapshot(uid);
}

export async function libraryTracksSnapshot(disstid, { reportedCount = null } = {}) {
  return qqMusicProvider.libraryTracksSnapshot(disstid, { reportedCount });
}

// ---- playlistAllTracks：拿一个歌单的全曲目 ----
// QQ 的 /songlist?id=<disstid> 返回完整曲目（不分页，但有上限）；
// 大歌单只能拿前若干首，与 NCM 的 limit 概念对齐。
export async function playlistAllTracks(disstid, { limit = 200 } = {}) {
  const { songs } = await qqMusicProvider.playlistDetail(disstid);
  return songs.slice(0, limit).map(normalizeQqSong).filter(song => song?.song_id);
}

// ---- likedSongs / likedSongIds：真实的「我喜欢」（dirId 201），不再猜第一个歌单 ----
export const likedSongs = (...args) => qqMusicProvider.likedSongs(...args);
export const likedSongIds = (...args) => qqMusicProvider.likedSongIds(...args);
export const likedPlaylist = (...args) => qqMusicProvider.likedPlaylist(...args);

// ---- recommend：daily 接口挂了 → fallback /recommend/playlist 取头几首歌单的歌 ----
export const recommend = (...args) => qqMusicProvider.recommend(...args);
export const discover = (...args) => qqMusicProvider.discover(...args);
export const loginStatus = (...args) => qqMusicProvider.loginStatus(...args);

// ---- QR 登录：认证 SDK 只返回给本模块 Cookie；临时 QQ 参数不出后端 ----
export const qrKey = (...args) => qqQrLogin.qrKey(...args);
export const qrCreate = (...args) => qqQrLogin.qrCreate(...args);
export const qrCheck = (...args) => qqQrLogin.qrCheck(...args);

export async function logout() {
  clearCookie();
  return { ok: true };
}

export async function ping() {
  return true;
}

// ---- 缓存音频（与 ncm 共用媒体资产库：并发去重 + 原子发布 + 解码校验） ----
export async function cacheAudio(songId, url, { expectedDurationSeconds = 0 } = {}) {
  if (!url) return null;
  ensureCacheDir();
  return getMediaAssetStore().acquire({ provider: 'qq', songId, url, expectedDurationSeconds });
}

// ---- 核心：解析 query → 可播放轨道 ----
export async function resolveQuery(query) {
  try {
    const candidates = await search(query);
    if (!candidates.length) return { ...sourceFailure(SOURCE_FAILURE.NOT_FOUND, { source: 'qq', query }) };
    const meta = pickMatch(query, candidates);
    // 匹配不到明确目标 == 源里没有这首歌（对用户是同一件事：得换个说法或换歌）。
    if (!meta) return { ...sourceFailure(SOURCE_FAILURE.NOT_FOUND, { source: 'qq', query }) };

    const [url, lyr] = await Promise.all([songUrl(meta.song_id), lyric(meta.song_id)]);
    if (!url) return { ok: false, query, ...meta, ...sourceFailure(SOURCE_FAILURE.NOT_PLAYABLE, { source: 'qq' }) };

    const cached = await cacheAudio(meta.song_id, url, { expectedDurationSeconds: Number(meta.duration) || 0 });
    return {
      ok: true,
      query,
      ...meta,
      // 缓存没成也绝不把供应商直链交给播放器：跨源媒体元素在 Web Audio 图里是静音
      // （进度条照走、没有任何报错）。同源中继由 server/media/remoteAudioProxy.js 提供。
      url: cached?.url || remoteAudioUrl('qq', meta.song_id),
      original_url: url,
      lyric: lyr,
      cached: cached?.cached || false,
      source: 'qq',
    };
  } catch (e) {
    // 只归因，不回显原文：这里可能带着 cookie 或内部地址。
    return sourceFailure(e, { source: 'qq', query });
  }
}

export default {
  search, pickMatch, songUrl, lyric, coverArt, comments, recommend, userPlaylists, playlistAllTracks,
  likedSongs, likedSongIds, likedPlaylist, setSongLiked, setSongsLiked, isSongLiked, isSongLikedBatch,
  cacheAudio, resolveQuery, loginStatus,
  qrKey, qrCreate, qrCheck,
  setCookie, getCookie, clearCookie, getUid, onCookieChange, logout, ping,
  libraryPlaylistsSnapshot, libraryTracksSnapshot,
};
