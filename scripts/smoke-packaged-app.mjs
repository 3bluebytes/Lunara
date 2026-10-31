#!/usr/bin/env node
// smoke-packaged-app.mjs — 打包产物冷启动冒烟（契约：desktop-packaging「打包产物的自动冒烟验收」）。
//
// 用法: node scripts/smoke-packaged-app.mjs /path/to/Lunara.app
//
// - 完全隔离数据根：六个 LUNARA_* env + DOTENV_CONFIG_PATH=/dev/null，绝不写真实 ~/.lunara。
// - 直接启动 .app 内的可执行文件（不依赖 Finder/launchd），轮询 /api/health 至 ok:true。
// - 断言页面 200、数据根生成 state/life 两库与 user/ 模板。
// - SIGTERM 后 15s 内干净退出。
// - win32：NSIS 安装后才存在可执行入口，本轮按人工验收清单执行，退出码 2（不静默通过）。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(name);
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

if (process.platform === 'win32') {
  console.log('smoke:packaged 在 Windows 需先经 NSIS 安装后人工验收（docs/engineering/packaging.md）。本轮跳过，退出码 2。');
  process.exit(2);
}

const appPath = resolve(process.argv[2] || '');
const bin = join(appPath, 'Contents', 'MacOS', 'Lunara');
if (!existsSync(bin)) {
  console.error(`不是有效的 macOS .app（找不到 ${bin}）。用法: node scripts/smoke-packaged-app.mjs /path/to/Lunara.app`);
  process.exit(1);
}

const session = mkdtempSync(join(tmpdir(), 'lunara-packaged-smoke-'));
const dataRoot = join(session, 'data-root');
const port = await freePort();
const childEnv = {
  ...process.env,
  PORT: String(port),
  LUNARA_DATA_DIR: dataRoot,
  LUNARA_DB_PATH: join(dataRoot, 'data', 'state.db'),
  LUNARA_RADIOHOST_DIR: join(dataRoot, 'user', 'radiohost'),
  LUNARA_CONFIG_DIR: join(session, 'config'),
  CLAUDIO_CONFIG_DIR: join(session, 'legacy-config'),
  LUNARA_TTS_CACHE_DIR: join(dataRoot, 'cache', 'tts'),
  LUNARA_TTS_MODEL_DIR: join(dataRoot, 'cache', 'tts-models'),
  DOTENV_CONFIG_PATH: '/dev/null',
  LUNARA_HOST: '127.0.0.1',
};

console.log(`━━━ 打包冒烟: ${appPath}（port=${port}，数据根=${dataRoot}）━━━`);
const child = spawn(bin, [], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const bootLog = [];
child.stdout.on('data', chunk => bootLog.push(String(chunk)));
child.stderr.on('data', chunk => bootLog.push(String(chunk)));

try {
  let health = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
      const body = await response.json();
      if (response.ok && body?.ok === true) { health = body; break; }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  check('health ok:true', health?.ok === true, bootLog.join('').slice(-400));
  if (health?.ok === true) {
    check('health 携带登录状态结构', typeof health.qqLogin === 'object' && typeof health.llm === 'object');
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.text()).catch(() => '');
    check('页面 200 且含 Lunara 标识', page.includes('Lunara'));
  }

  const dataDir = join(dataRoot, 'data');
  const dataFiles = existsSync(dataDir) ? readdirSync(dataDir) : [];
  for (const db of ['state.db', 'life.db']) {
    check(`数据根生成 ${db}`, dataFiles.includes(db), dataFiles.join(', '));
  }
  check('数据根播种 user 模板（taste.md）', existsSync(join(dataRoot, 'user', 'taste.md')));
  check('数据根不含真实账号凭据写入（config 目录为空）',
    !existsSync(join(session, 'config', 'config.json')));
} finally {
  const exited = new Promise(resolveExit => {
    if (child.exitCode !== null || child.signalCode) return resolveExit({ code: child.exitCode });
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, 15_000).unref?.();
  });
  try { child.kill('SIGTERM'); } catch { /* already dead */ }
  const result = await exited;
  check('SIGTERM 后 15s 内退出', result.code === 0 || result.code === null || result.signal === 'SIGTERM',
    JSON.stringify(result));
  rmSync(session, { recursive: true, force: true });
}

console.log('──────────────────────────────');
if (failures.length) {
  console.log(`❌ 打包冒烟失败 ${failures.length} 项:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('✅ 打包冒烟全部通过');
