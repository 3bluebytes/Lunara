// personMemory.test.js — 图式注入的范围门（fix-release-blocking-defects）。
//
// 图式是 namespace 级、无条件注入的记忆。一旦它的来源被撤回、被收窄或过期，
// 就不能继续由图式携带那份内容——否则「忘记」只对原记忆生效，对副本无效。
//
// Run: node --test server/virtual-person/personMemory.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryService } from '../memory/MemoryService.js';
import { revokeMemory } from '../memory/memoryProvenance.js';
import { retrievePersonMemories } from './personMemory.js';

let counter = 0;
async function withService(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-person-memory-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'state.db');
  const service = new MemoryService('radiohost:t1');
  await service.initialize();
  try {
    return await run(service);
  } finally {
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 写入一条图式行；contributorIds/scope 可省略以模拟旧图式。 */
function writeSchema(service, { content = '长期偏爱爵士钢琴。', contributorIds, scope = 'widest-audience' } = {}) {
  return service.addMemory({
    namespace: service.namespace, type: 'semantic', content, tags: 'taste-schema', importance: 8,
    evidence: JSON.stringify({ schema: 2, revision: 1, generatedBy: 'fallback',
      ...(scope ? { scope } : {}), ...(contributorIds ? { contributorIds } : {}) }),
  });
}

function schemaTexts(service) {
  return retrievePersonMemories(service, null, { namespace: service.namespace, virtualPersonId: 't1',
    sessionId: 'conversation:primary', query: '想听点什么' })
    .filter(row => row.kind === 'schema').map(row => row.content);
}

test('a schema with live widest-audience contributors is injected', async () => {
  await withService(async service => {
    const contributor = service.addMemory({ namespace: service.namespace, type: 'semantic',
      content: '喜欢爵士钢琴', source: 'user_explicit_feedback', tags: ['person-relationship'], evidence: '{}' });
    writeSchema(service, { contributorIds: [contributor.id] });
    assert.deepEqual(schemaTexts(service), ['长期偏爱爵士钢琴。']);
  });
});

test('revoking a contributor stops the schema from being injected', async () => {
  await withService(async service => {
    const contributor = service.addMemory({ namespace: service.namespace, type: 'semantic',
      content: '喜欢爵士钢琴', source: 'user_explicit_feedback', tags: ['person-relationship'], evidence: '{}' });
    writeSchema(service, { contributorIds: [contributor.id] });
    revokeMemory(service.store, contributor.id);
    assert.deepEqual(schemaTexts(service), [], '来源被忘记后，图式不能再携带它的内容');
  });
});

test('narrowing a contributor to one conversation stops injection everywhere', async () => {
  await withService(async service => {
    const contributor = service.addMemory({ namespace: service.namespace, type: 'semantic',
      content: '喜欢爵士钢琴', source: 'user_explicit_feedback', tags: ['person-relationship'], evidence: '{}' });
    writeSchema(service, { contributorIds: [contributor.id] });
    service.store.update(contributor.id, { evidence: JSON.stringify({ policy: { onlyConversationId: 'conversation:tmp' } }) });
    assert.deepEqual(schemaTexts(service), [], '来源收窄后，namespace 级图式不再适用');
  });
});

test('a private contributor never keeps the schema alive', async () => {
  await withService(async service => {
    const contributor = service.addMemory({ namespace: service.namespace, type: 'semantic',
      content: '私下说过的事', source: 'user_explicit_feedback', tags: ['person-relationship'],
      evidence: JSON.stringify({ policy: { disclosure: 'private' } }) });
    writeSchema(service, { contributorIds: [contributor.id] });
    assert.deepEqual(schemaTexts(service), []);
  });
});

test('a deleted contributor stops injection', async () => {
  await withService(async service => {
    const contributor = service.addMemory({ namespace: service.namespace, type: 'semantic',
      content: '喜欢爵士钢琴', source: 'user_explicit_feedback', tags: ['person-relationship'], evidence: '{}' });
    writeSchema(service, { contributorIds: [contributor.id] });
    service.store.delete(contributor.id);
    assert.deepEqual(schemaTexts(service), []);
  });
});

test('a schema with no recorded provenance is not injected', async () => {
  await withService(async service => {
    writeSchema(service, { contributorIds: undefined, scope: undefined });
    assert.deepEqual(schemaTexts(service), [],
      '无法证明适用面的旧图式不得继续无限期注入；下一次蒸馏会重建带来源的图式');
  });
});

test('an explicitly revoked schema stays out', async () => {
  await withService(async service => {
    const contributor = service.addMemory({ namespace: service.namespace, type: 'semantic',
      content: '喜欢爵士钢琴', source: 'user_explicit_feedback', tags: ['person-relationship'], evidence: '{}' });
    const schema = writeSchema(service, { contributorIds: [contributor.id] });
    revokeMemory(service.store, schema.id);
    assert.deepEqual(schemaTexts(service), []);
    counter += 1;
    assert.ok(counter > 0);
  });
});
