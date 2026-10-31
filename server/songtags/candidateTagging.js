// candidateTagging.js — 把"相关候选"按需入队打标（有界、默认跟随 auto 开关）。
//
// enabled 缺省读 song-tag.json 的 auto 开关（env SONG_TAG_AUTO 双向覆盖）；
// 调用方仍可显式传 enabled 覆盖（测试与特殊路径用）。

import { getSongTagStore } from './songTagStore.js';
import { isSongTagAutoEnabled } from './songTagConfig.js';

export function enqueueRelevantCandidateTags(candidates, {
  store,
  enqueue,
  enabled = isSongTagAutoEnabled(),
  limit = 100,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (!enabled || !store || typeof enqueue !== 'function') {
    return { enabled: Boolean(enabled), pool: list.length, eligible: 0, enqueued: 0, skipped: list.length };
  }
  const bounded = Math.min(100, Math.max(0, Number.parseInt(limit, 10) || 0));
  let eligible = 0;
  let enqueued = 0;
  let skipped = 0;
  for (const candidate of list.slice(0, bounded)) {
    const provider = String(candidate?.provider || candidate?.source || '').split(':')[0];
    const songId = candidate?.song_id != null ? String(candidate.song_id) : '';
    if (!songId || !store.needsTagging(songId, provider)) { skipped += 1; continue; }
    eligible += 1;
    if (enqueue({ ...candidate, provider, songId, source: provider })) enqueued += 1;
    else skipped += 1;
  }
  return { enabled: true, pool: list.length, scanned: Math.min(list.length, bounded), eligible, enqueued, skipped };
}
