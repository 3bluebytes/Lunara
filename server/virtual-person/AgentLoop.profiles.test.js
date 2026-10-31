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
