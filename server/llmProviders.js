// llmProviders.js — 模型供应商注册表与"使用中"模型。
//
// 用户决策（unified-model-providers）：模型接入是一张注册表，不再是单一 endpoint。
// 持久化在既有 `~/.lunara/config.json`（0600，LUNARA_CONFIG_DIR 约定）：
//   { llm: {...legacy 保留不删}, modelProviders: [...], activeModel: {providerId, model} }
// provider = { id, name, baseUrl, apiKey, api, models[], disabledModels[], enabled,
//              capabilities{}, modelInfo{}, modelDefaults{} }，
// api ∈ ['openai-completions','openai-responses','anthropic-messages','google-generative-ai']。
// `disabledModels` 是 `models` 的子集：保留配置但停用（旧配置缺字段 = 全部启用）。
// `modelInfo[model]` 是发现事实（声明档位/容量/模态），`modelDefaults[model]` 是用户的默认思考档；
// 两者都裁剪到 `models`，旧配置缺字段即空（add-reasoning-effort-controls）。
//
// 安全约定：apiKey 只写不读出（对外一律 hasKey 布尔）；错误与日志不得含 key。
//
// 端点解析链（resolveModelEndpoint）：
//   1. 显式 endpoint 参数（测试/特殊调用）
//   2. 会话覆盖 prefs `model-override:<sessionId>`（provider 被删/禁用、模型被停用时回落）
//   3. 全局 activeModel（provider/模型不可用同样回落）
//   4. legacy llm 三元组（未迁移旧用户）
// 都不可用 → null（调用方按未配置处理）。
// 解析结果附带思考档位事实：`reasoningEfforts`（该模型声明的档位）与 `reasoningEffort`
// （生效档位 = 会话覆盖 > 模型默认 > null）；legacy/显式 endpoint 无信息时为 [] / null。

import { randomUUID } from 'node:crypto';
import { getLLMConfigPath, getLLMConfigDir } from './llmConfig.js';
import { normalizeCapability } from './llmCapabilities.js';
import { readConfigDocument, withConfigLock, writeConfigDocument } from './configLock.js';

export const PROVIDER_APIS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
]);

const EMPTY = Object.freeze({ modelProviders: [], activeModel: null });

/**
 * 能力档案随注册表存储（design §1）：provider.capabilities = { [模型名]: 档案 }。
 * 档案记录来源与探测时间（设置页展示"（2026-10-15 探测）"），值本身经
 * normalizeCapability 校验：坏值回落 unknown，不猜测。
 */
function normalizeCapabilities(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [model, raw] of Object.entries(input)) {
    const name = String(model || '').trim();
    if (!name) continue;
    const capability = normalizeCapability(raw);
    const probedAt = typeof raw?.probedAt === 'string' && !Number.isNaN(Date.parse(raw.probedAt))
      ? new Date(raw.probedAt).toISOString() : null;
    out[name] = { ...capability, probedAt };
  }
  return out;
}

const MAX_REASONING_EFFORTS = 16;
const MAX_EFFORT_LENGTH = 24;
const MAX_MODALITIES = 16;

/** 档位字符串归一：trim 后最多 24 字符；空/非字符串 → null（不猜测）。 */
function normalizeEffort(value) {
  if (typeof value !== 'string') return null;
  const effort = value.trim().slice(0, MAX_EFFORT_LENGTH);
  return effort || null;
}

/** 正整数（容量类字段）→ floor；坏值/非正数 → null。 */
function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/** 字符串数组归一：trim、去空、去重（保留首次出现顺序）；可限制单项长度与项数。 */
function uniqueStringList(value, { maxItems = Infinity, maxLength = Infinity } = {}) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const text = item.trim().slice(0, maxLength);
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

/** 模型事实：键必须是 models 成员；坏字段丢弃；没有有效字段的条目不保留。 */
function normalizeModelInfo(value, models) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const model = String(key || '').trim();
    if (!model || !models.includes(model)) continue;
    const entry = {};
    const reasoningEfforts = uniqueStringList(raw?.reasoningEfforts,
      { maxItems: MAX_REASONING_EFFORTS, maxLength: MAX_EFFORT_LENGTH });
    if (reasoningEfforts.length) entry.reasoningEfforts = reasoningEfforts;
    const contextWindow = positiveIntegerOrNull(raw?.contextWindow);
    if (contextWindow) entry.contextWindow = contextWindow;
    const maxOutputTokens = positiveIntegerOrNull(raw?.maxOutputTokens);
    if (maxOutputTokens) entry.maxOutputTokens = maxOutputTokens;
    const modalities = uniqueStringList(raw?.modalities, { maxItems: MAX_MODALITIES });
    if (modalities.length) entry.modalities = modalities;
    if (Object.keys(entry).length) out[model] = entry;
  }
  return out;
}

