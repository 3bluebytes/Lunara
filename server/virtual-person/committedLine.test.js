// committedLine.test.js — 播放提交后，模型在同一条消息里写好的那句话能不能直接给用户看。
import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptCommittedLine } from './committedLine.js';

const policy = { allowedTitles: ['小小的太阳', '特别的人'] };

test('只提到已提交歌曲的自然一句话被采用（去掉首尾空白与说话人标签）', () => {
  assert.equal(acceptCommittedLine('  我挑了《特别的人》，副歌那段很适合现在。 ', policy), '我挑了《特别的人》，副歌那段很适合现在。');
  assert.equal(acceptCommittedLine('[历史说话人：小满]\n《小小的太阳》给你，暖一点。', policy), '《小小的太阳》给你，暖一点。');
  assert.equal(acceptCommittedLine('这两首都给你安排上了，先暖一点再慢下来。', policy), '这两首都给你安排上了，先暖一点再慢下来。');
});

test('提到没提交的歌、宣称已经出声、泄露机制或过长的都不采用', () => {
  for (const text of [
    '',
    '《小小的太阳》和《爱爱爱》都安排上了。',
    '《特别的人》已经在放了。',
    '现在正在播《特别的人》。',
    '已经切到《特别的人》。',
    '候选里我选了《特别的人》提交了。',
    '最终排歌的人会决定放哪首。',
    '看看 https://example.com',
    '好'.repeat(201),
  ]) assert.equal(acceptCommittedLine(text, policy), '', text);
});

test('没有放行策略就不采用模型的话', () => {
  assert.equal(acceptCommittedLine('《特别的人》给你。', null), '');
  assert.equal(acceptCommittedLine('《特别的人》给你。', { allowedTitles: [] }), '');
});

test('别人推荐的歌不能说成自己挑的；交代来源或只说自己的那首照常采用', () => {
  const group = { allowedTitles: ['春风吹', '三人游'], othersTitles: ['春风吹'] };
  for (const text of ['我挑了《春风吹》，先放这个。', '我推荐的《春风吹》和《三人游》都排上了。', '我选的是《春风吹》。']) {
    assert.equal(acceptCommittedLine(text, group), '', text);
  }
  assert.equal(acceptCommittedLine('小满推的《春风吹》我收下了，再加上我挑的《三人游》。', group),
    '小满推的《春风吹》我收下了，再加上我挑的《三人游》。');
});

test('committed line strips peer envelope markers before checking', () => {
  assert.equal(acceptCommittedLine('<peer_message from="小满" member="x" round="current">\n《小小的太阳》给你，暖一点。\n</peer_message>', policy),
    '《小小的太阳》给你，暖一点。');
});
