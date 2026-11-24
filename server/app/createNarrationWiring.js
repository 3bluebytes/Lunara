// createNarrationWiring.js — 串词的组装（组合根行数守卫）。
//
// 写串词是 host 自己的事：write_track_lines 工具登记到 host 的工具表，line pass 接到 host 的 runtime。
// composer 只负责把写好的文字合成成声音。播放停得够久再接着放时，旧串词交还原 host 重写。

import { ProgramNarrationComposer } from '../program/ProgramNarrationComposer.js';
import { createTrackLineMaterialProvider } from '../program/trackLineMaterial.js';
import { createTrackLinePass } from '../program/trackLinePass.js';
import { createTrackLineRewrite } from '../program/trackLineRewrite.js';
import { registerTrackLineTools } from '../program/trackLineTools.js';

export function createNarrationWiring({ agentLoop, toolRegistry, registry, conversationStore, host, getSongTagStore,
  getMemoryService, getTrackLikeService, getListening = () => null, getMusicService,
  synthesize, getPerformanceCapability = () => null, sessionTrace = null } = {}) {
  registerTrackLineTools(toolRegistry);
  const getMaterial = createTrackLineMaterialProvider({ registry, conversationStore, getSongTagStore, getMemoryService,
    getTrackLikeService, getListening, getPerformanceCapability,
    getProbe: track => getMusicService?.()?.recentProbeForTrack?.(track) || null });
  const trackLinePass = createTrackLinePass({ agentLoop, getMaterial, sessionTrace });
  host?.attachTrackLinePass?.(trackLinePass);
  const programNarrationComposer = new ProgramNarrationComposer({ synthesize });
  // 停得够久再接着放：runtime 作废了旧串词的几首，交还给原 host 的 line pass 重写。
  const rewriteTrackLines = createTrackLineRewrite({ getRegistry: () => registry, getHost: () => host,
    getSelectionService: () => getMusicService?.() || null });
  return Object.freeze({ programNarrationComposer, trackLinePass, rewriteTrackLines });
}

export default createNarrationWiring;
