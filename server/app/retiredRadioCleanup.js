// retiredRadioCleanup.js — 每日节目与连续播客退役后的一次性数据清理。
//
// 这两项功能已整体移除，清理目标是让数据根看起来从未有过它们：
//   - 独立库 data/daily-programs.db、data/radio-episodes.db；
//   - life.db 的 life_radio_episode_grants；
//   - state.db：playback_start_results、两类草稿任务的 llm_usage、整集房间
//     （session_id 形如 episode-* / conversation:episode-*）在所有带 session_id 列的表里的行、
//     台本 turn（episode-script:* 或带台本标记的 message_json）及引用它们的请求/观察/摘要、
//     playback_runtime_state 里的整集队列项与节目绑定字段；
//   - 合成好的整集 mp3（tts 缓存）与 tasks/daily_program/ 执行记录。
//
// 顺序契约（与 dataRootMigration 同纪律）：
//   1. 只读预扫描；没有任何残留 → 只写 marker，不做备份。
//   2. 涉及的库逐个 rw 打开 + wal_checkpoint(TRUNCATE)；busy ≠ 0 → 整体放弃，零修改。
//   3. 库连同 -wal/-shm 复制到 <root>/backup/pre-retire-radio-<ts>/，副本逐表 COUNT + integrity_check。
//   4. state.db 单事务清理；life.db 删表；旧库与 mp3、task 记录移入同一备份目录。
//   5. 清理后 integrity_check，写 <root>/retired-radio-cleanup.json（只跑一次）。
// 失败不阻断启动：没写 marker，下次启动重跑（每一步都幂等）。
//
// 敏感域：备份含私人聊天与 cookie 字段，留在数据根由用户自行处理，禁入仓库与可分享日志。

import Database from 'better-sqlite3';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { resolveDataRoot } from '../runtimePaths.js';
import { readTableStats, validateCopiedDatabase } from './dataRootMigration.js';

export const RETIRED_RADIO_MARKER = 'retired-radio-cleanup.json';

const RETIRED_DATABASES = ['daily-programs.db', 'radio-episodes.db'];
const RETIRED_USAGE_TASKS = ['daily_program_draft', 'radio_episode_draft'];
const EPISODE_SESSION_SQL = (column) => `(${column} GLOB 'episode-*' OR ${column} GLOB 'conversation:episode-*')`;
const EPISODE_SESSION_PATTERN = /^(?:conversation:)?episode-/;
const SCRIPT_TURN_SQL = `(turn_id LIKE 'episode-script:%'
  OR message_json LIKE '%radio_episode_script%'
  OR message_json LIKE '%radio_episode_restricted%'
  OR message_json LIKE '%episodeDependency%')`;
const TURN_COLUMNS = ['turn_id', 'source_turn_id', 'user_turn_id', 'assistant_turn_id'];
// 每路径覆盖说明是开发/测试环境，数据根推导出的路径不可信，绝不自动清理。
const PATH_OVERRIDE_ENV = ['LUNARA_DB_PATH', 'CLAUDIO_DB_PATH', 'LUNARA_TTS_CACHE_DIR', 'CLAUDIO_TTS_CACHE_DIR',
  'LUNARA_TASK_TRACE_DIR'];

const quote = name => `"${String(name).replaceAll('"', '""')}"`;

