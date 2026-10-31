#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

export function buildMusicSourceLaunch(source, {
  root = DEFAULT_ROOT,
  env = process.env,
  fileExists = existsSync,
} = {}) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized === 'ncm') {
    const entry = resolve(root, 'node_modules/NeteaseCloudMusicApi/app.js');
    if (!fileExists(entry)) {
      throw new Error('网易云音乐服务未安装。请先运行 npm install，再重试 npm run ncm。');
    }
    return {
      command: process.execPath,
      args: [entry],
      env: { ...env },
      notice: '网易云音乐服务启动中，默认地址 http://127.0.0.1:3000',
    };
  }

  throw new Error(`不支持的独立音乐源：${normalized || '(empty)'}。可用值：ncm（QQ SDK 已内置 Lunara）。`);
}

export function startMusicSource(source, options = {}) {
  const launch = buildMusicSourceLaunch(source, options);
  console.log(`[music-source] ${launch.notice}`);
  const child = spawn(launch.command, launch.args, {
    cwd: options.root || DEFAULT_ROOT,
    env: launch.env,
    stdio: 'inherit',
  });
  child.once('error', error => {
    console.error(`[music-source] 启动失败：${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) console.warn(`[music-source] 子进程因 ${signal} 退出`);
    process.exitCode = code ?? 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill(signal));
  }
  return child;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    startMusicSource(process.argv[2]);
  } catch (error) {
    console.error(`[music-source] ${error.message}`);
    process.exitCode = 1;
  }
}
