// contextUsage.test.js — 每轮上下文构成统计（add-context-usage-observation）。
//
// Run: node --test server/virtual-person/contextUsage.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { estimateTokens, measureContextUsage, splitPromptSections } from './contextUsage.js';

const system = [
  '你是 Lunara。',
  '## 跨聊天保留的关系记忆\n- [memoryId=3, user_explicit_feedback, savedAt=2026年11月1日] 用户对芒果过敏，吃了会起疹子\n- [memoryId=4, user_explicit_feedback] 用户养了一只橘猫',
  '## 相关长期记忆\n- [user_explicit_feedback, memoryId=3, confidence=0.7] 用户对芒果过敏，吃了会起疹子',
  '## 当前真实状态\n正在播放：无',
].join('\n\n');

test('估算 token：中日韩字符与其他字节分别折算', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.ok(estimateTokens('用户对芒果过敏') > estimateTokens('mango'));
});

test('系统提示按小节拆分，开头无标题的部分单独计', () => {
  const sections = splitPromptSections(system);
  assert.deepEqual(sections.map(item => item.title), ['(开头)', '跨聊天保留的关系记忆', '相关长期记忆', '当前真实状态']);
  assert.equal(sections.reduce((sum, item) => sum + item.bytes, 0) <= Buffer.byteLength(system), true);
});

test('合计系统提示、历史、工具定义与输出预留', () => {
  const tools = [{ type: 'function', function: { name: 'play', description: '播放', parameters: { type: 'object' } } }];
  const usage = measureContextUsage({
    messages: [{ role: 'system', content: system }, { role: 'user', content: '今晚适合听什么？' }, { role: 'assistant', content: 'ok' }],
    tools, outputReserveTokens: 2048,
  });
  assert.equal(usage.method, 'heuristic-v1');
  assert.equal(usage.history.messages, 2);
  assert.equal(usage.tools.count, 1);
  assert.ok(usage.tools.tokens > 0);
  assert.equal(usage.outputReserveTokens, 2048);
  assert.equal(usage.totalTokens, usage.system.tokens + usage.history.tokens + usage.tools.tokens + 2048);
  assert.ok(usage.sections.find(item => item.title === '跨聊天保留的关系记忆').tokens > 0);
});

test('跨小节重复的行只报数量、字节和小节标题，不带内容', () => {
  const usage = measureContextUsage({ messages: [{ role: 'system', content: system }] });
  assert.equal(usage.repeated.lines, 1);
  assert.equal(usage.repeated.bytes, Buffer.byteLength('用户对芒果过敏，吃了会起疹子'));
  assert.deepEqual(usage.repeated.sections, ['跨聊天保留的关系记忆', '相关长期记忆']);
  assert.equal(usage.repeated.memoryIds, 1, 'memoryId=3 在两个小节都出现');
  assert.ok(!JSON.stringify(usage).includes('芒果'), '事件里不带记忆内容');
});

test('整理目录引用的来源 id 不算重复注入', () => {
  const content = ['## 跨聊天保留的关系记忆', '- [memoryId=3, person:lunara:user_explicit_feedback] 用户对芒果过敏',
    '## 关系记忆目录', '- [饮食｜来源 memoryId=3,8,9] 饮食上有几条忌口', '## 相关长期记忆', '- [manual_seed, memoryId=9] 用户在找工作'].join('\n');
  const usage = measureContextUsage({ messages: [{ role: 'system', content }] });
  assert.equal(usage.repeated.memoryIds, 0);
});

test('没有系统消息、内容不是字符串时也不抛错', () => {
  const usage = measureContextUsage({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }, null] });
  assert.equal(usage.system.tokens, 0);
  assert.ok(usage.history.tokens > 0);
});

test('AgentLoop 每次调用模型前回调；回调抛错不影响请求与回合', async () => {
  const { AgentLoop } = await import('./AgentLoop.js');
  const registry = { definitions: () => [], execute: () => { throw new Error('unexpected tool call'); } };
  const sent = [];
  const seen = [];
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async messages => { sent.push(messages); return { message: { role: 'assistant', content: '好的。' } }; } });
  const result = await loop.run({ systemPrompt: '## 平台原则\n友好', messages: [{ role: 'user', content: '你好' }],
    onContextUsage: usage => { seen.push(usage); throw new Error('observer broke'); } });
  assert.equal(result.finalText, '好的。');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].round, 1);
  assert.equal(seen[0].recovery, false);
  assert.equal(seen[0].taskId, 'chat_dialogue');
  assert.deepEqual(seen[0].messages, sent[0], '观测看到的就是实际发送的消息');
});

test('本轮背景块里的小节与系统提示的小节一起计量，字节只算在历史里', async () => {
  const { attachTurnContext } = await import('./contextBlocks.js');
  const messages = [{ role: 'system', content: '## 跨聊天保留的关系记忆\n- 用户喜欢慢歌' },
    ...attachTurnContext([{ role: 'user', content: '现在几点' }], '## 相关长期记忆\n- 用户在找工作\n\n## 当前真实状态\n本地时间 21:00')];
  const usage = measureContextUsage({ messages });
  assert.deepEqual(usage.sections.map(item => item.title), ['跨聊天保留的关系记忆', '相关长期记忆', '当前真实状态']);
  assert.ok(usage.turnContext.bytes > 0 && usage.turnContext.bytes < usage.history.bytes);
  assert.equal(usage.totalTokens, usage.system.tokens + usage.history.tokens);
});
