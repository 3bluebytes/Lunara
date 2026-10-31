#!/usr/bin/env node
// smoke-cli-launch.mjs — bin/lunara.js 冷启动冒烟（add-cli-launch-data-dir）。
//
// 步骤 0 先重建 Node ABI（better-sqlite3 的 ABI 是运行态：npm start 的 prestart
// 随时把它切回 Electron ABI，不先重建则 spawn bin 必 ERR_DLOPEN_FAILED）。
// 随后在完全隔离的临时目录冷启动 web 档并验证：
//   a) HTTP / 200 且 HTML 含 Lunara 标识；/api/health JSON 可用；
//   b) stdout 含 URL 与「数据目录」行；<data-root>/data/ 下两库（state/life）
//      与 user 模板播种生成；
//   c) spawn 前后 cwd 均无 data/（不再锚 cwd）；
//   d) SIGINT 15s 内干净退出；
//   e) migrate --dry-run：JSON 报告正确且 fixture 文件集合与 mtime 不变。
// 任一断言失败非零退出；结束清理全部临时目录。无凭据参与，全程合成数据。
//
// Run: npm run smoke:cli（或 node scripts/smoke-cli-launch.mjs）

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = join(REPO_ROOT, 'bin', 'lunara.js');
const HTTP_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 15_000;

const failures = [];
function check(name, ok, detail = '') {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
    srv.on('error', rejectPort);
  });
}

async function poll(path, { timeoutMs = HTTP_TIMEOUT_MS, expect } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(path, { signal: AbortSignal.timeout(2000) });
      const body = await res.text();
      if (res.status === (expect?.status ?? 200) && (!expect?.bodyMatches || expect.bodyMatches(body))) {
        return { status: res.status, body };
      }
      last = `status ${res.status}`;
    } catch (error) {
      last = error?.message || 'fetch failed';
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`poll 超时: ${path}（最后: ${last}）`);
}

function snapshot(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).sort()
    .map(p => `${p}:${statSync(join(root, p)).mtimeMs}:${statSync(join(root, p)).size}`);
}

console.log('━━━ 步骤 0：重建 Node ABI（npm run rebuild:node）━━━');
const rebuild = spawnSync('npm', ['run', 'rebuild:node'], { cwd: REPO_ROOT, stdio: 'inherit' });
if (rebuild.status !== 0) {
  console.error('rebuild:node 失败，无法继续冒烟。');
  process.exit(1);
}

const session = mkdtempSync(join(tmpdir(), 'lunara-smoke-'));
const dataRoot = join(session, 'data-root');
const cwdData = join(REPO_ROOT, 'data');
const cwdHadData = existsSync(cwdData);
let child = null;

try {
  // ---- web 档冷启动 ----
  console.log('━━━ web 档冷启动 ━━━');
  const port = await freePort();
  const childEnv = {
    ...process.env,
    LUNARA_DATA_DIR: dataRoot,
    LUNARA_CONFIG_DIR: join(session, 'config'),
    CLAUDIO_CONFIG_DIR: join(session, 'legacy-config'),
    PORT: String(port),
    LUNARA_HOST: '127.0.0.1',
  };
  child = spawn(process.execPath, [BIN_PATH, '--profile', 'web', '--port', String(port), '--data-dir', dataRoot], {
    cwd: REPO_ROOT,
    env: childEnv,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });

  const page = await poll(`http://127.0.0.1:${port}/`, { expect: { bodyMatches: body => /Lunara/i.test(body) } });
  check('GET / 返回 200 且含 Lunara 标识', true);
  const health = await poll(`http://127.0.0.1:${port}/api/health`);
  JSON.parse(health.body);
  check('GET /api/health 返回可解析 JSON', true);

  check('stdout 含「数据目录」行', /数据目录/.test(stdout), stdout.slice(0, 400));
  check('stdout 含服务 URL', stdout.includes(`http://127.0.0.1:${port}`) || new RegExp(`:${port}`).test(stdout), stdout.slice(0, 400));
  // 预期初始化文件：state.js / life 两库都落在临时数据根。
  const expectedDbs = ['state.db', 'life.db'];
  for (const name of expectedDbs) {
    check(`<data-root>/data/${name} 已生成`, existsSync(join(dataRoot, 'data', name)),
      `dataRoot 内容: ${existsSync(dataRoot) ? readdirSync(join(dataRoot, 'data')).join(', ') : 'dataRoot 不存在'}`);
  }
  check('首启播种 user 模板（taste.md）', existsSync(join(dataRoot, 'user', 'taste.md')));
  check('spawn 后 cwd 无新增 data/ 目录', cwdHadData || !existsSync(cwdData), 'cwd 出现了 data/');

  child.kill('SIGINT');
  const exited = await Promise.race([
    new Promise(resolveExit => child.on('exit', (code, signal) => resolveExit({ code, signal }))),
    new Promise((_, rejectExit) => setTimeout(() => rejectExit(new Error('SIGINT 后 15s 未退出')), EXIT_TIMEOUT_MS)),
  ]);
  check('SIGINT 后 15s 内退出（code 0 或 signal）', exited.code === 0 || exited.signal === 'SIGINT', JSON.stringify(exited));

  // ---- migrate --dry-run ----
  console.log('━━━ migrate --dry-run ━━━');
  const fixture = join(session, 'fixture');
  const target2 = join(session, 'root2');
  mkdirSync(join(fixture, 'data'), { recursive: true });
  mkdirSync(join(fixture, 'user'), { recursive: true });
  writeFileSync(join(fixture, 'data', 'state.db'), Buffer.from('SQLite format 3\x00smoke fixture'));
  writeFileSync(join(fixture, 'user', 'taste.md'), '# smoke\n');
  const before = snapshot(fixture);

  const migrate = spawnSync(
    process.execPath,
    [BIN_PATH, 'migrate', '--dry-run', '--source', fixture, '--data-dir', target2],
    { cwd: REPO_ROOT, env: { ...childEnv, LUNARA_DATA_DIR: target2 }, encoding: 'utf8' },
  );
  check('migrate --dry-run exit 0', migrate.status === 0, migrate.stderr?.slice(0, 400));
  const jsonStart = migrate.stdout.indexOf('{');
  const report = jsonStart >= 0 ? JSON.parse(migrate.stdout.slice(jsonStart)) : null;
  check('dry-run 报告 status=dry-run', report?.status === 'dry-run', migrate.stdout.slice(0, 400));
  check('dry-run 目标零写入', !existsSync(join(target2, 'data')) && !existsSync(join(target2, 'backup')));
  check('dry-run fixture 文件集合与 mtime 不变', JSON.stringify(snapshot(fixture)) === JSON.stringify(before));
} catch (error) {
  failures.push(`异常: ${error?.message || error}`);
  console.error(error);
} finally {
  if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
  rmSync(session, { recursive: true, force: true });
}

console.log('──────────────────────────────');
if (failures.length) {
  console.log(`❌ smoke-cli-launch 失败 ${failures.length} 项:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('✅ smoke-cli-launch 全部通过');
