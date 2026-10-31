// musicTools.js — Music search and playlist tools for the radiohost agent
//
// Extracted from server/agent.js. Each function takes (args) and returns a string
// suitable for LLM tool result injection.

import * as ncm from '../ncm.js';
import * as qq from '../qq.js';
import * as candidates from '../candidates.js';
import * as musicResolver from '../musicResolver.js';
import { rememberTracks } from '../libraryTrackCache.js';
import { filterCandidatesByTags, appendAnnotation, hasAnyTagFilter } from '../songtags/songTagRetrieval.js';
import { toolFailure, toolSuccess } from './ToolOutcome.js';
import { getLibraryStore } from '../library/libraryStore.js';
import { getSongTagStore } from '../songtags/songTagStore.js';
import { rankCandidatesByTaste } from '../library/tasteBootstrap.js';
import { providerRegistry } from '../music/providerRegistry.js';

const PLAYLIST_SOURCES = new Set(['all', ...providerRegistry.defaultSourceCandidates()]);

function normalizeSource(value) {
  const source = String(value || 'all').trim().toLowerCase();
  return PLAYLIST_SOURCES.has(source) ? source : null;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? fallback, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizedTrackCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) ? count : null;
}

function providerDeps(overrides = {}) {
  return {
    ncm: overrides.ncm || ncm,
    qq: overrides.qq || qq,
    rememberTracks: overrides.rememberTracks || rememberTracks,
  };
}

/**
 * Search user's personal library (NCM + QQ merged candidate pool).
 * 支持两种过滤（可组合）：
 *   - query：标题/艺人子串匹配（向后兼容）
 *   - tags：结构化标签精筛（mood/energy/language/year/艺人性别…）；
 *           使用 tags 时未打标的歌被排除。
 * 命中行附带 `[mood:.. energy:.. ...]` 注解（无 tag 的歌为普通行）。
 * @param {object} args
 * @param {string} [args.query] - Search keyword (title or artist)
 * @param {object} [args.tags] - Structured tag filter
 * @returns {Promise<string>}
 */
export async function searchLibrary(args) {
  const query = String(args.query || '');
  const tags = args.tags && typeof args.tags === 'object' ? args.tags : null;
  const hasTags = hasAnyTagFilter(tags);
  let list = [];
  try {
    const [ncmStatus, qqStatus] = await Promise.all([ncm.loginStatus(), qq.loginStatus()]);
    const { list: cl } = await candidates.loadCandidates({
      ncmUid: ncmStatus?.loggedIn ? ncmStatus.userId : null,
      qqUid: qqStatus?.loggedIn ? qqStatus.userId : null,
    });
    const store = getLibraryStore();
    const profiles = new Map();
    if (ncmStatus?.loggedIn && ncmStatus.userId != null) {
      const profile = store.getTasteProfile('ncm', String(ncmStatus.userId))?.profile;
      if (profile) profiles.set('ncm', profile);
    }
    if (qqStatus?.loggedIn && qqStatus.userId != null) {
      const profile = store.getTasteProfile('qq', String(qqStatus.userId))?.profile;
      if (profile) profiles.set('qq', profile);
    }
    list = rankCandidatesByTaste(cl, { profiles, songTagStore: getSongTagStore() });
  } catch {
    return '（候选池加载失败）';
  }
  // 既无 query 也无 tags：返回候选池总数（保持原行为）
  if (!query && !hasTags) {
    return `你有 ${list.length} 首候选歌曲。用 get_user_playlists 查看具体歌单。`;
  }
  // 先按结构化标签精筛（无 tags 时原样返回，向后兼容；未打标的歌在有 tags 时被排除）
  let pool = hasTags ? filterCandidatesByTags(list, tags) : list;
  // 再在缩小后的池里做标题/艺人子串匹配
  if (query) {
    const q = query.toLowerCase();
    pool = pool.filter(t =>
      (t.title || '').toLowerCase().includes(q) ||
      (t.artist || '').toLowerCase().includes(q)
    );
  }
  const matched = pool.slice(0, 10);
  if (!matched.length) {
    if (query && hasTags) return `没找到同时满足 "${query}" 和指定标签的歌。`;
    if (query) return `没找到 "${query}" 的匹配项。`;
    return '没有歌符合指定标签（可能是这些歌还没打标）。';
  }
  rememberTracks(matched.filter(t => String(t.source || '').startsWith('qq')), 'qq');
  rememberTracks(matched.filter(t => String(t.source || '').startsWith('ncm')), 'ncm');
  return matched.map(t => appendAnnotation(`- ${t.title} — ${t.artist} [${t.source || '?'}]`, t)).join('\n');
}

