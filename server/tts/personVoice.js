// personVoice.js — 「哪位伙伴用哪个音色」的唯一装配点。
//
// 从 server/index.js 抽出（组合根行数守卫要求新增职责下沉，而不是继续往组合根堆）。
// 这是纯搬迁：注册顺序与行为都不变——先给 VoiceDirectory 装上「可用 provider」查询，
// 再把 VoiceDirectory 注册成 tts 的 voiceResolver，最后导出解析与合成两个入口。
//
// 意图分两层：resolvePersonVoice 只回答「这个 voiceProfileId 现在解析成什么」，
// 解析不出来时如实返回 unavailable（不编一个假音色）；synthesizeForPerson 只合成
// 已解析的声音，失败照实抛出——系统语音已关闭，不再有沉默换声的兜底；唯一的例外是用户
// 在设置里开启的「代读」（见 voiceFallback.js），它显式、可见，结果带 voiceSource。

import * as tts from '../tts.js';
import * as VoiceDirectory from '../station/VoiceDirectory.js';
import { TtsProviderUnavailableError } from './TtsProvider.js';
import { NO_PERFORMANCE_CAPABILITY } from './performance/capabilities.js';
import { readCustomTtsConfig } from '../ttsCustomConfig.js';
import { FREE_EDGE_PROVIDER_ID, FREE_EDGE_LABEL } from './providers/freeEdge.js';
import { createVoiceHealth } from './voiceHealth.js';
import { synthesizeWithFallback } from './voiceFallback.js';
import { effectiveFallbackTarget } from '../ttsFallbackConfig.js';

/**
 * 自定义 TTS 配置变更后的唯一同步点：先让每个接口各有一个 provider，再把统一声音池
 * （带所属接口 id、接口名与 model）并入 VoiceDirectory。启动迁移后与设置页保存后都调用它。
 */
export function syncCustomVoices(config = readCustomTtsConfig()) {
  tts.syncCustomTtsProviders();
  const names = new Map([[FREE_EDGE_PROVIDER_ID, FREE_EDGE_LABEL], ...(config?.endpoints || []).map(endpoint => [endpoint.id, endpoint.name])]);
  return VoiceDirectory.setCustomVoiceEntries((config?.voices || []).map(voice => ({
    ...voice,
    providerId: voice.endpointId,
    providerName: names.get(voice.endpointId) || null,
  })));
}

export function createPersonVoice({
  publish = null,
  // 本地失败记录（state.db，见 synthesisFailureLog.js）；不传时只提醒不记录。
  failureLog = null,
  voiceHealth = createVoiceHealth({ displayNameOf: id => tts.registry.get(id)?.label, record: entry => failureLog?.record(entry) }),
  fallbackTarget = () => effectiveFallbackTarget(),
} = {}) {
  // 声音接口故障提醒走与音乐源提醒相同的广播出口。
  if (typeof publish === 'function') voiceHealth.subscribe(publish);
  function voicesAvailableProviders() {
    return new Set(tts.providerStatus()
      .filter(item => item.configured)
      .map(item => item.id));
  }

  VoiceDirectory.initialize(null, { getAvailableProviders: voicesAvailableProviders });
  tts.setVoiceResolver(voiceProfileId => VoiceDirectory.resolveVoiceRef(voiceProfileId));

  function resolvePersonVoice(voiceProfileId) {
    const resolved = VoiceDirectory.resolveVoiceRef(voiceProfileId);
    if (resolved) return resolved;
    return { profileId: null, providerId: null, voiceId: String(voiceProfileId || ''), isFallback: true, unavailable: /^vp_cx_/.test(String(voiceProfileId || '')) };
  }

  // performance 是中立表演意图（情绪/语速/力度/指令），由网关按实际 provider 翻译或丢弃。
  async function synthesizeForPerson(text, { voiceProfileId, signal, performance = null } = {}) {
    signal?.throwIfAborted();
    const voice = resolvePersonVoice(voiceProfileId);
    if (voice.unavailable) throw new TtsProviderUnavailableError('这把声音当前不可用，请重新选择声音。');
    // 显式 providerId 会跳过网关的解析器，所以声音自带的参数（model）在这里一并带上。
    // 每次发声结果都上报给声音健康：失败给出可见提醒（代读时说明由谁代读），成功解除。
    return synthesizeWithFallback(text, {
      voice, signal, performance, voiceHealth, fallbackTarget,
      synth: (input, options) => tts.synth(input, options),
      resolveFallback: target => resolvePersonVoice(target.profileId),
    });
  }

  /** 这位伙伴当前声音支持哪些表演能力；声音不可用时如实返回 NONE，串词就不写标记。 */
  function performanceCapabilityForPerson(voiceProfileId) {
    const voice = resolvePersonVoice(voiceProfileId);
    if (voice.unavailable) return NO_PERFORMANCE_CAPABILITY;
    return tts.performanceCapability(voice.voiceId, { providerId: voice.providerId, params: voice.params || {} });
  }

  return Object.freeze({ resolvePersonVoice, synthesizeForPerson, performanceCapabilityForPerson, voicesAvailableProviders, voiceHealth });
}

export default createPersonVoice;
