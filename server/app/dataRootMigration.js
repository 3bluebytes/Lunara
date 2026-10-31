// dataRootMigration.js — 仓库布局 → 数据根（~/.lunara 或 LUNARA_DATA_DIR）的一次性迁移。
//
// 顺序契约（add-cli-launch-data-dir design D5-D8，终审核正语义）：
//   第 0 步 源侧隔离：quarantineLegacyRadiohostLayout({cwd: sourceRoot})——隔离先于复制，
//           djhosts 内嵌信号的真旧布局库被整搬进源树 backup/pre-radiohost-*/，绝不复制。
//   第 1 步 源侧读（三层回退）：
//           1) rw 打开 + PRAGMA wal_checkpoint(TRUNCATE)；busy ≠ 0 = 源库存在活跃读写事务，
//              此刻逐字节复制会撕裂 → fail-closed（status:'source-busy'）。注意：空闲第二连接
//              （旧版 Lunara 挂着的典型形态）busy=0，复制的是 checkpoint 后一致快照，安全；
//           2) rw 失败（如库文件 0o444）→ readonly 打开 + 跳过 checkpoint + 源计数；
//           3) 目录级只读（0o555/只读挂载）两者皆败 → 跳过源侧计数，
//              以备份副本作校验基准，status:'source-readonly-degraded'。
//   第 2 步 逐字节 copyFile data/*.db 连同 -wal/-shm 到 <root>/backup/pre-datadir-<ts>/。
//   第 3 步 副本 rw 连接逐表 COUNT 对照源计数 + 表集合相等 + integrity_check（fail-closed，
//           这是「迁移中旧进程活跃写」的真正兜底）。不做单文件 hash（AGENTS.md 明令）。
//   第 4 步 通过才晋升 <root>/data/（backup 副本 rename 过去）+ 复制 user/（排除 *.example
//           与 user/dj；cache/ 默认不迁，--include-cache 才迁）。
//   第 5 步 写 <root>/migration.json marker（含 source；机器级一次性契约）。
//
// 崩溃窗口：晋升式复制失败残留只落 backup/。目标是否可清理不由「有没有 state.db」决定，
// 而由**在途凭据**决定：推进前先写 <root>/.migration-in-progress.json（记 source/targetRoot/
// startedAt/pid），成功才移除。目标已有 data/*.db 时：有 migration.json → 拒绝；无 marker 但
// 凭据与本次 source+targetRoot 都匹配 → 认定为自己上次失败的残留，按既有范围清理后重跑；
// 其余任何非空目标（正常使用过的安装也在内）→ refused-target-not-empty，绝不删除。
// 源与目标同实体（含符号链接别名）→ refused-source-equals-target，零写入。
// 凭据保留到成功为止，因此「失败窗口可重试」在自动路径上第一次真正成立。
//
// 敏感域：backup/pre-datadir-* 与 migration.json 属数据根敏感域（库副本内嵌 ncm/qq
// cookie 字段；marker 含源路径），保留至用户手动清理，禁入可分享日志。
//
// 本模块只依赖 runtimePaths + node:fs + better-sqlite3 + legacyCutover.js，
// 不 import state.js（避免迁移逻辑依赖启动链路）。

import Database from 'better-sqlite3';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveDataRoot } from '../runtimePaths.js';
import { detectLegacyRadiohostLayout, quarantineLegacyRadiohostLayout } from '../legacyCutover.js';

/**
 * 在途凭据（fix-release-blocking-defects）。
 *
 * 它是「目标里的东西是我自己上次写坏的」的唯一凭据：只有同时匹配本次 source 与 targetRoot
 * 才允许清理目标 data/。凭据在决定推进后、首个目标写入前落盘，成功时移除，失败时保留。
 */
export const IN_PROGRESS_MARKER = '.migration-in-progress.json';

