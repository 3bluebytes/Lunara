// dataRootMigration.test.js — 数据根迁移（add-cli-launch-data-dir）。
//
// 终审核正语义：
//   - busy ≠ 0 = 源库存在活跃读写事务（空闲第二连接 busy=0，迁移仍成功）；
//   - dry-run 零写入含源侧；0o555 下 djhosts 内嵌信号是已知假阴性（不断言检出）；
//   - 只读源三层回退，目录级只读以副本作校验基准（source-readonly-degraded）；
//   - 源侧隔离先于复制（djhosts 内嵌信号的真旧布局整搬进源 backup/，不复制）；
//   - 残留清理仅限 data/、user/、migration.json、backup/pre-datadir-*，
//     且必须有匹配的 .migration-in-progress.json 凭据（fix-release-blocking-defects）；
//   - 目标已用但无凭据 → refused-target-not-empty，一律不删；source/target 同实体亦拒绝；
//   - 每个用例自设 LUNARA_DATA_DIR（单文件直跑不写真实 ~/.lunara）。
//
// Run: node --test server/app/dataRootMigration.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  IN_PROGRESS_MARKER,
  detectLegacySourceRoot,
  ensureDataRootReady,
  runMigration,
  validateCopiedDatabase,
} from './dataRootMigration.js';

/** 目录快照：相对路径集合 + 文件大小与内容摘要，用于断言「零写入」。 */
function snapshotTree(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const full = join(entry.parentPath || root, entry.name);
      return `${relative(root, full)}:${readFileSync(full).length}:${statSync(full).mtimeMs}`;
    })
    .sort();
}

function uniqueRoot(label) {
  return mkdtempSync(resolve(tmpdir(), `lunara-mig-${label}-`));
}

/** 隔离数据根：未设 LUNARA_DATA_DIR 时临时指向唯一目录，杜绝写真实 ~/.lunara。 */
function withDataRoot(fn) {
  const previous = process.env.LUNARA_DATA_DIR;
  const root = uniqueRoot('target');
  process.env.LUNARA_DATA_DIR = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.LUNARA_DATA_DIR;
    else process.env.LUNARA_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** 构造「新布局」源仓库：data/state.db（WAL）+ user 文件。返回 { root, close }。 */
function makeSource(root, { rows = 1, withWal = false, extraUser = true } = {}) {
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'user'), { recursive: true });
  const db = new Database(join(root, 'data/state.db'));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS legacy_notes (id INTEGER PRIMARY KEY, text TEXT)');
  const insert = db.prepare('INSERT INTO legacy_notes (text) VALUES (?)');
  for (let i = 0; i < rows; i++) insert.run(`row-${i}`);
  writeFileSync(join(root, 'user', 'taste.md'), '# taste\n', 'utf8');
  writeFileSync(join(root, 'user', 'taste.md.example'), '# template\n', 'utf8');
  writeFileSync(join(root, 'user', 'playlists.json'), '{}', 'utf8');
  if (withWal) {
    // 留一个未关闭连接 + 未 checkpoint 的事务，制造 -wal/-shm 三件套场景。
    return { root, db };
  }
  db.close();
  return { root, db };
}

