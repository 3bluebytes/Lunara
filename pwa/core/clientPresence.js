// clientPresence.js — 把「这个窗口看得见吗、有没有在输入、静置后是否重新聚焦房间」告诉服务端（add-app-open-greeting / add-structured-beats-and-real-clock-presence）。
//
// 默认只发布尔值 { type: 'client-presence', visible, typing }（未传 getActiveSessionId 时不附带多余字段）。
// 当提供 getActiveSessionId 或调用 notifyRoomFocus(sessionId) 时，附带当前房间 activeSessionId；
// 窗口持续可见且未输入超过 idleThresholdMs（默认 25 分钟）后切回/聚焦某房间时，发送一次性 idleReturn 边沿。
// 连上时补发一次当前状态；之后只在变化或触发 idleReturn 时发。没连上就丢弃，下次连上再补。
const OPEN = 1;
export const DEFAULT_IDLE_THRESHOLD_MS = 25 * 60_000;
export const DEFAULT_FOCUS_SETTLE_MS = 120;

export function createClientPresence({
  getSocket,
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  input = null,
  getActiveSessionId = null,
  isRoomViewActive = () => true,
  now = () => Date.now(),
  idleThresholdMs = DEFAULT_IDLE_THRESHOLD_MS,
  focusSettleMs = DEFAULT_FOCUS_SETTLE_MS,
  setTimer = (fn, ms) => { const h = setTimeout(fn, ms); h?.unref?.(); return h; },
  clearTimer = handle => clearTimeout(handle),
} = {}) {
  if (typeof getSocket !== 'function') throw new TypeError('client presence requires getSocket()');
  const thresholdMs = Math.max(1_000, Number(idleThresholdMs) || DEFAULT_IDLE_THRESHOLD_MS);
  const settleMs = Math.max(0, Number.isFinite(Number(focusSettleMs)) ? Number(focusSettleMs) : DEFAULT_FOCUS_SETTLE_MS);
  const cleanups = [];
  let last = null;
  const bootAt = now();
  let lastGlobalActiveAt = bootAt;
  const lastRoomActiveAt = new Map();
  let wasVisible = documentLike?.visibilityState !== 'hidden';
  let settleTimer = null;
  let pendingSettleAt = null;
  let pendingSettleOriginSid = null;

  const resolveSessionId = (explicitSessionId = null) => {
    if (typeof explicitSessionId === 'string' && explicitSessionId.trim()) {
      return explicitSessionId.trim();
    }
    if (typeof getActiveSessionId === 'function') {
      const sid = getActiveSessionId();
      return typeof sid === 'string' && sid.trim() ? sid.trim() : null;
    }
    return null;
  };

  const initialSid = resolveSessionId();
  if (initialSid) lastRoomActiveAt.set(initialSid, bootAt);

  function roomSince(sid) {
    if (!sid) return lastGlobalActiveAt;
    return lastRoomActiveAt.has(sid) ? lastRoomActiveAt.get(sid) : bootAt;
  }

  function markActive(sid, at) {
    lastGlobalActiveAt = at;
    if (sid) lastRoomActiveAt.set(sid, at);
  }

  function cancelSettle() {
    if (settleTimer != null) {
      clearTimer(settleTimer);
      settleTimer = null;
    }
    pendingSettleAt = null;
    pendingSettleOriginSid = null;
  }

  function reconcileStaleSettle(at) {
    if (pendingSettleAt !== null && at - pendingSettleAt > settleMs) {
      markActive(pendingSettleOriginSid, pendingSettleAt);
      cancelSettle();
    }
  }

  const current = (explicitSessionId = null) => {
    const visible = documentLike?.visibilityState !== 'hidden';
    const typing = String(input?.value ?? '').trim().length > 0;
    const activeSessionId = resolveSessionId(explicitSessionId);
    return {
      visible,
      typing,
      ...(activeSessionId ? { activeSessionId } : {}),
    };
  };

  function sendState(state, extra = null) {
    const socket = getSocket();
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify({ type: 'client-presence', ...state, ...(extra || {}) }));
    } catch {
      return false;
    }
    last = `${state.visible}:${state.typing}:${state.activeSessionId || ''}`;
    return true;
  }

  function report({ force = false, sessionId = null } = {}) {
    const state = current(sessionId);
    const key = `${state.visible}:${state.typing}:${state.activeSessionId || ''}`;
    if (!force && key === last) return false;
    return sendState(state);
  }

  function evaluateRoomFocus(explicitSessionId = null, { fromSettle = false } = {}) {
    const state = current(explicitSessionId);
    if (!state.visible) return false;
    const at = now();
    const targetSid = state.activeSessionId || null;
    if (!targetSid) {
      markActive(null, at);
      return report({ sessionId: null });
    }
    if (fromSettle && typeof isRoomViewActive === 'function' && !isRoomViewActive()) {
      return false;
    }
    const awayMs = at - roomSince(targetSid);
    markActive(targetSid, at);
    if (!state.typing && awayMs >= thresholdMs) {
      return sendState(
        { ...state, activeSessionId: targetSid },
        { idleReturn: { sessionId: targetSid, awayMs, firedAtMs: at } },
      );
    }
    return report({ sessionId: targetSid });
  }

  function scheduleRoomFocus() {
    if (documentLike?.visibilityState === 'hidden') return false;
    if (typeof isRoomViewActive === 'function' && !isRoomViewActive()) return false;
    const at = now();
    reconcileStaleSettle(at);
    const sid = resolveSessionId();
    if (String(input?.value ?? '').trim().length > 0) {
      cancelSettle();
      markActive(sid, at);
      return false;
    }
    if (!sid && typeof getActiveSessionId !== 'function') {
      markActive(null, at);
      return false;
    }
    if (settleTimer != null) clearTimer(settleTimer);
    pendingSettleAt = at;
    pendingSettleOriginSid = sid;
    settleTimer = setTimer(() => {
      settleTimer = null;
      pendingSettleAt = null;
      pendingSettleOriginSid = null;
      evaluateRoomFocus(null, { fromSettle: true });
    }, settleMs);
    return true;
  }

  function notifyRoomFocus(sessionId = null) {
    const at = now();
    reconcileStaleSettle(at);
    cancelSettle();
    return evaluateRoomFocus(sessionId, { fromSettle: false });
  }

  function listen(element, type, handler = () => { report(); }) {
    if (!element?.addEventListener) return;
    element.addEventListener(type, handler);
    cleanups.push(() => element.removeEventListener(type, handler));
  }

  return Object.freeze({
    init() {
      if (cleanups.length) return;
      const sid = resolveSessionId();
      if (sid && !lastRoomActiveAt.has(sid)) lastRoomActiveAt.set(sid, now());
      listen(documentLike, 'visibilitychange', () => {
        const isVisible = documentLike?.visibilityState !== 'hidden';
        if (isVisible && !wasVisible) {
          cancelSettle();
          markActive(resolveSessionId(), now());
        }
        wasVisible = isVisible;
        report();
      });
      // 输入框清空（回车发送）不触发 input 事件，所以 keyup/blur 也看一眼。
      for (const type of ['input', 'keyup']) {
        listen(input, type, () => {
          const at = now();
          if (documentLike?.visibilityState !== 'hidden') {
            if (typeof isRoomViewActive !== 'function' || isRoomViewActive()) {
              cancelSettle();
              markActive(resolveSessionId(), at);
            }
          }
          report();
        });
      }
      listen(input, 'blur');
      for (const type of ['keydown', 'pointerdown']) {
        listen(documentLike, type, () => {
          if (documentLike?.visibilityState === 'hidden') return;
          scheduleRoomFocus();
        });
      }
      listen(windowLike, 'focus', () => {
        if (documentLike?.visibilityState === 'hidden') return;
        scheduleRoomFocus();
      });
    },
    /** WebSocket 连上（含重连）时调用：补发当前状态。 */
    connected: () => report({ force: true }),
    notifyRoomFocus,
    scheduleRoomFocus,
    report,
    destroy() {
      cancelSettle();
      while (cleanups.length) cleanups.pop()();
    },
  });
}

export default createClientPresence;
