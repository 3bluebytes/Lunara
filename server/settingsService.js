// settingsService.js — 组合“用户 LLM endpoint 配置”与 state.db 非敏感偏好。
// 路由层只负责 HTTP；本模块保证任何返回给前端的对象都不含 apiKey 明文。

import { getPublicLLMConfig, setLLMConfig } from './llmConfig.js';
import { publicLocation, readStoredLocation } from './locationService.js';
import { providerRegistry } from './music/providerRegistry.js';
import { normalizeSourcePolicy } from './music/sourcePolicy.js';
import { mergeWeights, playableSourceIds } from './music/recommendationWeights.js';

// 源名单不再手写：可选项来自注册表，「默认播放源」只允许可播源。
// 历史上 SOURCE_IDS 含 apple 而 PRIMARY_SOURCE_IDS 不含，白名单就是这样漂移的。
function isKnownSource(id) {
  return providerRegistry.get(id) !== null;
}

function isPlayableSource(id) {
  return providerRegistry.isPlayable(id);
}

export function readRecommendationWeights(state) {
  // 只读偏好，不写、不推导：设置页里设的比例是唯一来源。按收听行为自动加权
  // 会把「推荐来源构成」变成反馈回路，用户看不见也改不动。读不到即未配置。
  try {
    const saved = parseStoredSettings(state)?.recommendationWeights;
    return saved && typeof saved === 'object' ? saved : null;
  } catch {
    return null;
  }
}

function parseStoredSettings(state) {
  try {
    return JSON.parse(state.getPref('settings') || '{}');
  } catch {
    return {};
  }
}

export async function getSettingsSnapshot({ state, tts }) {
  const saved = parseStoredSettings(state);
  return {
    llm: await getPublicLLMConfig(),
    source: isKnownSource(saved.source) ? saved.source : 'ncm',
    voice: saved.voice || tts.getVoice(),
    primarySource: normalizeSourcePolicy(saved).primarySource,
    playbackSourceMode: normalizeSourcePolicy(saved).mode,
    // 未配置时就是均分：设置页的滑块打开就能用，不需要先做一次配置。
    recommendationWeights: mergeWeights(saved.recommendationWeights, playableSourceIds()),
    // 位置只回城市名，坐标不出设置接口。
    location: publicLocation(readStoredLocation(state)),
  };
}

export async function updateSettings(input = {}, { state, tts, ttsVoiceIds = [] }) {
  const previous = parseStoredSettings(state);
  if (input.playbackSourceMode !== undefined && !['single', 'multi'].includes(input.playbackSourceMode)) {
    throw Object.assign(new TypeError('请选择单源播放或多源播放'), { statusCode: 400 });
  }
  if (input.primarySource !== undefined && !isPlayableSource(input.primarySource)) {
    throw Object.assign(new TypeError('请选择可用的播放源'), { statusCode: 400 });
  }
  if (input.baseUrl !== undefined || input.model !== undefined || input.apiKey !== undefined) {
    await setLLMConfig({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
    });
  }

  const source = isKnownSource(input.source) ? input.source : (isKnownSource(previous.source) ? previous.source : 'ncm');
  const primarySource = isPlayableSource(input.primarySource)
    ? input.primarySource
    : normalizeSourcePolicy(previous).primarySource;
  const allowedVoices = new Set(ttsVoiceIds);
  const voice = allowedVoices.has(input.voice)
    ? input.voice
    : (previous.voice || tts.getVoice());

  if (voice) tts.setVoice(voice);
  const stored = { source, voice, primarySource,
    playbackSourceMode: input.playbackSourceMode ?? normalizeSourcePolicy(previous).mode };
  // 权重只在用户真的动过（或此前已保存）时落盘：不写默认值，删掉这个偏好项
  // 就等于回到「均分」的现状，回滚不需要迁移。
  if (input.recommendationWeights !== undefined) {
    stored.recommendationWeights = mergeWeights(input.recommendationWeights, playableSourceIds());
  } else if (previous.recommendationWeights !== undefined) {
    stored.recommendationWeights = mergeWeights(previous.recommendationWeights, playableSourceIds());
  }
  state.setPref('settings', JSON.stringify(stored));

  const llm = await getPublicLLMConfig();
  return {
    current: { llm, ...stored },
    ready: llm.ready,
  };
}

export function restoreRuntimeSettings({ state, tts }) {
  const saved = parseStoredSettings(state);
  if (saved.voice) tts.setVoice(saved.voice);
  if (isPlayableSource(saved.primarySource)) {
    process.env.PRIMARY_SOURCE = saved.primarySource;
  }
  return saved;
}
