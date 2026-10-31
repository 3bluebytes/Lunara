// AgentLoop.arguments.test.js — 循环侧安全参数归一（change §2.1/§2.2）。
//
// 合同：归一发生在鉴权/校验/去重执行键/只读预启动之前；包装与平铺调用共享一个
// executionKey；归一失败是 typed INVALID_TOOL_ARGUMENTS 且无副作用，循环可纠正；
// 未知工具与没有 prepareArguments 的 registry 保持既有行为；terminal 之后的调用仍被跳过。
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

const SEARCH_DEFINITION = {
  type: 'function',
  function: {
    name: 'search_music', description: '搜索', readOnly: true,
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
};
const SELECT_DEFINITION = {
  type: 'function',
  function: { name: 'select_music', description: '选歌', parameters: { type: 'object', properties: {} } },
};
const COMMIT_DEFINITION = {
  type: 'function',
  function: { name: 'commit_mutation', description: '提交', parameters: { type: 'object', properties: {} } },
};

function stubRegistry({ prepareArguments, readOnly = ['search_music'], handler } = {}) {
  const events = [];
  const registry = {
    definitions: () => structuredClone([SEARCH_DEFINITION, SELECT_DEFINITION, COMMIT_DEFINITION]),
    isReadOnly: name => { events.push(`isReadOnly:${name}`); return readOnly.includes(name); },
    execute: async (name, args) => {
      events.push(`execute:${name}`);
      return handler(name, args);
    },
  };
  if (prepareArguments) {
    registry.prepareArguments = (name, args) => {
      events.push(`prepare:${name}`);
      return prepareArguments(name, args);
    };
  }
  return { registry, events };
}

// 与 registry.prepareArguments 同合同的极简实现：只解一层 params 包装。
function unwrapParams(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const keys = Object.keys(args);
  if (keys.length === 1 && keys[0] === 'params') {
    if (!args.params || typeof args.params !== 'object' || Array.isArray(args.params)) throw new Error('bad wrapper');
    return args.params;
  }
  if (keys.includes('params') && keys.length > 1) throw new Error('ambiguous wrapper');
  return args;
}

test('同一批包装调用与平铺调用共享 executionKey：handler 只执行一次', async () => {
  let executions = 0;
  const { registry } = stubRegistry({
    prepareArguments: unwrapParams,
    handler: () => {
      executions += 1;
      return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'SEARCH_OK', facts: { tracks: [{ title: 'x' }] } });
    },
  });
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3, toolRegistry: registry, chat: async () => {
    round += 1;
    return round === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [
        toolCall('c1', 'search_music', { params: { query: 'x' } }),
        toolCall('c2', 'search_music', { query: 'x' }),
      ] } }
      : { message: { role: 'assistant', content: '找到了。' } };
  } });
  const result = await loop.run({ systemPrompt: '测', messages: [{ role: 'user', content: '找歌' }] });
  assert.equal(executions, 1, '包装与平铺是同一次执行');
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0].code, 'SEARCH_OK');
  assert.equal(result.outcomes[1].code, 'SEARCH_OK', '第二个调用复用同一结果');
  assert.equal(result.finalText, '找到了。');
});

test('归一在只读预启动与执行前完成，handler 只拿到归一后的参数', async () => {
  const { registry, events } = stubRegistry({
    prepareArguments: unwrapParams,
    handler: async (_name, args) => {
      assert.deepEqual(args, { query: 'x' }, 'handler 收到的必须是归一后的参数');
      return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'SEARCH_OK', facts: { tracks: [] } });
    },
  });
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3, toolRegistry: registry, chat: async () => {
    round += 1;
    return round === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'search_music', { params: { query: 'x' } })] } }
      : { message: { role: 'assistant', content: '好。' } };
  } });
  await loop.run({ systemPrompt: '测', messages: [{ role: 'user', content: '找歌' }] });
  const preparedAt = events.findIndex(event => event === 'prepare:search_music');
  const executedAt = events.findIndex(event => event === 'execute:search_music');
  assert.ok(preparedAt >= 0, '循环必须先调用 prepareArguments');
  assert.ok(preparedAt < executedAt, '归一时机必须在执行之前');
});

