// tts.js — 声音合成网关。
//
// 职责边界（重要）：
//   本模块只负责 **缓存、provider 选择与回落、对外资产描述**。
//   具体怎么合成、用哪个精度、调用哪个服务，全部属于 provider。
//   新增声音源应当只新增 provider 并注册，不需要改动本文件。
//
// 失败契约：合成失败必须抛出可识别错误，**不得**写入占位音频冒充成功。
// 上层据此跳过该次串词并可重试。
//
// 兼容：对外仍暴露 synth / setVoice / getVoice，签名与旧实现一致，
// 因此 server/index.js 与 server/settingsService.js 不需要改动。

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { trace } from './trace.js';
import { resolveTtsCacheDir } from './runtimePaths.js';
import { TtsProviderRegistry } from './tts/TtsProviderRegistry.js';
import { TtsSynthesisError, TtsProviderUnavailableError } from './tts/TtsProvider.js';
import { normalizeLoudnessSafely } from './tts/loudness.js';
import { createCustomProvider, CUSTOM_PROVIDER_ID } from './tts/providers/custom.js';
import { getCustomTtsEndpoint, readCustomTtsConfig } from './ttsCustomConfig.js';
import { readTtsFallbackConfig } from './ttsFallbackConfig.js';
import { createFreeEdgeProvider, FREE_EDGE_PROVIDER_ID } from './tts/providers/freeEdge.js';
import { NO_PERFORMANCE_CAPABILITY } from './tts/performance/capabilities.js';
import { toPlainText } from './tts/performance/markers.js';
import { renderSpeech } from './tts/performance/render.js';

/** 已知的输出容器。provider 未声明扩展名时按此顺序探测缓存。 */
const CACHE_EXTENSIONS = ['wav', 'mp3'];

const DEFAULT_VOICE = process.env.MINIMAX_VOICE_ID || 'Chinese (Mandarin)_Sweet_Lady';

/** 稳定序列化：参数顺序不同不应产生不同缓存键。 */
function stableParams(params) {
  if (!params || typeof params !== 'object') return '';
  return Object.keys(params).sort()
    .filter(key => params[key] !== undefined && params[key] !== null)
    .map(key => `${key}=${JSON.stringify(params[key])}`)
    .join(',');
}

/**
 * 缓存键必须覆盖 provider：不同 provider 对同一文本会产出不同音频，
 * 不区分会导致跨 provider 命中并返回错误的声音。
 */
function cacheKey({ providerId, voiceRef, text, params }) {
  return createHash('sha256')
    .update(`${providerId}::${voiceRef || ''}::${stableParams(params)}::${text}`)
    .digest('hex');
}

/**
 * 构造一个网关实例。
 *
 * 拆成工厂是为了让测试能用隔离的 registry 与缓存目录，而不必依赖进程级环境变量。
 *
 * @param {{ registry: TtsProviderRegistry, cacheDir?: string, logger?: object, initialVoice?: string }} options
 */
