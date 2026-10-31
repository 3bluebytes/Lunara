// ttsCustomConfig.js — 自定义 TTS 接口的用户配置（多接口 + 统一声音池）。
//
// version 2 结构：
//   endpoints[]  { id, name, protocol(openai|minimax|breeze|recipe), baseUrl, apiKey, model,
//                  recipe?, presetId? }   ← recipe 协议才有：声明式请求配方与来源预设
//   voices[]     { profileId, endpointId, sourceVoiceId, displayName, model? }
// 每个接口在 tts.js 里注册为 id 相同的 provider；每把保留声音记住自己属于哪个接口、
// 用哪个 model，合成时按声音的记录去请求对应接口。旧的单接口文件读取时迁移成
// id=custom 的那个接口，第一次保存才写出新格式。
// 持久化到 `~/.lunara/tts-custom.json`（0600，目录复用 LUNARA_CONFIG_DIR 解析约定）。
//
// 安全约定：apiKey 只写不读出（对外只给 hasKey 布尔）；任何错误与日志
// 都不得包含 key。content 内除声音列表外不做任何结构承诺。
//
// 一次性迁移：`seedFromLegacyMinimax` 把旧 MiniMax 环境变量与已存的声音
// 选择按新接口格式填入（幂等：配置文件已存在即跳过）。协议默认 openai，
// 官方 MiniMax 端点需在设置里显式切到 minimax 协议才能合成/拉取声音。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getLLMConfigDir } from './llmConfig.js';
import { validateRecipe } from './tts/providers/protocols/recipe.js';

const CONFIG_FILE = 'tts-custom.json';
const CONFIG_VERSION = 2;

export const CUSTOM_TTS_PROTOCOLS = Object.freeze(['openai', 'minimax', 'breeze', 'recipe']);
const PROTOCOL_NAMES = Object.freeze({ openai: 'OpenAI 兼容', minimax: 'MiniMax', breeze: 'Breeze', recipe: '配方接口' });
const PRESET_ID_PATTERN = /^[a-z0-9-]{1,40}$/;

