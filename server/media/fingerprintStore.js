// fingerprintStore.js — 指纹的本地存储（state.db 附加表，纯增量）。
//
// 只存「相似度摘要」与状态，不存音频；`state` 区分 ready 与 failed，失败会在冷却后
// 再试，避免一个解不开的文件每次播放都重算。
//
// 与曲目封面同样属于**展示/提议用的派生数据**：计算失败、表为空、身份层未知都不
// 影响解析与播放。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { resolveDatabasePath } from '../runtimePaths.js';

export const FINGERPRINT_STATE = Object.freeze({ READY: 'ready', FAILED: 'failed' });

export function createFingerprintStore({ db, now = () => Date.now() } = {}) {
  if (!db) throw new TypeError('fingerprint store requires a database handle');
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_fingerprint (
      provider   TEXT NOT NULL,
      song_id    TEXT NOT NULL,
      fingerprint TEXT,
      version    INTEGER NOT NULL DEFAULT 1,
      points     INTEGER NOT NULL DEFAULT 0,
      state      TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, song_id)
    );
    CREATE INDEX IF NOT EXISTS idx_track_fingerprint_state ON track_fingerprint(state);
  `);
  const stmts = {
    get: db.prepare('SELECT * FROM track_fingerprint WHERE provider = ? AND song_id = ?'),
    put: db.prepare(`
      INSERT INTO track_fingerprint (provider, song_id, fingerprint, version, points, state, attempts, updated_at)
      VALUES (@provider, @songId, @fingerprint, @version, @points, @state, @attempts, @updatedAt)
      ON CONFLICT(provider, song_id) DO UPDATE SET
        fingerprint = excluded.fingerprint, version = excluded.version, points = excluded.points,
        state = excluded.state, attempts = excluded.attempts, updated_at = excluded.updated_at`),
    ready: db.prepare("SELECT provider, song_id AS songId, fingerprint, version, points, updated_at AS updatedAt FROM track_fingerprint WHERE state = 'ready' ORDER BY updated_at DESC LIMIT ?"),
  };

  function get(provider, songId) {
    const row = stmts.get.get(String(provider || ''), String(songId || ''));
    return row ? { ...row } : null;
  }

  function put({ provider, songId, fingerprint = null, state = FINGERPRINT_STATE.READY,
    version = 1, points = 0, attempts = 0 } = {}) {
    const key = { provider: String(provider || ''), songId: String(songId || '') };
    if (!key.provider || !key.songId) return { ok: false, reason: 'missing-identity' };
    stmts.put.run({ ...key, fingerprint: fingerprint ? String(fingerprint) : null,
      version: Number(version) || 1, points: Number(points) || 0, state,
      attempts: Number(attempts) || 0, updatedAt: now() });
    return { ok: true };
  }

  /** 已算好的指纹（有上限）：只用于「同一首歌」的提议，不参与播放。 */
  function ready(limit = 500) {
    return stmts.ready.all(Math.max(1, Math.min(2000, Number(limit) || 500)));
  }

  return Object.freeze({ db, get, put, ready, FINGERPRINT_STATE });
}

let singleton = null;

/** 生产单例：与其它本地派生数据共用 state.db；打开失败返回 null（指纹不是必需品）。 */
export function getFingerprintStore() {
  if (singleton) return singleton;
  try {
    const dbPath = resolveDatabasePath();
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    singleton = createFingerprintStore({ db });
    return singleton;
  } catch {
    return null;
  }
}

export function resetFingerprintStoreForTest() {
  try { singleton?.db?.close?.(); } catch { /* ignore */ }
  singleton = null;
}
