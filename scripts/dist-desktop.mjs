#!/usr/bin/env node
// dist-desktop.mjs — 桌面安装包构建入口（macOS .dmg / Windows NSIS .exe）。
//
// 职责（契约见 openspec change add-desktop-packaging / design D1、D2、D7）：
// - 本机构建默认注入 npmmirror 下载镜像（用户已显式设置时不覆盖）；CI 在 GitHub
//   网络内可自行覆盖或无视这些镜像。
// - 默认未签名：没有 CSC_LINK/CSC_KEY_PASSWORD 时显式设
//   CSC_IDENTITY_AUTO_DISCOVERY=false，构建不得因缺少证书而失败。
// - macOS 构建成功后自动执行打包冒烟（scripts/smoke-packaged-app.mjs，arm64）。
// - Windows 本轮不做自动冒烟（NSIS 安装后才存在入口），由人工验收清单覆盖。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.argv.includes('--win');
const isMac = process.argv.includes('--mac');
if (!isWindows && !isMac) {
  console.error('用法: node scripts/dist-desktop.mjs --mac | --win');
  process.exit(1);
}

const env = { ...process.env };
// 国内外网络差异只在这里收敛；用户/CI 显式设置的镜像优先。
env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/';
env.ELECTRON_BUILDER_BINARIES_MIRROR ||= 'https://npmmirror.com/mirrors/electron-builder-binaries/';
if (!env.CSC_LINK && !env.CSC_KEY_PASSWORD) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('· 未检测到签名凭据（CSC_LINK），按未签名构建。');
}

const builderCli = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
if (!existsSync(builderCli)) {
  console.error('electron-builder 未安装：请先 npm install（缺少 node_modules/electron-builder/cli.js）。');
  process.exit(1);
}

console.log(`━━━ 构建 ${isMac ? 'macOS .dmg (arm64+x64)' : 'Windows .exe (x64)'} ━━━`);
const build = spawnSync(process.execPath, [builderCli, '--config', 'electron-builder.yml', isMac ? '--mac' : '--win'],
  { cwd: ROOT, stdio: 'inherit', env });
if (build.status !== 0) {
  console.error(`打包失败（exit=${build.status}）。`);
  process.exit(build.status ?? 1);
}

if (isMac) {
  const appPath = join(ROOT, 'dist-desktop', 'mac-arm64', 'Lunara.app');
  if (!existsSync(appPath)) {
    console.error(`未找到 ${appPath}，无法执行打包冒烟。`);
    process.exit(1);
  }
  const smoke = spawnSync(process.execPath, [join(ROOT, 'scripts', 'smoke-packaged-app.mjs'), appPath],
    { stdio: 'inherit', env: { ...process.env } });
  process.exit(smoke.status ?? 1);
}

console.log('✓ Windows 安装程序构建完成。人工安装验收清单见 docs/engineering/packaging.md（本轮不做自动冒烟）。');
