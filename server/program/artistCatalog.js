// 按歌手名找候选：给“明确点名某位歌手”的选歌请求补充目录，而不再只靠导入曲库
// 和当天的在线推荐窗口。搜索结果里只有歌手名真的匹配、且有稳定 song_id 的行才会
// 进入候选；真正的硬约束校验与 canonical 解析仍由 MusicSelectionService /
// ProgramCommitService 负责，这里只负责找“可能有关的行”。
//
// 失败安全：任一音乐源报错、超时或未登录都静默降级为空数组，绝不把搜索失败
// 升级成选歌失败，也不重试。
import * as ncm from '../ncm.js';
import * as qq from '../qq.js';
import { artistMatchesRequest } from './musicSelectionRequest.js';

const DEFAULT_TIMEOUT_MS = 8000;

export const DEFAULT_ARTIST_SOURCES = Object.freeze([
  { name: 'qq', provider: qq },
  { name: 'ncm', provider: ncm },
]);

function withTimeout(task, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(task).catch(() => []),
    new Promise(resolve => { timer = setTimeout(() => resolve([]), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {string} artist
 * @param {{ limit?: number, signal?: AbortSignal, sources?: Array<{name: string, provider: object}>,
 *   timeoutMs?: number }} [options]
 * @returns {Promise<Array<object>>} 带 `<source>:search` 来源标记的候选行，顺序沿用搜索相关性
 */
export async function searchArtistTracks(artist, { limit = 12, signal, sources = DEFAULT_ARTIST_SOURCES, allowedSources = null,
  timeoutMs = Number(process.env.MUSIC_ARTIST_SEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS } = {}) {
  const name = String(artist || '').trim();
  if (!name) return [];
  const wanted = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 12));
  const perSource = Math.min(50, Math.max(wanted, 10));
  signal?.throwIfAborted();
  const batches = await Promise.all(sources
    .filter(source => (!allowedSources || allowedSources.includes(source.name)) && typeof source?.provider?.search === 'function')
    .map(source => withTimeout(Promise.resolve().then(() => source.provider.search(name, perSource))
      .then(rows => (Array.isArray(rows) ? rows : []).map(row => ({ ...row, source: `${source.name}:search` }))), timeoutMs)));
  signal?.throwIfAborted();
  const seen = new Set();
  const found = [];
  for (const rows of batches) {
    for (const row of rows) {
      const songId = String(row?.song_id || '');
      if (!songId || !row?.title || !artistMatchesRequest(row.artist, name)) continue;
      const key = `${String(row.source).split(':')[0]}:${songId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(row);
      if (found.length >= wanted) break;
    }
    if (found.length >= wanted) break;
  }
  return found;
}
