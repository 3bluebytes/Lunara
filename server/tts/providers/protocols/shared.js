// protocols/shared.js — 自定义 TTS 各协议适配器共用的小工具。
//
// 安全约定：任何错误文本只摘录截断后的上游响应体，绝不拼入 API key。

import { createTtsAudio, TtsProviderUnavailableError, TtsSynthesisError } from '../../TtsProvider.js';

export const CUSTOM_PROVIDER_ID = 'custom';

export const EXTENSION_BY_CONTENT_TYPE = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
});

export function describeUpstreamBody(body) {
  return String(body || '').replace(/\s+/g, ' ').slice(0, 200);
}

/** 宽松解析 models/voices 响应：数组、{data}、{models}、{voices} 皆可。 */
export function extractRows(payload, arrayKeys) {
  if (Array.isArray(payload)) return payload;
  for (const key of arrayKeys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

export function dedupeById(rows) {
  const seen = new Set();
  return rows.filter(row => (row && !seen.has(row.id) ? (seen.add(row.id), true) : false));
}

export function unavailable(message, code = null) {
  const error = new TtsProviderUnavailableError(message, { providerId: CUSTOM_PROVIDER_ID });
  if (code) error.code = code;
  return error;
}

export function synthesisError(message, { code, cause } = {}) {
  return new TtsSynthesisError(message, { providerId: CUSTOM_PROVIDER_ID, ...(code ? { code } : {}), ...(cause ? { cause } : {}) });
}

/** 字节流响应 → TtsAudio；扩展名按 content-type，缺省 mp3。 */
export async function readBinaryAudio(response, { model, fallbackExtension = 'mp3' } = {}) {
  const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType] || fallbackExtension;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length) throw synthesisError('custom tts returned no audio');
  return createTtsAudio({ bytes, extension, source: `custom:${model}` });
}
