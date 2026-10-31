import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryController } from './memoryController.js';

test('memory load, explicit write, and consolidation preserve API semantics', async () => {
  const calls = [];
  const controller = createMemoryController({
    apiClient: {
      get: async path => path === '/api/memory/shared'
        ? { ok: true, memories: [{ id: 'm1' }], candidates: [{ id: 'pending', status: 'pending' }, { id: 'revoked', status: 'revoked' }] }
        : { ok: true, stationMemory: { semantic: 2, episodic: 1, working: 1 } },
      post: async (...args) => { calls.push(args); return args[0].endsWith('consolidate') ? { ok: true, promoted: 1 } : { ok: true }; },
    },
  });
  const loaded = await controller.load();
  assert.equal(loaded.total, 1);
  assert.equal(loaded.candidates.length, 1);
  await controller.add('喜欢雨声', 'focus,rain');
  await controller.consolidate();
  assert.deepEqual(calls, [
    ['/api/station/memory', { content: '喜欢雨声', source: 'user_explicit_feedback', tags: 'focus,rain' }],
    ['/api/station/consolidate', {}],
  ]);
});

test('memory mutations reject unsuccessful server results', async () => {
  const controller = createMemoryController({ apiClient: {
    get: async () => ({}), post: async () => ({ ok: false }),
  } });
  await assert.rejects(controller.correct('m1', '雨声'), /记忆修改失败/);
  await assert.rejects(controller.forget('m1'), /记忆修改失败/);
  await assert.rejects(controller.dismissCandidate('c1'), /记忆修改失败/);
});

test('memory add rejects empty content before HTTP', async () => {
  const controller = createMemoryController({ apiClient: { get: async () => ({}), post: async () => ({}) } });
  await assert.rejects(controller.add('  '), /记忆内容不能为空/);
});
