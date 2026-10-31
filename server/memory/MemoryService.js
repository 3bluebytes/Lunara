// MemoryService.js — Core memory business logic
//
// Facade over MemoryStore that enforces memory writing policies:
//
// Policy 1 — User explicit long-term preference → Semantic (high confidence)
// Policy 2 — One-time temporary request → Working (auto-expire)
// Policy 3 — Behavior observation → Episodic (low confidence)
// Policy 4 — Repeated pattern → promoted during consolidation (not directly)
// Policy 5 — Conflicting memories → coexist with version tracking
//
// This module does NOT directly depend on the storage implementation —
// all persistence goes through MemoryStore.

import { SQLiteMemoryStore } from './MemoryStore.js';
import {
  MemoryType, MemorySource,
  createMemoryRecord, contentSimilarity, tagOverlap, parseTags, validateImportance, validateConfidence,
} from './types.js';

export class MemoryService {
  constructor(namespace) {
    this.store = null;
    this._namespace = namespace || 'station';
    this._initialized = false;
  }

  get namespace() { return this._namespace; }

  // ===================== Lifecycle =====================

  async initialize() {
    if (this._initialized) return this;
    this.store = new SQLiteMemoryStore();
    this.store.initialize();
    this._initialized = true;
    return this;
  }

  isInitialized() { return this._initialized; }

  async shutdown() {
    if (this.store) this.store.close?.();
    this.store = null;
    this._initialized = false;
  }

  // ===================== Core CRUD =====================

