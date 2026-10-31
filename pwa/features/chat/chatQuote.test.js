import assert from 'node:assert/strict';
import test from 'node:test';

import { applyQuoteToDraft, buildQuoteText, splitLeadingQuote, QUOTE_MAX_CHARS } from './chatQuote.js';

test('a partner message becomes a quoting line; a user message quotes as 我', () => {
  assert.equal(buildQuoteText({ role: 'assistant', speakerName: 'Lunara', text: '三小时过去了，天也黑透了。' }),
    '引用 Lunara：三小时过去了，天也黑透了。');
  assert.equal(buildQuoteText({ role: 'user', text: '我这两天有点累' }), '引用 我：我这两天有点累');
  // 说话人未知时给一个稳定名字，而不是空的“引用 ：”。
  assert.equal(buildQuoteText({ role: 'assistant', text: '嗯' }), '引用 Lunara：嗯');
});

test('segments and multi-line text are flattened, and long text is truncated', () => {
  assert.equal(buildQuoteText({ role: 'assistant', speakerName: '阿岚', segments: [{ content: '第一段' }, { content: '第二段' }] }),
    '引用 阿岚：第一段 第二段');
  assert.equal(buildQuoteText({ role: 'user', text: '  第一行\n\n第二行   ' }), '引用 我：第一行 第二行');
  const long = buildQuoteText({ role: 'assistant', speakerName: 'Lunara', text: '树'.repeat(400) });
  assert.equal(long, `引用 Lunara：${'树'.repeat(QUOTE_MAX_CHARS)}…`);
});

test('a card-only message quotes the song instead of nothing', () => {
  assert.equal(buildQuoteText({ role: 'assistant', speakerName: 'Lunara', tracks: [
    { title: '那个女孩', artist: '陶喆 / 卢广仲' }, { title: 'Special One', artist: 'AGA' }, { title: '多余' },
  ] }), '引用 Lunara：《那个女孩》— 陶喆 / 卢广仲、《Special One》— AGA');
  // 没有任何可引用内容的消息不给引用行，调用方据此不渲染按钮。
  assert.equal(buildQuoteText({ role: 'assistant', speakerName: 'Lunara', text: '   ', tracks: [] }), '');
});

test('leading quote lines are split from the body; later quote lines stay body', () => {
  assert.deepEqual(splitLeadingQuote('> 引用 Lunara：嗯\n> 第二行\n\n我是在想下一首'),
    { quote: ['引用 Lunara：嗯', '第二行'], body: '我是在想下一首' });
  assert.deepEqual(splitLeadingQuote('普通正文\n> 不是引用'), { quote: [], body: '普通正文\n> 不是引用' });
  assert.deepEqual(splitLeadingQuote('> 引用 Lunara：嗯'), { quote: ['引用 Lunara：嗯'], body: '' });
  assert.deepEqual(splitLeadingQuote(''), { quote: [], body: '' });
});

test('quote goes above the draft, and a second quote replaces the first instead of stacking', () => {
  assert.equal(applyQuoteToDraft('', '引用 Lunara：嗯'), '> 引用 Lunara：嗯\n\n');
  assert.equal(applyQuoteToDraft('我这两天有点累', '引用 Lunara：嗯'), '> 引用 Lunara：嗯\n\n我这两天有点累');
  assert.equal(applyQuoteToDraft('> 引用 Lunara：第一句\n\n我这两天有点累', '引用 我：第二句'),
    '> 引用 我：第二句\n\n我这两天有点累');
  // 重复引用同一条：草稿不动，插入符位置由调用方决定。
  assert.equal(applyQuoteToDraft('> 引用 Lunara：嗯\n\n', '引用 Lunara：嗯'), '> 引用 Lunara：嗯\n\n');
  // 没给引用就不碰草稿。
  assert.equal(applyQuoteToDraft('我这两天有点累', ''), '我这两天有点累');
});
