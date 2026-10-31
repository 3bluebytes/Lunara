import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseSpokenText, toPlainText, normalizePerformance, hasPerformance, MAX_INLINE_EVENTS, MAX_PAUSES,
} = await import('./markers.js');

test('解析白名单标记：语气词与停顿按顺序成段', () => {
  const parsed = parseSpokenText('{叹气}已经很晚了。{停顿:0.6}我们听首安静的。{轻笑}');
  assert.deepEqual(parsed.segments, [
    { type: 'event', event: 'sigh' },
    { type: 'text', text: '已经很晚了。' },
    { type: 'pause', seconds: 0.6 },
    { type: 'text', text: '我们听首安静的。' },
    { type: 'event', event: 'chuckle' },
  ]);
  assert.equal(parsed.eventCount, 2);
  assert.equal(parsed.pauseCount, 1);
  assert.deepEqual(parsed.invalid, []);
});

test('五个语气词都能识别，停顿接受全角冒号与秒单位', () => {
  const parsed = parseSpokenText('{笑}a{轻笑}b{叹气}c{换气}d{清嗓子}e{停顿：1.2秒}f{停顿:0.5s}g');
  assert.deepEqual(parsed.segments.filter(s => s.type === 'event').map(s => s.event),
    ['laugh', 'chuckle', 'sigh', 'breath', 'clear_throat']);
  assert.deepEqual(parsed.segments.filter(s => s.type === 'pause').map(s => s.seconds), [1.2, 0.5]);
});

test('非白名单花括号按原文保留，不算标记也不算未知标记', () => {
  const parsed = parseSpokenText('这首《{Love}》很好听，{ 1 + 1 }也是。');
  assert.equal(parsed.eventCount, 0);
  assert.deepEqual(parsed.invalid, []);
  assert.equal(toPlainText('这首《{Love}》很好听。'), '这首《{Love}》很好听。');
});

test('看起来像标记的中文花括号记为未知标记；停顿越界或格式错记为无效', () => {
  const parsed = parseSpokenText('{咳嗽}你好。{停顿:3}再见。{停顿}好。{停顿:0.1}嗯。');
  assert.deepEqual(parsed.invalid.map(item => item.reason), ['unknown_marker', 'pause_out_of_range', 'pause_malformed', 'pause_out_of_range']);
  assert.equal(parsed.pauseCount, 0, '无效停顿不计入可用停顿');
});

test('允许的原文（如歌名）里的中文花括号不算未知标记', () => {
  const parsed = parseSpokenText('来听{晴天}。', { literal: ['{晴天}'] });
  assert.deepEqual(parsed.invalid, []);
});

test('识别供应商原生语法，供提交校验拒绝', () => {
  const parsed = parseSpokenText('(sighs)好晚了<#0.5#>听歌吧[叹气]');
  assert.deepEqual(parsed.nativeSyntax.sort(), ['(sighs)', '<#0.5#>', '[叹气]'].sort());
});

test('toPlainText 剥离标记（含无效停顿）并规整空白', () => {
  assert.equal(toPlainText('{叹气} 已经很晚了。 {停顿:0.6} 我们听首安静的。{笑}'), '已经很晚了。我们听首安静的。');
  assert.equal(toPlainText('好 {笑} 啊'), '好 啊');
  assert.equal(toPlainText('{停顿:9}没事'), '没事');
  assert.equal(toPlainText('Hello {换气} world'), 'Hello world');
  assert.equal(toPlainText('没有标记的文本'), '没有标记的文本');
});

test('上限常量：每段最多 2 个语气词、3 个停顿', () => {
  assert.equal(MAX_INLINE_EVENTS, 2);
  assert.equal(MAX_PAUSES, 3);
});

test('normalizePerformance：未知枚举归 null，direction 截到 60 字，全空返回 null', () => {
  assert.deepEqual(normalizePerformance({ emotion: 'sad', pace: 'slow', intensity: 'soft', direction: '  像在耳边低声说话  ' }),
    { emotion: 'sad', pace: 'slow', intensity: 'soft', direction: '像在耳边低声说话' });
  assert.deepEqual(normalizePerformance({ emotion: 'whisper', pace: 'normal', extra: 1 }),
    { emotion: null, pace: 'normal', intensity: null, direction: null });
  assert.equal(normalizePerformance({ emotion: 'angry' }), null);
  assert.equal(normalizePerformance(null), null);
  assert.equal(normalizePerformance('sad'), null);
  assert.equal(normalizePerformance({ direction: '长'.repeat(80) }).direction.length, 60);
});

test('hasPerformance：有标记或有风格才算', () => {
  assert.equal(hasPerformance('纯文本', null), false);
  assert.equal(hasPerformance('{笑}好', null), true);
  assert.equal(hasPerformance('纯文本', { emotion: 'happy', pace: null, intensity: null, direction: null }), true);
  assert.equal(hasPerformance('纯文本', { emotion: null, pace: 'normal', intensity: 'normal', direction: null }), false);
});
