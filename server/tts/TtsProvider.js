// TtsProvider.js — 声音合成的 provider 契约与共享 helper。
//
// 这个模块只定义"什么是 provider"，不包含任何具体声音源。
//
// provider 的职责边界：
//   - 把一段文本合成成音频字节
//   - 报告自己是否可用（凭据 / 平台引擎 / 模型是否就绪）
//   - 列举自己能提供的音色
//
// provider **不**负责：缓存、响度归一化、对外 URL、队列身份。
// 那些属于网关（server/tts.js）。

import { randomUUID } from 'node:crypto';

/** 合成失败。必须向上抛出，不允许用占位音频冒充成功。 */
export class TtsSynthesisError extends Error {
  constructor(message, { providerId = null, cause = null, code = 'TTS_SYNTHESIS_FAILED' } = {}) {
    super(message);
    this.name = 'TtsSynthesisError';
    this.code = code;
    this.providerId = providerId;
    this.cause = cause;
  }
}

/** provider 缺少运行所需资源（凭据 / 模型 / 平台引擎）。 */
export class TtsProviderUnavailableError extends TtsSynthesisError {
  constructor(message, { providerId = null, cause = null } = {}) {
    super(message, { providerId, cause, code: 'TTS_PROVIDER_UNAVAILABLE' });
    this.name = 'TtsProviderUnavailableError';
  }
}

const SUPPORTED_EXTENSIONS = new Set(['wav', 'mp3']);
const CONTENT_TYPES = Object.freeze({
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
});

/**
 * provider.synth() 的返回值。音频格式用扩展名表达，contentType 由此派生，
 * 避免各 provider 各自手写 MIME 字符串导致不一致。
 *
 * @param {object} input
 * @param {Buffer|Uint8Array} input.bytes 音频字节
 * @param {'wav'|'mp3'} input.extension
 * @param {string} input.source 可诊断的来源标记
 * @param {number} [input.durationMs]
 * @param {number} [input.loudnessLufs]
 */
export function createTtsAudio({ bytes, extension, source, durationMs = null, loudnessLufs = null }) {
  if (!bytes || bytes.length === 0) {
    throw new TtsSynthesisError('provider returned empty audio', { code: 'TTS_EMPTY_AUDIO' });
  }
  const ext = String(extension || '').toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new TtsSynthesisError(`provider returned unsupported audio format: ${extension}`, {
      code: 'TTS_UNSUPPORTED_FORMAT',
    });
  }
  return {
    bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    extension: ext,
    contentType: CONTENT_TYPES[ext],
    source: String(source || 'unknown'),
    durationMs,
    loudnessLufs,
  };
}

/**
 * 校验并补全一个 provider 对象，使网关可以无条件下调用。
 * 缺 synth / listVoices / isConfigured 视为实现错误，直接失败而不是运行期才发现。
 */
export function assertTtsProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('tts provider must be an object');
  }
  const id = String(provider.id || '').trim();
  if (!id) throw new TypeError('tts provider requires a non-empty id');
  for (const method of ['isConfigured', 'listVoices', 'synth']) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`tts provider "${id}" is missing ${method}()`);
    }
  }
  return {
    ...provider,
    id,
    label: String(provider.label || id),
    requiresCredentials: provider.requiresCredentials === true,
    ensureReady: typeof provider.ensureReady === 'function' ? provider.ensureReady : async () => {},
  };
}
