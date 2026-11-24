// retrieval.test.js — coverage for memory-system-v2 retrieveForPrompt
//
// Run: node server/memory/retrieval.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryService } from './MemoryService.js';
import { MemoryType, MemorySource } from './types.js';
import { writeMemoryWithEncoding } from './writeMemoryWithEncoding.js';
import { retrieveForPrompt } from './retrieval.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-retrieval-test-')));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

let _c = 0;
async function fresh() {
  _c += 1;
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `data/state-${_c}.db`);
  const svc = new MemoryService(`radiohost:test-${_c}`);
  await svc.initialize();
  return svc;
}

function plant(svc, opts) {
  return writeMemoryWithEncoding(svc, {
    namespace: svc.namespace,
    type: opts.type || MemoryType.EPISODIC,
    content: opts.content,
    summary: opts.summary || '',
    tags: opts.tags || '',
    source: opts.source || MemorySource.AGENT_REFLECTION,
    importance: opts.importance ?? 5,
    confidence: opts.confidence ?? 0.5,
  }, opts.hints || {});
}

async function testEmptyArgsReturnsRecent() {
  console.log('\n--- empty args returns recent records ---');
  const svc = await fresh();
  for (let i = 0; i < 3; i++) {
    plant(svc, { content: `record ${i}`, hints: { mood: 'calm' } });
  }
  const out = retrieveForPrompt(svc, { namespace: svc.namespace, topK: 5 });
  assert(out.length === 3, `returned all ${out.length} records when no filter given`);
}

async function testBM25Matching() {
  console.log('\n--- BM25 ranks query matches higher ---');
  const svc = await fresh();
  plant(svc, { content: 'user prefers jazz piano late at night', tags: 'genre:jazz' });
  plant(svc, { content: 'morning user wants energetic rock music', tags: 'genre:rock' });
  plant(svc, { content: 'random unrelated content about cooking' });
  const out = retrieveForPrompt(svc, { namespace: svc.namespace, query: 'jazz piano', topK: 5 });
  assert(out.length >= 1, 'returned at least 1 hit');
  assert(out[0].content.includes('jazz'), `top hit contains 'jazz' (got '${out[0].content.slice(0, 50)}')`);
}

async function testBM25OrderAmongSeveralHits() {
  console.log('\n--- BM25: stronger matches rank above weaker ones ---');
  const svc = await fresh();
  plant(svc, { content: '用户失眠的时候喜欢听雨声' });
  plant(svc, { content: '用户对芒果过敏' });
  plant(svc, { content: '芒果过敏的人夏天可以多吃西瓜，夏天的水果里西瓜最解暑' });
  const out = retrieveForPrompt(svc, { namespace: svc.namespace, query: '芒果过敏的人夏天的水果吃什么', topK: 2, enableSpreading: false });
  assert(out[0]?.content.includes('西瓜'), `strongest hit first (got '${out[0]?.content}')`);
  assert(!out.some(r => r.content.includes('失眠')), 'weakest hit is not kept over stronger ones');
}

async function testAcceptReachesBeyondFirstPage() {
  console.log('\n--- accept: 前 50 个强命中都被拒时，往后翻页找到能用的 ---');
  const svc = await fresh();
  const target = plant(svc, { content: '周杰伦是用户初恋时最常听的歌手' }).id;
  const rejected = new Set();
  for (let i = 0; i < 70; i += 1) rejected.add(plant(svc, { content: `周杰伦的晴天又听了一遍，第 ${i} 次周杰伦晴天` }).id);
  const out = retrieveForPrompt(svc, { namespace: svc.namespace, query: '周杰伦的晴天', topK: 3, enableSpreading: false,
    accept: row => !rejected.has(row.id) });
  assert(out.some(r => r.id === target), `weaker accepted hit is found (got ${out.map(r => r.content).join('|')})`);
}

