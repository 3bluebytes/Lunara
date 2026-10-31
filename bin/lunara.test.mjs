// lunara.test.mjs — bin/lunara.js CLI 契约（add-cli-launch-data-dir）。
//
// 覆盖：参数默认值与 env 注入、--data-dir 与残留每路径 env 的冲突告警、
// nativeModuleHint（注入合成 error 对象——require 探针是假阴性，不用作触发器）、
// migrate 报告与退出码、desktop 缺 Electron 回退、version/help。
// 端到端子进程用例会真实 spawn bin：migrate --dry-run 零写入（fixture mtime 不变）。
//
// Run: node --test bin/lunara.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  PACKAGE_ROOT,
  applyCliEnv,
  inspectElectronInstall,
  nativeModuleHint,
  parseCliArgs,
  resolveDesktopLaunch,
  statusExitCode,
  warnDataDirConflicts,
} from './lunara.js';

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), 'lunara.js');

function tempRoot(label) {
  return mkdtempSync(resolve(tmpdir(), `lunara-bin-${label}-`));
}

// ---- parseCliArgs ----

test('parseCliArgs：默认 profile web', () => {
  assert.equal(parseCliArgs([]).profile, 'web');
});

test('parseCliArgs：--profile desktop / --data-dir / --port / --host / migrate 参数', () => {
  const args = parseCliArgs(['--profile', 'desktop', '--data-dir', '/tmp/dr', '--port', '9090', '--host', '0.0.0.0']);
  assert.equal(args.profile, 'desktop');
  assert.equal(args.dataDir, '/tmp/dr');
  assert.equal(args.port, '9090');
  assert.equal(args.host, '0.0.0.0');

  const migrate = parseCliArgs(['migrate', '--source', '/repo', '--dry-run', '--include-cache']);
  assert.equal(migrate.migrate, true);
  assert.equal(migrate.source, '/repo');
  assert.equal(migrate.dryRun, true);
  assert.equal(migrate.includeCache, true);
});

test('parseCliArgs：--version 与 --help', () => {
  assert.equal(parseCliArgs(['--version']).version, true);
  assert.equal(parseCliArgs(['--help']).help, true);
});

// ---- env 注入（在任何服务端 import 之前） ----

test('applyCliEnv：--data-dir/--port/--host 写入对应 env', () => {
  const env = {};
  applyCliEnv({ dataDir: '/tmp/dr', port: '9090', host: '0.0.0.0' }, env);
  assert.equal(env.LUNARA_DATA_DIR, '/tmp/dr');
  assert.equal(env.PORT, '9090');
  assert.equal(env.LUNARA_HOST, '0.0.0.0');
});

test('applyCliEnv：未传参数时不写入', () => {
  const env = {};
  applyCliEnv({}, env);
  assert.deepEqual(env, {});
});

// ---- --data-dir 与残留每路径 env 冲突告警（含 dotenv 注入后的 env） ----

test('warnDataDirConflicts：残留 LUNARA_DB_PATH/RADIOHOST_DIR 时告警优先级与实际路径', () => {
  const warnings = [];
  const env = { LUNARA_DB_PATH: 'relative/state.db', LUNARA_DATA_DIR: '/tmp/dr' };
  warnDataDirConflicts({ env, log: { warn: m => warnings.push(String(m)) } });
  assert.equal(warnings.length, 1, `应合并为一条告警，实际: ${warnings}`);
  assert.match(warnings[0], /LUNARA_DB_PATH/);
  assert.match(warnings[0], /更高优先级|优先/);
  assert.match(warnings[0], /跳过自动迁移/);
});

test('warnDataDirConflicts：无残留 env 时静默', () => {
  const warnings = [];
  warnDataDirConflicts({ env: { LUNARA_DATA_DIR: '/tmp/dr' }, log: { warn: m => warnings.push(String(m)) } });
  assert.equal(warnings.length, 0);
});

// ---- nativeModuleHint：合成 error 注入（require 探针是假阴性） ----

test('nativeModuleHint：ERR_DLOPEN_FAILED → rebuild:node 指引', () => {
  const hint = nativeModuleHint(Object.assign(new Error("was compiled against a different Node.js version"), { code: 'ERR_DLOPEN_FAILED' }));
  assert.match(hint, /rebuild:node/);
});

test('nativeModuleHint：NODE_MODULE_VERSION 文本 → 同一指引', () => {
  const hint = nativeModuleHint(new Error('MODULE_NOT_LINKED: NODE_MODULE_VERSION 140 与 137 不符'));
  assert.match(hint, /rebuild:node/);
});

