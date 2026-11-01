// TasteSchemaService.test.js — 口味图式蒸馏（add-taste-learning-loop P2）
//
// 覆盖：
//   - 规则版兜底蒸馏（无 LLM / LLM 失败 / LLM 非法输出）
//   - 首次蒸馏迁移旧 user/taste.md、user/mood-rules.md（migratedFrom 记录，文件只读）
//   - 同日非手动跳过；手动绕过并升 revision
//   - LLM 合法输出被采用
//   - 撤销后不得重建
//   - stationMemoryTarget / collectStationTasteSchemas 装配

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryService } from './MemoryService.js';
import { TasteSchemaService, stationMemoryTarget, collectStationTasteSchemas } from './TasteSchemaService.js';
import { revokeMemory } from './memoryProvenance.js';

// Windows 下 new URL().pathname 返回 "/D:/..."，path.resolve 会解析出错误盘符路径；fileURLToPath 才是正确写法。
const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const repoPrompt = resolve(repoRoot, 'prompts', 'taste-schema.md');

const workdir = mkdtempSync(resolve(tmpdir(), 'lunara-taste-schema-test-'));
process.chdir(workdir);
mkdirSync(resolve(workdir, 'user'), { recursive: true });
writeFileSync(resolve(workdir, 'user', 'taste.md'), '# 旧口味\n偏爱 R&B，少听电子。');
writeFileSync(resolve(workdir, 'user', 'mood-rules.md'), '- 深夜放慢歌。');

let dbNumber = 0;
async function makeService() {
  process.env.LUNARA_DB_PATH = resolve(workdir, `state-${++dbNumber}.db`);
  const svc = new MemoryService('radiohost:t1');
  await svc.initialize();
  return svc;
}

const stats = [
  { provider: 'qq', songId: '1', songQuery: '爱，很简单 — 陶喆', outcome: 'completed', count: 5 },
  { provider: 'qq', songId: '2', songQuery: 'Love Song — 方大同', outcome: 'completed', count: 3 },
  { provider: 'qq', songId: '3', songQuery: '塑料袋 — 某某', outcome: 'skipped', count: 4 },
  { provider: 'qq', songId: '4', songQuery: '故障曲 — 某某', outcome: 'technical_failure', count: 2 },
];

function makeService2(svc, { llm } = {}) {
  return new TasteSchemaService({
    memoryTarget: async () => ({ service: svc, namespace: svc.namespace }),
    getSongStats: () => stats,
    readLegacyFiles: async () => ({ taste: '# 旧口味\n偏爱 R&B，少听电子。', moodRules: '- 深夜放慢歌。' }),
    promptPath: repoPrompt,
    llm: llm || { askText: async () => { throw new Error('LLM_OFF'); }, extractJson: () => null },
  });
}

test('首次蒸馏走规则兜底并迁移旧档案', async () => {
  const svc = await makeService();
  const distiller = makeService2(svc);
  const result = await distiller.distill('host-t1');
  assert.ok(result.ok, `蒸馏成功: ${JSON.stringify(result)}`);
  assert.equal(result.source, 'fallback');
  assert.equal(result.revision, 1);
  const row = distiller.schemaRow(svc, svc.namespace);
  assert.ok(row, '图式行存在');
  assert.equal(row.importance, 8, 'importance 8');
  assert.match(row.tags, /taste-schema/);
  assert.ok(row.content.length <= 2000, '内容不超过 2000 字符');
  assert.match(row.content, /偏爱 R&B，少听电子。/, '迁移旧 taste.md 内容');
  assert.match(row.content, /爱，很简单/, '统计基线入图式');
  assert.doesNotMatch(row.content, /故障曲/, '技术失败不进统计基线');
  const evidence = JSON.parse(row.evidence);
  assert.deepEqual(evidence.migratedFrom, ['user/taste.md', 'user/mood-rules.md']);
  assert.ok(readSafe('user/taste.md').includes('偏爱 R&B'), '旧文件保留在磁盘');
});

function readSafe(rel) {
  try { return readFileSync(resolve(workdir, rel), 'utf8'); }
  catch { return ''; }
}

test('同日非手动跳过，手动绕过并升 revision', async () => {
  const svc = await makeService();
  const distiller = makeService2(svc);
  assert.ok((await distiller.distill('host-t1')).ok);
  const second = await distiller.distill('host-t1', { manual: false });
  assert.equal(second.code, 'ALREADY_TODAY');
  const manual = await distiller.distill('host-t1', { manual: true });
  assert.ok(manual.ok && manual.revision === 2, `手动蒸馏 revision 2: ${JSON.stringify(manual)}`);
});

