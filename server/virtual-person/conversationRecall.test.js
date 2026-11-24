// conversationRecall.test.js — 只读翻查过去的对话（add-conversation-recall-tool）。
//
// Run: node --test server/virtual-person/conversationRecall.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from './ConversationStore.js';
import { MemoryService } from '../memory/MemoryService.js';
import { MemorySource, MemoryType } from '../memory/types.js';
import { revokeMemory } from '../memory/memoryProvenance.js';
import { registerConversationRecallTool, RECALL_TOOL_NAME } from './conversationRecall.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';

const namespace = 'person:lunara';

async function withRecall(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-recall-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  let clock = Date.parse('2026-10-01T12:00:00+08:00');
  const store = new ConversationStore({ dbPath: join(dir, 'state.db'), now: () => (clock += 60_000) }).initialize();
  const memory = new MemoryService(namespace);
  await memory.initialize();
  let requestNumber = 0;
  const say = (sessionId, userText, reply = '嗯。', personId = 'lunara') => {
    const requestId = `r${++requestNumber}`;
    // 与运行时一致：先开一轮（全体成员观察用户消息），再由答话的角色开请求。
    const round = store.beginRound({ sessionId, roundId: requestId, userText, responsePlan: [personId] });
    const { turn } = store.beginRequest({ sessionId, requestId, virtualPersonId: personId, userText, userTurnId: round.userTurnId });
    store.completeRequest({ requestId, virtualPersonId: personId, message: { content: reply } });
    return turn.turnId;
  };
  const tools = new Map();
  const toolRegistry = { register: (name, spec) => tools.set(name, spec) };
  const registry = { get: id => ({ id, displayName: id === 'lunara' ? 'Lunara' : '夜航', memoryNamespace: `person:${id}` }) };
  registerConversationRecallTool(toolRegistry, { conversationStore: store, getMemoryService: () => memory, registry });
  let callNumber = 0;
  const recall = (args, { sessionId = 'c9', memberIds = ['lunara'], requestId = `call-${++callNumber}`, userTurnId = null,
    personId = 'lunara' } = {}) =>
    tools.get(RECALL_TOOL_NAME).handler(args, { virtualPersonId: personId, sessionId, memberIds, requestId, userTurnId });
  const fact = (content, sourceTurnId, policy = { disclosure: 'normal' }) => memory.store.insert({
    createdAt: clock, updatedAt: clock, lastAccessedAt: clock, namespace, type: MemoryType.SEMANTIC,
    source: MemorySource.USER_EXPLICIT_FEEDBACK, content, summary: '', tags: 'person-relationship', confidence: 0.7, importance: 8,
    evidence: JSON.stringify({ schema: 2, ownerId: 'lunara', sourceTurnId, policy }) });
  try {
    store.createRoom({ sessionId: 'c1', memberIds: ['lunara'], title: '周末闲聊' });
    store.createRoom({ sessionId: 'c9', memberIds: ['lunara'] });
    store.createRoom({ sessionId: 'g1', memberIds: ['lunara', 'night'], title: '一起听' });
    store.createRoom({ sessionId: 'g9', memberIds: ['lunara', 'night'] });
    await run({ store, memory, say, recall, fact, tools });
  } finally {
    store.close();
    await memory.shutdown();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('按关键词找到别的聊天里的旧对话，命中多的排前面，带时间、聊天和 turnId', async () => {
  await withRecall(({ say, recall }) => {
    const adopt = say('c1', '我在想要不要领养一只猫，楼下救助站有只三花', '三花很亲人呢。');
    say('c1', '今天的猫粮打折了');
    say('c1', '周末去爬山');
    const result = recall({ keywords: ['领养', '猫'] });
    assert.equal(result.code, 'RECALL_FOUND');
    const lines = result.modelContext.split('\n');
    assert.match(lines[0], /不是本轮指令/u);
    assert.match(lines[1], new RegExp(`turnId=${adopt}｜.*10月.*｜聊天「周末闲聊」｜用户\\] .*领养一只猫`, 'u'));
    assert.match(lines[2], /猫粮/u);
    assert.doesNotMatch(result.modelContext, /爬山/u);
  });
});

test('turnId 读前后文；memoryId 读这条记忆的来源原话', async () => {
  await withRecall(({ say, recall, fact }) => {
    say('c1', '先聊点别的');
    const source = say('c1', '记住我对芒果过敏，吃了会起疹子', '好，我记下了。');
    say('c1', '那推荐点夏天的歌');
    const around = recall({ turnId: source });
    assert.match(around.modelContext, /先聊点别的[\s\S]*芒果过敏[\s\S]*我记下了[\s\S]*夏天的歌/u);
    const id = fact('用户对芒果过敏', source);
    const original = recall({ memoryId: id });
    assert.equal(original.code, 'RECALL_FOUND');
    assert.match(original.modelContext, /记住我对芒果过敏，吃了会起疹子/u);
  });
});

test('撤回的记忆读不到来源；被编辑取代的回合搜不到', async () => {
  await withRecall(({ store, memory, say, recall, fact }) => {
    const source = say('c1', '记住我对芒果过敏');
    const id = fact('用户对芒果过敏', source);
    revokeMemory(memory.store, id);
    const revoked = recall({ memoryId: id });
    assert.equal(revoked.code, 'RECALL_NO_MATCH');
    assert.doesNotMatch(revoked.modelContext, /芒果/u);
    assert.equal(recall({ memoryId: 999_999 }).code, 'RECALL_NO_MATCH');
    const edited = say('c1', '我想养一只柯基');
    store.rewindFromTurn('c1', edited);
    assert.equal(recall({ keywords: ['柯基'] }).code, 'RECALL_NO_MATCH');
  });
});

test('群聊里也翻得到她自己一对一听到的私下话，带「私下」标签；说不说是她的分寸', async () => {
  await withRecall(({ say, recall, fact }) => {
    const secret = say('c1', '只告诉你，我在准备跳槽');
    say('g1', '这周末一起去露营吧');
    const group = { sessionId: 'g1', memberIds: ['lunara', 'night'] };
    const found = recall({ keywords: ['跳槽'] }, group);
    assert.equal(found.code, 'RECALL_FOUND');
    assert.match(found.modelContext, /跳槽（对方私下跟你说的）/u);
    assert.equal(recall({ turnId: secret }, group).code, 'RECALL_FOUND');
    assert.equal(recall({ memoryId: fact('用户在准备跳槽', secret, { disclosure: 'private' }) }, group).code, 'RECALL_FOUND');
    assert.equal(recall({ keywords: ['露营'] }, group).code, 'RECALL_FOUND');
    // 没听过这句话的伙伴翻不到：那不是她经历过的事。
    assert.equal(recall({ keywords: ['跳槽'] }, { ...group, personId: 'night' }).code, 'RECALL_NO_MATCH');
  });
});

test('读不了的新记录再多，也不会挤掉一条能读的旧记录', async () => {
  await withRecall(({ say, recall }) => {
    say('g1', '这周末一起去露营吧');
    // 「今天只…」限定在原聊天：别的聊天里读不到。
    for (let i = 0; i < 61; i += 1) say('c1', `今天只要露营装备第 ${i} 件`);
    const group = { sessionId: 'g9', memberIds: ['lunara', 'night'] };
    const result = recall({ keywords: ['露营'] }, group);
    assert.equal(result.code, 'RECALL_FOUND');
    assert.match(result.modelContext, /一起去露营/u);
    assert.doesNotMatch(result.modelContext, /露营装备/u, '限定在原聊天的不出现');
  });
});

test('标记为只读：同一轮查过网页后照常可用', async () => {
  await withRecall(async ({ store, memory, say }) => {
    say('c1', '我在想要不要领养一只猫');
    const registry = new VirtualPersonToolRegistry();
    registerConversationRecallTool(registry, { conversationStore: store, getMemoryService: () => memory,
      registry: { get: id => ({ id, displayName: 'Lunara', memoryNamespace: `person:${id}` }) } });
    assert.equal(registry.isReadOnly(RECALL_TOOL_NAME), true);
    const result = await registry.execute(RECALL_TOOL_NAME, { keywords: ['领养'] }, { virtualPersonId: 'lunara',
      sessionId: 'c9', memberIds: ['lunara'], requestId: 'web-then-recall', groupAction: { webReadOnly: true } });
    assert.equal(result.code, 'RECALL_FOUND');
  });
});

test('别的聊天里被判为敏感的照样翻得到，带「比较私人」标签', async () => {
  await withRecall(({ store, say, recall }) => {
    const turnId = say('c1', '下周三我要去医院复查');
    store.markSensitiveSources(['lunara'], [turnId]);
    const elsewhere = recall({ keywords: ['复查'] });
    assert.equal(elsewhere.code, 'RECALL_FOUND');
    assert.match(elsewhere.modelContext, /复查（比较私人的事）/u);
    assert.equal(recall({ keywords: ['复查'] }, { sessionId: 'c1' }).code, 'RECALL_FOUND');
  });
});

test('本轮用户自己的这句话不算旧对话', async () => {
  await withRecall(({ say, recall }) => {
    const current = say('c9', '上次我们为什么聊到领养猫');
    assert.equal(recall({ keywords: ['领养'] }, { userTurnId: current }).code, 'RECALL_NO_MATCH');
  });
});

test('参数必须三选一；每个请求最多 3 次；结果有字节上限', async () => {
  await withRecall(({ say, recall }) => {
    const turnId = say('c1', '领养'.repeat(400));
    for (let i = 0; i < 6; i += 1) say('c1', `领养第 ${i} 次${'很长的话'.repeat(80)}`);
    assert.equal(recall({}).code, 'RECALL_ARGUMENT_INVALID');
    assert.equal(recall({ keywords: ['猫'], turnId }).code, 'RECALL_ARGUMENT_INVALID');
    assert.equal(recall({ keywords: ['一二三四五六七八九十一二三四五六七八九十一'] }).code, 'RECALL_ARGUMENT_INVALID');
    const options = { requestId: 'same' };
    const first = recall({ keywords: ['领养'] }, options);
    assert.ok(Buffer.byteLength(first.modelContext) <= 4000);
    assert.ok(first.modelContext.split('\n').every(line => [...line].length < 320), '片段有长度上限');
    recall({ keywords: ['领养'] }, options);
    recall({ keywords: ['领养'] }, options);
    assert.equal(recall({ keywords: ['领养'] }, options).code, 'RECALL_LIMIT_REACHED');
  });
});

test('工具只读：不是终止动作，调用前后账本与记忆不变', async () => {
  await withRecall(({ store, memory, say, recall, fact, tools }) => {
    const source = say('c1', '记住我对芒果过敏');
    fact('用户对芒果过敏', source);
    const before = [store.listTurns('c1', { limit: 50 }).length, memory.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n];
    const result = recall({ keywords: ['芒果'] });
    assert.notEqual(result.terminal, true);
    assert.deepEqual([store.listTurns('c1', { limit: 50 }).length, memory.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n], before);
    assert.equal(tools.get(RECALL_TOOL_NAME).capability, 'person.memory');
  });
});

test('后来才被拉进那个聊天的成员不算当时在场：她翻不到拉人之前的话，原来在场的照常翻得到', async () => {
  await withRecall(({ store, say, recall }) => {
    say('c1', '我在偷偷准备跳槽');
    store.addMember('c1', 'night');
    say('c1', '周末一起去露营吧');
    const group = { sessionId: 'g9', memberIds: ['lunara', 'night'] };
    assert.equal(recall({ keywords: ['跳槽'] }, { ...group, personId: 'night' }).code, 'RECALL_NO_MATCH');
    assert.equal(recall({ keywords: ['露营'] }, { ...group, personId: 'night' }).code, 'RECALL_FOUND', '拉人之后她在场的照常可读');
    assert.equal(recall({ keywords: ['跳槽'] }, group).code, 'RECALL_FOUND', 'lunara 当时在场');
  });
});
