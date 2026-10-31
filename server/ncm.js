// ncm.js — NeteaseCloudMusicApi 客户端（增强版）
// 搜索多候选匹配、播放列表获取、推荐、缓存、重试。

import { mkdirSync } from 'node:fs';
import { resolveAudioCacheDir } from './runtimePaths.js';
import { getMediaAssetStore } from './media/sharedMediaAssets.js';
import { remoteAudioUrl } from './media/remoteAudioProxy.js';
import { SOURCE_FAILURE, sourceFailure, classifySourceFailure } from './music/sourceFailure.js';
import { reportSourceHealth } from './music/sourceHealthSignal.js';

// 基地址可设置：内置服务可能因端口冲突改听空闲端口（见 ncmEmbedded.js），
// 组合根在启动后把实际地址同步进来；默认值保持原有约定。
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
let BASE = normalizeBaseUrl(process.env.NCM_BASE_URL) || DEFAULT_BASE_URL;
let COOKIE = process.env.NCM_COOKIE || '';

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  return raw ? raw.replace(/\/+$/, '') : '';
}

export function setBaseUrl(url) {
  const next = normalizeBaseUrl(url);
  if (!next) return;
  BASE = next;
  process.env.NCM_BASE_URL = next;
}

export function getBaseUrl() { return BASE; }

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

// 监听 cookie 变化（候选池缓存等下游模块订阅，避免循环依赖）
const _cookieListeners = new Set();
export function onCookieChange(fn) { _cookieListeners.add(fn); return () => _cookieListeners.delete(fn); }
function _emitCookieChange() {
  for (const fn of _cookieListeners) { try { fn(COOKIE); } catch {} }
}

export function setCookie(c) {
  COOKIE = (c || '').trim();
  process.env.NCM_COOKIE = COOKIE;
  _emitCookieChange();
}

export function getCookie() { return COOKIE; }

export function clearCookie() {
  COOKIE = '';
  process.env.NCM_COOKIE = '';
  _emitCookieChange();
}

// ---- 基础请求 ----
// opts.noCookie：QR 登录系列必须用，避免 NeteaseCloudMusicApi 把旧账号 cookie
//   带过去导致后端命中「老用户的登录态」、新二维码扫了也只回旧 cookie。
// opts.noCache：所有跟登录态相关的接口加 timestamp 旁路 NCM API 自带的 LRU 缓存。
async function _get(path, params = {}, timeout = 8000, opts = {}) {
  const requestParams = new URLSearchParams(params);
  const authenticated = Boolean(COOKIE && !opts.noCookie);
  if (authenticated) requestParams.set('cookie', COOKIE);
  if (opts.noCache) requestParams.set('timestamp', String(Date.now()));

  // NeteaseCloudMusicApi logs req.originalUrl. Keeping authenticated values in
  // the form body prevents cookies, account UIDs and playlist IDs from leaking
  // into its access log while preserving the same read-only route semantics.
  const url = authenticated ? `${BASE}${path}` : `${BASE}${path}?${requestParams.toString()}`;
  const init = authenticated
    ? {
        method: 'POST',
        // NeteaseCloudMusicApi 的 apicache 只用 URL + header cookie 作 key，看不到 body：
        // 不旁路的话 2 分钟内所有歌的 /lyric、/song/url/v1 都会拿到第一首的回应。
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-apicache-bypass': '1' },
        body: requestParams,
        signal: AbortSignal.timeout(timeout),
      }
    : { signal: AbortSignal.timeout(timeout) };
  const r = await fetch(url, init);
  if (!r.ok) {
    // 写接口会拿 HTTP 4xx/5xx 承载业务原因（例如「下架歌曲无法收藏」是 500 +
    // body.code 500）。只有显式要求时把 body 交出去，默认仍是抛错——读接口
    // 一直依赖这个行为。
    if (opts.allowHttpError) {
      try { return await r.json(); } catch { return { code: r.status }; }
    }
    throw new Error(`ncm ${path} → ${r.status}`);
  }
  return r.json();
}

