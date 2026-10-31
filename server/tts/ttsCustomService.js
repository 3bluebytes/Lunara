// ttsCustomService.js — 自定义 TTS 接口（多接口 + 统一声音池）的应用服务。
//
// 组合配置存储（ttsCustomConfig）与发现（providers/custom）。每次配置变化后调用
// onConfigChanged(config)，由组合根同步每个接口的 provider 与 VoiceDirectory。
// 路由只看到这个服务；apiKey 永不出服务端。
//
// 声音设计（breeze/minimax）：生成的候选只带厂商样音（经 storeAudio 写入 TTS 缓存），
// 不进声音池；加入声音池前由 activateDesignedVoice 转正。描述可由 LLM 按伙伴人设起草，
// 但起草结果只回给设置页让用户修改——人设原文只给用户配置的 LLM，绝不发给 TTS 厂商。
//
// 配方接口（recipe）：预设或助手起草的配方，保存前必须对「同一个接口地址 + 同一份配方」
// 跑通过一次试合成（本进程内 30 分钟有效）；设置页另外要求用户试听确认后才发保存。
// 起草把文档交给用户配置的 LLM，但 Key 只留在服务端，模型看不到。
//
// 迁移：`migrateLegacyMinimaxTtsConfig` 把旧 MiniMax 环境配置与已存声音选择
// 一次性填入自定义配置（幂等）。必须在注册表/数据库就绪后调用（start 阶段），
// 不能在模块加载期执行。

import { createHash } from 'node:crypto';
import {
  seedFromLegacyMinimax,
  readCustomTtsConfig,
  saveCustomTtsConfig,
  publicCustomTtsConfig,
  removeCustomTtsEndpoint,
  getCustomTtsEndpoint,
} from '../ttsCustomConfig.js';
import {
  fetchCustomModels, fetchCustomVoices, CUSTOM_PROVIDER_ID,
  voiceDesignCapability, designCustomVoices, activateCustomDesignedVoice,
} from './providers/custom.js';
import { TtsProviderUnavailableError } from './TtsProvider.js';
import { FREE_EDGE_PROVIDER_ID } from './providers/freeEdge.js';
import { readTtsFallbackConfig, saveTtsFallbackConfig } from '../ttsFallbackConfig.js';
import { LEGACY_NATIVE_DISPLAY_NAMES } from '../station/VoiceDirectory.js';
import { recipeBase, testRecipe as runTestRecipe, validateRecipe } from './providers/protocols/recipe.js';
import { publicRecipePresets, recipePreset } from './providers/protocols/recipePresets.js';
import { createRecipeDraftService, RECIPE_TEST_TEXT } from './recipeDraftService.js';

/** 未指定接口时用第一个（单接口用户的旧行为）；指定了但不存在就如实报不可用。 */
function endpointIdOrDefault(endpointId) {
  const id = String(endpointId || '').trim();
  if (id) return id;
  return readCustomTtsConfig().endpoints[0]?.id || CUSTOM_PROVIDER_ID;
}

function requireEndpoint(endpointId) {
  const endpoint = getCustomTtsEndpoint(endpointIdOrDefault(endpointId));
  if (!endpoint) throw new TtsProviderUnavailableError('这个接口还没有保存，先保存连接信息再拉取。');
  return endpoint;
}

const DESIGN_DESCRIPTION_LIMITS = Object.freeze({ min: 3, max: 500 });
const DEFAULT_DESIGN_PREVIEW_TEXT = '你好，这里是 Lunara 电台。今晚想听点什么？我们慢慢来。';
const PERSONA_EXCERPT_CHARS = 4000;

/** 起草提示词：只要声音本身的描述，不要名字、经历与私人细节（用户之后还会审阅）。 */
function voiceDraftPrompt(person) {
  return [
    '你在为中文语音合成服务写一段"音色设计描述"。根据下面的角色设定，写出这个角色的声音应该是什么样：',
    '性别、年龄感、音高、音色质感、语速、情绪基调与说话习惯。',
    '要求：只描述声音本身；不写角色名字，不复述角色的经历、关系或任何私人细节；',
    '不超过 300 字；不分点、不加引号、不做解释，直接输出描述。',
    '',
    '角色设定：',
    String(person.personaDocument || '').slice(0, PERSONA_EXCERPT_CHARS),
  ].join('\n');
}

