// 时间线布局（data-layout="timeline"）的纯投影：顶栏标签、听歌时间线、串词分段。
// 输入只来自 conversationController 的会话列表与 runtime state；这里不持有状态，
// 也不发任何播放命令（看 ≠ 听，时间线不是第二个游标）。
import { queueEstimates } from '../../visuals/cikePresentation.js';

export const TOP_BAR_MAX_TABS = 3;

const activityOf = room => {
  const value = room.lastTurnAt ?? room.updatedAt ?? room.createdAt;
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * 顶栏标签：最多 3 个（「全部」在它们左边，用竖线隔开）。先保证「正在听」与「正在看」在场，再按最近活跃补齐；
 * 显示顺序是正在听的固定第一，其余按最近活跃——浏览不会让标签跳位置。
 */
export function deriveTopBarTabs({ rooms = [], focusedId = null, listeningId = null, max = TOP_BAR_MAX_TABS } = {}) {
  const live = rooms.filter(room => room?.sessionId && !room.archivedAt);
  const byRecent = [...live].sort((a, b) => activityOf(b) - activityOf(a));
  const known = new Set(live.map(room => room.sessionId));
  const chosen = new Set();
  for (const id of [listeningId, focusedId, ...byRecent.map(room => room.sessionId)]) {
    if (chosen.size >= max) break;
    if (id && known.has(id)) chosen.add(id);
  }
  const ordered = byRecent.filter(room => chosen.has(room.sessionId) && room.sessionId !== listeningId);
  if (listeningId && chosen.has(listeningId)) ordered.unshift(live.find(room => room.sessionId === listeningId));
  return ordered.map(room => ({
    room,
    sessionId: room.sessionId,
    viewing: room.sessionId === focusedId,
    listening: room.sessionId === listeningId,
  }));
}

/**
 * 听歌时间线：已放 / 当前 / 待播。已放只给顺序（runtime 不提供每项开始时刻）；
 * 待播时刻按当前剩余与各首时长累加估算，某首时长未知则其后不再估。
 */
export function deriveTimelineStops({ queue = [], currentIndex = -1, positionSeconds = 0, now = Date.now() } = {}) {
  const items = Array.isArray(queue) ? queue : [];
  const index = Number.isInteger(currentIndex) && items[currentIndex] ? currentIndex : -1;
  const estimates = queueEstimates(items, index, positionSeconds, now);
  return {
    played: index > 0 ? items.slice(0, index).map((item, i) => ({ item, index: i, order: i + 1, at: null })) : [],
    current: index >= 0 ? { item: items[index], index } : null,
    upcoming: items.slice(index + 1).map((item, k) => ({ item, index: index + 1 + k, at: estimates.get(item.queueItemId) ?? null })),
  };
}
