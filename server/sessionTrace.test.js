// sessionTrace.test.js — 会话记录门面：身份合并、llm 事件投影、ALS 接线与无 store 降级。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionTrace } from './sessionTrace.js';
import { trace, traceSection } from './trace.js';

function collector() {
  const rows = [];
  const taskRows = [];
  return {
    rows,
    taskRows,
    store: {
      record: (context, event) => rows.push({ context, event }),
      recordTask: (context, event) => taskRows.push({ context, event }),
      flush: async () => {},
      deleteSession: async () => {},
      status: () => ({}),
    },
  };
}

test('enter() routes trace()/traceSection() output into the same session record', () => {
  const { rows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.enter({ sessionId: 's1', requestId: 'r1', virtualPersonId: 'p1' }, () => {
    trace({ event: 'service-thing', detail: 1 });
    traceSection('阶段', '完成');
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].context.sessionId, 's1');
  assert.equal(rows[0].context.requestId, 'r1');
  assert.equal(rows[0].event.event, 'service-thing');
  assert.equal(rows[1].event.type, 'section');
});

test('record merges active trace identity while explicit context wins', () => {
  const { rows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.enter({ sessionId: 'session-a', requestId: 'outer' }, () => {
    sessionTrace.record({ requestId: 'inner', virtualPersonId: 'p2' }, { type: 'step' });
  });
  assert.equal(rows[0].context.sessionId, 'session-a', '会话身份来自活动上下文');
  assert.equal(rows[0].context.requestId, 'inner', '显式身份优先');
  assert.equal(rows[0].context.virtualPersonId, 'p2');
});

test('recordModel projects llm observer events by phase', () => {
  const { rows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.recordModel({ phase: 'start', sessionId: 's1', model: 'm', api: 'openai-completions',
    source: 'session', taskId: 'song_tag', maxTokens: 1200, temperature: 0.6,
    budget: { requested: 1500, effective: 2524, allowance: 1024 }, body: { messages: [] } });
  sessionTrace.recordModel({ phase: 'attempt', sessionId: 's1', model: 'm', api: 'openai-completions',
    taskId: 'song_tag', attempt: 1, escalatedFrom: null, outcome: 'truncated', truncated: true,
    finishReason: 'length', usage: { completion_tokens: 900 }, reasoningTokens: 850,
    budget: { requested: 1500, effective: 2524, allowance: 1024 }, durationMs: 700,
    structuredMeans: 'text_extraction' });
  sessionTrace.recordModel({ phase: 'end', sessionId: 's1', model: 'm', finishReason: 'stop',
    outcome: 'ok', attempt: 2, escalatedFrom: 2524, usage: { completion_tokens: 120 },
    reasoning: '思考', reasoningTokens: 850, text: '', durationMs: 1200 });
  sessionTrace.recordModel({ phase: 'error', sessionId: 's1', model: 'm', errorCode: 'LLM_API_ERROR', status: 503,
    providerDetail: 'messages must not end with assistant' });
  assert.deepEqual(rows.map(row => row.event.type),
    ['model_request', 'model_attempt', 'model_response', 'model_error']);
  const attempt = rows[1].event;
  assert.equal(attempt.taskId, 'song_tag');
  assert.equal(attempt.outcome, 'truncated');
  assert.equal(attempt.truncated, true);
  assert.deepEqual(attempt.budget, { requested: 1500, effective: 2524, allowance: 1024 });
  assert.equal(attempt.structuredMeans, 'text_extraction');
  assert.equal(rows[0].event.taskId, 'song_tag');
  assert.equal(rows[2].event.reasoningTokens, 850);
  assert.equal(rows[2].event.finishReason, 'stop');
  assert.equal(rows[2].event.outcome, 'ok');
  assert.equal(rows[3].event.errorCode, 'LLM_API_ERROR');
  assert.equal(rows[3].event.providerDetail, 'messages must not end with assistant');
  // 记录不泄露凭据/URL：attempt 事件只带数值与分类。
  const serialized = JSON.stringify(rows[1].event);
  assert.doesNotMatch(serialized, /Authorization|apiKey|Bearer|https?:\/\//u);
});

test('events without a session identity are not recorded', () => {
  const { rows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.recordModel({ phase: 'start', model: 'm' });
  sessionTrace.record({}, { type: 'stray' });
  sessionTrace.recordScoped('', { type: 'stray' });
  assert.equal(rows.length, 0, '没有会话身份时不伪造记录');
});

test('recordModel: explicit null/empty sessionId means unowned and never falls back to the ALS context', () => {
  const { rows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.enter({ sessionId: 'chat-1', requestId: 'r1' }, () => {
    // 后台打标/回填的形态：显式 null（或空串）= 生产者声明无归属。
    sessionTrace.recordModel({ phase: 'start', sessionId: null, model: 'deepseek-flash' });
    sessionTrace.recordModel({ phase: 'end', sessionId: null, model: 'deepseek-flash', finishReason: 'length' });
    sessionTrace.recordModel({ phase: 'start', sessionId: '', model: 'deepseek-flash' });
    // 缺省（undefined）才回退到当前回合身份。
    sessionTrace.recordModel({ phase: 'start', model: 'deepseek-flash' });
  });
  assert.deepEqual(rows.map(row => row.event.type), ['model_request']);
  assert.equal(rows[0].context.sessionId, 'chat-1', '只有缺省身份的前台调用落在聊天记录里');
});

test('recordModel: explicit null outside any context stays unowned (no phantom session file)', () => {
  const { rows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.recordModel({ phase: 'start', sessionId: null, model: 'm' });
  sessionTrace.recordModel({ phase: 'start', sessionId: '', model: 'm' });
  assert.equal(rows.length, 0);
});

test('a missing store degrades to safe no-ops', async () => {
  const sessionTrace = createSessionTrace({ store: null });
  assert.equal(sessionTrace.available, false);
  assert.doesNotThrow(() => sessionTrace.record({ sessionId: 's' }, { type: 'x' }));
  assert.doesNotThrow(() => sessionTrace.recordModel({ phase: 'start', sessionId: 's' }));
  assert.equal(sessionTrace.enter({ sessionId: 's' }, () => 42), 42);
  await sessionTrace.flush();
  assert.deepEqual(sessionTrace.status(), { pendingBytes: 0, droppedEvents: 0, writeFailures: 0 });
});

test('a throwing store never breaks business calls', () => {
  const store = { record() { throw new Error('disk gone'); }, flush: async () => {}, deleteSession: async () => {}, status: () => ({}) };
  const sessionTrace = createSessionTrace({ store });
  assert.doesNotThrow(() => sessionTrace.record({ sessionId: 's' }, { type: 'x' }));
  assert.doesNotThrow(() => sessionTrace.enter({ sessionId: 's' }, () => trace({ event: 'inside' })));
});

test('enterTask routes trace() and recordTask() into task records', () => {
  const { rows, taskRows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.enterTask({ taskType: 'capability_probe', taskId: 'prog-1', targetDate: '2026-10-15' }, () => {
    trace({ event: 'segment_gathered', index: 0 });
    sessionTrace.recordTask({}, { type: 'draft_submitted' });
  });
  assert.equal(rows.length, 0, '不往聊天记录写任何事件');
  assert.equal(taskRows.length, 2);
  assert.equal(taskRows[0].context.taskType, 'capability_probe');
  assert.equal(taskRows[0].context.taskId, 'prog-1');
  assert.equal(taskRows[0].event.event, 'segment_gathered');
  assert.equal(taskRows[1].event.type, 'draft_submitted');
});

test('recordModel within enterTask routes model calls to task store when sessionId is unset', () => {
  const { rows, taskRows, store } = collector();
  const sessionTrace = createSessionTrace({ store });
  sessionTrace.enterTask({ taskType: 'capability_probe', taskId: 'prog-1' }, () => {
    sessionTrace.recordModel({ phase: 'start', model: 'deepseek-chat', taskId: 'capability_probe' });
    sessionTrace.recordModel({ phase: 'end', model: 'deepseek-chat', text: '探测回复', finishReason: 'stop' });
  });
  assert.equal(rows.length, 0);
  assert.equal(taskRows.length, 2);
  assert.equal(taskRows[0].context.taskType, 'capability_probe');
  assert.equal(taskRows[0].context.taskId, 'prog-1');
  assert.equal(taskRows[0].event.type, 'model_request');
  assert.equal(taskRows[1].event.type, 'model_response');
  assert.equal(taskRows[1].event.text, '探测回复');
});
