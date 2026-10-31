// trace.js — 执行追踪上下文与落到会话 JSONL 的事件出口。
//
// 一次会话回合在 AsyncLocalStorage 中携带身份（sessionId/roundId/requestId/
// virtualPersonId），回合内所有模型调用、工具执行和 service 事件因此自动归属同一
// 执行链；没有上下文的调用不记录，也不会把私人正文打印到终端。
// 转义出口是 store.emit(event)：生产是会话 JSONL writer，测试可注入数组收集器。

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

/** 当前追踪上下文（只读视图）；无上下文返回 null。 */
export function activeTraceContext() {
  const store = als.getStore();
  return store ? { ...store } : null;
}

/**
 * 进入追踪上下文执行。子上下文继承父身份，可覆盖 requestId/virtualPersonId/spanId。
 * @param {{traceId?: string, sessionId?: string, emit?: Function, [key: string]: any}} context
 * @param {Function} fn
 */
export function runWithTrace(context, fn) {
  const hasSession = typeof context?.sessionId === 'string' && Boolean(context.sessionId);
  const hasTask = Boolean(context?.taskType && context?.taskId);
  if (!context || (!hasSession && !hasTask)) return fn();
  const parent = als.getStore() || null;
  const merged = { ...(parent || {}), ...context };
  if (typeof merged.emit !== 'function' && typeof parent?.emit === 'function') merged.emit = parent.emit;
  merged.traceId = context.traceId || parent?.traceId || merged.sessionId || `${merged.taskType}:${merged.taskId}`;
  return als.run(merged, fn);
}

function emitEvent(event) {
  const store = als.getStore();
  if (!store || typeof store.emit !== 'function' || !event || typeof event !== 'object') return;
  try { store.emit(event); } catch { /* 记录失败不影响业务 */ }
}

/**
 * 结构化事件出口。对象参数按事件记录；字符串参数合成为 message 事件。
 * 无上下文时是 no-op（不再是直接打印）。
 */
export function trace(...args) {
  if (!als.getStore()) return;
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    emitEvent({ type: 'service_event', ...args[0] });
    return;
  }
  emitEvent({ type: 'message', message: args.map(value =>
    typeof value === 'string' ? value : JSON.stringify(value ?? null)).join(' ') });
}

/** 带分区标记的事件（保持旧调用形状）。 */
export function traceSection(section, ...args) {
  if (!als.getStore()) return;
  emitEvent({ type: 'section', section: String(section || ''), message: args.map(value =>
    typeof value === 'string' ? value : JSON.stringify(value ?? null)).join(' ') });
}
