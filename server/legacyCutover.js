// legacyCutover.js — rename-dj-to-radiohost 的一次性旧布局隔离切换（design D4）。
//
// 硬切换：不做任何读兼容。在**任何 SQLite 连接打开之前**调用本模块：
// 检测到旧布局信号（默认人格根下的 user/dj/ 目录，或默认库中的 djhosts 表 /
// virtual_persons.kind='dj' 行）时，把 user/dj/ 与 data/ 整体**移动**到
// backup/pre-radiohost-<时间戳>/（保留原始相对布局），然后按新布局重建
// user/radiohost/ 空目录。文件级整体移动（而非表级迁移）保证无部分失败状态，
// 且天然满足「带备份」。
//
// 自定义 LUNARA_DB_PATH / LUNARA_RADIOHOST_DIR 属开发场景，不做自动检测，
// 需要时手动处理旧目录（见 .env.example 注释）。

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 检测默认布局下的旧格式信号。
 * @returns {{ legacyDir: boolean, legacyDb: boolean }}
 */
export function detectLegacyRadiohostLayout({ cwd = process.cwd() } = {}) {
  const legacyDir = existsSync(resolve(cwd, 'user/dj'));
  let legacyDb = false;
  const dbPath = resolve(cwd, 'data/state.db');
  if (!legacyDir && existsSync(dbPath)) {
    try {
      // 调用方保证此刻尚无其他连接；只读探测后立即关闭。
      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(row => row.name);
        if (tables.includes('djhosts')) {
          legacyDb = true;
        } else if (tables.includes('virtual_persons')) {
          legacyDb = (db.prepare(`SELECT COUNT(*) AS n FROM virtual_persons WHERE kind = 'dj'`).get().n || 0) > 0;
        }
      } finally {
        db.close();
      }
    } catch {
      // 库打不开（损坏/被锁）时不触发隔离：不能凭模糊信号搬走用户数据，
      // 让正常启动按原样失败并暴露真实错误。
      legacyDb = false;
    }
  }
  return { legacyDir, legacyDb };
}

/**
 * 执行一次旧布局隔离。幂等：无信号时不做任何事。
 * @returns {{ triggered: boolean, backupDir?: string, reason?: string }}
 */
export function quarantineLegacyRadiohostLayout({ cwd = process.cwd(), now = () => new Date() } = {}) {
  const { legacyDir, legacyDb } = detectLegacyRadiohostLayout({ cwd });
  if (!legacyDir && !legacyDb) return { triggered: false, reason: 'no-legacy-layout' };

  const timestamp = now().toISOString().replaceAll(/[:.]/g, '-');
  const backupDir = resolve(cwd, `backup/pre-radiohost-${timestamp}`);
  mkdirSync(resolve(backupDir, 'user'), { recursive: true });

  // 只移动存在的部分；rename 同盘原子，隔离目录内保持原始相对布局。
  if (legacyDir) renameSync(resolve(cwd, 'user/dj'), resolve(backupDir, 'user/dj'));
  if (existsSync(resolve(cwd, 'data'))) renameSync(resolve(cwd, 'data'), resolve(backupDir, 'data'));

  // 按新布局重建：库文件由后续启动链路（state.js 等）创建全新数据库。
  mkdirSync(resolve(cwd, 'user/radiohost'), { recursive: true });
  return { triggered: true, backupDir };
}

/**
 * 生产入口：默认布局才自动隔离；显式覆盖路径属开发场景，一律跳过。
 * 在 state.js 打开数据库之前调用（模块加载期），保证「打开 SQLite 之前」语义。
 */
export function ensureLegacyRadiohostCutover({ cwd = process.cwd(), env = process.env, log = console } = {}) {
  // LUNARA_DATA_DIR 与每路径 env 同属显式/开发场景：数据根 change 后统一跳过自动化。
  if (env.LUNARA_DB_PATH || env.LUNARA_RADIOHOST_DIR || env.LUNARA_DATA_DIR) {
    return { triggered: false, reason: 'env-override' };
  }
  try {
    const result = quarantineLegacyRadiohostLayout({ cwd });
    if (result.triggered) {
      log?.warn?.(`[legacy-cutover] 已把旧角色数据整体隔离到 ${result.backupDir}（rename-dj-to-radiohost 硬切换，不保留读兼容）`);
    }
    return result;
  } catch (error) {
    // 隔离失败不能静默吞掉：带备份的硬切换失败意味着旧数据仍在原位，
    // 此时继续用新代码写库会造成两套格式混写，必须让启动显式失败。
    log?.error?.(`[legacy-cutover] 旧布局隔离失败: ${error?.message || error}`);
    throw error;
  }
}
