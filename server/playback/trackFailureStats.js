// trackFailureStats.js — 播放失败的**脱敏计数**，只回答「失败大概是哪一类」。
//
// 为什么需要它：同一个「这首歌没播出来」，可能是直链过期、源里没这条资源、会员限制、
// 或者浏览器解不了这个容器。四种情况的处置完全不同（重新取直链 / 换歌 / 提示去登录 /
// 换编码），但在此之前它们全被压成一句 free-form 的浏览器报错文本——既有泄露 URL 的
// 风险，也让「该不该做同源刷新续播」只能靠猜。
//
// 约束：只存封闭分类与源 id 的计数，不存任何原文、URL、凭据。进程内、有界、不落盘；
// 重启即清空，因为它描述的是「最近发生了什么」，不是长期账本。

export const TRACK_FAILURE_KINDS = Object.freeze([
  'timeout', 'network', 'decode', 'unsupported', 'aborted', 'unknown',
]);

const KIND_SET = new Set(TRACK_FAILURE_KINDS);
const MAX_PROVIDERS = 8;

export function normalizeTrackFailureKind(value) {
  const kind = String(value ?? '').trim().toLowerCase();
  return KIND_SET.has(kind) ? kind : 'unknown';
}

export function createTrackFailureStats({ now = Date.now, maxProviders = MAX_PROVIDERS } = {}) {
  const byProvider = new Map();
  let total = 0;
  let since = null;

  function record({ provider = '', kind = 'unknown' } = {}) {
    const id = String(provider ?? '').trim().slice(0, 32) || 'unknown';
    const safeKind = normalizeTrackFailureKind(kind);
    let entry = byProvider.get(id);
    if (!entry) {
      // 有界：源的数量本来有限，超了也只是新源挤掉最久没出现的那一个，不会无限增长。
      if (byProvider.size >= maxProviders) byProvider.delete(byProvider.keys().next().value);
      entry = { provider: id, total: 0, byKind: {}, lastAt: null };
      byProvider.set(id, entry);
    }
    entry.total += 1;
    entry.byKind[safeKind] = (entry.byKind[safeKind] || 0) + 1;
    entry.lastAt = now();
    total += 1;
    if (since == null) since = entry.lastAt;
    return { provider: entry.provider, kind: safeKind };
  }

  /** 只读摘要：总量、按分类、按源。数字之外没有任何原文。 */
  function inspect() {
    const kinds = {};
    for (const kind of TRACK_FAILURE_KINDS) kinds[kind] = 0;
    const providers = [];
    for (const entry of byProvider.values()) {
      for (const [kind, count] of Object.entries(entry.byKind)) kinds[kind] = (kinds[kind] || 0) + count;
      providers.push({ provider: entry.provider, total: entry.total, byKind: { ...entry.byKind }, lastAt: entry.lastAt });
    }
    providers.sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider));
    return { total, since, kinds, providers };
  }

  return Object.freeze({ record, inspect });
}

let singleton = null;

export function getTrackFailureStats() {
  if (!singleton) singleton = createTrackFailureStats();
  return singleton;
}

/** 仅测试使用。 */
export function resetTrackFailureStatsForTest() {
  singleton = null;
}
