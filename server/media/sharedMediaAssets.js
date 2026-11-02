// sharedMediaAssets.js — 进程内唯一的媒体资产库实例。
//
// 为什么必须是单例：并发去重是 per-store 的内存状态；qq.js、ncm.js 与播放失败
// 隔离三处必须看到同一张 in-flight 表，否则「同一首歌两个写流」这个问题会原样复现。
//
// 工具解析（ffmpeg）走 audioToolPaths 的路径契约：env → 随包二进制 → PATH，
// 并实际执行探测；不可用时退化为结构校验，绝不声称做过解码验证。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStaticPath from 'ffmpeg-static';
import { resolveRunnableAudioTools } from './audioToolPaths.js';
import { resolveAudioCacheDir } from '../runtimePaths.js';
import { createMediaAssetStore } from './mediaAssetStore.js';
import { createMediaVerifier } from './mediaProbe.js';
import { getFingerprintQueue } from './fingerprintQueue.js';

let store = null;
let toolsPromise = null;
let traceSink = null;

async function audioTools() {
  if (!toolsPromise) {
    toolsPromise = resolveRunnableAudioTools({
      env: process.env,
      bundledFfmpegPath: typeof ffmpegStaticPath === 'string' ? ffmpegStaticPath : null,
    }).catch(() => ({ ffmpegPath: null }));
  }
  return toolsPromise;
}

/** 组合根可注入持久化 trace（不含 URL、凭据或供应商报文）。 */
export function setMediaAssetTrace(sink) {
  traceSink = typeof sink === 'function' ? sink : null;
}

const execFileAsync = promisify(execFile);

async function verifyMediaFile(file, { expectedDurationSeconds = 0 } = {}) {
  const { ffmpegPath } = await audioTools();
  const verifier = createMediaVerifier({ ffmpegPath, execFileImpl: execFileAsync });
  return verifier(file, { expectedDurationSeconds });
}

export function getMediaAssetStore() {
  if (!store) {
    store = createMediaAssetStore({
      getDir: () => resolveAudioCacheDir(),
      verifier: verifyMediaFile,
      // 资产就绪后排进指纹队列：异步、单并发、有界，失败不影响资产与播放（任务 7.1）。
      onAssetReady: ({ provider, songId, filePath }) => {
        try { getFingerprintQueue().enqueue({ provider, songId, filePath }); } catch { /* 旁路 */ }
      },
      trace: event => {
        try {
          traceSink?.(event);
        } catch { /* 诊断不影响播放 */ }
        // 没有持久化订阅时也留一行脱敏告警：失败必须有人能在终端看到。
        if (!traceSink) {
          console.warn('[media]', event?.event ?? 'event', 'provider=' + (event?.provider ?? '-'),
            'song=' + (event?.songId ?? '-'), 'reason=' + (event?.reason ?? event?.phase ?? '-'));
        }
      },
    });
  }
  return store;
}

/** 仅供测试：注入替身资产库，验证 qq/ncm 的接线而不触网。 */
export function __setMediaAssetStoreForTest(candidate) {
  store = candidate || null;
}

/** 仅供测试：重置单例，让临时数据根与替身工具生效。 */
export function resetMediaAssetStoreForTest() {
  store = null;
  toolsPromise = null;
  traceSink = null;
}
