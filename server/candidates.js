// candidates.js — 多源候选池（NCM + QQ）
// 同时从两边已登录的源拉取 liked / 自建歌单 / daily，按 <provider>:<bucket> 打标签合并。
// 失败容错：任何源失败不影响其他源；全部失败返回空数组。
// 同名歌曲不是同一录音；只用 provider + song_id 合并重复 bucket。
// 缓存 key = `${ncmUid || '_'}|${qqUid || '_'}`，任一源 cookie 变化即失效。

import * as ncm from './ncm.js';
import * as qq from './qq.js';

const TTL_MS = parseInt(process.env.CANDIDATES_TTL_MS || String(30 * 60 * 1000), 10);

// 候选池覆盖面：每个 provider 取前 N 个自建歌单、每歌单取前 M 首。
// 旧实现只取「最小的 2 个歌单 ×30 首」，导致 Eason(77) 这类大歌单永远进不了
// 候选池 → 既打不上标、也搜不到。放宽后大歌单也能进池被打标/检索。
// trackCount<2000 的守卫仍在（见 fetchSource），避免拉超巨歌单拖垮拉取。
const MAX_PLAYLISTS = Math.max(1, parseInt(process.env.CANDIDATE_MAX_PLAYLISTS || '8', 10));
const PLAYLIST_LIMIT = Math.max(1, parseInt(process.env.CANDIDATE_PLAYLIST_LIMIT || '50', 10));

const cache = new Map();

// eval-only：注入一个确定的候选池，让 harness 不依赖 NCM/QQ 登录态。
// null = 未注入（线上正常走 NCM/QQ）。只有 agent-eval-harness 的 invoker 会设它。
let _evalPool = null;
let _candidateObserver = null;
export function __setEvalCandidatePool(list) {
  _evalPool = Array.isArray(list) ? list : null;
}

export function setCandidateObserver(observer) {
  _candidateObserver = typeof observer === 'function' ? observer : null;
}

function notifyCandidateObserver(list) {
  if (!_candidateObserver || !Array.isArray(list) || list.length === 0) return;
  queueMicrotask(() => {
    try {
      Promise.resolve(_candidateObserver(list)).catch(() => {});
    } catch {}
  });
}

export function __notifyCandidateObserverForTest(list) {
  notifyCandidateObserver(list);
}

export function invalidateCandidates() {
  cache.clear();
}

/**
 * 同步读取最近一次缓存的候选池快照。
 *
 * 供需要同步检查候选缓存的调用方使用，不触发网络刷新。
 * 如果还没有任何缓存（启动后第一次还没人调过 loadCandidates）就返回空数组 ——
 * 调用方应该把"空快照"视为"暂时无法校验"而不是"用户库为空"。
 *
 * 缓存内容会被任意 loadCandidates 调用（含 /api/me/library 接口、searchLibrary 工具等）
 * 自然填充，过期后 TTL_MS 触发下一次刷新。
 *
 * @returns {Array<{title:string, artist:string, song_id?:string, source?:string}>}
 */
export function getCachedCandidatesSnapshot() {
  if (_evalPool) return _evalPool;
  // 找最新一条缓存（按 at 排序）
  let newest = null;
  for (const entry of cache.values()) {
    if (!newest || entry.at > newest.at) newest = entry;
  }
  return newest?.list || [];
}

ncm.onCookieChange(() => cache.clear());
qq.onCookieChange(() => cache.clear());