export function createTtsGateway({
  registry,
  cacheDir = resolveTtsCacheDir(),
  logger = console,
  initialVoice = DEFAULT_VOICE,
  resolveVoiceRef = null,
} = {}) {
  if (!registry) throw new TypeError('tts gateway requires a provider registry');
  mkdirSync(cacheDir, { recursive: true });

  // 可替换的声音身份解析器。由组装根注入，避免网关反向依赖 station 层。
  let voiceResolver = typeof resolveVoiceRef === 'function' ? resolveVoiceRef : null;

  // 兼容旧的进程级默认音色。per-call 的 voiceId 优先，不受这里影响。
  let currentVoice = String(initialVoice || '');

  function setVoice(id) {
    if (id && typeof id === 'string') currentVoice = id;
  }
  function getVoice() {
    return currentVoice;
  }

  function readCache(hash) {
    for (const extension of CACHE_EXTENSIONS) {
      const path = resolve(cacheDir, `${hash}.${extension}`);
      if (existsSync(path) && statSync(path).size > 0) {
        return {
          path,
          extension,
          url: `/tts/${hash}.${extension}`,
          contentType: extension === 'wav' ? 'audio/wav' : 'audio/mpeg',
        };
      }
    }
    return null;
  }

  /**
   * 生成或取回缓存。
   *
   * 未指定 providerId 时按 registry 优先级依次尝试，前一个失败才回落；
   * 显式指定时只试它，不静默换成别的声音源。
   *
   * @returns {Promise<{hash,path,url,source,providerId,extension,contentType}|null>}
   *   文本为空返回 null；合成失败抛出 TtsSynthesisError。
   */
  /**
   * 把调用方的声音引用解析成 (providerId, voiceRef)。
   * 调用方可能传入的是 Lunara 的稳定声音身份（例如设置页保存的 vp_* id），
   * 也可能是不带 provider 的裸声音 id。注入的解析器负责把它变成
   * (providerId, voiceId)；未注入时保持原行为。失效的保留身份抛不可用。
   */
  function resolveTarget(voiceId, providerId) {
    // per-call voiceId 优先，避免并发会话互相改动进程级默认音色。
    const requestedRef = providerId === 'system' && voiceId === null ? '' : String(voiceId || currentVoice || '');
    let resolvedProviderId = providerId;
    let voiceRef = requestedRef;
    let resolvedParams = null;
    if (!resolvedProviderId && voiceResolver && requestedRef) {
      try {
        const resolved = voiceResolver(requestedRef);
        if (resolved?.unavailable || (!resolved && /^vp_(sy|cx)_/.test(requestedRef))) throw new TtsProviderUnavailableError('所选声音当前不可用，请重新选择。');
        if (resolved && !resolved.unavailable && resolved.providerId) {
          resolvedProviderId = resolved.providerId;
          voiceRef = resolved.voiceId || '';
          // 声音自带的合成参数（例如这把声音记录的 model），调用方显式参数优先。
          if (resolved.params && typeof resolved.params === 'object') resolvedParams = resolved.params;
        }
      } catch (error) {
        if (error instanceof TtsProviderUnavailableError) throw error;
        logger?.warn?.(`[tts] voice resolution failed for "${requestedRef}": ${error.message}`);
      }
    }
    return { providerId: resolvedProviderId, voiceRef, params: resolvedParams };
  }

  /** provider 的表演翻译；未声明翻译能力的 provider 一律按 NONE 剥离标记、不带原生参数。 */
  function renderFor(provider, text, performance, { voiceRef, params }) {
    if (typeof provider.renderPerformance === 'function') {
      const rendered = provider.renderPerformance(text, performance, { voiceRef, params });
      return { text: String(rendered?.text ?? '').trim(), native: rendered?.native || {} };
    }
    return renderSpeech({}, text, performance);
  }

  /**
   * 生成或取回缓存。
   *
   * 未指定 providerId 时按 registry 优先级依次尝试，前一个失败才回落；
   * 显式指定时只试它，不静默换成别的声音源。
   *
   * performance 是 provider 中立的 SpeechPerformance；text 可以含白名单中立标记。
   * 每个候选 provider 都从中立形式各自翻译（回落不复用前一家的翻译），缓存键基于
   * 翻译后的文本与原生参数：同字不同语气不共用缓存，翻译结果相同则命中同一条。
   *
   * @returns {Promise<{hash,path,url,source,providerId,extension,contentType}|null>}
   *   文本为空返回 null；合成失败抛出 TtsSynthesisError。
   */
  async function synth(text, { voiceId = null, signal = null, providerId = null, params: callParams = {}, performance = null } = {}) {
    const cleaned = String(text ?? '').trim();
    if (!cleaned || !toPlainText(cleaned)) {
      trace('tts.synth: empty text, returning null');
      return null;
    }
    signal?.throwIfAborted?.();

    const { providerId: providerId_, voiceRef, params: voiceParams } = resolveTarget(voiceId, providerId);
    const params = voiceParams ? { ...voiceParams, ...callParams } : callParams;
    const selection = registry.resolve({ providerId: providerId_ });
    if (!selection.providers.length) {
      throw new TtsProviderUnavailableError(
        `no usable tts provider (${selection.reason})`,
        { providerId },
      );
    }

    const failures = [];
    for (const provider of selection.providers) {
      signal?.throwIfAborted?.();
      let rendered;
      try {
        rendered = renderFor(provider, cleaned, performance, { voiceRef, params });
      } catch (error) {
        failures.push({ providerId: provider.id, error });
        logger?.warn?.(`[tts] provider "${provider.id}" render failed: ${error.message}`);
        continue;
      }
      if (!rendered.text) continue;
      const native = rendered.native || {};
      // 没有原生参数时键与旧实现完全一致，已有缓存不失效。
      const keyParams = Object.keys(native).length ? { ...params, native } : params;
      const hash = cacheKey({ providerId: provider.id, voiceRef, text: rendered.text, params: keyParams });
      const cached = readCache(hash);
      if (cached) {
        trace(`tts.synth: cache HIT provider=${provider.id} text="${rendered.text.slice(0, 40)}"`);
        return {
          hash,
          path: cached.path,
          url: cached.url,
          source: 'cache',
          providerId: provider.id,
          extension: cached.extension,
          contentType: cached.contentType,
        };
      }
      try {
        trace(`tts.synth: provider=${provider.id} text="${rendered.text.slice(0, 40)}"`);
        await provider.ensureReady();
        const audio = await provider.synth(rendered.text, { voiceRef, signal, params, native });
        // 响度归一化在网关层做，所有 provider 一致受益；非 WAV 会原样透传。
        const normalized = normalizeLoudnessSafely(audio.bytes, { providerId: provider.id });
        const path = resolve(cacheDir, `${hash}.${audio.extension}`);
        writeFileSync(path, normalized.bytes);
        trace(`tts.synth: provider=${provider.id} OK url=/tts/${hash}.${audio.extension}`
          + (normalized.changed ? ` gain=+${normalized.gainDb.toFixed(1)}dB` : ''));
        return {
          hash,
          path,
          url: `/tts/${hash}.${audio.extension}`,
          source: audio.source,
          providerId: provider.id,
          extension: audio.extension,
          contentType: audio.contentType,
          durationMs: audio.durationMs ?? null,
          loudnessDb: normalized.loudnessDb ?? audio.loudnessDb ?? null,
          peakDb: normalized.peakDb ?? null,
          appliedGainDb: normalized.changed ? normalized.gainDb : 0,
        };
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        failures.push({ providerId: provider.id, error });
        trace(`tts.synth: provider=${provider.id} failed: ${error.message}`);
        logger?.warn?.(`[tts] provider "${provider.id}" failed: ${error.message}`);
      }
    }
    // 全部失败：显式抛出，不写占位音频。
    const detail = failures.map(item => `${item.providerId}: ${item.error.message}`).join(' | ');
    // 只试了一家时保留它的稳定错误码（额度、鉴权、并发…），诊断与提醒据此给出真实原因。
    const only = failures.length === 1 ? failures[0] : null;
    throw new TtsSynthesisError(`all tts providers failed — ${detail}`, {
      code: only?.error?.code && only.error.code !== 'TTS_SYNTHESIS_FAILED' ? only.error.code : 'TTS_ALL_PROVIDERS_FAILED',
      providerId: only?.providerId || null,
      cause: only?.error || null,
    });
  }

  /**
   * 供串词写作侧查询：某个声音此刻落到的 provider 声明了哪些表演能力。
   * 解析失败、声音不可用或 provider 未声明时返回 NONE（写作侧就不提供表演段落）。
   */
  function performanceCapability(voiceId = null, { providerId = null, params = {} } = {}) {
    try {
      const target = resolveTarget(voiceId, providerId);
      const provider = registry.resolve({ providerId: target.providerId }).providers[0];
      if (typeof provider?.performanceCapability !== 'function') return NO_PERFORMANCE_CAPABILITY;
      const merged = target.params ? { ...target.params, ...params } : params;
      return provider.performanceCapability({ voiceRef: target.voiceRef, params: merged }) || NO_PERFORMANCE_CAPABILITY;
    } catch {
      return NO_PERFORMANCE_CAPABILITY;
    }
  }

  /** 供健康检查与设置页使用：各 provider 的就绪状态。 */
  function providerStatus() {
    return registry.status();
  }

  /** 供设置页与虚拟人组装使用：跨 provider 的音色总表。 */
  function listAllVoices() {
    return registry.available().flatMap(provider => {
      try {
        const voices = provider.listVoices();
        return (Array.isArray(voices) ? voices : []).map(voice => ({ ...voice, providerId: provider.id }));
      } catch {
        return [];
      }
    });
  }

  /**
   * 把厂商直接给出的样音（如声音设计的试听）写入缓存并给出可播放 URL。
   * 按内容哈希命名，不做响度归一化：样音用来判断音色本身。
   */
  function storeAudio({ bytes, extension } = {}) {
    if (!CACHE_EXTENSIONS.includes(extension)) throw new TypeError(`unsupported audio extension: ${extension}`);
    if (!bytes?.length) throw new TypeError('cannot store empty audio');
    const hash = createHash('sha1').update(bytes).digest('hex');
    writeFileSync(resolve(cacheDir, `${hash}.${extension}`), bytes);
    return { url: `/tts/${hash}.${extension}` };
  }

  return {
    synth, setVoice, getVoice, providerStatus, listAllVoices, performanceCapability, cacheDir, registry, storeAudio,
    setVoiceResolver(resolver) {
      voiceResolver = typeof resolver === 'function' ? resolver : null;
    },
  };
}

