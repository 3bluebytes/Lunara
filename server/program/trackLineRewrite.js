// trackLineRewrite.js — 停得够久再接着放：把旧串词已作废的几首交还给原 host 重写。
//
// PlaybackRuntime 判断停顿、作废旧串词、开新代次，发出 REWRITE_TRACK_LINES；这里只做接线：
// 按写这首的 host 分组，拿 runtime 的写入目标（lineTargetFor：按代次入账），交给 startLinePass
// ——同一个 host、同一段上下文、只开放 write_track_lines，不另起写串词的 Agent。
// 找不到 host 的那组由 startLinePass 走 fail，这几首安静播放。
//
// Python 伪代码：
//   for person_id, items in group_by(tracks, 'virtualPersonId'):
//       host.start_line_pass(entity=registry.get(person_id), targets=[line_target(i) for i in items],
//                            playback_gap={'stoppedAtMs': stopped, 'resumedAtMs': resumed})

export function createTrackLineRewrite({ getRegistry, getHost, getSelectionService }) {
  return async ({ listeningSessionId, tracks = [], stoppedAtMs, resumedAtMs } = {}) => {
    const host = getHost();
    const selection = getSelectionService();
    if (!host?.startLinePass || !selection?.lineTargetFor) throw new Error('track line rewrite unavailable');
    const byHost = new Map();
    for (const track of tracks) {
      const personId = track?.virtualPersonId || '';
      if (!byHost.has(personId)) byHost.set(personId, []);
      byHost.get(personId).push(selection.lineTargetFor(track, listeningSessionId));
    }
    await Promise.all([...byHost].map(([personId, targets]) => host.startLinePass({
      entity: personId ? getRegistry()?.get(personId) || null : null,
      sessionId: listeningSessionId, targets, playbackGap: { stoppedAtMs, resumedAtMs } })));
  };
}