function dedup(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const provider = String(it?.source || '').split(':')[0];
    const songId = String(it?.song_id || it?.songId || '');
    if (!it?.title || !provider || !songId) continue;
    const k = `${provider}:${songId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

export function shouldFetchCandidatePlaylist(playlist) {
  if (!playlist) return false;
  const countKnown = playlist.trackCount !== null && playlist.trackCount !== undefined
    && Number.isFinite(Number(playlist.trackCount));
  return !countKnown || (Number(playlist.trackCount) > 0 && Number(playlist.trackCount) < 2000);
}

export async function fetchSource({ likedFn, userPlaylistsFn, playlistAllTracksFn, recommendFn, getUid, provider }) {
  const uid = typeof getUid === 'function' ? getUid() : getUid;
  const likedTask = uid ? likedFn(uid, { limit: 50 }).then(items =>
    items.map(track => ({ ...track, source: `${provider}:liked` }))).catch(() => []) : Promise.resolve([]);
  const playlistTask = uid ? (async () => {
    const playlists = await userPlaylistsFn(uid).catch(() => []);
    const owned = (playlists || [])
      // A missing upstream count is not evidence that the playlist is empty.
      // Reading remains bounded by PLAYLIST_LIMIT, so it is safe to probe.
      .filter(shouldFetchCandidatePlaylist)
      .slice(0, MAX_PLAYLISTS);
    const playlistItems = [];
    for (const pl of owned) {
      const tracks = await playlistAllTracksFn(pl.id, { limit: PLAYLIST_LIMIT }).catch(() => []);
      for (const t of tracks) {
        playlistItems.push({ ...t, source: `${provider}:playlist:${pl.name}` });
      }
    }
    return playlistItems;
  })() : Promise.resolve([]);
  const dailyTask = recommendFn(30).then(items =>
    items.map(track => ({ ...track, source: `${provider}:daily` }))).catch(() => []);
  const [liked, playlist, daily] = await Promise.all([likedTask, playlistTask, dailyTask]);
  return { liked, playlist, daily };
}

/**
 * 拉取候选池：同时从 NCM + QQ 拉，合并去重。
 * @param {{ ncmUid?: string|number, qqUid?: string|number }}
 * @returns {Promise<{ list: Array, counts: { ncm:object, qq:object }, cachedAt: number }>}
 */
export async function loadCandidates({ ncmUid, qqUid } = {}) {
  if (_evalPool) return { list: _evalPool, counts: { ncm: {}, qq: {} }, cachedAt: Date.now() };
  const ncmCookie = ncm.getCookie();
  const qqCookie = qq.getCookie();
  const effectiveNcmUid = ncmCookie ? ncmUid || '' : '';
  const effectiveQqUid = qqCookie ? qqUid || '' : '';
  const cacheKey = `${String(effectiveNcmUid || '_')}|${String(effectiveQqUid || '_')}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { list: hit.list, counts: hit.counts, cachedAt: hit.at };
  }

  const results = await Promise.all([
    effectiveNcmUid
      ? fetchSource({
          provider: 'ncm', getUid: effectiveNcmUid,
          likedFn: ncm.likedSongs, userPlaylistsFn: ncm.userPlaylists,
          playlistAllTracksFn: ncm.playlistAllTracks, recommendFn: ncm.recommend,
        }).catch(() => ({ liked: [], playlist: [], daily: [] }))
      : Promise.resolve({ liked: [], playlist: [], daily: [] }),
    effectiveQqUid
      ? fetchSource({
          provider: 'qq', getUid: effectiveQqUid,
          likedFn: qq.likedSongs, userPlaylistsFn: qq.userPlaylists,
          playlistAllTracksFn: qq.playlistAllTracks, recommendFn: qq.recommend,
        }).catch(() => ({ liked: [], playlist: [], daily: [] }))
      : Promise.resolve({ liked: [], playlist: [], daily: [] }),
  ]);

  const [ncmResult, qqResult] = results;
  const all = [...ncmResult.liked, ...ncmResult.playlist, ...ncmResult.daily,
               ...qqResult.liked, ...qqResult.playlist, ...qqResult.daily];

  const merged = dedup(all);

  const count = (sourcePrefix) => merged.filter(t => t.source?.startsWith(sourcePrefix)).length;
  const counts = {
    ncm: {
      liked: count('ncm:liked'),
      playlist: count('ncm:playlist'),
      daily: count('ncm:daily'),
    },
    qq: {
      liked: count('qq:liked'),
      playlist: count('qq:playlist'),
      daily: count('qq:daily'),
    },
  };

  const at = Date.now();
  // A cookie switch may happen while one provider's playlist request is still
  // in flight. Never publish that old account's rows into the new snapshot.
  if (ncm.getCookie() === ncmCookie && qq.getCookie() === qqCookie) {
    cache.set(cacheKey, { at, list: merged, counts });
    notifyCandidateObserver(merged);
  }
  return { list: merged, counts, cachedAt: at };
}

/**
 * 从候选池结果里取出曲目数组。
 *
 * `loadCandidates` 返回的是带 list/counts/cachedAt 的信封；把它当成数组会在选择链路上直接抛错。
 *
 * @param {{list?: Array}|Array|null} result
 * @returns {Array}
 */
export function candidateTrackList(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.list) ? result.list : [];
}
