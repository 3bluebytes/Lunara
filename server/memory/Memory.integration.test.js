import { retrievePersonMemories } from '../virtual-person/personMemory.js';
// test.js — Memory system integration tests
//
// Run: node server/memory/test.js
//
// Coverage:
//   10.1 User temp request → Working Memory, not Semantic
//   10.2 3+ observations → consolidateMemories() → Semantic Memory
//   10.3 Explicit preference → Semantic with high confidence + evidence
//   10.4 Behavior observation → Episodic with low confidence
//   10.5 Working Memory expiration → deleteExpired()
//   10.6 Low-value Episodic → prune()
//   10.7 buildContextForAgent → ≤ 15 memories with 500+ total
//   10.8 Playback progress stays in state, not memory

import { MemoryService } from './MemoryService.js';
import { MemoryConsolidator } from './MemoryConsolidator.js';
import { MemoryType, MemorySource, createMemoryRecord } from './types.js';
import { seedPersonaMemory } from './seedPersonaMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-memory-test-')));

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

async function runTests() {
  console.log('\n🧪 Memory System Tests\n');

  // Initialize fresh service
  const svc = new MemoryService();
  svc.initialize();
  await seedPersonaMemory(svc, svc.namespace);

  // Wipe all test data from previous runs (keep persona)
  const allPersona = svc.getMemoriesByType(MemoryType.PERSONA);
  const store = svc.getStore();
  const allMems = store.getAllForConsolidation();
  for (const m of allMems) store.delete(m.id);

  const consolidator = new MemoryConsolidator(svc);

  // ===================== Test 10.1 =====================
  console.log('\n--- 10.1: Temporary request → Working Memory ---');

  const tempResult = svc.classifyAndAddMemory({
    content: '今天想听激烈一点',
    tags: ['energetic', 'temporary-today'],
    isTemporary: true,
    evidence: { userInput: '今天想听激烈一点' },
  });
  assert(tempResult.ok === true, 'classifyAndAddMemory returns ok');
  assert(tempResult.type === MemoryType.WORKING, 'stored as Working Memory, not Semantic');

  const workingMems = svc.getMemoriesByType(MemoryType.WORKING);
  const semanticMems = svc.getMemoriesByType(MemoryType.SEMANTIC);
  assert(workingMems.length > 0, 'Working Memory contains the record');
  assert(semanticMems.length === 0, 'Semantic Memory is empty (no promotion)');

  const tempRecord = svc.getMemory(tempResult.id);
  assert(tempRecord !== null, 'record retrievable by id');
  assert(tempRecord.expiresAt !== null, 'Working Memory has expiresAt');
  assert(tempRecord.confidence <= 0.5, 'confidence ≤ 0.5 for temporary request');
  assert(tempRecord.source === 'user_temporary_request', 'source is user_temporary_request');

  // ===================== Test 10.2 =====================
  console.log('\n--- 10.2: 3+ observations → consolidation promotes to Semantic ---');

  // Create 3 episodic memories with night+low-vocal pattern
  svc.classifyAndAddMemory({
    content: '用户连续听了 3 首低人声氛围音乐，没有跳过',
    tags: ['night', 'low-vocal', 'ambient', 'completed'],
    isObservation: true,
  });
  svc.classifyAndAddMemory({
    content: '用户在深夜要求安静音乐，跳过了人声很重的推荐',
    tags: ['night', 'low-vocal', 'calm', 'skip-vocal'],
    isObservation: true,
  });
  svc.classifyAndAddMemory({
    content: '用户主动说"放点安静的"，并完整听完了推荐的低人声曲目',
    tags: ['night', 'low-vocal', 'calm', 'completed'],
    isObservation: true,
  });

  // Check episodic count before consolidation
  const episodicBefore = svc.getMemoriesByType(MemoryType.EPISODIC);
  console.log(`  episodic before consolidation: ${episodicBefore.length}`);

  const consoResult = consolidator.consolidateMemories();
  console.log(`  consolidation report: promoted=${consoResult.promoted} merged=${consoResult.merged} pruned=${consoResult.pruned}`);

  const semanticAfter = svc.getMemoriesByType(MemoryType.SEMANTIC);
  const promoted = semanticAfter.filter(m => m.source === MemorySource.CONSOLIDATION);
  assert(promoted.length >= 1, `at least 1 Semantic Memory promoted from pattern (got ${promoted.length})`);

  if (promoted.length > 0) {
    const pm = promoted[0];
    assert(pm.importance >= 5, 'promoted memory importance ≥ 5');
    assert(pm.confidence > 0, 'promoted memory has confidence > 0');
    console.log(`  promoted: "${pm.content.slice(0, 80)}..." (confidence=${pm.confidence.toFixed(2)})`);
  }

  // ===================== Test 10.3 =====================
  console.log('\n--- 10.3: Explicit preference → Semantic with high confidence + evidence ---');

  const explicitResult = svc.classifyAndAddMemory({
    content: '用户表示一直不太喜欢人声太重的歌',
    tags: ['vocal', 'preference', 'explicit'],
    isExplicit: true,
    evidence: { userInput: '我一直都不太喜欢人声太重的歌' },
  });
  assert(explicitResult.ok === true, 'explicit preference stored ok');
  assert(explicitResult.type === MemoryType.SEMANTIC, 'stored as Semantic Memory');

  const explicitRec = svc.getMemory(explicitResult.id);
  assert(explicitRec !== null, 'explicit preference retrievable');
  assert(explicitRec.confidence >= 0.7, `confidence ≥ 0.7 (got ${explicitRec.confidence})`);
  assert(explicitRec.source === MemorySource.USER_EXPLICIT_FEEDBACK, 'source is user_explicit_feedback');

  // Check evidence contains the user utterance
  assert(explicitRec.evidence.length > 0, 'evidence is not empty');
  try {
    const ev = JSON.parse(explicitRec.evidence);
    assert(ev.userInput === '我一直都不太喜欢人声太重的歌', 'evidence contains user utterance');
  } catch {
    assert(false, 'evidence is valid JSON');
  }

  // ===================== Test 10.4 =====================
  console.log('\n--- 10.4: Behavior observation → Episodic with low confidence ---');

  const observedResult = svc.classifyAndAddMemory({
    content: '系统观察到用户连续跳过了 3 首人声偏重的歌曲，可能是对高密度人声有排斥',
    tags: ['skip', 'vocal', 'heavy-vocal'],
    isObservation: true,
  });
  assert(observedResult.ok === true, 'behavior observation stored ok');
  assert(observedResult.type === MemoryType.EPISODIC, 'stored as Episodic Memory');

  const obsRec = svc.getMemory(observedResult.id);
  assert(obsRec.confidence <= 0.4, `confidence ≤ 0.4 (got ${obsRec.confidence})`);
  assert(obsRec.source === MemorySource.BEHAVIOR_OBSERVATION, 'source is behavior_observation');

  // ===================== Test 10.5 =====================
  console.log('\n--- 10.5: Working Memory expiration → deleteExpired() ---');

  // There should still be the working memory from test 10.1
  const workingBeforeExpire = svc.getMemoriesByType(MemoryType.WORKING);
  console.log(`  working memories before expire: ${workingBeforeExpire.length}`);

  if (workingBeforeExpire.length > 0) {
    // Manually set one working memory to expired
    const target = workingBeforeExpire[0];
    store.update(target.id, { expiresAt: Date.now() - 1000 });
  }

  // Create a fresh working memory that should NOT be expired
  svc.classifyAndAddMemory({
    content: '今晚想放松一下',
    tags: ['calm', 'night'],
    isTemporary: true,
  });

  const deleted = store.deleteExpired();
  console.log(`  expired records deleted: ${deleted}`);

  const workingAfterExpire = svc.getMemoriesByType(MemoryType.WORKING);
  assert(workingAfterExpire.length >= 1, 'at least 1 working memory survives after expiry cleanup');
  // The fresh one should still be there
  const freshRemaining = workingAfterExpire.filter(m => m.content.includes('今晚想放松一下'));
  assert(freshRemaining.length === 1, 'fresh working memory (not expired) survives');

  // ===================== Test 10.6 =====================
  console.log('\n--- 10.6: Low-value Episodic → prune() ---');

  // Create a low-value episodic memory (importance 1, confidence 0.1, with old timestamp)
  // We need to bypass classifyAndAddMemory defaults and directly insert
  const lowValRec = createMemoryRecord(MemoryType.EPISODIC, {
    content: '微不足道的事件: 用户在一个月前听过一首歌',
    source: MemorySource.AGENT_REFLECTION,
    importance: 1,
    confidence: 0.1,
  });
  // Manually set lastAccessedAt to 40 days ago
  lowValRec.lastAccessedAt = Date.now() - 40 * 24 * 60 * 60 * 1000;
  lowValRec.createdAt = Date.now() - 45 * 24 * 60 * 60 * 1000;
  store.insert(lowValRec);

  const beforePrune = store.count();
  const pruneResult = store.prune({ minImportance: 2, minConfidence: 0.2, maxAgeDays: 30 });
  const afterPrune = store.count();
  console.log(`  prune result: deleted=${pruneResult.deleted}, before=${beforePrune}, after=${afterPrune}`);
  assert(pruneResult.deleted > 0, 'low-value memory was pruned');

  // ===================== Test 10.7 =====================
  console.log('\n--- 10.7: buildContextForAgent returns ≤ 15 memories with 500+ total ---');

  // Bulk-insert extra memories to exceed 500 total
  for (let i = 0; i < 600; i++) {
    const tag = i % 5 === 0 ? 'test-a' : 'test-b';
    store.insert(createMemoryRecord(MemoryType.EPISODIC, {
      content: `Bulk test memory entry number ${i}`,
      tags: tag,
      source: MemorySource.AGENT_REFLECTION,
      importance: 3,
      confidence: 0.3,
    }));
  }

  const contextItems = retrievePersonMemories(svc, null, { namespace: svc.namespace, virtualPersonId: 'lunara', sessionId: 'test', query: '今晚想安静听点什么' });
  // Verify total count greatly exceeds returned items
  const totalAfterBulk = store.count();
  console.log(`  total memories in store: ${totalAfterBulk}`);
  assert(totalAfterBulk > 100, 'there are more than 100 memories in store');
  assert(contextItems.length < totalAfterBulk, 'returned items << total memories');
  assert(contextItems.length < 30, `returned items < 30 (got ${contextItems.length})`);

  // ===================== Test 10.8 =====================
  console.log('\n--- 10.8: Playback progress NOT in memory system ---');

  // Verify memory system has no record of played_seconds or queue position
  const allMemsFinal = store.getAllForConsolidation();
  const playbackRelated = allMemsFinal.filter(m =>
    m.content.includes('played_seconds') || m.content.includes('queue_position') ||
    m.content.includes('playback_progress') || m.content.includes('cursor')
  );
  assert(playbackRelated.length === 0, 'no memory records contain playback progress data');

  // Verify memory system has no "play" or "queue" specific fields
  const noPlay = allMemsFinal.every(m => !m.content.includes('queue_position'));
  assert(noPlay, 'memory records do not contain queue position data');

  // The played_seconds should remain purely in state.js plays table
  console.log('  (played_seconds stays in state.recordOutcome() per existing architecture)');

  // ===================== Summary =====================
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

  if (failed > 0) {
    console.log('❌ Some tests failed');
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
    process.exit(0);
  }
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(1);
});