/** 封面必须走 https：http 图在 https 页面会被混合内容策略直接拦掉，表现为「没有封面」。 */
export function normalizeArtworkUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  if (raw.startsWith('http://')) return `https://${raw.slice('http://'.length)}`;
  return /^https:\/\//i.test(raw) ? raw : '';
}

// ---- 封面（按 songId） ----
// 三种返回值含义与 qq.coverArt 一致：resolved / absent / null（这次没查到）。
export async function coverArt(songId) {
  const id = String(songId || '').trim();
  if (!id) return null;
  try {
    const j = await _get('/song/detail', { ids: id }, 6000, { noCookie: true });
    const song = Array.isArray(j?.songs) ? j.songs[0] : null;
    if (!song) return null;
    const artwork = normalizeArtworkUrl(song?.al?.picUrl);
    if (artwork) return { state: 'resolved', artwork };
    return String(song?.al?.name || '').trim() ? null : { state: 'absent' };
  } catch { return null; }
}

// ---- 搜索（返回多条候选） ----
export async function search(keywords, limit = 10) {
  const j = await _get('/cloudsearch', { keywords, limit });
  const songs = j?.result?.songs || [];
  return songs.map(s => ({
    song_id: String(s.id),
    title: s.name,
    artist: (s.ar || []).map(a => a.name).join(' / '),
    album: s.al?.name || '',
    album_id: String(s.al?.id || ''),
    pic_url: normalizeArtworkUrl(s.al?.picUrl),
    duration: Math.round((s.dt || 0) / 1000),
    year: s.publishTime > 0 ? new Date(s.publishTime).getFullYear() : null,
    score: 0, // 由 matcher 填充
  }));
}

