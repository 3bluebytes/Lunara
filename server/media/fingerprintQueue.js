// fingerprintQueue.js — 指纹计算的有界后台队列（关键路径之外）。
//
// 为什么是队列而不是「解析时就地算」：解一首歌的 PCM 要几百毫秒到几秒，放在解析或
// 播放路径上会把「点了歌多久出声」变成不可控。这里在资产就绪之后异步排队，单并发、
// 有上限、失败记一次并在冷却后才重试；任何异常都不冒泡到播放。
//
// 指纹只服务「同一首歌」的**提议**：算不出来不影响播放，算错了也不会自动合并。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { computeFingerprint } from './audioFingerprint.js';
import { getFingerprintStore } from './fingerprintStore.js';
import { FINGERPRINT_STATE } from './fingerprintStore.js';

const RETRY_AFTER_MS = 6 * 60 * 60_000;

export function createFingerprintQueue({
  store = null,
  compute = computeFingerprint,
  tools = async () => ({ ffmpegPath: null }),
  execFileImpl = null,
  now = () => Date.now(),
  concurrency = 1,
  maxPending = 64,
  trace = null,
} = {}) {
  const pending = [];
  const queued = new Set();
  let running = 0;
  let closed = false;

  function shouldSkip(provider, songId) {
    const existing = store?.get?.(provider, songId);
    if (!existing) return false;
    if (existing.state === FINGERPRINT_STATE.READY) return true;
    // 失败过的文件冷却后再试，避免每次播放都重算一个解不开的容器。
    return now() - Number(existing.updated_at || 0) < RETRY_AFTER_MS;
  }

  async function run(job) {
    const { provider, songId, filePath } = job;
    try {
      const { ffmpegPath } = await tools();
      const result = await compute(filePath, { ffmpegPath, execFileImpl });
      if (result?.ok) {
        store?.put?.({ provider, songId, fingerprint: result.fingerprint, version: result.version,
          points: result.points, state: FINGERPRINT_STATE.READY });
        trace?.({ event: 'fingerprint-ready', provider, songId, points: result.points });
      } else {
        const previous = store?.get?.(provider, songId);
        store?.put?.({ provider, songId, state: FINGERPRINT_STATE.FAILED,
          attempts: Number(previous?.attempts || 0) + 1 });
        trace?.({ event: 'fingerprint-unavailable', provider, songId, reason: result?.reason || 'unknown' });
      }
    } catch {
      // 计算/存储失败都只影响「有没有提议」，不影响任何用户可见事实。
      trace?.({ event: 'fingerprint-failed', provider, songId, reason: 'internal' });
    } finally {
      running -= 1;
      queued.delete(`${provider}:${songId}`);
      drain();
    }
  }

  function drain() {
    while (!closed && running < concurrency && pending.length) {
      const job = pending.shift();
      running += 1;
      void run(job);
    }
  }

  function enqueue({ provider, songId, filePath } = {}) {
    const key = `${provider}:${songId}`;
    if (closed || !provider || !songId || !filePath) return { ok: false, reason: 'invalid' };
    if (queued.has(key) || shouldSkip(provider, songId)) return { ok: false, reason: 'skipped' };
    if (pending.length >= maxPending) return { ok: false, reason: 'full' };
    queued.add(key);
    pending.push({ provider, songId, filePath });
    drain();
    return { ok: true };
  }

  /** 测试与关闭用：等在飞任务结束，不再接受新任务。 */
  async function close() {
    closed = true;
    pending.length = 0;
    while (running > 0) await new Promise(resolve => setTimeout(resolve, 5));
  }

  return Object.freeze({ enqueue, close, inspect: () => ({ pending: pending.length, running, queued: queued.size }) });
}

let singleton = null;

/** 生产单例：工具解析延迟到首次真实任务，避免模块加载就找 ffmpeg。 */
export function getFingerprintQueue() {
  if (singleton) return singleton;
  singleton = createFingerprintQueue({
    // 存储按需取：单例打不开数据库时指纹功能整体退化，不影响播放。
    store: {
      get: (...args) => getFingerprintStore()?.get?.(...args) ?? null,
      put: payload => getFingerprintStore()?.put?.(payload),
    },
    execFileImpl: promisify(execFile),
    tools: async () => {
      const { resolveRunnableAudioTools } = await import('./audioToolPaths.js');
      const ffmpegStaticPath = (await import('ffmpeg-static')).default;
      const ffprobeStatic = (await import('ffprobe-static')).default;
      return resolveRunnableAudioTools({
        env: process.env,
        bundledFfmpegPath: typeof ffmpegStaticPath === 'string' ? ffmpegStaticPath : null,
        bundledFfprobePath: typeof ffprobeStatic?.path === 'string' ? ffprobeStatic.path : null,
      });
    },
  });
  return singleton;
}

export function resetFingerprintQueueForTest() {
  singleton = null;
}
