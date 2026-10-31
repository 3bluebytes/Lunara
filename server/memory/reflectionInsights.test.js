// reflectionInsights.test.js — 注入价值排序 + claim 去重 + 提取强化
//
// 覆盖 add-taste-learning-loop P1：
//   - claim 标签洞察优先于无 key 事实性记录
//   - 同 claim 同极性去重，对立极性共存
//   - limit 可配（含 env 读取）
//   - 注入路径调用 incrementAccess（access_count 增长）
//   - retrievePersonMemories 返回 taste-schema 行（kind=schema），撤销后排除

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryService } from './MemoryService.js';
import { recentReflectionInsights } from './reflectionInsights.js';
import { retrievePersonMemories } from '../virtual-person/personMemory.js';
import { revokeMemory } from './memoryProvenance.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-reflection-inject-test-')));

let dbNumber = 0;
async function makeService(ns) {
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `state-${++dbNumber}.db`);
  const svc = new MemoryService(ns);
  await svc.initialize();
  return svc;
}

const insight = (service, { content, claim, confidence = 0.3, tags = 'reflection-insight,reflection-short' }) => {
  const result = service.addMemory({
    namespace: service.namespace, type: 'semantic', source: 'agent_reflection',
    content, summary: '短窗反思', tags: claim ? `${tags},claim:${claim.key}` : tags,
    confidence, importance: 5,
    evidence: JSON.stringify({ eventKeys: ['e1'], claim, scope: 'recent-listening-context' }),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });
  assert.ok(result.ok, 'insight 写入成功');
  return result.id;
};

test('claim 标签洞察优先于无 key 记录，同 claim 同极性去重', async () => {
  const svc = await makeService('radiohost:rank');
  insight(svc, { content: '流水账：两首完整播放。', confidence: 0.35 });
  insight(svc, { content: '用户偏爱 R&B。', claim: { key: 'music.genre.rnb', polarity: 'positive' }, confidence: 0.3 });
  insight(svc, { content: '用户偏爱 R&B（强化）。', claim: { key: 'music.genre.rnb', polarity: 'positive' }, confidence: 0.4 });
  const rows = recentReflectionInsights(svc, svc.namespace, { limit: 3 });
  assert.equal(rows.length, 2, '同 claim 同极性只留最高分一条');
  assert.match(rows[0].content, /强化/, 'claim 高分记录排第一');
  const keyless = rows[1];
  assert.ok(!keyless.content.includes('R&B'), '无 key 记录排在 claim 之后');
});

test('对立极性共存且各自去重', async () => {
  const svc = await makeService('radiohost:conflict');
  insight(svc, { content: '想多听 R&B。', claim: { key: 'music.genre.rnb', polarity: 'positive' } });
  insight(svc, { content: '暂时不想听 R&B。', claim: { key: 'music.genre.rnb', polarity: 'negative' } });
  insight(svc, { content: '暂时不想听 R&B（强化）。', claim: { key: 'music.genre.rnb', polarity: 'negative' }, confidence: 0.5 });
  const rows = recentReflectionInsights(svc, svc.namespace, { limit: 5 });
  assert.equal(rows.length, 2, '正负极性各留一条');
});

test('limit 参数与撤销排除', async () => {
  const svc = await makeService('radiohost:limit');
  const first = insight(svc, { content: '第一条', claim: { key: 'a.b', polarity: 'positive' } });
  insight(svc, { content: '第二条', claim: { key: 'c.d', polarity: 'positive' } });
  insight(svc, { content: '第三条', claim: { key: 'e.f', polarity: 'positive' } });
  assert.equal(recentReflectionInsights(svc, svc.namespace, { limit: 2 }).length, 2);
  revokeMemory(svc.store, first);
  const rows = recentReflectionInsights(svc, svc.namespace, { limit: 5 });
  assert.equal(rows.length, 2, '撤销后排除');
  assert.ok(rows.every(row => row.id !== first), '不含已撤销行');
});

test('注入路径强化 access 并携带 schema', async () => {
  const svc = await makeService('radiohost:inject');
  const rid = insight(svc, { content: '用户推歌别从固定歌曲开始。', claim: { key: 'recommendation.routine', polarity: 'negative' } });
  // 图式必须带着可重验的来源才会被注入（fix-release-blocking-defects）：
  // 来源被撤回/收窄后，副本也不能继续携带它的内容。
  const contributor = svc.addMemory({
    namespace: svc.namespace, type: 'semantic', source: 'user_explicit_feedback',
    content: '喜欢爵士钢琴', tags: ['person-relationship'], evidence: '{}',
  });
  assert.ok(contributor.ok, '贡献来源写入成功');
  const schema = svc.addMemory({
    namespace: svc.namespace, type: 'semantic', source: 'agent_reflection',
    content: '# 口味图式', summary: '口味图式', tags: 'taste-schema', confidence: 0.7, importance: 8,
    evidence: JSON.stringify({ revision: 1, scope: 'widest-audience', contributorIds: [contributor.id] }),
  });
  assert.ok(schema.ok, 'schema 写入成功');
  const before = svc.store.getById(rid).accessCount;
  const memories = retrievePersonMemories(svc, null, {
    namespace: svc.namespace, virtualPersonId: 'radiohost:inject', sessionId: 's1', query: '',
    isSharedMemoryActive: () => true,
  });
  const kinds = memories.map(row => row.kind);
  assert.ok(kinds.includes('schema'), 'schema 行进入注入列表');
  assert.ok(kinds.includes('reflection'), 'reflection 行进入注入列表');
  assert.equal(svc.store.getById(rid).accessCount, before + 1, '注入的洞察 access_count +1');

  revokeMemory(svc.store, schema.id);
  const after = retrievePersonMemories(svc, null, {
    namespace: svc.namespace, virtualPersonId: 'radiohost:inject', sessionId: 's1', query: '',
    isSharedMemoryActive: () => true,
  });
  assert.ok(!after.map(row => row.kind).includes('schema'), '撤销后 schema 不再注入');

  // 另一个方向：撤回「贡献来源」同样不能让图式继续携带它。
  const other = await makeService('radiohost:inject2');
  const source = other.addMemory({ namespace: other.namespace, type: 'semantic', source: 'user_explicit_feedback',
    content: '喜欢爵士钢琴', tags: ['person-relationship'], evidence: '{}' });
  other.addMemory({ namespace: other.namespace, type: 'semantic', source: 'agent_reflection',
    content: '# 口味图式', tags: 'taste-schema', importance: 8,
    evidence: JSON.stringify({ revision: 1, scope: 'widest-audience', contributorIds: [source.id] }) });
  revokeMemory(other.store, source.id);
  const gated = retrievePersonMemories(other, null, {
    namespace: other.namespace, virtualPersonId: 'radiohost:inject2', sessionId: 's1', query: '',
    isSharedMemoryActive: () => true,
  });
  assert.ok(!gated.map(row => row.kind).includes('schema'), '来源被忘记后图式停止注入');
});
