// Notifications only. Durable ownership and receipts live in the stores, not in the bus.
function validateEnvelope(msg) {
  if (!msg || typeof msg !== 'object') {
    return `event: envelope is not an object`;
  }
  if (!msg.id) return `event: missing id`;
  if (!msg.type) return `event: missing type`;
  if (!msg.sourceAgentId) return `event: missing sourceAgentId`;
  if (typeof msg.createdAt !== 'number') return `event: missing createdAt`;
  if (!msg.payload || typeof msg.payload !== 'object') return `event: missing payload object`;
  return null;
}

export class InMemoryAgentMessageBus {
  constructor(opts = {}) {
    /** @type {Map<string, Set<EventSubscriber>>} */
    this._subscribers = new Map();
    /** Pending subscriber microtasks. flush() awaits these. */
    this._pending = 0;
    /** @type {Array<() => void>} */
    this._idleWaiters = [];
    this._log = opts.log === false ? () => {} : (level, ...rest) => {
      // Compact, single-line trace for debugging cross-agent flows.
      // Disable by passing { log: false } to the constructor (used in tests).
      const fn = console[level] || console.log;
      fn('[bus]', ...rest);
    };
  }

  // ===================== Events =====================

  /**
   * Fire-and-forget. Subscribers run on queued microtasks; a publisher cannot
   * be re-entered by its own subscribers synchronously.
   * @param {Event} event
   */
  publishEvent(event) {
    const err = validateEnvelope(event);
    if (err) {
      // Don't throw — events are fire-and-forget. Log and drop.
      console.warn('[bus] dropping invalid event:', err);
      return;
    }
    const subs = this._subscribers.get(event.type);
    if (!subs || subs.size === 0) {
      this._log('log', `·evt ${event.type} (no subscribers)`);
      return;
    }
    this._log('log', `→evt ${event.type} src=${event.sourceAgentId} fanout=${subs.size}${event.correlationId ? ' cid=' + event.correlationId : ''}`);
    // Snapshot subscribers — protect against modifications during dispatch.
    const snapshot = [...subs];
    for (const sub of snapshot) {
      this._pending++;
      queueMicrotask(async () => {
        try {
          await sub(event);
        } catch (e) {
          console.error(`[bus] subscriber for ${event.type} threw:`, e.message);
        } finally {
          this._pending--;
          if (this._pending === 0) {
            const waiters = this._idleWaiters;
            this._idleWaiters = [];
            for (const r of waiters) r();
          }
        }
      });
    }
  }

  /**
   * @param {string} type
   * @param {EventSubscriber} handler
   * @returns {() => void} unsubscribe
   */
  subscribe(type, handler) {
    let set = this._subscribers.get(type);
    if (!set) {
      set = new Set();
      this._subscribers.set(type, set);
    }
    set.add(handler);
    return () => {
      const s = this._subscribers.get(type);
      if (s) s.delete(handler);
    };
  }

  // ===================== Test helpers =====================

  /**
   * Resolve once all currently queued event-subscriber microtasks have settled.
   * Tests use this to assert post-event state without setTimeout races.
   * @returns {Promise<void>}
   */
  flush() {
    if (this._pending === 0) return Promise.resolve();
    return new Promise(resolve => {
      this._idleWaiters.push(resolve);
    });
  }
}

/**
 * Factory. Other modules import this and avoid naming the concrete class.
 * @returns {InMemoryAgentMessageBus}
 */
export function createBus(opts) {
  return new InMemoryAgentMessageBus(opts);
}
