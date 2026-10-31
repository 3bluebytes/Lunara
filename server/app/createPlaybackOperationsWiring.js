// createPlaybackOperationsWiring.js — 播放操作服务的组合接线。
//
// 放在组合根之外，是为了让 server/index.js 只保留「兼容组合根」的职责：
// 媒体资产库与持久化 trace 是播放事实的一部分，不能靠路由层临时拼装。
// trace 只接收身份与稳定分类，不接收 URL、凭据或供应商报文。

import { getMediaAssetStore } from '../media/sharedMediaAssets.js';
import { PlaybackOperationsService } from '../services/PlaybackOperationsService.js';
import { getTrackFailureStats } from '../playback/trackFailureStats.js';
import { getRecordingStore } from '../music/recordingStore.js';

export function createPlaybackOperationsService({ applyOutcome, playbackRuntime, queueService, trace = null } = {}) {
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
