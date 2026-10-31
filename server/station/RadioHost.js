// RadioHost.js — radiohost registry type definition
//
// RadioHost represents an independent radiohost instance with:
//   - Unique identity (id, name)
//   - Voice binding (voiceProfileId)
//   - Own memory namespace (radiohost:<id>)
//   - Status lifecycle (active, inactive, archived)
//
// RadioHost is not a sub-object of StationAgent. StationAgent holds only
// registry metadata. The actual memory lives in the radiohost's namespace.

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from '../runtimePaths.js';

function databasePath() {
  return resolveDatabasePath();
}

/**
 * Create a RadioHost instance.
 * @param {object} opts
 * @param {string} [opts.id] - Auto-generated if not provided
 * @param {string} opts.voiceProfileId
 * @param {string} [opts.name]
 * @param {string} [opts.status] - 'active' | 'inactive' | 'archived'
 * @returns {object} RadioHost
 */
export function createRadioHost(opts) {
  const id = opts.id || `radiohost_${randomUUID().slice(0, 8)}`;
  return {
    id,
    name: opts.name || '',
    voiceProfileId: opts.voiceProfileId || '',
    namespace: `radiohost:${id}`,
    status: opts.status || 'inactive',
    lastDailyStateDate: opts.lastDailyStateDate || '',
    lastSessionId: opts.lastSessionId || '',
    memoryStats: { persona: 0, semantic: 0, episodic: 0, working: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ===================== RadioHost Registry =====================

/**
 * SQLite-backed registry for RadioHost metadata.
 */
export class RadioHostRegistry {
  constructor() {
    this.db = null;
    this._cache = null; // id → RadioHost
  }

  initialize() {
    const dbPath = databasePath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS radiohosts (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL DEFAULT '',
        voice_profile_id TEXT NOT NULL,
        namespace       TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'inactive',
        last_daily_state_date TEXT DEFAULT '',
        last_session_id TEXT DEFAULT '',
        memory_stats    TEXT DEFAULT '{}',
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      )
    `);

    this._loadCache();
    return this;
  }

  _loadCache() {
    this._cache = new Map();
    const rows = this.db.prepare('SELECT * FROM radiohosts').all();
    for (const r of rows) {
      this._cache.set(r.id, this._rowToHost(r));
    }
  }

  _rowToHost(r) {
    return {
      id: r.id,
      name: r.name,
      voiceProfileId: r.voice_profile_id,
      namespace: r.namespace,
      status: r.status,
      lastDailyStateDate: r.last_daily_state_date || '',
      lastSessionId: r.last_session_id || '',
      memoryStats: safeParseJSON(r.memory_stats, {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  register(host) {
    this.db.prepare(`
      INSERT INTO radiohosts (id, name, voice_profile_id, namespace, status, last_daily_state_date, last_session_id, memory_stats, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        voice_profile_id = excluded.voice_profile_id,
        status = excluded.status,
        last_daily_state_date = excluded.last_daily_state_date,
        last_session_id = excluded.last_session_id,
        updated_at = excluded.updated_at
    `).run(host.id, host.name, host.voiceProfileId, host.namespace, host.status,
      host.lastDailyStateDate || '', host.lastSessionId || '',
      JSON.stringify(host.memoryStats || {}), host.createdAt, host.updatedAt);
    this._cache.set(host.id, host);
  }

  unregister(id) {
    this.db.prepare('DELETE FROM radiohosts WHERE id = ?').run(id);
    this._cache.delete(id);
  }

  get(id) {
    return this._cache.get(id) || null;
  }

  getByNamespace(ns) {
    for (const h of this._cache.values()) {
      if (h.namespace === ns) return h;
    }
    return null;
  }

  list() {
    return [...this._cache.values()];
  }

  getActive() {
    for (const h of this._cache.values()) {
      if (h.status === 'active') return h;
    }
    return null;
  }

  setActive(id) {
    const host = this._cache.get(id);
    if (!host) return null;

    // Deactivate all
    for (const h of this._cache.values()) {
      if (h.status === 'active') {
        h.status = 'inactive';
        this.db.prepare('UPDATE radiohosts SET status = ?, updated_at = ? WHERE id = ?').run('inactive', Date.now(), h.id);
      }
    }
    // Activate target
    host.status = 'active';
    host.updatedAt = Date.now();
    this.db.prepare('UPDATE radiohosts SET status = ?, updated_at = ? WHERE id = ?').run('active', host.updatedAt, id);
    return host;
  }

  updateStats(id, stats) {
    const host = this._cache.get(id);
    if (host) {
      host.memoryStats = stats;
      this.db.prepare('UPDATE radiohosts SET memory_stats = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(stats), Date.now(), id);
    }
  }

  /**
   * Update specific fields on a RadioHost (e.g. lastDailyStateDate, lastSessionId).
   * Only updates non-null/undefined values.
   * @param {string} id
   * @param {object} fields - { lastDailyStateDate?, lastSessionId? }
   */
  updateFields(id, fields) {
    const host = this._cache.get(id);
    if (!host) return;
    const updates = [];
    const params = [];
    if (fields.lastDailyStateDate !== undefined) {
      host.lastDailyStateDate = fields.lastDailyStateDate;
      updates.push('last_daily_state_date = ?');
      params.push(fields.lastDailyStateDate);
    }
    if (fields.lastSessionId !== undefined) {
      host.lastSessionId = fields.lastSessionId;
      updates.push('last_session_id = ?');
      params.push(fields.lastSessionId);
    }
    if (updates.length > 0) {
      host.updatedAt = Date.now();
      updates.push('updated_at = ?');
      params.push(host.updatedAt);
      params.push(id);
      this.db.prepare(`UPDATE radiohosts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
  }

  count() {
    return this._cache.size;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this._cache = null;
  }
}

function safeParseJSON(s, def) {
  try { return JSON.parse(s); } catch { return def; }
}
