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
  const workdir = process.cwd();
  // 隔离：MemoryService 不传 dbPath 时会落到真实数据根 ~/.lunara，
  // 首次运行写入的撤销记录会永久拦截后续重跑（writeKey 是确定性的）。
  const previousDbPath = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = resolve(workdir, 'memory.db');
  const dbPath = resolve(workdir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  // 注意：node:test 的 after hook 按注册顺序（FIFO）执行，不是 LIFO！
  // 所以清理必须合并进单个 hook，按依赖顺序执行：关库 → 切走 → 删目录。
  // （在 POSIX 上 rm 打开中的文件也能成功，所以顺序错误从不在 mac 上暴露。）
  let memory;
  t.after(async () => {
    process.env.LUNARA_DB_PATH = previousDbPath;
    await memory?.shutdown?.();
    conversationStore.close(); registry.close();
    process.chdir(tmpdir());
    rmSync(workdir, { recursive: true, force: true });
  });
  registry.createRadiohost({ id: 'a', displayName: 'A', voiceProfileId: 'voice-a' });
  const person = registry.get('a');
  memory = new MemoryService(person.memoryNamespace);
  await memory.initialize();

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
