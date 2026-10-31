// legacyCutover.test.js — rename-dj-to-radiohost D4 一次性隔离切换。
//
// 覆盖 radiohost-terminology spec 的 Legacy DJ data cutover requirement：
//   - 首次启动检测旧布局（user/dj/ 目录、djhosts 表、kind='dj' 行）→ 整体移动到
//     backup/pre-radiohost-<ts>/ 并重建新布局；
//   - 二次启动不再触发；
//   - 自定义 LUNARA_* 路径属开发场景，不自动处理；
//   - backup/ 必须在 .gitignore（私人数据备份不进仓库）。
//
// 本文件被 productIdentity.test.js 的 dj 扫描白名单豁免：隔离切换的单测
// 必须引用旧标识（user/dj、djhosts、kind='dj'），它们就是被检测的信号本身。
//
// Run: node server/legacyCutover.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureLegacyRadiohostCutover, quarantineLegacyRadiohostLayout } from './legacyCutover.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeSandbox({ withLegacyDir = false, legacyDb = null } = {}) {
  const cwd = mkdtempSync(resolve(tmpdir(), 'lunara-cutover-test-'));
  if (withLegacyDir) {
    mkdirSync(join(cwd, 'user/dj/host_a'), { recursive: true });
    writeFileSync(join(cwd, 'user/dj/host_a/persona.md'), '# 旧人格', 'utf8');
  }
  if (legacyDb) {
    mkdirSync(join(cwd, 'data'), { recursive: true });
    const db = new Database(join(cwd, 'data/state.db'));
    db.exec(legacyDb);
    db.close();
  }
  return cwd;
}

function backupEntries(cwd) {
  const backupRoot = join(cwd, 'backup');
  if (!existsSync(backupRoot)) return [];
  return readdirSync(backupRoot).filter(name => name.startsWith('pre-radiohost-'));
}

test('首次启动：user/dj 与旧库整体隔离到 backup/pre-radiohost-<ts>/', () => {
  const cwd = makeSandbox({
    withLegacyDir: true,
    legacyDb: `CREATE TABLE djhosts (id TEXT PRIMARY KEY); INSERT INTO djhosts (id) VALUES ('dj_abc');`,
  });
  const result = quarantineLegacyRadiohostLayout({ cwd });
  assert.equal(result.triggered, true);

  const entries = backupEntries(cwd);
  assert.equal(entries.length, 1, `应只有一个时间戳隔离目录，实际: ${entries}`);
  const quarantined = join(cwd, 'backup', entries[0]);
  assert.ok(existsSync(join(quarantined, 'user/dj/host_a/persona.md')), '旧 persona 随目录整体保留');
  assert.ok(existsSync(join(quarantined, 'data/state.db')), '旧数据库整体保留（含 -wal/-shm）');

  assert.ok(!existsSync(join(cwd, 'user/dj')), '旧目录不再存在于原位');
  assert.ok(!existsSync(join(cwd, 'data/state.db')), '旧库不再存在于原位');
  assert.ok(existsSync(join(cwd, 'user/radiohost')), '新布局目录已重建');
});

test('无 user/dj 时仍检测旧库信号（djhosts 表 / kind=dj 行）', () => {
  const withTable = makeSandbox({
    legacyDb: `CREATE TABLE djhosts (id TEXT PRIMARY KEY);`,
  });
  assert.equal(quarantineLegacyRadiohostLayout({ cwd: withTable }).triggered, true);
  assert.ok(!existsSync(join(withTable, 'data/state.db')), '旧库已被隔离');

  const withKindRow = makeSandbox({
    legacyDb: `
      CREATE TABLE virtual_persons (id TEXT PRIMARY KEY, kind TEXT NOT NULL);
      INSERT INTO virtual_persons (id, kind) VALUES ('dj_old', 'dj');`,
  });
  assert.equal(quarantineLegacyRadiohostLayout({ cwd: withKindRow }).triggered, true);
});

test('二次启动：新布局不再触发隔离', () => {
  const cwd = makeSandbox({ withLegacyDir: true });
  const first = quarantineLegacyRadiohostLayout({ cwd });
  assert.equal(first.triggered, true);

  // 模拟新布局下的全新数据库（radiohosts 表、kind='radiohost'）。
  mkdirSync(join(cwd, 'data'), { recursive: true });
  const db = new Database(join(cwd, 'data/state.db'));
  db.exec(`CREATE TABLE radiohosts (id TEXT PRIMARY KEY);`);
  db.close();

  const second = quarantineLegacyRadiohostLayout({ cwd });
  assert.equal(second.triggered, false, '第二次启动不应触发');
  assert.equal(backupEntries(cwd).length, 1, '不会产生第二个隔离目录');
});

test('自定义 LUNARA_DB_PATH / LUNARA_RADIOHOST_DIR 属开发场景，不自动隔离', () => {
  const cwd = makeSandbox({ withLegacyDir: true });
  const result = ensureLegacyRadiohostCutover({
    cwd,
    env: { LUNARA_DB_PATH: '/tmp/custom/state.db' },
  });
  assert.equal(result.triggered, false, '设置了 LUNARA_DB_PATH 时跳过');
  assert.ok(existsSync(join(cwd, 'user/dj')), '旧目录原样保留');

  const result2 = ensureLegacyRadiohostCutover({
    cwd,
    env: { LUNARA_RADIOHOST_DIR: '/tmp/custom/user/radiohost' },
  });
  assert.equal(result2.triggered, false, '设置了 LUNARA_RADIOHOST_DIR 时跳过');
});

test('backup/ 在 .gitignore 中（私人数据备份不进仓库）', async () => {
  const gitignore = await readFile(join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^backup\/?$/m, '.gitignore 应包含 backup/ 条目');
});

test('LUNARA_DATA_DIR 存在时同样跳过自动隔离（数据根 change：显式覆盖即开发场景）', () => {
  const sandbox = makeSandbox({ withLegacyDir: true });
  const result = ensureLegacyRadiohostCutover({
    cwd: sandbox,
    env: { LUNARA_DATA_DIR: '/tmp/lunara-home' },
  });
  assert.equal(result.triggered, false);
  assert.equal(result.reason, 'env-override');
  assert.ok(existsSync(join(sandbox, 'user/dj')), '旧目录原样保留');
  assert.equal(backupEntries(sandbox).length, 0, '不产生隔离备份');
});
