// AgentLoop.plainTextCorrection.test.js — 纯文本的一次可纠正（add-companion-heartbeat 12.1）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

const CORRECTION = '［运行时提示，不是对方说的话］请用 presence_respond 提交。';
const respondCall = { role: 'assistant', content: '', tool_calls: [{ id: 'call_r', type: 'function',
  function: { name: 'presence_respond', arguments: '{"action":"quiet"}' } }] };
const registry = {
  definitions: () => [{ type: 'function', function: { name: 'presence_respond', parameters: { type: 'object' } } }],
  execute: () => createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'AMBIENT_QUIET', terminal: true,
    facts: { action: 'quiet' }, presentation: { displayText: '' } }),
};
const scripted = replies => {
  const sent = [];
  return { sent, chat: async messages => { sent.push(structuredClone(messages)); return { message: replies.shift() }; } };
};

test('纯文本且有剩余轮次：追加一次纠正，下一轮看到自己的那句和纠正', async () => {
  const model = scripted([{ role: 'assistant', content: '这首挺好。' }, respondCall]);
  const events = [];
  const loop = new AgentLoop({ toolRegistry: registry, chat: model.chat });
  const result = await loop.run({ messages: [{ role: 'user', content: '提示' }], profileOverrides: {
    maxRounds: 3, plainTextCorrection: CORRECTION, allowEmptyTerminalPresentation: true },
    onMessage: event => events.push(event.kind === 'plain_text_correction' ? { kind: event.kind, text: event.text, round: event.round } : event.kind) });
  assert.equal(model.sent.length, 2);
  assert.deepEqual(model.sent[1].slice(-2), [{ role: 'assistant', content: '这首挺好。' }, { role: 'user', content: CORRECTION }]);
  assert.equal(result.outcomes.at(-1).code, 'AMBIENT_QUIET');
  assert.deepEqual(events[0], { kind: 'plain_text_correction', text: '这首挺好。', round: 1 });
});

test('只纠正一次：纠正后仍是纯文本就照旧返回', async () => {
  const model = scripted([{ role: 'assistant', content: '第一句。' }, { role: 'assistant', content: '第二句。' }]);
  const loop = new AgentLoop({ toolRegistry: registry, chat: model.chat });
  const result = await loop.run({ messages: [{ role: 'user', content: '提示' }],
    profileOverrides: { maxRounds: 3, plainTextCorrection: CORRECTION } });
  assert.equal(model.sent.length, 2);
  assert.equal(result.finalText, '第二句。');
});

test('没有剩余轮次时不纠正，照旧返回纯文本', async () => {
  const model = scripted([{ role: 'assistant', content: '只有一轮。' }]);
  const loop = new AgentLoop({ toolRegistry: registry, chat: model.chat });
  const result = await loop.run({ messages: [{ role: 'user', content: '提示' }],
    profileOverrides: { maxRounds: 1, plainTextCorrection: CORRECTION } });
  assert.equal(model.sent.length, 1);
  assert.equal(result.finalText, '只有一轮。');
});

test('未设置 plainTextCorrection 的档案行为不变', async () => {
  const model = scripted([{ role: 'assistant', content: '普通回答。' }]);
  const loop = new AgentLoop({ toolRegistry: registry, chat: model.chat });
  const result = await loop.run({ messages: [{ role: 'user', content: '你好' }] });
  assert.equal(model.sent.length, 1);
  assert.equal(result.finalText, '普通回答。');
});
