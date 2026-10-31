// state.js — STATE.DB
// messages / plays / plan / prefs，全部 SQLite 单文件，跨重启持久。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from './runtimePaths.js';
import { ensureDataRootReady } from './app/dataRootMigration.js';
import { ensureRetiredRadioCleaned } from './app/retiredRadioCleanup.js';
import { createSynthesisFailureLog } from './tts/synthesisFailureLog.js';

// 数据根 bootstrap：首启动自动迁移（源侧隔离先于复制）+ 旧布局隔离带外保险。
// 必须在任何 SQLite 连接打开之前完成（幂等；任一 LUNARA_* 覆盖 env 的开发场景自动跳过）。
ensureDataRootReady();
// 每日节目与连续播客已移除：一次性清掉它们留下的库、聊天记录与播放快照（先备份）。
ensureRetiredRadioCleaned();

const DB_PATH = resolveDatabasePath();
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  role      TEXT NOT NULL,         -- 'user' | 'assistant'
  text      TEXT NOT NULL,
  meta      TEXT
);

CREATE TABLE IF NOT EXISTS plays (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,
  query     TEXT,
  song_id   TEXT,
  title     TEXT,
  artist    TEXT,
  album     TEXT,
  url       TEXT,
  duration  INTEGER,
  source    TEXT,                  -- 'ncm' | 'local' | ...
  segue     TEXT
);

CREATE TABLE IF NOT EXISTS plan (
  date      TEXT PRIMARY KEY,      -- yyyy-mm-dd
  payload   TEXT NOT NULL          -- JSON
);

CREATE TABLE IF NOT EXISTS prefs (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TABLE IF NOT EXISTS consolidation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  input_count   INTEGER,
  status        TEXT NOT NULL,      -- 'running' | 'success' | 'error' | 'parse_error'
  trigger       TEXT,               -- 'auto' | 'manual'
  dry_run       INTEGER,
  summary       TEXT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts DESC);
