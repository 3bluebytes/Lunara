// sourceHealth.js — 音乐源的**派生**健康状态。
//
// 两条原则：
//
// 1. 不持久化。把「某源可用/不可用」写进库，必然与真实状态不同步，而这类不同步
//    会直接变成「明明能播却提示不可用」。这里只保留短期的**观察**（最近一次失败、
//    最近一次登录态核验），进程重启即清空。
// 2. 不假装知道得更多。我们只知道「最近一次尝试的结果」。没有失败记录就是 ready，
//    而不是「正在探测中」这种编出来的中间态。登录态单独作为 `authenticated` 字段，
//    不直接推成「不可用」——QQ 与网易云在未登录时仍能搜索和播放部分公开内容。
//
// 因此 health 的语义是：**最近观察到的事实**，不是主动探测的结论。

import { SOURCE_FAILURE, classifySourceFailure } from './sourceFailure.js';

export const SOURCE_HEALTH_READY = 'ready';
export const SOURCE_HEALTH_CATALOG_ONLY = 'catalog-only';

export function createSourceHealth({
  registry,
  // (id) => ({ loggedIn, userId }) | null；可为异步。抛错按「核验失败」处理。
  loginStatusOf = null,
  now = () => Date.now(),
  failureTtlMs = 5 * 60_000,
  loginTtlMs = 30_000,
} = {}) {
  if (!registry) throw new TypeError('createSourceHealth requires a provider registry');
  const failures = new Map();
  const logins = new Map();

  function normalize(id) {
    return String(id ?? '').trim().toLowerCase();
  }

  /** 记录一次可归因的失败。只保留 code 与时间，不留原文。 */
  function recordFailure(id, code) {
    const key = normalize(id);
    if (!registry.get(key)) return null;
    const entry = { code: classifySourceFailure(code), at: now() };
    failures.set(key, entry);
    return entry;
  }

  /** 一次成功就清掉失败记录：用户的下一步操作应该立刻看到效果。 */
  function recordSuccess(id) {
    return failures.delete(normalize(id));
  }

  async function loginFact(id, declaration) {
    if (!loginStatusOf || declaration.authMode === 'none') return null;
    const cached = logins.get(id);
    if (cached && now() - cached.at < loginTtlMs) return cached.value;
    try {
      const value = await loginStatusOf(id);
      const normalized = value && typeof value === 'object'
        ? { loggedIn: value.loggedIn === true }
        : null;
      logins.set(id, { value: normalized, at: now() });
      return normalized;
    } catch {
      // 核验本身失败不代表源不可用；不写入任何负面状态，也不回显原因。
      logins.set(id, { value: null, at: now() });
      return null;
    }
  }

  /** 单个源的派生状态。未知 id 返回 null，不编造。 */
  async function read(id) {
    const declaration = registry.get(id);
    if (!declaration) return null;
    const key = declaration.id;
    const login = await loginFact(key, declaration);
    if (!declaration.playable) {
      return Object.freeze({
        id: key, displayName: declaration.displayName, playable: false,
        state: SOURCE_HEALTH_CATALOG_ONLY, since: null, authenticated: login?.loggedIn ?? null,
      });
    }
    const failure = failures.get(key);
    const fresh = failure && now() - failure.at < failureTtlMs ? failure : null;
    if (failure && !fresh) failures.delete(key);
    return Object.freeze({
      id: key,
      displayName: declaration.displayName,
      playable: true,
      state: fresh ? fresh.code : SOURCE_HEALTH_READY,
      since: fresh ? fresh.at : null,
      authenticated: login?.loggedIn ?? null,
    });
  }

  async function snapshot() {
    return Promise.all(registry.list().map(source => read(source.id)));
  }

  /** 仅供诊断：不含任何原文。 */
  function inspect() {
    return { failures: [...failures.entries()].map(([id, entry]) => ({ id, code: entry.code, at: entry.at })) };
  }

  return Object.freeze({ read, snapshot, recordFailure, recordSuccess, inspect, SOURCE_FAILURE });
}
