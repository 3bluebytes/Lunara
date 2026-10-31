// ambientLine.test.js — ambient turn 说出口的话的机械校验（add-companion-heartbeat 3.5）。
//
// 只查是否真实、是否越界：句数与长度、《》标题必须在本轮上下文里、不声称已播放、
// 无内部术语/URL/ID、不与她最近 3 句重复。不查情绪词。
import assert from 'node:assert/strict';
import test from 'node:test';
import { AMBIENT_LINE_MAX_CHARS, ambientLineDefect, ambientRuleFeedback } from './ambientLine.js';

const task = (overrides = {}) => ({
  contextText: '## 当前真实状态\n正在放《夜航星》（不才）。\n用户：今天加班到很晚',
  recentLines: ['这首的鼓点像在下雨。'],
  ...overrides,
});

test('自然的一两句话通过；情绪词不会导致拒绝', () => {
  for (const line of [
    '加班到这么晚，累坏了吧。',
    '我有点难过，也有点想你。要不要歇一会儿？',
    '《夜航星》的副歌一出来，整个晚上都安静了。',
    '好开心你还在听……',
  ]) assert.equal(ambientLineDefect(line, task()), null, line);
});

test('空、超过两句、过长都被拒绝', () => {
  assert.equal(ambientLineDefect('   ', task()), 'empty_text');
  assert.equal(ambientLineDefect('第一句。第二句。第三句。', task()), 'too_many_sentences');
  assert.equal(ambientLineDefect('第一句\n第二句\n第三句', task()), 'too_many_sentences');
  assert.equal(ambientLineDefect('嗯'.repeat(AMBIENT_LINE_MAX_CHARS + 1), task()), 'too_long');
  assert.equal(ambientLineDefect('嗯'.repeat(AMBIENT_LINE_MAX_CHARS), task()), null);
});

test('链接、内部术语、内部 ID 被拒绝', () => {
  assert.equal(ambientLineDefect('看看 https://example.com 吧。', task()), 'url');
  assert.equal(ambientLineDefect('队列里还有好几首呢。', task()), 'internal_terms');
  assert.equal(ambientLineDefect('刚才那句 turn_3f2a9c1d7e8b 你看到了吗？', task()), 'internal_id');
  assert.equal(ambientLineDefect('编号 9f86d081884c7d65 是什么。', task()), 'internal_id');
});

test('声称已经播放、切歌或安排了什么被拒绝', () => {
  assert.equal(ambientLineDefect('我已经给你换了一首轻一点的。', task()), 'playback_claim');
  assert.equal(ambientLineDefect('已经安排好下一首了。', task()), 'playback_claim');
});

test('《》标题必须出现在本轮上下文里', () => {
  assert.equal(ambientLineDefect('《夜航星》真适合夜里听。', task()), null);
  assert.equal(ambientLineDefect('要不要听听《晴天》？', task()), 'entity_outside_context');
  assert.equal(ambientLineDefect('要不要听听《晴天》？', task({ contextText: '用户：我最喜欢《晴天》' })), null);
});

test('与她最近说过的话几乎一样被拒绝', () => {
  assert.equal(ambientLineDefect('这首的鼓点像在下雨！', task()), 'repeats_recent');
  assert.equal(ambientLineDefect('外面好像真的下雨了。', task()), null);
});

test('每条规则都有可纠正的反馈，且不回显原句', () => {
  for (const rule of ['empty_text', 'too_many_sentences', 'too_long', 'url', 'internal_terms', 'internal_id',
    'playback_claim', 'entity_outside_context', 'repeats_recent']) {
    const feedback = ambientRuleFeedback(rule);
    assert.ok(feedback.length > 4, rule);
    assert.doesNotMatch(feedback, /夜航星|晴天/);
  }
});
