import test from 'node:test';
import assert from 'node:assert/strict';

// 预算常量在模块加载时读取环境变量，所以每个用例用不同的 query string 绕过模块缓存。
const load = async label => import(`./continuationBudget.js?case=${label}`);

test('the default budget keeps the batch strictly larger than the look-ahead', async () => {
  const budget = await load('default');
  assert.equal(budget.CONTINUATION_LOOKAHEAD, 1);
  assert.equal(budget.CONTINUATION_BATCH_SIZE, 3);
  assert.ok(budget.CONTINUATION_BATCH_SIZE > budget.CONTINUATION_LOOKAHEAD,
    '批量必须大于提前量，否则队列会永远贴着阈值、每次换歌都续选');
});

test('a batch configured at or below the look-ahead is lifted to look-ahead + 1', async () => {
  const previous = { ...process.env };
  process.env.MUSIC_CONTINUATION_LOOKAHEAD = '3';
  process.env.MUSIC_CONTINUATION_BATCH = '2';
  try {
    const budget = await load('lifted');
    assert.equal(budget.CONTINUATION_LOOKAHEAD, 3);
    assert.equal(budget.CONTINUATION_BATCH_SIZE, 4, '不变量按构造兜底，调参也不会退化');
  } finally {
    process.env = previous;
  }
});

test('invalid or negative tuning values fall back to the documented defaults', async () => {
  const previous = { ...process.env };
  process.env.MUSIC_CONTINUATION_LOOKAHEAD = 'nonsense';
  process.env.MUSIC_CONTINUATION_BATCH = '-4';
  try {
    const budget = await load('invalid');
    assert.equal(budget.CONTINUATION_LOOKAHEAD, 1);
    assert.equal(budget.CONTINUATION_BATCH_SIZE, 3);
  } finally {
    process.env = previous;
  }
});
