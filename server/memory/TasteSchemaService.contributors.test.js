import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'lunara-schema-contributors-'));
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import(`${ROOT}/memory/MemoryService.js`);
const { TasteSchemaService } = await import(`${ROOT}/memory/TasteSchemaService.js`);
const { revokeMemory } = await import(`${ROOT}/memory/memoryProvenance.js`);
const { retrievePersonMemories } = await import(`${ROOT}/virtual-person/personMemory.js`);

test('反思洞察很多时显式事实仍记为图式来源：忘掉它后图式不再注入', async () => {
  const ns = 'person:a';
  const memory = new MemoryService(ns);
  await memory.initialize();
  try {
    const fact = memory.addMemory({ namespace: ns, type: 'semantic', source: 'user_explicit_feedback', content: '用户最爱听坂本龙一',
      tags: ['person-relationship'], evidence: JSON.stringify({ writeKey: 'wk-fact', sourceTurnId: 'u-fact', policy: { disclosure: 'normal' } }) });
    for (let i = 0; i < 45; i += 1) {
      memory.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: `第${i}条听歌观察`,
        tags: 'reflection-insight,reflection-short', expiresAt: Date.now() + 86_400_000,
        evidence: JSON.stringify({ eventKeys: [`turn:x${i}`], sourceTurnIds: [`ux${i}`], policy: { disclosure: 'normal' } }) });
    }
    const svc = new TasteSchemaService({ memoryTarget: async () => ({ service: memory, namespace: ns }),
      llm: { askText: async () => { throw new Error('offline'); } }, logger: { warn() {} } });
    const r = await svc.distill('a', { manual: true });
    assert.equal(r.ok, true);
    const schema = memory.store.getById(r.id);
    assert.match(schema.content, /坂本龙一/, 'precondition: schema text carries the explicit fact');
    revokeMemory(memory.store, fact.id); // 用户：忘掉我最爱坂本龙一
    const injected = retrievePersonMemories(memory, null, { namespace: ns, virtualPersonId: 'a', sessionId: 's', query: '' })
      .filter(row => row.kind === 'schema').map(row => row.content).join('\n');
    assert.doesNotMatch(injected, /坂本龙一/, '被忘掉的显式事实不应再经图式注入');
  } finally { await memory.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test('校验图式来源是只读的：不给来源记访问次数', async () => {
  const { schemaContributorsStillApply } = await import(`${ROOT}/memory/memoryProvenance.js`);
  const ns = 'person:c';
  const memory = new MemoryService(ns);
  await memory.initialize();
  try {
    const fact = memory.addMemory({ namespace: ns, type: 'semantic', source: 'user_explicit_feedback', content: '用户喜欢爵士',
      evidence: JSON.stringify({ writeKey: 'wk-c', sourceTurnId: 'u-c', policy: { disclosure: 'normal' } }) });
    const schema = { evidence: JSON.stringify({ scope: 'widest-audience', contributorIds: [fact.id] }) };
    const before = memory.store.getById(fact.id).accessCount;
    for (let i = 0; i < 3; i += 1) assert.equal(schemaContributorsStillApply(memory, schema), true);
    assert.equal(memory.store.getById(fact.id).accessCount, before);
  } finally { await memory.shutdown(); }
});
