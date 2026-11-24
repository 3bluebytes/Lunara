// 关系事实的语义召回（add-local-semantic-memory-recall）。
//
// 输入：超出关系记忆字节预算的事实行（已经过适用面与撤回过滤）和本轮用户原话。
// 输出：按余弦相似度排好的记忆 id（最多 8 条、相似度 ≥ 0.2）。它只"提名"，
// 进不进提示词仍由 retrievePersonMemories 决定。
// 失败去向：模型未装、子进程失败或超时 → 返回 []，调用方照旧走按原话检索。
//
// 交互路径不等冷启动：子进程还没加载好模型时，本轮直接返回 []，同时在后台预热并补向量；
// 加载好之后一次召回只多几毫秒（查询向量 + 少量缺失向量），超时上限 400 毫秒。
//
// 向量存在同一个记忆库的 memory_embeddings 表里，按模型 id + 内容哈希判断新鲜；
// 检索时顺带补齐最多 16 条缺失向量，其余后台分批补（进程重启后从缺口继续）。
import { createHash } from 'node:crypto';
import { EMBEDDING_MODEL } from './embeddingModel.js';

export const SEMANTIC_RECALL_LIMIT = 8;
export const SEMANTIC_MIN_SIMILARITY = 0.2;
export const INLINE_EMBED_LIMIT = 16;
const BACKGROUND_BATCH = 32;
const QUERY_CHARS = 500;

const contentHash = text => createHash('sha256').update(String(text || '')).digest('hex').slice(0, 32);

export class MemoryEmbeddingIndex {
  constructor(db, model = EMBEDDING_MODEL.id) {
    this.db = db;
    this.model = model;
    db.exec(`CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id    INTEGER PRIMARY KEY,
      model        TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      vector       BLOB NOT NULL,
      updated_at   INTEGER NOT NULL
    )`);
    // 一次取齐这批记忆的向量（json_each 展开 id），超出预算的事实有几千条时不逐条点查。
    this._getMany = db.prepare(`SELECT memory_id, model, content_hash, vector FROM memory_embeddings
      WHERE memory_id IN (SELECT value FROM json_each(?))`);
    this._put = db.prepare(`INSERT INTO memory_embeddings (memory_id, model, content_hash, vector, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET model = excluded.model, content_hash = excluded.content_hash,
        vector = excluded.vector, updated_at = excluded.updated_at`);
    // 已删除或已撤回的记忆不留向量：撤回只打墓碑、原文仍在，向量也算原文的派生副本。
    // 按向量表逐条点查记忆主键：向量表比记忆表小，不必每轮全扫记忆表。
    this._prune = db.prepare(`DELETE FROM memory_embeddings WHERE NOT EXISTS (
      SELECT 1 FROM memories m WHERE m.id = memory_embeddings.memory_id
        AND (',' || COALESCE(m.tags, '') || ',') NOT LIKE '%,revoked,%')`);
    // 进程内向量缓存：id → { model, content, vector }。命中要求模型与原文都相同，否则回库重读；
    // 每轮几千条超出预算的事实不再重读 BLOB、重算哈希。写入与清理时同步更新。
    this.cache = new Map();
  }

  /** rows 里模型与内容哈希都对得上的向量：Map(id → Float32Array)。 */
  fresh(rows) {
    const vectors = new Map();
    if (!rows.length) return vectors;
    const misses = [];
    for (const row of rows) {
      const cached = this.cache.get(row.id);
      if (cached && cached.model === this.model && cached.content === String(row.content || '')) vectors.set(row.id, cached.vector);
      else misses.push(row);
    }
    if (!misses.length) return vectors;
    const storedById = new Map(this._getMany.all(JSON.stringify(misses.map(row => row.id))).map(stored => [stored.memory_id, stored]));
    for (const row of misses) {
      const stored = storedById.get(row.id);
      if (!stored || stored.model !== this.model || stored.content_hash !== contentHash(row.content)) continue;
      const bytes = stored.vector;
      const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      this.cache.set(row.id, { model: this.model, content: String(row.content || ''), vector });
      vectors.set(row.id, vector);
    }
    return vectors;
  }

  put(rows, vectors, now = Date.now()) {
    this.db.transaction(() => {
      rows.forEach((row, i) => this._put.run(row.id, this.model, contentHash(row.content),
        Buffer.from(vectors[i].buffer, vectors[i].byteOffset, vectors[i].byteLength), now));
    })();
    rows.forEach((row, i) => this.cache.set(row.id, { model: this.model, content: String(row.content || ''), vector: vectors[i] }));
  }

