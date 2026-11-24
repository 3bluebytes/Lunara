import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'r6a-dream-'));
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import(`${ROOT}/memory/MemoryService.js`);
const { StationDreamingService } = await import(`${ROOT}/station/StationDreamingService.js`);
const { registerPersonMemoryTools, retrievePersonMemories } = await import(`${ROOT}/virtual-person/personMemory.js`);

const DAY = 86_400_000;
const registry = { get: id => ({ id, memoryNamespace: `person:${id}` }) };
const conversationStore = { revokeObservation() {}, observersOf() { return []; } };

function tools(memory, dreaming = null) {
  const t = {};
  registerPersonMemoryTools({ register: (n, d) => { t[n] = d; } }, { getMemoryService: () => memory, conversationStore, registry, getDreaming: () => dreaming });
  return t;
}

function original(i, { person = 'a', text = `我喜欢R&B 第${i}次`, at }) {
  return { eventKey: `turn:a${i}`, originalKey: `u${person}${i}`, personId: person, namespace: `person:${person}`,
    sessionId: `s-${person}-${i}`, createdAt: at, kind: 'turn', data: { userTurnId: `u${person}${i}`, userText: text },
    policy: { disclosure: 'normal' } };
}

function insight(memory, ns, claim, originals) {
  return memory.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: claim.text,
    tags: 'reflection-insight,reflection-short', evidence: JSON.stringify({ claim, policy: { disclosure: 'normal' }, originalEvidence: originals }),
    expiresAt: Date.now() + 7 * DAY });
}

const liveStation = (memory, content) => memory.store.db.prepare(
  "SELECT * FROM memories WHERE namespace = 'station' AND content = ? AND (expires_at IS NULL OR expires_at > ?) AND (',' || tags || ',') NOT LIKE '%,revoked,%'")
  .all(content, Date.now());

test('聊天里忘掉已晋升的明确共享偏好：claim 一并撤回，下一次 reconcile 不重新晋升', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  const dreaming = new StationDreamingService({ stationMemoryService: memory }).initialize();
  try {
    const now = Date.now();
    const claim = { key: 'music.genre.rnb', polarity: 'positive', text: '用户喜欢R&B', scope: 'shared_candidate',
      explicitSharedQuote: '告诉所有伙伴我喜欢R&B' };
    // 较早的一次明确共享
    insight(memory, 'person:a', claim, [original(0, { text: '告诉所有伙伴我喜欢R&B', at: now - 10 * DAY })]);
    // 之后十次普通的"我喜欢R&B"
    insight(memory, 'person:a', claim, Array.from({ length: 10 }, (_, i) => original(i + 1, { at: now - 9 * DAY + i * 1000 })));
    dreaming.reconcile();
    const promoted = liveStation(memory, '用户喜欢R&B');
    assert.equal(promoted.length, 1, 'precondition: promoted');
    assert.equal(promoted[0].source, 'user_explicit_feedback');
    const r = tools(memory, dreaming).forget_person_memory.handler({ memoryIds: [promoted[0].id] },
      { virtualPersonId: 'a', sessionId: 's-x', userText: '把这条忘掉吧' });
    assert.equal(r.kind, 'success');
    assert.equal(liveStation(memory, '用户喜欢R&B').length, 0, 'forgotten right after the tool');
    dreaming.reconcile(); // 每小时一次或下一条洞察发布时
    const again = liveStation(memory, '用户喜欢R&B');
    assert.equal(again.length, 0, '用户在聊天里要求忘掉的共享偏好不应被重新晋升');
  } finally { dreaming.shutdown(); await memory.shutdown(); }
});

test('从聊天晋升出的共享推测能在聊天里被忘掉', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  const dreaming = new StationDreamingService({ stationMemoryService: memory }).initialize();
  try {
    memory.store.db.exec("DELETE FROM memories; DELETE FROM station_claims; DELETE FROM station_claim_evidence; DELETE FROM reflection_publications; DELETE FROM station_processed_insights; DELETE FROM memory_revocations;");
    const now = Date.now();
    const claim = { key: 'music.genre.jazz', polarity: 'positive', text: '用户喜欢爵士', scope: 'shared_candidate', explicitSharedQuote: '' };
    insight(memory, 'person:a', claim, [original(1, { person: 'a', text: '我喜欢爵士', at: now - 3 * DAY }),
      original(2, { person: 'a', text: '我还是喜欢爵士', at: now - 2 * DAY })]);
    insight(memory, 'person:b', claim, [original(3, { person: 'b', text: '我喜欢爵士乐', at: now - DAY })]);
    dreaming.reconcile();
    const promoted = liveStation(memory, '用户喜欢爵士');
    assert.equal(promoted.length, 1, 'precondition: promoted');
    assert.equal(promoted[0].source, 'station_seed');
    const injected = retrievePersonMemories(memory, null, { namespace: 'person:c', virtualPersonId: 'c', sessionId: 'sc', query: '' })
      .filter(row => row.id === promoted[0].id);
    assert.equal(injected.length, 1, 'precondition: injected into an unrelated companion with its memoryId');
    const r = tools(memory, dreaming).forget_person_memory.handler({ memoryIds: [promoted[0].id] },
      { virtualPersonId: 'c', sessionId: 'sc', userText: '别再记这个了，忘掉它' });
    assert.equal(r.code, 'PERSON_MEMORY_REVOKED', '从用户聊天推断并注入的共享推测应能在聊天里被忘掉');
  } finally { dreaming.shutdown(); await memory.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
