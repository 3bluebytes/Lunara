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
  assert.equal(h.dream.candidatePool().length, 0);
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
  assert.equal(h.dream.candidatePool().length, 0);
  assert.equal(h.memory.searchMemory(undefined, { namespace: 'station' }).length, 0);
});

test('来源被删的 claim 文本不随后来的证据晋升', async t => {
  const { forgetLearnedFromSources } = await import('../memory/forgetSources.js');
  const DAY = 86_400_000;
  const dir = mkdtempSync(join(tmpdir(), 'lunara-claim-text-'));
  const memory = new MemoryService('station');
  memory.store = new SQLiteMemoryStore({ dbPath: join(dir, 's.db') }).initialize();
  const now = Date.now();
  const dream = new StationDreamingService({ stationMemoryService: memory, now: () => now }).initialize();
  t.after(() => { dream.shutdown(); memory.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const publish = (person, original, text, at) => {
    const evidence = { claim: { key: 'taste.rnb', polarity: 'positive', text, scope: 'shared_candidate', explicitSharedQuote: '' },
      originalEvidence: [{ eventKey: `turn:${original}`, originalKey: original, personId: person, namespace: `radiohost:${person}`,
        sessionId: `s-${original}`, createdAt: at, kind: 'turn', data: { userText: '我喜欢 R&B' }, policy: {} }] };
    memory.addMemory({ namespace: `radiohost:${person}`, type: 'semantic', source: 'agent_reflection', content: '反思',
      tags: ['reflection-insight'], evidence: JSON.stringify(evidence) });
    dream.reconcile();
  };
  publish('a', 'secret-turn', '用户和前任分手后一直靠 R&B 熬夜', now - DAY);
  memory.store.db.transaction(() => forgetLearnedFromSources(memory.store.db, { turnIds: ['secret-turn'], now }))();
  publish('b', 'u2', '用户喜欢 R&B', now - DAY);
  publish('a', 'u3', '用户喜欢 R&B', now);
  publish('b', 'u4', '用户喜欢 R&B', now);
  const shared = memory.searchMemory(undefined, { namespace: 'station', limit: 10 });
  assert.equal(shared.length, 1);
  assert.equal(shared[0].content, '用户喜欢 R&B');
  assert.ok(!dream.candidatePool().some(row => /前任/.test(row.content)));
});

test('洞察行被删后，发布记录与已处理标记随之清理，已收进的 claim 证据保留', t => {
  const h = fixture(t);
  const id = h.publish({ person: 'a', original: 'gone', session: 'a' });
  const kept = h.publish({ person: 'b', original: 'kept', session: 'b' });
  const count = (table, memoryId) => h.memory.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE memory_id = ?`).get(memoryId).n;
  assert.equal(count('reflection_publications', id), 1);
  h.memory.store.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  h.dream.reconcile();
  assert.equal(count('reflection_publications', id), 0);
  assert.equal(count('station_processed_insights', id), 0);
  assert.equal(count('reflection_publications', kept), 1, '仍在的洞察不受影响');
  assert.equal(h.memory.store.db.prepare('SELECT COUNT(*) AS n FROM station_claim_evidence WHERE original_key = ?').get('gone').n, 1);
});

test('relationship/temporary、非音乐键与亲密互动不进待核对，且历史零合格证据 pending 行在 reconcile 时清理', t => {
  const h = fixture(t);
  const addInsight = (person, key, text, scope, quote) => {
    const id = h.memory.addMemory({
      namespace: `radiohost:${person}`, type: 'semantic', source: 'agent_reflection', content: text,
      tags: ['reflection-insight'],
      evidence: JSON.stringify({
        claim: { key, polarity: 'positive', text, scope, explicitSharedQuote: '' },
        originalEvidence: [{ eventKey: `turn:${person}:${key}`, originalKey: `u:${person}:${key}`, personId: person,
          namespace: `radiohost:${person}`, sessionId: `s:${person}`, createdAt: h.now, kind: 'turn',
          data: { userText: quote }, policy: {} }],
      }),
    }).id;
    return id;
  };
  addInsight('a', 'music.genre.rnb', '用户喜欢 R&B', 'relationship', '我喜欢听 R&B');
  addInsight('a', 'music.genre.jazz', '用户今天喜欢爵士', 'temporary', '我今天喜欢听爵士');
  addInsight('a', 'interaction.intimacy', '用户在互动中主动发起亲昵称呼与肢体亲近', 'shared_candidate', '我很喜欢和你抱抱');
  addInsight('a', 'music.routine', '用户在亲密后休息的场景里会主动要求放点音乐陪伴，但尚未表现出对具体曲风或歌手的偏好。', 'shared_candidate', '我喜欢亲密后放点音乐');
  addInsight('a', 'taste.intimate', '用户在互动中主动发起亲昵称呼与肢体亲近，并表达性幻想内容，倾向于以亲昵方式开启对话', 'shared_candidate', '我喜欢这样亲近你');
  h.dream.reconcile();
  assert.equal(h.dream.candidatePool().length, 0);
  assert.equal(h.memory.store.db.prepare('SELECT COUNT(*) AS n FROM reflection_publications').get().n, 0);

  // 模拟历史版本遗留的零合格证据 pending 行：下次 reconcile 立即清理
  h.memory.store.db.prepare("INSERT INTO station_claims VALUES ('legacy-polluted', 'interaction.intimacy', 'positive', '用户倾向于以亲昵方式开启对话', 'pending', NULL, 1, ?, ?)").run(h.now, h.now);
  h.memory.store.db.prepare("INSERT INTO station_claim_evidence VALUES ('legacy-polluted', 'old-u1', 'a', 999, ?, ?)")
    .run(JSON.stringify({ namespace: 'radiohost:a', sessionId: 's1', scope: 'relationship', claimText: '用户倾向于以亲昵方式开启对话',
      policy: {}, kind: 'turn', quote: '亲爱的抱抱', explicitShared: false, feedback: true, relationshipOnly: false }), h.now);
  h.dream.reconcile();
  assert.equal(h.memory.store.db.prepare('SELECT COUNT(*) AS n FROM station_claims').get().n, 0);
  assert.equal(h.memory.store.db.prepare('SELECT COUNT(*) AS n FROM station_claim_evidence').get().n, 0);
});

test('书名号内包含亲密词的歌曲偏好仍可正常入池与晋升', t => {
  const h = fixture(t);
  const publishSong = (person, original, session, at) => {
    const text = '用户喜欢《亲密爱人》';
    const evidence = {
      claim: { key: 'music.song.qinmi', polarity: 'positive', text, scope: 'shared_candidate', explicitSharedQuote: '' },
      originalEvidence: [{ eventKey: `turn:${original}`, originalKey: original, personId: person, namespace: `radiohost:${person}`,
        sessionId: session, createdAt: at, kind: 'turn', data: { userText: '我特别喜欢《亲密爱人》这首歌' }, policy: {} }],
    };
    h.memory.addMemory({ namespace: `radiohost:${person}`, type: 'semantic', source: 'agent_reflection', content: '反思',
      tags: ['reflection-insight'], evidence: JSON.stringify(evidence) });
    h.dream.reconcile();
  };
  publishSong('a', 's1', 'sa1', h.now - DAY);
  publishSong('b', 's2', 'sb1', h.now - DAY);
  publishSong('a', 's3', 'sa2', h.now);
  const claim = h.dream.candidatePool()[0];
  assert.equal(claim.status, 'promoted');
  assert.equal(h.memory.store.getById(claim.memory_id).content, '用户喜欢《亲密爱人》');
});

test('曾晋升的 claim 若来源全部撤回导致零合格证据，evaluate 撤销共享记忆并标为 expired 保留 revision', t => {
  const h = fixture(t);
  const publishJazz = (person, original, session, at) => {
    const evidence = {
      claim: { key: 'music.genre.jazz', polarity: 'positive', text: '用户喜欢爵士', scope: 'shared_candidate', explicitSharedQuote: '' },
      originalEvidence: [{ eventKey: `turn:${original}`, originalKey: original, personId: person, namespace: `radiohost:${person}`,
        sessionId: session, createdAt: at, kind: 'turn', data: { userText: '我喜欢爵士' }, policy: {} }],
    };
    h.memory.addMemory({ namespace: `radiohost:${person}`, type: 'semantic', source: 'agent_reflection', content: '反思',
      tags: ['reflection-insight'], evidence: JSON.stringify(evidence) });
    h.dream.reconcile();
  };
  publishJazz('a', 'j1', 'sa1', h.now - DAY);
  publishJazz('b', 'j2', 'sb1', h.now - DAY);
  publishJazz('a', 'j3', 'sa2', h.now);
  const promoted = h.dream.candidatePool()[0];
  assert.equal(promoted.status, 'promoted');
  assert.equal(promoted.revision, 1);

  for (const key of ['j1', 'j2', 'j3']) {
    h.memory.store.db.prepare('INSERT INTO memory_revocations (namespace, source_key, created_at) VALUES (?, ?, ?)').run('station', key, h.now);
  }
  h.dream.reconcile();
  const row = h.memory.store.db.prepare('SELECT status, revision, memory_id FROM station_claims WHERE id = ?').get(promoted.id);
  assert.equal(row.status, 'expired');
  assert.equal(row.revision, 1);
  assert.match(h.memory.store.getById(row.memory_id).tags, /revoked/);
});