// ---- 热门评论（song-tag 打标的长尾兜底弱信号；失败安全返 []） ----
export async function comments(songId, limit = 10) {
  try {
    const j = await _get('/comment/music', { id: songId, limit }, 8000, { noCookie: true });
    const hot = Array.isArray(j?.hotComments) ? j.hotComments : [];
    const normal = Array.isArray(j?.comments) ? j.comments : [];
    const pick = (hot.length ? hot : normal).slice(0, limit);
    return pick.map(c => String(c?.content || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ---- 智能匹配：从搜索结果中挑最佳 ----
export function pickMatch(query, candidates) {
  if (!candidates.length) return null;

  const q = query.toLowerCase().trim();

  for (const c of candidates) {
    const t = (c.title || '').toLowerCase();
    const a = (c.artist || '').toLowerCase();
    const al = (c.album || '').toLowerCase();

    // 精确匹配标题
    if (t === q) { c.score = 100; return c; }
    // 标题包含查询
    if (t.includes(q)) { c.score = 85; return c; }
    // 查询包含标题
    if (q.includes(t) && t.length > 2) { c.score = 80; return c; }
    // 艺人+标题
    const parts = q.split(/\s+/);
    if (parts.length >= 2 && parts.every(p => t.includes(p) || a.includes(p))) {
      c.score = 75;
      return c;
    }
  }

  // 兜底：第一个
  // 没有任何候选达到最低匹配度时**不猜**。
  // 以前这里返回 candidates[0] 并标 score=50，等于把抛硬币包装成结论：
  // 多源之后候选更多，猜错的代价是播出一首名字相近的别的歌。
  return null;
}

// ---- 多策略拿直链（quality 降级重试） ----
// 只给试听片段（`freeTrialInfo` 非空，常见于未登录/无会员的 VIP 歌）不算完整音源：
// 电台里播 30 秒就断等于放歌失败。有任一音质正常回应却没有完整音源 → null（not-playable）；
// 每个音质都抛错 → 重新抛出，让上层按超时/源不可用归因，不把一次断网当成「放不了」。
export async function songUrl(songId) {
  const levels = ['hires', 'lossless', 'exhigh', 'standard'];
  let lastError = null;
  let answered = false;
  for (const level of levels) {
    try {
      const j = await _get('/song/url/v1', { id: songId, level });
      answered = true;
      const item = j?.data?.[0];
      if (item?.url && !item.freeTrialInfo) return item.url;
    } catch (error) { lastError = error; }
  }
  if (!answered && lastError) throw lastError;
  return null;
}

// ---- 歌词 ----
export async function lyric(songId) {
  try {
    const j = await _get('/lyric', { id: songId });
    return {
      lrc: j?.lrc?.lyric || '',
      tlyric: j?.tlyric?.lyric || '',
    };
  } catch {
    return { lrc: '', tlyric: '' };
  }
}

// ---- 个性化推荐（需要 cookie） ----
export async function recommend(limit = 20) {
  if (!COOKIE) return [];
  try {
    const j = await _get('/recommend/songs');
    return (j?.data?.dailySongs || []).slice(0, limit).map(s => ({
      song_id: String(s.id),
      title: s.name,
      artist: (s.ar || []).map(a => a.name).join(' / '),
      album: s.al?.name || '',
      album_id: String(s.al?.id || ''),
      pic_url: normalizeArtworkUrl(s.al?.picUrl),
      duration: Math.round((s.dt || 0) / 1000),
      reason: s.reason || '推荐',
    }));
  } catch {
    return [];
  }
}

// ---- 用户歌单列表 ----
export async function userPlaylists(uid) {
  if (!COOKIE) return [];
  try {
    const j = await _get('/user/playlist', { uid });
    return (j?.playlist || []).map(p => ({
      id: String(p.id),
      name: p.name,
      trackCount: p.trackCount,
      coverImgUrl: p.coverImgUrl,
    }));
  } catch {
    return [];
  }
}

// Strict library snapshots are separate from playback-safe helpers: failures
// remain visible so reconciliation never mistakes an outage for an empty list.
export async function libraryPlaylistsSnapshot(uid, { pageSize = 1000 } = {}) {
  if (!COOKIE || !uid) throw new Error('ncm library playlists: verified login required');
  const items = [];
  let offset = 0;
  let reportedCount = null;
  for (;;) {
    const j = await _get('/user/playlist', { uid, limit: pageSize, offset }, 12000, { noCache: true });
    if (!Array.isArray(j?.playlist)) throw new Error('ncm library playlists: invalid payload');
    const chunk = j.playlist.map(p => ({
      id: String(p.id),
      name: p.name || '',
      trackCount: Number.isFinite(Number(p.trackCount)) ? Number(p.trackCount) : null,
      coverImgUrl: p.coverImgUrl || '',
    }));
    items.push(...chunk);
    if (Number.isFinite(Number(j?.count))) reportedCount = Number(j.count);
    if (Number.isFinite(Number(j?.total))) reportedCount = Number(j.total);
    const more = j?.more === true || (reportedCount != null && items.length < reportedCount);
    if (!more) break;
    if (chunk.length === 0) throw new Error('ncm library playlists: pagination stopped early');
    offset += chunk.length;
  }
  const expected = reportedCount ?? items.length;
  return { items, complete: items.length === expected, reportedCount: expected, fetchedCount: items.length, error: null };
}

export async function libraryTracksSnapshot(playlistId, { reportedCount = null, pageSize = 1000 } = {}) {
  if (!COOKIE) throw new Error('ncm library tracks: verified login required');
  const expected = Number.isFinite(Number(reportedCount)) ? Math.max(0, Number(reportedCount)) : null;
  const items = [];
  let offset = 0;
  for (;;) {
    const limit = expected == null ? pageSize : Math.min(pageSize, Math.max(0, expected - offset));
    if (limit === 0) break;
    const j = await _get('/playlist/track/all', { id: playlistId, limit, offset }, 12000, { noCache: true });
    if (!Array.isArray(j?.songs)) throw new Error('ncm library tracks: invalid payload');
    const chunk = j.songs.map(s => ({
      song_id: String(s.id),
      title: s.name || '',
      artist: (s.ar || []).map(a => a.name).join(' / '),
      album: s.al?.name || '',
      duration: Math.round((s.dt || 0) / 1000),
      year: s.publishTime > 0 ? new Date(s.publishTime).getFullYear() : null,
    }));
    items.push(...chunk);
    offset += chunk.length;
    if (expected != null && items.length >= expected) break;
    if (chunk.length < limit || chunk.length === 0) break;
  }
  const finalExpected = expected ?? items.length;
  const complete = items.length === finalExpected;
  return {
    items, complete, reportedCount: finalExpected, fetchedCount: items.length,
    error: complete ? null : `ncm count mismatch: expected ${finalExpected}, fetched ${items.length}`,
  };
}

// ---- 歌单详情 ----
export async function playlistDetail(playlistId, limit = 50) {
  try {
    const j = await _get('/playlist/detail', { id: playlistId });
    const tracks = j?.playlist?.tracks || [];
    return tracks.slice(0, limit).map(s => ({
      song_id: String(s.id),
      title: s.name,
      artist: (s.ar || []).map(a => a.name).join(' / '),
      album: s.al?.name || '',
      album_id: String(s.al?.id || ''),
      pic_url: normalizeArtworkUrl(s.al?.picUrl),
      duration: Math.round((s.dt || 0) / 1000),
    }));
  } catch {
    return [];
  }
}

// ---- 歌单全量曲目（分页） ----
// `/playlist/detail` 只返回前一截 tracks 全量元数据；大歌单要走 `/playlist/track/all`。
// limit > 1000 时自动按 1000 分批合并。
export async function playlistAllTracks(id, { limit = 200, offset = 0 } = {}) {
  const fetchChunk = async (chunkLimit, chunkOffset) => {
    try {
      const j = await _get('/playlist/track/all', { id, limit: chunkLimit, offset: chunkOffset }, 12000);
      const songs = j?.songs || [];
      return songs.map(s => ({
        song_id: String(s.id),
        title: s.name,
        artist: (s.ar || []).map(a => a.name).join(' / '),
        album: s.al?.name || '',
        album_id: String(s.al?.id || ''),
        pic_url: normalizeArtworkUrl(s.al?.picUrl),
        duration: Math.round((s.dt || 0) / 1000),
      }));
    } catch {
      return [];
    }
  };

  if (limit <= 1000) return fetchChunk(limit, offset);

  const out = [];
  for (let off = offset; off < offset + limit; off += 1000) {
    const remaining = offset + limit - off;
    const chunk = await fetchChunk(Math.min(1000, remaining), off);
    if (!chunk.length) break;
    out.push(...chunk);
    if (chunk.length < 1000) break;
  }
  return out;
}

// ---- 专辑曲目（整专连播，add-album-sequencing） ----
// `/album` 一次返回整张专辑的曲目列表，没有分页参数；limit/offset 在本地切片，
// 与 playlistAllTracks 保持同一个返回形状，供上层共用一套映射。失败返回安全空值。
export async function albumTracks(id, { limit = 200, offset = 0 } = {}) {
  const albumId = String(id ?? '').trim();
  if (!albumId) return [];
  try {
    const j = await _get('/album', { id: albumId }, 12000);
    const songs = j?.songs || j?.album?.songs || [];
    return songs.map(s => ({
      song_id: String(s.id),
      title: s.name,
      artist: (s.ar || []).map(a => a.name).join(' / '),
      album: s.al?.name || j?.album?.name || '',
      album_id: String(s.al?.id || albumId),
      pic_url: normalizeArtworkUrl(s.al?.picUrl || j?.album?.picUrl),
      duration: Math.round((s.dt || 0) / 1000),
    })).slice(offset, offset + limit);
  } catch {
    return [];
  }
}

// ---- "我喜欢的音乐"（网易云惯例：用户歌单列表第 0 项就是 liked） ----
export async function likedSongs(uid, { limit = 100 } = {}) {
  if (!COOKIE || !uid) return [];
  const lists = await userPlaylists(uid);
  if (!lists.length) return [];
  return playlistAllTracks(lists[0].id, { limit });
}

// ---- 「喜欢 / 取消喜欢」写入（红心） ----
// 内嵌 NeteaseCloudMusicApi 的 /like 就是红心开关（module/like.js → weapi
// /api/radio/like）：加与删是**同一个端点**，只由 like 参数区分，所以不存在
// 「能加不能删」的半套实现。带 cookie 的请求由 _get 走 POST 表单体，凭据不会
// 进 URL 与上游访问日志。
//
// 返回结构化结果而不是抛错：调用方（未来的 like 服务）要据此区分「未登录」
// 「供应商失败」和「已成功」，不能把一次 5xx 当成用户不想喜欢了。
export async function setSongLiked(songId, liked) {
  const id = String(songId ?? '').trim();
  if (!id) return { ok: false, reason: 'invalid_song' };
  if (!COOKIE) return { ok: false, reason: 'not_logged_in' };
  try {
    const body = await _get('/like', { id, like: liked ? 'true' : 'false' }, 8000,
      { noCache: true, allowHttpError: true });
    const code = Number(body?.code);
    if (code === 200) return { ok: true, state: liked ? 'liked' : 'unliked' };
    // 301 = 需要登录（cookie 失效）。401/500 在真机上对应「下架歌曲无法收藏」：
    // 上游对已下架/无版权曲目就是这样拒绝的，别把它说成网络故障。
    if (code === 301) return { ok: false, reason: 'not_logged_in', code };
    if (code === 401 || code === 500) return { ok: false, reason: 'not_collectable', code };
    return { ok: false, reason: 'request_failed', code: Number.isFinite(code) ? code : null };
  } catch {
    return { ok: false, reason: 'request_failed', code: null };
  }
}

/**
 * 已喜欢歌曲 id 列表（无序）。用于点击前判重、写入后回显。
 * 与 likedSongs() 的区别：那条路要翻歌单分页，这条是官方专用的 id 列表接口。
 *
 * 返回 `{ ok, ids, reason }` 而不是裸数组：「读到空列表」和「没读到」必须分开。
 * 前者说明用户确实没有收藏，后者说明校准没完成 —— 把后者当成前者会让界面
 * 谎称「已同步」。
 */
export async function likedSongIds(uid) {
  if (!COOKIE || !uid) return { ok: false, ids: [], reason: 'not_logged_in' };
  try {
    const body = await _get('/likelist', { uid: String(uid) }, 8000, { noCache: true });
    const code = Number(body?.code);
    if (code !== 200 || !Array.isArray(body?.ids)) {
      return { ok: false, ids: [], reason: code === 301 ? 'not_logged_in' : 'request_failed' };
    }
    return { ok: true, ids: body.ids.map(String), reason: null };
  } catch {
    return { ok: false, ids: [], reason: 'request_failed' };
  }
}

// ---- 下载并缓存音频文件（与 qq 共用媒体资产库：并发去重 + 原子发布 + 解码校验） ----
export async function cacheAudio(songId, url, { expectedDurationSeconds = 0 } = {}) {
  if (!url) return null;
  ensureCacheDir();
  return getMediaAssetStore().acquire({ provider: 'ncm', songId, url, expectedDurationSeconds });
}

// ---- 核心：解析 query → 可播放轨道（增强版） ----
export async function resolveQuery(query) {
  try {
    // 1) 搜索
    const candidates = await search(query);
    if (!candidates.length) return sourceFailure(SOURCE_FAILURE.NOT_FOUND, { source: 'ncm', query });

    // 2) 智能匹配（达不到最低匹配度就不猜）
    const meta = pickMatch(query, candidates);
    if (!meta) return sourceFailure(SOURCE_FAILURE.NOT_FOUND, { source: 'ncm', query });

    // 3) 并行拿直链 + 歌词
    const [url, lyr] = await Promise.all([
      songUrl(meta.song_id),
      lyric(meta.song_id),
    ]);

    if (!url) return { ok: false, query, ...meta, ...sourceFailure(SOURCE_FAILURE.NOT_PLAYABLE, { source: 'ncm' }) };

    // 4) 预缓存音频
    const cached = await cacheAudio(meta.song_id, url, { expectedDurationSeconds: Number(meta.duration) || 0 });

    return {
      ok: true,
      query,
      ...meta,
      // 缓存没成也不回落供应商直链：跨源媒体元素在 Web Audio 图里会被静音播放。
      url: cached?.url || remoteAudioUrl('ncm', meta.song_id),
      original_url: url,
      lyric: lyr,
      cached: cached?.cached || false,
    };
  } catch (e) {
    // 只归因，不回显原文：这里可能带着 cookie 或内部地址。
    return sourceFailure(e, { source: 'ncm', query });
  }
}

// ---- 登录状态 ----
// 这里强制 noCache：以前 NCM API 默认 LRU 会把过期或者旧账号的 status 缓存住，
// 导致 PWA 一直以为是老用户。每次都 timestamp 走真实查询。
export async function loginStatus() {
  if (!COOKIE) return { loggedIn: false, reason: 'no cookie set' };
  const requestedCookie = COOKIE;
  const failed = code => {
    if (COOKIE !== requestedCookie) code = SOURCE_FAILURE.UNAVAILABLE;
    if (code === SOURCE_FAILURE.REQUIRES_AUTH) reportSourceHealth('ncm', code);
    return { loggedIn: false, reason: code === SOURCE_FAILURE.REQUIRES_AUTH ? '需要重新登录网易云音乐' : '音乐源登录状态暂时无法核验', code };
  };
  try {
    const j = await _get('/login/status', {}, 8000, { noCache: true });
    if (COOKIE !== requestedCookie) return failed(SOURCE_FAILURE.UNAVAILABLE);
    const acc = j?.data?.account;
    const profile = j?.data?.profile;
    if (acc && profile) {
      return {
        loggedIn: true,
        userId: String(acc.id),
        nickname: profile.nickname || '',
        avatarUrl: profile.avatarUrl || '',
        vipType: acc.vipType || 0,
      };
    }
    const status = j?.data;
    // A valid login-status response with explicitly null account/profile confirms logout;
    // missing or malformed payload does not. Keep the reason closed for every provider.
    const statusCode = Number(status?.code);
    const expired = statusCode === 301 || (statusCode === 200 && Object.hasOwn(status, 'account')
      && Object.hasOwn(status, 'profile') && status.account === null && status.profile === null);
    return failed(expired ? SOURCE_FAILURE.REQUIRES_AUTH
      : statusCode >= 500 ? SOURCE_FAILURE.UNAVAILABLE : SOURCE_FAILURE.INTERNAL);
  } catch (error) {
    return failed(classifySourceFailure(error));
  }
}

// ---- QR 码登录 ----
// 关键：QR 三个接口都不要把旧 cookie 带过去 —— 否则 NeteaseCloudMusicApi
// 后端 csrf/anonymous_token 会跟着旧账号走，新扫码拿到的 cookie 仍然落到旧账号上。
// 同时全部 timestamp 旁路缓存。
export async function qrKey() {
  const j = await _get('/login/qr/key', {}, 8000, { noCookie: true, noCache: true });
  return j?.data?.unikey || null;
}

export async function qrCreate(key) {
  const j = await _get('/login/qr/create', { key, qrimg: true }, 8000, { noCookie: true, noCache: true });
  return {
    qrimg: j?.data?.qrimg || '',   // base64 png
    qrurl: j?.data?.qrurl || '',
  };
}

export async function qrCheck(key) {
  const j = await _get('/login/qr/check', { key }, 8000, { noCookie: true, noCache: true });
  // NCM API 返回: { code: 200, data: { code: 803 }, cookie: 'MUSIC_U=...' }
  // 实际状态码在 data.code 里 (800=过期, 801=待扫码, 802=已扫码待确认, 803=成功)
  const statusCode = (j?.data && typeof j.data.code === 'number') ? j.data.code : (j?.code || 0);
  return {
    code: statusCode,
    cookie: j?.cookie || '',
    message: j?.message || '',
  };
}

// ---- 退出登录 ----
// 服务端 + 本地全部清掉。NeteaseCloudMusicApi 的 /logout 会让该 cookie 失效。
export async function logout() {
  if (COOKIE) {
    try { await _get('/logout', {}, 5000, { noCache: true }); } catch {}
  }
  clearCookie();
  return { ok: true };
}

// ---- 心跳 ----
export async function ping() {
  try {
    const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export default { search, pickMatch, songUrl, lyric, coverArt, comments, recommend, userPlaylists, playlistDetail, playlistAllTracks, libraryPlaylistsSnapshot, libraryTracksSnapshot, likedSongs, likedSongIds, setSongLiked, cacheAudio, resolveQuery, loginStatus, qrKey, qrCreate, qrCheck, setCookie, getCookie, clearCookie, logout, ping, setBaseUrl, getBaseUrl };