/** 两个路径是否指向同一文件系统实体（含符号链接别名）；任一侧不可解析时退回字面比较。 */
function sameEntity(left, right) {
  if (!left || !right) return false;
  const real = value => { try { return realpathSync(value); } catch { return resolve(String(value)); } };
  return real(left) === real(right);
}

/** 数据根里已存在的数据库文件名（`data/*.db`）。目录缺失视为空。 */
export function targetDatabaseNames(targetRoot = resolveDataRoot()) {
  const dir = join(resolve(targetRoot), 'data');
  if (!existsSync(dir)) return [];
  try { return readdirSync(dir).filter(name => name.endsWith('.db')); } catch { return []; }
}

function readInProgressCredential(targetRoot) {
  try { return JSON.parse(readFileSync(join(resolve(targetRoot), IN_PROGRESS_MARKER), 'utf8')); }
  catch { return null; }
}

/** 凭据是否属于本次迁移：source 与 targetRoot 必须都匹配，缺一不可。 */
function credentialBelongsTo(credential, { sourceRoot, targetRoot }) {
  if (!credential || typeof credential !== 'object') return false;
  if (resolve(String(credential.targetRoot || '')) !== resolve(targetRoot)) return false;
  return sameEntity(credential.source, sourceRoot);
}

/** 自动迁移的源：LUNARA_LEGACY_DATA_DIR 显式优先，否则 cwd 含 data/state.db 即认定。 */
export function detectLegacySourceRoot({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.LUNARA_LEGACY_DATA_DIR) return resolve(env.LUNARA_LEGACY_DATA_DIR);
  if (existsSync(join(resolve(cwd), 'data', 'state.db'))) return resolve(cwd);
  return null;
}

export function readTableStats(db) {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all()
    .map(row => row.name);
  const counts = {};
  let rows = 0;
  for (const table of tables) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get().n || 0;
    counts[table] = n;
    rows += n;
  }
  return { tables, counts, rows };
}

/**
 * 副本校验：integrity_check 必为 ok；提供 {tables,counts} 时逐表对照（fail-closed）。
 * 未提供对照（目录级只读源降级）时仅做完整性检查并返回副本自身统计。
 */
export function validateCopiedDatabase(copyPath, { tables, counts } = {}) {
  const db = new Database(copyPath, { readonly: true });
  try {
    const integrity = db.pragma('integrity_check');
    if (integrity?.[0]?.integrity_check !== 'ok') {
      throw new Error(`integrity_check 未通过 (${copyPath}): ${JSON.stringify(integrity?.[0])}`);
    }
    const stats = readTableStats(db);
    if (tables && counts) {
      const missing = tables.filter(name => !stats.tables.includes(name));
      const extra = stats.tables.filter(name => !tables.includes(name));
      if (missing.length || extra.length) {
        throw new Error(`表集合不一致 (copy=${copyPath}) 缺少: [${missing}] 多出: [${extra}]`);
      }
      for (const [table, expected] of Object.entries(counts)) {
        if (stats.counts[table] !== expected) {
          throw new Error(`表 ${table} 行数校验失败: 源 ${expected} vs 副本 ${stats.counts[table]}`);
        }
      }
    }
    return stats;
  } finally {
    db.close();
  }
}

/**
 * 三层回退打开源库。返回：
 *   { level: 'rw', db, stats }    — 可 checkpoint、源计数可得
 *   { level: 'readonly', db, stats } — 跳过 checkpoint、源计数可得
 *   { level: 'none' }             — 目录级只读，跳过源侧计数（降级）
 * busy ≠ 0 时关闭连接并返回 { level: 'busy' }（活跃读写事务，复制会撕裂）。
 */
