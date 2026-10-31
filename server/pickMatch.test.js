// pickMatch.test.js — 两个源的模糊匹配口径必须一致，且**不许猜**。
//
// 以前两个 pickMatch 的末段都是 `candidates[0].score = 50; return candidates[0];`，
// 即「没有任何候选达标时，拿第一条并给它一个分数」。多源之后候选更多，
// 这条兜底等于把抛硬币包装成结论：用户会听到一首名字相近的、别的歌。
import assert from 'node:assert/strict';
import test from 'node:test';
import { pickMatch as qqPickMatch } from './qq.js';
import { pickMatch as ncmPickMatch } from './ncm.js';

const IMPLEMENTATIONS = [
  ['qq', qqPickMatch],
  ['ncm', ncmPickMatch],
];

const CANDIDATES = () => [
  { song_id: 'a', title: '晴天', artist: '周杰伦' },
  { song_id: 'b', title: '稻香', artist: '周杰伦' },
];

for (const [name, pickMatch] of IMPLEMENTATIONS) {
  test(`${name}: an exact title is a confident match`, () => {
    const hit = pickMatch('晴天', CANDIDATES());
    assert.equal(hit.song_id, 'a');
    assert.equal(hit.score, 100);
  });

  test(`${name}: a title containing the query is a match, a query containing the title is a weaker one`, () => {
    const contained = pickMatch('晴', CANDIDATES());
    assert.equal(contained.song_id, 'a');
    // 单字查询命中 t.includes(q) 的 85；这里只要求它不是一个硬币翻转的结果。
    assert.ok(contained.score >= 75);

    const reverse = pickMatch('东风破 现场版', [{ song_id: 'c', title: '东风破', artist: '周杰伦' }]);
    assert.equal(reverse?.song_id, 'c');
    assert.equal(reverse.score, 80);
  });

  test(`${name}: a two-character title inside a longer query is a known gap, not a guess`, () => {
    // 既存启发式要求 `query.includes(title) && title.length > 2`。中文两字标题
    // （晴天/稻香/十年）因此不会在更长查询里被匹配。去掉硬币翻转之后这里返回 null，
    // 也就是 fail closed —— 宁可让用户换个说法，也不播一首相近的歌。
    // 放宽这条启发式属于独立的召回改进，不在本次范围。
    assert.equal(pickMatch('周杰伦 晴天 现场版', CANDIDATES()), null);
  });

  test(`${name}: no evidence means no match, and no candidate is mutated`, () => {
    const candidates = CANDIDATES();
    const hit = pickMatch('完全不相干的东西', candidates);
    assert.equal(hit, null, 'must not fall back to the first candidate');
    for (const candidate of candidates) {
      assert.equal(candidate.score, undefined, 'a non-match must not be labelled with a score');
    }
  });

  test(`${name}: an empty result set is not a match`, () => {
    assert.equal(pickMatch('晴天', []), null);
  });

  test(`${name}: artist words alone are enough only when the query has several parts`, () => {
    // 「周杰伦 稻香」同时命中标题与艺人 → 75 档，可以接受。
    const hit = pickMatch('周杰伦 稻香', CANDIDATES());
    assert.equal(hit.song_id, 'b');
    assert.ok(hit.score >= 75);
    // 只有一个不相关的词时不该硬凑。
    assert.equal(pickMatch('周杰伦', CANDIDATES()), null);
  });
}
