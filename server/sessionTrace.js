// sessionTrace.js — 会话执行记录的门面：把运行时、模型观测与服务事件统一送进
// SessionTraceStore，并负责把 AsyncLocalStorage 身份与显式身份合并、投影 llm 事件。
//
// 所有方法在 store 缺失时是安全 no-op：没有接线的环境（测试、纯 CLI 命令）照常运行。

import { activeTraceContext, runWithTrace } from './trace.js';

const EVENT_IDENTITY_KEYS = ['executionId', 'roundId', 'requestId', 'virtualPersonId',
  'spanId', 'parentSpanId', 'toolCallId', 'modelCallId'];

function identityOf(value = {}) {
  const identity = {};
  for (const key of EVENT_IDENTITY_KEYS) {
    if (value[key] != null && value[key] !== '') identity[key] = value[key];
  }
  return identity;
}

export function createSessionTrace({ store = null, logger = console } = {}) {
  const noop = () => {};
  if (!store) {
    return Object.freeze({
      available: false,
      record: noop, recordScoped: noop, recordTask: noop, recordModel: noop,
      enter: (_context, fn) => fn(), enterTask: (_context, fn) => fn(),
      flush: async () => {}, deleteSession: async () => {},
      status: () => ({ pendingBytes: 0, droppedEvents: 0, writeFailures: 0 }),
    });
  }

  const record = (context = {}, event = {}) => {
    try {
      const active = activeTraceContext() || {};
      const merged = { ...active, ...context };
      const sessionId = merged.sessionId;
      if (sessionId) {
        store.record({ sessionId, ...identityOf(merged) }, event);
        return;
      }
      if (merged.taskType && merged.taskId) {
        store.recordTask({ ...merged, ...identityOf(merged) }, event);
      }
    } catch { /* 记录失败不影响业务 */ }
  };

  const recordScoped = (sessionId, event, extra = {}) => {
    if (!sessionId) return;
    record({ ...extra, sessionId }, event);
  };

  const recordTask = (context = {}, event = {}) => {
    try {
      const active = activeTraceContext() || {};
      const merged = { ...active, ...context };
      if (!merged.taskType || !merged.taskId) return;
      store.recordTask({ ...merged, ...identityOf(merged) }, event);
    } catch { /* 记录失败不影响业务 */ }
  };

  // llm 观测事件（server/llm.js 的 setLlmObserver）→ 会话或任务文件。
  //
  // 归属规则：显式 null/'' = 生产者声明「本次调用无归属」（如后台打标/回填：它是被某个
  // 聊天恰好触发，但不是该会话的一部分），此时**不**回退到 AsyncLocalStorage 上下文；
  // 只有缺省（undefined）才回退到当前回合身份。
  // 若无会话身份，但处于活跃任务上下文（如模型能力探测），则自动归属该任务文件。
  // 既无会话也无任务的维护调用不伪造任何文件。
  const recordModel = event => {
    if (!event || typeof event !== 'object') return;
    const active = activeTraceContext() || {};
    let sessionId;
    if (event.sessionId === undefined) sessionId = active.sessionId;
    else if (event.sessionId == null || event.sessionId === '') sessionId = null; // 显式无主
    else sessionId = event.sessionId;

    const taskType = event.taskType ?? (sessionId ? null : active.taskType);
    const taskId = active.taskId ?? (sessionId ? null : event.traceTaskId);

    if (!sessionId && (!taskType || !taskId)) return; // 既无会话也无任务，安全丢弃

    const identity = { ...identityOf(active), ...identityOf({ requestId: event.requestId }) };
    const base = { model: event.model ?? null, api: event.api ?? null, source: event.source ?? null,
      virtualPersonId: event.virtualPersonId ?? identity.virtualPersonId ?? undefined };
    const target = sessionId ? { sessionId, ...identity } : { taskType, taskId, ...identity };

    if (event.phase === 'start') {
      record(target, { type: 'model_request', ...base,
        taskId: event.taskId ?? null,
        maxTokens: event.maxTokens ?? null, temperature: event.temperature ?? null,
        timeoutMs: event.timeoutMs ?? null, thinkingMode: event.thinkingMode ?? null,
        thinkingBudget: event.thinkingBudget ?? null,
        toolChoice: event.toolChoice ?? null, toolNames: event.toolNames || [],
        structuredMeans: event.structuredMeans ?? null,
        overrideSources: event.overrideSources || [],
        budget: event.budget ?? null,
        body: event.body ?? null });
      return;
    }
    if (event.phase === 'attempt') {
      // 每次尝试一条 model_attempt：任务、额度、分类、升级与用量（design §3 任务 3.4）。
      record(target, { type: 'model_attempt', ...base,
        taskId: event.taskId ?? null, attempt: event.attempt ?? null, escalatedFrom: event.escalatedFrom ?? null,
        outcome: event.outcome ?? null, truncated: event.truncated === true,
        finishReason: event.finishReason ?? null, durationMs: event.durationMs ?? null,
        usage: event.usage ?? null, reasoningTokens: event.reasoningTokens ?? null,
        budget: event.budget ?? null, structuredMeans: event.structuredMeans ?? null });
      return;
    }
    if (event.phase === 'end') {
      record(target, { type: 'model_response', ...base,
        taskId: event.taskId ?? null, outcome: event.outcome ?? null,
        attempt: event.attempt ?? null, escalatedFrom: event.escalatedFrom ?? null,
        budget: event.budget ?? null, structuredMeans: event.structuredMeans ?? null,
        durationMs: event.durationMs ?? null, finishReason: event.finishReason ?? null,
        usage: event.usage ?? null, reasoning: event.reasoning ?? null,
        reasoningTokens: event.reasoningTokens ?? null, text: event.text ?? null,
        toolCalls: event.toolCalls ?? null });
      return;
    }
    if (event.phase === 'error') {
      record(target, { type: 'model_error', ...base,
        taskId: event.taskId ?? null, attempt: event.attempt ?? null,
        outcome: event.outcome ?? null,
        durationMs: event.durationMs ?? null, errorCode: event.errorCode ?? null, status: event.status ?? null,
        providerDetail: event.providerDetail ?? null });
    }
  };

  // 进入追踪上下文：上下文内 trace()/traceSection() 的事件写入同一会话文件。
  const enter = (context = {}, fn) => {
    if (typeof fn !== 'function') return undefined;
    if (!context.sessionId) return fn();
    const sessionId = context.sessionId;
    const identity = identityOf(context);
    return runWithTrace({
      traceId: context.traceId || context.requestId || sessionId,
      ...identity,
      sessionId,
      emit: event => record({ sessionId, ...identity }, event),
    }, fn);
  };

  // 进入任务追踪上下文：用于模型能力探测等无会话任务。
  const enterTask = (context = {}, fn) => {
    if (typeof fn !== 'function') return undefined;
    if (!context.taskType || !context.taskId) return fn();
    const taskType = context.taskType;
    const taskId = String(context.taskId);
    const identity = identityOf(context);
    return runWithTrace({
      traceId: context.traceId || context.requestId || `${taskType}:${taskId}`,
      ...identity,
      taskType,
      taskId,
      emit: event => recordTask({ taskType, taskId, ...identity }, event),
    }, fn);
  };

  return Object.freeze({
    available: true,
    store,
    record,
    recordScoped,
    recordTask,
    recordModel,
    enter,
    enterTask,
    flush: () => store.flush(),
    deleteSession: sessionId => store.deleteSession(sessionId),
    status: () => store.status(),
  });
}

export default createSessionTrace;