function openSourceDatabase(dbPath) {
  // 1) rw 打开：可 checkpoint(TRUNCATE)，规避副本侧 WAL 恢复依赖。
  let db;
  try {
    db = new Database(dbPath);
    try {
      const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)');
      if ((checkpoint?.[0]?.busy || 0) !== 0) {
        db.close();
        return { level: 'busy' };
      }
      return { level: 'rw', db, stats: readTableStats(db) };
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (rwError) {
    if (rwError?.code === 'SQLITE_BUSY' || /database is locked/i.test(String(rwError?.message))) {
      // 连接竞争同属活跃读写事务信号：等同 busy fail-closed。
      try { db?.close(); } catch { /* already closed */ }
      return { level: 'busy' };
    }
    // 2) 目录可写但库文件只读等场景：readonly 打开（SQLite 需建 -shm，目录级只读会失败）。
    try {
      db = new Database(dbPath, { readonly: true });
      return { level: 'readonly', db, stats: readTableStats(db) };
    } catch {
      // 3) 目录级只读：两层皆败，跳过源侧计数，以备份副本为校验基准。
      return { level: 'none' };
    }
  }
}

/**
 * 执行一次迁移。返回机器可读报告（status: ok | dry-run | source-busy |
 * source-readonly-degraded | refused-target-not-empty），不 throw 业务失败；
 * ensureDataRootReady（自动路径）收到非成功 status 时自行 fail-closed。
 */
export function runMigration({
  sourceRoot,
  targetRoot,
  dryRun = false,
  includeCache = false,
  now = () => new Date(),
  log = console,
} = {}) {
  sourceRoot = resolve(sourceRoot);
  targetRoot = resolve(targetRoot);
  const sourceDataDir = join(sourceRoot, 'data');
  const targetDataDir = join(targetRoot, 'data');
  const targetStateDb = join(targetDataDir, 'state.db');
  const markerPath = join(targetRoot, 'migration.json');

  // ---- dry-run：零写入含源侧（不隔离、不 rw/checkpoint、不写目标）----
  if (dryRun) {
    const layout = detectLegacyRadiohostLayout({ cwd: sourceRoot });
    return {
      status: 'dry-run',
      sourceRoot,
      targetRoot,
      sourceFiles: existsSync(sourceDataDir) ? readdirSync(sourceDataDir) : [],
      targetStateDbExists: existsSync(targetStateDb),
      wouldQuarantine: {
        legacyDir: layout.legacyDir,
        legacyDb: layout.legacyDb,
        triggered: layout.legacyDir || layout.legacyDb,
      },
      includeCache,
      // 已知限制：目录级只读源下 djhosts 内嵌信号是假阴性（readonly 探测被吞）。
    };
  }

  // ---- 源与目标同实体：绝不自我迁移 ----
  if (sameEntity(sourceRoot, targetRoot)) {
    return { status: 'refused-source-equals-target', sourceRoot, targetRoot,
      hint: '源目录与数据根指向同一处（或互为符号链接），不需要迁移；未做任何写入。' };
  }

  // ---- 目标状态判定：只认可归属的残留，其余一律拒绝且零删除 ----
  const hasMarker = existsSync(markerPath);
  const occupied = targetDatabaseNames(targetRoot);
  if (hasMarker && occupied.length) {
    return { status: 'refused-target-not-empty', sourceRoot, targetRoot };
  }
  if (!hasMarker && occupied.length) {
    const credential = readInProgressCredential(targetRoot);
    if (!credentialBelongsTo(credential, { sourceRoot, targetRoot })) {
      return { status: 'refused-target-not-empty', sourceRoot, targetRoot,
        hint: '数据根里已有数据，且没有本次迁移的在途凭据，因此不会被清理或接管。'
          + '如需迁移到已有数据的位置，请先自行备份并手动清空该位置。' };
    }
    // 凭据匹配：承认这是本次迁移上次失败留下的部分晋升，清理范围仅限 data/ 与完成标记。
    rmSync(targetDataDir, { recursive: true, force: true });
    rmSync(markerPath, { force: true });
  }

  // ---- 在途凭据：决定推进后、首个目标写入前落盘 ----
  const inProgressPath = join(targetRoot, IN_PROGRESS_MARKER);
  writeFileSync(inProgressPath, `${JSON.stringify({ source: sourceRoot, targetRoot,
    startedAt: now().toISOString(), pid: process.pid }, null, 2)}\n`, 'utf8');

  // ---- 第 0 步：源侧隔离（先于复制，作用于源）----
  const quarantine = quarantineLegacyRadiohostLayout({ cwd: sourceRoot, now });
  const quarantined = !!quarantine.triggered;
  if (quarantined) {
    log?.warn?.(`[data-root] 源 ${sourceRoot} 检出旧布局（user/dj 或 djhosts 信号），已整搬隔离到 ${quarantine.backupDir}；不复制旧布局库，新根从全新库开始`);
  }

  // ---- 第 1-3 步：三层回退读源 → 复制 → 副本校验 ----
  const timestamp = now().toISOString().replaceAll(/[:.]/g, '-');
  const backupDir = join(targetRoot, 'backup', `pre-datadir-${timestamp}`);
  mkdirSync(backupDir, { recursive: true });

  const dbFiles = (!quarantined && existsSync(sourceDataDir))
    ? readdirSync(sourceDataDir).filter(name => name.endsWith('.db'))
    : [];
  const databases = [];
  let degraded = false;

  for (const name of dbFiles) {
    const sourceDbPath = join(sourceDataDir, name);
    const attempt = openSourceDatabase(sourceDbPath);
    if (attempt.level === 'busy') {
      // fail-closed：此刻逐字节复制会撕裂。清掉刚建的空 backup 目录，保持目标干净。
      rmSync(backupDir, { recursive: true, force: true });
      return {
        status: 'source-busy',
        sourceRoot,
        targetRoot,
        database: name,
        hint: '源库存在活跃读写事务（此刻复制会撕裂）。建议退出正在写入旧版数据的进程后重试；空闲挂起的旧进程不影响迁移。',
      };
    }

    const copied = [name];
    copyFileSync(sourceDbPath, join(backupDir, name));
    for (const side of ['-wal', '-shm']) {
      if (existsSync(sourceDbPath + side)) {
        copyFileSync(sourceDbPath + side, join(backupDir, name + side));
        copied.push(name + side);
      }
    }

    // 第 3 步：副本校验是「迁移中旧进程活跃写」的真正兜底。
    const sourceStats = attempt.level === 'none' ? null : { tables: attempt.stats.tables, counts: attempt.stats.counts };
    const copyStats = validateCopiedDatabase(join(backupDir, name), sourceStats || {});
    if (attempt.level === 'none') degraded = true;
    databases.push({ name, tables: copyStats.tables.length, rows: copyStats.rows, sourceLevel: attempt.level });
  }

  // ---- 第 4 步：晋升 data/ + 复制 user/ ----
  // 晋升用 copy（而非 rename）：backup/pre-datadir-*/ 内的副本 literal 保留
  //（敏感域说明成立——副本含 ncm/qq cookie 字段，保留至用户手动清理）；
  // 源树、backup 副本、正式库三份一致，任一环节失败均无 marker、可安全重跑。
  mkdirSync(targetDataDir, { recursive: true });
  for (const name of dbFiles) {
    for (const suffix of ['', '-wal', '-shm']) {
      const staged = join(backupDir, name + suffix);
      if (existsSync(staged)) copyFileSync(staged, join(targetDataDir, name + suffix));
    }
  }

  const sourceUserDir = join(sourceRoot, 'user');
  if (existsSync(sourceUserDir)) {
    cpSync(sourceUserDir, join(targetRoot, 'user'), {
      recursive: true,
      filter: (from) => {
        const base = from.split(/[\\/]/).pop();
        if (base.endsWith('.example')) return false;
        if (from.split(/[\\/]/).includes('dj')) return false; // user/dj 纯防御排除
        return true;
      },
    });
  }
  const sourceCacheDir = join(sourceRoot, 'cache');
  if (includeCache && existsSync(sourceCacheDir)) {
    cpSync(sourceCacheDir, join(targetRoot, 'cache'), { recursive: true });
  }

  // ---- 第 5 步：marker（机器级一次性契约）----
  const status = degraded ? 'source-readonly-degraded' : 'ok';
  const marker = {
    status,
    migratedAt: now().toISOString(),
    source: sourceRoot,
    targetRoot,
    backupDir,
    databases,
    degraded,
    ...(quarantined ? { quarantinedSourceBackup: quarantine.backupDir } : {}),
  };
  writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  rmSync(inProgressPath, { force: true });
  log?.warn?.(`[data-root] 已把 ${sourceRoot} 的数据迁移到 ${targetRoot}（源保留未删；报告: ${markerPath}）`);

  return marker;
}

/**
 * 生产 bootstrap：在 state.js 打开任何 SQLite 连接之前调用（模块加载期）。
 * 三覆盖 env 任一存在即视为显式/开发场景，全部自动化跳过。
 */
export function ensureDataRootReady({ env = process.env, cwd = process.cwd(), log = console, now = () => new Date() } = {}) {
  if (env.LUNARA_DB_PATH || env.LUNARA_RADIOHOST_DIR || env.LUNARA_DATA_DIR) {
    return { triggered: false, reason: 'env-override' };
  }
  const targetRoot = resolveDataRoot();
  const markerPath = join(targetRoot, 'migration.json');

  if (existsSync(markerPath)) {
    let marker = null;
    try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch { /* 损坏 marker 按不存在处理 */ }
    const source = detectLegacySourceRoot({ env, cwd });
    if (marker?.source && source && marker.source !== resolve(source)) {
      log?.warn?.(`[data-root] 迁移 marker 记录的来源（${marker.source}）与当前探测源（${resolve(source)}）不同，跳过自动迁移`);
    }
    // 尾部目标侧隔离：带外保险（幂等）。
    quarantineLegacyRadiohostLayout({ cwd: targetRoot, now });
    return { triggered: false, reason: 'marker-present' };
  }

  const source = detectLegacySourceRoot({ env, cwd });
  if (targetDatabaseNames(targetRoot).length) {
    // 目标已有数据、无 marker：默认不接管、不删除。唯一例外是「本次迁移自己的失败残留」——
    // 只有在途凭据同时匹配本次源与目标根时才继续；否则显式 lunara migrate 也会拒绝。
    const credential = readInProgressCredential(targetRoot);
    if (!source || !credentialBelongsTo(credential, { sourceRoot: source, targetRoot })) {
      return { triggered: false, reason: 'target-not-empty' };
    }
  }

  if (!source) {
    quarantineLegacyRadiohostLayout({ cwd: targetRoot, now });
    return { triggered: false, reason: 'no-legacy-source' };
  }
  if (sameEntity(source, targetRoot)) {
    return { triggered: false, reason: 'source-equals-target' };
  }

  let report;
  try {
    report = runMigration({ sourceRoot: source, targetRoot, now, log });
  } catch (error) {
    // fail-closed（仿 legacyCutover）：迁移失败继续写库会造成两套状态，必须显式失败。
    log?.error?.(`[data-root] 首启动迁移失败: ${error?.message || error}`);
    throw error;
  }
  if (report.status !== 'ok' && report.status !== 'source-readonly-degraded') {
    throw new Error(`[data-root] 首启动迁移未完成: ${report.status}${report.hint ? ` — ${report.hint}` : ''}`);
  }
  if (report.status === 'source-readonly-degraded') {
    log?.warn?.('[data-root] 源目录只读，跳过源侧逐表计数，以备份副本为校验基准（source-readonly-degraded）');
  }
  return { triggered: true, status: report.status, sourceRoot: source, targetRoot };
}

export default { IN_PROGRESS_MARKER, detectLegacySourceRoot, runMigration, ensureDataRootReady, validateCopiedDatabase, targetDatabaseNames };