  /**
   * Add a memory record with policy enforcement.
   * @param {object} record - MemoryRecord fields (type, content, source, ...)
   * @returns {{ ok: boolean, id?: number, error?: string }}
   */
  addMemory(record) {
    try {
      const rec = createMemoryRecord(record.type || MemoryType.EPISODIC, {
        namespace: record.namespace || this._namespace,
        content: record.content,
        source: record.source || MemorySource.AGENT_REFLECTION,
        summary: record.summary,
        tags: record.tags,
        importance: record.importance,
        confidence: record.confidence,
        evidence: record.evidence,
        expiresAt: record.expiresAt,
        // v2 encoding-specificity passthrough（memory-system-v2 change）
        mood_at_creation:    record.mood_at_creation    ?? record.moodAtCreation    ?? null,
        time_bucket:         record.time_bucket         ?? record.timeBucket         ?? null,
        day_of_week:         record.day_of_week         ?? record.dayOfWeek          ?? null,
        weather_at_creation: record.weather_at_creation ?? record.weatherAtCreation ?? null,
        session_id:          record.session_id          ?? record.sessionId          ?? null,
        last_activated_at:   record.last_activated_at   ?? record.lastActivatedAt   ?? null,
      });
      const id = this.store.insert(rec);
      return { ok: true, id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Retrieve a memory by id, tracking access.
   * @param {number} id
   * @returns {object|null}
   */
  getMemory(id) {
    const rec = this.store.getById(id);
    if (rec) {
      this.store._stmts.incrementAccess.run(Date.now(), id);
    }
    return rec;
  }

  /**
   * Search memories with filters.
   * @param {string} [query]
   * @param {object} [options]
   * @param {string} [options.namespace]
   * @returns {object[]}
   */
  searchMemory(query, options = {}) {
    return this.store.search({
      namespace: options.namespace || this._namespace,
      type: options.type,
      tags: options.tags,
      query: query || undefined,
      minImportance: options.minImportance,
      minConfidence: options.minConfidence,
      limit: options.limit || 50,
      offset: options.offset || 0,
    });
  }

  /** @param {string} type @param {string} [namespace] */
  getMemoriesByType(type, namespace) {
    return this.store.getByType(type, namespace || this._namespace);
  }

  /**
   * Update a memory record (increments version).
   * @param {number} id
   * @param {object} patch
   * @returns {boolean}
   */
  updateMemory(id, patch) {
    return this.store.update(id, patch);
  }

  /** @param {number} id */
  deleteMemory(id) {
    return this.store.delete(id);
  }

  // ===================== Policy-Based Writing =====================

  /**
   * Classify and add a memory applying automatic writing policies.
   *
   * Policies:
   *   isExplicit & isLongTerm → Semantic, high confidence
   *   isTemporary             → Working, auto-expire
   *   behavior/agent          → Episodic, low confidence
   *
   * @param {object} input
   * @param {string} input.content - The memory content
   * @param {string} [input.source] - Override source
   * @param {string[]} [input.tags] - Tags for search
   * @param {boolean} [input.isTemporary] - True = user one-time request
   * @param {boolean} [input.isExplicit] - True = user stated explicit preference
   * @param {boolean} [input.isObservation] - True = system inferred from behavior
   * @param {number} [input.importance]
   * @param {number} [input.confidence]
   * @param {string} [input.evidence] - Source material (user utterance, etc.)
   * @returns {{ ok: boolean, id?: number, type?: string, error?: string }}
   */
  classifyAndAddMemory(input) {
    const { content, tags, isTemporary, isExplicit, isObservation, evidence } = input;
    const ns = input.namespace || this._namespace;

    if (!content) return { ok: false, error: 'content required' };

    let type;
    let source;
    let confidence;
    let expiresAt;

    // Policy 1: User explicit long-term preference → Semantic
    if (isExplicit && !isTemporary) {
      type = MemoryType.SEMANTIC;
      source = MemorySource.USER_EXPLICIT_FEEDBACK;
      confidence = 0.7; // explicit starts high
    }
    // Policy 2: One-time user request → Working
    else if (isTemporary) {
      type = MemoryType.WORKING;
      source = MemorySource.USER_TEMPORARY_REQUEST;
      confidence = 0.4;
      // expires in 24h (handled by createMemoryRecord auto-set for WORKING)
    }
    // Policy 3: System observation → Episodic (low confidence)
    else if (isObservation) {
      type = MemoryType.EPISODIC;
      source = MemorySource.BEHAVIOR_OBSERVATION;
      confidence = 0.3;
    }
    // Default: agent reflection → Episodic
    else {
      type = MemoryType.EPISODIC;
      source = MemorySource.AGENT_REFLECTION;
      confidence = 0.5;
    }

    // Check for conflicts before writing (Policy 5)
    const conflicts = this.findConflicts(content, tags, type);
    const hasConflict = conflicts.length > 0;

    const result = this.addMemory({
      namespace: ns,
      type,
      content,
      source: input.source || source,
      tags,
      importance: input.importance,
      confidence: input.confidence ?? confidence,
      evidence: evidence ? JSON.stringify(evidence) : undefined,
      expiresAt,
    });

    return { ...result, type, namespace: ns, conflictsFound: hasConflict ? conflicts.length : 0 };
  }

  // ===================== Conflict Detection (Policy 5) =====================

  /**
   * Find potentially conflicting memories.
   * Checks Semantic and Episodic types for overlapping tags + similar content.
   *
   * @param {string} content
   * @param {string|string[]} tags
   * @param {string} [typeFilter]
   * @returns {object[]}
   */
  findConflicts(content, tags, typeFilter) {
    const tagArr = parseTags(tags);
    if (!tagArr.length) return [];

    const candidates = this.store.search({
      namespace: this._namespace,
      type: typeFilter || undefined,
      limit: 100,
    });

    return candidates.filter(m => {
      const overlap = tagOverlap(tags, m.tags, 1);
      if (overlap < 1) return false;
      // Low similarity = potentially different direction = potential conflict
      const sim = contentSimilarity(content, m.content);
      return sim < 0.3;
    });
  }

  // ===================== Stats =====================

  stats(namespace) {
    const ns = namespace || this._namespace;
    const byType = this.store.countByType(ns);
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    return { ...byType, total, namespace: ns };
  }

  // ===================== Delegates to store =====================

  getStore() { return this.store; }
}
