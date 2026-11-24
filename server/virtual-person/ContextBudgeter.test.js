import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextBudgeter, groupsFrom } from './ContextBudgeter.js';
import { isSummaryMessage, summaryBody, summaryMessage } from './contextBlocks.js';

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

const dialogue = count => Array.from({ length: count }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user', content: `${index % 2 ? '答' : '问'} ${Math.floor(index / 2) + 1}` }));

test('history under the limits is returned unchanged, so the request prefix stays byte-stable', async () => {
  const budgeter = new ContextBudgeter({ maxMessages: 8, maxBytes: 3000 });
  const earlier = await budgeter.prepare(dialogue(5));
  const later = await budgeter.prepare(dialogue(7));
  assert.deepEqual(earlier, dialogue(5));
  assert.deepEqual(later.slice(0, 5), earlier, '只追加：上一轮的请求是下一轮的前缀');
});

test('over the limit, the budgeter keeps one contiguous tail and hands the dropped head to onSummary', async () => {
  let audit = null;
  const input = dialogue(11);
  const output = await new ContextBudgeter({ maxMessages: 8, maxBytes: 3000 }).prepare(input, {
    onSummary: info => { audit = info; return summaryMessage('user: 问 1'); },
  });
  assert.equal(isSummaryMessage(output[0]), true, '摘要是历史的第一条消息，不进系统提示');
  const kept = output.slice(1);
  assert.deepEqual(kept, input.slice(audit.keptFrom), '保留的是连续的结尾，中间没有空洞');
  assert.equal(kept[0].role, 'user');
  assert.ok(kept.length <= 4, `裁到低水位（留 ${kept.length} 条），之后很多轮不用再裁`);
  assert.deepEqual(audit.removedIndexes, input.slice(0, audit.keptFrom).map((_m, index) => index));
  assert.equal(audit.removedCount, audit.keptFrom);
});

test('an existing summary head stays pinned and is replaced, not duplicated, on the next compaction', async () => {
  const head = summaryMessage('user: 很早的事');
  const input = [head, ...dialogue(11)];
  const budgeter = new ContextBudgeter({ maxMessages: 8, maxBytes: 3000 });
  let audit = null;
  const replaced = await budgeter.prepare(input, { onSummary: info => { audit = info; return summaryMessage('新的摘要'); } });
  assert.equal(replaced.filter(isSummaryMessage).length, 1);
  assert.equal(summaryBody(replaced[0]), '新的摘要');
  assert.equal(audit.removedIndexes[0], 1, '下标按输入数组算，摘要头不算被裁掉的消息');
  const fallback = await budgeter.prepare(input);
  assert.equal(fallback.filter(isSummaryMessage).length, 1);
  assert.match(summaryBody(fallback[0]), /很早的事[\s\S]*问 4/, '没有回调时旧摘要与被裁掉的话并成一条');
});

test('the current turn is never dropped, however long its tool loop runs', async () => {
  const loop = Array.from({ length: 6 }, (_, index) => ([
    { role: 'assistant', content: '', tool_calls: [{ id: `c${index}`, type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `c${index}`, content: 'ok' },
  ])).flat();
  const output = await new ContextBudgeter({ maxMessages: 8, maxBytes: 3000 })
    .prepare([...dialogue(6), { role: 'user', content: '本轮的问题' }, ...loop]);
  assert.equal(output.some(message => message.content === '本轮的问题'), true);
  assert.deepEqual(output.slice(-12), loop);
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
