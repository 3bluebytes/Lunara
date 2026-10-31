// backfill.js — 把候选池里"该打标"的歌批量入队。
//
// 单一职责，给两个调用方共用，行为完全一致：
//   1. HTTP POST /api/songtags/backfill —— 用户手动触发当前候选池回填。
//   2. scheduler 后台增量 cron —— 不等播放，定期扫候选池把新歌补上标。
//
// 流程：拉候选池 → 逐首判 needsTagging（force 时跳过判定，强制重打）→ enqueueTagging。
// 入队后由 taggingQueue 串行消化（concurrency=1 + in-flight 去重），天然防 LLM storm；
// 所以即便 cron 与上一批还没排空时再次触发，重复 songId 也会被去重，不会叠加打爆。
//
// 不自己抓登录态、不自己起 LLM —— 这些靠 deps 注入，方便离线单测。

import * as candidatesMod from '../candidates.js';
import { getSongTagStore } from './songTagStore.js';
import { enqueueTagging as defaultEnqueue } from './taggingQueue.js';

/**
 * 扫候选池入队打标。
 * @param {object} opts
 * @param {boolean} [opts.force]            - 忽略 TTL 强制重打（透传 generator）
 * @param {string|number|null} [opts.ncmUid]
 * @param {string|number|null} [opts.qqUid]
 * @param {function} [opts.loadCandidates]  - ({ncmUid,qqUid})=>{list} （默认 candidates.loadCandidates）
 * @param {object}   [opts.store]           - SongTagStore（默认进程单例）
 * @param {function} [opts.enqueue]         - (song,deps)=>boolean（默认 taggingQueue.enqueueTagging）
 * @returns {Promise<{force:boolean, candidatePool:number, enqueued:number, skipped:number, noId:number}>}
 */
export async function runBackfill({
  force = false,
  limit = 50,
  ncmUid = null,
  qqUid = null,
  loadCandidates = candidatesMod.loadCandidates,
  store = getSongTagStore(),
  enqueue = defaultEnqueue,
} = {}) {
  const boundedLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 50));
  const source = 'candidates';
  const { list } = await loadCandidates({ ncmUid, qqUid });
  const pool = Array.isArray(list) ? list : [];

  let eligible = 0, enqueued = 0, skipped = 0, noId = 0;
  for (const c of pool) {
    const songId = c?.song_id != null ? String(c.song_id) : '';
    if (!songId) { noId += 1; continue; }
    const provider = String(c.provider || c.source || '').split(':')[0] || 'legacy';
    // 默认尊重 TTL：已新鲜（含 confidence=0 占位行在 TTL 内）→ 跳过，不重打。
    if (!force && !store.needsTagging(songId, provider)) { skipped += 1; continue; }
    eligible += 1;
    if (enqueued >= boundedLimit) continue;
    const ok = enqueue(
      { provider, songId, title: c.title || '', artist: c.artist || '', source: provider, year: c.year ?? null },
      force ? { force: true } : {},
    );
    if (ok) enqueued += 1; else skipped += 1; // 入队失败=已在 in-flight，算跳过
  }
  return {
    force, source, limit: boundedLimit, pool: pool.length,
    eligible, enqueued, skipped, noId,
    candidatePool: pool.length,
  };
}
