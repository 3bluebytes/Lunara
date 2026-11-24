// createPlaybackOperationsWiring.js — 播放操作服务的组合接线。
//
// 放在组合根之外，是为了让 server/index.js 只保留「兼容组合根」的职责：
// 媒体资产库与持久化 trace 是播放事实的一部分，不能靠路由层临时拼装。
// trace 只接收身份与稳定分类，不接收 URL、凭据或供应商报文。

import { getMediaAssetStore } from '../media/sharedMediaAssets.js';
import { PlaybackOperationsService } from '../services/PlaybackOperationsService.js';
import { getTrackFailureStats } from '../playback/trackFailureStats.js';
import { getRecordingStore } from '../music/recordingStore.js';
import { classifyPlaybackTransition } from '../playback/playbackOutcome.js';

export function createPlaybackOperationsService({ applyOutcome, playbackRuntime, queueService, trace = null } = {}) {
  // 把 runtime 权威认定的技术失败与会话切出同步回写 state.plays，避免坏源/未播曲目留空污染 24h 冷却。
  if (typeof playbackRuntime?.subscribe === 'function' && typeof applyOutcome === 'function') {
    playbackRuntime.subscribe((next, event, previous) => {
      const classified = classifyPlaybackTransition(next, event, previous);
      if (!classified || !['technical_failure', 'superseded'].includes(classified.outcome)) return;
      const track = classified.track;
      if (!track?.songId) return;
      const source = track.source || track.provider || null;
      Promise.resolve(applyOutcome({
        song_id: String(track.songId),
        ...(source ? { source: String(source) } : {}),
        outcome: classified.outcome,
        played_seconds: Number(event?.playedSeconds ?? event?.deliveredDuration ?? event?.positionSeconds) || 0,
      })).catch(() => {});
    });
  }
  return new PlaybackOperationsService({
    applyOutcome,
    playbackRuntime,
    queueService,
    mediaAssets: getMediaAssetStore(),
    trackFailures: getTrackFailureStats(),
    recordings: getRecordingStore(),
    trace,
  });
}
