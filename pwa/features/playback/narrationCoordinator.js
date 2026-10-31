function sourceMatches(actual, expected, locationHref) {
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  try { return new URL(expected, locationHref).href === actual; } catch { return false; }
}

const NOOP = () => {};

/**
 * The sole owner of the browser narration audio element.
 *
 * Foreground tasks are ordinary user-facing replies/interstitials. Runtime
 * tasks are correlated track introductions. While a foreground turn is in
 * flight, runtime tasks may queue but cannot take the audio element. This lets
 * the user's reply finish before automatic-continuation narration and media.
 */
export function createNarrationCoordinator({
  audio,
  locationHref = globalThis.location?.href || '',
  logger = console,
} = {}) {
  if (!audio?.addEventListener || typeof audio.play !== 'function') {
    throw new TypeError('narration coordinator requires an audio element');
  }

  let initialized = false;
  let destroyed = false;
  let pumping = false;
  let sequence = 0;
  let active = null;
  let queue = [];
  const foregroundTurns = new Set();
  const foregroundWaiters = new Set();
  const lifecycleListeners = new Set();

  function snapshot() {
    return Object.freeze({
      active: active ? { id: active.id, lane: active.lane, url: active.url, status: active.status } : null,
      queued: queue.map(task => ({ id: task.id, lane: task.lane, url: task.url })),
      foregroundTurns: [...foregroundTurns],
    });
  }

  function notifyWaitersIfIdle() {
    if (foregroundTurns.size > 0) return;
    for (const resolve of foregroundWaiters) resolve();
    foregroundWaiters.clear();
  }

  function nextRunnableIndex() {
    if (queue.length === 0) return -1;
    if (foregroundTurns.size === 0) return 0;
    return queue.findIndex(task => task.lane !== 'runtime');
  }

  function safely(callback, ...args) {
    try { callback?.(...args); } catch (error) { logger?.warn?.('[narration] callback failed:', error.message); }
  }

  function emitLifecycle(type, task, detail = null) {
    for (const listener of lifecycleListeners) safely(listener, { type, task, detail });
  }

  function clearOwnedSource(task) {
    if (!task || !sourceMatches(audio.src, task.url, locationHref)) return;
    audio.pause();
    audio.src = '';
  }

  function finishActive(outcome, detail = null) {
    const task = active;
    if (!task) return false;
    active = null;
    clearOwnedSource(task);
    emitLifecycle(outcome, task, detail);
    if (outcome === 'finished') safely(task.onFinish, task);
    else if (outcome === 'error') safely(task.onError, detail, task);
    else safely(task.onCancel, detail, task);
    void pump();
    return true;
  }

  async function pump() {
    if (destroyed || active || pumping) return false;
    const index = nextRunnableIndex();
    if (index < 0) return false;
    pumping = true;
    const [task] = queue.splice(index, 1);
    const token = task.token;
    active = { ...task, status: 'starting' };
    try {
      const eligible = await task.beforeStart?.(active);
      if (!active || active.token !== token) return false;
      if (eligible === false) {
        finishActive('cancelled', 'pre-start-ineligible');
        return false;
      }
      audio.pause();
      audio.src = task.url;
      const result = audio.play();
      if (result?.then) await result;
      if (!active || active.token !== token) return false;
      const startResult = active.onStart(active);
      const accepted = startResult?.then ? await startResult : startResult;
      if (!active || active.token !== token) return false;
      if (accepted === false) {
        finishActive('cancelled', 'start-rejected');
        return false;
      }
      active.status = 'playing';
      emitLifecycle('started', active);
      // A very short clip can finish while the asynchronous audible
      // acknowledgement is in flight. The ended event is ignored while the
      // task is in `starting`, so reconcile it once the acknowledgement lands.
      if (audio.ended === true) finishActive('finished');
      return true;
    } catch (error) {
      if (active?.token === token) finishActive('error', error);
      return false;
    } finally {
      pumping = false;
      if (!active) void pump();
    }
  }

  function enqueue(task = {}) {
    const url = String(task.url || '').trim();
    if (!url) return null;
    const normalized = {
      id: String(task.id || `narration-${sequence + 1}`),
      token: ++sequence,
      lane: task.lane === 'runtime' ? 'runtime' : 'foreground',
      url,
      meta: task.meta || null,
      onStart: task.onStart || NOOP,
      beforeStart: task.beforeStart || null,
      onFinish: task.onFinish || NOOP,
      onError: task.onError || NOOP,
      onCancel: task.onCancel || NOOP,
    };
    queue.push(normalized);
    void pump();
    return normalized.token;
  }

  function cancel(predicate = () => true, reason = 'cancelled') {
    const matches = typeof predicate === 'function' ? predicate : () => true;
    const removed = [];
    queue = queue.filter(task => {
      if (!matches(task)) return true;
      removed.push(task);
      return false;
    });
    for (const task of removed) {
      emitLifecycle('cancelled', task, reason);
      safely(task.onCancel, reason, task);
    }
    if (active && matches(active)) {
      finishActive('cancelled', reason);
      return removed.length + 1;
    }
    void pump();
    return removed.length;
  }

  function beginForegroundTurn(turnId) {
    const id = String(turnId || 'foreground');
    foregroundTurns.add(id);
    return id;
  }

  function endForegroundTurn(turnId) {
    foregroundTurns.delete(String(turnId || 'foreground'));
    notifyWaitersIfIdle();
    void pump();
  }

  function waitForForeground() {
    if (foregroundTurns.size === 0) return Promise.resolve();
    return new Promise(resolve => foregroundWaiters.add(resolve));
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('narration lifecycle listener must be a function');
    lifecycleListeners.add(listener);
    return () => lifecycleListeners.delete(listener);
  }

  function publishLifecycle(type, task, detail = null) {
    if (!task || !['runtime-audible'].includes(type)) return false;
    emitLifecycle(type, task, detail);
    return true;
  }

  const listeners = {
    ended: () => {
      if (!active || active.status !== 'playing') return;
      if (!sourceMatches(audio.src, active.url, locationHref)) return;
      finishActive('finished');
    },
    error: () => {
      if (!active || active.status !== 'playing') return;
      if (!sourceMatches(audio.src, active.url, locationHref)) return;
      finishActive('error', audio.error || new Error('narration media error'));
    },
  };

  function init() {
    if (initialized) return api;
    initialized = true;
    destroyed = false;
    audio.addEventListener('ended', listeners.ended);
    audio.addEventListener('error', listeners.error);
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    destroyed = true;
    audio.removeEventListener('ended', listeners.ended);
    audio.removeEventListener('error', listeners.error);
    cancel(() => true, 'destroyed');
    foregroundTurns.clear();
    notifyWaitersIfIdle();
    audio.pause();
    audio.src = '';
  }

  function cancelAll(reason = 'cancelled') {
    const count = cancel(() => true, reason);
    // STOP/reset must also clean up media that predates this coordinator or was
    // restored by the browser without a matching in-memory task.
    audio.pause();
    audio.src = '';
    return count;
  }

  const api = Object.freeze({
    init,
    destroy,
    enqueue,
    cancel,
    cancelAll,
    beginForegroundTurn,
    endForegroundTurn,
    waitForForeground,
    subscribe,
    publishLifecycle,
    getSnapshot: snapshot,
  });
  return api;
}
