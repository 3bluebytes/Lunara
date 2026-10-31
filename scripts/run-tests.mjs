#!/usr/bin/env node
// run-tests.mjs — 在隔离数据目录内运行 server、pwa、scripts 的 *.test.js / *.test.mjs
//
// 同时支持 node:test 和独立 assert 脚本；逐个隔离进程，按退出码聚合。
//
// 用法：npm test           跑全部
//       npm test memory    只跑路径含 'memory' 的

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// 只有质量门禁（scripts/quality.mjs）设置 LUNARA_QUALITY_RUN_FILE 时才需要源码摘要；
// 按需加载，让不含质量工具的公开发布快照也能直接 npm test。
const evidencePath = process.env.LUNARA_QUALITY_RUN_FILE;
const digest = evidencePath ? (await import('./quality-core.mjs')).sourceDigest(process.cwd()) : null;
const ROOTS = ['server', 'pwa', 'scripts', 'electron', 'bin'].map(dir => resolve(process.cwd(), dir));
const filter = process.argv[2] || '';

function findTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      out.push(...findTests(full));
    } else if (/\.test\.(?:js|mjs)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

const tests = ROOTS.flatMap(findTests)
  .filter(f => !filter || f.includes(filter))
  .sort();

if (tests.length === 0) {
  console.log(`No test files found${filter ? ` matching '${filter}'` : ''}.`);
  process.exit(1);
}

console.log(`\n🧪 Running ${tests.length} test file(s)${filter ? ` (filter: ${filter})` : ''}\n`);

let passed = 0;
let failed = 0;
const failedFiles = [];
const t0 = Date.now();

for (const f of tests) {
  const rel = f.replace(process.cwd() + '/', '');
  // Preserve the caller's native-module ABI, including Electron's node mode.
  const isolated = mkdtempSync(join(tmpdir(), 'lunara-test-process-'));
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 60000, env: { ...process.env,
    // 日期断言使用 UTC+8 fixture；固定测试时区，避免开发机/CI 本地时区造成假回归。
    // 仅作用于测试子进程，不改变应用运行时的设备本地时间语义。
    TZ: 'Asia/Shanghai',
    LUNARA_DB_PATH: join(isolated, 'state.db'), LUNARA_RADIOHOST_DIR: join(isolated, 'radiohost'), LUNARA_CONFIG_DIR: join(isolated, 'config'),
    // 数据根 change 后默认根是 ~/.lunara：补全六个 env，杜绝任何测试写进真实 home。
    LUNARA_DATA_DIR: join(isolated, 'data-root'), LUNARA_TTS_CACHE_DIR: join(isolated, 'tts-cache'), LUNARA_TTS_MODEL_DIR: join(isolated, 'tts-models'),
  } });
  rmSync(isolated, { recursive: true, force: true });
  if (r.status === 0) {
    passed++;
    console.log(`  ✓ ${rel}`);
  } else {
    failed++;
    failedFiles.push(rel);
    console.log(`  ✗ ${rel}`);
    // 打印失败测试的末尾输出帮助定位
    const tail = (r.stdout || '').trim().split('\n').slice(-8).join('\n');
    if (tail) console.log(tail.split('\n').map(l => `      ${l}`).join('\n'));
    if (r.stderr) console.log(`      [stderr] ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
}

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n──────────────────────────────`);
console.log(`${passed} passed · ${failed} failed · ${tests.length} total · ${elapsed}s`);
if (failedFiles.length) {
  console.log(`\nFailed files:`);
  for (const f of failedFiles) console.log(`  - ${f}`);
}
if (evidencePath) {
  const { sourceDigest } = await import('./quality-core.mjs');
  const unchanged = digest === sourceDigest(process.cwd());
  writeFileSync(evidencePath, JSON.stringify({ version: 1, completed: unchanged, filter,
    passed, failed, total: tests.length, digest, elapsedSeconds: Number(elapsed),
    node: process.version, platform: process.platform, timeZone: 'Asia/Shanghai' }, null, 2) + '\n');
  if (!unchanged) {
    console.error('Source changed during tests; coverage must be collected again.');
    process.exit(1);
  }
}
process.exit(failed > 0 ? 1 : 0);
