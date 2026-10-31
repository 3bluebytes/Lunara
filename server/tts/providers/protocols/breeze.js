// protocols/breeze.js — BreezeBlue Developer API（https://docs.breezeblue.ai）。
//
//   合成  POST {origin}/v1/text-to-speech/{voice_id}?output_format=mp3
//         头 xi-api-key；body { text, model_id, language_code:'zh',
//         [instructions], [voice_settings:{guidance_scale,speed}] } → mp3 字节流
//   模型  GET {origin}/v1/models → [{ model_id, name, languages }]
//   声音  GET {origin}/v1/voices?language_code=zh&voice_type=…&page_size=100
//         → { voices:[{voice_id,name}], has_more, next_page_token }；按 next_page_token
//         有界翻页：个人音色 1 页 + 公开目录按当日热度 2 页；每行带 group（personal/trending）。
//   设计  POST {origin}/v1/voice-previews/design?output_format=mp3
//         { voice_description, text, language_code:'zh', preview_count≤3 } →
//         { previews:[{ generated_voice_id, audio_base_64, media_type }] }（临时候选）
//   转正  POST {origin}/v1/voice-previews/{generated_voice_id}/save
//         { voice_name, voice_description, language_code:'zh' } → { voice_id }
// 失败：402 额度用尽、429 并发超限、503 容量不足都如实报出并带稳定错误码；429/503 由
// custom provider 按 Retry-After 有界重试。错误文本只摘录上游响应，不含 key。
// 并发：账号级生成池满额时直接 429 不排队（Free 2、Starter 4），maxConcurrent 按 Free 设。

import { createTtsAudio } from '../../TtsProvider.js';
import { dedupeById, describeUpstreamBody, extractRows, readBinaryAudio, synthesisError, unavailable } from './shared.js';

const LANGUAGE_CODE = 'zh';
const PAGE_SIZE = 100;
// group 随结果交给设置页，发现结果据此分开计数「我的 / 热门」。
const VOICE_QUERIES = Object.freeze([
  { voice_type: 'personal', group: 'personal', pages: 1 },
  { voice_type: 'default', sort: 'trend', group: 'trending', pages: 2 },
]);

const FAILURE_CODES = Object.freeze({
  401: 'TTS_AUTH_FAILED',
  402: 'TTS_CREDIT_EXHAUSTED',
  429: 'TTS_RATE_LIMITED',
  503: 'TTS_UPSTREAM_BUSY',
});
const FAILURE_HINTS = Object.freeze({
  402: 'Breeze 额度已用尽',
  429: 'Breeze 并发超限，请稍后再试',
  503: 'Breeze 暂时容量不足',
});

/** 基础 URL 归一到主域名：主域名、{origin}/v1、文档里的完整接口地址都可以。 */
export function breezeOrigin(baseUrl) {
  return String(baseUrl)
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v1\/(?:text-to-speech(?:\/.*)?|models|voices(?:\?.*)?)$/, '')
    .replace(/\/v1$/, '');
}

const headers = config => ({ 'xi-api-key': config.apiKey });

/** 设计/转正失败：沿用合成的 402/429/503 映射，另补 403（名额）与 404（候选失效）。 */
const DESIGN_HINTS = Object.freeze({ ...FAILURE_HINTS, 403: '账号的私人音色名额已满', 404: '候选已过期或不属于这个账号' });
async function designFailure(action, response) {
  const hint = DESIGN_HINTS[response.status];
  return unavailable(
    `${action}失败（HTTP ${response.status}${hint ? `，${hint}` : ''}）：${describeUpstreamBody(await response.text().catch(() => ''))}`,
    FAILURE_CODES[response.status] || 'TTS_VOICE_DESIGN_FAILED',
  );
}

