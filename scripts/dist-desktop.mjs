#!/usr/bin/env node
// dist-desktop.mjs — 桌面安装包构建入口（macOS arm64 .dmg / Windows x64 NSIS .exe），不发布。
//
// 职责（契约见 openspec change add-desktop-packaging / design D1、D2、D7）：
// - 构建前强制重编 better-sqlite3 为 Electron ABI，避免 `npm test` 切回 Node ABI 后缓存误判。
// - 构建前校验并确保随包 ffmpeg 可合法再分发（`ffmpeg -L` 不得含 nonfree）。
// - 本机构建默认注入 npmmirror 下载镜像（用户已显式设置时不覆盖）；CI 在 GitHub
//   网络内可自行覆盖或无视这些镜像。
// - 默认未签名：没有 CSC_LINK/CSC_KEY_PASSWORD 时显式设
//   CSC_IDENTITY_AUTO_DISCOVERY=false，构建不得因缺少证书而失败。
// - macOS 构建成功后自动执行打包冒烟（scripts/smoke-packaged-app.mjs，arm64）。
// - 构建完成后输出 `dist-desktop/SHA256SUMS.txt` 供校验。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureRedistributableFfmpeg } from './prepare-ffmpeg.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.argv.includes('--win');
const isMac = process.argv.includes('--mac');
if (!isWindows && !isMac) {
  console.error('用法: node scripts/dist-desktop.mjs --mac | --win');
  process.exit(1);
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
}
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

const rebuildCli = join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
if (!existsSync(rebuildCli)) {
  console.error('@electron/rebuild 未安装：请先 npm install。');
  process.exit(1);
}

console.log('━━━ 步骤 1：强制重编 better-sqlite3 为 Electron ABI ━━━');
const rebuild = spawnSync(process.execPath, [rebuildCli, '-f', '-w', 'better-sqlite3'],
  { cwd: ROOT, stdio: 'inherit', env });
if (rebuild.status !== 0) {
  console.error(`Electron 原生模块重编失败（exit=${rebuild.status}）。`);
  process.exit(rebuild.status ?? 1);
}

console.log('━━━ 步骤 2：校验随包 ffmpeg 许可与架构 ━━━');
await ensureRedistributableFfmpeg({
  platform: isWindows ? 'win32' : 'darwin',
  arch: isWindows ? 'x64' : process.arch,
  root: ROOT,
  env,
});

console.log(`━━━ 步骤 3：构建 ${isMac ? 'macOS .dmg (arm64)' : 'Windows .exe (x64)'} ━━━`);
const build = spawnSync(process.execPath, [builderCli, '--config', 'electron-builder.yml', isMac ? '--mac' : '--win', '--publish', 'never'],
  { cwd: ROOT, stdio: 'inherit', env });
if (build.status !== 0) {
  console.error(`打包失败（exit=${build.status}）。`);
  process.exit(build.status ?? 1);
}

const distDir = join(ROOT, 'dist-desktop');
const ext = isMac ? '.dmg' : '.exe';
const artifacts = readdirSync(distDir)
  .filter(name => name.endsWith(ext) && name.startsWith('Lunara'))
  .sort();
if (artifacts.length > 0) {
  const checksumLines = artifacts.map(name => {
    const digest = createHash('sha256').update(readFileSync(join(distDir, name))).digest('hex');
    return `${digest}  ${name}`;
  });
  writeFileSync(join(distDir, 'SHA256SUMS.txt'), checksumLines.join('\n') + '\n', 'utf8');
  console.log(`✓ 已写入 dist-desktop/SHA256SUMS.txt：\n  ${checksumLines.join('\n  ')}`);
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

console.log('✓ Windows 安装程序构建完成。请在 Windows 上安装并启动验收后，再决定是否发布安装包。');
