// protocols/openai.js — OpenAI 兼容协议（默认）。
//
//   合成  POST {baseUrl}/audio/speech  { model, voice, input } → 音频字节流
//   模型  GET   {baseUrl}/models       → 宽松解析（数组 / {data} / {models}）
//   声音  GET   {baseUrl}/voices       → 非标准端点，宽松解析；不可用就如实
//                                      报告（TTS_CUSTOM_VOICES_UNAVAILABLE），
//                                      由用户在 UI 手填 voice 名。
// 表演能力：未登记，任何表演都被翻译成纯文本，native 恒为 {}。

import { dedupeById, describeUpstreamBody, extractRows, readBinaryAudio, unavailable } from './shared.js';

const authHeaders = config => ({ Authorization: `Bearer ${config.apiKey}` });

export const openaiProtocol = Object.freeze({
  id: 'openai',
  synthRequest({ base, config, model, voiceId, text }) {
    return {
      url: `${base}/audio/speech`,
      init: {
        method: 'POST',
        headers: { ...authHeaders(config), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice: voiceId, input: text }),
      },
    };
  },
  readAudio: (response, { model }) => readBinaryAudio(response, { model }),
  async fetchModels({ base, config, fetchImpl, signal }) {
    const response = await fetchImpl(`${base}/models`, { headers: authHeaders(config), signal });
    if (!response.ok) {
      throw unavailable(`获取模型列表失败（HTTP ${response.status}）：${describeUpstreamBody(await response.text().catch(() => ''))}`);
    }
    const payload = await response.json().catch(() => null);
    const models = extractRows(payload, ['data', 'models'])
      .map(row => (typeof row === 'string' ? row : row?.id || row?.model || row?.name))
      .filter(Boolean)
      .map(String);
    return [...new Set(models)];
  },
  async fetchVoices({ base, config, fetchImpl, signal }) {
    const response = await fetchImpl(`${base}/voices`, { method: 'GET', headers: authHeaders(config), signal });
    if (!response.ok) {
      throw unavailable(`该端点未提供声音列表（HTTP ${response.status}）；可改用手动填写 voice 名称`, 'TTS_CUSTOM_VOICES_UNAVAILABLE');
    }
    const payload = await response.json().catch(() => null);
    return dedupeById(extractRows(payload, ['data', 'voices'])
      .map(row => {
        if (typeof row === 'string') return { id: row, name: row };
        const id = row?.id || row?.voice || row?.voiceId || row?.voice_id || row?.name;
        if (!id) return null;
        return { id: String(id), name: String(row?.name || row?.displayName || id) };
      }));
  },
});