test('归一失败 fail closed 为 INVALID_TOOL_ARGUMENTS，不执行 handler，循环继续可纠正', async () => {
  let executions = 0;
  const { registry } = stubRegistry({
    prepareArguments: unwrapParams,
    handler: () => { executions += 1; return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }); },
  });
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3, toolRegistry: registry, chat: async () => {
    round += 1;
    return round === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [
        toolCall('c1', 'search_music', { params: { query: 'x' }, query: 'x' }),
      ] } }
      : { message: { role: 'assistant', content: '我换个说法。' } };
  } });
  const result = await loop.run({ systemPrompt: '测', messages: [{ role: 'user', content: '找歌' }] });
  assert.equal(executions, 0, '归一失败不能有副作用');
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].code, 'INVALID_TOOL_ARGUMENTS');
  assert.equal(result.outcomes[0].kind, ToolOutcomeKind.BUSINESS_FAILURE);
  assert.equal(result.outcomes[0].presentation.speak, false);
  assert.equal(result.finalText, '我换个说法。', '失败不是终局，循环可以继续');
});

test('非法 JSON 仍是 INVALID_TOOL_ARGUMENTS，且不进入归一', async () => {
  const prepared = [];
  const { registry } = stubRegistry({
    prepareArguments: (name, args) => { prepared.push(name); return args; },
    handler: () => createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }),
  });
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3, toolRegistry: registry, chat: async () => {
    round += 1;
    return round === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'search_music', '{"query":')] } }
      : { message: { role: 'assistant', content: '抱歉。' } };
  } });
  const result = await loop.run({ systemPrompt: '测', messages: [{ role: 'user', content: '找歌' }] });
  assert.equal(result.outcomes[0].code, 'INVALID_TOOL_ARGUMENTS');
  assert.deepEqual(prepared, [], '解析失败不进入归一');
});

test('没有 prepareArguments 的 registry（测试替身/旧实现）保持原有执行路径', async () => {
  let executions = 0;
  const { registry } = stubRegistry({ handler: () => { executions += 1; return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }); } });
  let round = 0;
  const loop = new AgentLoop({ maxRounds: 3, toolRegistry: registry, chat: async () => {
    round += 1;
    return round === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [toolCall('c1', 'search_music', { query: 'x' })] } }
      : { message: { role: 'assistant', content: '好。' } };
  } });
  const result = await loop.run({ systemPrompt: '测', messages: [{ role: 'user', content: '找歌' }] });
  assert.equal(executions, 1);
  assert.equal(result.outcomes[0].code, 'OK');
});

test('terminal 之后的包装调用仍被跳过，不再归一也不再执行', async () => {
  let executions = 0;
  const prepared = [];
  const { registry } = stubRegistry({
    prepareArguments: (name, args) => { prepared.push(name); return unwrapParams(name, args); },
    handler: name => {
      executions += 1;
      return name === 'commit_mutation'
        ? createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'MUTATION_COMMITTED', terminal: true,
          presentation: { displayText: '已经安排好了。', speak: false } })
        : createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'SEARCH_OK' });
    },
  });
  const loop = new AgentLoop({ maxRounds: 3, toolRegistry: registry, chat: async () => ({
    message: { role: 'assistant', content: '已经安排好了。', tool_calls: [
      toolCall('c1', 'commit_mutation', {}),
      toolCall('c2', 'search_music', { params: { query: 'x' } }),
    ] },
  }) });
  const result = await loop.run({ systemPrompt: '测', messages: [{ role: 'user', content: '放歌' }] });
  assert.equal(executions, 1, 'terminal 之后不能再执行任何调用');
  assert.equal(result.outcomes[1].code, 'SKIPPED_AFTER_TERMINAL');
  assert.deepEqual(prepared, ['commit_mutation'], '被跳过的调用不进入归一');
  assert.equal(result.finalText, '已经安排好了。');
});
