import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from '../memory/MemoryService.js';
import { SQLiteMemoryStore } from '../memory/MemoryStore.js';
import { ConversationStore } from './ConversationStore.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { AgentLoop } from './AgentLoop.js';
import { PromptAssembler } from './PromptAssembler.js';
import { PresentationService } from './PresentationService.js';
import { PERSON_MEMORY_CAPABILITY, registerPersonMemoryTools, retrievePersonMemories } from './personMemory.js';

function harness(dbPath, chat) {
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  const memory = new MemoryService();
  memory.store = new SQLiteMemoryStore({ dbPath });
  memory.store.initialize();
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerPersonMemoryTools(tools, { getMemoryService: () => memory, conversationStore, registry });
  const runtime = new VirtualPersonRuntime({ registry, conversationStore,
    promptAssembler: new PromptAssembler(), agentLoop: new AgentLoop({ chat, toolRegistry: tools }),
    presentationService: new PresentationService(), capabilityResolver: () => [PERSON_MEMORY_CAPABILITY],
    retrieveMemories: input => retrievePersonMemories(memory, conversationStore, input),
    logger: { error() {}, warn() {} },
  }).initialize();
  return { registry, conversationStore, memory, tools, runtime,
    close() { runtime.shutdown(); memory.store.close(); } };
}

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-relationships-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.db');
}

function createPeople(h) {
  for (const id of ['a', 'b', 'c']) h.registry.createRadiohost({ id, displayName: id.toUpperCase(), voiceProfileId: `voice-${id}` });
}

function memoryCall(content, sourceQuote) {
  return { message: { role: 'assistant', content: '', tool_calls: [
    { id: 'remember', type: 'function', function: { name: 'remember_person_fact', arguments: JSON.stringify({ content, sourceQuote }) } },
  ] } };
}

test('A and B retain different relationships across rooms, restart and old-room archive; C never inherits them', async t => {
  const dbPath = temporary(t);
  const prompts = [];
  const chat = async messages => {
    const text = messages.at(-1).content;
    if (messages.at(-1).role === 'user' && text.startsWith('记住')) return memoryCall(text, text);
    prompts.push(messages[0].content);
    return { message: { role: 'assistant', content: '我们接着聊。' } };
  };
  let h = harness(dbPath, chat);
  createPeople(h);
  h.conversationStore.createRoom({ sessionId: 'one', memberIds: ['a'] });
  h.conversationStore.createRoom({ sessionId: 'two', memberIds: ['b'] });
  await h.runtime.handleTurn({ sessionId: 'one', requestId: 'r1', userText: '记住，你叫我小月亮，我们一起听 R&B', speak: false });
  await h.runtime.handleTurn({ sessionId: 'two', requestId: 'r2', userText: '记住，你叫我老铁，我们一起听 Rap', speak: false });
  const aNamespace = h.registry.get('a').memoryNamespace;
  h.close();
  h = harness(dbPath, chat);
  t.after(() => h.close());
  assert.equal(h.registry.get('a').memoryNamespace, aNamespace);
  h.conversationStore.updateRoom('one', { archived: true });
  h.conversationStore.updateRoom('two', { archived: true });
  h.conversationStore.createRoom({ sessionId: 'three', memberIds: ['a', 'b', 'c'] });
  prompts.length = 0;
  const result = await h.runtime.handleTurn({ sessionId: 'three', requestId: 'group', userText: '大家各自聊聊我们吧', speak: true });
  assert.equal(result.responses.length, 3);
  // 主持人 a 在多人计划里排最后：b、c 先说，a 收尾。
  assert.deepEqual(result.responses.map(response => response.presentation.voiceProfileId), ['voice-b', 'voice-c', 'voice-a']);
  assert.match(prompts[2], /小月亮/);
  assert.match(prompts[2], /R&B/);
  assert.doesNotMatch(prompts[2], /老铁|Rap/);
  assert.match(prompts[0], /老铁/);
  assert.match(prompts[0], /Rap/);
  assert.doesNotMatch(prompts[0], /小月亮|R&B/);
  assert.doesNotMatch(prompts[1], /小月亮|老铁|R&B|Rap/);
  assert.equal(h.conversationStore.listTurns('three', { visibleOnly: true }).filter(turn => turn.role === 'user').length, 1);
  const replay = await h.runtime.handleTurn({ sessionId: 'three', requestId: 'group', userText: '不能重复执行', speak: true });
  assert.deepEqual(replay, result);
  assert.equal(prompts.length, 3);
});

