// createMusicSourceWiring.js — 内置音乐源服务的生命周期接线
//
// 组合根只保留一行装配；「启动内置服务 + 客户端基地址跟随实际端口」的细节
// 放在这里，避免 server/index.js 继续长出子系统实现
// （契约见 server/app/index.composition.test.js 与 openspec change embed-netease-api-service）。

import { startEmbeddedNcm } from '../ncmEmbedded.js';
import * as ncm from '../ncm.js';
import * as qq from '../qq.js';

/**
 * 供应商直链解析（同源中继用）：拿到的是带 vkey/uid 的原始地址，只在服务端使用。
 * 中继路由不自己 import 供应商，认证状态仍由组合根的装配位置掌握。
 */
export async function resolveAudioDirectUrl(provider, songId) {
  if (provider === 'qq') return qq.songUrl(songId);
  if (provider === 'ncm') return ncm.songUrl(songId);
  return null;
}

export function createMusicSourceComponent({ ncm, startEmbedded = startEmbeddedNcm } = {}) {
  if (!ncm || typeof ncm.getBaseUrl !== 'function') {
    throw new TypeError('createMusicSourceComponent requires the ncm provider client');
  }
  let handle = null;
  return {
    async start() {
      // 内置服务永不抛错：不可用时返回 null，网易云源本次降级，启动继续。
      handle = await startEmbedded();
      // 端口冲突时内置服务改听别的端口，客户端基地址跟随实际地址。
      if (handle?.baseUrl && handle.baseUrl !== ncm.getBaseUrl()) ncm.setBaseUrl(handle.baseUrl);
    },
    async stop() {
      const current = handle;
      handle = null;
      await current?.stop?.();
    },
  };
}

export default { createMusicSourceComponent, resolveAudioDirectUrl };
