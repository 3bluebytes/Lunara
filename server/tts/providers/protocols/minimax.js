// protocols/minimax.js — MiniMax 官方 t2a_v2 协议（https://platform.minimax.cn 文档）。
//
//   合成  POST {origin}/v1/t2a_v2     { model, text, voice_setting:{voice_id},
//                                      audio_setting:{format,sample_rate} } →
//                                      JSON { data:{audio:<hex>}, base_resp }
//   模型  无列表接口 → 如实报告（TTS_CUSTOM_MODELS_UNAVAILABLE），按官方
//                       文档手填（如 speech-2.8-hd / speech-2.8-turbo）。
//   声音  POST {origin}/v1/get_voice  { voice_type:'all' } →
//                                      { system_voice/voice_cloning/
//                                        voice_generation:[{voice_id,...}] }
//   设计  POST {origin}/v1/voice_design  { prompt, preview_text } →
//                                      { voice_id, trial_audio:<hex>, base_resp }
//   转正  生成的音色 7 天内未被正式合成会被删除：用接口 model 做一次极短 t2a，
//         音色转为永久（官方此时收取音色设计费），voice_id 不变。
// 表演：翻译器产出的 native.voice_setting（emotion/speed）合并进 voice_setting，
// native.voice_modify 原样附加；没有表演时请求体与旧实现逐字段一致。

import { createTtsAudio } from '../../TtsProvider.js';
import { dedupeById, describeUpstreamBody, extractRows, synthesisError, unavailable } from './shared.js';

/** 端点自动纠正：主域名、{base}/v1、文档里的完整接口地址（…/v1/t2a_v2
 *  或 …/v1/get_voice）都归一到主域名，再统一拼标准路径。 */
export function minimaxEndpoint(baseUrl, path) {
  const base = String(baseUrl)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/(?:t2a_v2|get_voice|voice_design)$/, '')
    .replace(/\/v1$/, '');
  return `${base}${path}`;
}