/**
 * List user's playlists from NCM and QQ.
 * @returns {Promise<string>}
 */
export function createGetUserPlaylists(overrides = {}) {
  const deps = providerDeps(overrides);
  return async function getUserPlaylistsWithDeps(args = {}) {
    const source = normalizeSource(args.source);
    if (!source) {
      return toolFailure(`source 必须是 all 或已接入的音乐源（${providerRegistry.defaultSourceCandidates().join(' / ')}）。`,
        { reason: 'invalid_source' });
    }
    const limit = boundedInt(args.limit, 20, 1, 50);
    const playlists = [];
    const providers = [];

    if (source === 'all' || source === 'ncm') {
      try {
        const status = await deps.ncm.loginStatus();
        if (!status?.loggedIn || !status.userId) {
          providers.push({ source: 'ncm', ok: false, reason: status?.reason || 'not_logged_in' });
        } else {
          const rows = await deps.ncm.userPlaylists(status.userId);
          playlists.push(...(rows || []).slice(0, limit).map(item => ({
            source: 'ncm', playlistId: String(item.id), name: String(item.name || ''),
            trackCount: normalizedTrackCount(item.trackCount),
          })));
          providers.push({ source: 'ncm', ok: true, count: rows?.length || 0 });
        }
      } catch (error) {
        providers.push({ source: 'ncm', ok: false, reason: error?.message || 'provider_error' });
      }
    }
    if (source === 'all' || source === 'qq') {
      try {
        const status = await deps.qq.loginStatus?.();
        const uid = status?.loggedIn ? status.userId : deps.qq.getUid?.();
        if (!uid) {
          providers.push({ source: 'qq', ok: false, reason: status?.reason || 'not_logged_in' });
        } else {
          const rows = await deps.qq.userPlaylists(uid);
          playlists.push(...(rows || []).slice(0, limit).map(item => ({
            source: 'qq', playlistId: String(item.id), name: String(item.name || ''),
            trackCount: normalizedTrackCount(item.trackCount),
          })));
          providers.push({ source: 'qq', ok: true, count: rows?.length || 0 });
        }
      } catch (error) {
        providers.push({ source: 'qq', ok: false, reason: error?.message || 'provider_error' });
      }
    }

    if (!playlists.length) {
      return toolFailure('没有读取到歌单；请检查所选音乐平台的登录状态。', {
        reason: 'no_playlists', source, providers, playlists: [],
      });
    }
    const lines = playlists.map(item => {
      const count = Number.isFinite(Number(item.trackCount)) && item.trackCount !== null
        ? `${Number(item.trackCount)} 首`
        : '数量未知，请读取曲目确认';
      return `[${item.source}] id=${item.playlistId} ${item.name}（${count}）`;
    });
    return toolSuccess(lines.join('\n'), { source, playlists, providers, truncated: playlists.length >= limit });
  };
}

export const getUserPlaylists = createGetUserPlaylists();

/**
 * Get tracks from a named playlist.
 * @param {object} args
 * @param {string} args.name - Playlist name keyword
 * @param {number} [args.limit] - Max tracks (default 20)
 * @returns {Promise<string>}
 */