test('a silent member retains witnessed group events but a later invitee does not receive private old history as personal memory', async t => {
  const h = harness(temporary(t), async () => ({ message: { content: '听见了。' } }));
  t.after(() => h.close());
  createPeople(h);
  h.conversationStore.createRoom({ sessionId: 'group', memberIds: ['a', 'b'] });
  const result = await h.runtime.handleTurn({ sessionId: 'group', requestId: 'r', userText: '@A 今天一起听了那张蓝色专辑', speak: false });
  assert.equal(result.virtualPersonId, 'a');
  assert.match(JSON.stringify(h.conversationStore.recentEncounters('b')), /蓝色专辑/);
  h.conversationStore.addMember('group', 'c');
  assert.equal(h.conversationStore.recentEncounters('c').length, 0);
  assert.equal(h.conversationStore.recentEncounters('b').filter(turn => turn.role === 'user').length, 1);
});

test('temporary applicability and private disclosure do not erase the rest of a relationship', async t => {
  const h = harness(temporary(t), async () => ({ message: { content: '继续。' } }));
  t.after(() => h.close());
  createPeople(h);
  h.conversationStore.createRoom({ sessionId: 'private', memberIds: ['a'] });
  const remember = async (id, text) => {
    const round = h.conversationStore.beginRound({ sessionId: 'private', roundId: id, userText: text, responsePlan: ['a'] });
    return h.tools.execute('remember_person_fact', { content: text, sourceQuote: text }, {
      virtualPersonId: 'a', userText: text, userTurnId: round.userTurnId, sessionId: 'private',
    });
  };
  await remember('nickname', '你叫我小月亮');
  await remember('tonight', '今晚只听电子音乐');
  await remember('secret', '我准备辞职，别在群里提');
  const retrieve = (sessionId, isGroup) => retrievePersonMemories(h.memory, h.conversationStore, {
    virtualPersonId: 'a', namespace: 'radiohost:a', query: '你好', sessionId, isGroup,
  });
  assert.match(JSON.stringify(retrieve('private', false)), /电子音乐|辞职/);
  const newGroup = JSON.stringify(retrieve('another-group', true));
  assert.match(newGroup, /小月亮/);
  assert.doesNotMatch(newGroup, /电子音乐|辞职/);
  assert.match(JSON.stringify(retrieve('another-private', false)), /辞职/);
});

test('explicit remember only succeeds after durable writing; revoke removes facts and encounter fallbacks', async t => {
  const h = harness(temporary(t), async () => ({ message: { content: '继续。' } }));
  t.after(() => h.close());
  createPeople(h);
  h.conversationStore.createRoom({ sessionId: 'private', memberIds: ['a'] });
  const round = h.conversationStore.beginRound({ sessionId: 'private', roundId: 'memory-r', userText: '记住我叫小月亮', responsePlan: ['a'] });
  const context = { virtualPersonId: 'a', userText: '记住我叫小月亮', userTurnId: round.userTurnId, sessionId: 'private' };
  const saved = await h.tools.execute('remember_person_fact', { content: '用户叫小月亮', sourceQuote: '我叫小月亮' }, context);
  assert.equal(saved.ok, true);
  assert.equal(h.memory.store.getById(saved.facts.memoryId).namespace, 'radiohost:a');
  const invalid = await h.tools.execute('remember_person_fact', { content: '用户喜欢爵士', sourceQuote: '我喜欢爵士' }, context);
  assert.equal(invalid.ok, false);
  const revoked = await h.tools.execute('forget_person_memory', { memoryIds: [saved.facts.memoryId] }, { ...context, userText: '忘掉小月亮这个称呼' });
  assert.equal(revoked.ok, true);
  const later = retrievePersonMemories(h.memory, h.conversationStore, { virtualPersonId: 'a', namespace: 'radiohost:a', sessionId: 'new', query: '小月亮' });
  assert.doesNotMatch(JSON.stringify(later), /小月亮/);
  assert.equal(h.conversationStore.isTurnRevoked('a', { turnId: round.userTurnId }), true);
});

