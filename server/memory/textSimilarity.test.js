// textSimilarity.test.js — 字符二元组相似度（CJK 适用）单测
//
// 覆盖：中文改写判似/判异边界、空串、单字、西文混排。

import { charBigrams, charBigramSimilarity } from './textSimilarity.js';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

const a = '用户不喜欢每次推歌都从同样的两首歌开始，希望推荐别形成固定套路。';
console.log('\n🧪 textSimilarity tests\n');

assert(charBigramSimilarity(a, a) === 1, '自身相似度为 1');
assert(charBigramSimilarity(a, '完全无关的另一句话谈论天气') < 0.2, '无关文本判异');
assert(charBigramSimilarity(a, '') === 0, '空串返回 0');
assert(charBigramSimilarity('', '') === 0, '双空串返回 0');
assert(charBigramSimilarity('好', '好') === 1, '单字相同返回 1');
assert(charBigramSimilarity('好', '坏') === 0, '单字不同返回 0');
assert(charBigramSimilarity('R&B 爱好者', 'R&B 爱好者！') === 1, '标点差异不影响');
assert(charBigramSimilarity(a, a.slice(0, 40)) > 0.6, '截断版仍高相似');

console.log(`\n──────────────────────`);
console.log(`${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
