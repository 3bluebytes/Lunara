import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'lunara-claim-reshare-'));
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import(`${ROOT}/memory/MemoryService.js`);
const { StationDreamingService } = await import(`${ROOT}/station/StationDreamingService.js`);
const { registerPersonMemoryTools } = await import(`${ROOT}/virtual-person/personMemory.js`);

const DAY = 86_400_000;
const registry = { get: id => ({ id, memoryNamespace: `person:${id}` }) };
const claim = { key: 'music.genre.rnb', polarity: 'positive', text: '用户喜欢R&B', scope: 'shared_candidate', explicitSharedQuote: '告诉所有伙伴我喜欢R&B' };
const insight = (memory, turn, at) => memory.addMemory({ namespace: 'person:a', type: 'semantic', source: 'agent_reflection', content: claim.text,
  tags: 'reflection-insight,reflection-short', expiresAt: Date.now() + 7 * DAY,
  evidence: JSON.stringify({ claim, policy: { disclosure: 'normal' }, originalEvidence: [{ eventKey: `turn:${turn}`, originalKey: turn, personId: 'a',
    namespace: 'person:a', sessionId: `s-${turn}`, createdAt: at, kind: 'turn', data: { userTurnId: turn, userText: '告诉所有伙伴我喜欢R&B' },
    policy: { disclosure: 'normal' } }] }) });
const live = memory => memory.store.db.prepare(`SELECT id FROM memories WHERE namespace='station' AND content=? AND expires_at > ?
  AND (',' || tags || ',') NOT LIKE '%,revoked,%'`).all(claim.text, Date.now());

test('after forgetting a promoted shared preference, a later explicit re-share is promoted again', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  const dreaming = new StationDreamingService({ stationMemoryService: memory }).initialize();
  const tools = {};
  registerPersonMemoryTools({ register: (n, d) => { tools[n] = d; } }, { getMemoryService: () => memory, registry,
    conversationStore: { revokeObservation() {}, observersOf: () => [] }, getDreaming: () => dreaming });
  insight(memory, 'u1', Date.now() - 5 * DAY);
  dreaming.reconcile();
  const [promoted] = live(memory);
  assert.ok(promoted, 'precondition: promoted');
  tools.forget_person_memory.handler({ memoryIds: [promoted.id] }, { virtualPersonId: 'a', sessionId: 's-x', userText: '把这条忘掉' });
  assert.equal(live(memory).length, 0);
  // A week later, in a new turn, the user explicitly says it again.
  insight(memory, 'u2', Date.now() + 1000);
  dreaming.reconcile();
  assert.equal(live(memory).length, 1, 'new explicit shared statement (different turn) should be promotable');
  dreaming.shutdown(); await memory.shutdown();
});

test('after forgetting, merely inferred evidence from a later turn does not reopen the claim', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  const dreaming = new StationDreamingService({ stationMemoryService: memory }).initialize();
  const tools = {};
  registerPersonMemoryTools({ register: (n, d) => { tools[n] = d; } }, { getMemoryService: () => memory, registry,
    conversationStore: { revokeObservation() {}, observersOf: () => [] }, getDreaming: () => dreaming });
  insight(memory, 'v1', Date.now() - 5 * DAY);
  dreaming.reconcile();
  const [promoted] = live(memory);
  tools.forget_person_memory.handler({ memoryIds: [promoted.id] }, { virtualPersonId: 'a', sessionId: 's-y', userText: '把这条忘掉' });
  const id = memory.addMemory({ namespace: 'person:a', type: 'semantic', source: 'agent_reflection', content: claim.text,
    tags: 'reflection-insight,reflection-short', expiresAt: Date.now() + 7 * DAY,
    evidence: JSON.stringify({ claim, policy: { disclosure: 'normal' }, originalEvidence: [{ eventKey: 'turn:v2', originalKey: 'v2', personId: 'a',
      namespace: 'person:a', sessionId: 's-v2', createdAt: Date.now() + 1000, kind: 'turn', data: { userTurnId: 'v2', userText: '这首R&B挺好听的' },
      policy: { disclosure: 'normal' } }] }) });
  assert.ok(id);
  dreaming.reconcile();
  assert.equal(live(memory).length, 0);
  assert.equal(memory.store.db.prepare('SELECT status FROM station_claims').get().status, 'revoked');
  dreaming.shutdown(); await memory.shutdown();
});
