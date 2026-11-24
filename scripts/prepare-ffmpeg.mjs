#!/usr/bin/env node
// prepare-ffmpeg.mjs — 校验并准备可合法再分发的随包 ffmpeg 二进制。
//
// 背景：`ffmpeg-static@5.3.0` (`b6.1.1`) 的 darwin-arm64 构建来自 osxexperts.net，
// `ffmpeg -L` 含 `--enable-nonfree` 并明确声明 "not legally redistributable"。
// 公开分发 macOS 安装包前，必须将其替换为合法 GPL-3.0 的静态构建并核对 SHA-256 与 `-L`。

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const MACOS_ARM64_FFMPEG = Object.freeze({
  version: '9.1',
  url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1795207104_9.1/ffmpeg.zip',
  sha256: '1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1',
  license: 'GPL-3.0-or-later',
  buildScriptUrl: 'https://git.martin-riedl.de/ffmpeg/build-script',
});

const NONFREE_PATTERN = /\bnonfree\b|not legally redistributable|--enable-nonfree/i;
const GPL_PATTERN = /GNU (?:Lesser )?General Public License/i;

export function isRedistributableLicenseOutput(text) {
  const output = String(text || '');
  if (!output.trim()) return false;
  if (NONFREE_PATTERN.test(output)) return false;
  return GPL_PATTERN.test(output);
}

export function inspectFfmpegLicense(ffmpegPath, { spawnImpl = spawnSync } = {}) {
  const result = spawnImpl(ffmpegPath, ['-L'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.error) {
    return {
      ok: false,
      reason: `无法执行 ffmpeg (${result.error.message})`,
      output: '',
    };
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `ffmpeg -L 退出码异常 (${result.status})`,
      output,
    };
  }
  if (!isRedistributableLicenseOutput(output)) {
    const hasNonfree = NONFREE_PATTERN.test(output);
    return {
      ok: false,
      reason: hasNonfree
        ? '随包 ffmpeg 启用了 nonfree 组件（not legally redistributable），禁止公开发布'
        : '随包 ffmpeg -L 未包含可识别的 GPL/LGPL 许可声明',
      output,
    };
  }
  return { ok: true, reason: null, output };
}

export function assertFfmpegRedistributable(ffmpegPath, options = {}) {
  const check = inspectFfmpegLicense(ffmpegPath, options);
  if (!check.ok) {
    throw new Error(`${check.reason}：${ffmpegPath}`);
  }
  return check;
}

export function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

async function defaultDownload(url, destinationPath) {
  mkdirSync(dirname(destinationPath), { recursive: true });
  const curl = spawnSync('curl', [
    '-fsSL',
    '--connect-timeout', '20',
    '--max-time', '120',
    '-o', destinationPath,
    url,
  ], { encoding: 'utf8', windowsHide: true });
  if (!curl.error && curl.status === 0 && existsSync(destinationPath)) {
    return;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new Error(`下载 ffmpeg 失败：HTTP ${response.status} (${url})`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destinationPath, bytes);
}

function defaultExtractZip(zipPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  execFileSync('ditto', ['-x', '-k', zipPath, outDir], { stdio: 'inherit' });
}

export function defaultFfmpegTargetPath(root = ROOT, platform = process.platform) {
  return join(root, 'node_modules', 'ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export async function ensureRedistributableFfmpeg({
  platform = process.platform,
  arch = process.arch,
  root = ROOT,
  env = process.env,
  targetPath = defaultFfmpegTargetPath(root, platform),
  existsImpl = existsSync,
  spawnImpl = spawnSync,
  downloadImpl = defaultDownload,
  extractZipImpl = defaultExtractZip,
  log = console,
} = {}) {
  if (existsImpl(targetPath)) {
    const current = inspectFfmpegLicense(targetPath, { spawnImpl });
    if (current.ok) {
      return { ok: true, replaced: false, targetPath };
    }
    if (!(platform === 'darwin' && arch === 'arm64')) {
      throw new Error(`${current.reason}：${targetPath}`);
    }
    log.warn(`· 检测到不可再分发的 darwin-arm64 ffmpeg（${current.reason}），准备替换为 GPL-3.0 静态构建…`);
  } else if (!(platform === 'darwin' && arch === 'arm64')) {
    throw new Error(`未找到随包 ffmpeg：${targetPath}（请先运行 npm ci / npm install）`);
  }

  const url = String(env.LUNARA_MACOS_FFMPEG_ZIP_URL || MACOS_ARM64_FFMPEG.url).trim();
  const expectedSha = String(env.LUNARA_MACOS_FFMPEG_SHA256 || MACOS_ARM64_FFMPEG.sha256).trim().toLowerCase();
  const workDir = mkdtempSync(join(tmpdir(), 'lunara-ffmpeg-prep-'));

  try {
    const zipPath = join(workDir, 'ffmpeg.zip');
    const extractDir = join(workDir, 'unpacked');
    log.log(`· 下载合法 GPL-3.0 macOS arm64 ffmpeg ${MACOS_ARM64_FFMPEG.version}: ${url}`);
    await downloadImpl(url, zipPath);

    const actualSha = sha256File(zipPath);
    if (actualSha !== expectedSha) {
      throw new Error(`ffmpeg.zip SHA-256 校验失败：期望 ${expectedSha}，实际 ${actualSha}`);
    }

    await extractZipImpl(zipPath, extractDir);
    const extracted = join(extractDir, 'ffmpeg');
    if (!existsImpl(extracted)) {
      throw new Error(`解压后未找到 ffmpeg 二进制：${extracted}`);
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(extracted, targetPath);
    if (platform !== 'win32') chmodSync(targetPath, 0o755);

    // 移除旧版 osxexperts 附带的误导性 LICENSE / README，统一以 build/licenses/ 为准。
    for (const stale of [`${targetPath}.LICENSE`, `${targetPath}.README`]) {
      if (existsImpl(stale)) rmSync(stale, { force: true });
    }

    assertFfmpegRedistributable(targetPath, { spawnImpl });
    log.log(`✓ 已替换为可再分发 GPL-3.0 ffmpeg（SHA-256=${expectedSha.slice(0, 12)}…）`);
    return { ok: true, replaced: true, targetPath, sha256: actualSha };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensureRedistributableFfmpeg();
    console.log(`✓ ffmpeg 许可校验通过：${result.targetPath}${result.replaced ? '（已替换）' : ''}`);
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exit(1);
  }
}
