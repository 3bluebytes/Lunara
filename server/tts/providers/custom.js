// providers/custom.js — 用户自定义 TTS provider。
//
// 取代旧的硬编码 MiniMax provider：端点 URL、API key、model、协议与保留的
// 声音全部来自用户配置（ttsCustomConfig）。
//
// 本文件只负责：配置校验、超时、错误包装、按协议分派与表演翻译入口。
// 每个协议的地址、鉴权头、请求体、取音频与发现各在 protocols/ 下一份适配文件：
//   openai（默认）  protocols/openai.js   OpenAI 兼容 /audio/speech
//   minimax         protocols/minimax.js  官方 t2a_v2（hex 音频）
//   breeze          protocols/breeze.js   BreezeBlue /v1/text-to-speech（xi-api-key）
//   recipe          protocols/recipe.js   声明式请求配方（预设或助手起草），固定解释器执行
//
// 表演意图：网关先调 renderPerformance(text, performance) 拿到 { text, native }，
// 再把翻译后的文本与 native 交给 synth。能力按 (协议, 模型) 查静态表，未登记即 NONE。
//
// 安全约定：错误信息不得包含 API key；上游响应体只截断摘录。

import { TtsProviderUnavailableError, TtsSynthesisError } from '../TtsProvider.js';
import { resolvePerformanceCapability } from '../performance/capabilities.js';
import { renderSpeech } from '../performance/render.js';
import { attachSynthesisTiming, createSynthesisClock } from '../synthesisTiming.js';
import { breezeProtocol } from './protocols/breeze.js';
import { minimaxProtocol } from './protocols/minimax.js';
import { openaiProtocol } from './protocols/openai.js';
import { recipeProtocol } from './protocols/recipe.js';
import { CUSTOM_PROVIDER_ID, describeUpstreamBody, unavailable } from './protocols/shared.js';

export { CUSTOM_PROVIDER_ID };
const REQUEST_TIMEOUT_MS = 30_000;
const DISCOVER_TIMEOUT_MS = 15_000;
// 设计一次要生成多段试听音频，比合成慢得多。
const DESIGN_TIMEOUT_MS = 90_000;
// 供应商并发满额（429）或容量不足（503）时按 Retry-After 有界重试；其余失败不重试。
const RETRYABLE_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

const PROTOCOL_ADAPTERS = Object.freeze({
  openai: openaiProtocol,
  minimax: minimaxProtocol,
  breeze: breezeProtocol,
  recipe: recipeProtocol,
});
export const CUSTOM_PROTOCOL_IDS = Object.freeze(Object.keys(PROTOCOL_ADAPTERS));

function protocolOf(config) {
  return PROTOCOL_ADAPTERS[config?.protocol] ? config.protocol : 'openai';
}

/** 端点未配置或 baseUrl 非法时抛不可用；返回去尾斜杠的 base。 */
function requireConfigured(config, providerId = CUSTOM_PROVIDER_ID) {
  const baseUrl = String(config?.baseUrl || '').trim();
  const apiKey = String(config?.apiKey || '').trim();
  if (!baseUrl || !apiKey) {
    throw new TtsProviderUnavailableError('自定义 TTS 接口未配置完整（需要 URL 与 API key）', { providerId });
  }
  const base = baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) {
    throw new TtsProviderUnavailableError('自定义 TTS 接口的 URL 必须以 http(s):// 开头', { providerId });
  }
  return base;
}

/** 等待 ms，期间响应取消。 */
function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 每个接口一个 FIFO 并发闸门。按接口 id 放在模块级：设置保存会重建 provider 实例，
 * 但同一个账号的并发额度不变，新旧实例必须共用同一道闸门。
 */
