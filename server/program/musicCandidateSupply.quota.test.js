import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { orderCandidatesByQuota } from './musicCandidateSupply.js';

const rows = (provider, n, prefix = provider) => Array.from({ length: n }, (_, i) => ({
  source: `${provider}:daily`, song_id: `${prefix}${i}`, title: `T{i}`, artist: 'A',
}));
const providersOf = list => list.map(row => row.source.split(':')[0]);
const mix = list => list.reduce((acc, id) => ({ ...acc, [id]: (acc[id] || 0) + 1 }), {});

test('未配置时就是均分，且一条候选都不丢', () => {
  const input = [...rows('qq', 30), ...rows('ncm', 30)];
  const out = orderCandidatesByQuota(input, { saved: null, budget: 10, playableIds: ['qq', 'ncm'] });
  assert.equal(out.length, input.length, '重排不截断');
  assert.deepEqual(mix(providersOf(out.slice(0, 10))), { qq: 5, ncm: 5 });
});

test('用户比例决定候选池头部的源构成', () => {
  const input = [...rows('qq', 40), ...rows('ncm', 40)];
  const out = orderCandidatesByQuota(input, { saved: { qq: 70, ncm: 30 }, budget: 10, playableIds: ['qq', 'ncm'] });
  assert.deepEqual(mix(providersOf(out.slice(0, 10))), { qq: 7, ncm: 3 });
  assert.equal(new Set(out.map(row => `${row.source}:${row.song_id}`)).size, input.length, '没有重复也没有丢失');
});

test('某源候选不足时按相对权重接住空位，不硬凑不缩水', () => {
  const input = [...rows('qq', 40), ...rows('ncm', 2)];
  const out = orderCandidatesByQuota(input, { saved: { qq: 30, ncm: 70 }, budget: 10, playableIds: ['qq', 'ncm'] });
  const head = mix(providersOf(out.slice(0, 10)));
  assert.equal(head.ncm, 2, '只有两条就只用两条，不重复也不编造');
  assert.equal(head.qq, 8);
  assert.equal(out.length, input.length);
});

test('单源或目录源不参与配额：保持原顺序', () => {
  const input = [...rows('qq', 5), { source: 'apple:catalog', song_id: 'a1', title: 'T', artist: 'A' }];
  const out = orderCandidatesByQuota(input, { saved: { qq: 1 }, budget: 3, playableIds: ['qq', 'ncm'] });
  assert.deepEqual(out.map(row => row.source), input.map(row => row.source));
});

test('确定搜索与播放路径不读推荐权重：同样输入给出同样的源选择', async () => {
  // 结构断言胜过口头承诺：解析器一旦 import 权重，这条就会红。
  const resolver = await readFile(new URL('../musicResolver.js', import.meta.url), 'utf8');
  assert.doesNotMatch(resolver, /recommendationWeights|recommendationMix/, '播放与解析路径必须与偏好无关');
  const commit = await readFile(new URL('../program/ProgramCommitService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(commit, /recommendationWeights|orderCandidatesByQuota/, '提交路径不消费配额');
});

test('预算为 0 时完全不动：供给层不该在没有配额需求时改变顺序', () => {
  const input = [...rows('qq', 3), ...rows('ncm', 3)];
  assert.deepEqual(orderCandidatesByQuota(input, { budget: 0 }), input);
});