/** 迁移来的旧单接口固定用这个 id：旧缓存键与旧声音身份都以它为前缀。 */
export const LEGACY_ENDPOINT_ID = 'custom';
const ENDPOINT_ID_PATTERN = /^custom(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;
const PROFILE_ID_PATTERN = /^vp_cx_[0-9a-f]{8}$/;
/** 内置免费声音（Edge 朗读）的接口 id：声音池可以保留它的声音，但它不是一条可编辑的接口。 */
const FREE_VOICE_ENDPOINT_ID = 'free-edge';
const poolEndpointIds = endpoints => new Set([...endpoints.map(endpoint => endpoint.id), FREE_VOICE_ENDPOINT_ID]);

function configPath() {
  return join(getLLMConfigDir(), CONFIG_FILE);
}

function emptyConfig() {
  return { version: CONFIG_VERSION, endpoints: [], voices: [], migratedFromMinimax: false };
}

/**
 * 保留声音的稳定身份。旧接口（custom）沿用旧算法，只哈希源 voice id，
 * 已落库的伙伴绑定因此不变；其他接口把接口 id 一起哈希，不同接口的同名 voice 不撞车。
 */
export function customVoiceProfileId(endpointId, sourceVoiceId) {
  const seed = endpointId === LEGACY_ENDPOINT_ID ? sourceVoiceId : `${endpointId}:${sourceVoiceId}`;
  return `vp_cx_${createHash('sha1').update(seed).digest('hex').slice(0, 8)}`;
}

function normalizeEndpoint(endpoint) {
  const protocol = String(endpoint?.protocol || '').trim();
  const normalizedProtocol = CUSTOM_TTS_PROTOCOLS.includes(protocol) ? protocol : 'openai';
  return {
    id: String(endpoint?.id || '').trim(),
    name: String(endpoint?.name || '').trim().slice(0, 40) || PROTOCOL_NAMES[normalizedProtocol],
    protocol: normalizedProtocol,
    baseUrl: String(endpoint?.baseUrl || '').trim(),
    apiKey: String(endpoint?.apiKey || '').trim(),
    model: String(endpoint?.model || '').trim(),
    // 配方原样保存（读写时都不在这里拒绝）：校验不过的接口在合成时按不可用处理，
    // 对外视图给出 recipeError 说明原因。保存前的校验和试合成门槛在 ttsCustomService。
    ...(normalizedProtocol === 'recipe' && endpoint?.recipe && typeof endpoint.recipe === 'object'
      ? { recipe: JSON.parse(JSON.stringify(endpoint.recipe)) } : {}),
    ...(normalizedProtocol === 'recipe' && PRESET_ID_PATTERN.test(String(endpoint?.presetId || ''))
      ? { presetId: String(endpoint.presetId) } : {}),
  };
}

/** 配方接口的校验结果：合法为 null，否则为给人看的原因。 */
export function recipeProblem(endpoint) {
  if (endpoint?.protocol !== 'recipe') return null;
  try {
    validateRecipe(endpoint.recipe);
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * 声音池规范化：按 (endpointId, sourceVoiceId) 去重，丢弃指向不存在接口的声音。
 * profileId 只采信 `known`（已落盘的身份）里的值，否则按规则派生——客户端不能指定身份。
 */
function normalizeVoices(voices, endpointIds, known = new Map()) {
  if (!Array.isArray(voices)) return [];
  const seen = new Set();
  const profiles = new Set();
  const result = [];
  for (const voice of voices) {
    const endpointId = String(voice?.endpointId || LEGACY_ENDPOINT_ID).trim();
    const sourceVoiceId = String(voice?.sourceVoiceId ?? voice?.id ?? '').trim();
    const key = `${endpointId}::${sourceVoiceId}`;
    if (!sourceVoiceId || !endpointIds.has(endpointId) || seen.has(key)) continue;
    const profileId = known.get(key) || customVoiceProfileId(endpointId, sourceVoiceId);
    if (profiles.has(profileId)) continue;
    seen.add(key);
    profiles.add(profileId);
    result.push({
      profileId,
      endpointId,
      sourceVoiceId,
      displayName: String(voice?.displayName || '').trim() || sourceVoiceId,
      ...(voice?.model ? { model: String(voice.model).trim() } : {}),
    });
  }
  return result;
}

/** 文件里已落盘的身份（只从磁盘内容读取，格式不合法的忽略）。 */
function persistedProfileIds(voices) {
  const known = new Map();
  for (const voice of Array.isArray(voices) ? voices : []) {
    const endpointId = String(voice?.endpointId || LEGACY_ENDPOINT_ID).trim();
    const sourceVoiceId = String(voice?.sourceVoiceId || '').trim();
    const profileId = String(voice?.profileId || '').trim();
    if (sourceVoiceId && PROFILE_ID_PATTERN.test(profileId)) known.set(`${endpointId}::${sourceVoiceId}`, profileId);
  }
  return known;
}

/** 读文件内容 → version 2。旧单接口文件原样成为 id=custom 的接口。 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return emptyConfig();
  const legacy = !Array.isArray(raw.endpoints);
  const rawEndpoints = legacy
    ? ((raw.baseUrl || raw.apiKey || raw.model || raw.protocol || (raw.voices || []).length)
      ? [{ ...raw, id: LEGACY_ENDPOINT_ID, name: '' }] : [])
    : raw.endpoints;
  const endpoints = [];
  for (const item of rawEndpoints) {
    const endpoint = normalizeEndpoint(item);
    if (!ENDPOINT_ID_PATTERN.test(endpoint.id) || endpoints.some(existing => existing.id === endpoint.id)) continue;
    endpoints.push(endpoint);
  }
  return {
    version: CONFIG_VERSION,
    endpoints,
    voices: normalizeVoices(raw.voices, poolEndpointIds(endpoints), persistedProfileIds(raw.voices)),
    migratedFromMinimax: Boolean(raw.migratedFromMinimax),
  };
}

let _cache = null;

export function readCustomTtsConfig() {
  if (_cache) return _cache;
  try {
    _cache = sanitize(JSON.parse(readFileSync(configPath(), 'utf8')));
  } catch {
    _cache = emptyConfig();
  }
  return _cache;
}

/** 某个接口的连接信息，附带它名下的保留声音；不存在返回 null。 */
export function getCustomTtsEndpoint(endpointId) {
  const config = readCustomTtsConfig();
  const endpoint = config.endpoints.find(item => item.id === String(endpointId || '').trim());
  if (!endpoint) return null;
  return { ...endpoint, voices: config.voices.filter(voice => voice.endpointId === endpoint.id) };
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

function generateEndpointId(endpoint, taken) {
  const base = `custom-${slugify(endpoint.name) || endpoint.protocol}`;
  let id = base;
  for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`;
  return id;
}

/**
 * 保存：`endpoint` 按 id 更新已有接口（apiKey 留空保留旧值），id 缺失或不存在则新建；
 * `voices` 给出时整体替换声音池。返回新配置与本次保存的接口 id。
 */
export function saveCustomTtsConfig({ endpoint = null, voices } = {}) {
  const current = readCustomTtsConfig();
  const endpoints = current.endpoints.map(item => ({ ...item }));
  let savedEndpointId = null;
  if (endpoint && typeof endpoint === 'object') {
    const requestedId = String(endpoint.id || '').trim();
    const index = endpoints.findIndex(item => item.id === requestedId);
    if (index >= 0) {
      const previous = endpoints[index];
      // 换成别的协议时不留旧配方。
      const { recipe: previousRecipe, presetId: previousPreset, ...previousRest } = previous;
      const keepRecipe = (endpoint.protocol ?? previous.protocol) === 'recipe';
      endpoints[index] = normalizeEndpoint({
        ...previousRest,
        ...(keepRecipe && previousRecipe ? { recipe: previousRecipe } : {}),
        ...(keepRecipe && previousPreset ? { presetId: previousPreset } : {}),
        ...endpoint,
        id: previous.id,
        apiKey: String(endpoint.apiKey || '').trim() || previous.apiKey,
      });
      savedEndpointId = previous.id;
    } else {
      const created = normalizeEndpoint({ ...endpoint, id: '' });
      // 第一个接口可以显式用 custom（与旧单接口一致）；其他 id 一律由服务端生成。
      created.id = requestedId === LEGACY_ENDPOINT_ID
        ? LEGACY_ENDPOINT_ID
        : generateEndpointId(created, new Set(endpoints.map(item => item.id)));
      endpoints.push(created);
      savedEndpointId = created.id;
    }
  }
  const endpointIds = poolEndpointIds(endpoints);
  const known = new Map(current.voices.map(voice => [`${voice.endpointId}::${voice.sourceVoiceId}`, voice.profileId]));
  const next = {
    version: CONFIG_VERSION,
    endpoints,
    voices: normalizeVoices(voices ?? current.voices, endpointIds, known),
    migratedFromMinimax: current.migratedFromMinimax,
  };
  writeConfig(next);
  return { ...next, savedEndpointId };
}

/** 删除接口及其名下的保留声音。 */
export function removeCustomTtsEndpoint(endpointId) {
  const current = readCustomTtsConfig();
  const id = String(endpointId || '').trim();
  if (!current.endpoints.some(item => item.id === id)) return { removed: false, removedVoices: 0, config: current };
  const voices = current.voices.filter(voice => voice.endpointId !== id);
  const next = { ...current, endpoints: current.endpoints.filter(item => item.id !== id), voices };
  writeConfig(next);
  return { removed: true, removedVoices: current.voices.length - voices.length, config: next };
}

function writeConfig(config) {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  rmSync(path, { force: true });
  renameSync(temp, path);
  _cache = config;
}

const endpointConfigured = endpoint => Boolean(endpoint.baseUrl && endpoint.apiKey) && !recipeProblem(endpoint);

/** 对外视图：永不包含 apiKey，只给 hasKey。 */
export function publicCustomTtsConfig() {
  const config = readCustomTtsConfig();
  return {
    endpoints: config.endpoints.map(endpoint => ({
      id: endpoint.id,
      name: endpoint.name,
      protocol: endpoint.protocol,
      baseUrl: endpoint.baseUrl,
      model: endpoint.model,
      hasKey: Boolean(endpoint.apiKey),
      configured: endpointConfigured(endpoint),
      ...(endpoint.protocol === 'recipe'
        ? { recipe: endpoint.recipe || null, presetId: endpoint.presetId || null, recipeError: recipeProblem(endpoint) }
        : {}),
    })),
    voices: config.voices.map(voice => ({ ...voice })),
    migratedFromMinimax: config.migratedFromMinimax,
  };
}

export function customTtsConfigured() {
  return readCustomTtsConfig().endpoints.some(endpointConfigured);
}

/**
 * 一次性迁移：旧 MiniMax 环境变量 + 已存的声音选择 → 新自定义接口配置。
 * 配置文件已存在即跳过（幂等）。声音集合 = MINIMAX_VOICE_ID ∪ 全局 voice
 * 偏好 ∪ collectLegacyVoiceSelections()（角色绑定的原生声线），显示名经
 * displayNameForLegacySource 回填，拿不到就用源 id——绝不编造。
 */
export function seedFromLegacyMinimax({
  env = process.env,
  state = null,
  collectLegacyVoiceSelections = () => [],
  displayNameForLegacySource = () => null,
  logger = console,
} = {}) {
  if (readCustomTtsConfig().migratedFromMinimax) return { seeded: false, reason: 'already-migrated' };
  const legacyBaseUrl = String(env.MINIMAX_BASE_URL || '').trim();
  const legacyApiKey = String(env.MINIMAX_API_KEY || '').trim();
  const legacyModel = String(env.MINIMAX_MODEL || '').trim();
  const legacyVoiceId = String(env.MINIMAX_VOICE_ID || '').trim();

  const selections = new Set();
  const savedSettings = state?.getPref?.('settings');
  let savedVoice = '';
  try {
    const parsed = typeof savedSettings === 'string' ? JSON.parse(savedSettings || '{}') : savedSettings;
    savedVoice = String(parsed?.voice || '').trim();
  } catch { }
  for (const id of [legacyVoiceId, savedVoice]) {
    if (id) selections.add(id);
  }
  for (const id of collectLegacyVoiceSelections() || []) {
    const value = String(id || '').trim();
    if (value) selections.add(value);
  }
  const seeded = sanitize({
    endpoints: [{
      id: LEGACY_ENDPOINT_ID,
      // 旧链路本来就是 MiniMax 协议，迁移如实标记，否则官方端点既拉不到
      // 声音列表也无法合成。
      protocol: 'minimax',
      baseUrl: legacyBaseUrl,
      apiKey: legacyApiKey,
      model: legacyModel,
    }],
    voices: [...selections].map(sourceVoiceId => ({
      endpointId: LEGACY_ENDPOINT_ID,
      sourceVoiceId,
      displayName: displayNameForLegacySource(sourceVoiceId) || sourceVoiceId,
    })),
    migratedFromMinimax: true,
  });
  writeConfig(seeded);
  logger?.log?.(`[tts] custom endpoint config seeded from legacy minimax values (${seeded.voices.length} kept voices, key ${legacyApiKey ? 'present' : 'absent'})`);
  return { seeded: true, voices: seeded.voices.length };
}

/** 仅供测试：清空模块级缓存。 */
export function resetCustomTtsConfigForTest() {
  _cache = null;
}
