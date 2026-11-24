import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5000;

/** 打开 SQLite 连接并在切换 WAL 前配置统一 busy_timeout，降低多连接并发写锁报错。 */
export function openSqliteDatabase(dbPath, {
  readonly = false,
  wal = !readonly,
  busyTimeoutMs = DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  foreignKeys = false,
} = {}) {
  if (!readonly && dbPath && dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const timeout = Math.max(0, Math.floor(Number(busyTimeoutMs) || 0));
  const options = { timeout };
  if (readonly) options.readonly = true;
  const db = new Database(dbPath, options);
  db.pragma(`busy_timeout = ${timeout}`);
  if (wal && !readonly) db.pragma('journal_mode = WAL');
  if (foreignKeys) db.pragma('foreign_keys = ON');
  return db;
}

export default openSqliteDatabase;
