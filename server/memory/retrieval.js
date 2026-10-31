// retrieval.js — v2: 统一检索入口（memory-system-v2 change）
//
// 供角色上下文与检索评估复用。三阶段：
//   1. Primary 命中：BM25（FTS5）或 tag/type 过滤
//   2. State-dependent boost：当前 mood / time_bucket / day_of_week 匹配加权
//   3. Spreading activation：跟 primary 共享 ≥ 2 个 tag 的 secondary 入选（权重 0.5）
//
// 返回后批量 UPDATE last_activated_at（让未来的 spreading 能感知"最近用过的"）。

import { parseTags } from './types.js';

// Score boosts —— 后续可调
const BOOST_MOOD = 0.3;
const BOOST_TIME_BUCKET = 0.2;
const BOOST_DAY_OF_WEEK = 0.1;
const PENALTY_OLDER_30D = 0.1;
const SECONDARY_MULTIPLIER = 0.5;
const PRIMARY_FETCH_LIMIT = 50;   // SQL 拉的最大数，再做评分排序
const SECONDARY_FETCH_LIMIT = 30; // spreading 的上限

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 统一检索入口。
 *
 * @param {object} memoryService - MemoryService 实例（必须有 .store, .namespace）
 * @param {object} options
 * @param {string} options.namespace - 强制必填，避免误检索别人的 namespace
 * @param {string} [options.type] - 'working' | 'episodic' | 'semantic' | 'life_state'
 * @param {string} [options.query] - 自由文本，走 BM25（trigram tokenizer 需 ≥ 3 chars）
 * @param {string} [options.currentMood]
 * @param {string} [options.currentTimeBucket]
 * @param {number} [options.currentDayOfWeek]
 * @param {string[]} [options.tagsAny] - 任意一个 tag 命中即可
 * @param {string[]} [options.tagsAll] - 必须全部命中
 * @param {string[]} [options.excludeTags] - 任一 tag 在排除列表里就剔除
 * @param {number} [options.topK=5]
 * @param {boolean} [options.enableSpreading=true]
 * @returns {object[]}
 */
