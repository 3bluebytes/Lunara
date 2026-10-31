// createSourceHealthWiring.js — 音乐源派生健康状态的生产装配（组合根行数守卫）。
//
// 组合根只取一个 `sourceHealth()` getter 传给设置服务；具体「登录态怎么问、
// 失败怎么记」留在这里。放在独立模块还有一个实际理由：这些逻辑需要被单测覆盖，
// 而组合根本身没有单测入口。
//
// 健康状态是**派生**的，不落库：进程重启即清空。「最近观察到的事实」比「某次
// 探测写死的结论」更接近真相——后者一旦与真实状态不同步，就会变成
// 「明明能播却提示不可用」。

import { providerRegistry } from '../music/providerRegistry.js';
import { createSourceHealth } from '../music/sourceHealth.js';
import { setSourceHealthReporter } from '../music/sourceHealthSignal.js';
import { SOURCE_FAILURE, classifySourceFailure } from '../music/sourceFailure.js';
import * as ncm from '../ncm.js';
import * as qq from '../qq.js';

/**
 * @param {object} options
 * @param {Record<string, {loginStatus?: () => Promise<object>|object}>} options.providers
 *   源 id → provider 模块。只用于问登录态，不从它推能力。
 * @returns {{ read: Function, snapshot: Function, recordFailure: Function, recordSuccess: Function, inspect: Function }}
 */
export function createSourceHealthWiring({ providers = {}, registry = providerRegistry, logger = console, now = Date.now,
  authCheckIntervalMs = 30_000, authCheckTimeoutMs = 8_000 } = {}) {
  const health = createSourceHealth({
    registry,
    // 未接线或未实现 loginStatus 的源返回 null：不知道，而不是「不可用」。
    loginStatusOf: id => providers[id]?.loginStatus?.() ?? null,
  });

  // 登录提醒属于这份派生健康观测，不写播放器或账号凭据。公开歌曲仍可能可播，
  // 所以普通解析成功不能证明账号恢复；只有明确验证成功的登录才解除提醒。
  const pendingAuth = new Set();
  const issues = new Map();
  const actionable = new Set(['requires-auth', 'requires-member', 'timeout', 'unavailable', 'rate-limited']);
  const authChecks = new Map();
  const listeners = new Set();
  const emit = (source, code) => {
    for (const listener of listeners) {
      try { listener({ type: 'music-source-status', source, displayName: registry.get(source)?.displayName || source, code }); } catch { /* 通知不影响播放 */ }
    }
  };
  const recordFailure = (id, code) => {
    const source = registry.get(id)?.id;
    if (!source) return null;
    const result = health.recordFailure(source, code);
    const classified = classifySourceFailure(code);
    if (classified === SOURCE_FAILURE.REQUIRES_AUTH) pendingAuth.add(source);
    // 单曲版权/空音源不升级成整个音乐源故障。已确证的鉴权问题不会被网络噪声覆盖。
    if (actionable.has(classified) && (!pendingAuth.has(source) || classified === SOURCE_FAILURE.REQUIRES_AUTH)
      && issues.get(source) !== classified) {
      issues.set(source, classified);
      emit(source, classified);
    }
    if (result?.code === SOURCE_FAILURE.NOT_PLAYABLE) verifyAuthInBackground(source);
    return result;
  };
  // 空 URL 无法确证过期：仅在有凭据时沿现有 loginStatus 做一次有界核验。
  // 并发预解析共用一次，30 秒内不重复，不阻塞选歌，也不凭网络故障猜登录态。
  function verifyAuthInBackground(source) {
    const provider = providers[source];
    const credential = provider?.getCookie?.();
    if (!credential || !provider?.loginStatus || pendingAuth.has(source)) return;
    const prior = authChecks.get(source);
    if (prior?.credential === credential && (prior.pending || now() - prior.at < authCheckIntervalMs)) return;
    const check = { at: now(), credential, pending: true };
    authChecks.set(source, check);
    let timer;
    const expired = new Promise(resolve => { timer = setTimeout(() => resolve(null), authCheckTimeoutMs); timer.unref?.(); });
    // 等待窗口结束不等于底层请求已结束；没有 AbortSignal 的旧 provider 仍在途时，
    // 不再叠加第二次核验。迟到结果由 race 丢弃，凭据更换后才可另起任务。
    const work = Promise.resolve().then(() => provider.loginStatus()).finally(() => { check.pending = false; });
    void Promise.race([work, expired]).then(status => {
      if (authChecks.get(source) !== check || provider.getCookie() !== credential) return;
      if (status?.loggedIn === false && status.code === SOURCE_FAILURE.REQUIRES_AUTH) recordFailure(source, status.code);
    }).catch(() => {}).finally(() => { clearTimeout(timer); });
  }
  const recordSuccess = id => {
    const source = registry.get(id)?.id;
    if (!source) return;
    health.recordSuccess(source);
    if (!pendingAuth.has(source) && issues.delete(source)) emit(source, null);
  };
  setSourceHealthReporter((id, code) => {
    if (code) recordFailure(id, code);
    else recordSuccess(id);
  });

  return {
    read: id => health.read(id),
    snapshot: async () => {
      try {
        return await health.snapshot();
      } catch (error) {
        // 健康探测失败绝不能影响设置页；退化为空健康表，前端回落到基础源列表。
        logger?.warn?.(`[music-source] health snapshot failed: ${error?.message || error}`);
        return [];
      }
    },
    // 解析与播放路径发现自己这次失败了可以记一笔，让界面有机会说明原因。
    recordFailure,
    recordSuccess,
    recordAuthenticated: id => {
      const source = registry.get(id)?.id;
      if (!source) return;
      health.recordSuccess(source);
      authChecks.delete(source);
      pendingAuth.delete(source);
      issues.delete(source);
      emit(source, null);
    },
    // 首次连接/重连重放尚未恢复的鉴权事实；不带 UID、Cookie 或上游原文。
    authFailures: () => [...pendingAuth].map(source => ({ source, code: SOURCE_FAILURE.REQUIRES_AUTH })),
    sourceIssues: () => [...issues].map(([source, code]) => ({ source, displayName: registry.get(source)?.displayName || source, code })),
    subscribe: listener => {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inspect: () => health.inspect(),
  };
}

/**
 * 生产实例。健康状态是进程内观测（最近失败 / 最近一次登录核验），
 * 天然应当只有一份——组合根直接取它，不必自己 new 一个。
 */
export const productionSourceHealth = createSourceHealthWiring({ providers: { ncm, qq } });
