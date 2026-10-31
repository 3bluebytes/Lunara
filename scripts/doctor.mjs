#!/usr/bin/env node
// scripts/doctor.mjs — 诊断 Lunara 启动相关的常见环境问题
//
// 主要解决两类反复出现的痛：
//   1. better-sqlite3 的 native binary 编译给的是错的 ABI（Electron vs Node）
//      → 详情见 README 的 better-sqlite3 部分
//   2. 端口被占（NCM=3000 / Lunara=8080）— 上次跑没杀干净
//
// 用法：npm run doctor

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { getLLMConfig } from '../server/llmConfig.js';
import * as qq from '../server/qq.js';

const ROOT = process.cwd();
const BIN_PATH = resolve(ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');

function header(text) {
  console.log(`\n━━━━━━ ${text} ━━━━━━`);
}
function ok(msg) { console.log(`  ✅ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }
function bad(msg) { console.log(`  ❌ ${msg}`); }
function hint(msg) { console.log(`     → ${msg}`); }

let problems = 0;

// ===== 1. better-sqlite3 binary ABI =====
header('better-sqlite3 ABI');

if (!existsSync(BIN_PATH)) {
  bad('better-sqlite3 binary 不存在');
  hint('跑 npm install');
  problems++;
} else {
  const nodeAbi = process.versions.modules;
  try {
    // 关键：必须真的实例化才会触发 dlopen，require 只会做 package resolution
    const { createRequire } = await import('node:module');
    const requireFromHere = createRequire(import.meta.url);
    const Database = requireFromHere('better-sqlite3');
    const probe = new Database(':memory:');
    probe.close();
    ok(`binary 对当前 runtime（Node ABI ${nodeAbi}）兼容`);
    hint('npm run start:web / npm run dev / node *.test.js — 立刻可用');
    hint('npm start（Electron）— prestart 会自动重建到 Electron ABI');
  } catch (e) {
    const m = String(e.message).match(/NODE_MODULE_VERSION (\d+)/g) || [];
    const builtFor = m[0] ? m[0].replace('NODE_MODULE_VERSION ', '') : '?';
    const need = m[1] ? m[1].replace('NODE_MODULE_VERSION ', '') : nodeAbi;
    bad(`binary 编译给 ABI ${builtFor}，但当前 Node 运行时是 ABI ${need}`);
    hint(`想跑 Node（test/dev/start:web）：npm run rebuild:node`);
    hint(`想跑 Electron（start）：npm start  ← prestart 会自动重建`);
    problems++;
  }
}

// ===== 2. Electron-installed ABI =====
header('Electron ABI 对齐');
try {
  const electronAbi = execSync(
    `ELECTRON_RUN_AS_NODE=1 ${resolve(ROOT, 'node_modules/.bin/electron')} -e "process.stdout.write(process.versions.modules)"`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
  ok(`Electron 当前 ABI = ${electronAbi}`);
  hint(`prestart 用 \`electron-rebuild -f\` 自动检测，无需 hardcode --force-abi`);
} catch (e) {
  warn('Electron 未安装或读取 ABI 失败：' + e.message.split('\n')[0]);
}

// ===== 3. LLM endpoint =====
header('LLM endpoint');
const llmConfig = await getLLMConfig();
if (!llmConfig.baseUrl || !llmConfig.apiKey || !llmConfig.model) {
  bad('LLM endpoint 未配置完整（Base URL / API Key / Model）');
  hint('启动应用，在设置浮层填写一个 OpenAI-compatible 接口');
  hint('配置默认保存在 ~/.lunara/config.json');
  problems++;
} else {
  try {
    const response = await fetch(`${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${llmConfig.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      ok(`OpenAI-compatible endpoint 可达（model=${llmConfig.model}）`);
    } else {
      const detail = await response.text().catch(() => '');
      bad(`LLM endpoint 返回 HTTP ${response.status}: ${detail.slice(0, 120)}`);
      problems++;
    }
  } catch (error) {
    bad(`LLM endpoint 连接失败：${error.message}`);
    problems++;
  }
}

// ===== 4. 端口占用 =====
header('端口占用');
const ports = [
  { port: 3000, role: '内置网易云 API（npm start 自带）或 npm run ncm 独立进程' },
  { port: 8080, role: 'Lunara server (npm start / start:web)' },
];
for (const { port, role } of ports) {
  try {
    const out = execSync(`lsof -i :${port} -sTCP:LISTEN -P -n 2>/dev/null || true`, { encoding: 'utf8' });
    if (out.trim()) {
      const lines = out.split('\n').slice(1).filter(Boolean);
      const first = lines[0]?.split(/\s+/) || [];
      warn(`:${port} 已被占用（${role}） — pid=${first[1] || '?'} cmd=${first[0] || '?'}`);
      hint(`如果不是你想要的进程：kill ${first[1]}`);
    } else {
      ok(`:${port} 空闲 — ${role} 可用`);
    }
  } catch {
    ok(`:${port} 状态未知（lsof 不可用，跳过）`);
  }
}

// ===== QQ SDK 端到端可用性 =====
header('QQ 内置 SDK 实际可用性');
try {
  const songs = await qq.search('晴天', 1);
  const first = songs[0];
  if (!first?.song_id) {
    warn('QQ SDK 搜索未返回歌曲；请检查当前网络是否能访问 QQ 音乐上游');
  } else {
    ok(`QQ SDK 搜索可用（${first.title} — ${first.artist}）`);
    const url = await qq.songUrl(first.song_id);
    if (url) {
      ok('QQ SDK 拿到了可播放 URL');
    } else if (!qq.getCookie()) {
      warn('未登录 QQ，当前歌曲未返回播放 URL；可在 Lunara 中扫码登录后重试');
    } else {
      warn('QQ SDK 未返回播放 URL；Cookie 可能过期，或该歌曲需要其他权限');
    }
  }
} catch (e) {
  warn('QQ SDK 检查失败：' + e.message);
}

// ===== Summary =====
header('总结');
if (problems === 0) {
  console.log('\n✨ 一切就绪。');
  process.exit(0);
} else {
  console.log(`\n发现 ${problems} 个需要处理的问题，按上面 → 提示执行修复后再跑 npm start。\n`);
  process.exit(1);
}
