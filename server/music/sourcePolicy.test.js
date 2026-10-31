import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourcePolicy, readSourcePolicy, sourceAllowed } from './sourcePolicy.js';
test('legacy settings stay multi and preserve primary order', () => {
  assert.deepEqual(normalizeSourcePolicy({ primarySource: 'ncm' }), { mode: 'multi', primarySource: 'ncm', sources: ['ncm', 'qq'] });
  assert.equal(readSourcePolicy({ getPref: () => '{broken' }).mode, 'multi');
});
test('single is exactly one playable provider; unknown legacy source is ignored', () => {
  const policy = normalizeSourcePolicy({ playbackSourceMode: 'single', primarySource: 'qq', source: 'apple' });
  assert.deepEqual(policy.sources, ['qq']);
  assert.equal(sourceAllowed(policy, 'qq:library'), true);
  assert.equal(sourceAllowed(policy, 'ncm'), false);
  assert.equal(sourceAllowed(policy, 'apple'), false);
});
