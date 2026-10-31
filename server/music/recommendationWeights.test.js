import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateQuotas, effectiveWeights, equalWeights, mergeWeights, resolveRecommendationWeights,
} from './recommendationWeights.js';

test('没有配置时按可播源均分，目录源不占配额', () => {
  assert.deepEqual(equalWeights(['qq', 'ncm']), { qq: 0.5, ncm: 0.5 });
  assert.deepEqual(equalWeights(['qq', 'ncm', 'kugou']), { qq: 1 / 3, ncm: 1 / 3, kugou: 1 / 3 });
  assert.deepEqual(equalWeights([]), {}, '空列表不能除零');
  assert.deepEqual(mergeWeights(null, ['qq', 'ncm']), { qq: 0.5, ncm: 0.5 });
});

test('用户显式比例被保留，并归一到 1', () => {
  const weights = mergeWeights({ qq: 7, ncm: 3 }, ['qq', 'ncm']);
  assert.ok(Math.abs(weights.qq - 0.7) < 1e-9);
  assert.ok(Math.abs(weights.ncm - 0.3) < 1e-9);
  const uneven = mergeWeights({ qq: 0.2, ncm: 0.2 }, ['qq', 'ncm']);
  assert.ok(Math.abs(uneven.qq - 0.5) < 1e-9, '只要相对关系，不要求正好加满');
});

test('新增可播源拿到均分那一份，用户已调比例不被静默重置', () => {
  const weights = mergeWeights({ qq: 0.8, ncm: 0.2 }, ['qq', 'ncm', 'kugou']);
  assert.ok(Math.abs(weights.kugou - 1 / 3) < 1e-9, '新源不能是 0，否则看起来像坏了');
  const rest = 1 - weights.kugou;
  assert.ok(Math.abs(weights.qq - rest * (0.8 / 1)) < 1e-9);
  assert.ok(Math.abs(weights.ncm - rest * (0.2 / 1)) < 1e-9);
  assert.ok(Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('全 0 或非法保存值退回均分，不产生无意义配置', () => {
  assert.deepEqual(mergeWeights({ qq: 0, ncm: 0 }, ['qq', 'ncm']), { qq: 0.5, ncm: 0.5 });
  assert.deepEqual(mergeWeights({ qq: -1, ncm: 'x' }, ['qq', 'ncm']), { qq: 0.5, ncm: 0.5 });
  assert.deepEqual(mergeWeights({ apple: 1 }, ['qq', 'ncm']), { qq: 0.5, ncm: 0.5 },
    '目录源或未知源不进门');
});

test('某源不可兑现时按其余源相对权重归一，总量不缩水', () => {
  const targets = { qq: 0.7, ncm: 0.3 };
  const effective = effectiveWeights(targets, ['qq']);
  assert.deepEqual(effective, { qq: 1 });
  const three = effectiveWeights({ a: 0.5, b: 0.25, c: 0.25 }, ['b', 'c']);
  assert.ok(Math.abs(three.b - 0.5) < 1e-9);
  assert.ok(Math.abs(three.c - 0.5) < 1e-9);
  assert.deepEqual(effectiveWeights(targets, []), {}, '没有可用源时不能编一份均分');
  assert.deepEqual(effectiveWeights(targets, ['kugou']), {}, '不可兑现的源不算可用');
});

test('整数配额用最大余额法，结果稳定且不超发', () => {
  assert.deepEqual(allocateQuotas({ qq: 0.7, ncm: 0.3 }, 10), { qq: 7, ncm: 3 });
  const split = allocateQuotas({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 10);
  assert.equal(Object.values(split).reduce((x, y) => x + y, 0), 10);
  assert.deepEqual(allocateQuotas({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 10),
    allocateQuotas({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 10), '同样输入同样结果');
  assert.deepEqual(allocateQuotas({ qq: 1 }, 0), {});
  assert.deepEqual(allocateQuotas({}, 10), {});
});

test('一次算清目标、可兑现与配额', () => {
  const result = resolveRecommendationWeights({ saved: { qq: 7, ncm: 3 },
    playableIds: ['qq', 'ncm'], availableIds: ['ncm'], total: 6 });
  assert.ok(Math.abs(result.targets.qq - 0.7) < 1e-9);
  assert.deepEqual(result.effective, { ncm: 1 });
  assert.deepEqual(result.quotas, { ncm: 6 });
});