const gates = new Map();
function gateFor(id, limit) {
  if (!limit) return null;
  let gate = gates.get(id);
  if (!gate) {
    gate = { active: 0, limit, waiting: [] };
    gates.set(id, gate);
  }
  gate.limit = limit;
  return gate;
}
function acquire(gate, signal) {
  if (!gate) return Promise.resolve(() => {});
  const release = () => {
    gate.active -= 1;
    const next = gate.waiting.shift();
    if (next) next();
  };
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const admit = () => {
      signal?.removeEventListener('abort', onAbort);
      gate.active += 1;
      let released = false;
      resolve(() => { if (!released) { released = true; release(); } });
    };
    const onAbort = () => {
      const index = gate.waiting.indexOf(admit);
      if (index >= 0) gate.waiting.splice(index, 1);
      reject(signal.reason);
    };
    if (gate.active < gate.limit) { admit(); return; }
    gate.waiting.push(admit);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-After 秒数（上限 MAX_RETRY_WAIT_MS）；没有时按 0.5·2^n 秒退避。 */
function retryDelayMs(response, attempt, random) {
  const header = Number.parseFloat(response.headers?.get?.('retry-after') ?? '');
  const base = Number.isFinite(header) && header >= 0 ? header * 1000 : 500 * 2 ** attempt;
  return Math.min(MAX_RETRY_WAIT_MS, base) + Math.floor(random() * 250);
}

const withTimeout = (signal, ms) => {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

/**
 * 一个接口 = 一个 provider。多接口时每个接口各建一个实例，id 等于接口 id
 * （custom、custom-<slug>），getConfig 只返回该接口的连接信息与它名下的声音。
 */
export function createCustomProvider({
  getConfig, id = CUSTOM_PROVIDER_ID, label = '自定义接口音色', fetchImpl = globalThis.fetch, logger = console,
  wait = abortableWait, random = Math.random, now = Date.now,
} = {}) {
  if (typeof getConfig !== 'function') throw new TypeError('custom tts provider requires getConfig');
  const providerId = String(id || CUSTOM_PROVIDER_ID);

  /** 当前配置下的表演能力：按协议与 model 查静态表。 */
  function performanceCapability({ params = {} } = {}) {
    const config = getConfig() || {};
    return resolvePerformanceCapability({
      protocol: protocolOf(config),
      model: String(params.model || config.model || '').trim(),
    });
  }

  return {
    id: providerId,
    label,
    requiresCredentials: true,
    isConfigured: () => {
      const config = getConfig() || {};
      return Boolean(String(config.baseUrl || '').trim() && String(config.apiKey || '').trim());
    },
    listVoices: () => (getConfig()?.voices || []).map(voice => ({
      id: voice.sourceVoiceId,
      displayName: voice.displayName || voice.sourceVoiceId,
    })),
    performanceCapability,
    renderPerformance(text, performance, { params = {} } = {}) {
      const protocol = protocolOf(getConfig() || {});
      return renderSpeech({ protocol, capability: performanceCapability({ params }) }, text, performance);
    },
    async synth(text, { voiceRef = null, signal = null, params = {}, native = {} } = {}) {
      const config = getConfig() || {};
      const base = requireConfigured(config, providerId);
      const voiceId = String(voiceRef || '').trim();
      if (!voiceId) {
        throw new TtsSynthesisError('custom tts requires a voice id', { providerId });
      }
      const adapter = PROTOCOL_ADAPTERS[protocolOf(config)];
      const model = String(params.model || config.model || '').trim();
      if (!model && !adapter.modelOptional) {
        throw new TtsSynthesisError('custom tts requires a model（请在设置里填写或拉取）', {
          providerId, code: 'TTS_CUSTOM_MODEL_REQUIRED',
        });
      }
      const { url, init } = adapter.synthRequest({ base, config, model, voiceId, text, native: native || {} });
      const gate = gateFor(providerId, adapter.maxConcurrent || 0);
      // 分段计时（排队 / 请求 / 重试等待）随失败的错误交给失败记录，用来分辨超时花在了哪里。
      const clock = createSynthesisClock(now);
      try {
        return await requestWithRetries();
      } catch (error) {
        attachSynthesisTiming(error, clock.snapshot());
        throw error;
      }

      async function requestWithRetries() {
        for (let attempt = 0; ; attempt += 1) {
          // 重试等待不占闸门：位置留给别的请求。
          clock.enter('queue');
          const release = await acquire(gate, signal);
          clock.enter('request');
          let response;
          try {
            try {
              response = await fetchImpl(url, { ...init, signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
            } catch (error) {
              logger?.warn?.(`[tts] custom endpoint "${providerId}" request failed`);
              const timedOut = error?.name === 'TimeoutError' && !signal?.aborted;
              throw new TtsSynthesisError(`custom tts request failed: ${error.message}`, {
                providerId, cause: error, ...(timedOut ? { code: 'TTS_TIMEOUT' } : {}),
              });
            }
            clock.status(response.status);
            if (response.ok) {
              clock.enter('read');
              try {
                return await adapter.readAudio(response, { model, config, fetchImpl, signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
              } catch (error) {
                // 响应体沿用 fetch 的计时：音频没在时限内传完，与迟迟不回同样归为超时。
                if (error?.name !== 'TimeoutError' || signal?.aborted) throw error;
                throw new TtsSynthesisError(`custom tts audio read timed out: ${error.message}`, { providerId, cause: error, code: 'TTS_TIMEOUT' });
              }
            }
            const body = await response.text().catch(() => '');
            const failure = typeof adapter.describeFailure === 'function'
              ? adapter.describeFailure(response.status, body, config)
              : { message: `custom tts responded ${response.status}: ${describeUpstreamBody(body)}`, code: null };
            if (!RETRYABLE_STATUSES.has(response.status) || attempt >= MAX_RETRIES) {
              throw new TtsSynthesisError(failure.message, {
                providerId, ...(failure.code ? { code: failure.code } : {}),
              });
            }
          } finally {
            release();
          }
          clock.enter('retry-wait');
          await wait(retryDelayMs(response, attempt, random), signal);
        }
      }
    },
  };
}

/**
 * 拉取 model 列表（按协议）。openai/breeze 走各自的列表接口；minimax 官方不提供，
 * 如实报告 TTS_CUSTOM_MODELS_UNAVAILABLE。失败抛不可用（含截断的上游摘录，不含 key）。
 */
export async function fetchCustomModels({ getConfig, fetchImpl = globalThis.fetch, signal = null } = {}) {
  const config = getConfig() || {};
  const base = requireConfigured(config);
  return PROTOCOL_ADAPTERS[protocolOf(config)].fetchModels({
    base, config, fetchImpl, signal: withTimeout(signal, DISCOVER_TIMEOUT_MS),
  });
}

/**
 * 拉取声音列表（按协议），返回去重后的 [{ id, name }]。
 * 端点不提供列表时抛 TTS_CUSTOM_VOICES_UNAVAILABLE，由用户手填。
 */
export async function fetchCustomVoices({ getConfig, fetchImpl = globalThis.fetch, signal = null } = {}) {
  const config = getConfig() || {};
  const base = requireConfigured(config);
  return PROTOCOL_ADAPTERS[protocolOf(config)].fetchVoices({
    base, config, fetchImpl, signal: withTimeout(signal, DISCOVER_TIMEOUT_MS),
  });
}

// ---- 按描述设计声音：协议可选能力（breeze、minimax）；openai 兼容没有统一接口 ----

/** 协议的设计能力 { maxCandidates, costNote }；不支持时为 null。 */
export function voiceDesignCapability(protocol) {
  const adapter = PROTOCOL_ADAPTERS[protocol];
  return adapter && typeof adapter.designVoice === 'function' ? adapter.voiceDesign : null;
}

function requireDesignAdapter(config) {
  const adapter = PROTOCOL_ADAPTERS[protocolOf(config)];
  if (typeof adapter.designVoice !== 'function' || typeof adapter.activateDesignedVoice !== 'function') {
    throw unavailable('这个接口的协议不支持按描述设计声音', 'TTS_VOICE_DESIGN_UNSUPPORTED');
  }
  return adapter;
}

/**
 * 生成设计候选：[{ generatedId, audio }]。候选数夹到协议上限；不自动重试。
 * 只有用户确认的描述与试听文本会发给厂商。
 */
export async function designCustomVoices({
  getConfig, description, previewText = '', count = 1, fetchImpl = globalThis.fetch, signal = null,
} = {}) {
  const config = getConfig() || {};
  const adapter = requireDesignAdapter(config);
  const base = requireConfigured(config);
  const limit = adapter.voiceDesign.maxCandidates;
  return adapter.designVoice({
    base, config, fetchImpl, signal: withTimeout(signal, DESIGN_TIMEOUT_MS),
    description, previewText, count: Math.min(limit, Math.max(1, Number.parseInt(count, 10) || 1)),
  });
}

/** 把设计候选转为可长期合成的声音，返回 { voiceId }（Breeze 为保存后的新 id）。 */
export async function activateCustomDesignedVoice({
  getConfig, generatedId, name = '', description = '', model = '', fetchImpl = globalThis.fetch, signal = null,
} = {}) {
  const config = getConfig() || {};
  const adapter = requireDesignAdapter(config);
  const base = requireConfigured(config);
  return adapter.activateDesignedVoice({
    base, config, fetchImpl, signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    generatedId: String(generatedId || '').trim(), name, description,
    model: String(model || config.model || '').trim(),
  });
}
