#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function inspectElectronInstall({
  root = DEFAULT_ROOT,
  fileExists = existsSync,
  readText = path => readFileSync(path, 'utf8'),
} = {}) {
  const packageDir = resolve(root, 'node_modules/electron');
  const pathFile = resolve(packageDir, 'path.txt');
  if (!fileExists(pathFile)) return { ready: false, reason: 'path.txt missing' };
  let relativePath = '';
  try {
    relativePath = String(readText(pathFile) || '').trim();
  } catch (error) {
    return { ready: false, reason: `path.txt unreadable: ${error.message}` };
  }
  if (!relativePath) return { ready: false, reason: 'path.txt empty' };
  const binaryPath = resolve(packageDir, 'dist', relativePath);
  if (!fileExists(binaryPath)) return { ready: false, reason: `binary missing: ${binaryPath}` };
  return { ready: true, binaryPath };
}

function defaultRunInstaller(installerPath) {
  const result = spawnSync(process.execPath, [installerPath], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron installer exited with code ${result.status}`);
}

export async function ensureElectronInstalled({
  root = DEFAULT_ROOT,
  inspect = () => inspectElectronInstall({ root }),
  runInstaller = defaultRunInstaller,
} = {}) {
  const current = inspect();
  if (current.ready) return current;
  const installerPath = resolve(root, 'node_modules/electron/install.js');
  if (!existsSync(installerPath) && runInstaller === defaultRunInstaller) {
    throw new Error('Electron npm 包未安装。请先运行 npm install。');
  }
  console.warn(`[startup] Electron 二进制缺失（${current.reason}），正在修复…`);
  await runInstaller(installerPath);
  const repaired = inspect();
  if (!repaired.ready) {
    throw new Error(`Electron 二进制仍不可用（${repaired.reason}）。请检查网络/代理后重新运行 npm install。`);
  }
  return repaired;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await ensureElectronInstalled();
    console.log(`[startup] Electron ready: ${result.binaryPath}`);
  } catch (error) {
    console.error(`[startup] ${error.message}`);
    process.exitCode = 1;
  }
}
