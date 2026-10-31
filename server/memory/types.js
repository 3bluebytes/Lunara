// types.js — Memory system type definitions, factory, and validation
//
// v2 architecture（memory-system-v2 change）:
//   ✅ WORKING / EPISODIC / SEMANTIC / LIFE_STATE — the 4 valid types
//   ❌ PERSONA / EPISODE / USER_PREFERENCE / INTERACTION — DEPRECATED, store will reject on insert
//
// 旧枚举值仍然导出（避免立刻打断老代码 import），但写入路径会被 MemoryStore._validateType 拦截。
// 检索路径仍可以查询老数据（如果 DB 里还有），但新写入必须用 v2 的 4 种类型。
// 长期目标：所有 callsite 迁完后这些 deprecated 字段可彻底移除。

// ===================== Enums =====================

/** @enum {string} */
export const MemoryType = Object.freeze({
  WORKING: 'working',
  EPISODIC: 'episodic',
  SEMANTIC: 'semantic',
  LIFE_STATE: 'life_state',
  // ↓↓↓ DEPRECATED in v2，store 写入时会抛错。仅保留以便老 import 不立即 break。
  PERSONA: 'persona',
  EPISODE: 'episode',
  USER_PREFERENCE: 'user_preference',
  INTERACTION: 'interaction',
});

/** v2 only — 检查 enum 字面值是否还在白名单内 */
export const V2_VALID_TYPES = Object.freeze(new Set(['working', 'episodic', 'semantic', 'life_state']));
export const V2_DEPRECATED_TYPES = Object.freeze(new Set(['persona', 'episode', 'user_preference', 'interaction']));

/** @enum {string} */
export const MemorySource = Object.freeze({
  USER_EXPLICIT_FEEDBACK: 'user_explicit_feedback',
  USER_TEMPORARY_REQUEST: 'user_temporary_request',
  BEHAVIOR_OBSERVATION: 'behavior_observation',
  AGENT_REFLECTION: 'agent_reflection',
  CONSOLIDATION: 'consolidation',
  MANUAL_SEED: 'manual_seed',
  STATION_SEED: 'station_seed',
});

/** Default namespace */
export const DEFAULT_NAMESPACE = 'station';

/**
 * Derive a radiohost namespace from the radiohost registry id.
 * @param {string} radiohostId
 * @returns {string}
 */
export function radiohostNamespace(radiohostId) {
  return `radiohost:${radiohostId}`;
}

// Valid sets for validation
const VALID_TYPES = new Set(Object.values(MemoryType));
const VALID_SOURCES = new Set(Object.values(MemorySource));

// ===================== Defaults =====================

export const IMPORTANCE_DEFAULTS = Object.freeze({
  [MemoryType.WORKING]: 3,
  [MemoryType.EPISODIC]: 5,
  [MemoryType.SEMANTIC]: 7,
  [MemoryType.PERSONA]: 9,
  [MemoryType.LIFE_STATE]: 6,
  [MemoryType.EPISODE]: 7,
  [MemoryType.USER_PREFERENCE]: 8,
  [MemoryType.INTERACTION]: 5,
});

export const SOURCE_CONFIDENCE_CAPS = Object.freeze({
  [MemorySource.BEHAVIOR_OBSERVATION]: 0.4,
  [MemorySource.USER_EXPLICIT_FEEDBACK]: 0.7,
  [MemorySource.USER_TEMPORARY_REQUEST]: 0.5,
  // AGENT_REFLECTION 上调到 0.7（add-reflection-layer change）。
  // 原 0.3 是给"agent 单方面臆测"留的天花板；新的 ReflectionAgent 吃 skip/completed
  // 真实信号，地基有 ground truth，由 ReflectionAgent 自己按 window 截顶
  // （短窗 0.4 / 长窗 0.7）。其它 AGENT_REFLECTION 写入方原本就传 0.5-0.8 的
  // 自报值，从「被强制压到 0.3」变成「按自报值在 0.7 内保留」，更如实反映该模块的判断。
  [MemorySource.AGENT_REFLECTION]: 0.7,
  [MemorySource.CONSOLIDATION]: 0.6,
  [MemorySource.MANUAL_SEED]: 1.0,
  [MemorySource.STATION_SEED]: 0.7,
});

/** Working memory default TTL: 24 hours */
const WORKING_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

