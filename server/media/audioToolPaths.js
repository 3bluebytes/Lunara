// audioToolPaths.js — 共享媒体与音频指纹使用的 ffmpeg/ffprobe 解析契约。
//
// 路径顺序：显式 env → 随包二进制 → PATH 命令。
// 运行时必须通过 resolveRunnableAudioTool 实际执行探测，不能把存在性当成可执行性；
// 静态 resolveAudioToolPaths 仅保留给配置/打包路径检查。探测不阻塞主程序启动。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);


/** electron-builder 把 asarUnpack 的文件放到 app.asar.unpacked；二进制导出路径仍指向 asar 内部，执行前必须修正。 */
export function asarUnpackedPath(path) {
  if (typeof path !== 'string' || !path) return null;
  if (path.includes('app.asar/') && !path.includes('app.asar.unpacked/')) {
    return path.replace('app.asar/', 'app.asar.unpacked/');
  }
  return path;
}

export async function resolveRunnableAudioTool(candidates = [], {
  timeoutMs = 3_000,
  execFileImpl = execFileAsync,
} = {}) {
  const seen = new Set();
  for (const value of candidates) {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await execFileImpl(candidate, ['-version'], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 });
      return candidate;
    } catch {
      // 路径存在但架构错误、无执行权限或超时时，继续找下一个来源。
    }
  }
  return null;
}

export async function resolveRunnableAudioTools({
  env = process.env,
  bundledFfmpegPath = null,
  bundledFfprobePath = null,
  timeoutMs = 3_000,
  execFileImpl = execFileAsync,
} = {}) {
  const candidates = (...values) => [...new Set(values
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)
    .map(asarUnpackedPath))];
  const [ffmpegPath, ffprobePath] = await Promise.all([
    resolveRunnableAudioTool(candidates(env?.LUNARA_FFMPEG_PATH, bundledFfmpegPath, 'ffmpeg'), { timeoutMs, execFileImpl }),
    resolveRunnableAudioTool(candidates(env?.LUNARA_FFPROBE_PATH, bundledFfprobePath, 'ffprobe'), { timeoutMs, execFileImpl }),
  ]);
  return { ffmpegPath, ffprobePath };
}

/**
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] 读写 LUNARA_FFMPEG_PATH / LUNARA_FFPROBE_PATH
 * @param {string|null} [options.bundledFfmpegPath] ffmpeg-static 的导出值
 * @param {string|null} [options.bundledFfprobePath] ffprobe-static 的导出值
 * @param {(path: string) => boolean} [options.exists] 存在性判定（默认全部通过，由上层兜底）
 * @returns {{ ffmpegPath: string|null, ffprobePath: string|null }}
 */
export function resolveAudioToolPaths({
  env = process.env,
  bundledFfmpegPath = null,
  bundledFfprobePath = null,
  exists = () => true,
} = {}) {
  const pick = (...candidates) => {
    const usable = candidates
      .map(candidate => (typeof candidate === 'string' ? candidate.trim() : ''))
      .filter(candidate => candidate.length > 0)
      .map(asarUnpackedPath)
      .find(path => { try { return exists(path); } catch { return false; } });
    return usable || null;
  };
  return {
    ffmpegPath: pick(env?.LUNARA_FFMPEG_PATH, bundledFfmpegPath),
    ffprobePath: pick(env?.LUNARA_FFPROBE_PATH, bundledFfprobePath),
  };
}
