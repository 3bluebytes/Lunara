/**
 * 语音预览与音色列表投影：供设置页读取可选音色并安全试听。
 */

/**
 * 把 VoiceDirectory 的解析结果投影成设置页选项结构。
 * @param {object} VoiceDirectory
 * @returns {Array<object>}
 */
export function listResolvedVoiceOptions(VoiceDirectory) {
  return VoiceDirectory.listResolvedVoiceProfiles().map(profile => ({
    id: profile.id,
    name: profile.displayName,
    note: profile.description,
    providerId: profile.resolvedProviderId,
    voiceId: profile.resolvedVoiceId,
    sourceLabel: profile.sourceLabel,
    isFallback: profile.isFallback,
  }));
}

/**
 * 创建音色试听服务；对长文本截断以防止本地合成空转，异常对外返回温和提示。
 * @param {object} deps
 * @param {(voiceProfileId: string) => object|null} deps.resolvePersonVoice
 * @param {(text: string, options: object) => Promise<object>} deps.synth
 * @returns {{ preview: (input?: { voiceProfileId?: string, text?: string }) => Promise<object> }}
 */
export function createTtsPreviewService({ resolvePersonVoice, synth }) {
  return {
    async preview({ voiceProfileId, text } = {}) {
      const voice = resolvePersonVoice(voiceProfileId);
      if (!voice || voice.unavailable || !voice.providerId) {
        return { error: '这把声音当前不可用，请换一个或检查声音服务配置。' };
      }
      // 试听只是确认音色，本地合成没有费用但没有时间上限——不截断的话
      // 一段超长文本会让 CPU 空转数分钟。
      const previewText = String(text || '').trim().slice(0, 500) || '接下来是陈奕迅的《富士山下》。';
      try {
        const audio = await synth(previewText, {
          providerId: voice.providerId,
          voiceId: voice.voiceId,
          params: voice.params || {},
        });
        return {
          url: audio?.url || null,
          providerId: audio?.providerId || voice.providerId,
          isFallback: voice.isFallback,
        };
      } catch {
        return { error: '这把声音试听失败，请检查声音配置后重试。' };
      }
    },
  };
}