export function createGetPlaylistTracks(overrides = {}) {
  const deps = providerDeps(overrides);
  return async function getPlaylistTracksWithDeps(args = {}) {
    const source = normalizeSource(args.source);
    if (!source) return toolFailure('source 必须是 all / ncm / qq。', { reason: 'invalid_source' });
    const playlistId = String(args.playlistId || '').trim();
    const name = String(args.name || '').trim();
    if (!playlistId && !name) {
      return toolFailure('请提供 playlistId 或歌单 name。', { reason: 'playlist_required' });
    }
    const offset = boundedInt(args.offset, 0, 0, 100_000);
    const limit = boundedInt(args.limit, 20, 1, 50);
    const matches = [];
    const providers = source === 'all' ? providerRegistry.defaultSourceCandidates() : [source];

    for (const providerName of providers) {
      // 能力门：注册表说这个源不提供歌单读取，就不要去调它的实现。
      // 缺实现时静默跳过，比在 try 里等到 TypeError 更像一个可解释的结果。
      if (!providerRegistry.supports(providerName, 'playlist')) continue;
      const provider = deps[providerName];
      if (!provider) continue;
      try {
        const status = await provider.loginStatus?.();
        const uid = providerName === 'ncm'
          ? (status?.loggedIn ? status.userId : null)
          : (status?.loggedIn ? status.userId : provider.getUid?.());
        if (!uid) continue;
        const lists = await provider.userPlaylists(uid);
        const playlist = (lists || []).find(item => (
          playlistId ? String(item.id) === playlistId : String(item.name || '').includes(name)
        ));
        if (!playlist) continue;
        const fetchLimit = providerName === 'qq' ? offset + limit : limit;
        const fetched = await provider.playlistAllTracks(playlist.id, {
          limit: fetchLimit,
          ...(providerName === 'ncm' ? { offset } : {}),
        });
        const tracks = (providerName === 'qq' ? (fetched || []).slice(offset, offset + limit) : (fetched || []).slice(0, limit));
        deps.rememberTracks(tracks.map(track => ({ ...track, source: `${providerName}:playlist` })), providerName);
        matches.push({
          source: providerName,
          playlist: {
            source: providerName, playlistId: String(playlist.id), name: String(playlist.name || ''),
            trackCount: Number(playlist.trackCount) || 0,
          },
          tracks: tracks.map(track => ({
            source: providerName, songId: String(track.song_id || ''),
            title: String(track.title || ''), artist: String(track.artist || ''), album: String(track.album || ''),
          })),
        });
        if (source !== 'all') break;
      } catch { /* provider fact is represented by no match */ }
    }

    if (!matches.length) {
      const label = playlistId || name;
      return toolFailure(`没有在 ${source} 找到或读取歌单 "${label}"。`, {
        reason: 'playlist_unavailable', source, playlistId: playlistId || null, name: name || null,
      });
    }
    const lines = [];
    for (const match of matches) {
      lines.push(`[${match.source}] ${match.playlist.name} id=${match.playlist.playlistId}，本页 offset=${offset} limit=${limit}`);
      for (const track of match.tracks) lines.push(`- ${track.title} — ${track.artist} [${track.source}:${track.songId}]`);
    }
    const totalTracks = matches.reduce((sum, item) => sum + item.tracks.length, 0);
    return toolSuccess(lines.join('\n'), {
      source, offset, limit, matches,
      returned: totalTracks,
      hasMore: matches.some(item => offset + item.tracks.length < item.playlist.trackCount),
    });
  };
}

export const getPlaylistTracks = createGetPlaylistTracks();

/**
 * Get every track of one album (whole-album sequencing, add-album-sequencing).
 *
 * 与歌单读取的区别：专辑不需要登录 uid，也不需要先从用户歌单里找到它——它就是一个
 * `(source, albumId)` 稳定引用。失败返回 typed 失败，不回落到同名搜索。
 * @param {object} args
 * @param {'ncm'|'qq'} args.source
 * @param {string} args.albumId
 * @param {number} [args.offset]
 * @param {number} [args.limit]
 */
export function createGetAlbumTracks(overrides = {}) {
  const deps = providerDeps(overrides);
  return async function getAlbumTracksWithDeps(args = {}) {
    const source = normalizeSource(args.source);
    if (!source || source === 'all') return toolFailure('source 必须是 ncm 或 qq。', { reason: 'invalid_source' });
    const albumId = String(args.albumId || '').trim();
    if (!albumId) return toolFailure('请提供 albumId。', { reason: 'album_required' });
    const offset = boundedInt(args.offset, 0, 0, 100_000);
    const limit = boundedInt(args.limit, 200, 1, 200);
    const provider = deps[source];
    if (!providerRegistry.supports(source, 'album') || typeof provider?.albumTracks !== 'function') {
      return toolFailure(`${source} 不支持读取专辑曲目。`, { reason: 'album_unsupported', source });
    }
    const rows = await provider.albumTracks(albumId, { limit, offset });
    const tracks = (Array.isArray(rows) ? rows : []).slice(0, limit).map(track => ({
      source, songId: String(track.song_id || track.songId || ''), title: String(track.title || ''),
      artist: String(track.artist || ''), album: String(track.album || ''),
      ...(track.pic_url ? { artwork: String(track.pic_url) } : {}),
      ...(Number(track.duration) ? { duration: Number(track.duration) } : {}),
    })).filter(track => track.songId && track.title && track.artist);
    if (!tracks.length) {
      return toolFailure(`没有在 ${source} 读到专辑 ${albumId} 的曲目。`,
        { reason: 'album_unavailable', source, albumId });
    }
    deps.rememberTracks(tracks.map(track => ({ ...track, source: `${source}:album` })), source);
    const lines = [`[${source}] 专辑 ${albumId}，本页 offset=${offset} limit=${limit}`];
    for (const track of tracks) lines.push(`- ${track.title} — ${track.artist} [${track.source}:${track.songId}]`);
    return toolSuccess(lines.join('\n'), {
      source, offset, limit,
      matches: [{ source, album: { source, albumId }, tracks }],
      returned: tracks.length,
      hasMore: tracks.length >= limit,
    });
  };
}

export const getAlbumTracks = createGetAlbumTracks();