export function retrieveForPrompt(memoryService, options = {}) {
  const {
    namespace,
    type,
    query,
    currentMood,
    currentTimeBucket,
    currentDayOfWeek,
    tagsAny,
    tagsAll,
    excludeTags,
    topK = 5,
    enableSpreading = true,
  } = options;

  if (!memoryService || !memoryService.store) return [];
  if (!namespace) return [];

  const store = memoryService.store;
  const db = store.db;

  // ===== Step 1: primary hit =====
  let primary = [];
  if (query && store._ftsAvailable && String(query).trim().length >= 3) {
    // BM25 via FTS5
    primary = _bm25Primary(db, namespace, query, type, PRIMARY_FETCH_LIMIT);
  } else {
    // 退化：按 type / tag 过滤
    primary = store.search({
      namespace,
      type,
      tags: tagsAny ? tagsAny.join(',') : (tagsAll ? tagsAll.join(',') : undefined),
      query,
      limit: PRIMARY_FETCH_LIMIT,
    });
    // 给一个保底 base_relevance（越新越高，归一化到 [0, 1]）
    primary.forEach(r => { r._base = _recencyBase(r); });
  }

  // 应用 tagsAll / excludeTags 过滤
  primary = _applyTagFilters(primary, { tagsAll, excludeTags });

  // ===== Step 2: state-dependent boost =====
  primary.forEach(r => {
    r._score = (r._base ?? _recencyBase(r))
      + _stateBoost(r, { currentMood, currentTimeBucket, currentDayOfWeek });
  });

  // ===== Step 3: spreading activation =====
  let combined = [...primary];
  if (enableSpreading && primary.length > 0) {
    const primaryIds = new Set(primary.map(r => r.id));
    const primaryTagSet = _collectTags(primary);
    const secondary = _spreadingSecondary(store, namespace, primaryIds, primaryTagSet, type, SECONDARY_FETCH_LIMIT);
    const filteredSecondary = _applyTagFilters(secondary, { excludeTags });
    filteredSecondary.forEach(r => {
      r._score = (_recencyBase(r) + _stateBoost(r, { currentMood, currentTimeBucket, currentDayOfWeek })) * SECONDARY_MULTIPLIER;
    });
    combined = [...primary, ...filteredSecondary];
  }

  // ===== Step 4: sort + top-K =====
  combined.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  const final = combined.slice(0, topK);

  // ===== Step 5: 更新 last_activated_at（batch）=====
  if (final.length > 0) {
    const now = Date.now();
    const ids = final.map(r => r.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE memories SET last_activated_at = ? WHERE id IN (${placeholders})`).run(now, ...ids);
  }

  return final;
}

// ===== Helpers =====

function _bm25Primary(db, namespace, query, type, limit) {
  // FTS5 query: 用 MATCH，BM25 rank 越小越相关；归一化到 [0, 1]
  const sql = `
    SELECT m.*, bm25(memories_fts) AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.namespace = ?
      ${type ? 'AND m.type = ?' : ''}
      AND (m.expires_at IS NULL OR m.expires_at > ?)
    ORDER BY rank
    LIMIT ?
  `;
  const params = [query, namespace];
  if (type) params.push(type);
  params.push(Date.now(), limit);
  let rows;
  try {
    rows = db.prepare(sql).all(...params);
  } catch {
    return [];
  }
  if (!rows.length) return [];
  // bm25 越小越相关 → 反转到 [0, 1]：用 1 / (1 + |rank|)
  return rows.map(r => {
    const rec = store_rowToRecord(r);
    rec._base = 1 / (1 + Math.abs(r.rank || 0));
    return rec;
  });
}

function _recencyBase(record) {
  const ageMs = Date.now() - (record.createdAt || record.created_at || 0);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  // 一个月之内基本满分，之后慢慢掉
  return Math.max(0, Math.min(1, 1 - ageDays / 90));
}

function _stateBoost(record, { currentMood, currentTimeBucket, currentDayOfWeek }) {
  let boost = 0;
  if (currentMood && record.mood_at_creation === currentMood) boost += BOOST_MOOD;
  if (currentTimeBucket && record.time_bucket === currentTimeBucket) boost += BOOST_TIME_BUCKET;
  if (currentDayOfWeek != null && record.day_of_week === currentDayOfWeek) boost += BOOST_DAY_OF_WEEK;
  const ageMs = Date.now() - (record.createdAt || record.created_at || 0);
  if (ageMs > THIRTY_DAYS_MS) boost -= PENALTY_OLDER_30D;
  return boost;
}

function _collectTags(records) {
  const set = new Set();
  for (const r of records) {
    for (const t of parseTags(r.tags)) {
      set.add(t);
    }
  }
  return set;
}

function _spreadingSecondary(store, namespace, primaryIds, primaryTagSet, type, limit) {
  if (primaryTagSet.size === 0) return [];
  // 拿所有共享 ≥ 1 tag 的候选（SQL 端做 LIKE），再在 JS 端精准算 ≥ 2 tag overlap
  const tagsArr = [...primaryTagSet];
  const candidates = store.search({
    namespace,
    type,
    tags: tagsArr.slice(0, 5).join(','), // SQL LIKE 至多前 5 个 tag 触发候选
    limit: limit * 2,
  });
  const filtered = [];
  for (const r of candidates) {
    if (primaryIds.has(r.id)) continue;
    const rTags = new Set(parseTags(r.tags));
    let overlap = 0;
    for (const t of rTags) if (primaryTagSet.has(t)) overlap++;
    if (overlap >= 2) filtered.push(r);
    if (filtered.length >= limit) break;
  }
  return filtered;
}

function _applyTagFilters(records, { tagsAll, excludeTags }) {
  if (!tagsAll && !excludeTags) return records;
  return records.filter(r => {
    const recTags = new Set(parseTags(r.tags));
    if (tagsAll) {
      for (const t of tagsAll) if (!recTags.has(t)) return false;
    }
    if (excludeTags) {
      for (const t of excludeTags) if (recTags.has(t)) return false;
    }
    return true;
  });
}

// 复制 MemoryStore._rowToRecord 的行为（避免循环依赖，直接做映射）
function store_rowToRecord(r) {
  return {
    id: r.id,
    namespace: r.namespace,
    type: r.type,
    content: r.content,
    summary: r.summary,
    tags: r.tags,
    importance: r.importance,
    confidence: r.confidence,
    source: r.source,
    evidence: r.evidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastAccessedAt: r.last_accessed_at,
    expiresAt: r.expires_at,
    accessCount: r.access_count,
    version: r.version,
    mood_at_creation: r.mood_at_creation,
    moodAtCreation: r.mood_at_creation,
    time_bucket: r.time_bucket,
    timeBucket: r.time_bucket,
    day_of_week: r.day_of_week,
    dayOfWeek: r.day_of_week,
    weather_at_creation: r.weather_at_creation,
    weatherAtCreation: r.weather_at_creation,
    session_id: r.session_id,
    sessionId: r.session_id,
    last_activated_at: r.last_activated_at,
    lastActivatedAt: r.last_activated_at,
  };
}
