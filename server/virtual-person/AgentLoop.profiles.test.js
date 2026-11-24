// AgentLoop.profiles.test.js — 模型 profile 的「任务规格引用」与思考开关契约。
//
// 机械 JSON 任务（反思等）必须在思考模型上也稳：显式关思考（成本选择）+ 足够输出额度。
// 数字不再写在 profile 里：额度/超时/升级阶梯由任务预算规格唯一决定
// （server/llmTasks.js），截断与"只有思考"由传输层有界升级恢复（server/llm.js）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';

const registry = { definitions: () => [], execute: () => { throw new Error('unexpected tool call'); } };

test('reflection profile 引用任务规格并保留关思考的成本选择', async () => {
  const options = [];
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async (_messages, _tools, profile) => {
      options.push(profile);
      return { message: { role: 'assistant', content: '{"observation":""}' } };
    } });
  const result = await loop.run({ messages: [{ role: 'user', content: '反思' }], modelProfileId: 'reflection' });

  assert.equal(result.finalText, '{"observation":""}');
  assert.equal(options[0].taskId, 'reflection', '额度与升级阶梯由规格决定');
  assert.equal(options[0].thinkingMode, 'disabled', '机械 JSON 反思显式请求关思考（档案允许时才发送）');
  assert.equal(options[0].maxTokens, undefined, 'profile 不再自带魔法数字');
  assert.equal(options[0].temperature, 0.2);
});

test('dialogue profile 引用任务规格且不强制思考开关', async () => {
  const options = [];
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async (_messages, _tools, profile) => {
      options.push(profile);
      return { message: { role: 'assistant', content: '好。' } };
    } });
  await loop.run({ messages: [{ role: 'user', content: '你好' }] });

  assert.equal(options[0].taskId, 'chat_dialogue');
  assert.equal(options[0].thinkingMode, undefined, '对话不做强制思考开关');
  assert.equal(options[0].maxTokens, undefined, '额度由 chat_dialogue 规格计算（正文 + 思考余量）');
});

test('空回复重试不再以「关闭思考」为默认动作', async () => {
  const options = [];
  let calls = 0;
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async (_messages, _tools, profile) => {
      options.push(profile);
      calls += 1;
      return calls === 1
        ? { message: { role: 'assistant', content: '' }, finishReason: 'stop' }
        : { message: { role: 'assistant', content: '补上了' }, finishReason: 'stop' };
    } });
  const result = await loop.run({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.finalText, '补上了');
  assert.equal(calls, 2);
  assert.equal(options[1].thinkingMode, undefined, '空回复重试保留思考（失败分类与升级由传输层负责）');
});

test('ambient profile 引用 ambient_turn 规格，并要求观测不记录正文', async () => {
  const options = [];
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async (_messages, _tools, profile) => {
      options.push(profile);
      return { message: { role: 'assistant', content: '嗯。' } };
    } });
  await loop.run({ messages: [{ role: 'user', content: '［运行时提示，不是对方说的话］' }], modelProfileId: 'ambient' });
  assert.equal(options[0].taskId, 'ambient_turn');
  assert.equal(options[0].temperature, 0.9);
  assert.equal(options[0].traceContent, false, '运行时提示与她的草稿都不进 trace 正文');
});

test('相邻的 user 消息只在发给模型的请求里并成一条；run.messages 保持调用方给的形状，并标记 promptCache', async () => {
  const seen = [];
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async (messages, _tools, profile) => {
      seen.push({ messages: structuredClone(messages), profile });
      return { message: { role: 'assistant', content: '好。' } };
    } });
  const history = [
    { role: 'user', content: '[较早对话摘要]' },
    { role: 'user', content: '上一句' },
    { role: 'assistant', content: '回上一句' },
    { role: 'user', content: '[本轮背景]' },
    { role: 'user', content: '运行时提示' },
  ];
  const result = await loop.run({ systemPrompt: '系统', messages: history });
  assert.deepEqual(seen[0].messages.map(message => [message.role, message.content]), [
    ['system', '系统'],
    ['user', '[较早对话摘要]\n\n上一句'],
    ['assistant', '回上一句'],
    ['user', '[本轮背景]\n\n运行时提示'],
  ]);
  assert.equal(seen[0].profile.promptCache, true);
  assert.deepEqual(result.messages.slice(0, 5), history, '历史不被改写');
});

