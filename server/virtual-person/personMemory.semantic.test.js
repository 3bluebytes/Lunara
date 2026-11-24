// personMemory.semantic.test.js — 超出预算的关系事实经语义召回进入提示（add-local-semantic-memory-recall）。
//
// Run: node --test server/virtual-person/personMemory.semantic.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryService } from '../memory/MemoryService.js';
import { MemorySource, MemoryType } from '../memory/types.js';
import { revokeMemory } from '../memory/memoryProvenance.js';
import { retrieveMemoriesWithRecall } from './createVirtualPersonRuntimeComposition.js';

async function withMemory(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-semantic-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  const namespace = 'radiohost:a';
  const memory = new MemoryService(namespace);
  await memory.initialize();
  let clock = 1_000;
  const fact = content => memory.store.insert({
    createdAt: ++clock, updatedAt: clock, lastAccessedAt: clock,
    namespace, type: MemoryType.SEMANTIC, source: MemorySource.USER_EXPLICIT_FEEDBACK, content, summary: '',
    tags: 'person-relationship', confidence: 0.7, importance: 8,
    evidence: JSON.stringify({ schema: 2, ownerId: 'a', policy: { disclosure: 'normal' } }),
  });
  const calls = [];
  // 假语义召回：记下被问到的候选，按 pick 规则提名。
  const semanticMemory = pick => ({
    available: () => true,
    async recall({ rows, query }) {
      calls.push({ ids: rows.map(row => row.id), query });
      return pick(rows);
    },
  });
  const retrieve = (semantic, input = {}) => retrieveMemoriesWithRecall(() => memory, semantic,
    { namespace, virtualPersonId: 'a', sessionId: 'c2', query: '天好热，给我推荐点夏天的水果吧', ...input }, null);
  const relationshipContents = rows => rows.filter(row => row.kind === 'relationship').map(row => row.content);
  try {
    await run({ memory, fact, calls, semanticMemory, retrieve, relationshipContents });
  } finally {
    await memory.shutdown();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const vinyls = (fact, count) => { for (let i = 0; i < count; i += 1) fact(`用户收藏了第 ${i} 张黑胶唱片，是一张很少见的日版首版，封套保存得很好`); };

test('超出预算的旧事实经语义召回进入关系记忆', async () => {
  await withMemory(async ({ fact, calls, semanticMemory, retrieve, relationshipContents }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(fact, 130);
    const without = relationshipContents(await retrieve(null));
    assert.ok(!without.includes('用户对芒果过敏'), '没有语义召回时想不起来');
    const rows = await retrieve(semanticMemory(rows => rows.filter(row => row.content.includes('芒果')).map(row => row.id)));
    assert.ok(relationshipContents(rows).includes('用户对芒果过敏'));
    assert.ok(calls[0].ids.includes(mango), '候选是超出预算的事实');
    assert.equal(calls[0].query, '天好热，给我推荐点夏天的水果吧');
  });
});

test('事实都在预算内时不调用语义召回', async () => {
  await withMemory(async ({ fact, calls, semanticMemory, retrieve, relationshipContents }) => {
    fact('用户对芒果过敏');
    vinyls(fact, 10);
    const rows = await retrieve(semanticMemory(() => []));
    assert.equal(calls.length, 0);
    assert.ok(relationshipContents(rows).includes('用户对芒果过敏'));
  });
});

test('提名不能绕过过滤：已撤回或不在候选里的 id 被忽略', async () => {
  await withMemory(async ({ memory, fact, semanticMemory, retrieve, relationshipContents }) => {
    const mango = fact('用户对芒果过敏');
    const secret = fact('用户不喝酒');
    vinyls(fact, 130);
    revokeMemory(memory.store, secret);
    const injected = relationshipContents(await retrieve(semanticMemory(() => [secret, mango, 999_999])));
    assert.ok(injected.includes('用户对芒果过敏'));
    assert.ok(!injected.includes('用户不喝酒'));
    assert.equal(injected.filter(content => content === '用户对芒果过敏').length, 1);
  });
});

test('召回期间撤回的事实不注入；库没变过时关系事实只检索一次', async () => {
  await withMemory(async ({ memory, fact, retrieve, relationshipContents }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(fact, 130);
    let searches = 0;
    const search = memory.store.search.bind(memory.store);
    memory.store.search = options => {
      if (options?.sources?.includes('manual_seed')) searches += 1;
      return search(options);
    };
    const nominate = { available: () => true, recall: async ({ rows }) => rows.filter(row => row.id === mango).map(row => row.id) };
    assert.ok(relationshipContents(await retrieve(nominate)).includes('用户对芒果过敏'));
    assert.equal(searches, 1, '库没变过就复用召回前的关系事实');
    const revoking = { available: () => true,
      recall: async ({ rows }) => { revokeMemory(memory.store, mango); return rows.filter(row => row.id === mango).map(row => row.id); } };
    assert.ok(!relationshipContents(await retrieve(revoking)).includes('用户对芒果过敏'));
  });
});