CREATE INDEX IF NOT EXISTS idx_plays_ts ON plays(ts DESC);
CREATE INDEX IF NOT EXISTS idx_plays_song ON plays(song_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_consolidation_started ON consolidation_log(started_at DESC);
`);

// plays 表幂等扩展
function ensurePlaysColumns() {
  const cols = db.prepare(`PRAGMA table_info(plays)`).all().map(c => c.name);
  if (!cols.includes('played_seconds')) {
    db.exec(`ALTER TABLE plays ADD COLUMN played_seconds INTEGER`);
  }
  if (!cols.includes('outcome')) {
    db.exec(`ALTER TABLE plays ADD COLUMN outcome TEXT`);
  }
  // v2 encoding-specificity（memory-system-v2 change）：跟 memories 表对齐，
  // 让 future thinking / summary 能按 (mood, time_bucket) 聚合 play outcomes。
  if (!cols.includes('mood_at_play')) {
    db.exec(`ALTER TABLE plays ADD COLUMN mood_at_play TEXT`);
  }
  if (!cols.includes('time_bucket_at_play')) {
    db.exec(`ALTER TABLE plays ADD COLUMN time_bucket_at_play TEXT`);
  }
}
ensurePlaysColumns();

const _stmts = {
  insertMessage: db.prepare(
    `INSERT INTO messages (ts, role, text, meta) VALUES (?, ?, ?, ?)`
  ),
  recentMessages: db.prepare(
    `SELECT ts, role, text FROM messages ORDER BY ts DESC LIMIT ?`
  ),
  messagesSince: db.prepare(
    `SELECT ts, role, text FROM messages WHERE ts >= ? ORDER BY ts ASC`
  ),
  insertPlay: db.prepare(
    `INSERT INTO plays (ts, query, song_id, title, artist, album, url, duration, source, segue)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  recentPlays: db.prepare(
    `SELECT ts, title, artist, album FROM plays ORDER BY ts DESC LIMIT ?`
  ),
  // 推荐新鲜度：窗口内实播身份（只读；既有 recentPlays 契约不变）
  recentPlaysIdentitySince: db.prepare(
    `SELECT ts, song_id, source, artist FROM plays WHERE ts >= ? AND song_id IS NOT NULL ORDER BY ts DESC LIMIT 5000`
  ),
  playsToday: db.prepare(
    `SELECT * FROM plays WHERE ts >= ? ORDER BY ts ASC`
  ),
  // outcome 上报：找到该 song_id 在合理排队窗口内最近一行
  findRecentPlayBySong: db.prepare(
    `SELECT id, outcome, query, song_id, title, artist, album, duration, source
     FROM plays
     WHERE song_id = ? AND ts >= ?
     ORDER BY ts DESC LIMIT 1`
  ),
  updateOutcome: db.prepare(
    `UPDATE plays SET outcome = ?, played_seconds = ? WHERE id = ?`
  ),
  // 推荐配额的「近 N 天实际占比」：只数真正听过的行，技术失败/跳过/拉黑不算
  // 用户的选择，把它们算进占比会让一次网络故障看起来像「我更爱听另一个源」。
  sourceMixSince: db.prepare(
    `SELECT source AS provider, COUNT(*) AS n FROM plays
     WHERE ts >= ? AND source IS NOT NULL AND source != ''
       AND (outcome IS NULL OR outcome NOT IN ('banned', 'technical_failure', 'skipped'))
     GROUP BY source`
  ),
  // 给 consolidation 用：自 ts 起所有 plays 行
  playsWithOutcomeSince: db.prepare(
    `SELECT ts, song_id, title, artist, album, duration, played_seconds, outcome, segue
     FROM plays WHERE ts >= ? ORDER BY ts ASC`
  ),
  playsCountSince: db.prepare(
    `SELECT COUNT(*) AS n FROM plays WHERE ts >= ?`
  ),
  outcomeStatsSince: db.prepare(
    `SELECT outcome, COUNT(*) AS n FROM plays WHERE ts >= ? GROUP BY outcome`
  ),
  // 候选池过滤：最近被 banned 的 song_id
  bannedSongsSince: db.prepare(
    `SELECT DISTINCT song_id FROM plays WHERE outcome = 'banned' AND ts >= ?`
  ),
  upsertPlan: db.prepare(
    `INSERT INTO plan (date, payload) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET payload = excluded.payload`
  ),
  getPlan: db.prepare(`SELECT payload FROM plan WHERE date = ?`),
  setPref: db.prepare(
    `INSERT INTO prefs (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  ),
  getPref: db.prepare(`SELECT v FROM prefs WHERE k = ?`),
  // consolidation log
  insertConsolidation: db.prepare(
    `INSERT INTO consolidation_log (started_at, status, trigger, dry_run, input_count)
     VALUES (?, ?, ?, ?, ?)`
  ),
  finishConsolidation: db.prepare(
    `UPDATE consolidation_log
     SET finished_at = ?, status = ?, summary = ?, error = ?
     WHERE id = ?`
  ),
  recentConsolidationLogs: db.prepare(
    `SELECT id, started_at, finished_at, input_count, status, trigger, dry_run, summary, error
     FROM consolidation_log ORDER BY started_at DESC LIMIT ?`
  ),
  lastSuccessfulConsolidation: db.prepare(
    `SELECT id, started_at, finished_at, summary
     FROM consolidation_log WHERE status = 'success'
     ORDER BY started_at DESC LIMIT 1`
  ),
};

export function logMessage(role, text, meta = null) {
  _stmts.insertMessage.run(Date.now(), role, text, meta ? JSON.stringify(meta) : null);
}

function normalizeMessageRole(row) {
  return row?.role === 'claudio' ? { ...row, role: 'assistant' } : row;
}

export function recentMessages(limit = 20) {
  return _stmts.recentMessages.all(limit).reverse().map(normalizeMessageRole);
}

export function logPlay(track) {
  _stmts.insertPlay.run(
    Date.now(),
    track.query || null,
    track.song_id || null,
    track.title || null,
    track.artist || null,
    track.album || null,
    track.url || null,
    track.duration || null,
    track.source || 'ncm',
    track.segue || null,
  );
}

export function recentPlays(limit = 30) {
  return _stmts.recentPlays.all(limit);
}

export function sourceMixSince(sinceTs) {
  return _stmts.sourceMixSince.all(Number(sinceTs) || 0);
}

/** 推荐新鲜度用：窗口内的实播身份流（song_id + source），供选歌排序。 */
export function recentPlaysIdentitySince(sinceTs) {
  return _stmts.recentPlaysIdentitySince.all(Math.max(0, Number(sinceTs) || 0));
}

export function playsToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return _stmts.playsToday.all(start.getTime());
}

// outcome 上报：找最近一段排队窗口内该 song_id 的 plays 行并更新。
// 「先到先得」：已是 final outcome 不覆盖。
const FINAL_OUTCOMES = new Set(['completed', 'banned']);
const VALID_OUTCOMES = new Set(['completed', 'skipped', 'banned', 'partial']);
const OUTCOME_MATCH_WINDOW_MS = 24 * 60 * 60 * 1000;

export function recordOutcome({ song_id, outcome, played_seconds }) {
  if (!song_id || !VALID_OUTCOMES.has(outcome)) {
    return { ok: false, error: 'invalid input' };
  }
  const since = Date.now() - OUTCOME_MATCH_WINDOW_MS;
  const row = _stmts.findRecentPlayBySong.get(String(song_id), since);
  if (!row) return { ok: true, updated: 0, skipped: 'no-recent-play' };
  const play = {
    query: row.query,
    song_id: row.song_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration: row.duration,
    source: row.source,
  };
  if (FINAL_OUTCOMES.has(row.outcome)) {
    return { ok: true, updated: 0, skipped: 'already-final', play };
  }
  const sec = Number.isFinite(played_seconds) ? Math.max(0, Math.round(played_seconds)) : null;
  const r = _stmts.updateOutcome.run(outcome, sec, row.id);
  // v2: 顺便填 mood/time_bucket（caller 不传时从当前 LifeState/clock 推断由 caller 处理；
  // 这里只在 outcome 写入时机做 best-effort 补一下 time_bucket）
  try {
    const d = new Date();
    const h = d.getHours();
    const bucket = h < 6 ? 'late-night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'night';
    db.prepare(`UPDATE plays SET time_bucket_at_play = COALESCE(time_bucket_at_play, ?) WHERE id = ?`).run(bucket, row.id);
  } catch { /* non-fatal */ }
  return { ok: true, updated: r.changes, play };
}

export function playsWithOutcomeSince(ts) {
  return _stmts.playsWithOutcomeSince.all(ts);
}

export function playsCountSince(ts) {
  return _stmts.playsCountSince.get(ts).n;
}

export function messagesSince(ts) {
  return _stmts.messagesSince.all(ts).map(normalizeMessageRole);
}

export function outcomeStats({ since } = {}) {
  const ts = since || (Date.now() - 14 * 24 * 3600 * 1000);
  const rows = _stmts.outcomeStatsSince.all(ts);
  const out = { completed: 0, skipped: 0, banned: 0, partial: 0, none: 0 };
  for (const r of rows) {
    const k = r.outcome || 'none';
    out[k] = (out[k] || 0) + r.n;
  }
  return out;
}

export function bannedSongIdsSince(since) {
  return _stmts.bannedSongsSince.all(since);
}

// ---- consolidation log ----
export function startConsolidation({ trigger = 'auto', dryRun = false, inputCount = 0 } = {}) {
  const r = _stmts.insertConsolidation.run(Date.now(), 'running', trigger, dryRun ? 1 : 0, inputCount);
  return Number(r.lastInsertRowid);
}

export function finishConsolidation(id, { status, summary = null, error = null } = {}) {
  _stmts.finishConsolidation.run(Date.now(), status, summary, error, id);
}

export function recentConsolidations(limit = 20) {
  return _stmts.recentConsolidationLogs.all(limit);
}

export function lastConsolidation() {
  return _stmts.lastSuccessfulConsolidation.get();
}

export function lastConsolidationAt() {
  const row = lastConsolidation();
  return row?.finished_at || row?.started_at || 0;
}

export function savePlan(dateStr, payload) {
  _stmts.upsertPlan.run(dateStr, JSON.stringify(payload));
}

export function loadPlan(dateStr) {
  const row = _stmts.getPlan.get(dateStr);
  return row ? JSON.parse(row.payload) : null;
}

export function setPref(k, v) {
  _stmts.setPref.run(k, typeof v === 'string' ? v : JSON.stringify(v));
}

export function getPref(k) {
  const row = _stmts.getPref.get(k);
  return row?.v ?? null;
}

// ---- 伙伴发声失败的本地记录（有界 200 条，见 tts/synthesisFailureLog.js）----
export const ttsFailureLog = createSynthesisFailureLog({ db });

export default {
  logMessage, recentMessages, messagesSince,
  logPlay, recentPlays, recentPlaysIdentitySince, playsToday,
  recordOutcome, playsWithOutcomeSince, playsCountSince, outcomeStats, bannedSongIdsSince,
  startConsolidation, finishConsolidation, recentConsolidations, lastConsolidation, lastConsolidationAt,
  savePlan, loadPlan, setPref, getPref,
  ttsFailureLog,
};
