// unplayableTrackMemory.js — 「这首暂时放不了」的进程内短期记录。
//
// 只收解析器明确给出的「拿不到音源」（canonical-resource-unavailable + not-playable，
// 含只有试听片段的情况）；超时、源挂了、登录态失效、限流等临时故障不记，否则一次断网会把整池拉黑。
// 该源登录成功后按源清除（clearProvider），原证据随账号状态失效。
// 按 canonical `(provider, songId)` 记，不按歌名合并。它不是口味信号：
// 不进记忆、反思或 taste signals，也不代表用户不喜欢这首歌。

import { SOURCE_FAILURE } from '../music/sourceFailure.js';

const DEFAULT_TTL_MS = Math.max(60_000, Number(process.env.MUSIC_UNPLAYABLE_TTL_MS) || 3 * 60 * 60 * 1000);
const DEFAULT_MAX_ITEMS = 2000;

export const isConfirmedUnplayable = result => Boolean(result && result.ok !== true
  && result.error === 'canonical-resource-unavailable' && result.code === SOURCE_FAILURE.NOT_PLAYABLE);

export class UnplayableTrackMemory {
  constructor({ now = Date.now, ttlMs = DEFAULT_TTL_MS, maxItems = DEFAULT_MAX_ITEMS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxItems = maxItems;
    this._entries = new Map();
  }

  get size() { return this._entries.size; }

  _key(provider, songId) {
    const source = String(provider || '').trim();
    const id = String(songId || '').trim();
    return source && id ? `${source}:${id}` : null;
  }

  has(provider, songId) {
    const key = this._key(provider, songId);
    if (!key) return false;
    const expiresAt = this._entries.get(key);
    if (expiresAt == null) return false;
    if (expiresAt > this.now()) return true;
    this._entries.delete(key);
    return false;
  }

  /** 该源账号状态变了（登录成功），原先「拿不到音源」的证据失效，按源清除。返回清除条数。 */
  clearProvider(provider) {
    const prefix = `${String(provider || '').trim()}:`;
    if (prefix === ':') return 0;
    let cleared = 0;
    for (const key of [...this._entries.keys()]) {
      if (key.startsWith(prefix)) { this._entries.delete(key); cleared += 1; }
    }
    return cleared;
  }

  /** 记录期内重复标记不延长冷却。 */
  mark(provider, songId) {
    const key = this._key(provider, songId);
    if (!key || this.has(provider, songId)) return;
    this._entries.set(key, this.now() + this.ttlMs);
    while (this._entries.size > this.maxItems) this._entries.delete(this._entries.keys().next().value);
  }
}