const isCustomProviderId = id => id === CUSTOM_PROVIDER_ID || String(id).startsWith(`${CUSTOM_PROVIDER_ID}-`);

/**
 * 让 registry 里的自定义 provider 与配置的接口一一对应：每个接口一个 provider
 * （id = 接口 id，label = 接口名），删掉的接口注销。没有任何接口时保留一个空的
 * custom，状态页仍如实显示"未配置"。重复调用安全（register 按 id 替换）。
 */
export function syncCustomEndpointProviders(targetRegistry, { endpoints = [], getEndpoint } = {}) {
  const wanted = endpoints.length ? endpoints : [{ id: CUSTOM_PROVIDER_ID, name: '' }];
  const wantedIds = new Set(wanted.map(endpoint => endpoint.id));
  for (const existing of targetRegistry.list()) {
    if (isCustomProviderId(existing.id) && !wantedIds.has(existing.id)) targetRegistry.unregister(existing.id);
  }
  for (const endpoint of wanted) {
    targetRegistry.register(createCustomProvider({
      id: endpoint.id,
      label: endpoint.name || '自定义接口音色',
      getConfig: () => getEndpoint(endpoint.id),
    }));
  }
}

/**
 * 免费声音（Edge 朗读）按用户开关注册或注销。关闭时不创建 provider，因此不请求声音列表、
 * 不发送文字；打开时复用已有实例（保留声音列表缓存）。它是 explicitOnly：只有伙伴明确
 * 绑定了免费声音或代读显式指定它时才会出声，不参与网关的隐式优先级回落。
 */
