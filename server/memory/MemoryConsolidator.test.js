import assert from 'node:assert/strict';
import test from 'node:test';

import { SQLiteMemoryStore } from './MemoryStore.js';
import { MemoryService } from './MemoryService.js';
import { consolidateStation } from '../station/StationConsolidation.js';

function inMemoryService() {
  const svc = new MemoryService('station');
  svc.store = new SQLiteMemoryStore({ dbPath: ':memory:' });
  svc.store.initialize();
  svc._initialized = true;
  return svc;
}

function addSemantic(svc, content, source, confidence = 0.7) {
  const result = svc.addMemory({
    namespace: 'station', type: 'semantic', source, content, confidence, importance: 8, tags: ['shared-explicit'],
  });
  assert.equal(result.ok, true);
}

function confidences(svc) {
  return Object.fromEntries(svc.searchMemory(undefined, { namespace: 'station', limit: 20 })
    .map((row) => [row.content, row.confidence]));
}

test('反复整理不会把用户亲口说的、内容互不相关的共享事实降到 0', () => {
  const svc = inMemoryService();
  addSemantic(svc, '用户的猫叫小满', 'user_explicit_feedback');
  addSemantic(svc, '用户在上海做设计师', 'user_explicit_feedback');

  for (let run = 0; run < 8; run += 1) consolidateStation(svc);

  assert.deepEqual(confidences(svc), { 用户的猫叫小满: 0.7, 用户在上海做设计师: 0.7 });
});

test('与用户事实同标签的推断记忆仍会被降级，用户事实本身不动', () => {
  const svc = inMemoryService();
  addSemantic(svc, '用户的猫叫小满', 'user_explicit_feedback', 0.9);
  addSemantic(svc, '深夜偏好器乐后摇', 'agent_reflection', 0.6);

  const before = confidences(svc);
  consolidateStation(svc);

  const after = confidences(svc);
  assert.equal(after['用户的猫叫小满'], before['用户的猫叫小满']);
  assert.ok(after['深夜偏好器乐后摇'] < before['深夜偏好器乐后摇']);
});
