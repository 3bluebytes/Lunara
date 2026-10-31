// sharedTrackArtwork.js — 进程内唯一的封面缓存实例。
//
// 必须是单例的原因和媒体资产库一致：进程内缓存与 in-flight 去重是 per-store 状态。
// 曲库候选投影、canonical 解析、运行时补全三处必须看到同一份缓存，否则同一首歌
// 会在同一次启动里被查询三次。
//
// provider 查询用动态 import 注入，避免 qq/ncm ↔ library/media 之间的静态循环依赖。

import { createTrackArtworkStore } from './trackArtworkStore.js';

let store = null;
let lookup = null;
let traceSink = null;

/** 默认 provider 查询：只读公开元数据，不带 cookie。 */
async function defaultLookup(provider, songId, { signal } = {}) {
  const name = String(provider || '').trim().toLowerCase();
  if (name === 'qq') {
    const qq = await import('../qq.js');
    return qq.coverArt(songId, { signal });
  }
  if (name === 'ncm') {
    const ncm = await import('../ncm.js');
    return ncm.coverArt(songId);
  }
  return null;
}

export function getTrackArtworkStore() {
  if (!store) {
    store = createTrackArtworkStore({
      lookup: (provider, songId, options) => (lookup || defaultLookup)(provider, songId, options),
      trace: event => { try { traceSink?.(event); } catch { /* 诊断失败不影响封面 */ } },
    });
  }
  return store;
}

/** 组合根可注入持久化 trace（不含封面 URL、凭据或供应商报文）。 */
export function setTrackArtworkTrace(sink) {
  traceSink = typeof sink === 'function' ? sink : null;
}

/** 仅供测试：替换 provider 查询，验证接线而不触网。 */
export function setTrackArtworkLookup(candidate) {
  lookup = typeof candidate === 'function' ? candidate : null;
  store = null;
}

/** 仅供测试：重置单例，让临时数据根生效。 */
export function resetTrackArtworkStoreForTest() {
  try { store?.close(); } catch { /* ignore */ }
  store = null;
  lookup = null;
  traceSink = null;
}
