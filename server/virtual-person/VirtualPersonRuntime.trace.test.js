// VirtualPersonRuntime.trace.test.js — 会话执行记录的运行时行为（不需要 SQLite 之外的外部依赖）。
//
// 验证：一次回合把用户输入、组装上下文、工具提案与结果、最终回复按同一执行身份写入记录；
// 工具内部通过 trace() 输出的事件也落到同一会话（AsyncLocalStorage 接线）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoop } from './AgentLoop.js';
import { ConversationStore } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';
import { runWithTrace, trace } from '../trace.js';

function harness(t, chat) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-vp-trace-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath });
  const conversationStore = new ConversationStore({ dbPath });
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const records = [];
  const sessionTrace = {
    record: (context, event) => records.push({ context, event }),
    enter: (context, fn) => runWithTrace({ traceId: context.requestId, emit: event => records.push({ context, event }), ...context }, fn),
  };
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date('2026-10-15T00:00:00.000Z') }),
    agentLoop: new AgentLoop({ chat, toolRegistry: tools }),
    presentationService: new PresentationService(),
    capabilityResolver: () => ['probe'],
    retrieveMemories: async () => [],
    getRuntimeState: () => null,
    sessionTrace,
    logger: { error() {}, warn() {} },
  }).initialize();
  t.after(() => { conversationStore.close(); registry.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, tools, records };
}

test('one turn records input, context, tool execution and the committed reply under one identity', async t => {
  const toolReply = createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'PROBE_OK', terminal: true,
    facts: { answer: 42 }, presentation: { displayText: '探测完成。', speak: false } });
  const h = harness(t, async () => {
    // 工具内部输出的事件必须落在同一执行上下文（AsyncLocalStorage）。
    trace({ event: 'probe-inside-tool' });
    return { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function',
      function: { name: 'probe_tool', arguments: '{}' } }] } };
  });
  h.tools.register('probe_tool', { capability: 'probe', definition: { description: '探测', parameters: { type: 'object', properties: {} } },
    handler: async () => toolReply });

  const response = await h.runtime.handleTurn({ sessionId: 'session-trace', requestId: 'request-trace',
    userText: '开始探测', speak: false });
  assert.equal(response.ok, true);

  const types = h.records.map(entry => entry.event.type);
  for (const expected of ['turn_input', 'round_started', 'response_started', 'context_assembled',
    'tool_proposed', 'tool_result', 'response_committed', 'round_completed']) {
    assert.ok(types.includes(expected), `缺少记录类型 ${expected}（实际：${types.join(',')}）`);
  }
  // 每次记录都带会话身份；工具事件同样归属该请求。
  assert.ok(h.records.every(entry => entry.context.sessionId === 'session-trace'));
  const inside = h.records.find(entry => entry.event.type === 'service_event' && entry.event.event === 'probe-inside-tool');
  assert.ok(inside, '工具内部的 trace() 事件必须落入同一会话记录');
  assert.equal(inside.context.requestId, 'request-trace');

  const assembled = h.records.find(entry => entry.event.type === 'context_assembled').event;
  assert.match(assembled.systemPrompt, /Lunara|伙伴/u, '系统提示正文随上下文一起记录');
  assert.ok(Array.isArray(assembled.messages) && assembled.messages.length >= 1);
  assert.ok(assembled.messages.every(message => typeof message.role === 'string' && Number.isInteger(message.chars)));

  const proposed = h.records.find(entry => entry.event.type === 'tool_proposed').event;
  assert.equal(proposed.calls[0].name, 'probe_tool');
  const result = h.records.find(entry => entry.event.type === 'tool_result').event;
  assert.equal(result.name, 'probe_tool', '工具名由调用 id 关联回提案');
  assert.equal(result.code, 'PROBE_OK');
  assert.equal(result.terminal, true);

  const committed = h.records.find(entry => entry.event.type === 'response_committed').event;
  assert.equal(committed.displayText, '探测完成。');
  const input = h.records.find(entry => entry.event.type === 'turn_input').event;
  assert.equal(input.userText, '开始探测');
});

test('a failed turn records the failure with its stable code and no assistant text', async t => {
  const h = harness(t, async () => { throw Object.assign(new Error('endpoint down'), { code: 'LLM_API_ERROR' }); });
  const response = await h.runtime.handleTurn({ sessionId: 'session-trace', requestId: 'request-fail',
    userText: '在吗', speak: false });
  assert.equal(response.ok, false);
  const failed = h.records.find(entry => entry.event.type === 'response_failed');
  assert.ok(failed, '失败回合必须留下记录');
  assert.equal(failed.event.failureCode, 'LLM_API_ERROR');
  assert.ok(failed.event.errorId);
  assert.equal(h.records.some(entry => entry.event.type === 'response_committed'), false);
});
