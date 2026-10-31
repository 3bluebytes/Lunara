// ManagedTaskGroup.js — explicit ownership for timers and subscriptions.

export class ManagedTaskGroup {
  constructor({ clock = globalThis } = {}) {
    this.clock = clock;
    this._cleanups = [];
  }

  get size() {
    return this._cleanups.length;
  }

  _own(cleanup) {
    const entry = { cleanup };
    this._cleanups.push(entry);
    return entry;
  }

  _forget(entry) {
    const index = this._cleanups.indexOf(entry);
    if (index >= 0) this._cleanups.splice(index, 1);
  }

  timeout(callback, ms) {
    let entry;
    const handle = this.clock.setTimeout(async () => {
      this._forget(entry);
      await callback();
    }, ms);
    entry = this._own(() => this.clock.clearTimeout(handle));
    return handle;
  }

  interval(callback, ms) {
    const handle = this.clock.setInterval(callback, ms);
    this._own(() => this.clock.clearInterval(handle));
    return handle;
  }

  addCleanup(cleanup) {
    if (typeof cleanup !== 'function') throw new TypeError('cleanup must be a function');
    this._own(cleanup);
    return cleanup;
  }

  async stop() {
    const failures = [];
    while (this._cleanups.length > 0) {
      const entry = this._cleanups.pop();
      try {
        await entry.cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'managed task cleanup failed');
    }
  }
}
