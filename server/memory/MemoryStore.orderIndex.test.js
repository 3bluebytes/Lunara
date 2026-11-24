import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMemoryStore } from './MemoryStore.js';

test('按命名空间与类型取最近 N 条走索引、不再整段排序，同一时刻写入的行按 id 新者在前', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-order-index-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  const store = new SQLiteMemoryStore();
  store.initialize();
  try {
    const at = 5_000;
    const ids = [1, 2, 3].map(i => store.insert({ createdAt: at, updatedAt: at, lastAccessedAt: at, namespace: 'person:a',
      type: 'semantic', source: 'user_explicit_feedback', content: `事实 ${i}`, summary: '', tags: '', confidence: 0.7, importance: 5,
      evidence: '{}' }));
    for (const orderBy of [undefined, 'updated_at_desc']) {
      assert.deepEqual(store.search({ namespace: 'person:a', type: 'semantic', orderBy, limit: 10 }).map(row => row.id), [...ids].reverse());
    }
    const plan = sql => store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('person:a', 'semantic').map(row => row.detail).join(' | ');
    for (const order of ['updated_at DESC, id DESC', 'created_at DESC, id DESC']) {
      const detail = plan(`SELECT * FROM memories WHERE namespace = ? AND type = ? ORDER BY ${order} LIMIT 30`);
      assert.ok(!/TEMP B-TREE/.test(detail), `${order}: ${detail}`);
    }
  } finally {
    store.close?.();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH; else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