export const breezeProtocol = Object.freeze({
  id: 'breeze',
  maxConcurrent: 2,
  synthRequest({ base, config, model, voiceId, text, native = {} }) {
    return {
      url: `${breezeOrigin(base)}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3`,
      init: {
        method: 'POST',
        headers: { ...headers(config), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: model,
          language_code: LANGUAGE_CODE,
          ...(native.instructions ? { instructions: native.instructions } : {}),
          ...(native.voice_settings ? { voice_settings: native.voice_settings } : {}),
        }),
      },
    };
  },
  describeFailure(status, body) {
    const hint = FAILURE_HINTS[status];
    return {
      message: `custom tts responded ${status}${hint ? `（${hint}）` : ''}: ${describeUpstreamBody(body)}`,
      code: FAILURE_CODES[status] || null,
    };
  },
  async readAudio(response, { model }) {
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      throw synthesisError(`custom tts returned json instead of audio: ${describeUpstreamBody(await response.text().catch(() => ''))}`);
    }
    return readBinaryAudio(response, { model });
  },
  async fetchModels({ base, config, fetchImpl, signal }) {
    const response = await fetchImpl(`${breezeOrigin(base)}/v1/models`, { headers: headers(config), signal });
    if (!response.ok) {
      throw unavailable(`获取模型列表失败（HTTP ${response.status}）：${describeUpstreamBody(await response.text().catch(() => ''))}`);
    }
    const payload = await response.json().catch(() => null);
    const models = extractRows(payload, ['models', 'data'])
      .map(row => (typeof row === 'string' ? row : row?.model_id || row?.id))
      .filter(Boolean)
      .map(String);
    return [...new Set(models)];
  },
  voiceDesign: Object.freeze({
    maxCandidates: 3,
    costNote: 'Breeze 按试听文本计费：中文每字约 2 个单位 × 候选数；加入声音池时保存为账号里的私人音色（占用音色名额）。',
  }),
  async designVoice({ base, config, fetchImpl, signal, description, previewText, count }) {
    const response = await fetchImpl(`${breezeOrigin(base)}/v1/voice-previews/design?output_format=mp3`, {
      method: 'POST',
      headers: { ...headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice_description: description,
        ...(previewText ? { text: previewText } : {}),
        language_code: LANGUAGE_CODE,
        preview_count: count,
      }),
      signal,
    });
    if (!response.ok) throw await designFailure('设计声音', response);
    const payload = await response.json().catch(() => null);
    return extractRows(payload, ['previews'])
      .map(row => {
        const generatedId = String(row?.generated_voice_id || '').trim();
        const bytes = Buffer.from(String(row?.audio_base_64 || ''), 'base64');
        if (!generatedId || !bytes.length) return null;
        return { generatedId, audio: createTtsAudio({ bytes, extension: 'mp3', source: 'custom:voice-design' }) };
      })
      .filter(Boolean);
  },
  async activateDesignedVoice({ base, config, fetchImpl, signal, generatedId, name, description }) {
    const response = await fetchImpl(`${breezeOrigin(base)}/v1/voice-previews/${encodeURIComponent(generatedId)}/save`, {
      method: 'POST',
      headers: { ...headers(config), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice_name: String(name || generatedId).slice(0, 80),
        ...(description ? { voice_description: String(description).slice(0, 1000) } : {}),
        language_code: LANGUAGE_CODE,
      }),
      signal,
    });
    if (!response.ok) throw await designFailure('保存设计的声音', response);
    const payload = await response.json().catch(() => null);
    const voiceId = String(payload?.voice_id || '').trim();
    if (!voiceId) throw unavailable('保存设计的声音失败：Breeze 没有返回 voice_id', 'TTS_VOICE_DESIGN_FAILED');
    return { voiceId };
  },
  async fetchVoices({ base, config, fetchImpl, signal }) {
    const origin = breezeOrigin(base);
    const rows = [];
    for (const query of VOICE_QUERIES) {
      let token = null;
      for (let page = 0; page < query.pages; page += 1) {
        const params = new URLSearchParams({ language_code: LANGUAGE_CODE, voice_type: query.voice_type, page_size: String(PAGE_SIZE) });
        if (query.sort) params.set('sort', query.sort);
        if (token) params.set('next_page_token', token);
        const response = await fetchImpl(`${origin}/v1/voices?${params}`, { method: 'GET', headers: headers(config), signal });
        if (!response.ok) {
          throw unavailable(`获取声音列表失败（HTTP ${response.status}）：${describeUpstreamBody(await response.text().catch(() => ''))}`, 'TTS_CUSTOM_VOICES_UNAVAILABLE');
        }
        const payload = await response.json().catch(() => null);
        for (const row of extractRows(payload, ['voices'])) {
          const id = String(row?.voice_id || '').trim();
          if (id) rows.push({ id, name: String(row?.name || '').trim() || id, group: query.group });
        }
        token = payload?.has_more ? payload?.next_page_token || null : null;
        if (!token) break;
      }
    }
    return dedupeById(rows);
  },
});
