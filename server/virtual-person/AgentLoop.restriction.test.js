// AgentLoop.restriction.test.js — 受限任务入口：工具白名单、回合取消信号与失败分类。
//
// 对应 add-session-jsonl-trace 任务 2：
//   - run({ toolNames }) 只把白名单内工具交给模型；清单外调用绝不执行，只得到 TOOL_NOT_AVAILABLE
//   - 内部 AbortController 把外层取消与回合截止统一传导给 chat() 与工具执行，超时仍是 AGENT_TIMEOUT
//   - 只有参数 JSON 解析失败才归类为 INVALID_TOOL_ARGUMENTS；执行异常保持原始分类
//
// Run: node --test server/virtual-person/AgentLoop.restriction.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

function toolCall(id, name, args = '{}') {
  return { id, type: 'function', function: { name, arguments: args } };
}

const TWO_TOOLS = [
  { type: 'function', function: { name: 'read_only_probe', description: '只读查询', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'commit_mutation', description: '提交变更', parameters: { type: 'object', properties: {} } } },
];

test('toolNames 白名单：清单外工具不执行，模型只拿到可纠正的 TOOL_NOT_AVAILABLE', async () => {
  const sentTools = [];
  const executed = [];
  const events = [];
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3,
    chat: async (_messages, tools) => {
      sentTools.push(tools);
      round += 1;
      return round === 1
        ? { message: { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'commit_mutation')] } }
        : { message: { role: 'assistant', content: '我用只读查询再试。' } };
    },
    toolRegistry: {
      definitions: () => structuredClone(TWO_TOOLS),
      execute: async name => { executed.push(name); return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }); },
    },
  });
  const result = await loop.run({
    systemPrompt: '受限任务',
    messages: [{ role: 'user', content: '提交变更' }],
    toolNames: ['read_only_probe'],
    onMessage: event => events.push(event),
  });

  assert.deepEqual(sentTools.map(tools => tools?.map(tool => tool.function.name) ?? null),
    [['read_only_probe'], ['read_only_probe']], '模型只能看到白名单内的工具');
  assert.deepEqual(executed, [], '白名单外工具绝不能被 handler 执行');
  assert.equal(result.outcomes.length, 1);
  const refused = result.outcomes[0];
  assert.equal(refused.code, 'TOOL_NOT_AVAILABLE');
  assert.equal(refused.kind, ToolOutcomeKind.BUSINESS_FAILURE);
  assert.equal(refused.ok, false);
  assert.equal(refused.presentation.speak, false);
  assert.match(refused.modelContext, /不在本任务可用范围/u, '模型上下文必须说明本任务不可用');
  assert.equal(result.finalText, '我用只读查询再试。', '限制不是终局：循环继续，模型可以纠正');
  const toolResult = events.find(event => event.kind === 'tool_result');
  assert.equal(toolResult.outcome.code, 'TOOL_NOT_AVAILABLE');
  assert.match(toolResult.message.content, /TOOL_NOT_AVAILABLE/);
});

test('toolNames 空数组：模型拿不到任何工具，点名调用同样只得到 TOOL_NOT_AVAILABLE', async () => {
  const sentTools = [];
  let executed = 0;
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3,
    chat: async (_messages, tools) => {
      sentTools.push(tools);
      round += 1;
      return round === 1
        ? { message: { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'read_only_probe')] } }
        : { message: { role: 'assistant', content: '那我直接回答。' } };
    },
    toolRegistry: {
      definitions: () => structuredClone(TWO_TOOLS),
      execute: async () => { executed += 1; return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }); },
    },
  });
  const result = await loop.run({ messages: [{ role: 'user', content: '查询' }], toolNames: [] });
  assert.deepEqual(sentTools, [null, null], '空名单不向模型暴露任何工具');
  assert.equal(executed, 0);
  assert.equal(result.outcomes[0].code, 'TOOL_NOT_AVAILABLE');
  assert.equal(result.finalText, '那我直接回答。');
});

test('toolNames 为 null 时不限制工具（既有行为保持）', async () => {
  const sentTools = [];
  let executed = 0;
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3,
    chat: async (_messages, tools) => {
      sentTools.push(tools);
      round += 1;
      return round === 1
        ? { message: { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'commit_mutation')] } }
        : { message: { role: 'assistant', content: '已提交。' } };
    },
    toolRegistry: {
      definitions: () => structuredClone(TWO_TOOLS),
      execute: async () => { executed += 1; return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'COMMITTED' }); },
    },
  });
  const result = await loop.run({ messages: [{ role: 'user', content: '提交变更' }] });
  assert.deepEqual(sentTools[0].map(tool => tool.function.name), ['read_only_probe', 'commit_mutation']);
  assert.equal(executed, 1);
  assert.equal(result.outcomes[0].code, 'COMMITTED');
});

