// personMemory.supersede.test.js — 新事实取代旧事实（improve-memory-retrieval-and-updates）。
//
// Run: node --test server/virtual-person/personMemory.supersede.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryService } from '../memory/MemoryService.js';
import { revokeMemory } from '../memory/memoryProvenance.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { RELATIONSHIP_MEMORY_BYTES, registerPersonMemoryTools, retrievePersonMemories } from './personMemory.js';

async function withTools(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-supersede-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  const registry = new VirtualPersonRegistry({ dbPath: join(dir, 'state.db') }).initialize();
  registry.createRadiohost({ id: 'a', displayName: 'A', voiceProfileId: 'voice-a' });
  const person = registry.get('a');
  const memory = new MemoryService(person.memoryNamespace);
  await memory.initialize();
  const tools = {};
  registerPersonMemoryTools({ register: (name, def) => { tools[name] = def; } },
    { getMemoryService: () => memory, conversationStore: { revokeObservation() {} }, registry });
  let turn = 0;
  const remember = (userText, args) => tools.remember_person_fact.handler(args,
    { virtualPersonId: 'a', sessionId: 'room', userText, userTurnId: `turn-${++turn}` });
  const relationships = () => retrievePersonMemories(memory, null, { namespace: person.memoryNamespace, virtualPersonId: 'a',
    sessionId: 'room', query: '周末去哪' }).filter(row => row.kind === 'relationship').map(row => row.content);
  try {
    const forget = (userText, args) => tools.forget_person_memory.handler(args,
      { virtualPersonId: 'a', sessionId: 'room', userText, userTurnId: `turn-${++turn}` });
    await run({ memory, remember, relationships, person, forget });
  } finally {
    await memory.shutdown();
    registry.close();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('新事实取代旧事实后旧事实不再注入；撤回新事实旧事实恢复', async () => {
  await withTools(async ({ memory, remember, relationships }) => {
    const old = remember('我住在上海徐汇', { content: '用户住在上海徐汇', sourceQuote: '我住在上海徐汇' });
    assert.equal(old.ok, true);
    const moved = remember('我搬到杭州了', { content: '用户搬到杭州', sourceQuote: '我搬到杭州了',
      replacesMemoryIds: [old.facts.memoryId] });
    assert.equal(moved.ok, true, moved.modelContext);
    assert.deepEqual(relationships(), ['用户搬到杭州']);

    revokeMemory(memory.store, moved.facts.memoryId);
    assert.deepEqual(relationships(), ['用户住在上海徐汇']);
  });
});

test('取代的 id 不是生效的关系记忆时整条拒绝，什么都不写', async () => {
  await withTools(async ({ memory, remember, relationships }) => {
    const old = remember('我住在上海徐汇', { content: '用户住在上海徐汇', sourceQuote: '我住在上海徐汇' });
    revokeMemory(memory.store, old.facts.memoryId);
    for (const ids of [[old.facts.memoryId], [99999]]) {
      const result = remember('我搬到杭州了', { content: '用户搬到杭州', sourceQuote: '我搬到杭州了', replacesMemoryIds: ids });
      assert.equal(result.ok, false);
      assert.equal(result.code, 'MEMORY_REPLACE_INVALID');
    }
    assert.deepEqual(relationships(), []);
  });
});

test('关系记忆按最近更新在字节预算内注入，超出预算的最旧事实不再出现', async () => {
  await withTools(async ({ remember, relationships }) => {
    const filler = '这是一条很长的说明'.repeat(30);
    const count = Math.ceil(RELATIONSHIP_MEMORY_BYTES / Buffer.byteLength(filler)) + 2;
    for (let i = 0; i < count; i += 1) {
      assert.equal(remember(`我收藏的第${i}张黑胶`, { content: `用户收藏第${i}张黑胶：${filler}`, sourceQuote: `我收藏的第${i}张黑胶` }).ok, true);
    }
    const injected = relationships();
    const perLine = Buffer.byteLength(`用户收藏第10张黑胶：${filler}`) + 100;
    assert.equal(injected.length, Math.floor(RELATIONSHIP_MEMORY_BYTES / perLine));
    assert.ok(!injected.some(text => text.startsWith('用户收藏第0张黑胶')));
    assert.ok(injected[0].startsWith(`用户收藏第${count - 1}张黑胶`), '最新的在前');
  });
});

test('短事实远超 30 条也全部注入', async () => {
  await withTools(async ({ remember, relationships }) => {
    for (let i = 0; i < 60; i += 1) remember(`我收藏的第${i}张黑胶`, { content: `用户收藏第${i}张黑胶`, sourceQuote: `我收藏的第${i}张黑胶` });
    assert.equal(relationships().length, 60);
  });
});

test('用户只说忘掉新说法时旧说法不复活；说旧说法仍成立才恢复', async () => {
  await withTools(async ({ remember, relationships, forget }) => {
    const old = remember('我住在上海徐汇', { content: '用户住在上海徐汇', sourceQuote: '我住在上海徐汇' });
    const moved = remember('我搬到杭州了', { content: '用户搬到杭州', sourceQuote: '我搬到杭州了',
      replacesMemoryIds: [old.facts.memoryId] });
    const forgotten = forget('把我搬家这件事忘掉吧', { memoryIds: [moved.facts.memoryId] });
    assert.equal(forgotten.ok, true);
    assert.deepEqual(forgotten.facts.restoredMemoryIds, []);
    assert.match(forgotten.modelContext, /旧说法仍保持失效/);
    assert.deepEqual(relationships(), [], '忘掉不是“旧地址又成立了”');

    const restored = forget('撤回，我其实没搬，还住徐汇', { memoryIds: [moved.facts.memoryId], restoreReplaced: true });
    assert.deepEqual(restored.facts.restoredMemoryIds, [old.facts.memoryId]);
    assert.match(restored.modelContext, /已恢复/);
    assert.deepEqual(relationships(), ['用户住在上海徐汇']);
  });
});
