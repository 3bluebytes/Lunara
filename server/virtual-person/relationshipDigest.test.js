// relationshipDigest.test.js — 关系记忆目录：后台整理与注入前重验（add-relationship-memory-digest）。
//
// Run: node --test server/virtual-person/relationshipDigest.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryService } from '../memory/MemoryService.js';
import { MemorySource, MemoryType } from '../memory/types.js';
import { revokeMemory } from '../memory/memoryProvenance.js';
import { readRelationshipDigest, retrievePersonMemories } from './personMemory.js';
import { RelationshipDigestService } from './relationshipDigest.js';
import { PromptAssembler } from './PromptAssembler.js';

const namespace = 'radiohost:a';

async function withDigest(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-digest-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  const memory = new MemoryService(namespace);
  await memory.initialize();
  let clock = 1_000;
  const fact = (content, policy = { disclosure: 'normal' }) => memory.store.insert({
    createdAt: ++clock, updatedAt: clock, lastAccessedAt: clock,
    namespace, type: MemoryType.SEMANTIC, source: MemorySource.USER_EXPLICIT_FEEDBACK, content, summary: '',
    tags: 'person-relationship', confidence: 0.7, importance: 8,
    evidence: JSON.stringify({ schema: 2, ownerId: 'a', policy }),
  });
  const vinyls = count => { for (let i = 0; i < count; i += 1) fact(`用户收藏了第 ${i} 张黑胶唱片，是一张很少见的日版首版，封套保存得很好`); };
  const prompts = [];
  let reply = () => ({ entries: [] });
  const llm = {
    async askText(prompt) {
      prompts.push(prompt);
      const value = reply(prompt);
      if (value instanceof Error) throw value;
      return JSON.stringify(value);
    },
  };
  const service = new RelationshipDigestService({ memoryTarget: async () => ({ service: memory, namespace }), llm, logger: { warn() {} } });
  const offeredIds = prompt => [...prompt.matchAll(/"memoryId":(\d+)/g)].map(match => Number(match[1]));
  const retrieve = (input = {}) => retrievePersonMemories(memory, null,
    { namespace, virtualPersonId: 'a', sessionId: 'c2', query: '天好热，给我推荐点夏天的水果吧', ...input });
  const digestOf = rows => rows.filter(row => row.kind === 'digest');
  try {
    await run({ memory, fact, vinyls, prompts, service, offeredIds, retrieve, digestOf, setReply: fn => { reply = fn; } });
  } finally {
    await memory.shutdown();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('超出预算的旧事实被整理进目录，并注入提示', async () => {
  await withDigest(async ({ fact, vinyls, prompts, service, offeredIds, retrieve, digestOf, setReply }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    assert.equal(digestOf(retrieve()).length, 0, '整理前没有目录');
    setReply(prompt => ({ entries: [
      { topic: '饮食禁忌', text: '对芒果过敏', memoryIds: [mango] },
      { topic: '黑胶收藏', text: '收藏了许多日版首版黑胶', memoryIds: offeredIds(prompt).filter(id => id !== mango) },
    ] }));
    const result = await service.refresh('a');
    assert.equal(result.code, 'UPDATED');
    assert.ok(offeredIds(prompts[0]).includes(mango), '交给模型的是超出预算的事实');
    const digest = digestOf(retrieve());
    assert.deepEqual(digest.map(item => item.topic), ['饮食禁忌', '黑胶收藏']);
    assert.deepEqual(digest[0].memoryIds, [mango]);
    const text = new PromptAssembler().assemble({ entity: { id: 'a', displayName: 'A' }, memories: retrieve() });
    assert.match(text, /更早关系记忆的整理目录/u);
    assert.match(text, new RegExp(`饮食禁忌｜来源 memoryId=${mango}\\] 对芒果过敏`, 'u'));
    assert.match(text, /不是用户原话/u);
  });
});

test('没有新的待整理事实时不调用模型；模型没收进条目的事实也不反复重发', async () => {
  await withDigest(async ({ fact, vinyls, prompts, service, setReply }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    setReply(() => ({ entries: [{ topic: '饮食禁忌', text: '对芒果过敏', memoryIds: [mango] }] }));
    await service.refresh('a');
    assert.equal(prompts.length, 1);
    assert.equal((await service.refresh('a')).code, 'UP_TO_DATE');
    assert.equal(prompts.length, 1, '第二次检查不调模型');
  });
});

test('事实都在预算内时不调用模型', async () => {
  await withDigest(async ({ fact, prompts, service }) => {
    fact('用户对芒果过敏');
    assert.equal((await service.refresh('a')).code, 'UP_TO_DATE');
    assert.equal(prompts.length, 0);
  });
});

test('编造的或不是交给它的 id 被丢掉，没有合法来源的条目不存', async () => {
  await withDigest(async ({ memory, fact, vinyls, service, setReply }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    const newest = fact('用户最近搬到了杭州'); // 在预算内，不是交给模型的事实
    setReply(() => ({ entries: [
      { topic: '饮食禁忌', text: '对芒果过敏', memoryIds: [mango, 999_999] },
      { topic: '住处', text: '搬到了杭州', memoryIds: [newest] },
      { topic: '编造', text: '喜欢爬山', memoryIds: [123_456] },
    ] }));
    await service.refresh('a');
    const { entries } = readRelationshipDigest(memory, namespace);
    assert.deepEqual(entries.map(entry => [entry.topic, entry.memoryIds]), [['饮食禁忌', [mango]]]);
  });
});

test('保密事实与普通事实混在一条时整条不存', async () => {
  await withDigest(async ({ memory, fact, vinyls, service, setReply }) => {
    const secret = fact('用户在准备跳槽', { disclosure: 'private' });
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    setReply(() => ({ entries: [{ topic: '近况', text: '在准备跳槽，对芒果过敏', memoryIds: [secret, mango] }] }));
    await service.refresh('a');
    assert.equal(readRelationshipDigest(memory, namespace).entries.length, 0);
  });
});

test('保密条目一对一和群聊都注入，并标着是私下说的', async () => {
  await withDigest(async ({ fact, vinyls, service, retrieve, digestOf, setReply }) => {
    const secret = fact('用户在准备跳槽', { disclosure: 'private' });
    vinyls(130);
    setReply(() => ({ entries: [{ topic: '工作', text: '在准备跳槽', memoryIds: [secret] }] }));
    await service.refresh('a');
    assert.equal(digestOf(retrieve()).length, 1);
    const group = digestOf(retrieve({ isGroup: true }));
    assert.equal(group.length, 1);
    assert.match(group[0].label, /私下跟你说的/);
  });
});

test('来源被撤回后条目不再注入，下一次检查不调模型就把它删掉', async () => {
  await withDigest(async ({ memory, fact, vinyls, prompts, service, retrieve, digestOf, setReply }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    setReply(() => ({ entries: [{ topic: '饮食禁忌', text: '对芒果过敏', memoryIds: [mango] }] }));
    await service.refresh('a');
    revokeMemory(memory.store, mango);
    assert.equal(digestOf(retrieve()).length, 0, '撤回后立即不注入');
    const calls = prompts.length;
    assert.equal((await service.refresh('a')).code, 'CLEANED');
    assert.equal(prompts.length, calls, '清理不调模型');
    assert.ok(!JSON.stringify(readRelationshipDigest(memory, namespace)).includes('芒果'), '目录行里不再留着复述');
  });
});

test('模型失败时保留旧目录', async () => {
  await withDigest(async ({ memory, fact, vinyls, service, setReply }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    setReply(() => ({ entries: [{ topic: '饮食禁忌', text: '对芒果过敏', memoryIds: [mango] }] }));
    await service.refresh('a');
    vinyls(10); // 新事实把更多旧事实挤出预算
    setReply(() => new Error('provider down'));
    assert.equal((await service.refresh('a')).code, 'DIGEST_LLM_FAILED');
    assert.deepEqual(readRelationshipDigest(memory, namespace).entries.map(entry => entry.topic), ['饮食禁忌']);
  });
});

test('模型漏掉的旧条目原样保留', async () => {
  await withDigest(async ({ memory, fact, vinyls, service, setReply }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    setReply(() => ({ entries: [{ topic: '饮食禁忌', text: '对芒果过敏', memoryIds: [mango] }] }));
    await service.refresh('a');
    vinyls(10);
    setReply(prompt => ({ entries: [{ topic: '黑胶收藏', text: '收藏了许多日版首版黑胶',
      memoryIds: [...prompt.matchAll(/"memoryId":(\d+)/g)].map(match => Number(match[1])) }] }));
    await service.refresh('a');
    assert.deepEqual(readRelationshipDigest(memory, namespace).entries.map(entry => entry.topic), ['黑胶收藏', '饮食禁忌']);
  });
});

test('来源都在常驻关系记忆里时不重复注入；本轮语义召回不改变目录；目录行本身不被按原话检索取回', async () => {
  await withDigest(async ({ memory, fact, vinyls, service, retrieve, digestOf, setReply }) => {
    const mango = fact('用户对芒果过敏');
    vinyls(130);
    setReply(() => ({ entries: [{ topic: '饮食禁忌', text: '对芒果过敏', memoryIds: [mango] }] }));
    await service.refresh('a');
    // 语义召回按本轮原话变化；目录在系统提示里，不能跟着它每轮增减（align-context-compaction-and-cache）。
    assert.deepEqual(digestOf(retrieve({ semanticRecall: [mango] })), digestOf(retrieve()));
    assert.equal(digestOf(retrieve()).length, 1);
    const recalled = retrieve({ semanticRecall: [mango] }).filter(item => item.kind === 'relationship' && item.recalled);
    assert.deepEqual(recalled.map(item => item.id), [mango]);
    assert.ok(!retrieve().some(item => item.recalled));
    const row = readRelationshipDigest(memory, namespace).row;
    assert.ok(!retrieve({ query: '关系记忆目录' }).some(item => item.id === row.id && item.kind !== 'digest'));
  });
});

test('目录满了被截掉的条目记为已交过，不在每次检查时重发', async () => {
  await withDigest(async ({ fact, vinyls, prompts, service, setReply }) => {
    for (let i = 0; i < 40; i += 1) fact(`用户第 ${i} 件很早说过的小事`);
    vinyls(130);
    setReply(prompt => ({ entries: [...prompt.matchAll(/"memoryId":(\d+)/g)].map((match, i) =>
      ({ topic: `主题${i}`, text: '一句很长的复述'.repeat(10), memoryIds: [Number(match[1])] })) }));
    await service.refresh('a');
    assert.equal(prompts.length, 1);
    assert.equal((await service.refresh('a')).code, 'UP_TO_DATE');
    assert.equal(prompts.length, 1);
  });
});
