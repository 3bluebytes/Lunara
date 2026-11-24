// playbackIssue.js — 把 runtime 的 lastError 换成模型能读的播放问题摘要（surface-playback-issue-to-agent）。
//
// lastError.message 是原始异常文本，可能带供应商细节；上下文清洗也会按键名丢掉 lastError。
// 这里只按 type 给一句固定的人话，再附上出问题那首歌的歌名和歌手，原始 message 一律不带。
//
// Python 伪代码：
//   if not snapshot.lastError or type 未知: return None
//   track = next(t for t in queue if t.songId == lastError.songId)
//   return {"summary": SUMMARY[type], "title": track.title, "artist": track.artist}
const SUMMARIES = Object.freeze({
  'track-failed': '这首歌没能播放出来，播放已停下；不要说它正在播放，也不要把它当成用户不喜欢',
  'continuation-failed': '自动续播没能接上下一首，队列已停在这里',
  'invalid-snapshot-safe-idle': '播放状态恢复时出了问题，已安全停下，队列可能需要重新安排',
});

export function describePlaybackIssue(snapshot) {
  const issue = snapshot?.lastError;
  const summary = issue && SUMMARIES[issue.type];
  if (!summary) return null;
  const track = issue.songId
    ? (Array.isArray(snapshot.queue) ? snapshot.queue : []).find(item => String(item?.songId) === String(issue.songId))
    : null;
  return track ? { summary, title: track.title, artist: track.artist } : { summary };
}