test('只有参数 JSON 解析失败才是 INVALID_TOOL_ARGUMENTS，循环继续', async () => {
  let executed = 0;
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3,
    chat: async () => {
      round += 1;
      return round === 1
        ? { message: { role: 'assistant', content: '', tool_calls: [toolCall('bad', 'read_only_probe', '{"query": ')] } }
        : { message: { role: 'assistant', content: '我改成自然回答。' } };
    },
    toolRegistry: {
      definitions: () => structuredClone(TWO_TOOLS),
      execute: async () => { executed += 1; return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }); },
    },
  });
  const result = await loop.run({ messages: [{ role: 'user', content: '查询' }] });
  assert.equal(executed, 0, '参数不合法时绝不执行 handler');
  assert.equal(result.outcomes[0].code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(result.outcomes[0].presentation.speak, false);
  assert.equal(round, 2);
  assert.equal(result.finalText, '我改成自然回答。');
});

test('工具执行抛出的异常不再伪装成参数错误，原样带 outcomes 上抛', async () => {
  const failure = Object.assign(new Error('音乐库暂时不可用'), { code: 'MUSIC_STORE_DOWN' });
  let executed = 0;
  let chatCalls = 0;
  const loop = new AgentLoop({ maxRounds: 3,
    chat: async () => {
      chatCalls += 1;
      return { message: { role: 'assistant', content: '', tool_calls: [toolCall(`c${chatCalls}`, 'read_only_probe')] } };
    },
    toolRegistry: {
      definitions: () => structuredClone(TWO_TOOLS),
      execute: async () => { executed += 1; throw failure; },
    },
  });
  await assert.rejects(loop.run({ messages: [{ role: 'user', content: '查询' }] }),
    error => error === failure && error.code === 'MUSIC_STORE_DOWN');
  assert.equal(executed, 1);
  assert.equal(chatCalls, 1, '执行失败不再被当作参数错误继续下一轮模型调用');
  assert.deepEqual(failure.agentOutcomes, [], '异常带着本回合已收集的 outcomes 上抛');
});

test('回合超时：同一信号传进 chat() 与工具并真正中止，错误码保持 AGENT_TIMEOUT', async () => {
  let chatSignal = null;
  let toolSignal = null;
  let markAborted;
  const abortSeen = new Promise(resolve => { markAborted = resolve; });
  const loop = new AgentLoop({ timeoutMs: 120,
    chat: async (_messages, _tools, options) => {
      chatSignal = options.signal;
      return { message: { role: 'assistant', content: '', tool_calls: [toolCall('slow', 'read_only_probe')] } };
    },
    toolRegistry: {
      definitions: () => structuredClone(TWO_TOOLS),
      execute: async (_name, _args, context) => {
        toolSignal = context.signal;
        return new Promise((_, reject) => {
          context.signal.addEventListener('abort', () => {
            markAborted();
            reject(context.signal.reason ?? new Error('aborted'));
          }, { once: true });
        });
      },
    },
  });
  await assert.rejects(loop.run({ messages: [{ role: 'user', content: '跑个长任务' }] }),
    error => error?.code === 'AGENT_TIMEOUT' && /timed out/u.test(error.message));
  await abortSeen;
  assert.ok(chatSignal instanceof AbortSignal);
  assert.equal(chatSignal, toolSignal, 'chat 与工具执行共享同一个回合信号');
  assert.equal(toolSignal.aborted, true, '超时必须真正中止工具内的工作');
  assert.equal(toolSignal.reason?.code, 'AGENT_TIMEOUT');
  assert.ok(Array.isArray(toolSignal.reason?.agentOutcomes), '超时错误带本回合 outcomes');
});

test('外层取消：取消原因原样传播，工具信号同步中止；预取消则不再发起模型调用', async () => {
  const cancelled = Object.assign(new Error('用户取消了这轮'), { name: 'AbortError', code: 'TURN_CANCELLED' });
  const controller = new AbortController();
  let toolSignal = null;
  let chatCalls = 0;
  const loop = new AgentLoop({ timeoutMs: 5_000,
    chat: async () => {
      chatCalls += 1;
      return { message: { role: 'assistant', content: '', tool_calls: [toolCall('slow', 'read_only_probe')] } };
    },
    toolRegistry: {
      definitions: () => structuredClone(TWO_TOOLS),
      execute: async (_name, _args, context) => {
        toolSignal = context.signal;
        setTimeout(() => controller.abort(cancelled), 5);
        return new Promise(() => {});
      },
    },
  });
  await assert.rejects(() => loop.run({ messages: [{ role: 'user', content: '跑长任务' }], signal: controller.signal }),
    error => error === cancelled, '取消原因必须是原对象，不被包装成超时或参数错误');
  assert.equal(toolSignal.aborted, true);
  assert.equal(toolSignal.reason, cancelled);
  assert.equal(chatCalls, 1);

  const preCancelled = Object.assign(new Error('请求已被替换'), { name: 'AbortError', code: 'TURN_SUPERSEDED' });
  const pre = new AbortController();
  pre.abort(preCancelled);
  let hungChats = 0;
  const loop2 = new AgentLoop({
    chat: async () => { hungChats += 1; return { message: { role: 'assistant', content: '不应发生' } }; },
    toolRegistry: { definitions: () => [], execute: async () => { throw new Error('不应执行'); } },
  });
  await assert.rejects(() => loop2.run({ messages: [{ role: 'user', content: '跑长任务' }], signal: pre.signal }),
    error => error === preCancelled);
  assert.equal(hungChats, 0, '预取消的信号在首个模型调用前就要中止回合');
});
