import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'lunara-admin-forget-'))
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import(`${ROOT}/memory/MemoryService.js`);
const { MemoryAdminService } = await import(`${ROOT}/services/MemoryAdminService.js`);
const { registerPersonMemoryTools, relationshipFacts } = await import(`${ROOT}/virtual-person/personMemory.js`);
const { isMemoryRevoked } = await import(`${ROOT}/memory/memoryProvenance.js`);
const { retrieveExpressionPreferences } = await import(`${ROOT}/program/narrationContext.js`);
const { MusicSelectionService } = await import(`${ROOT}/program/MusicSelectionService.js`);

const DAY = 86_400_000;
const persons = ['a', 'b'].map(id => ({ id, memoryNamespace: `person:${id}` }));
const registry = { get: id => persons.find(p => p.id === id), list: () => persons };

function setup(memory) {
  const revokedObs = [];
  const conversationStore = { revokeObservation: (p, s) => revokedObs.push(`${p}:${s}`), observersOf: () => ['a', 'b'] };
  const tools = {};
  registerPersonMemoryTools({ register: (n, d) => { tools[n] = d; } }, { getMemoryService: () => memory, conversationStore, registry });
  const admin = new MemoryAdminService({ getStation: () => ({ stationMemory: memory, virtualPersonRegistry: registry }), conversationStore });
  return { tools, admin, revokedObs };
}

function insightFrom(memory, ns, person, turn, text) {
  return memory.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: '用户喜欢R&B',
    tags: 'reflection-insight,reflection-short', expiresAt: Date.now() + 7 * DAY,
    evidence: JSON.stringify({ claim: { key: 'music.genre.rnb', polarity: 'positive', text: '用户喜欢R&B' }, policy: { disclosure: 'normal' },
      originalEvidence: [{ originalKey: turn, personId: person, namespace: ns, data: { userTurnId: turn, userText: text } }] }) }).id;
}

for (const path of ['chat', 'admin']) {
  test(`[${path}] forgetting a shared fact also invalidates observers' reflections from the same quote`, async () => {
    const memory = new MemoryService('station');
    await memory.initialize();
    memory.store.db.exec('DELETE FROM memories; DELETE FROM memory_revocations;');
    const { tools, admin, revokedObs } = setup(memory);
    const text = '告诉所有伙伴我喜欢R&B';
    const r = tools.remember_shared_fact.handler({ content: '用户喜欢R&B', sourceQuote: text },
      { virtualPersonId: 'a', sessionId: 's1', userTurnId: `u-${path}`, userText: text });
    const sharedId = r.facts.memoryId;
    const insightB = insightFrom(memory, 'person:b', 'b', `u-${path}`, text);
    if (path === 'chat') tools.forget_person_memory.handler({ memoryIds: [sharedId] }, { virtualPersonId: 'a', sessionId: 's1', userText: '把这条忘掉' });
    else admin.updateMemory(sharedId, { forget: true });
    assert.equal(isMemoryRevoked(memory.store, memory.store.getById(insightB)), true, "b's reflection from the forgotten quote must be revoked");
    assert.ok(revokedObs.includes(`b:u-${path}`), 'observer b observation must be revoked');
    await memory.shutdown();
  });
}

test('[admin] editing a fact that superseded an older one must not resurrect the older fact', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  memory.store.db.exec('DELETE FROM memories; DELETE FROM memory_revocations;');
  const { tools, admin } = setup(memory);
  const a = tools.remember_person_fact.handler({ content: '用户住在巴黎', sourceQuote: '我住在巴黎' },
    { virtualPersonId: 'a', sessionId: 's1', userTurnId: 'u1', userText: '我住在巴黎' }).facts.memoryId;
  const b = tools.remember_person_fact.handler({ content: '用户搬到了柏林', sourceQuote: '我搬到柏林了', replacesMemoryIds: [a] },
    { virtualPersonId: 'a', sessionId: 's1', userTurnId: 'u2', userText: '我搬到柏林了' }).facts.memoryId;
  admin.updateMemory(b, { content: '用户搬到了柏林米特区' });
  const live = relationshipFacts(memory, { namespace: 'person:a', sessionId: 's1' }).kept.map(row => row.content);
  assert.ok(!live.includes('用户住在巴黎'), 'superseded old fact came back next to the correction');
  await memory.shutdown();
});

