// modelPlaybackView.js — 给模型看的播放状态。
//
// runtime 的队列会越放越长，而进提示词的状态要过 sanitizeFacts（数组最多 20 项）。
// 直接给整条队列时，放到第 21 首以后模型就看不到正在放什么了。这里只截当前这首附近的
// 一段，并把 currentIndex 换成窗口里的位置；currentTrackOf 照常可用。

const BEFORE = 3;
const AFTER = 8;

// 当前这首是怎么来的，就说明上一首是怎么走的。只认 runtime 记下的原因，不猜。
const ENDED_BY = Object.freeze({
  disliked_track_removed: '听众点了不喜欢，已撤下',
  manual_next: '被跳过',
  natural_next: '播完了',
});

/** snapshot 是 PlaybackRuntime 的（公开）快照；不改原对象。 */
export function modelPlaybackView(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.queue)) return snapshot;
  const { queue } = snapshot;
  const current = Number.isInteger(snapshot.currentIndex) && snapshot.currentIndex >= 0 && snapshot.currentIndex < queue.length
    ? snapshot.currentIndex : -1;
  const start = current >= 0 ? Math.max(0, current - BEFORE) : 0;
  const end = current >= 0 ? current + 1 + AFTER : 1 + AFTER;
  const endedBy = ENDED_BY[snapshot.txn?.reason];
  const last = snapshot.lastOutputTrack;
  return {
    ...snapshot,
    queue: queue.slice(start, end),
    currentIndex: current >= 0 ? current - start : -1,
    queueWindow: { start, total: queue.length },
    ...(last && typeof last === 'object' ? { lastOutputTrack: { ...last, ...(endedBy ? { endedBy } : {}) } } : {}),
  };
}