const headers = config => ({ Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' });

/** MiniMax 音色行的显示名：voice_name → description 首条 → voice_id，绝不编造。 */
function minimaxVoiceRow(row) {
  const id = String(row?.voice_id || '').trim();
  if (!id) return null;
  const description = Array.isArray(row?.description) ? row.description.filter(Boolean) : [];
  const name = String(row?.voice_name || description[0] || '').trim() || id;
  return { id, name };
}

/** HTTP 200 也可能带非 0 base_resp：两者都按不可用如实报出。 */
async function readBusinessPayload(response, action) {
  if (!response.ok) {
    throw unavailable(`${action}失败（HTTP ${response.status}）：${describeUpstreamBody(await response.text().catch(() => ''))}`, 'TTS_VOICE_DESIGN_FAILED');
  }
  const payload = await response.json().catch(() => null);
  const statusCode = Number(payload?.base_resp?.status_code ?? 0);
  if (payload && statusCode !== 0) {
    throw unavailable(`${action}失败（status_code ${statusCode}）：${String(payload?.base_resp?.status_msg || '未知错误').slice(0, 200)}`, 'TTS_VOICE_DESIGN_FAILED');
  }
  return payload;
}

const ACTIVATION_TEXT = '你好。';

export const minimaxProtocol = Object.freeze({
  id: 'minimax',
  voiceDesign: Object.freeze({
    maxCandidates: 1,
    costNote: 'MiniMax 每次生成按音色设计价目计费；生成的音色 7 天内不用会被删除，加入声音池时会做一次很短的合成让它转为永久（此时收取音色设计费）。',
  }),
  async designVoice({ base, config, fetchImpl, signal, description, previewText }) {
    const response = await fetchImpl(minimaxEndpoint(base, '/v1/voice_design'), {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({ prompt: description, preview_text: previewText }),
      signal,
    });
    const payload = await readBusinessPayload(response, '设计声音');
    const generatedId = String(payload?.voice_id || '').trim();
    const hex = String(payload?.trial_audio || '').trim();
    const bytes = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
    if (!generatedId || !bytes.length) throw unavailable('设计声音失败：MiniMax 没有返回音色或试听音频', 'TTS_VOICE_DESIGN_FAILED');
    return [{ generatedId, audio: createTtsAudio({ bytes, extension: 'mp3', source: 'custom:voice-design' }) }];
  },
  async activateDesignedVoice({ base, config, fetchImpl, signal, generatedId, model }) {
    if (!model) throw unavailable('转正需要 model：先在接口里填写 model（如 speech-2.8-hd）', 'TTS_CUSTOM_MODEL_REQUIRED');
    const { url, init } = minimaxProtocol.synthRequest({ base, config, model, voiceId: generatedId, text: ACTIVATION_TEXT });
    const response = await fetchImpl(url, { ...init, signal });
    if (!response.ok) {
      throw unavailable(`声音转正失败（HTTP ${response.status}）：${describeUpstreamBody(await response.text().catch(() => ''))}`, 'TTS_VOICE_DESIGN_FAILED');
    }
    await minimaxProtocol.readAudio(response, { model });
    return { voiceId: generatedId };
  },
  synthRequest({ base, config, model, voiceId, text, native = {} }) {
    return {
      url: minimaxEndpoint(base, '/v1/t2a_v2'),
      init: {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({
          model,
          text,
          stream: false,
          voice_setting: { voice_id: voiceId, ...(native.voice_setting || {}) },
          ...(native.voice_modify ? { voice_modify: native.voice_modify } : {}),
          audio_setting: { format: 'mp3', sample_rate: 32000 },
          output_format: 'hex',
        }),
      },
    };
  },
  /** 合成响应：base_resp 非 0 抛合成错误；data.audio 为 hex 编码的 mp3。 */
  async readAudio(response, { model }) {
    const payload = await response.json().catch(() => null);
    const statusCode = Number(payload?.base_resp?.status_code ?? 0);
    if (payload && statusCode !== 0) {
      throw synthesisError(
        `custom tts rejected by upstream (status_code ${statusCode}): ${String(payload?.base_resp?.status_msg || 'unknown').slice(0, 200)}`,
      );
    }
    const hex = String(payload?.data?.audio || '').trim();
    const bytes = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0);
    if (!bytes.length) throw synthesisError('custom tts returned no audio');
    return createTtsAudio({ bytes, extension: 'mp3', source: `custom:${model}` });
  },
  async fetchModels() {
    throw unavailable('该接口不提供模型列表；请按官方文档手动填写 model（如 speech-2.8-hd、speech-2.8-turbo）', 'TTS_CUSTOM_MODELS_UNAVAILABLE');
  },
  /** 合并系统音色、快速克隆与音色生成三类；快克音色在首次合成成功前可能不在列表里（官方边界）。 */
  async fetchVoices({ base, config, fetchImpl, signal }) {
    const response = await fetchImpl(minimaxEndpoint(base, '/v1/get_voice'), {
      method: 'POST',
      body: JSON.stringify({ voice_type: 'all' }),
      headers: headers(config),
      signal,
    });
    if (!response.ok) {
      throw unavailable(`该端点未提供声音列表（HTTP ${response.status}）；可改用手动填写 voice 名称`, 'TTS_CUSTOM_VOICES_UNAVAILABLE');
    }
    // 业务错误约定：HTTP 200 也可能带非 0 base_resp.status_code。
    const payload = await response.json().catch(() => null);
    const statusCode = Number(payload?.base_resp?.status_code ?? 0);
    if (payload && statusCode !== 0) {
      throw unavailable(`获取声音列表失败（status_code ${statusCode}）：${String(payload?.base_resp?.status_msg || '未知错误').slice(0, 200)}`);
    }
    return dedupeById(['system_voice', 'voice_cloning', 'voice_generation']
      .flatMap(key => extractRows(payload, [key]).map(minimaxVoiceRow)));
  },
});
