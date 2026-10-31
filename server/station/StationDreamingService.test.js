import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteMemoryStore } from '../memory/MemoryStore.js';
import { MemoryService } from '../memory/MemoryService.js';
import { StationDreamingService } from './StationDreamingService.js';
import { revokeMemory } from '../memory/memoryProvenance.js';

const DAY = 86_400_000;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-dreaming-'));
  const memory = new MemoryService('station'); memory.store = new SQLiteMemoryStore({ dbPath: join(dir, 'state.db') }).initialize();
  const now = Date.now();
  let dream = new StationDreamingService({ stationMemoryService: memory, now: () => now }).initialize();
  let seq = 0;
  t.after(() => { dream.shutdown(); memory.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const publish = ({ key = 'taste.rnb', person = 'a', original = `u${++seq}`, session = person, quote = '我喜欢 R&B', scope = 'shared_candidate', explicit = '', polarity = 'positive', at = now } = {}) => {
    const evidence = { claim: { key, polarity, text: polarity === 'negative' ? '用户不喜欢 R&B' : '用户喜欢 R&B', scope, explicitSharedQuote: explicit },
      originalEvidence: [{ eventKey: `turn:${seq}`, originalKey: original, personId: person, namespace: `radiohost:${person}`,
        sessionId: session, createdAt: at, kind: 'turn', data: { userText: quote }, policy: {} }] };
    const row = memory.addMemory({ namespace: `radiohost:${person}`, type: 'semantic', source: 'agent_reflection',
      content: '反思', tags: ['reflection-insight'], evidence: JSON.stringify(evidence) });
    // Intentionally no notification or publication record: startup/periodic reconciliation must recover it.
    dream.reconcile(); return row.id;
  };
  return { memory, now, publish, get dream() { return dream; }, restart() {
    dream.shutdown(); dream = new StationDreamingService({ stationMemoryService: memory, now: () => now }).initialize();
  } };
}

test('two radiohosts seeing the same user turn count one evidence group; repeated notifications and restart do not inflate it', t => {
  const h = fixture(t);
  h.publish({ person: 'a', original: 'same', session: 'group', at: h.now - DAY });
  h.publish({ person: 'b', original: 'same', session: 'group', at: h.now - DAY });
  h.dream.reconcile(); h.restart();
  assert.equal(h.dream.candidatePool()[0].status, 'pending');
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'station' }).length, 0);
  h.publish({ person: 'b', original: 'u2', session: 'b', at: h.now });
  h.publish({ person: 'a', original: 'u3', session: 'a', at: h.now });
  const claim = h.dream.candidatePool()[0];
  assert.equal(claim.status, 'promoted');
  const shared = h.memory.store.getById(claim.memory_id);
  assert.equal(shared.confidence, 0.6); assert.ok(shared.expiresAt <= h.now + 30 * DAY);
  h.restart(); h.dream.reconcile();
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'station' }).length, 1);
});

test('relationship-limited R&B remains private even if a model labels it shared or explicit', t => {
  const h = fixture(t);
  for (let n = 0; n < 5; n++) h.publish({ person: n % 2 ? 'b' : 'a', session: `s${n}`, original: `u${n}`,
    at: h.now - (n % 2) * DAY, quote: '我只和你一起听 R&B，特别喜欢', explicit: '所有伙伴都要知道我喜欢 R&B' });
  assert.equal(h.dream.candidatePool()[0].status, 'pending');
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'station' }).length, 0);
});

test('verified universal preference promotes once; correction survives old publications and expired-memory cleanup', t => {
  const h = fixture(t);
  const quote = '所有伙伴都可以知道，我喜欢 R&B';
  h.publish({ quote, explicit: quote });
  const claim = h.dream.candidatePool()[0]; assert.equal(claim.status, 'promoted');
  assert.equal(h.dream.revoke(claim.id), true);
  h.memory.store.deleteExpired('station');
  h.restart(); h.publish({ person: 'b', quote, explicit: quote });
  assert.equal(h.dream.candidatePool()[0].status, 'revoked');
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'station' }).length, 0);
});

test('conflicting observations stop promotion; a newer explicit shared correction wins across restart', t => {
  const h = fixture(t);
  for (const [person, at] of [['a', h.now - DAY], ['b', h.now], ['a', h.now]]) h.publish({ person, at });
  assert.equal(h.dream.candidatePool().find(row => row.polarity === 'positive').status, 'promoted');
  h.publish({ person: 'b', polarity: 'negative', quote: '我不喜欢 R&B', at: h.now });
  assert.ok(h.dream.candidatePool().every(row => row.status === 'pending'));
  const quote = '告诉所有伙伴，我现在不喜欢 R&B';
  h.publish({ person: 'b', polarity: 'negative', quote, explicit: quote, at: h.now });
  h.restart();
  const claims = h.dream.candidatePool();
  assert.equal(claims.find(row => row.polarity === 'negative').status, 'promoted');
  assert.equal(claims.find(row => row.polarity === 'positive').status, 'pending');
});

test('withdrawing an explicit shared source prevents another person reflecting it back into station memory', t => {
  const h = fixture(t);
  const quote = '所有伙伴都可以知道，我喜欢 R&B';
  const saved = h.memory.addMemory({ namespace: 'station', type: 'semantic', source: 'user_explicit_feedback',
    content: quote, evidence: JSON.stringify({ sourceTurnId: 'withdrawn-turn', quote }) });
  revokeMemory(h.memory.store, saved.id, h.now);
  h.publish({ person: 'b', original: 'withdrawn-turn', quote, explicit: quote });
  h.restart();
  assert.equal(h.dream.candidatePool()[0].status, 'pending');
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'station' }).length, 0);
});