/** 模型偶尔会包一层引号或前缀，去掉后截断到厂商上限。 */
function cleanDraft(text) {
  return String(text || '')
    .trim()
    .replace(/^(?:音色(?:设计)?描述[:：]\s*)/, '')
    .replace(/^["“'「]+|["”'」]+$/g, '')
    .trim()
    .slice(0, DESIGN_DESCRIPTION_LIMITS.max);
}

const RECIPE_PASS_TTL_MS = 30 * 60 * 1000;
const RECIPE_NOT_TESTED = '配方还没有通过试合成：先试合成、试听确认，再保存。';

/** 对象键排序后的 JSON：前端改了键顺序也算同一份配方。 */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 「接口地址 + 配方」的指纹：试合成通过的记录按它查。 */
function recipeFingerprint(baseUrl, recipe) {
  const base = recipeBase(baseUrl);
  return createHash('sha256').update(`${base.origin}${base.prefix}\n${stableJson(validateRecipe(recipe))}`).digest('hex');
}

const lazyAskText = async (prompt, options) => (await import('../llm.js')).askText(prompt, options);
const lazyFreeVoiceProvider = async () => (await import('../tts.js')).registry.get(FREE_EDGE_PROVIDER_ID);
const FREE_VOICES_OFF = '先开启免费声音，再拉取或试听。';

/**
 * 接口视图附带设计能力（协议不支持时为 null），设置页据此决定是否显示「设计声音」；
 * 另附免费声音开关与代读目标（不含任何凭据）。
 */
function publicView() {
  const config = publicCustomTtsConfig();
  return {
    ...config,
    endpoints: config.endpoints.map(endpoint => ({ ...endpoint, voiceDesign: voiceDesignCapability(endpoint.protocol) })),
    fallback: { ...readTtsFallbackConfig() },
  };
}

export function createTtsCustomService({
  onConfigChanged = () => {}, synthesize = null,
  storeAudio = null, getPerson = () => null, askText = lazyAskText, fetchImpl = globalThis.fetch,
  freeVoiceProvider = lazyFreeVoiceProvider, testRecipe = runTestRecipe, now = () => Date.now(),
} = {}) {
  const recipePasses = new Map();
  const draftService = createRecipeDraftService({ askText, fetchImpl });

  /**
   * 配方接口的连接信息：请求里没填 Key 时，只有地址与已保存接口同 origin 才沿用旧 Key
   * （改了地址就得重新填，旧 Key 不会被发往新主机）。
   */
  function recipeConnection({ endpointId, baseUrl, apiKey }) {
    const typed = String(apiKey || '').trim();
    if (typed) return { apiKey: typed };
    const saved = endpointId ? getCustomTtsEndpoint(String(endpointId).trim()) : null;
    if (!saved?.apiKey) return { error: '先填写这个接口的 API Key。' };
    try {
      if (recipeBase(saved.baseUrl).origin !== recipeBase(baseUrl).origin) return { error: '接口地址改了，请重新填写 API Key。' };
    } catch (error) {
      return { error: error.message };
    }
    return { apiKey: saved.apiKey };
  }

  function rememberPass(baseUrl, recipe) {
    recipePasses.set(recipeFingerprint(baseUrl, recipe), now() + RECIPE_PASS_TTL_MS);
  }

  /** 保存配方接口前的门槛：配方合法，且新的或改过的「地址 + 配方」刚通过试合成。 */
  function recipeSaveProblem(endpoint) {
    const saved = endpoint.id ? getCustomTtsEndpoint(String(endpoint.id).trim()) : null;
    const protocol = endpoint.protocol ?? saved?.protocol;
    if (protocol !== 'recipe') return null;
    const baseUrl = endpoint.baseUrl ?? saved?.baseUrl;
    const recipe = endpoint.recipe ?? (saved?.protocol === 'recipe' ? saved.recipe : undefined);
    let fingerprint;
    try {
      fingerprint = recipeFingerprint(baseUrl, recipe);
    } catch (error) {
      return error.message;
    }
    const unchanged = saved?.protocol === 'recipe' && saved.recipe && (() => {
      try { return recipeFingerprint(saved.baseUrl, saved.recipe) === fingerprint; } catch { return false; }
    })();
    if (unchanged) return null;
    return (recipePasses.get(fingerprint) || 0) > now() ? null : RECIPE_NOT_TESTED;
  }

  return {
    getConfig: () => publicView(),
    /** endpoint 按 id 新增或更新（key 留空保留旧值）；voices 给出时整体替换声音池。 */
    saveConfig: ({ endpoint, voices } = {}) => {
      if (endpoint) {
        const problem = recipeSaveProblem(endpoint);
        if (problem) return { error: problem };
      }
      const next = saveCustomTtsConfig({
        ...(endpoint ? { endpoint } : {}),
        ...(voices !== undefined ? { voices } : {}),
      });
      onConfigChanged(next);
      return { ...publicView(), savedEndpointId: next.savedEndpointId };
    },
    removeEndpoint: ({ endpointId } = {}) => {
      const result = removeCustomTtsEndpoint(endpointId);
      if (!result.removed) return { error: '没有找到这个接口。' };
      onConfigChanged(result.config);
      return { ...publicView(), removedVoices: result.removedVoices };
    },
    /** 随软件发布的预设配方（千问、豆包）。 */
    recipePresets: () => publicRecipePresets(),
    /**
     * 对一份配方只做试合成（预设、或用户编辑过的配方）：固定试听句，不重试。
     * 通过时返回试听链接，并记下「地址 + 配方」已通过；失败返回脱敏后的原因。
     */
    async testRecipe({ endpointId, baseUrl, apiKey, model, voice, recipe, presetId } = {}) {
      const preset = presetId ? recipePreset(String(presetId)) : null;
      if (presetId && !preset) return { error: '没有这个预设。' };
      const candidate = recipe ?? preset?.recipe;
      const connection = recipeConnection({ endpointId, baseUrl, apiKey });
      if (connection.error) return { error: connection.error };
      if (typeof storeAudio !== 'function') return { error: '试听音频存储不可用。' };
      const result = await testRecipe({
        baseUrl, apiKey: connection.apiKey, model: String(model || '').trim(), voice: String(voice || '').trim(),
        recipe: candidate, text: RECIPE_TEST_TEXT, fetchImpl,
      });
      if (!result.ok) return { error: result.summary.message, summary: result.summary, stage: result.stage };
      rememberPass(baseUrl, result.recipe);
      return { recipe: result.recipe, previewUrl: storeAudio(result.audio).url, testText: RECIPE_TEST_TEXT };
    },
    /**
     * 「其他（让助手接入）」：读文档起草配方，或带上一次失败修订。只调模型、不向厂商发请求，
     * 不需要 Key（已知的 Key 只用来抹掉文档里误贴的副本）；试合成是用户另点的 testRecipe。
     */
    async draftRecipe({ endpointId, baseUrl, apiKey, model, voice, docText, docUrl, previous } = {}) {
      const connection = recipeConnection({ endpointId, baseUrl, apiKey });
      const result = await draftService.draft({
        baseUrl, apiKey: connection.apiKey || '', model: String(model || '').trim(), voice: String(voice || '').trim(),
        docText: String(docText || '').slice(0, 200_000), docUrl: String(docUrl || ''), previous: previous ?? null,
      });
      if (result.error) return { error: result.error };
      if (!result.ok) {
        return {
          drafted: false, recipe: result.recipe, summary: result.summary, attempts: result.attempts,
          ...(result.unsupported ? { unsupported: result.unsupported } : {}),
        };
      }
      return { drafted: true, recipe: result.recipe, attempts: result.attempts };
    },
    discoverModels: async ({ endpointId } = {}) => {
      const endpoint = requireEndpoint(endpointId);
      return fetchCustomModels({ getConfig: () => endpoint });
    },
    /**
     * 免费声音开关与代读设置。从关到开必须带本次的知情确认（consent:true）；开关变化后
     * 重新同步 provider：关闭即注销 free-edge，此后不再向微软发送任何文字。
     */
    saveFallback: (patch = {}) => {
      try {
        saveTtsFallbackConfig(patch);
      } catch (error) {
        return { error: error.message };
      }
      onConfigChanged(readCustomTtsConfig());
      return publicView();
    },
    discoverVoices: async ({ endpointId } = {}) => {
      if (String(endpointId || '').trim() === FREE_EDGE_PROVIDER_ID) {
        const provider = await freeVoiceProvider();
        if (!provider) throw new TtsProviderUnavailableError(FREE_VOICES_OFF);
        return provider.fetchVoices();
      }
      const endpoint = requireEndpoint(endpointId);
      return fetchCustomVoices({ getConfig: () => endpoint });
    },
    // 待选试听：不经 VoiceDirectory，直接 (接口, 源 voice id[, model]) 合成，因此还没
    // 保存的草稿声音也能先听再决定去留；试听不改变待选名单（试听 ≠ 保留）。
    // 同 voice+文本命中网关磁盘缓存，重复试听不会重复请求端点（费用边界）。
    async previewVoice({ endpointId, voiceId, model, text } = {}) {
      const id = String(voiceId || '').trim();
      if (!id) return { error: '缺少要试听的 voice id。' };
      if (typeof synthesize !== 'function') return { error: '合成服务不可用。' };
      // 试听只为确认音色：样音文本截断到 80 字，控制自定义端点的合成费用。
      const previewText = String(text || '').trim().slice(0, 80) || '你好，这里是 Lunara 电台。';
      const voiceModel = String(model || '').trim();
      try {
        const audio = await synthesize(previewText, {
          providerId: endpointIdOrDefault(endpointId),
          voiceId: id,
          ...(voiceModel ? { params: { model: voiceModel } } : {}),
        });
        return { url: audio?.url || null, source: audio?.source || null };
      } catch (error) {
        // 组合根在 provider 就绪前就短路，机械报错对用户没有可操作性；
        // 映射成设置页语境的可纠正指引。
        if (/no usable tts provider/.test(String(error?.message || ''))) {
          if (String(endpointId || '').trim() === FREE_EDGE_PROVIDER_ID) return { error: FREE_VOICES_OFF };
          return { error: '这个接口未配置完整（需要 URL 与 API key），先填写并保存后再试听。' };
        }
        return { error: error.message };
      }
    },
    /**
     * 按描述生成设计候选：[{ generatedId, previewUrl }]。每次调用都是用户点击触发、
     * 会扣厂商额度，因此不自动重试；候选数由协议上限约束。
     */
    async designVoices({ endpointId, description, previewText, count } = {}) {
      const text = String(description || '').trim();
      if (text.length < DESIGN_DESCRIPTION_LIMITS.min || text.length > DESIGN_DESCRIPTION_LIMITS.max) {
        return { error: `音色描述需要 ${DESIGN_DESCRIPTION_LIMITS.min}–${DESIGN_DESCRIPTION_LIMITS.max} 个字。` };
      }
      try {
        const endpoint = requireEndpoint(endpointId);
        if (!voiceDesignCapability(endpoint.protocol)) return { error: '这个接口的协议不支持按描述设计声音。' };
        // 先确认样音能落地再发请求，免得扣了额度却拿不到试听。
        if (typeof storeAudio !== 'function') return { error: '试听音频存储不可用。' };
        const candidates = await designCustomVoices({
          getConfig: () => endpoint, fetchImpl, description: text, count,
          previewText: String(previewText || '').trim().slice(0, 500) || DEFAULT_DESIGN_PREVIEW_TEXT,
        });
        if (!candidates.length) return { error: '厂商没有返回任何候选。' };
        return {
          candidates: candidates.map(candidate => ({ generatedId: candidate.generatedId, previewUrl: storeAudio(candidate.audio).url })),
        };
      } catch (error) {
        return { error: error.message, ...(error.code ? { code: error.code } : {}) };
      }
    },
    /** 按伙伴人设起草音色描述；结果只回给设置页，不保存、不直接用于生成。 */
    async draftVoiceDescription({ personId } = {}) {
      const person = getPerson(String(personId || '').trim());
      if (!person) return { error: '没有找到这个伙伴。' };
      if (!String(person.personaDocument || '').trim()) return { error: '这个伙伴还没有人设，没法起草。' };
      try {
        const description = cleanDraft(await askText(voiceDraftPrompt(person), { taskId: 'voice_design_prompt' }));
        if (description.length < DESIGN_DESCRIPTION_LIMITS.min) return { error: '模型没有给出可用的描述，请手写或再试一次。' };
        return { description };
      } catch (error) {
        return { error: `起草失败：${error.message}` };
      }
    },
    /** 设计候选转正（Breeze 保存为私人音色、MiniMax 做一次短合成），返回长期可用的 voice id。 */
    async activateDesignedVoice({ endpointId, generatedId, name, description, model } = {}) {
      const id = String(generatedId || '').trim();
      if (!id) return { error: '缺少要转正的候选 id。' };
      try {
        const endpoint = requireEndpoint(endpointId);
        return await activateCustomDesignedVoice({
          getConfig: () => endpoint, fetchImpl, generatedId: id,
          name: String(name || '').trim(), description: String(description || '').trim(), model,
        });
      } catch (error) {
        return { error: error.message, ...(error.code ? { code: error.code } : {}) };
      }
    },
  };
}

/** 一次性迁移入口；默认用 VoiceDirectory 的静态表回填保留声音的显示名。 */
export function migrateLegacyMinimaxTtsConfig(options = {}) {
  return seedFromLegacyMinimax({
    displayNameForLegacySource: id => LEGACY_NATIVE_DISPLAY_NAMES[id] || null,
    ...options,
  });
}