function targetStateDbRows(targetRoot) {
  const db = new Database(join(targetRoot, 'data', 'state.db'), { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM legacy_notes').get().n;
  } finally {
    db.close();
  }
}

// ---- detectLegacySourceRoot ----

test('detectLegacySourceRoot：LEGACY env 优先，cwd 含 data/state.db 次之，否则 null', () => {
  const sandbox = uniqueRoot('detect');
  try {
    assert.equal(detectLegacySourceRoot({ env: {}, cwd: sandbox }), null);
    mkdirSync(join(sandbox, 'data'), { recursive: true });
    writeFileSync(join(sandbox, 'data', 'state.db'), '', 'utf8');
    assert.equal(detectLegacySourceRoot({ env: {}, cwd: sandbox }), resolve(sandbox));
    assert.equal(
      detectLegacySourceRoot({ env: { LUNARA_LEGACY_DATA_DIR: '/elsewhere' }, cwd: sandbox }),
      resolve('/elsewhere'),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

// ---- happy path：复制迁移、排除规则、源保留 ----

test('非 dry-run：库与 user 复制到新根、*.example 排除、源数据保留、marker 写入', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 3 });
      if (db) db.close();

      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'ok');
      assert.equal(existsSync(join(targetRoot, 'data', 'state.db')), true);
      assert.equal(targetStateDbRows(targetRoot), 3);
      assert.equal(existsSync(join(targetRoot, 'user', 'taste.md')), true);
      assert.equal(existsSync(join(targetRoot, 'user', 'playlists.json')), true);
      assert.equal(existsSync(join(targetRoot, 'user', 'taste.md.example')), false, '*.example 不迁移');

      const marker = JSON.parse(readFileSync(join(targetRoot, 'migration.json'), 'utf8'));
      assert.equal(marker.status, 'ok');
      assert.equal(marker.source, resolve(source));
      assert.ok(marker.migratedAt);
      assert.ok(Array.isArray(marker.databases) && marker.databases.length === 1);

      // 备份留存：backup/pre-datadir-*/ 内的副本 literal 保留（晋升用 copy 而非 rename）。
      const backupRoot = join(targetRoot, 'backup');
      const preDatadir = readdirSync(backupRoot).filter(name => name.startsWith('pre-datadir-'));
      assert.equal(preDatadir.length, 1, `应有一个 pre-datadir 备份目录，实际: ${preDatadir}`);
      const backupCopy = join(backupRoot, preDatadir[0], 'state.db');
      assert.equal(existsSync(backupCopy), true, '备份副本应保留在 backup/pre-datadir-*/');
      assert.deepEqual(
        readFileSync(backupCopy).toString('hex'), readFileSync(join(source, 'data', 'state.db')).toString('hex'),
        '备份副本与源字节一致',
      );
      // 表级校验记录（marker.databases）在备份副本校验后写入。
      assert.equal(marker.databases[0].name, 'state.db');
      assert.equal(marker.databases[0].sourceLevel, 'rw');

      // 源永不删除：copy 语义 + 目标侧晋升。
      assert.equal(existsSync(join(source, 'data', 'state.db')), true);
      assert.equal(existsSync(join(source, 'user', 'taste.md')), true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('-wal/-shm 三件套一并复制，目标库数据完整', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 2, withWal: true });
      // db 连接保持打开：主库 + 未 checkpoint 的 wal 帧。
      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'ok');
      db.close();
      assert.equal(targetStateDbRows(targetRoot), 2);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('user/dj 纯防御排除：新布局库无信号时 dj 目录也不复制', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      makeSource(source, { rows: 1 });
      mkdirSync(join(source, 'user', 'dj', 'host_a'), { recursive: true });
      writeFileSync(join(source, 'user', 'dj', 'host_a', 'persona.md'), '# dj', 'utf8');
      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'ok');
      assert.equal(existsSync(join(targetRoot, 'user', 'dj')), false, 'user/dj 不迁移');
      assert.equal(existsSync(join(targetRoot, 'user', 'taste.md')), true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- (a) busy：活跃读写事务 fail-closed；空闲连接不算 busy ----

test('第二连接持未提交写事务 → status source-busy 且不产出目标库', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      const blocker = new Database(join(source, 'data', 'state.db'));
      blocker.exec('BEGIN IMMEDIATE');
      blocker.prepare('INSERT INTO legacy_notes (text) VALUES (?)').run('uncommitted');

      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'source-busy');
      assert.equal(existsSync(join(targetRoot, 'data')), false, 'busy 时不得晋升目标 data/');
      assert.equal(existsSync(join(targetRoot, 'migration.json')), false);

      blocker.close();
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('第二连接持读快照且源产生新帧 → busy=1 fail-closed', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      const reader = new Database(join(source, 'data', 'state.db'));
      reader.exec('BEGIN');
      reader.prepare('SELECT COUNT(*) AS n FROM legacy_notes').get();
      const writer = new Database(join(source, 'data', 'state.db'));
      writer.prepare('INSERT INTO legacy_notes (text) VALUES (?)').run('new-frame');

      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'source-busy');

      writer.close();
      reader.close();
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('空闲第二连接（旧版 Lunara 挂着的典型形态）→ checkpoint 成功、迁移成功', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 2 });
      db.close();
      const idle = new Database(join(source, 'data', 'state.db'));
      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'ok');
      assert.equal(targetStateDbRows(targetRoot), 2);
      idle.close();
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- (b) dry-run：零写入含源侧 ----

test('dry-run：目标零写入、报告含检测结果', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      const report = runMigration({ sourceRoot: source, targetRoot, dryRun: true });
      assert.equal(report.status, 'dry-run');
      assert.equal(report.sourceRoot, resolve(source));
      assert.equal(report.targetStateDbExists, false);
      assert.ok(report.sourceFiles.includes('state.db'));
      assert.equal(report.wouldQuarantine.triggered, false);
      assert.equal(existsSync(join(targetRoot, 'data')), false, 'dry-run 不写目标');
      assert.equal(existsSync(join(targetRoot, 'backup')), false);
      assert.equal(existsSync(join(targetRoot, 'migration.json')), false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('dry-run 对 0o555 只读源仍成功且源文件 mtime 集合不变（不假设 djhosts 信号检出）', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      const dataDir = join(source, 'data');
      const before = readdirSync(dataDir).sort().map(name => `${name}:${readFileSync(join(dataDir, name)).length}`);
      chmodSync(dataDir, 0o555);
      try {
        const report = runMigration({ sourceRoot: source, targetRoot, dryRun: true });
        assert.equal(report.status, 'dry-run');
        const after = readdirSync(dataDir).sort().map(name => `${name}:${readFileSync(join(dataDir, name)).length}`);
        assert.deepEqual(after, before, '源文件集合与内容不变');
        // 已知限制：目录级只读下 legacyCutover readonly 探测被吞，djhosts 内嵌信号
        // 假阴性——这里刻意不断言 legacyDb 检出，防止实现者把 dry-run 改成写源。
      } finally {
        chmodSync(dataDir, 0o755);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- (c) 只读源三层回退 ----

test('第二层回退：库文件只读（目录可写）→ readonly 打开 + 跳过 checkpoint + status ok', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 2 });
      db.close();
      chmodSync(join(source, 'data', 'state.db'), 0o444);
      try {
        const report = runMigration({ sourceRoot: source, targetRoot });
        assert.equal(report.status, 'ok');
        assert.equal(report.degraded, false, '源计数可得时不降级');
        assert.equal(targetStateDbRows(targetRoot), 2);
      } finally {
        chmodSync(join(source, 'data', 'state.db'), 0o644);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('第三层回退：目录级只读 → 以副本为基准 status source-readonly-degraded 且校验通过', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 2 });
      db.close();
      const dataDir = join(source, 'data');
      chmodSync(dataDir, 0o555);
      try {
        const report = runMigration({ sourceRoot: source, targetRoot });
        assert.equal(report.status, 'source-readonly-degraded');
        assert.equal(report.degraded, true);
        assert.equal(existsSync(join(targetRoot, 'data', 'state.db')), true);
        assert.equal(targetStateDbRows(targetRoot), 2);
        const marker = JSON.parse(readFileSync(join(targetRoot, 'migration.json'), 'utf8'));
        assert.equal(marker.status, 'source-readonly-degraded');
      } finally {
        chmodSync(dataDir, 0o755);
      }
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- (d) 隔离先于复制、作用于源 ----

test('djhosts 内嵌信号：源侧隔离生成 pre-radiohost-*，新根无 djhosts 表，二次 bootstrap 不触发', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      mkdirSync(join(source, 'user', 'dj', 'host_a'), { recursive: true });
      writeFileSync(join(source, 'user', 'dj', 'host_a', 'persona.md'), '# 旧人格', 'utf8');
      mkdirSync(join(source, 'data'), { recursive: true });
      const db = new Database(join(source, 'data', 'state.db'));
      db.exec("CREATE TABLE djhosts (id TEXT PRIMARY KEY); INSERT INTO djhosts VALUES ('dj_abc');");
      db.close();

      const logs = { warn() {}, error() {} };
      const ready = ensureDataRootReady({ env: {}, cwd: source, log: logs });
      assert.equal(ready.triggered, true);

      const backupRoot = join(source, 'backup');
      const entries = readdirSync(backupRoot).filter(name => name.startsWith('pre-radiohost-'));
      assert.equal(entries.length, 1, `源侧应生成 pre-radiohost-*，实际: ${entries}`);
      assert.equal(existsSync(join(backupRoot, entries[0], 'user', 'dj', 'host_a', 'persona.md')), true);
      assert.equal(existsSync(join(backupRoot, entries[0], 'data', 'state.db')), true);

      // state.js 等价行为：隔离后新根首库由启动链路全新创建，不含 djhosts。
      mkdirSync(join(targetRoot, 'data'), { recursive: true });
      const fresh = new Database(join(targetRoot, 'data', 'state.db'));
      const tables = fresh.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
      fresh.close();
      assert.equal(tables.includes('djhosts'), false, '新根不得带 djhosts 表');

      const ready2 = ensureDataRootReady({ env: {}, cwd: source, log: logs });
      assert.equal(ready2.triggered, false, '二次启动不再触发');
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- (e) 目标根无关文件保留（清理范围限定） ----

test('目标根预建 cache/audio 等无关文件时迁移成功且原样保留', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      mkdirSync(join(targetRoot, 'cache', 'audio'), { recursive: true });
      writeFileSync(join(targetRoot, 'cache', 'audio', 'keep.txt'), 'keep', 'utf8');

      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'ok');
      assert.equal(existsSync(join(targetRoot, 'cache', 'audio', 'keep.txt')), true, '无关文件不得清理');
      assert.equal(existsSync(join(targetRoot, 'data', 'state.db')), true);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- (f) 表级校验：一致通过 / 篡改失败 ----

test('validateCopiedDatabase：表集合与计数一致通过', () => {
  const dir = uniqueRoot('validate');
  try {
    const db = new Database(join(dir, 'copy.db'));
    db.exec('CREATE TABLE a (id INTEGER); INSERT INTO a VALUES (1),(2);');
    db.close();
    validateCopiedDatabase(join(dir, 'copy.db'), { tables: ['a'], counts: { a: 2 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateCopiedDatabase：计数被篡改时 fail-closed 抛错', () => {
  const dir = uniqueRoot('validate');
  try {
    const db = new Database(join(dir, 'copy.db'));
    db.exec('CREATE TABLE a (id INTEGER); INSERT INTO a VALUES (1),(2);');
    db.close();
    const tamper = new Database(join(dir, 'copy.db'));
    tamper.prepare('DELETE FROM a WHERE id = 1').run();
    tamper.close();
    assert.throws(
      () => validateCopiedDatabase(join(dir, 'copy.db'), { tables: ['a'], counts: { a: 2 } }),
      /a|count|校验/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- (g) marker 跨源 warn ----

test('marker.source ≠ 当前探测源 → warn 并跳过，不覆盖已有数据', () => {
  withDataRoot(targetRoot => {
    mkdirSync(join(targetRoot, 'data'), { recursive: true });
    writeFileSync(
      join(targetRoot, 'migration.json'),
      JSON.stringify({ status: 'ok', source: '/elsewhere/old-repo', migratedAt: '2026-01-01T00:00:00.000Z' }),
      'utf8',
    );
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      const warnings = [];
      const ready = ensureDataRootReady({ env: {}, cwd: source, log: { warn: m => warnings.push(String(m)), error() {} } });
      assert.equal(ready.triggered, false);
      assert.equal(warnings.some(m => /marker|来源|不同/.test(m)), true, `应有跨源 warn，实际: ${warnings}`);
      assert.equal(existsSync(join(targetRoot, 'data', 'state.db')), false, '不得覆盖已有数据根');
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- (h) 覆盖 env 全跳过 ----

test('任一覆盖 env（DB_PATH/RADIOHOST_DIR/DATA_DIR）存在即跳过自动迁移', () => {
  const source = uniqueRoot('src');
  try {
    const { db } = makeSource(source, { rows: 1 });
    db.close();
    for (const env of [
      { LUNARA_DB_PATH: '/tmp/x.db' },
      { LUNARA_RADIOHOST_DIR: '/tmp/rh' },
      { LUNARA_DATA_DIR: '/tmp/dr' },
    ]) {
      const ready = ensureDataRootReady({ env: { ...env }, cwd: source, log: { warn() {}, error() {} } });
      assert.deepEqual(ready, { triggered: false, reason: 'env-override' });
    }
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

// ---- (i) 半套残留可重跑 / 有 marker 非空拒绝 ----

/**
 * 在途凭据（fix-release-blocking-defects）：残留清理的唯一合法前提。
 * 只有凭据同时匹配本次 source 与 targetRoot 时，才承认残留是自己的。
 */
function writeInProgressCredential(targetRoot, sourceRoot, overrides = {}) {
  writeFileSync(join(targetRoot, IN_PROGRESS_MARKER), JSON.stringify({
    source: resolve(sourceRoot), targetRoot: resolve(targetRoot),
    startedAt: '2026-01-01T00:00:00.000Z', pid: 4242, ...overrides,
  }), 'utf8');
}

/** 造一个「有真实数据但无 marker」的目标：正常使用过的安装，不是残留。 */
function makeOccupiedTarget(targetRoot) {
  mkdirSync(join(targetRoot, 'data'), { recursive: true });
  const db = new Database(join(targetRoot, 'data', 'state.db'));
  db.exec('CREATE TABLE user_fixture (id INTEGER PRIMARY KEY, text TEXT)');
  db.prepare('INSERT INTO user_fixture (text) VALUES (?)').run('keep me');
  db.close();
}

function occupiedTargetRows(targetRoot) {
  const db = new Database(join(targetRoot, 'data', 'state.db'), { readonly: true });
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM user_fixture').get().n;
  } finally {
    db.close();
  }
}

test('目标已用但无 marker → refused-target-not-empty，用户数据一行不少', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      makeOccupiedTarget(targetRoot);

      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'refused-target-not-empty');
      assert.equal(occupiedTargetRows(targetRoot), 1, '原目标表与行必须存活');
      assert.equal(existsSync(join(targetRoot, 'backup')), false, '拒绝发生在任何写入之前');
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('source 与 target 同路径 → refused-source-equals-target 且零写入', () => {
  const shared = uniqueRoot('shared');
  try {
    const { db } = makeSource(shared, { rows: 1 });
    db.close();
    const before = snapshotTree(shared);

    const report = runMigration({ sourceRoot: shared, targetRoot: shared });
    assert.equal(report.status, 'refused-source-equals-target');
    assert.deepEqual(snapshotTree(shared), before, '同实体拒绝不做任何写入');
  } finally {
    rmSync(shared, { recursive: true, force: true });
  }
});

test('target 是 source 的符号链接别名 → refused-source-equals-target', () => {
  const root = uniqueRoot('symlink');
  const source = join(root, 'real');
  const alias = join(root, 'alias');
  try {
    const { db } = makeSource(source, { rows: 1 });
    db.close();
    try { symlinkSync(source, alias, 'dir'); } catch { return; } // 平台不支持时跳过
    const report = runMigration({ sourceRoot: source, targetRoot: alias });
    assert.equal(report.status, 'refused-source-equals-target');
    assert.equal(existsSync(join(source, IN_PROGRESS_MARKER)), false, '别名同样不得写入');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('在途凭据匹配本次 source/target → 承认自有残留并重迁成功', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      mkdirSync(join(targetRoot, 'data'), { recursive: true });
      writeFileSync(join(targetRoot, 'data', 'state.db'), 'not a database', 'utf8');
      mkdirSync(join(targetRoot, 'backup', 'pre-datadir-old'), { recursive: true });
      mkdirSync(join(targetRoot, 'cache'), { recursive: true });
      writeFileSync(join(targetRoot, 'cache', 'keep.txt'), 'keep', 'utf8');
      writeInProgressCredential(targetRoot, source);

      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'ok');
      assert.equal(targetStateDbRows(targetRoot), 1, '凭据匹配才清理残留并重迁');
      assert.equal(existsSync(join(targetRoot, 'cache', 'keep.txt')), true, '清理仅限限定范围');
      assert.equal(existsSync(join(targetRoot, IN_PROGRESS_MARKER)), false, '成功后移除在途凭据');
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('在途凭据指向别的源 → 仍拒绝且不删除目标', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    const otherSource = uniqueRoot('other');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      makeOccupiedTarget(targetRoot);
      writeInProgressCredential(targetRoot, otherSource);

      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'refused-target-not-empty');
      assert.equal(occupiedTargetRows(targetRoot), 1, '别人的凭据不能授权清理我的数据');
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(otherSource, { recursive: true, force: true });
    }
  });
});

test('失败保留在途凭据，重跑同一源可完成迁移', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 3 });
      db.close();
      // 制造 source-busy 失败：源库存在活跃写事务。
      const busy = new Database(join(source, 'data', 'state.db'));
      busy.exec('BEGIN IMMEDIATE; INSERT INTO legacy_notes (text) VALUES (\'in-flight\')');
      const failed = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(failed.status, 'source-busy');
      busy.exec('ROLLBACK');
      busy.close();
      assert.equal(existsSync(join(targetRoot, IN_PROGRESS_MARKER)), true, '失败保留可归属凭据');
      assert.equal(existsSync(join(targetRoot, 'migration.json')), false, '未完成就没有完成标记');

      const retry = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(retry.status, 'ok', '失败窗口可重试');
      assert.equal(targetStateDbRows(targetRoot), 3);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('目标非空且有 marker → refused-target-not-empty', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      mkdirSync(join(targetRoot, 'data'), { recursive: true });
      writeFileSync(join(targetRoot, 'data', 'state.db'), 'existing', 'utf8');
      writeFileSync(
        join(targetRoot, 'migration.json'),
        JSON.stringify({ status: 'ok', source: resolve(source), migratedAt: '2026-01-01T00:00:00.000Z' }),
        'utf8',
      );
      const report = runMigration({ sourceRoot: source, targetRoot });
      assert.equal(report.status, 'refused-target-not-empty');
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

// ---- ensureDataRootReady 自动迁移主链 ----

test('ensureDataRootReady：无覆盖 env + 目标空 + 源存在 → 迁移并返回 triggered', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 2 });
      db.close();
      const ready = ensureDataRootReady({ env: {}, cwd: source, log: { warn() {}, error() {} } });
      assert.equal(ready.triggered, true);
      assert.equal(targetStateDbRows(targetRoot), 2);
      const ready2 = ensureDataRootReady({ env: {}, cwd: source, log: { warn() {}, error() {} } });
      assert.equal(ready2.triggered, false, 'marker 后幂等');
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});

test('ensureDataRootReady：busy 源让启动显式失败（fail-closed）', () => {
  withDataRoot(targetRoot => {
    const source = uniqueRoot('src');
    try {
      const { db } = makeSource(source, { rows: 1 });
      db.close();
      const blocker = new Database(join(source, 'data', 'state.db'));
      blocker.exec('BEGIN IMMEDIATE');
      blocker.prepare('INSERT INTO legacy_notes (text) VALUES (?)').run('uncommitted');
      assert.throws(
        () => ensureDataRootReady({ env: {}, cwd: source, log: { warn() {}, error() {} } }),
        /source-busy|活跃/,
      );
      blocker.close();
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });
});
