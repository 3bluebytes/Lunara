// recommendationMix.js — 「近 7 天实际收听占比」，只读既有 plays 记录。
//
// 为什么不新增账本：多一份统计就多一处会与真相不一致的地方（design D5）。
// 为什么不按实际占比自动调权重：那正是本 change 要避开的反馈回路——听得多的源
// 拿到更多推荐，于是听得更多，而用户既看不见也改不动。

import { sourceMixSince } from '../state.js';

/** 统计窗口只覆盖用户真正听过的事件：技术失败、跳过与拉黑不算「我选了它」。 */
export function playbackMixShares({ days = 7, now = Date.now } = {}) {
  const windowDays = Math.max(1, Math.min(30, Number(days) || 7));
  const since = Number(now()) - windowDays * 24 * 60 * 60_000;
  const rows = sourceMixSince(since);
  const total = rows.reduce((sum, row) => sum + (Number(row?.n) || 0), 0);
  if (!total) return null;
  return Object.fromEntries(rows
    .filter(row => row?.provider)
    .map(row => [String(row.provider), (Number(row.n) || 0) / total]));
}