/** 用户默认思考档：键必须是 models 成员；没有有效档位的条目不保留。 */
function normalizeModelDefaults(value, models) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [key, raw] of Object.entries(input)) {
    const model = String(key || '').trim();
    if (!model || !models.includes(model)) continue;
    const reasoningEffort = normalizeEffort(raw?.reasoningEffort);
    if (reasoningEffort) out[model] = { reasoningEffort };
  }
  return out;
}

/** 对外视图返回副本：调用方修改不会写回注册表（数组逐项复制）。 */
function cloneModelInfo(modelInfo) {
  const out = {};
  for (const [model, info] of Object.entries(modelInfo || {})) {
    out[model] = {
      ...info,
      ...(Array.isArray(info?.reasoningEfforts) ? { reasoningEfforts: [...info.reasoningEfforts] } : {}),
      ...(Array.isArray(info?.modalities) ? { modalities: [...info.modalities] } : {}),
    };
  }
  return out;
}

function cloneModelDefaults(modelDefaults) {
  return Object.fromEntries(Object.entries(modelDefaults || {})
    .map(([model, value]) => [model, { ...value }]));
}

function normalizeProvider(value = {}) {
  const api = PROVIDER_APIS.includes(value.api) ? value.api : 'openai-completions';
  const models = [...new Set((Array.isArray(value.models) ? value.models : [])
    .map(model => String(model || '').trim()).filter(Boolean))];
  // 停用记录只保留 models 成员：从 models 移除的模型天然同步裁剪，不会留下悬空 id。
  const disabledModels = [...new Set((Array.isArray(value.disabledModels) ? value.disabledModels : [])
    .map(model => String(model || '').trim()).filter(Boolean))]
    .filter(model => models.includes(model));
  return {
    id: String(value.id || '').trim() || `prov-${randomUUID()}`,
    name: String(value.name || '').trim().slice(0, 60),
    baseUrl: String(value.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(value.apiKey || '').trim(),
    api,
    models,
    disabledModels,
    enabled: value.enabled != null ? Boolean(value.enabled) : true,
    capabilities: normalizeCapabilities(value.capabilities),
    modelInfo: normalizeModelInfo(value.modelInfo, models),
    modelDefaults: normalizeModelDefaults(value.modelDefaults, models),
  };
}

/** 模型是否被停用（"可用"还需要 provider enabled 且有 baseUrl，由各调用点自行判断）。 */
function isModelDisabled(provider, model) {
  const name = String(model || '').trim();
  return Boolean(name) && Array.isArray(provider.disabledModels) && provider.disabledModels.includes(name);
}

function normalizeDocument(doc = {}) {
  const modelProviders = (Array.isArray(doc.modelProviders) ? doc.modelProviders : []).map(normalizeProvider);
  let activeModel = doc.activeModel && typeof doc.activeModel === 'object' ? {
    providerId: String(doc.activeModel.providerId || '').trim(),
    model: String(doc.activeModel.model || '').trim(),
  } : null;
  if (activeModel && !modelProviders.some(provider => provider.id === activeModel.providerId)) activeModel = null;
  return { modelProviders, activeModel };
}

// 故障切换策略（harden-native-agent-harness 3.1）：显式、默认关闭、至多两个有序目标。
// 持久在既有 config.json 的 `modelFailover` 键；这里只保存身份（providerId/model）与
// 两个开关，绝不保存 apiKey/baseUrl。跨 provider 需要显式 allowCrossProvider:true。
const MAX_FAILOVER_TARGETS = 2;
// 默认关闭是常态：只缓存"关闭"这一结论 2 秒，避免每次模型调用都读整份配置；
// 启用/保存/读取失败都不走这个短路，目标仍在每次调用时重新校验。
const FAILOVER_DISABLED_TTL_MS = 2_000;
let failoverDisabledCache = null;

function normalizeFailoverTargets(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const providerId = String(raw.providerId || '').trim();
    const model = String(raw.model || '').trim();
    if (!providerId || !model) continue;
    if (out.some(target => target.providerId === providerId && target.model === model)) continue;
    out.push({ providerId, model });
    if (out.length >= MAX_FAILOVER_TARGETS) break;
  }
  return out;
}

