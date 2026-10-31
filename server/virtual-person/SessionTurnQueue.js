export class SessionTurnQueue {
  constructor() {
    this._tails = new Map();
  }

  run(sessionId, work) {
    const key = String(sessionId || '').trim();
    if (!key) return Promise.reject(new TypeError('sessionId is required'));
    if (typeof work !== 'function') return Promise.reject(new TypeError('work must be a function'));

    const previous = this._tails.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this._tails.set(key, current);

    return previous
      .catch(() => {})
      .then(work)
      .finally(() => {
        release();
        if (this._tails.get(key) === current) this._tails.delete(key);
      });
  }

  /** 只读：该会话是否有排队或运行中的回合（presence 据此让路，不读私有 _tails）。 */
  has(sessionId) {
    return this._tails.has(String(sessionId || '').trim());
  }

  get activeSessions() {
    return this._tails.size;
  }
}