function tableNames(db) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    AND COALESCE(sql, '') NOT LIKE 'CREATE VIRTUAL%'`).all().map(row => row.name);
}

function columnsOf(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => row.name));
}

function hasTable(db, table) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

function isEpisodeItem(item) {
  return item?.mediaKind === 'radio_episode';
}

/**
 * 去掉播放快照里的整集与节目痕迹（纯函数，返回新对象与是否改动）。
 * 活跃会话就是整集房间时，回到 conversation:primary（有挂起状态就恢复它，否则空闲）。
 */
export function stripRetiredRadioFromRuntimeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { snapshot, changed: false };
  const before = JSON.stringify(snapshot);
  const next = structuredClone(snapshot);

  const cleanSession = session => {
    if (!session || typeof session !== 'object') return;
    const binding = session.dailyProgramBinding;
    if (binding && typeof binding.savedRadioMode === 'boolean') session.radioMode = binding.savedRadioMode;
    delete session.dailyProgramBinding;
    delete session.radioEpisode;
    if (Array.isArray(session.modeCountedOccurrences)) {
      session.modeCountedOccurrences = session.modeCountedOccurrences.map(entry => {
        if (!entry || typeof entry !== 'object' || !('scopeKey' in entry)) return entry;
        const { scopeKey: _scopeKey, ...rest } = entry;
        return rest;
      });
    }
    if (!Array.isArray(session.queue) || !session.queue.some(isEpisodeItem)) return;
    const current = Number.isInteger(session.currentIndex) ? session.queue[session.currentIndex] : null;
    session.queue = session.queue.filter(item => !isEpisodeItem(item));
    if (current && !isEpisodeItem(current)) {
      session.currentIndex = session.queue.indexOf(current);
    } else if (current) {
      Object.assign(session, { currentIndex: -1, currentSongId: null, phase: 'idle', txn: null,
        positionSeconds: 0, hasStarted: false });
    }
    if (session.txn?.queueItemId && !session.queue.some(item => item?.queueItemId === session.txn.queueItemId)) {
      session.txn = null;
    }
  };

  cleanSession(next);
  const suspended = next.suspendedSessions && typeof next.suspendedSessions === 'object' ? next.suspendedSessions : null;
  if (suspended) {
    for (const [id, session] of Object.entries(suspended)) {
      if (EPISODE_SESSION_PATTERN.test(id)) delete suspended[id];
      else cleanSession(session);
    }
  }
  if (EPISODE_SESSION_PATTERN.test(String(next.activeListeningSessionId || ''))) {
    const primary = suspended?.['conversation:primary'];
    Object.assign(next, { queue: [], currentIndex: -1, currentSongId: null, phase: 'idle', txn: null,
      positionSeconds: 0, hasStarted: false, pendingContinuation: null, listeningPlan: null, lastError: null,
      modeCountedOccurrences: [] }, primary || {});
    if (primary) delete suspended['conversation:primary'];
    next.activeListeningSessionId = 'conversation:primary';
    next.version = (Number(next.version) || 0) + 1;
    next.outputGeneration = (Number(next.outputGeneration) || 0) + 1;
  }
  delete next.radioEpisode;
  if (Array.isArray(next.processedEventIds)) {
    next.processedEventIds = next.processedEventIds.filter(id => !String(id).startsWith('episode-'));
  }
  if (Array.isArray(next.diagnostics)) {
    next.diagnostics = next.diagnostics.filter(entry => !/episode|daily-program/i.test(String(entry?.type || '')));
  }
  return JSON.stringify(next) === before ? { snapshot, changed: false } : { snapshot: next, changed: true };
}

function readRuntimePref(db) {
  if (!hasTable(db, 'prefs')) return null;
  return db.prepare(`SELECT v FROM prefs WHERE k = 'playback_runtime_state'`).get()?.v ?? null;
}

function runtimePrefNeedsCleanup(raw) {
  if (!raw) return false;
  try { return stripRetiredRadioFromRuntimeSnapshot(JSON.parse(raw)).changed; } catch { return false; }
}

/** state.db 是否还有退役功能的任何痕迹（只读）。 */
function stateHasResidue(db) {
  if (hasTable(db, 'playback_start_results')) return true;
  if (hasTable(db, 'llm_usage') && db.prepare(`SELECT 1 FROM llm_usage WHERE task_id IN (${RETIRED_USAGE_TASKS.map(() => '?').join(',')})
    LIMIT 1`).get(...RETIRED_USAGE_TASKS)) return true;
  if (hasTable(db, 'conversation_turns') && db.prepare(`SELECT 1 FROM conversation_turns WHERE ${SCRIPT_TURN_SQL} LIMIT 1`).get()) return true;
  for (const table of tableNames(db)) {
    if (columnsOf(db, table).has('session_id')
      && db.prepare(`SELECT 1 FROM ${quote(table)} WHERE ${EPISODE_SESSION_SQL('session_id')} LIMIT 1`).get()) return true;
  }
  return runtimePrefNeedsCleanup(readRuntimePref(db));
}

/** 只读收集整集音频在 tts 缓存里的文件名（来自起播记录、播放快照与将被删除的台本）。 */
function collectEpisodeAudioNames(db) {
  const texts = [];
  if (hasTable(db, 'playback_start_results')) {
    for (const row of db.prepare('SELECT result FROM playback_start_results').all()) texts.push(row.result || '');
  }
  const raw = readRuntimePref(db);
  if (raw) {
    try {
      const snapshot = JSON.parse(raw);
      const sessions = [snapshot, ...Object.values(snapshot?.suspendedSessions || {})];
      for (const session of sessions) {
        for (const item of session?.queue || []) if (isEpisodeItem(item)) texts.push(JSON.stringify(item));
        if (session?.radioEpisode) texts.push(JSON.stringify(session.radioEpisode));
      }
    } catch { /* 损坏快照里没有可信的文件名 */ }
  }
  if (hasTable(db, 'conversation_turns')) {
    for (const row of db.prepare(`SELECT message_json FROM conversation_turns
      WHERE ${SCRIPT_TURN_SQL} OR ${EPISODE_SESSION_SQL('session_id')}`).all()) texts.push(row.message_json || '');
  }
  const names = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(/\/tts\/([A-Za-z0-9._-]+\.mp3)/g)) names.add(match[1]);
    for (const match of text.matchAll(/"assetHash"\s*:\s*"([0-9a-f]{64})"/g)) names.add(`${match[1]}.mp3`);
  }
  return [...names];
}

function cleanStateDatabase(db) {
  const removed = {};
  const count = (table, changes) => { if (changes) removed[table] = (removed[table] || 0) + changes; };
  db.transaction(() => {
    const tables = tableNames(db);
    const columns = Object.fromEntries(tables.map(table => [table, columnsOf(db, table)]));
    db.exec(`DROP TABLE IF EXISTS temp.retired_turns; DROP TABLE IF EXISTS temp.retired_requests;
      CREATE TEMP TABLE retired_turns (turn_id TEXT PRIMARY KEY, session_id TEXT, sequence INTEGER);
      CREATE TEMP TABLE retired_requests (request_id TEXT PRIMARY KEY);`);
    if (tables.includes('conversation_turns')) {
      db.exec(`INSERT OR IGNORE INTO temp.retired_turns SELECT turn_id, session_id, sequence FROM conversation_turns
        WHERE ${SCRIPT_TURN_SQL} OR ${EPISODE_SESSION_SQL('session_id')}`);
    }
    if (tables.includes('conversation_requests')) {
      db.exec(`INSERT OR IGNORE INTO temp.retired_requests SELECT request_id FROM conversation_requests
        WHERE ${EPISODE_SESSION_SQL('session_id')}
          OR user_turn_id IN (SELECT turn_id FROM temp.retired_turns)
          OR assistant_turn_id IN (SELECT turn_id FROM temp.retired_turns)`);
    }
    // 普通房间里覆盖到台本的摘要是派生文本，无法逐句剔除，整条删掉等后续重新摘要。
    if (tables.includes('conversation_summaries')) {
      count('conversation_summaries', db.prepare(`DELETE FROM conversation_summaries WHERE EXISTS (
        SELECT 1 FROM temp.retired_turns r WHERE r.session_id = conversation_summaries.session_id
          AND r.sequence BETWEEN conversation_summaries.from_sequence AND conversation_summaries.to_sequence)`).run().changes);
    }
    // 会话行最后删：conversation_turns / conversation_requests 对它有外键。
    const ordered = [...tables.filter(table => table !== 'conversation_sessions'),
      ...tables.filter(table => table === 'conversation_sessions')];
    for (const table of ordered) {
      const cols = columns[table];
      const conditions = [];
      for (const column of TURN_COLUMNS) {
        if (cols.has(column)) conditions.push(`${column} IN (SELECT turn_id FROM temp.retired_turns)`);
      }
      if (cols.has('request_id')) conditions.push('request_id IN (SELECT request_id FROM temp.retired_requests)');
      if (cols.has('session_id')) conditions.push(EPISODE_SESSION_SQL('session_id'));
      if (table === 'llm_usage' && cols.has('task_id')) {
        conditions.push(`task_id IN (${RETIRED_USAGE_TASKS.map(task => `'${task}'`).join(', ')})`);
      }
      if (conditions.length) {
        count(table, db.prepare(`DELETE FROM ${quote(table)} WHERE ${conditions.join(' OR ')}`).run().changes);
      }
      if (cols.has('last_session_id')) {
        db.prepare(`UPDATE ${quote(table)} SET last_session_id = '' WHERE ${EPISODE_SESSION_SQL('last_session_id')}`).run();
      }
    }
    if (tables.includes('playback_start_results')) {
      count('playback_start_results', db.prepare('SELECT COUNT(*) AS n FROM playback_start_results').get().n);
      db.exec('DROP TABLE playback_start_results');
    }
    const raw = readRuntimePref(db);
    if (raw) {
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* 损坏快照交给 hydrate 的安全空闲恢复 */ }
      const { snapshot, changed } = stripRetiredRadioFromRuntimeSnapshot(parsed);
      if (changed) {
        db.prepare(`UPDATE prefs SET v = ? WHERE k = 'playback_runtime_state'`).run(JSON.stringify(snapshot));
        count('prefs', 1);
      }
    }
    db.exec('DROP TABLE temp.retired_turns; DROP TABLE temp.retired_requests;');
  })();
  return removed;
}

/** rw 打开 + checkpoint；busy 表示有活跃读写事务，此刻复制会撕裂。 */
function checkpoint(dbPath, busyTimeoutMs) {
  const db = new Database(dbPath, { timeout: busyTimeoutMs });
  try {
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    if ((result?.[0]?.busy || 0) !== 0) return { busy: true };
    return { busy: false, stats: readTableStats(db) };
  } finally {
    db.close();
  }
}

function backupDatabase(dbPath, backupDir, stats) {
  const name = basename(dbPath);
  copyFileSync(dbPath, join(backupDir, name));
  for (const side of ['-wal', '-shm']) {
    if (existsSync(dbPath + side)) copyFileSync(dbPath + side, join(backupDir, name + side));
  }
  validateCopiedDatabase(join(backupDir, name), stats);
}

function removeDatabaseFiles(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
}

function moveInto(source, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, basename(source));
  try {
    renameSync(source, target);
  } catch {
    cpSync(source, target, { recursive: true });
    rmSync(source, { recursive: true, force: true });
  }
}

function assertIntegrity(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const result = db.pragma('integrity_check');
    if (result?.[0]?.integrity_check !== 'ok') throw new Error(`integrity_check 未通过 (${dbPath})`);
  } finally {
    db.close();
  }
}

function timestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * 执行一次清理。返回 { status: 'already-done' | 'clean' | 'cleaned' | 'source-busy', ... }；
 * 校验失败等异常直接 throw（尚未写 marker，下次启动重试）。
 */
export function runRetiredRadioCleanup({
  dataRoot = resolveDataRoot(),
  now = () => new Date(),
  log = console,
  busyTimeoutMs = 5000,
} = {}) {
  dataRoot = resolve(dataRoot);
  const markerPath = join(dataRoot, RETIRED_RADIO_MARKER);
  if (existsSync(markerPath)) return { status: 'already-done', dataRoot };
  const dataDir = join(dataRoot, 'data');
  const statePath = join(dataDir, 'state.db');
  const lifePath = join(dataDir, 'life.db');
  const taskDir = join(dataRoot, 'tasks', 'daily_program');
  const ttsDir = join(dataRoot, 'cache', 'tts');

  const retiredDatabases = RETIRED_DATABASES.map(name => join(dataDir, name)).filter(path => existsSync(path));
  let stateResidue = false;
  let audioNames = [];
  if (existsSync(statePath)) {
    const db = new Database(statePath, { readonly: true });
    try {
      stateResidue = stateHasResidue(db);
      if (stateResidue) audioNames = collectEpisodeAudioNames(db);
    } finally {
      db.close();
    }
  }
  let lifeResidue = false;
  if (existsSync(lifePath)) {
    const db = new Database(lifePath, { readonly: true });
    try { lifeResidue = hasTable(db, 'life_radio_episode_grants'); } finally { db.close(); }
  }
  const audioFiles = audioNames.map(name => join(ttsDir, name)).filter(path => existsSync(path));
  const writeMarker = report => {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(markerPath, `${JSON.stringify({ completedAt: now().toISOString(), ...report }, null, 2)}\n`, 'utf8');
  };

  if (!stateResidue && !lifeResidue && !retiredDatabases.length && !audioFiles.length && !existsSync(taskDir)) {
    writeMarker({ status: 'clean' });
    return { status: 'clean', dataRoot };
  }

  // ---- 备份：先全部 checkpoint，任何一个 busy 就整体放弃 ----
  const touched = [...(stateResidue ? [statePath] : []), ...(lifeResidue ? [lifePath] : []), ...retiredDatabases];
  const stats = new Map();
  for (const path of touched) {
    const result = checkpoint(path, busyTimeoutMs);
    if (result.busy) {
      log?.warn?.(`[retired-radio] ${basename(path)} 正被其他连接写入，本次跳过清理，下次启动再试`);
      return { status: 'source-busy', dataRoot, database: basename(path) };
    }
    stats.set(path, result.stats);
  }
  const backupDir = join(dataRoot, 'backup', `pre-retire-radio-${timestamp(now())}`);
  mkdirSync(backupDir, { recursive: true });
  for (const path of touched) backupDatabase(path, backupDir, stats.get(path));

  // ---- 清理 ----
  let removed = {};
  if (stateResidue) {
    const db = new Database(statePath);
    try { removed = cleanStateDatabase(db); } finally { db.close(); }
    assertIntegrity(statePath);
  }
  if (lifeResidue) {
    const db = new Database(lifePath);
    try { db.exec('DROP TABLE IF EXISTS life_radio_episode_grants'); } finally { db.close(); }
    assertIntegrity(lifePath);
    removed.life_radio_episode_grants = stats.get(lifePath)?.counts?.life_radio_episode_grants ?? 0;
  }
  // 旧库已在备份目录里有校验过的副本，原位删除即可。
  for (const path of retiredDatabases) removeDatabaseFiles(path);
  for (const file of audioFiles) moveInto(file, join(backupDir, 'tts'));
  if (existsSync(taskDir)) moveInto(taskDir, join(backupDir, 'tasks'));

  const report = { status: 'cleaned', backupDir, removed,
    retiredDatabases: retiredDatabases.map(path => basename(path)), audioFiles: audioFiles.length };
  writeMarker(report);
  log?.info?.(`[retired-radio] 已清理每日节目与连续播客的遗留数据，备份在 ${backupDir}`);
  return { ...report, dataRoot };
}

/**
 * 启动入口：开发/测试的逐路径覆盖下跳过；node --test 子进程（NODE_TEST_CONTEXT）同样跳过，
 * 免得单独跑某个测试文件时碰到真实数据根。失败只告警，不阻断启动。
 */
export function ensureRetiredRadioCleaned({ env = process.env, log = console, now = () => new Date() } = {}) {
  if (PATH_OVERRIDE_ENV.some(name => env[name])) return { status: 'skipped', reason: 'env-override' };
  if (env.NODE_TEST_CONTEXT) return { status: 'skipped', reason: 'test-runner' };
  try {
    return runRetiredRadioCleanup({ dataRoot: resolveDataRoot(), now, log });
  } catch (error) {
    log?.warn?.(`[retired-radio] 遗留数据清理失败，下次启动重试: ${error?.message || error}`);
    return { status: 'failed', error: String(error?.message || error) };
  }
}
