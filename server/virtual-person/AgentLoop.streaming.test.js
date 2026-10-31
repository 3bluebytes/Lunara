import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from './AgentLoop.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

const messages = [{ role: 'user', content: '你好' }];
const tool = { id: 't', type: 'function', function: { name: 'write', arguments: '{}' } };
function fixture(chat) {
  const registry = new VirtualPersonToolRegistry();
  let writes = 0;
  registry.register('write', { definition: { description: 'write' }, handler: async () => {
    writes += 1;
    return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'WRITTEN', facts: {} });
  } });
  return { loop: new AgentLoop({ chat, toolRegistry: registry }), writes: () => writes };
}

test('streaming keeps the tool loadout available to the model', async () => {
  const { loop } = fixture(async (_messages, definitions) => {
    assert.equal(definitions.length, 1);
    assert.equal(definitions[0].function.name, 'write');
    return { message: { content: '你好' }, finishReason: 'stop' };
  });
  const result = await loop.run({ messages, stream: true, streamRequired: true });
  assert.equal(result.finalText, '你好');
});

test('a tool call during streaming executes and a later round can answer', async () => {
  let round = 0;
  const { loop, writes } = fixture(async () => {
    round += 1;
    return round === 1
      ? { message: { content: '', tool_calls: [tool] }, finishReason: 'tool_calls' }
      : { message: { content: '已经安排' }, finishReason: 'stop' };
  });
  const result = await loop.run({ messages, stream: true, streamRequired: true });
  assert.equal(writes(), 1);
  assert.equal(result.finalText, '已经安排');
});

test('draft callbacks use the same cancellation and membership guard as the turn', async () => {
  const deltas = [];
  let send;
  let current = true;
  const { loop } = fixture(async (_messages, _tools, options) => {
    send = options.onTextDelta;
    options.onStreamReset?.({ attempt: 1 });
    send({ text: '你好', attempt: 1 });
    current = false;
    send({ text: '迟到', attempt: 1 });
    return { message: { content: '你好' }, finishReason: 'stop' };
  });
  await loop.run({ messages, stream: true, streamRequired: true,
    toolContext: { isCurrent: () => current }, onTextDelta: e => deltas.push(e.text) });
  assert.deepEqual(deltas, ['你好']);
  send({ text: '晚到', attempt: 1 });
  assert.deepEqual(deltas, ['你好']);
});

test('ordinary turns without a stream still buffer deltas', async () => {
  const { loop } = fixture(async (_messages, _tools, options) => {
    assert.equal(options.onTextDelta, undefined);
    return { message: { content: '完整文本' } };
  });
  const result = await loop.run({ messages, onTextDelta: () => assert.fail('must be buffered') });
  assert.equal(result.finalText, '完整文本');
});