// ===================== Factory =====================

/**
 * Create a validated MemoryRecord object.
 *
 * @param {MemoryType} type
 * @param {object} data
 * @param {string} data.content - Main memory content
 * @param {MemorySource} data.source - How this memory was created
 * @param {string} [data.summary] - Optional short summary
 * @param {string[]} [data.tags] - Optional tags for search
 * @param {number} [data.importance] - 0-10, defaults per type
 * @param {number} [data.confidence] - 0.0-1.0, defaults per source
 * @param {string} [data.evidence] - JSON-serialized source materials
 * @param {number} [data.expiresAt] - Optional epoch ms expiry (auto-set for working)
 * @returns {object} Validated MemoryRecord ready for storage
 */
export function createMemoryRecord(type, data) {
  if (!data || !data.content) {
    throw new Error('MemoryRecord requires content');
  }

  const rec = {
    namespace: data.namespace || DEFAULT_NAMESPACE,
    type: validateType(type),
    content: String(data.content),
    summary: data.summary ? String(data.summary).slice(0, 200) : '',
    tags: Array.isArray(data.tags) ? data.tags.join(',') : (typeof data.tags === 'string' ? data.tags : ''),
    importance: data.importance != null ? validateImportance(data.importance) : IMPORTANCE_DEFAULTS[type] ?? 5,
    confidence: data.confidence != null ? validateConfidence(data.confidence) : getDefaultConfidence(data.source),
    source: validateSource(data.source || MemorySource.AGENT_REFLECTION),
    evidence: data.evidence ? String(data.evidence) : '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    expiresAt: null,
    accessCount: 0,
    version: 1,
    // v2 encoding-specificity fields（memory-system-v2 change）—— passthrough
    mood_at_creation:    data.mood_at_creation    ?? data.moodAtCreation    ?? null,
    time_bucket:         data.time_bucket         ?? data.timeBucket         ?? null,
    day_of_week:         data.day_of_week         ?? data.dayOfWeek          ?? null,
    weather_at_creation: data.weather_at_creation ?? data.weatherAtCreation ?? null,
    session_id:          data.session_id          ?? data.sessionId          ?? null,
    last_activated_at:   data.last_activated_at   ?? data.lastActivatedAt   ?? null,
  };

  // Apply source confidence cap
  const cap = SOURCE_CONFIDENCE_CAPS[rec.source];
  if (cap != null && rec.confidence > cap) {
    rec.confidence = cap;
  }

  // Working memory gets auto-expiry
  if (type === MemoryType.WORKING && !data.expiresAt) {
    rec.expiresAt = Date.now() + WORKING_MEMORY_TTL_MS;
  } else if (data.expiresAt != null) {
    rec.expiresAt = Number(data.expiresAt);
  }

  // Persona memory never expires
  if (type === MemoryType.PERSONA) {
    rec.expiresAt = null;
  }

  return rec;
}

function getDefaultConfidence(source) {
  return SOURCE_CONFIDENCE_CAPS[source] ?? 0.5;
}

// ===================== Validation =====================

export function validateType(type) {
  if (!VALID_TYPES.has(type)) {
    throw new Error(`Invalid memory type: ${type}. Must be one of: ${Object.values(MemoryType).join(', ')}`);
  }
  return type;
}

export function validateSource(source) {
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`Invalid memory source: ${source}. Must be one of: ${Object.values(MemorySource).join(', ')}`);
  }
  return source;
}

export function validateImportance(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 10 || !Number.isInteger(n)) {
    throw new Error(`Importance must be an integer 0-10, got ${v}`);
  }
  return n;
}

export function validateConfidence(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`Confidence must be a number 0.0-1.0, got ${v}`);
  }
  return n;
}

// ===================== Helpers =====================

/** Simple token overlap similarity (0.0 - 1.0) */
export function contentSimilarity(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  const overlap = tokensA.filter(t => setB.has(t)).length;
  return overlap / Math.max(tokensA.length, tokensB.length);
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w一-鿿]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Check if two tag strings share at least `minOverlap` tags */
export function tagOverlap(tagsA, tagsB, minOverlap = 2) {
  const a = parseTags(tagsA);
  const b = parseTags(tagsB);
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const overlap = a.filter(t => setB.has(t)).length;
  return overlap;
}

export function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}
