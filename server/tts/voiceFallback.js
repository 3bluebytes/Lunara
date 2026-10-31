// voiceFallback.js — 伙伴声音失败时的「代读」兜底（用户开启、可见标注）。
//
// 输入：已解析的主声音 {providerId, voiceId, params}、网关 synth、用户当前生效的代读目标。
// 先用主声音合成；只有主声音技术性失败（超时、网络/5xx、限流、额度、鉴权）且用户开启了代读、
// 目标能解析且不是主声音本身时，才用目标声音再显式合成一次剥掉表演标记的同一段文字。
// 网关"显式 providerId 只试这一个"不变：代读是这里发起的第二次显式调用，缓存键自然落在
// 实际出声的 provider 上。调用方取消（含预算超时）后不再代读。代读也失败时抛出主声音的原错误。
// 结果附 voiceSource，只用于展示；学习、反思和播放判定都不读它。
//
// Python 伪代码：
//   try: audio = synth(text, voice)
//   except TtsError as e:
//       if not eligible(e): raise
//       audio = synth(strip_markers(text), target); audio.voice_source = ('fallback', target, reason(e))

import { synthesisReasonOfError } from './boundedSynthesis.js';
import { toPlainText } from './performance/markers.js';

const isCancelled = (error, signal) => Boolean(signal?.aborted) || error?.name === 'AbortError';
const sameVoice = (a, b) => a.providerId === b.providerId && String(a.voiceId || '') === String(b.voiceId || '');

/** 解析出可用的代读声音；不可用或就是主声音时返回 null。 */
function fallbackVoiceFor(voice, { fallbackTarget, resolveFallback }) {
  const target = fallbackTarget();
  if (!target) return null;
  const resolved = target.profileId ? resolveFallback(target) : target;
  if (!resolved || resolved.unavailable || !resolved.providerId || sameVoice(resolved, voice)) return null;
  return resolved;
}

export async function synthesizeWithFallback(text, {
  voice, signal = null, performance = null, synth, voiceHealth,
  fallbackTarget = () => null, resolveFallback = () => null,
} = {}) {
  const startedAt = Date.now();
  try {
    const audio = await synth(text, { providerId: voice.providerId, voiceId: voice.voiceId, signal, performance, params: voice.params || {} });
    voiceHealth.observe(voice.providerId);
    return audio && { ...audio, voiceSource: { kind: 'primary', providerId: voice.providerId } };
  } catch (error) {
    const endpoint = voice.providerId || error?.providerId;
    const reason = synthesisReasonOfError(error);
    // 主声音自己花的时间（不含代读），给失败记录用。
    const elapsedMs = Date.now() - startedAt;
    const target = !isCancelled(error, signal) && reason !== 'not-configured'
      ? fallbackVoiceFor(voice, { fallbackTarget, resolveFallback }) : null;
    if (!target) {
      voiceHealth.observe(endpoint, { error, signal, elapsedMs });
      throw error;
    }
    let audio;
    try {
      audio = await synth(toPlainText(text), { providerId: target.providerId, voiceId: target.voiceId, signal, performance: null, params: target.params || {} });
    } catch (fallbackError) {
      if (isCancelled(fallbackError, signal)) throw fallbackError;
      voiceHealth.observe(target.providerId, { error: fallbackError, signal });
      voiceHealth.observe(endpoint, { error, signal, elapsedMs });
      throw error;
    }
    voiceHealth.observe(target.providerId);
    voiceHealth.observe(endpoint, { error, signal, elapsedMs, fallback: { endpoint: target.providerId } });
    return audio && { ...audio, voiceSource: { kind: 'fallback', providerId: target.providerId, reason } };
  }
}

export default synthesizeWithFallback;
