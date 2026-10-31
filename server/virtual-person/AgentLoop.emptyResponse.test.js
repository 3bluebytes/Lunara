import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';

const registry = { definitions: () => [], execute: () => { throw new Error('unexpected tool call'); } };

test('a truly empty response gets one bounded retry in the same turn', async () => {
  const options = [];
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async (_messages, _tools, profile) => {
      options.push(profile);
      return { message: { role: 'assistant', content: options.length === 1 ? '' : '我听到了。' } };
    } });
  const result = await loop.run({ messages: [{ role: 'user', content: '反馈' }] });
  assert.equal(result.finalText, '我听到了。');
  assert.equal(options.length, 2);
  assert.equal(options[0].thinkingMode, undefined);
  assert.equal(options[1].thinkingMode, undefined, '空回复重试不再强制关闭思考（失败分类与升级由传输层负责）');
});

test('two empty responses fail instead of spinning through rounds', async () => {
  let calls = 0;
  const loop = new AgentLoop({ toolRegistry: registry,
    chat: async () => { calls++; return { message: { role: 'assistant', content: '' } }; } });
  await assert.rejects(loop.run({ messages: [{ role: 'user', content: '反馈' }] }),
    error => error.code === 'EMPTY_ASSISTANT_RESPONSE');
  assert.equal(calls, 2);
});

test('empty-response retry keeps the same system + user request shape for restricted tasks', async () => {
  const sent = [];
  let calls = 0;
  const loop = new AgentLoop({
    toolRegistry: registry,
    chat: async messages => {
      sent.push(messages);
      calls += 1;
      return { message: { role: 'assistant', content: calls === 1 ? '' : '我听到了。' } };
    },
  });
  const result = await loop.run({ systemPrompt: '选一首合适的歌。', messages: [] });
  assert.equal(result.finalText, '我听到了。');
  assert.equal(sent.length, 2, '空回复重试仍然只调用两次');
  for (const messages of sent) {
    assert.deepEqual(messages.map(message => message.role), ['system', 'user']);
    assert.equal(messages[1].content, '按系统说明执行本轮任务。');
  }
});
