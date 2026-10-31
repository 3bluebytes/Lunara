import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryService } from '../memory/MemoryService.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { ConversationStore } from './ConversationStore.js';
import { registerPersonMemoryTools } from './personMemory.js';
import { retrieveExpressionPreferences } from '../program/narrationContext.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-expression-pref-')));

test('an expression correction persists with its quote and reaches narration retrieval until revoked', async t => {
  const dbPath = resolve(process.cwd(), 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  t.after(() => { conversationStore.close(); registry.close(); rmSync(process.cwd(), { recursive: true, force: true }); });
  registry.createRadiohost({ id: 'a', displayName: 'A', voiceProfileId: 'voice-a' });
  const person = registry.get('a');
  const memory = new MemoryService(person.memoryNamespace);
  await memory.initialize();
  t.after(() => memory.shutdown());

  const changed = [];
  const registered = {};
  registerPersonMemoryTools({ register: (name, def) => { registered[name] = def; } }, {
    getMemoryService: () => memory, conversationStore, registry,
    onMemoryChanged: event => changed.push(event),
  });
  const context = { virtualPersonId: 'a', sessionId: 'room', userText: '你介绍歌的时候不用每次都在最后一句提点我，全部内容都是介绍歌是被允许的',
    userTurnId: 'turn-1' };
  const saved = await registered.remember_person_fact.handler({
    content: '介绍歌时不要每首都以关照听众收尾，允许自然停在歌本身。',
    sourceQuote: '不用每次都在最后一句提点我', kind: 'expression',
  }, context);
  assert.equal(saved.ok, true, saved.modelContext || 'expression memory should save');
  assert.deepEqual(changed, [{ sessionId: 'room', affectsNarration: true }]);

  const retrieved = retrieveExpressionPreferences(memory, { namespace: person.memoryNamespace, sessionId: 'room' });
  assert.equal(retrieved.length, 1);
  assert.match(retrieved[0].content, /关照听众/u);

  // 表达偏好不能与关系事实、歌曲反馈混在一起：其它记忆不应进入表达偏好检索。
  const relationship = await registered.remember_person_fact.handler({
    content: '用户叫小月亮', sourceQuote: '我叫小月亮',
  }, { ...context, userTurnId: 'turn-2', userText: '我叫小月亮' });
  assert.equal(relationship.ok, true);
  // 关系事实不影响串词，不触发重备；表达偏好检索也不收它。
  assert.deepEqual(changed, [
    { sessionId: 'room', affectsNarration: true },
    { sessionId: 'room', affectsNarration: false },
  ]);
  assert.equal(retrieveExpressionPreferences(memory, { namespace: person.memoryNamespace, sessionId: 'room' }).length, 1);

  // 内容兜底：机制上线前的旧纠正没有 expression 标签，也能被识别为表达偏好。
  const legacy = await registered.remember_person_fact.handler({
    content: '介绍歌不用每次都在结尾提点我，可以老实讲歌。',
    sourceQuote: '不用每次都在结尾提点我',
  }, { ...context, userTurnId: 'turn-3', userText: '介绍歌不用每次都在结尾提点我' });
  assert.equal(legacy.ok, true);
  assert.equal(retrieveExpressionPreferences(memory, { namespace: person.memoryNamespace, sessionId: 'room' }).length, 2);

  const forget = await registered.forget_person_memory.handler(
    { memoryIds: [Number(saved.facts?.memoryId || saved.memoryId || retrieved[0].id)] },
    { ...context, userText: '忘掉刚才那条表达要求' });
  assert.equal(forget.ok, true, forget.modelContext || 'revoke should succeed');
  assert.equal(retrieveExpressionPreferences(memory, { namespace: person.memoryNamespace, sessionId: 'room' }).length, 1);
  // 撤回表达偏好同样需要让串词失效；撤回普通事实则不需要。
  assert.deepEqual(changed[changed.length - 1], { sessionId: 'room', affectsNarration: true });
});