test('LLM 合法输出被采用，非法输出回落兜底', async () => {
  const svc = await makeService();
  const good = makeService2(svc, { llm: {
    askText: async () => JSON.stringify({ content: '# 蒸馏后的图式\n用户长期偏爱 R&B。', notes: '全量重写' }),
    extractJson: text => JSON.parse(text),
  } });
  const ok = await good.distill('host-t1');
  assert.ok(ok.ok && ok.source === 'llm');
  assert.match(good.schemaRow(svc, svc.namespace).content, /蒸馏后的图式/);

  const svc2 = await makeService();
  const bad = makeService2(svc2, { llm: {
    askText: async () => '这不是 JSON',
    extractJson: () => null,
  } });
  const fallback = await bad.distill('host-t1');
  assert.ok(fallback.ok && fallback.source === 'fallback');
});

test('撤销后蒸馏不再重建', async () => {
  const svc = await makeService();
  const distiller = makeService2(svc);
  assert.ok((await distiller.distill('host-t1')).ok);
  const row = distiller.schemaRow(svc, svc.namespace);
  revokeMemory(svc.store, row.id);
  const next = await distiller.distill('host-t1', { manual: true });
  assert.equal(next.code, 'SCHEMA_REVOKED');
  assert.equal(distiller.schemaRow(svc, svc.namespace), null, '无未撤销图式行');
});

test('stationMemoryTarget 与 collectStationTasteSchemas 装配', async () => {
  const svc = await makeService();
  const station = {
    stationMemory: null,
    virtualPersonRegistry: { db: null },
    async getRadioHostMemoryService(id) { return id === 'host-t1' ? svc : null; },
    listRadioHosts() { return [{ id: 'host-t1' }]; },
    getReflectionAgent() { return { store: { songStats: () => stats } }; },
  };
  const target = await stationMemoryTarget(station, 'host-t1');
  assert.ok(target?.service === svc && target.namespace === svc.namespace);
  const distiller = makeService2(svc);
  await distiller.distill('host-t1');
  const collected = await collectStationTasteSchemas(station);
  assert.equal(collected.length, 1);
  assert.equal(collected[0].personId, 'host-t1');
  assert.equal(collected[0].source, 'db-schema');
});

// ---- 图式必须继承来源的范围（fix-release-blocking-defects）----
//
// 图式是 namespace 级、无条件注入的：一旦把会话限定或私密记忆蒸进去，它就会在
// 群聊和其他会话里出现，等于把私人事实升级成全局事实。因此蒸馏只收「最宽受众可用」
// 的输入，并把用到的来源 id 记进 evidence，供注入前复核。

test('会话限定与私密记忆不进入图式，且 evidence 记录贡献来源', async () => {
  const svc = await makeService();
  const global = svc.addMemory({ namespace: svc.namespace, type: 'semantic', content: '喜欢爵士钢琴',
    source: 'user_explicit_feedback', tags: ['person-relationship'], evidence: '{}' });
  const scoped = svc.addMemory({ namespace: svc.namespace, type: 'semantic', content: '只在这次聊天里承认爱听儿歌',
    source: 'user_explicit_feedback', tags: ['person-relationship'],
    evidence: JSON.stringify({ policy: { onlyConversationId: 'conversation:tmp' } }) });
  const secret = svc.addMemory({ namespace: svc.namespace, type: 'semantic', content: '私下说过的秘密曲目',
    source: 'user_explicit_feedback', tags: ['person-relationship'],
    evidence: JSON.stringify({ policy: { disclosure: 'private' } }) });
  const revoked = svc.addMemory({ namespace: svc.namespace, type: 'semantic', content: '已经撤回的旧偏好',
    source: 'user_explicit_feedback', tags: ['person-relationship'], evidence: '{}' });
  revokeMemory(svc.store, revoked.id);

  const distiller = makeService2(svc);
  const result = await distiller.distill('host-t1', { manual: true });
  assert.ok(result.ok, `蒸馏成功: ${JSON.stringify(result)}`);
  const row = distiller.schemaRow(svc, svc.namespace);
  assert.match(row.content, /喜欢爵士钢琴/, '最宽受众可用的显式记忆仍要进图式');
  assert.doesNotMatch(row.content, /儿歌/, '会话限定记忆不得进入 namespace 级图式');
  assert.doesNotMatch(row.content, /秘密曲目/, '私密记忆不得进入 namespace 级图式');
  assert.doesNotMatch(row.content, /已经撤回的旧偏好/, '已撤销来源不得被重新学回');

  const evidence = JSON.parse(row.evidence);
  assert.ok(Array.isArray(evidence.contributorIds), 'evidence 记录贡献来源 id');
  assert.ok(evidence.contributorIds.includes(global.id), '记下真正用到的来源');
  assert.ok(!evidence.contributorIds.includes(scoped.id), '被排除的来源不记为贡献者');
  assert.ok(!evidence.contributorIds.includes(secret.id));
  assert.equal(evidence.scope, 'widest-audience', '显式记录图式的适用面');
});
