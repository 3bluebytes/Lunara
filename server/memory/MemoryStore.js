import { initializeRevocations } from './memoryProvenance.js';
// MemoryStore.js — Abstraction layer for memory persistence
//
// Provides:
//   MemoryStore (abstract interface)
//   SQLiteMemoryStore (concrete implementation using better-sqlite3)
//
// Business logic MUST NOT depend directly on SQLiteMemoryStore — always
// use the MemoryService facade which wraps policy enforcement around storage.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createMemoryRecord, parseTags } from './types.js';
import * as types from './types.js';
import { trace } from '../trace.js';
import { resolveDatabasePath } from '../runtimePaths.js';

function databasePath() {
  return resolveDatabasePath();
}

// ===================== Abstract Store =====================

/**
 * MemoryStore interface (documentation reference — JS doesn't enforce interfaces)
 *
 * Methods that subclasses should implement:
 *   initialize()
 *   insert(record)        → number (id)
 *   getById(id)           → object | null
 *   update(id, patch)     → boolean
 *   delete(id)            → boolean
 *   search(opts)          → object[]
 *   getByType(type)       → object[]
 *   count()               → number
 *   countByType()         → object
 *   deleteExpired()       → number (deleted count)
 *   prune(opts)           → { deleted, kept }
 *   evict(type, maxCount) → number (deleted count)
 */

// ===================== SQLite Implementation =====================

export class SQLiteMemoryStore {
  constructor({ db = null, dbPath = null } = {}) {
    this.db = db;
    this.dbPath = dbPath;
    this.ownsDb = !db;
    this._stmts = {};
  }

