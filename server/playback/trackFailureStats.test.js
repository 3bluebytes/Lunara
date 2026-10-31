import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACK_FAILURE_KINDS, createTrackFailureStats, normalizeTrackFailureKind } from './trackFailureStats.js';

test('只保留封闭分类：原始报错文本一律归到 unknown', () => {
  assert.equal(normalizeTrackFailureKind('network'), 'network');
  assert.equal(normalizeTrackFailureKind('DECODE'), 'decode');
  assert.equal(normalizeTrackFailureKind('MEDIA_ERR_SRC_NOT_SUPPORTED'), 'unknown');
  assert.equal(normalizeTrackFailureKind('Failed to load https://cdn.example/a.mp3'), 'unknown');
  assert.equal(normalizeTrackFailureKind(undefined), 'unknown');
  assert.deepEqual([...TRACK_FAILURE_KINDS], ['timeout', 'network', 'decode', 'unsupported', 'aborted', 'unknown']);
});

test('按分类与源计数，摘要里没有任何原文', () => {
  const stats = createTrackFailureStats({ now: () => 1000 });
  stats.record({ provider: 'qq', kind: 'timeout' });
  stats.record({ provider: 'qq', kind: 'timeout' });
  stats.record({ provider: 'ncm', kind: 'unsupported' });
  stats.record({ provider: 'qq', kind: 'https://cdn.example/secret.mp3?token=abc' });
  const summary = stats.inspect();
  assert.equal(summary.total, 4);
  assert.equal(summary.kinds.timeout, 2);
  assert.equal(summary.kinds.unsupported, 1);
  assert.equal(summary.kinds.unknown, 1);
  assert.deepEqual(summary.providers.map(row => [row.provider, row.total]), [['qq', 3], ['ncm', 1]]);
  assert.match(JSON.stringify(summary), /^[^{]*\{/);
  assert.doesNotMatch(JSON.stringify(summary), /cdn\.example|token/);
});

test('源数量有界：新源挤掉最久未出现的那个，不会无限增长', () => {
  const stats = createTrackFailureStats({ maxProviders: 2 });
  stats.record({ provider: 'a', kind: 'network' });
  stats.record({ provider: 'b', kind: 'network' });
  stats.record({ provider: 'c', kind: 'network' });
  const providers = stats.inspect().providers.map(row => row.provider).sort();
  assert.deepEqual(providers, ['b', 'c']);
  assert.equal(stats.inspect().total, 3, '总量仍记全部尝试');
});