function normalizeFailoverPolicy(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    // 只有显式 true 才启用：坏配置/字符串/缺省都回到“不切换”。
    enabled: input.enabled === true,
    allowCrossProvider: input.allowCrossProvider === true,
    targets: normalizeFailoverTargets(input.targets),
  };
}

function cloneFailoverPolicy(policy) {
  return {
    enabled: policy?.enabled === true,
    allowCrossProvider: policy?.allowCrossProvider === true,
    targets: normalizeFailoverTargets(policy?.targets),
  };
}

/**
 * 保存前校验：目标必须是当前注册表里真实存在、启用且有地址的 provider 的启用模型。
 * 这是“保存时的事实校验”，不是运行时授权；provider 之后被停用/删除时由解析器跳过。
 */
function validateFailoverPolicy(patch = {}, providers = []) {
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const rawTargets = input.targets == null ? [] : input.targets;
  if (!Array.isArray(rawTargets)) throw new Error('备用模型列表必须是数组');
  const targets = [];
  const seen = new Set();
  for (const raw of rawTargets) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('备用模型条目格式不正确');
    const providerId = String(raw.providerId || '').trim();
    const model = String(raw.model || '').trim();
    if (!providerId || !model) throw new Error('备用模型需要 providerId 与 model');
    const key = `${providerId}\u0000${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const provider = providers.find(candidate => candidate.id === providerId) || null;
    if (!provider) throw new Error('备用模型引用了不存在的 provider');
    if (!provider.enabled || !provider.baseUrl) throw new Error('备用模型的 provider 未启用或缺少地址');
    if (!provider.models.includes(model)) throw new Error('备用模型不在该 provider 的模型列表中');
    if (isModelDisabled(provider, model)) throw new Error('备用模型已停用');
    targets.push({ providerId, model });
  }
  if (targets.length > MAX_FAILOVER_TARGETS) throw new Error('备用模型最多两个');
  return {
    enabled: input.enabled === true,
    allowCrossProvider: input.allowCrossProvider === true,
    targets,
  };
}

/**
 * 读注册表视图：保留整份文档的原始字段（写入时原样带回，绝不丢别的键——
 * legacy `llm`、未来新增的顶层字段都属于文档而不属于本模块）。
 */
async function readState() {
  const raw = await readConfigDocument(getLLMConfigPath());
  return {
    raw,
    llm: raw.llm || null,
    modelFailover: normalizeFailoverPolicy(raw.modelFailover),
    ...normalizeDocument(raw),
  };
}

/** 锁内写回：只覆盖注册表关心的键，其余顶层字段原样保留。 */
async function commit(raw, { modelProviders, activeModel, modelFailover }) {
  const next = { ...raw, modelProviders, activeModel };
  // 只有显式传入才改写策略；普通 provider/activeModel 写入不碰用户已有策略。
  if (modelFailover !== undefined) next.modelFailover = modelFailover;
  await writeConfigDocument(getLLMConfigPath(), next);
}

/** 幂等迁移：没有注册表但有 legacy llm 三元组 → 生成第一个 provider 并设为使用中。 */
function migrateLegacy(doc) {
  if (doc.modelProviders.length > 0) return doc;
  const legacy = doc.llm && typeof doc.llm === 'object' ? doc.llm : null;
  const baseUrl = String(legacy?.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(legacy?.model || '').trim();
  if (!baseUrl || !model) return { ...doc, modelProviders: [], activeModel: null };
  const provider = normalizeProvider({
    id: 'legacy', name: '默认', baseUrl, apiKey: String(legacy?.apiKey || '').trim(),
    api: 'openai-completions', models: [model], enabled: true,
  });
  return { ...doc, modelProviders: [provider], activeModel: { providerId: provider.id, model } };
}

/** 读取注册表（含 legacy 迁移，不回写：首次保存时自然落盘）。 */
export async function listModelProviders() {
  const doc = migrateLegacy(await readState());
  return doc.modelProviders.map(provider => publicProvider(provider));
}

function publicProvider(provider) {
  const { apiKey, ...rest } = provider;
  const disabledModels = [...(provider.disabledModels || [])];
  return {
    ...rest,
    disabledModels,
    // 事实与偏好都原样返回给设置页，但一律是副本；apiKey 仍只以 hasKey 表示。
    modelInfo: cloneModelInfo(provider.modelInfo),
    modelDefaults: cloneModelDefaults(provider.modelDefaults),
    hasKey: Boolean(apiKey),
    modelCount: provider.models.length,
    enabledModelCount: provider.models.length - disabledModels.length,
  };
}

/**
 * 能力档案的字段级合并（审查缺口修复）：探测结论与运行时观测都会携带**部分事实**，
 * 直接整份替换会把未观测字段（结构化形态、预算旋钮、输出上限）抹成默认值。
 * 显式给出的键（含显式 null）覆盖旧值；未给出的键保持旧值；caps/thinking 逐字段合并。
 */
function mergeCapabilityFields(existing, patch) {
  const base = existing && typeof existing === 'object' ? existing : {};
  const thinking = { ...(base.thinking || {}) };
  for (const [key, value] of Object.entries(patch?.thinking || {})) {
    if (value !== undefined) thinking[key] = value;
  }
  const caps = { ...(base.caps || {}) };
  for (const [key, value] of Object.entries(patch?.caps || {})) {
    if (value !== undefined) caps[key] = value;
  }
  return {
    ...base,
    ...patch,
    family: patch?.family ?? base.family ?? 'unknown',
    protocol: patch?.protocol !== undefined ? patch.protocol : base.protocol ?? null,
    structuredOutput: patch?.structuredOutput !== undefined ? patch.structuredOutput : base.structuredOutput,
    thinking,
    caps,
    price: patch?.price !== undefined ? patch.price : base.price ?? null,
  };
}

/** 创建或更新 provider；apiKey 留空 = 保留旧值。返回 public 视图。 */
export async function saveModelProvider(patch = {}) {
  return withConfigLock(getLLMConfigPath(), async () => {
    const doc = migrateLegacy(await readState());
    const id = String(patch.id || '').trim();
    if (!id) {
      const provider = normalizeProvider(patch);
      doc.modelProviders.push(provider);
      await commit(doc.raw, { modelProviders: doc.modelProviders, activeModel: doc.activeModel });
      return publicProvider(provider);
    }
    const existing = doc.modelProviders.find(candidate => candidate.id === id);
    if (!existing) throw new Error('provider 不存在，不能更新');
    const next = normalizeProvider({
      ...existing,
      ...patch,
      id: existing.id,
      apiKey: String(patch?.apiKey || '').trim() || existing.apiKey,
      models: patch?.models ?? existing.models,
      // patch 未给该字段时沿用旧停用集合；归一化会把已从 models 移除的 id 裁掉。
      disabledModels: patch?.disabledModels !== undefined ? patch.disabledModels : existing.disabledModels,
      // 模型事实与默认档同样字段级沿用：只给其中一个字段时另一个不被空对象覆盖。
      modelInfo: patch?.modelInfo !== undefined ? patch.modelInfo : existing.modelInfo,
      modelDefaults: patch?.modelDefaults !== undefined ? patch.modelDefaults : existing.modelDefaults,
    });
    // 端点协议/地址变了，旧探测结论不再成立：清空档案，后台会重新探测。
    if (next.baseUrl !== existing.baseUrl || next.api !== existing.api) next.capabilities = {};
    // 从模型列表移除的模型不再保留档案（重新勾选会触发一次探测）。
    next.capabilities = Object.fromEntries(
      Object.entries(next.capabilities || {}).filter(([model]) => next.models.includes(model)));
    doc.modelProviders.splice(doc.modelProviders.indexOf(existing), 1, next);
    // provider 被禁用、失去端点、不再提供该模型或模型被停用 → 清除使用中标记（不留悬空引用）。
    const active = doc.activeModel;
    const activeBroken = active && active.providerId === next.id
      && (!next.enabled || !next.baseUrl || !next.models.includes(active.model)
        || isModelDisabled(next, active.model));
    const activeModel = activeBroken ? null : active;
    await commit(doc.raw, { modelProviders: doc.modelProviders, activeModel });
    return publicProvider(next);
  });
}

export async function deleteModelProvider(id) {
  return withConfigLock(getLLMConfigPath(), async () => {
    const doc = migrateLegacy(await readState());
    const before = doc.modelProviders.length;
    doc.modelProviders = doc.modelProviders.filter(provider => provider.id !== id);
    const active = doc.activeModel && doc.activeModel.providerId === id ? null : doc.activeModel;
    await commit(doc.raw, { modelProviders: doc.modelProviders, activeModel: active });
    return { removed: doc.modelProviders.length < before, activeModel: active ? { ...active } : null };
  });
}

export async function setActiveModel({ providerId, model } = {}) {
  return withConfigLock(getLLMConfigPath(), async () => {
    const doc = migrateLegacy(await readState());
    const provider = doc.modelProviders.find(candidate => candidate.id === String(providerId || '').trim());
    if (!provider) throw new Error('provider 不存在，不能设为使用中');
    if (!provider.enabled) throw new Error('provider 已停用，不能设为使用中');
    const normalizedModel = String(model || '').trim();
    if (!normalizedModel) throw new Error('使用中模型不能为空');
    if (isModelDisabled(provider, normalizedModel)) throw new Error('模型已停用，不能设为使用中');
    doc.activeModel = { providerId: provider.id, model: normalizedModel };
    await commit(doc.raw, { modelProviders: doc.modelProviders, activeModel: doc.activeModel });
    return { ...doc.activeModel };
  });
}

export async function getActiveModel() {
  const doc = migrateLegacy(await readState());
  return doc.activeModel ? { ...doc.activeModel } : null;
}

/** 读取故障切换策略（缺省 = 关闭）。返回值只含身份与开关，不含任何凭据/地址。 */
export async function getModelFailoverPolicy() {
  const doc = migrateLegacy(await readState());
  return cloneFailoverPolicy(doc.modelFailover);
}

/** 保存故障切换策略（整体替换、锁内写回）。非法目标在保存时拒绝，不静默截断。 */
export async function saveModelFailoverPolicy(patch = {}) {
  failoverDisabledCache = null;
  return withConfigLock(getLLMConfigPath(), async () => {
    const doc = migrateLegacy(await readState());
    const policy = validateFailoverPolicy(patch, doc.modelProviders);
    await commit(doc.raw, {
      modelProviders: doc.modelProviders,
      activeModel: doc.activeModel,
      modelFailover: policy,
    });
    return cloneFailoverPolicy(policy);
  });
}

/** 读取某 provider/模型的能力档案（含 probedAt）；未登记 → null。 */
export async function getModelCapability({ providerId, model } = {}) {
  const doc = migrateLegacy(await readState());
  const provider = doc.modelProviders.find(candidate => candidate.id === String(providerId || '').trim()) || null;
  if (!provider) return null;
  const record = provider.capabilities?.[String(model || '').trim()];
  return record ? { ...record } : null;
}

/**
 * 保存/合并某 provider/模型的能力档案。来源 `source`：
 *   'user'（用户显式声明，默认）| 'probe'（探测结论）| 'observed'（运行时观测）。
 * 语义（审查缺口修复）：
 *   - 字段级合并：只覆盖显式给出的键，未观测到的字段保持旧值；
 *   - `overwrite:false`（自动探测与运行时观测）不覆盖 `source:'user'` 的档案——
 *     即使探测在用户声明之前开始、之后才提交，也不会静默改写用户的选择；
 *   - 用户显式声明（设置页保存）走默认 overwrite:true。
 */
export async function saveModelCapability({ providerId, model, capability = {}, source = 'user', probedAt = null, overwrite = true } = {}) {
  return withConfigLock(getLLMConfigPath(), async () => {
    const doc = migrateLegacy(await readState());
    const provider = doc.modelProviders.find(candidate => candidate.id === String(providerId || '').trim());
    if (!provider) throw new Error('provider 不存在，不能保存能力档案');
    const name = String(model || '').trim();
    if (!name) throw new Error('能力档案必须绑定具体模型');
    const existing = provider.capabilities?.[name] || null;
    if (!overwrite && existing?.source === 'user') return { ...existing };
    const merged = normalizeCapabilities({
      [name]: { ...mergeCapabilityFields(existing, capability), source,
        probedAt: probedAt || new Date().toISOString() },
    })[name];
    provider.capabilities = { ...(provider.capabilities || {}), [name]: merged };
    await commit(doc.raw, { modelProviders: doc.modelProviders, activeModel: doc.activeModel });
    return { ...merged };
  });
}

/** 删除某模型的能力档案（回到"未识别 = unknown"）。 */
export async function deleteModelCapability({ providerId, model } = {}) {
  return withConfigLock(getLLMConfigPath(), async () => {
    const doc = migrateLegacy(await readState());
    const provider = doc.modelProviders.find(candidate => candidate.id === String(providerId || '').trim());
    if (!provider || !provider.capabilities?.[String(model || '').trim()]) return false;
    delete provider.capabilities[String(model).trim()];
    await commit(doc.raw, { modelProviders: doc.modelProviders, activeModel: doc.activeModel });
    return true;
  });
}

/** 该模型声明的思考档位；没有发现信息 → []（legacy/旧配置不猜测）。 */
function modelReasoningEfforts(provider, model) {
  const efforts = provider?.modelInfo?.[model]?.reasoningEfforts;
  return Array.isArray(efforts) ? [...efforts] : [];
}

/** 该模型的用户默认思考档；没有 → null。 */
function modelDefaultEffort(provider, model) {
  return normalizeEffort(provider?.modelDefaults?.[model]?.reasoningEffort);
}

/**
 * 生效思考档：会话覆盖 > 模型默认 > null。这里只归一字符串（trim/≤24），
 * 不夹紧到声明档位——是否真的可发送由传输层按能力与声明决定。
 */
function effectiveReasoningEffort(provider, model, overrideEffort = null) {
  return normalizeEffort(overrideEffort) ?? modelDefaultEffort(provider, model) ?? null;
}

/** 探测/管理用途：按 providerId + model 解析端点（不依赖"使用中"或会话覆盖）。 */
export async function resolveProviderEndpoint({ providerId, model = null } = {}) {
  const doc = migrateLegacy(await readState());
  const provider = doc.modelProviders.find(candidate => candidate.id === String(providerId || '').trim()
    && candidate.enabled && candidate.baseUrl) || null;
  if (!provider) return null;
  const requested = String(model || '').trim();
  // 显式模型被停用 → 不可用；未指定 → 取第一个启用模型；没有启用模型 → null。
  const name = requested || provider.models.find(candidate => !isModelDisabled(provider, candidate)) || '';
  if (!name || isModelDisabled(provider, name)) return null;
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: name, api: provider.api,
    providerId: provider.id, source: 'provider', capability: provider.capabilities?.[name] || null,
    reasoningEffort: modelDefaultEffort(provider, name),
    reasoningEfforts: modelReasoningEfforts(provider, name) };
}

/**
 * 解析本次调用可用的备用端点（harden-native-agent-harness 3.1/3.2）：
 * - 策略缺省/关闭 → []；
 * - 显式 `options.endpoint` 表示调用方指定了目标，绝不自动套用全局备用列表；
 * - 目标按保存顺序逐个重新校验 provider 启用、地址存在、模型启用（每次调用现读）；
 * - 与主端点相同（provider+model）的条目不重复尝试；
 * - 跨 provider 只有在策略显式 allowCrossProvider:true 时才可用。
 * 返回的端点带既有能力投影（capability/reasoningEffort(s)），可直接作为 chat 的
 * options.endpoint，不再另实现协议。
 */
export async function resolveModelFailoverTargets(primary = null, options = {}) {
  if (!primary?.baseUrl || !primary?.model) return [];
  if (options?.endpoint) return [];
  const configPath = getLLMConfigPath();
  const cached = failoverDisabledCache;
  if (cached && cached.path === configPath && Date.now() - cached.at < FAILOVER_DISABLED_TTL_MS) return [];
  const doc = migrateLegacy(await readState());
  const policy = doc.modelFailover;
  if (!policy.enabled) {
    failoverDisabledCache = { path: configPath, at: Date.now() };
    return [];
  }
  failoverDisabledCache = null;
  const targets = [];
  for (const target of policy.targets) {
    const provider = doc.modelProviders.find(candidate => candidate.id === target.providerId
      && candidate.enabled && candidate.baseUrl) || null;
    if (!provider || !provider.models.includes(target.model) || isModelDisabled(provider, target.model)) continue;
    if (primary.providerId && provider.id === primary.providerId && target.model === primary.model) continue;
    const sameProvider = Boolean(primary.providerId) && provider.id === primary.providerId;
    if (!sameProvider && !policy.allowCrossProvider) continue;
    // 即使 provider 身份不同（例如 legacy 主端点没有 providerId），也不要把同一实际
    // 端点（baseUrl + api + model）当成备用再请求一次。
    const primaryApi = primary.api || 'openai-completions';
    if (provider.baseUrl === primary.baseUrl && provider.api === primaryApi && target.model === primary.model) continue;
    targets.push({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: target.model,
      api: provider.api,
      providerId: provider.id,
      source: 'provider',
      capability: provider.capabilities?.[target.model] || null,
      reasoningEffort: modelDefaultEffort(provider, target.model),
      reasoningEfforts: modelReasoningEfforts(provider, target.model),
    });
    if (targets.length >= MAX_FAILOVER_TARGETS) break;
  }
  return targets;
}

/** 会话覆盖：prefs 键 `model-override:<sessionId>`；存 null/空 = 清除。由调用方注入 get/set。 */
export function createSessionModelOverrides({ getPref, setPref } = {}) {
  const key = sessionId => `model-override:${String(sessionId || '').trim()}`;
  return {
    async get(sessionId) {
      const raw = getPref?.(key(sessionId));
      if (!raw) return null;
      try {
        const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
        return parsed && parsed.providerId && parsed.model ? { ...parsed } : null;
      } catch { return null; }
    },
    async set(sessionId, override) {
      let normalized = null;
      if (override && override.providerId && override.model) {
        // 缺省/null/空/非字符串档位 = 跟随模型默认：不写该字段。
        const reasoningEffort = normalizeEffort(override.reasoningEffort);
        normalized = {
          providerId: String(override.providerId),
          model: String(override.model),
          ...(reasoningEffort ? { reasoningEffort } : {}),
        };
      }
      setPref?.(key(sessionId), normalized ? JSON.stringify(normalized) : '');
      return normalized;
    },
  };
}

/**
 * 解析生效端点：显式 endpoint → 会话覆盖（provider 消失/禁用时回落）→ activeModel → legacy。
 * 返回 { baseUrl, apiKey, model, api, source, reasoningEffort, reasoningEfforts }；不可用 → null。
 */
export async function resolveModelEndpoint({ endpoint = null, sessionId = null, overrides = null } = {}) {
  if (endpoint && endpoint.baseUrl && endpoint.model) {
    // 显式 endpoint 不查注册表：调用方给了档位就透传，否则如实 null/[]（不猜测）。
    return {
      ...endpoint,
      source: 'explicit',
      reasoningEffort: normalizeEffort(endpoint.reasoningEffort),
      reasoningEfforts: Array.isArray(endpoint.reasoningEfforts) ? [...endpoint.reasoningEfforts] : [],
    };
  }
  const doc = migrateLegacy(await readState());
  const byId = id => doc.modelProviders.find(provider => provider.id === id && provider.enabled
    && provider.baseUrl) || null;

  if (sessionId && overrides) {
    const override = await overrides.get(sessionId);
    if (override) {
      const provider = byId(override.providerId);
      if (provider && !isModelDisabled(provider, override.model)) {
        return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: override.model,
          api: provider.api, source: 'session', providerId: provider.id,
          capability: provider.capabilities?.[override.model] || null,
          reasoningEffort: effectiveReasoningEffort(provider, override.model, override.reasoningEffort),
          reasoningEfforts: modelReasoningEfforts(provider, override.model) };
      }
      // 覆盖指向的 provider 消失/停用或模型已停用：如实回落全局，不报错。
    }
  }

  if (doc.activeModel) {
    const provider = byId(doc.activeModel.providerId);
    if (provider && !isModelDisabled(provider, doc.activeModel.model)) {
      return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: doc.activeModel.model,
        api: provider.api, source: 'active', providerId: provider.id,
        capability: provider.capabilities?.[doc.activeModel.model] || null,
        reasoningEffort: modelDefaultEffort(provider, doc.activeModel.model),
        reasoningEfforts: modelReasoningEfforts(provider, doc.activeModel.model) };
    }
  }

  const legacy = doc.llm && typeof doc.llm === 'object' ? doc.llm : null;
  const baseUrl = String(legacy?.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(legacy?.model || '').trim();
  if (baseUrl && model) {
    return { baseUrl, apiKey: String(legacy?.apiKey || '').trim(), model,
      api: 'openai-completions', source: 'legacy',
      reasoningEffort: null, reasoningEfforts: [] };
  }
  return null;
}

export function publicRegistry(doc) {
  return {
    providers: doc.modelProviders.map(publicProvider),
    activeModel: doc.activeModel ? { ...doc.activeModel } : null,
  };
}

export { getLLMConfigDir };