  initialize() {
    if (!this.db) {
      const dbPath = this.dbPath || databasePath();
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace       TEXT NOT NULL DEFAULT 'station',
        type            TEXT NOT NULL,
        content         TEXT NOT NULL,
        summary         TEXT DEFAULT '',
        tags            TEXT DEFAULT '',
        importance      INTEGER NOT NULL DEFAULT 5,
        confidence      REAL NOT NULL DEFAULT 0.5,
        source          TEXT NOT NULL,
        evidence        TEXT DEFAULT '',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        expires_at      INTEGER,
        access_count    INTEGER NOT NULL DEFAULT 0,
        version         INTEGER NOT NULL DEFAULT 1,
        -- v2 encoding specificity columns（memory-system-v2 change）
        mood_at_creation    TEXT,
        time_bucket         TEXT,
        day_of_week         INTEGER,
        weather_at_creation TEXT,
        session_id          TEXT,
        last_activated_at   INTEGER
      );

      -- v1 indexes（这些不依赖 v2 字段，CREATE TABLE 之后立刻建是安全的）
      CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
      CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed_at);
      CREATE INDEX IF NOT EXISTS idx_memories_type_namespace ON memories(type, namespace);
      CREATE INDEX IF NOT EXISTS idx_memories_namespace_type_importance ON memories(namespace, type, importance);
      -- 注：v2 encoding-specificity indexes 在 _migrateV2EncodingColumns 里建，
      -- 不能放这儿：升级老 DB 时此时 mood_at_creation 等列还不存在，
      -- CREATE INDEX 会报 "no such column" 让整个 initialize 挂掉。
    `);

    // Migration: add namespace column if missing (existing DBs from pre-namespace era)
    this._migrateNamespace();
    // Migration: add v2 encoding columns if missing (existing DBs from pre-v2 era)
    this._migrateV2EncodingColumns();
    // FTS5 mirror（v2）
    this._initFTS5();

    initializeRevocations(this.db);
    this._prepareStmts();
    return this;
  }

  close() {
    if (this.db) {
      if (this.ownsDb) this.db.close();
      this.db = null;
    }
    this._stmts = {};
  }

  /**
   * v2 migration: add 6 encoding-specificity columns to memories table if missing.
   * Idempotent — checks existing columns first.
   */
  _migrateV2EncodingColumns() {
    const cols = this.db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name);
    const additions = [
      { name: 'mood_at_creation',    sql: 'ALTER TABLE memories ADD COLUMN mood_at_creation TEXT' },
      { name: 'time_bucket',         sql: 'ALTER TABLE memories ADD COLUMN time_bucket TEXT' },
      { name: 'day_of_week',         sql: 'ALTER TABLE memories ADD COLUMN day_of_week INTEGER' },
      { name: 'weather_at_creation', sql: 'ALTER TABLE memories ADD COLUMN weather_at_creation TEXT' },
      { name: 'session_id',          sql: 'ALTER TABLE memories ADD COLUMN session_id TEXT' },
      { name: 'last_activated_at',   sql: 'ALTER TABLE memories ADD COLUMN last_activated_at INTEGER' },
    ];
    for (const { name, sql } of additions) {
      if (!cols.includes(name)) this.db.exec(sql);
    }
    // 加索引（IF NOT EXISTS 安全）
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_mood ON memories(namespace, mood_at_creation);
      CREATE INDEX IF NOT EXISTS idx_memories_time_bucket ON memories(namespace, time_bucket);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(namespace, session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_last_activated ON memories(namespace, last_activated_at);
    `);
  }

  /**
   * Initialize FTS5 virtual mirror for memories.content + tags.
   * Triggers keep it in sync on INSERT/UPDATE/DELETE.
   * Bails out gracefully if SQLite lacks FTS5 (logs warning, retrieval will fall back to LIKE).
   */
  _initFTS5() {
    try {
      // tokenize=trigram：对中文友好（unicode61 把整段 CJK 串当成一个 token，没法精准搜「深夜」）。
      // 代价：trigram 索引体积比 unicode61 略大，但对单用户量级影响可忽略。
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content, tags,
          content='memories', content_rowid='id',
          tokenize='trigram'
        );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.id, old.content, old.tags);
          INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
        END;
      `);
      this._ftsAvailable = true;
      // v2 升级老 DB 时的隐患：现存 memories 行从未进过 FTS5 镜像（trigger 只对未来 INSERT 生效），
      // 后续 DELETE/UPDATE 会让 trigger 尝试操作不存在的镜像行 → "database disk image is malformed"。
      // 启动时检查：若 memories 有行但 memories_fts 为空，自动 rebuild。一次性，幂等。
      try {
        const memRow = this.db.prepare(`SELECT COUNT(*) AS n FROM memories`).get();
        const ftsRow = this.db.prepare(`SELECT COUNT(*) AS n FROM memories_fts`).get();
        if (memRow.n > 0 && ftsRow.n === 0) {
          this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
          console.log(`[memory] FTS5 mirror auto-rebuilt for ${memRow.n} existing rows (upgrade safety)`);
        }
      } catch (e) {
        console.warn('[memory] FTS5 startup rebuild check failed (non-fatal):', e.message);
      }
    } catch (e) {
      console.warn('[memory] FTS5 unavailable, retrieval will fall back to LIKE:', e.message);
      this._ftsAvailable = false;
    }
  }

  /**
   * v2: rebuild FTS5 table from scratch. Use after bulk inserts or to recover from corruption.
   */
  rebuildFTS() {
    if (!this._ftsAvailable) return false;
    this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
    return true;
  }

  /**
   * v2: validate the type is one of the 4 allowed values. Reject deprecated v1 types.
   */
  _validateType(type) {
    const allowed = new Set(['working', 'episodic', 'semantic', 'life_state']);
    if (!allowed.has(type)) {
      const v1Legacy = ['persona', 'episode', 'user_preference', 'interaction'];
      if (v1Legacy.includes(type)) {
        throw new Error(`v2: type '${type}' was removed. Use one of: ${[...allowed].join(', ')}. See memory-system-v2 change.`);
      }
      throw new Error(`v2: unknown type '${type}'. Allowed: ${[...allowed].join(', ')}`);
    }
  }

  _prepareStmts() {
    const db = this.db;

    this._stmts = {
      insert: db.prepare(`
        INSERT INTO memories (namespace, type, content, summary, tags, importance, confidence, source, evidence,
                              created_at, updated_at, last_accessed_at, expires_at, access_count, version,
                              mood_at_creation, time_bucket, day_of_week, weather_at_creation, session_id, last_activated_at)
        VALUES (@namespace, @type, @content, @summary, @tags, @importance, @confidence, @source, @evidence,
                @created_at, @updated_at, @last_accessed_at, @expires_at, @access_count, @version,
                @mood_at_creation, @time_bucket, @day_of_week, @weather_at_creation, @session_id, @last_activated_at)
      `),

      getById: db.prepare(`SELECT * FROM memories WHERE id = ?`),

      update: db.prepare(`
        UPDATE memories SET
          content        = coalesce(?, content),
          summary        = coalesce(?, summary),
          tags           = coalesce(?, tags),
          importance     = coalesce(?, importance),
          confidence     = coalesce(?, confidence),
          evidence       = coalesce(?, evidence),
          expires_at     = coalesce(?, expires_at),
          updated_at     = ?,
          version        = version + 1
        WHERE id = ?
      `),

      incrementAccess: db.prepare(`
        UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
      `),

      delete: db.prepare(`DELETE FROM memories WHERE id = ?`),

      getByType: db.prepare(`
        SELECT * FROM memories WHERE type = ? AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC
      `),

      countAll: db.prepare(`SELECT COUNT(*) AS n FROM memories`),

      countByType: db.prepare(`
        SELECT type, COUNT(*) AS n FROM memories GROUP BY type
     `),

      countByTypeFilter: db.prepare(`
        SELECT COUNT(*) AS n FROM memories WHERE type = ?
      `),

      deleteExpired: db.prepare(`
        DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?
      `),

      // Search with dynamic WHERE clauses
      searchBase: `SELECT * FROM memories WHERE 1=1`,
      searchCountBase: `SELECT COUNT(*) AS n FROM memories WHERE 1=1`,

      evictBase: db.prepare(`
        DELETE FROM memories WHERE id IN (
          SELECT id FROM memories WHERE type = ? AND type != 'persona'
          ORDER BY created_at ASC
          LIMIT ?
        )
      `),
    };
  }

  /**
   * Insert a validated record.
   * @param {object} record - Must match MemoryRecord shape
   * @returns {number} assigned id
   */
  insert(record) {
    this._validateType(record.type);
    const info = this._stmts.insert.run({
      namespace: record.namespace || 'station',
      type: record.type,
      content: record.content,
      summary: record.summary || '',
      tags: record.tags || '',
      importance: record.importance,
      confidence: record.confidence,
      source: record.source,
      evidence: record.evidence || '',
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      last_accessed_at: record.lastAccessedAt,
      expires_at: record.expiresAt || null,
      access_count: record.accessCount || 0,
      version: record.version || 1,
      // v2 encoding-specificity（all nullable，缺失字段视为 NULL）
      mood_at_creation:    record.mood_at_creation    ?? record.moodAtCreation    ?? null,
      time_bucket:         record.time_bucket         ?? record.timeBucket         ?? null,
      day_of_week:         record.day_of_week         ?? record.dayOfWeek          ?? null,
      weather_at_creation: record.weather_at_creation ?? record.weatherAtCreation ?? null,
      session_id:          record.session_id          ?? record.sessionId          ?? null,
      last_activated_at:   record.last_activated_at   ?? record.lastActivatedAt   ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  /** @param {number} id */
  getById(id) {
    const row = this._stmts.getById.get(id);
    trace(`store.getById: id=${id} → ${row ? 'found' : 'null'}`);
    return row ? this._rowToRecord(row) : null;
  }

  /**
   * @param {number} id
   * @param {object} patch - Fields to update (content, summary, tags, importance, confidence, evidence, expiresAt)
   * @returns {boolean} true if a row was updated
   */
  update(id, patch) {
    const now = Date.now();
    const info = this._stmts.update.run(
      patch.content ?? null,
      patch.summary ?? null,
      patch.tags ?? null,
      patch.importance ?? null,
      patch.confidence ?? null,
      patch.evidence ?? null,
      patch.expiresAt ?? null,
      now,
      id,
    );
    return info.changes > 0;
  }

  /** @param {number} id */
  delete(id) {
    const info = this._stmts.delete.run(id);
    return info.changes > 0;
  }

  /**
   * Search memories with filters.
   * @param {object} opts
   * @param {string} [opts.type] - Filter by memory type
   * @param {string|string[]} [opts.tags] - Filter by tag (comma-separated or array)
   * @param {string} [opts.query] - Text search in content + summary
   * @param {number} [opts.minImportance]
   * @param {number} [opts.minConfidence]
   * @param {number} [opts.limit] - Max results (default 50)
   * @param {number} [opts.offset] - Pagination offset
   * @returns {object[]}
   */
  search(opts = {}) {
    const { namespace, type, tags, query, minImportance, minConfidence, limit = 50, offset = 0, orderBy } = opts;

    const where = [];
    const params = [];

    // Filter by namespace (default 'station')
    where.push('namespace = ?');
    params.push(namespace || 'station');

    if (type) {
      where.push('type = ?');
      params.push(type);
    }

    // Filter out expired
    where.push('(expires_at IS NULL OR expires_at > ?)');
    params.push(Date.now());

    if (tags) {
      const tagList = parseTags(tags);
      for (const tag of tagList) {
        where.push('tags LIKE ?');
        params.push(`%${tag}%`);
      }
    }

    if (query) {
      where.push('(content LIKE ? OR summary LIKE ?)');
      const like = `%${query}%`;
      params.push(like, like);
    }

    if (minImportance != null) {
      where.push('importance >= ?');
      params.push(minImportance);
    }

    if (minConfidence != null) {
      where.push('confidence >= ?');
      params.push(minConfidence);
    }

    const orderClause = orderBy === 'created_at_asc' ? 'ORDER BY created_at ASC'
      : 'ORDER BY created_at DESC';

    const sql = `${this._stmts.searchBase} AND ${where.join(' AND ')} ${orderClause} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params);
    trace(`store.search: ns=${params[0]} type=${type||'-'} tags=${tags||'-'} query=${query||'-'} → ${rows.length} results`);
    return rows.map(r => this._rowToRecord(r));
  }

  /**
   * @param {string} type
   * @param {string} [namespace] - defaults to 'station'
   */
  getByType(type, namespace) {
    const ns = namespace || 'station';
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE type = ? AND namespace = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
    `).all(type, ns, Date.now());
    trace(`store.getByType: type=${type} ns=${ns} → ${rows.length} results`);
    return rows.map(r => this._rowToRecord(r));
  }

  /** @returns {number} */
  count() {
    return this._stmts.countAll.get().n;
  }

  /** @returns {object} e.g. { working: 5, episodic: 12, semantic: 3, persona: 1 } */
  countByType(namespace) {
    const ns = namespace || 'station';
    const rows = this.db.prepare(`
      SELECT type, COUNT(*) AS n FROM memories WHERE namespace = ? GROUP BY type
    `).all(ns);
    const result = {};
    for (const r of rows) result[r.type] = r.n;
    // ensure all types have entries
    for (const t of Object.values(types.MemoryType)) {
      if (!(t in result)) result[t] = 0;
    }
    return result;
  }

  countByTypeSingle(type, namespace) {
    const ns = namespace || 'station';
    return this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE type = ? AND namespace = ?`).get(type, ns).n;
  }

  /**
   * 统计某个 namespace 下的记忆条数。
   *
   * 删除伙伴前需要先向用户披露将被永久移除的规模，因此计数必须与
   * deleteByNamespace 落在同一个 namespace 键上，不能靠估算。
   */
  countByNamespace(namespace) {
    if (!namespace) return 0;
    return this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE namespace = ?`).get(namespace).n;
  }

  /** Delete all memories in a given namespace. */
  deleteByNamespace(namespace) {
    if (!namespace) return 0;
    const info = this.db.prepare('DELETE FROM memories WHERE namespace = ?').run(namespace);
    return info.changes;
  }

  /** @param {string} [namespace] - defaults to 'station' */
  deleteExpired(namespace) {
    const ns = namespace || 'station';
    const info = this.db.prepare(`
      DELETE FROM memories WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at < ?
    `).run(ns, Date.now());
    return info.changes;
  }

  /**
   * Prune low-value memories.
   * @param {object} opts
   * @param {string} [opts.namespace] - defaults to 'station'
   * @param {number} [opts.minImportance=2]
   * @param {number} [opts.minConfidence=0.2]
   * @param {number} [opts.maxAgeDays=30]
   * @returns {{ deleted: number, kept: number }}
   */
  prune(opts = {}) {
    const ns = opts.namespace || 'station';
    const minImp = opts.minImportance ?? 2;
    const minConf = opts.minConfidence ?? 0.2;
    const maxAge = opts.maxAgeDays ?? 30;
    const cutoff = Date.now() - maxAge * 24 * 60 * 60 * 1000;

    const before = this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE namespace = ?`).get(ns).n;

    this.db.prepare(`
      DELETE FROM memories
      WHERE namespace = ?
        AND type != 'persona'
        AND importance < ?
        AND confidence < ?
        AND last_accessed_at < ?
        AND access_count = 0
    `).run(ns, minImp, minConf, cutoff);

    const after = this.db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE namespace = ?`).get(ns).n;
    return { deleted: before - after, kept: after };
  }

  /**
   * FIFO eviction: keep the newest N records of a given type.
   * @param {string} type
   * @param {number} maxCount
   * @param {string} [namespace] - defaults to 'station'
   * @returns {number} number of evicted rows
   */
  evict(type, maxCount, namespace) {
    if (type === types.MemoryType.PERSONA) return 0;
    const ns = namespace || 'station';
    const current = this.countByTypeSingle(type, ns);
    if (current <= maxCount) return 0;
    const toRemove = current - maxCount;
    this.db.prepare(`
      DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE type = ? AND namespace = ? AND type != 'persona'
        ORDER BY created_at ASC
        LIMIT ?
      )
    `).run(type, ns, toRemove);
    return toRemove;
  }

  /**
   * Get all memories for consolidation scanning in a namespace.
   * Only non-persona, non-expired.
   * @param {string} [namespace] - defaults to 'station'
   */
  getAllForConsolidation(namespace) {
    const ns = namespace || 'station';
    const rows = this.db.prepare(`
      SELECT * FROM memories
      WHERE namespace = ?
        AND type != 'persona'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at ASC
    `).all(ns, Date.now());
    return rows.map(r => this._rowToRecord(r));
  }

  /** Migrate existing DB: add namespace column if missing */
  _migrateNamespace() {
    const cols = this.db.prepare(`PRAGMA table_info(memories)`).all().map(c => c.name);
    if (!cols.includes('namespace')) {
      this.db.exec(`ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT 'station'`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace)`);
      // Mark existing records as 'station' namespace
      this.db.prepare(`UPDATE memories SET namespace = 'station' WHERE namespace IS NULL OR namespace = ''`).run();
    }
  }

  /** Bulk update importance (used during decay) */
  setImportance(id, val) {
    this.db.prepare(`UPDATE memories SET importance = ?, updated_at = ? WHERE id = ?`).run(val, Date.now(), id);
  }

  // ===================== Helpers =====================

  _rowToRecord(r) {
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
      // v2 encoding-specificity fields（snake_case 保留以便 SQL，camelCase 别名给 JS 代码用）
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
}
