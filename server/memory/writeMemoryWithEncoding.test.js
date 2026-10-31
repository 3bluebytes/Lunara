// writeMemoryWithEncoding.test.js — v2 unified write path tests
//
// Run: node server/memory/writeMemoryWithEncoding.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryService } from './MemoryService.js';
import { MemoryType, MemorySource } from './types.js';
import { writeMemoryWithEncoding } from './writeMemoryWithEncoding.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-v2-wme-test-')));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

let _c = 0;
async function freshService() {
  _c += 1;
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `data/state-${_c}.db`);
  const svc = new MemoryService(`radiohost:test-${_c}`);
  await svc.initialize();
  return svc;
}

async function testCallerWins() {
  console.log('\n--- caller-supplied encoding wins over hints ---');
  const svc = await freshService();
  const r = writeMemoryWithEncoding(svc, {
    type: MemoryType.EPISODIC,
    content: 'x',
    source: MemorySource.AGENT_REFLECTION,
    mood_at_creation: 'tired',  // 显式给了
  }, { mood: 'calm' });
  const out = svc.getMemory(r.id);
  assert(out.mood_at_creation === 'tired', 'caller-supplied mood preserved');
}

async function testHintsFillWhenMissing() {
  console.log('\n--- hints fill when record fields missing ---');
  const svc = await freshService();
  const r = writeMemoryWithEncoding(svc, {
    type: MemoryType.EPISODIC,
    content: 'x',
    source: MemorySource.AGENT_REFLECTION,
  }, { mood: 'calm', time_bucket: 'evening', session_id: 'sess_a' });
  const out = svc.getMemory(r.id);
  assert(out.mood_at_creation === 'calm', 'mood filled from hints');
  assert(out.time_bucket === 'evening', 'time_bucket filled from hints');
  assert(out.session_id === 'sess_a', 'session_id filled from hints');
}

async function testTimeInferredFromClock() {
  console.log('\n--- time_bucket and day_of_week inferred from current clock ---');
  const svc = await freshService();
  const r = writeMemoryWithEncoding(svc, {
    type: MemoryType.WORKING,
    content: 'x',
    source: MemorySource.USER_TEMPORARY_REQUEST,
  }, {});
  const out = svc.getMemory(r.id);
  const validBuckets = ['morning', 'afternoon', 'evening', 'night', 'late-night'];
  assert(validBuckets.includes(out.time_bucket), `time_bucket inferred (got '${out.time_bucket}')`);
  assert(out.day_of_week >= 0 && out.day_of_week <= 6, `day_of_week inferred (got ${out.day_of_week})`);
}

async function testNoSourceLeavesNull() {
  console.log('\n--- missing weather + missing session leaves NULL ---');
  const svc = await freshService();
  const r = writeMemoryWithEncoding(svc, {
    type: MemoryType.WORKING,
    content: 'x',
    source: MemorySource.USER_TEMPORARY_REQUEST,
  }, {});
  const out = svc.getMemory(r.id);
  assert(out.weather_at_creation === null, 'weather NULL when not provided');
  assert(out.session_id === null, 'session_id NULL when not provided');
}

async function testDeprecatedTypeRejected() {
  console.log('\n--- deprecated type still rejected via writeMemoryWithEncoding ---');
  const svc = await freshService();
  const r = writeMemoryWithEncoding(svc, {
    type: 'persona',
    content: 'should fail',
    source: MemorySource.AGENT_REFLECTION,
  }, {});
  assert(r.ok === false, 'returns {ok:false} for persona type');
}

async function runTests() {
  console.log('\n🧪 writeMemoryWithEncoding tests\n');
  try {
    await testCallerWins();
    await testHintsFillWhenMissing();
    await testTimeInferredFromClock();
    await testNoSourceLeavesNull();
    await testDeprecatedTypeRejected();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
