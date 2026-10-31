// store.v2.test.js — coverage for memory-system-v2 changes.
//
// 覆盖：
//   - 6 个新 encoding 字段写入 + 读出
//   - 4 个新索引存在
//   - FTS5 虚表 + triggers 同步
//   - deprecated v1 type 写入被拒
//
// Run: node server/memory/store.v2.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SQLiteMemoryStore } from './MemoryStore.js';
import { createMemoryRecord, MemoryType, MemorySource } from './types.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-v2-store-test-')));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// 每次 fresh() 用独立路径，避免一个测试创建的 schema 残留到下一个测试。
// LUNARA_DB_PATH env 控制 databasePath()。
let _freshCounter = 0;
function fresh() {
  _freshCounter += 1;
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `data/state-${_freshCounter}.db`);
  const s = new SQLiteMemoryStore();
  s.initialize();
  return s;
}

// ===== Test 1: 新 encoding 字段写入与读出 =====
function testEncodingFieldsRoundTrip() {
  console.log('\n--- encoding fields write & read ---');
  const store = fresh();
  const rec = createMemoryRecord(MemoryType.EPISODIC, {
    namespace: 'radiohost:test',
    content: '用户在雨夜放了陈奕迅',
    source: MemorySource.AGENT_REFLECTION,
  });
  // 手动塞 v2 encoding
  rec.mood_at_creation = 'calm';
  rec.time_bucket = 'late-night';
  rec.day_of_week = 5;
  rec.weather_at_creation = 'rain';
  rec.session_id = 'sess_abc';
  rec.last_activated_at = null;

  const id = store.insert(rec);
  const out = store.getById(id);

  assert(out.mood_at_creation === 'calm', 'mood_at_creation round-trip');
  assert(out.moodAtCreation === 'calm', 'moodAtCreation camelCase alias');
  assert(out.time_bucket === 'late-night', 'time_bucket round-trip');
  assert(out.day_of_week === 5, 'day_of_week round-trip');
  assert(out.weather_at_creation === 'rain', 'weather_at_creation round-trip');
  assert(out.session_id === 'sess_abc', 'session_id round-trip');
  assert(out.last_activated_at === null, 'last_activated_at NULL round-trip');
}

// ===== Test 2: 缺失 encoding 字段插入仍可成功，all NULL =====
function testEncodingFieldsDefaultNull() {
  console.log('\n--- encoding fields default NULL when missing ---');
  const store = fresh();
  const rec = createMemoryRecord(MemoryType.WORKING, {
    namespace: 'radiohost:test',
    content: '没带 encoding 的记录',
    source: MemorySource.USER_TEMPORARY_REQUEST,
  });
  const id = store.insert(rec);
  const out = store.getById(id);

  assert(out.mood_at_creation === null, 'mood NULL when not provided');
  assert(out.time_bucket === null, 'time_bucket NULL when not provided');
  assert(out.day_of_week === null, 'day_of_week NULL when not provided');
  assert(out.session_id === null, 'session_id NULL when not provided');
}

// ===== Test 3: 4 个新索引存在 =====
function testV2Indexes() {
  console.log('\n--- v2 indexes exist ---');
  const store = fresh();
  const idxs = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_memories_%'`).all().map(r => r.name);
  assert(idxs.includes('idx_memories_mood'), 'idx_memories_mood exists');
  assert(idxs.includes('idx_memories_time_bucket'), 'idx_memories_time_bucket exists');
  assert(idxs.includes('idx_memories_session'), 'idx_memories_session exists');
  assert(idxs.includes('idx_memories_last_activated'), 'idx_memories_last_activated exists');
}

// ===== Test 4: FTS5 虚表 + triggers 同步 =====
function testFTS5Sync() {
  console.log('\n--- FTS5 mirror + triggers ---');
  const store = fresh();
  if (!store._ftsAvailable) {
    console.log('  ⚠ FTS5 unavailable on this SQLite build, skipping');
    return;
  }
  // 验证表存在
  const tbl = store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'`).get();
  assert(!!tbl, 'memories_fts virtual table exists');

  // INSERT 同步：trigram tokenizer 需要 ≥ 3 字符查询
  const rec = createMemoryRecord(MemoryType.SEMANTIC, {
    namespace: 'radiohost:test',
    content: '用户偏好深夜安静的民谣',
    source: MemorySource.AGENT_REFLECTION,
  });
  const id = store.insert(rec);
  const hits = store.db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`).all('深夜安');
  assert(hits.some(h => h.rowid === id), 'INSERT propagates to FTS mirror（trigram，3+ 字符）');

  // DELETE 同步
  store.delete(id);
  const hitsAfter = store.db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?`).all('深夜安');
  assert(!hitsAfter.some(h => h.rowid === id), 'DELETE removes from FTS mirror');
}

// ===== Test 5: deprecated type 拒写 =====
function testDeprecatedTypeRejected() {
  console.log('\n--- deprecated v1 types rejected on insert ---');
  const store = fresh();
  const deprecatedTypes = ['persona', 'episode', 'user_preference', 'interaction'];
  for (const t of deprecatedTypes) {
    let threw = false;
    try {
      store.insert({
        namespace: 'radiohost:test', type: t, content: 'x', source: 'agent_reflection',
        importance: 5, confidence: 0.5,
        createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: Date.now(),
      });
    } catch (e) {
      threw = e.message.includes('removed') || e.message.includes('unknown');
    }
    assert(threw, `type='${t}' rejected with clear error`);
  }
}

// ===== Test 6: v2 valid type 接受 =====
function testV2ValidTypeAccepted() {
  console.log('\n--- v2 valid types accepted ---');
  const store = fresh();
  const okTypes = ['working', 'episodic', 'semantic', 'life_state'];
  for (const t of okTypes) {
    const id = store.insert({
      namespace: 'radiohost:test', type: t, content: 'x', source: 'agent_reflection',
      importance: 5, confidence: 0.5,
      createdAt: Date.now(), updatedAt: Date.now(), lastAccessedAt: Date.now(),
    });
    assert(id > 0, `type='${t}' accepted, got id=${id}`);
  }
}

// ===== Test 7: rebuildFTS idempotent =====
function testRebuildFTS() {
  console.log('\n--- rebuildFTS idempotent ---');
  const store = fresh();
  if (!store._ftsAvailable) {
    console.log('  ⚠ FTS5 unavailable, skipping');
    return;
  }
  for (let i = 0; i < 3; i++) {
    store.insert(createMemoryRecord(MemoryType.EPISODIC, {
      namespace: 'radiohost:test',
      content: `memory ${i}`,
      source: MemorySource.AGENT_REFLECTION,
    }));
  }
  const before = store.db.prepare(`SELECT COUNT(*) AS n FROM memories_fts`).get().n;
  const r1 = store.rebuildFTS();
  const after1 = store.db.prepare(`SELECT COUNT(*) AS n FROM memories_fts`).get().n;
  const r2 = store.rebuildFTS();
  const after2 = store.db.prepare(`SELECT COUNT(*) AS n FROM memories_fts`).get().n;
  assert(r1 === true && r2 === true, 'rebuildFTS returns true twice');
  assert(after1 === before && after2 === before, 'FTS row count stable across rebuilds');
}

async function runTests() {
  console.log('\n🧪 MemoryStore v2 schema tests\n');
  try {
    testEncodingFieldsRoundTrip();
    testEncodingFieldsDefaultNull();
    testV2Indexes();
    testFTS5Sync();
    testDeprecatedTypeRejected();
    testV2ValidTypeAccepted();
    testRebuildFTS();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