test('nativeModuleHint：普通错误返回 null（不吞真实故障）', () => {
  assert.equal(nativeModuleHint(new Error('ENOENT: no such file')), null);
  assert.equal(nativeModuleHint(null), null);
});

// ---- migrate 报告退出码映射 ----

test('statusExitCode：成功态 0、失败态 1', () => {
  assert.equal(statusExitCode('ok'), 0);
  assert.equal(statusExitCode('dry-run'), 0);
  assert.equal(statusExitCode('source-readonly-degraded'), 0);
  assert.equal(statusExitCode('source-busy'), 1);
  assert.equal(statusExitCode('refused-target-not-empty'), 1);
  // 源与目标同实体也属于「拒绝、且没有产出部分状态」，不能当成功。
  assert.equal(statusExitCode('refused-source-equals-target'), 1);
});

// ---- desktop 档：Electron 缺失回退（locator 注入） ----

test('inspectElectronInstall：无 electron 的目录返回 not ready', () => {
  const root = tempRoot('noelectron');
  try {
    const result = inspectElectronInstall({ root });
    assert.equal(result.ready, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveDesktopLaunch：locator not ready → web 回退 + 指引', () => {
  const logs = [];
  const launch = resolveDesktopLaunch({
    inspect: () => ({ ready: false }),
    log: { warn: m => logs.push(String(m)), log: m => logs.push(String(m)) },
  });
  assert.equal(launch.mode, 'web-fallback');
  assert.equal(logs.some(m => /rebuild:electron|npm install|回退/.test(m)), true, `应有指引，实际: ${logs}`);
});

test('resolveDesktopLaunch：ready → electron 档携带二进制路径', () => {
  const launch = resolveDesktopLaunch({
    inspect: () => ({ ready: true, binaryPath: '/fake/electron' }),
    log: { warn() {}, log() {} },
  });
  assert.equal(launch.mode, 'electron');
  assert.equal(launch.binaryPath, '/fake/electron');
});

// ---- 端到端：--version / --help / migrate --dry-run（真实 spawn） ----

test('端到端：lunara --version 打印包版本并退出 0', () => {
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const r = spawnSync(process.execPath, [BIN_PATH, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('端到端：lunara --help 打印用法', () => {
  const r = spawnSync(process.execPath, [BIN_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--profile/);
});

test('端到端：migrate --dry-run 输出 dry-run 报告、零写入、fixture mtime 不变、exit 0', () => {
  const fixture = tempRoot('fixture');
  const target = tempRoot('target');
  const env = {
    ...process.env,
    LUNARA_DATA_DIR: target,
    LUNARA_CONFIG_DIR: tempRoot('cfg'),
    CLAUDIO_CONFIG_DIR: tempRoot('legacy'),
  };
  try {
    mkdirSync(join(fixture, 'data'), { recursive: true });
    mkdirSync(join(fixture, 'user'), { recursive: true });
    writeFileSync(join(fixture, 'data', 'state.db'), Buffer.from('SQLite format 3 fixture', 'utf8'));
    writeFileSync(join(fixture, 'user', 'taste.md'), '# fixture\n', 'utf8');
    const mtimesBefore = readdirSync(fixture, { recursive: true }).sort()
      .map(p => `${p}:${statSync(join(fixture, p)).mtimeMs}`);

    const r = spawnSync(
      process.execPath,
      [BIN_PATH, 'migrate', '--dry-run', '--source', fixture, '--data-dir', target],
      { encoding: 'utf8', env },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const reportStart = r.stdout.indexOf('{');
    assert.ok(reportStart >= 0, `stdout 应含 JSON 报告: ${r.stdout}`);
    const report = JSON.parse(r.stdout.slice(reportStart));
    assert.equal(report.status, 'dry-run');
    assert.equal(report.targetStateDbExists, false);
    assert.equal(existsSync(join(target, 'data')), false, 'dry-run 零写入目标');
    const mtimesAfter = readdirSync(fixture, { recursive: true }).sort()
      .map(p => `${p}:${statSync(join(fixture, p)).mtimeMs}`);
    assert.deepEqual(mtimesAfter, mtimesBefore, 'fixture 文件集合与 mtime 不变');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    for (const key of ['LUNARA_CONFIG_DIR', 'CLAUDIO_CONFIG_DIR']) {
      if (env[key]) rmSync(env[key], { recursive: true, force: true });
    }
  }
});

// ---- bin 入口可加载性 ----

test('bin 模块可安全导入：导出齐全且主入口守卫不触发 main', async () => {
  const bin = await import('./lunara.js');
  for (const name of [
    'parseCliArgs', 'applyCliEnv', 'warnDataDirConflicts', 'nativeModuleHint',
    'statusExitCode', 'inspectElectronInstall', 'resolveDesktopLaunch', 'openBrowser', 'main',
  ]) {
    assert.equal(typeof bin[name], 'function', `应导出 ${name}`);
  }
  assert.equal(bin.PACKAGE_ROOT, resolve(dirname(BIN_PATH), '..'), 'PACKAGE_ROOT 应为 bin 的上一级（仓库/安装根）');
  // 守卫生效：导入过程没有执行 main（无启动输出、进程未被 exit）。
  assert.equal(process.exitCode, undefined);
});

// ---- 显式 lunara migrate 子命令端到端（非 dry-run：备份 + 表级校验 + 源保留） ----

test('端到端：lunara migrate 非 dry-run 完成迁移，备份留存、表级校验通过、源保留', () => {
  const fixture = tempRoot('migrate-src');
  const target = tempRoot('migrate-target');
  const env = {
    ...process.env,
    LUNARA_DATA_DIR: target,
    LUNARA_CONFIG_DIR: tempRoot('cfg'),
    CLAUDIO_CONFIG_DIR: tempRoot('legacy'),
  };
  try {
    // 旧仓库布局 fixture：WAL 库（含数据行）+ user 文件。
    mkdirSync(join(fixture, 'data'), { recursive: true });
    mkdirSync(join(fixture, 'user'), { recursive: true });
    const db = new Database(join(fixture, 'data', 'state.db'));
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE legacy_notes (id INTEGER PRIMARY KEY, text TEXT)');
    const insert = db.prepare('INSERT INTO legacy_notes (text) VALUES (?)');
    insert.run('row-a');
    insert.run('row-b');
    db.close();
    writeFileSync(join(fixture, 'user', 'taste.md'), '# migrate me\n', 'utf8');
    const sourceBefore = readdirSync(fixture, { recursive: true }).sort()
      .map(p => `${p}:${statSync(join(fixture, p)).size}`);

    const r = spawnSync(
      process.execPath,
      [BIN_PATH, 'migrate', '--source', fixture, '--data-dir', target],
      { encoding: 'utf8', env },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout?.slice(0, 600)}`);

    const jsonStart = r.stdout.indexOf('{');
    const report = JSON.parse(r.stdout.slice(jsonStart));
    assert.equal(report.status, 'ok');
    assert.equal(report.source, resolve(fixture));
    assert.ok(Array.isArray(report.databases) && report.databases.length === 1);
    assert.equal(report.databases[0].name, 'state.db');
    assert.equal(report.databases[0].sourceLevel, 'rw', '正常源走 rw + checkpoint 路径');

    // 表级校验：正式库行数与源一致。
    const migrated = new Database(join(target, 'data', 'state.db'), { readonly: true });
    try {
      assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM legacy_notes').get().n, 2);
    } finally {
      migrated.close();
    }
    // 备份留存：backup/pre-datadir-*/state.db 与源字节一致。
    const backupRoot = join(target, 'backup');
    const preDatadir = readdirSync(backupRoot).filter(name => name.startsWith('pre-datadir-'));
    assert.equal(preDatadir.length, 1);
    const backupDb = join(backupRoot, preDatadir[0], 'state.db');
    assert.ok(existsSync(backupDb), '备份副本应保留');
    const backup = new Database(backupDb, { readonly: true });
    try {
      assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM legacy_notes').get().n, 2);
      assert.match(backup.pragma('integrity_check')[0].integrity_check, /ok/);
    } finally {
      backup.close();
    }
    // marker 记录来源；user 文件迁移且模板不复制。
    const marker = JSON.parse(readFileSync(join(target, 'migration.json'), 'utf8'));
    assert.equal(marker.status, 'ok');
    assert.equal(marker.source, resolve(fixture));
    assert.equal(readFileSync(join(target, 'user', 'taste.md'), 'utf8'), '# migrate me\n');

    // 源保留：fixture 文件集合与大小不变。
    const sourceAfter = readdirSync(fixture, { recursive: true }).sort()
      .map(p => `${p}:${statSync(join(fixture, p)).size}`);
    assert.deepEqual(sourceAfter, sourceBefore, '源树原样保留');
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
    for (const key of ['LUNARA_CONFIG_DIR', 'CLAUDIO_CONFIG_DIR']) {
      if (env[key]) rmSync(env[key], { recursive: true, force: true });
    }
  }
});
