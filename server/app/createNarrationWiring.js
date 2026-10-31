// createNarrationWiring.js — 串词的组装（组合根行数守卫）。
//
// 串词属于“一切皆 tool”：确定性素材/校验/兜底在 ProgramNarrationComposer（技能）与
// narrationTools（读素材 + 终止性提交）里，需要模型写的正文由受限主 AgentLoop 任务生成
// （NarrationAgent）。本模块只负责把两者接到同一个 registry / agentLoop 与真实上下文源上。

import { ProgramNarrationComposer } from '../program/ProgramNarrationComposer.js';
import { createNarrationContextProvider } from '../program/narrationContext.js';
import { createNarrationAgent } from '../program/NarrationAgent.js';
import { withTasteProbeHint } from '../program/tasteProbeNarration.js';

export function createNarrationWiring({ agentLoop, toolRegistry, registry, conversationStore, getSongTagStore,
  getMemoryService, getTrackLikeService, getListeningSnapshot, getLifeSnapshot, getMusicService,
  synthesize, getPerformanceCapability = () => null, sessionTrace = null } = {}) {
  const getContext = withTasteProbeHint(createNarrationContextProvider({ registry, conversationStore,
    getSongTagStore, getMemoryService, getTrackLikeService, getCompanionModeSnapshot: getListeningSnapshot,
    getLifeSnapshot,
  }), effect => getMusicService?.()?.recentProbeForTrack?.(effect.track) || null);
  // composer 只保留确定性技能与 TTS 资产重解析（不再持有模型句柄）。
  const programNarrationComposer = new ProgramNarrationComposer({ synthesize });
  const narrationAgent = createNarrationAgent({ agentLoop, toolRegistry, sessionTrace, getContext, synthesize,
    getPerformanceCapability });
  return Object.freeze({ programNarrationComposer, narrationAgent });
}

export default createNarrationWiring;