  prune() {
    const changes = this._prune.run().changes;
    // 被清掉的向量也不能留在缓存里（撤回后原文仍在，命中条件挡不住）。
    if (changes) this.cache.clear();
    return changes;
  }
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

export function createSemanticMemory({ embedder, logger = console, timeoutMs = 400 } = {}) {
  const indexes = new WeakMap();
  const backfills = new WeakMap();
  const warned = new Set();
  const indexFor = db => {
    if (!indexes.has(db)) indexes.set(db, new MemoryEmbeddingIndex(db));
    return indexes.get(db);
  };
  const warnOnce = code => {
    if (warned.has(code)) return;
    warned.add(code);
    logger?.warn?.(`[semantic-memory] 语义召回暂不可用（${code}），本轮按原话检索`);
  };

  // 后台补向量：每批重新读新鲜度，跳过已补的；出错即停，下次召回再续。
  function scheduleBackfill(db, rows) {
    if (backfills.has(db)) return backfills.get(db);
    const index = indexFor(db);
    const run = (async () => {
      for (let start = 0; start < rows.length; start += BACKGROUND_BATCH) {
        const batch = rows.slice(start, start + BACKGROUND_BATCH);
        const fresh = index.fresh(batch);
        const todo = batch.filter(row => !fresh.has(row.id));
        if (!todo.length) continue;
        await new Promise(resolve => setImmediate(resolve));
        index.put(todo, await embedder.embed(todo.map(row => row.content), { timeoutMs: timeoutMs * 4 }));
      }
    })().catch(error => warnOnce(error?.code || 'EMBEDDING_FAILED')).finally(() => backfills.delete(db));
    backfills.set(db, run);
    return run;
  }

  // 冷启动：后台预热，预热成功后把这批缺失向量也补上，下一轮就能召回。
  function warmInBackground(db, rows) {
    void Promise.resolve(embedder.warmUp?.()).then(ok => {
      if (!ok) return;
      const fresh = indexFor(db).fresh(rows);
      const missing = rows.filter(row => !fresh.has(row.id));
      if (missing.length) void scheduleBackfill(db, missing);
    }).catch(error => warnOnce(error?.code || 'EMBEDDING_FAILED'));
  }

  return {
    available: () => Boolean(embedder?.available()),

    /** 后台加载模型；评估脚本等需要第一轮就召回的场合可以先 await 它。 */
    warmUp: () => Promise.resolve(embedder?.warmUp?.() ?? Boolean(embedder?.available())),

    /** rows：超出预算、已过滤的关系事实；返回按相似度降序的记忆 id。 */
    async recall({ store, rows, query }) {
      const text = String(query || '').trim().slice(0, QUERY_CHARS);
      if (!store?.db || !rows?.length || text.length < 2 || !embedder?.available()) return [];
      try {
        const index = indexFor(store.db);
        index.prune();
        if (embedder.ready && !embedder.ready()) {
          warmInBackground(store.db, rows);
          return [];
        }
        const vectors = index.fresh(rows);
        const missing = rows.filter(row => !vectors.has(row.id));
        const inline = missing.slice(0, INLINE_EMBED_LIMIT);
        const [queryVector, ...inlineVectors] = await embedder.embed([text, ...inline.map(row => row.content)], { timeoutMs });
        if (inline.length) {
          index.put(inline, inlineVectors);
          inline.forEach((row, i) => vectors.set(row.id, inlineVectors[i]));
        }
        if (missing.length > inline.length) void scheduleBackfill(store.db, missing.slice(INLINE_EMBED_LIMIT));
        return rows.filter(row => vectors.has(row.id))
          .map(row => ({ id: row.id, score: dot(queryVector, vectors.get(row.id)) }))
          .filter(item => item.score >= SEMANTIC_MIN_SIMILARITY)
          .sort((a, b) => b.score - a.score || b.id - a.id)
          .slice(0, SEMANTIC_RECALL_LIMIT)
          .map(item => item.id);
      } catch (error) {
        warnOnce(error?.code || 'EMBEDDING_FAILED');
        return [];
      }
    },

    /** 测试与关停用：等后台补向量跑完。 */
    async settle(store) {
      await (store?.db && backfills.get(store.db));
    },

    close: () => embedder?.close?.(),
  };
}
