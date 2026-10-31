export const WEB_CAPABILITY = 'web.read';
export const LIMITS = Object.freeze({ searches: 2, fetches: 2, concurrency: 2, searchMs: 12000, fetchMs: 10000,
  windowMs: 25000, searchBytes: 512 * 1024, pageBytes: 1024 * 1024, outputBytes: 3500, redirects: 3 });
const PREF = 'web-access-policy';
export class WebAccessPolicy {
  constructor(state) {
    this.state = state;
    let saved; try { saved = JSON.parse(state.getPref(PREF) || '{}'); } catch { saved = {}; }
    this.value = { enabled: saved?.enabled === true, allowDegoogFallback: saved?.allowDegoogFallback === true,
      revision: Number.isSafeInteger(saved?.revision) && saved.revision >= 0 ? saved.revision : 0 };
    this.listeners = new Set();
  }
  snapshot() { return { ...this.value }; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  update(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length
      || Object.entries(input).some(([key,value]) => !['enabled','allowDegoogFallback'].includes(key) || typeof value !== 'boolean')) {
      throw Object.assign(new Error('联网设置只接受启用与备用开关。'), { statusCode: 400 });
    }
    const next = { ...this.value, ...input, revision: this.value.revision + 1 };
    this.state.setPref(PREF, JSON.stringify(next)); // 落盘成功后才接受和通知。
    this.value = next;
    for (const fn of this.listeners) fn(this.snapshot());
    return this.snapshot();
  }
}