export function syncFreeVoiceProvider(targetRegistry, { enabled = false, createProvider } = {}) {
  if (!enabled) {
    targetRegistry.unregister(FREE_EDGE_PROVIDER_ID);
    return;
  }
  if (!targetRegistry.has(FREE_EDGE_PROVIDER_ID)) targetRegistry.register(createProvider());
}

/**
 * 进程级默认装配。
 *
 * 自定义接口（每个配置了 URL+key 的接口一个 provider），外加用户开启后的免费声音。系统语音与本地模型
 * 均已按产品决定关闭：没有配置自定义接口时如实失败，不偷偷换成别的发声。
 *
 * 明确绑定的声音由 VoiceDirectory 解析到所属接口，失败不在网关偷偷换 provider。
 */
export const registry = new TtsProviderRegistry();

/** 配置变更后调用（设置页保存/删除接口、启动迁移之后）。 */
export function syncCustomTtsProviders() {
  syncCustomEndpointProviders(registry, {
    endpoints: readCustomTtsConfig().endpoints,
    getEndpoint: getCustomTtsEndpoint,
  });
  syncFreeVoiceProvider(registry, {
    enabled: readTtsFallbackConfig().freeVoicesEnabled,
    createProvider: () => createFreeEdgeProvider({
      keptVoices: () => readCustomTtsConfig().voices.filter(voice => voice.endpointId === FREE_EDGE_PROVIDER_ID),
    }),
  });
}
syncCustomTtsProviders();

const defaultGateway = createTtsGateway({ registry });

/** 注入声音身份解析器；由组装根调用。 */
export function setVoiceResolver(resolver) {
  defaultGateway.setVoiceResolver(resolver);
}
export const synth = defaultGateway.synth;
export const setVoice = defaultGateway.setVoice;
export const getVoice = defaultGateway.getVoice;
export const providerStatus = defaultGateway.providerStatus;
export const performanceCapability = defaultGateway.performanceCapability;
export const storeAudio = defaultGateway.storeAudio;
const listAllVoices = defaultGateway.listAllVoices;
