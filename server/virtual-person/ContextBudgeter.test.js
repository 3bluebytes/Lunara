import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextBudgeter, groupsFrom } from './ContextBudgeter.js';

test('context budgeter never splits an assistant tool call from its result', async () => {
  const messages = [
    { role: 'user', content: 'older user ' + 'x'.repeat(1000) },
    {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call-old', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call-old', content: 'y'.repeat(5000) },
    { role: 'assistant', content: '旧答案' },
    { role: 'user', content: '现在的问题' },
  ];
  const output = await new ContextBudgeter({ maxBytes: 2200, maxMessages: 4, maxToolResultBytes: 300 }).prepare(messages);
  const ids = new Set(output.filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls || []).map(call => call.id));
  for (const message of output.filter(message => message.role === 'tool')) {
    assert.equal(ids.has(message.tool_call_id), true);
  }
  for (const group of groupsFrom(output)) {
    if (group[0].tool_calls?.length) assert.equal(group.some(message => message.role === 'tool'), true);
  }
  assert.equal(output.at(-1).content, '现在的问题');
});

test('context budgeter can summarize older dialogue while retaining recent turns', async () => {
  let audit = null;
  const output = await new ContextBudgeter({
    maxMessages: 4,
    maxBytes: 3000,
    summarize: async removed => `保留的旧目标；来自 ${removed.length} 条消息`,
  }).prepare([
    { role: 'user', content: '第一条' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二条' },
    { role: 'assistant', content: '第二答' },
    { role: 'user', content: '第三条' },
    { role: 'assistant', content: '第三答' },
  ], { onSummary: value => { audit = value; } });
  assert.equal(output[0].role, 'system');
  assert.match(output[0].content, /保留的旧目标/);
  assert.equal(output.at(-1).content, '第三答');
  assert.equal(audit.removedCount, 2);
  assert.deepEqual(audit.removedIndexes, [0, 1]);
  assert.match(audit.content, /来源 2 条/);
});

test('context budgeter preserves explicit commitments and unresolved referents', async () => {
  const messages = [
    { role: 'user', content: '下周提醒我继续这个话题', contextState: { commitment: true } },
    { role: 'assistant', content: '我记住这个约定。', contextState: { validReferent: true } },
    ...Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `填充 ${index} ${'x'.repeat(350)}` })),
    { role: 'user', content: '那件事你还记得吗？' },
  ];
  const output = await new ContextBudgeter({ maxMessages: 6, maxBytes: 5000 }).prepare(messages);
  assert.equal(output.some(message => message.content === '下周提醒我继续这个话题'), true);
  assert.equal(output.some(message => message.content === '我记住这个约定。'), true);
  assert.equal(output.at(-1).content, '那件事你还记得吗？');
});

test('context budgeter keeps the current turn tool results whole and compacts only earlier ones', async () => {
  const offer = JSON.stringify({ ok: true, facts: { candidates: 'c'.repeat(6000), offerId: 'offer-1' } });
  const messages = [
    { role: 'user', content: '之前的问题' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-old', type: 'function', function: { name: 'select_music', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-old', content: offer },
    { role: 'assistant', content: '旧答案' },
    { role: 'user', content: '推荐两首' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-now', type: 'function', function: { name: 'select_music', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-now', content: offer },
  ];
  const budgeter = new ContextBudgeter({ maxBytes: 48_000, maxToolResultBytes: 4000 });
  const output = await budgeter.prepare(messages);
  const tool = id => output.find(message => message.tool_call_id === id).content;
  assert.match(tool('call-old'), /^\[Earlier tool result compacted/);
  assert.equal(tool('call-now'), offer, '本回合 offer 原样保留，offerId 可解析');
  const recovered = await budgeter.prepare(messages, { aggressive: true });
  assert.match(recovered.find(message => message.tool_call_id === 'call-now').content, /compacted/, 'prompt 过长兜底仍压缩');
});
