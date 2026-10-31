// summary.test.js — coverage for memory-system-v2 hierarchical summarization
//
// Run: node server/memory/summary.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryService } from './MemoryService.js';
import { MemoryType, MemorySource } from './types.js';
import { writeMemoryWithEncoding } from './writeMemoryWithEncoding.js';
import { generateDailySummary } from './summary.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-summary-test-')));

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

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function testNotEnoughData() {
  console.log('\n--- empty day → no summary ---');
  const svc = await fresh();
  const r = await generateDailySummary({ memoryService: svc, date: todayStr() });
  assert(r === null, 'returns null with no data');
}

async function testRuleBasedSummary() {
  console.log('\n--- rule-based summary from episodic ---');
  const svc = await fresh();
  // plant 5 episodic memories with various moods/tags
  for (let i = 0; i < 5; i++) {
    writeMemoryWithEncoding(svc, {
      namespace: svc.namespace,
      type: MemoryType.EPISODIC,
      content: `event ${i}`,
      tags: `interaction,mood:${i < 3 ? 'calm' : 'energetic'}`,
      source: MemorySource.BEHAVIOR_OBSERVATION,
      importance: 5,
      confidence: 0.5,
    }, { mood: i < 3 ? 'calm' : 'energetic', time_bucket: i < 2 ? 'evening' : 'night' });
  }
  const r = await generateDailySummary({ memoryService: svc, date: todayStr() });
  assert(r !== null, 'summary generated');
  assert(typeof r.id === 'number', 'memory id returned');
  // verify the stored record
  const stored = svc.getMemory(r.id);
  assert(stored.type === 'semantic', 'stored as semantic type');
  assert(stored.tags.includes(`summary:daily:${todayStr()}`), 'tagged correctly');
  assert(stored.confidence <= 0.6, `confidence capped (got ${stored.confidence})`);
  // content should mention counts
  assert(stored.content.includes('5'), 'content mentions count of events');
}

async function testDeterministicSameInput() {
  console.log('\n--- same input → same content (rule-based determinism) ---');
  const svc = await fresh();
  for (let i = 0; i < 3; i++) {
    writeMemoryWithEncoding(svc, {
      namespace: svc.namespace,
      type: MemoryType.EPISODIC,
      content: `e ${i}`,
      tags: 'interaction',
      source: MemorySource.BEHAVIOR_OBSERVATION,
      importance: 5,
      confidence: 0.5,
    }, { mood: 'calm' });
  }
  const a = await generateDailySummary({ memoryService: svc, date: todayStr() });
  // Insert a new run (overwrite) — content should be same
  const b = await generateDailySummary({ memoryService: svc, date: todayStr() });
  const recA = svc.getMemory(a.id);
  const recB = svc.getMemory(b.id);
  assert(recA.content === recB.content, 'identical content across runs');
}

async function testTopMoodDetected() {
  console.log('\n--- summary identifies top mood ---');
  const svc = await fresh();
  // 4 calm + 1 energetic → top should be calm
  for (let i = 0; i < 4; i++) {
    writeMemoryWithEncoding(svc, {
      namespace: svc.namespace,
      type: MemoryType.EPISODIC,
      content: `calm ${i}`,
      tags: 'interaction',
      source: MemorySource.BEHAVIOR_OBSERVATION,
      importance: 5,
      confidence: 0.5,
    }, { mood: 'calm' });
  }
  writeMemoryWithEncoding(svc, {
    namespace: svc.namespace,
    type: MemoryType.EPISODIC,
    content: 'energetic 0',
    tags: 'interaction',
    source: MemorySource.BEHAVIOR_OBSERVATION,
    importance: 5,
    confidence: 0.5,
  }, { mood: 'energetic' });

  const r = await generateDailySummary({ memoryService: svc, date: todayStr() });
  const stored = svc.getMemory(r.id);
  assert(stored.content.includes('calm'), `content mentions top mood (got: ${stored.content})`);
}

async function runTests() {
  console.log('\n🧪 Daily Summary tests\n');
  try {
    await testNotEnoughData();
    await testRuleBasedSummary();
    await testDeterministicSameInput();
    await testTopMoodDetected();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