test('cancelling a group aborts a slow model and does not execute its late tool calls or start remaining speakers', async t => {
  let release;
  let called = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(temporary(t), async () => { called++; return gate; });
  t.after(() => h.close());
  createPeople(h);
  h.conversationStore.createRoom({ sessionId: 'group', memberIds: ['a', 'b', 'c'] });
  const pending = h.runtime.handleTurn({ sessionId: 'group', requestId: 'cancel', userText: '大家各自说说，记住我叫小月亮' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.runtime.cancel('group'), true);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(called, 1);
  release(memoryCall('用户叫小月亮', '我叫小月亮'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'radiohost:a' }).length, 0);
});

test('leaving and rejoining invalidates old model actions even within the same millisecond', async t => {
  let resume, reached;
  const ready = new Promise(resolve => { reached = resolve; });
  const h = harness(temporary(t), async messages => {
    if (messages.at(-1).role === 'user') {
      await new Promise(resolve => { resume = resolve; reached(); });
      return memoryCall('用户喜欢 R&B', '喜欢 R&B');
    }
    return { message: { content: '已经记住。' } };
  });
  t.after(() => h.close()); createPeople(h);
  h.conversationStore.now = () => 100;
  h.conversationStore.createRoom({ sessionId: 'room', memberIds: ['a', 'b'] });
  const running = h.runtime.handleTurn({ sessionId: 'room', requestId: 'late', userText: '@A 记住我喜欢 R&B' });
  await ready;
  h.conversationStore.removeMember('room', 'a'); h.conversationStore.addMember('room', 'a');
  resume();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.presentation.speak, false);
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'radiohost:a' }).length, 0);
});

test('explicit shared memory is quoted, durable for new people, and cannot revive after deletion', async t => {
  const h = harness(temporary(t), async () => ({ message: { content: '继续。' } }));
  t.after(() => h.close()); createPeople(h);
  const context = { virtualPersonId: 'a', userTurnId: 'shared-source', sessionId: 'room', userText: '告诉所有伙伴，我喜欢粤语歌' };
  const args = { content: '用户喜欢粤语歌', sourceQuote: context.userText };
  const saved = await h.tools.execute('remember_shared_fact', args, context);
  assert.equal(saved.ok, true);
  assert.equal(h.memory.store.getById(saved.facts.memoryId).namespace, 'station');
  assert.match(JSON.stringify(retrievePersonMemories(h.memory, h.conversationStore, {
    virtualPersonId: 'c', namespace: 'radiohost:c', sessionId: 'new-room', query: '你好', isGroup: true,
  })), /粤语歌/);
  const { revokeMemory } = await import('../memory/memoryProvenance.js');
  revokeMemory(h.memory.store, saved.facts.memoryId); h.memory.store.deleteExpired('station');
  const replay = await h.tools.execute('remember_shared_fact', args, context);
  assert.equal(replay.ok, false);
  const denied = await h.tools.execute('remember_shared_fact', args, { ...context, userText: '我只和你听粤语歌，保密' });
  assert.equal(denied.ok, false);
});

test('a newly invited person sees public room history but never private excerpts or old personal observations', async t => {
  const prompts = [];
  const h = harness(temporary(t), async messages => { prompts.push(messages); return { message: { content: '收到。' } }; });
  t.after(() => h.close()); createPeople(h);
  h.conversationStore.createRoom({ sessionId: 'room', memberIds: ['a'] });
  await h.runtime.handleTurn({ sessionId: 'room', requestId: 'secret', userText: '我准备辞职，只告诉你，别在群里提', speak: false });
  await h.runtime.handleTurn({ sessionId: 'room', requestId: 'public', userText: '今天听到了蓝色专辑', speak: false });
  h.conversationStore.addMember('room', 'b');
  await h.runtime.handleTurn({ sessionId: 'room', requestId: 'b-now', userText: '@B 你好', speak: false });
  const prompt = JSON.stringify(prompts.at(-1));
  assert.match(prompt, /蓝色专辑/); assert.doesNotMatch(prompt, /准备辞职/);
  assert.doesNotMatch(JSON.stringify(h.conversationStore.recentEncounters('b')), /蓝色专辑|准备辞职/);
});