async function testStateDependentBoost() {
  console.log('\n--- state-dependent boost ranks matching mood higher ---');
  const svc = await fresh();
  plant(svc, { content: 'old calm memory', hints: { mood: 'calm' }, importance: 5 });
  plant(svc, { content: 'old tired memory', hints: { mood: 'tired' }, importance: 5 });
  plant(svc, { content: 'old neutral memory', importance: 5 });

  // 不传 query，靠 state-dependent boost 排序
  const out = retrieveForPrompt(svc, {
    namespace: svc.namespace,
    currentMood: 'calm',
    topK: 3,
  });
  assert(out.length === 3, 'returned all 3 records');
  // calm 记录应排在最前
  assert(out[0].mood_at_creation === 'calm', `top hit has mood=calm (got '${out[0].mood_at_creation}')`);
}

async function testSpreadingActivation() {
  console.log('\n--- 2-hop spreading activation includes neighbors ---');
  const svc = await fresh();
  // primary 命中
  const p1 = plant(svc, { content: 'piano calm late-night memory', tags: 'mood:calm,time:late-night', importance: 6 });
  // secondary：共享 2 个 tag
  const s1 = plant(svc, { content: 'rainy night together', tags: 'mood:calm,time:late-night,weather:rain', importance: 5 });
  // 完全无关
  plant(svc, { content: 'unrelated cooking notes', tags: 'cat:food', importance: 5 });

  const out = retrieveForPrompt(svc, {
    namespace: svc.namespace,
    query: 'piano',
    topK: 10,
    enableSpreading: true,
  });
  const ids = out.map(r => r.id);
  assert(ids.includes(p1.id), 'primary hit included');
  assert(ids.includes(s1.id), 'secondary hit (shares 2 tags) included');
}

async function testSpreadingDisabled() {
  console.log('\n--- enableSpreading=false skips secondary expansion ---');
  const svc = await fresh();
  plant(svc, { content: 'piano memory', tags: 'mood:calm,time:late-night', importance: 6 });
  plant(svc, { content: 'rainy night calm', tags: 'mood:calm,time:late-night,extra:tag', importance: 5 });
  const out = retrieveForPrompt(svc, {
    namespace: svc.namespace,
    query: 'piano',
    topK: 10,
    enableSpreading: false,
  });
  const piano = out.find(r => r.content.includes('piano'));
  const rainy = out.find(r => r.content.includes('rainy'));
  assert(!!piano, 'primary still included');
  assert(!rainy, 'secondary NOT included with spreading off');
}

async function testLastActivatedAtUpdated() {
  console.log('\n--- returned records have last_activated_at updated ---');
  const svc = await fresh();
  const r = plant(svc, { content: 'test', tags: 'test' });
  // Pre-state
  const before = svc.getMemory(r.id);
  assert(before.last_activated_at === null, 'last_activated_at starts NULL');
  // Retrieve
  const t0 = Date.now();
  retrieveForPrompt(svc, { namespace: svc.namespace, query: 'test', topK: 1 });
  // Post-state
  const after = svc.getMemory(r.id);
  assert(after.last_activated_at != null, 'last_activated_at set after retrieve');
  assert(after.last_activated_at >= t0, 'last_activated_at >= retrieve time');
}

async function testTopKLimit() {
  console.log('\n--- topK limits returned count ---');
  const svc = await fresh();
  for (let i = 0; i < 10; i++) {
    plant(svc, { content: `match ${i}`, tags: 'shared' });
  }
  const out = retrieveForPrompt(svc, {
    namespace: svc.namespace,
    query: 'match',
    topK: 3,
  });
  assert(out.length === 3, `topK=3 returned ${out.length}`);
}

async function runTests() {
  console.log('\n🧪 retrieveForPrompt tests\n');
  try {
    await testEmptyArgsReturnsRecent();
    await testBM25Matching();
    await testBM25OrderAmongSeveralHits();
    await testAcceptReachesBeyondFirstPage();
    await testStateDependentBoost();
    await testSpreadingActivation();
    await testSpreadingDisabled();
    await testLastActivatedAtUpdated();
    await testTopKLimit();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
