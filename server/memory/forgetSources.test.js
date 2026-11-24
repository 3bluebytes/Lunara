import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { MemoryService } from './MemoryService.js';
import { SQLiteMemoryStore } from './MemoryStore.js';
import { initializeRevocations, isMemoryRevoked } from './memoryProvenance.js';

function withStores(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-forget-'));
  const dbPath = join(dir, 'state.db');
  let clock = 1_000;
  const conversations = new ConversationStore({ dbPath, now: () => ++clock }).initialize();
  const memory = new MemoryService('station');
  memory.store = new SQLiteMemoryStore({ dbPath });
  memory.store.initialize();
  memory._initialized = true;
  initializeRevocations(memory.store.db);
  return Promise.resolve(run({ conversations, memory })).finally(() => {
    conversations.close();
    memory.store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function exchange(store, sessionId, n, userText = `第${n}句`) {
  const { turn } = store.beginRequest({ sessionId, requestId: `rq-${sessionId}-${n}`, virtualPersonId: 'lunara', userText });
  store.completeRequest({ requestId: `rq-${sessionId}-${n}`, virtualPersonId: 'lunara', message: { content: `回应${n}` } });
  return turn;
}

function remember(memory, content, evidence) {
  const saved = memory.addMemory({ namespace: 'person:lunara', type: 'semantic', source: 'user_explicit_feedback',
    content, confidence: 0.7, importance: 8, evidence: JSON.stringify(evidence) });
  assert.equal(saved.ok, true);
  return saved.id;
}

const visible = (memory, id) => {
  const row = memory.store.getById(id);
  return !/(?:^|,)revoked(?:,|$)/.test(row.tags || '') && !isMemoryRevoked(memory.store, row);
};

test('删除聊天撤回从它学到的事实，别的聊天的事实不动', async () => {
  await withStores(({ conversations, memory }) => {
    conversations.createRoom({ sessionId: 'a', memberIds: ['lunara'] });
    conversations.createRoom({ sessionId: 'b', memberIds: ['lunara'] });
    const fromA = exchange(conversations, 'a', 1, '我的猫叫小满');
    const fromB = exchange(conversations, 'b', 1, '我住杭州');
    const cat = remember(memory, '用户的猫叫小满', { sourceTurnId: fromA.turnId, originSessionId: 'a' });
    const home = remember(memory, '用户住杭州', { sourceTurnId: fromB.turnId, originSessionId: 'b' });

    conversations.deleteRoom('a');

    assert.equal(visible(memory, cat), false);
    assert.equal(visible(memory, home), true);
  });
});

test('混合来源的洞察整条撤回，但只给被删聊天的 turn 写墓碑', async () => {
  await withStores(({ conversations, memory }) => {
    conversations.createRoom({ sessionId: 'a', memberIds: ['lunara'] });
    conversations.createRoom({ sessionId: 'b', memberIds: ['lunara'] });
    const fromA = exchange(conversations, 'a', 1);
    const fromB = exchange(conversations, 'b', 1);
    const insight = remember(memory, '用户深夜爱听后摇', { sourceTurnIds: [fromA.turnId, fromB.turnId], sessions: ['a', 'b'] });

    conversations.deleteRoom('a');

    assert.equal(visible(memory, insight), false);
    const tombstone = key => memory.store.db.prepare('SELECT 1 FROM memory_revocations WHERE namespace = ? AND source_key = ?')
      .get('person:lunara', key);
    assert.ok(tombstone(fromA.turnId));
    assert.equal(tombstone(fromB.turnId), undefined);
  });
});

test('编辑消息只撤回被改写的那条及之后学到的东西', async () => {
  await withStores(({ conversations, memory }) => {
    conversations.createRoom({ sessionId: 's', memberIds: ['lunara'] });
    const kept = exchange(conversations, 's', 1, '我住杭州');
    const edited = exchange(conversations, 's', 2, '我的猫叫小满');
    const home = remember(memory, '用户住杭州', { sourceTurnId: kept.turnId, originSessionId: 's' });
    const cat = remember(memory, '用户的猫叫小满', { sourceTurnId: edited.turnId, originSessionId: 's' });

    conversations.rewindFromTurn('s', edited.turnId);

    assert.equal(visible(memory, home), true);
    assert.equal(visible(memory, cat), false);
  });
});

test('反思观察日志里来自被删聊天的行一起删除', async () => {
  await withStores(({ conversations, memory }) => {
    conversations.createRoom({ sessionId: 'a', memberIds: ['lunara'] });
    const turn = exchange(conversations, 'a', 1);
    memory.store.db.exec(`CREATE TABLE reflection_observations (id INTEGER PRIMARY KEY, event_key TEXT, person_id TEXT,
      session_id TEXT, kind TEXT, data_json TEXT, created_at INTEGER)`);
    memory.store.db.prepare('INSERT INTO reflection_observations (event_key, person_id, session_id, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('turn:x', 'lunara', 'a', 'turn', JSON.stringify({ userTurnId: turn.turnId }), 1);

    conversations.deleteRoom('a');

    assert.equal(memory.store.db.prepare('SELECT COUNT(*) AS n FROM reflection_observations').get().n, 0);
  });
});

test('没有记忆库时删除聊天照常完成', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-forget-bare-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  try {
    store.createRoom({ sessionId: 'a', memberIds: ['lunara'] });
    exchange(store, 'a', 1);
    assert.equal(store.deleteRoom('a'), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('批量撤回过滤与逐行 isMemoryRevoked 一致：兄弟事实豁免、反思行不豁免、整源墓碑、跨 namespace', async () => {
  const { filterUnrevoked } = await import('./memoryProvenance.js');
  await withStores(({ memory }) => {
    const add = (namespace, source, evidence) => memory.addMemory({ namespace, type: 'semantic', source,
      content: `行 ${JSON.stringify(evidence)}`, confidence: 0.7, importance: 5, evidence: JSON.stringify(evidence) }).id;
    const ids = [
      add('person:lunara', 'user_explicit_feedback', { writeKey: 'w-cat', sourceTurnId: 't1' }),
      add('person:lunara', 'user_explicit_feedback', { writeKey: 'w-job', sourceTurnId: 't1' }),
      add('person:lunara', 'agent_reflection', { writeKey: 'w-life', sourceTurnId: 't1' }),
      add('person:lunara', 'agent_reflection', { originalEvidence: [{ originalKey: 'o9', data: { userTurnId: 't2' } }] }),
      add('person:lunara', 'user_explicit_feedback', { writeKey: 'w-free', sourceTurnId: 't3' }),
      add('person:other', 'user_explicit_feedback', { writeKey: 'w-x', sourceTurnId: 't1' }),
      add('person:lunara', 'user_explicit_feedback', {}),
    ];
    const write = memory.store.db.prepare('INSERT INTO memory_revocations VALUES (?, ?, ?, ?)');
    write.run('person:lunara', 't1', ids[0], 1);   // 忘掉了猫：同一句里的工作保留，近况不保留
    write.run('person:lunara', 'w-cat', ids[0], 1);
    write.run('person:lunara', 't2', null, 1);      // 删聊天：整源墓碑
    const rows = ids.map(id => memory.store.getById(id));
    const expected = rows.filter(row => !isMemoryRevoked(memory.store, row)).map(row => row.id);
    assert.deepEqual(filterUnrevoked(memory.store, rows).map(row => row.id), expected);
    assert.deepEqual(expected, [ids[1], ids[4], ids[5], ids[6]]);
  });
});