test('[admin] forgetting a fact that superseded an older one does not resurrect the older fact', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  memory.store.db.exec('DELETE FROM memories; DELETE FROM memory_revocations;');
  const { tools, admin } = setup(memory);
  const a = tools.remember_person_fact.handler({ content: '用户住在巴黎', sourceQuote: '我住在巴黎' },
    { virtualPersonId: 'a', sessionId: 's1', userTurnId: 'u1', userText: '我住在巴黎' }).facts.memoryId;
  const b = tools.remember_person_fact.handler({ content: '用户搬到了柏林', sourceQuote: '我搬到柏林了', replacesMemoryIds: [a] },
    { virtualPersonId: 'a', sessionId: 's1', userTurnId: 'u2', userText: '我搬到柏林了' }).facts.memoryId;
  admin.updateMemory(b, { forget: true });
  const live = relationshipFacts(memory, { namespace: 'person:a', sessionId: 's1' }).kept.map(row => row.content);
  assert.deepEqual(live, [], 'forgetting the move is not the same as "still lives in Paris"');
  await memory.shutdown();
});

test('[admin] editing an expression preference keeps it an expression preference', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  memory.store.db.exec('DELETE FROM memories; DELETE FROM memory_revocations;');
  const { tools, admin } = setup(memory);
  const id = tools.remember_person_fact.handler({ content: '结尾别加“亲爱的”', sourceQuote: '结尾别加亲爱的', kind: 'expression' },
    { virtualPersonId: 'a', sessionId: 's1', userTurnId: 'u1', userText: '结尾别加亲爱的' }).facts.memoryId;
  assert.equal(retrieveExpressionPreferences(memory, { namespace: 'person:a', sessionId: 's1' }).length, 1, 'precondition');
  admin.updateMemory(id, { content: '结尾别加“亲爱的”或“宝贝”' });
  const prefs = retrieveExpressionPreferences(memory, { namespace: 'person:a', sessionId: 's1' });
  assert.equal(prefs.length, 1, 'corrected expression preference no longer reaches narration');
  await memory.shutdown();
});

test('[admin] editing the wording of a dislike keeps the song excluded from recommendations', async () => {
  const memory = new MemoryService('station');
  await memory.initialize();
  memory.store.db.exec('DELETE FROM memories; DELETE FROM memory_revocations;');
  const { admin } = setup(memory);
  const id = memory.addMemory({ namespace: 'person:a', type: 'semantic', source: 'user_explicit_feedback', importance: 7, confidence: 0.7,
    content: '用户与我一起听歌时，对 A《T》的反馈：不喜欢。原话：这首别放了', tags: ['person-relationship', 'music-feedback', 'song:123'],
    evidence: JSON.stringify({ writeKey: 'k1', sourceTurnId: 'u1', songId: '123', source: 'qq', sentiment: 'dislike', quote: '这首别放了', policy: { disclosure: 'normal' } }) }).id;
  const exclusion = () => MusicSelectionService.prototype._recommendationExclusion.call(
    { now: () => Date.now(), getRecentPlays: () => [], getMemoryService: () => memory },
    { source: 'qq', songId: '123' }, { sessionId: 's1', entity: { memoryNamespace: 'person:a' }, listening: { queue: [] } });
  assert.equal(exclusion(), 'disliked', 'precondition');
  admin.updateMemory(id, { content: '用户很不喜欢 A《T》，觉得太吵' });
  assert.equal(exclusion(), 'disliked');
  await memory.shutdown();
});
