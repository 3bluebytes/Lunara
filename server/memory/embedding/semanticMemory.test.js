// semanticMemory.test.js — 关系事实的语义召回与向量索引（add-local-semantic-memory-recall）。
//
// 用假 embedder：按概念词把文本映射到固定维度的单位向量，余弦相似度可预测。
// Run: node --test server/memory/embedding/semanticMemory.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { createSemanticMemory, INLINE_EMBED_LIMIT, MemoryEmbeddingIndex, SEMANTIC_RECALL_LIMIT } from './semanticMemory.js';
import { EmbeddingUnavailable } from './EmbeddingClient.js';

const CONCEPTS = [/芒果|水果/u, /狗|柯基/u, /酒|drinks/u, /黑胶/u];

function fakeEmbedder({ available = true, fail = null, warm = true } = {}) {
  const calls = [];
  const state = { warm, warmUps: 0 };
  return {
    calls,
    state,
    available: () => available,
    ready: () => available && state.warm,
    async warmUp() {
      state.warmUps += 1;
      state.warm = true;
      return true;
    },
    async embed(texts) {
      calls.push(texts);
      if (fail) throw new EmbeddingUnavailable(fail);
      return texts.map(text => {
        const vector = new Float32Array(CONCEPTS.length + 1);
        CONCEPTS.forEach((pattern, i) => { if (pattern.test(text)) vector[i] = 1; });
        vector[CONCEPTS.length] = 0.1;
        const norm = Math.hypot(...vector);
        return vector.map(value => value / norm);
      });
    },
  };
}

function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, tags TEXT)');
  const insert = db.prepare('INSERT INTO memories (id, content, tags) VALUES (?, ?, ?)');
  const rows = [];
  const add = (content, tags = '') => {
    const id = rows.length + 1;
    insert.run(id, content, tags);
    rows.push({ id, content });
    return rows.at(-1);
  };
  return { db, store: { db }, rows, add };
}

const silent = { warn() {} };

test('按相似度召回超出预算的事实；无关的低于阈值不召回', async () => {
  const { store, rows, add } = fixture();
  const mango = add('用户对芒果过敏');
  add('用户收藏了第 3 张黑胶');
  const dog = add('用户养了一只叫豆包的柯基');
  const memory = createSemanticMemory({ embedder: fakeEmbedder(), logger: silent });
  assert.deepEqual(await memory.recall({ store, rows, query: '推荐点夏天的水果吧' }), [mango.id]);
  assert.deepEqual(await memory.recall({ store, rows, query: '我家狗最近不爱吃饭' }), [dog.id]);
});

test('最多召回 8 条', async () => {
  const { store, rows, add } = fixture();
  for (let i = 0; i < 12; i += 1) add(`用户喜欢第 ${i} 种水果`);
  const memory = createSemanticMemory({ embedder: fakeEmbedder(), logger: silent });
  assert.equal((await memory.recall({ store, rows, query: '水果' })).length, SEMANTIC_RECALL_LIMIT);
});

test('embedder 不可用或出错时返回空，不抛错', async () => {
  const { store, rows, add } = fixture();
  add('用户对芒果过敏');
  const off = fakeEmbedder({ available: false });
  assert.deepEqual(await createSemanticMemory({ embedder: off, logger: silent }).recall({ store, rows, query: '水果' }), []);
  assert.equal(off.calls.length, 0);
  const broken = fakeEmbedder({ fail: 'EMBEDDING_TIMEOUT' });
  assert.deepEqual(await createSemanticMemory({ embedder: broken, logger: silent }).recall({ store, rows, query: '水果' }), []);
});

test('向量按内容哈希判断新鲜：已存的不重算，内容变了才重算', async () => {
  const { store, rows, add } = fixture();
  add('用户对芒果过敏');
  const embedder = fakeEmbedder();
  const memory = createSemanticMemory({ embedder, logger: silent });
  await memory.recall({ store, rows, query: '水果' });
  await memory.recall({ store, rows, query: '水果' });
  assert.deepEqual(embedder.calls.map(texts => texts.length), [2, 1], '第二次只算查询');
  rows[0] = { ...rows[0], content: '用户养了一只柯基' };
  assert.deepEqual(await memory.recall({ store, rows, query: '水果' }), [], '旧向量不再使用');
  assert.equal(embedder.calls.at(-1).length, 2, '改过的事实重新计算');
});

test('撤回与删除的记忆，向量被清掉', async () => {
  const { db, store, rows, add } = fixture();
  add('用户对芒果过敏');
  add('用户不喝酒');
  const memory = createSemanticMemory({ embedder: fakeEmbedder(), logger: silent });
  await memory.recall({ store, rows, query: '水果' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, 2);
  db.prepare("UPDATE memories SET tags = 'person-relationship,revoked' WHERE id = 1").run();
  db.prepare('DELETE FROM memories WHERE id = 2').run();
  await memory.recall({ store, rows: [], query: '水果' });
  assert.equal(new MemoryEmbeddingIndex(db).prune(), 2, '空候选时不跑 recall，直接 prune 清掉两条');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, 0);
});

test('进程内向量缓存：命中要求原文相同；清理向量时缓存一并清掉', async () => {
  const { db, rows, add } = fixture();
  add('用户对芒果过敏');
  const index = new MemoryEmbeddingIndex(db);
  index.put(rows, [new Float32Array([1, 0])]);
  assert.equal(index.fresh(rows).size, 1);
  assert.equal(index.fresh([{ ...rows[0], content: '改过的' }]).size, 0, '原文变了不命中缓存');
  db.prepare("UPDATE memories SET tags = 'revoked' WHERE id = 1").run();
  assert.equal(index.prune(), 1);
  assert.equal(index.fresh(rows).size, 0, '清理后缓存里也没有');
});

test('检索内最多补 16 条向量，其余后台分批补齐', async () => {
  const { db, store, rows, add } = fixture();
  for (let i = 0; i < INLINE_EMBED_LIMIT + 40; i += 1) add(`用户收藏了第 ${i} 张黑胶`);
  const embedder = fakeEmbedder();
  const memory = createSemanticMemory({ embedder, logger: silent });
  await memory.recall({ store, rows, query: '黑胶' });
  assert.equal(embedder.calls[0].length, INLINE_EMBED_LIMIT + 1);
  await memory.settle(store);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, rows.length);
});

test('冷启动不等：本轮返回空，后台预热并补向量，下一轮召回', async () => {
  const { db, store, rows, add } = fixture();
  const mango = add('用户对芒果过敏');
  add('用户收藏了第 3 张黑胶');
  const embedder = fakeEmbedder({ warm: false });
  const memory = createSemanticMemory({ embedder, logger: silent });
  assert.deepEqual(await memory.recall({ store, rows, query: '推荐点夏天的水果吧' }), [], '冷启动这一轮不召回');
  assert.equal(embedder.state.warmUps, 1, '后台开始预热');
  await new Promise(resolve => setImmediate(resolve));
  await memory.settle(store);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n, rows.length, '预热后补齐向量');
  assert.deepEqual(await memory.recall({ store, rows, query: '推荐点夏天的水果吧' }), [mango.id]);
  assert.equal(embedder.calls.at(-1).length, 1, '预热后只算查询向量');
});