function toolLoopRegistry(executed) {
  return {
    definitions: () => [{ type: 'function', function: { name: 'remember', parameters: { type: 'object', properties: {} } } }],
    isReadOnly: () => false,
    execute: async (name, args) => {
      executed.push(args);
      return { ok: true, kind: 'success', code: 'REMEMBERED', facts: {}, modelContext: '记住了', presentation: { displayText: '' } };
    },
  };
}
const callRemember = n => ({ role: 'assistant', content: '',
  tool_calls: [{ id: `c${n}`, type: 'function', function: { name: 'remember', arguments: JSON.stringify({ n }) } }] });

test('工具轮用完时对话任务再调一次、禁用工具，由她按已发生的结果收尾', async () => {
  const executed = [];
  const calls = [];
  const loop = new AgentLoop({ toolRegistry: toolLoopRegistry(executed), maxRounds: 3,
    chat: async (messages, tools, profile) => {
      calls.push({ messages, tools, profile });
      return profile.toolChoice === 'none'
        ? { message: { role: 'assistant', content: '这几件事我都记下了，剩下的没来得及。', tool_calls: [callRemember(99).tool_calls[0]] } }
        : { message: callRemember(calls.length) };
    } });
  const result = await loop.run({ messages: [{ role: 'user', content: '记一下这些' }] });
  assert.equal(result.finalText, '这几件事我都记下了，剩下的没来得及。');
  assert.equal(result.roundLimitReached, true);
  assert.equal(executed.length, 3, '收尾调用里的工具调用不执行');
  assert.equal(calls.length, 4);
  assert.equal(calls[3].profile.toolChoice, 'none');
  assert.ok(calls[3].tools?.length, '工具定义保留，只是不许调用');
  assert.equal(calls[3].messages.at(-1).role, 'tool');
});

test('收尾调用没有文字时仍按 AGENT_ROUND_LIMIT 失败；受限任务不追加收尾调用', async () => {
  const run = (profile, wrapText) => {
    const calls = [];
    const loop = new AgentLoop({ toolRegistry: toolLoopRegistry([]), maxRounds: 2,
      chat: async (_messages, _tools, options) => {
        calls.push(options);
        return options.toolChoice === 'none' ? { message: { role: 'assistant', content: wrapText } } : { message: callRemember(calls.length) };
      } });
    return loop.run({ messages: [{ role: 'user', content: '记一下' }], modelProfileId: profile })
      .then(() => ({ calls }), error => ({ calls, error }));
  };
  const empty = await run('dialogue', '');
  assert.equal(empty.error?.code, 'AGENT_ROUND_LIMIT');
  assert.equal(empty.error.agentOutcomes.length, 2);
  const restricted = await run('music_selection', '不该出现');
  assert.equal(restricted.error?.code, 'AGENT_ROUND_LIMIT');
  assert.equal(restricted.calls.length, 2);
});

test('思考回传状态只在这次 run 的工具循环里带回，不交给 onMessage，也不留在返回的消息里', async () => {
  const replay = { api: 'anthropic-messages', blocks: [{ type: 'thinking', thinking: '想', signature: 'sig' }] };
  const requests = [];
  const seen = [];
  const loop = new AgentLoop({ toolRegistry: toolLoopRegistry([]),
    chat: async messages => {
      requests.push(structuredClone(messages));
      return requests.length === 1 ? { message: { ...callRemember(1), providerReplay: replay } }
        : { message: { role: 'assistant', content: '记住了。', providerReplay: replay } };
    } });
  const result = await loop.run({ messages: [{ role: 'user', content: '记一下' }], onMessage: event => { seen.push(structuredClone(event)); } });
  assert.deepEqual(requests[1].find(message => message.role === 'assistant').providerReplay, replay);
  assert.ok(seen.length && seen.every(event => !event.message || !('providerReplay' in event.message)));
  assert.ok(result.messages.every(message => !('providerReplay' in message)));
});
