import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { RecommendationDecisionStore, RecommendationOutcomeBridge, sanitizeDecisionFeatures, decisionPath,
  buildDecisionRows, DECISION_RETENTION_MS } from './recommendationDecisions.js';
import { classifyPlaybackTransition } from '../playback/playbackOutcome.js';

function storeFixture(t, { now = () => 1_000_000_000_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-decisions-'));
  const db = new Database(join(dir, 'state.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, store: new RecommendationDecisionStore({ db, now }) };
}

const row = (overrides = {}) => ({ sessionId: 'room', personId: 'a', path: 'auto_continue', offerId: 'offer-1',
  candidateIndex: 1, windowRank: 1, windowSize: 20, provider: 'qq', songId: '1', features: {},
  queueItemId: 'q-1', outputGeneration: 0, programId: 'p-1', ...overrides });

test('initialize creates the ledger and prunes rows older than 180 days', t => {
  let clock = 1_000_000_000_000;
  const { db, store } = storeFixture(t, { now: () => clock });
  store.record([row({ songId: 'old' })]);
  clock += DECISION_RETENTION_MS - 1000;
  store.record([row({ songId: 'recent' })]);
  clock += 2 * 24 * 60 * 60 * 1000; // old row is now 181 days old
  const fresh = new RecommendationDecisionStore({ db, now: () => clock });
  fresh.initialize();
  assert.deepEqual(db.prepare('SELECT song_id FROM music_recommendation_decisions').all().map(r => r.song_id), ['recent']);
});

test('outcomes join only by queue occurrence and never overwrite a final outcome', t => {
  const { db, store } = storeFixture(t);
  store.record([row({ queueItemId: 'q-1' }), row({ queueItemId: 'q-2', candidateIndex: 2 })]);
  assert.equal(store.applyOutcome({ queueItemId: 'q-2', outcome: 'completed', playedSeconds: 200 }), 1);
  assert.equal(store.applyOutcome({ queueItemId: 'q-2', outcome: 'skipped' }), 0, '最终结果不被覆盖');
  assert.equal(store.applyOutcome({ queueItemId: 'missing', outcome: 'completed' }), 0, '身份对不上就保持为空');
  const outcomes = Object.fromEntries(db.prepare('SELECT queue_item_id, outcome FROM music_recommendation_decisions').all()
    .map(r => [r.queue_item_id, r.outcome]));
  assert.deepEqual(outcomes, { 'q-1': null, 'q-2': 'completed' }, '同歌不同 occurrence 不串号');
});

test('superseded is provisional: a later final outcome replaces it, nothing replaces a final one with superseded', t => {
  const { db, store } = storeFixture(t);
  store.record([row({ queueItemId: 'q-1' }), row({ queueItemId: 'q-2' })]);
  store.applyOutcome({ queueItemId: 'q-1', outcome: 'superseded' });
  store.applyOutcome({ queueItemId: 'q-1', outcome: 'completed' });
  store.applyOutcome({ queueItemId: 'q-2', outcome: 'skipped' });
  store.applyOutcome({ queueItemId: 'q-2', outcome: 'superseded' });
  const outcomes = db.prepare('SELECT queue_item_id, outcome FROM music_recommendation_decisions ORDER BY id').all().map(r => r.outcome);
  assert.deepEqual(outcomes, ['completed', 'skipped']);
});

test('feature snapshots keep only whitelisted structured fields（1.5 结构断言）', () => {
  const clean = sanitizeDecisionFeatures({
    mode: 'discovery', origin: 'qq:library', tags: ['rnb', '夜晚'], freshness: 0.8, probe: false,
    scoreParts: { taste: 1.5, freshness: 3, note: 'text' },
    brief: '用户说过很喜欢深夜听 R&B……', memory: '她上周提到失眠', userQuote: '我想听点安静的',
    reason: '这是一段很长很长的、像是模型自由文本解释的理由，超过了短枚举的长度限制，不能进入账本快照。',
  });
  assert.deepEqual(clean, { mode: 'discovery', origin: 'qq:library', tags: ['rnb', '夜晚'], freshness: 0.8,
    probe: false, scoreParts: { taste: 1.5, freshness: 3 } });
  const text = JSON.stringify(clean);
  for (const leaked of ['深夜听', '失眠', '安静的', '自由文本']) assert.equal(text.includes(leaked), false);
});

test('decision path follows proposal > recommend_only > prepared > continuation > task > chat', () => {
  assert.equal(decisionPath({ proposal: true, delivery: 'append' }), 'group_proposal');
  assert.equal(decisionPath({ delivery: 'recommend_only', reason: 'auto_continue' }), 'recommend_only');
  assert.equal(decisionPath({ prepared: true, reason: 'auto_continue' }), 'prepared');
  assert.equal(decisionPath({ reason: 'auto_continue', task: true }), 'auto_continue');
  assert.equal(decisionPath({ reason: 'manual_next', task: true }), 'manual_next');
  assert.equal(decisionPath({ reason: 'user_request', task: true }), 'selection_task');
  assert.equal(decisionPath({ reason: 'user_request' }), 'chat');
});

test('rows skip indexes that did not survive resolution and match occurrences by identity', () => {
  const offer = { offerId: 'o', candidates: [{ source: 'qq', songId: '1' }, { source: 'qq', songId: '2' }, { source: 'netease', songId: '1' }] };
  const snapshot = { queue: [{ queueItemId: 'old', programId: 'other', source: 'qq', songId: '1' },
    { queueItemId: 'q-a', programId: 'p', source: 'netease', songId: '1' }],
  suspendedSessions: {} };
  const rows = buildDecisionRows({ offer, indexes: [3, 2], committedTracks: [{ source: 'netease', songId: '1' }],
    snapshot, programId: 'p', path: 'chat', sessionId: 'room', personId: 'a', outputGeneration: 3 });
  assert.deepEqual(rows.map(r => [r.candidateIndex, r.provider, r.songId, r.queueItemId, r.outputGeneration]),
    [[3, 'netease', '1', 'q-a', 3]], '解析失败的序号 2 不写，旧 program 的同 songId occurrence 不被借用');
  const recommended = buildDecisionRows({ offer, indexes: [1], committedTracks: [{ source: 'qq', songId: '1' }],
    snapshot, programId: 'p', path: 'recommend_only', sessionId: 'room', personId: 'a' });
  assert.equal(recommended[0].queueItemId, null);
  assert.equal(recommended[0].programId, null);
});

test('session switch while playing classifies as superseded; reflection-visible outcomes are unchanged', () => {
  const track = { queueItemId: 'q-1', songId: '1', programId: 'p' };
  const previous = { queue: [track], currentIndex: 0, txn: { correlationId: 'c' }, phase: 'playing', activeListeningSessionId: 'room' };
  const switched = classifyPlaybackTransition({ ...previous, activeListeningSessionId: 'other' },
    { type: 'LISTENING_SESSION_SWITCH_REQUESTED' }, previous);
  assert.equal(switched.outcome, 'superseded');
  const idle = classifyPlaybackTransition({ ...previous, activeListeningSessionId: 'other' },
    { type: 'LISTENING_SESSION_SWITCH_REQUESTED' }, { ...previous, phase: 'idle' });
  assert.equal(idle, null, '没在放的歌切走不算任何结果');
});

test('outcome bridge forwards only classified transitions with an occurrence', () => {
  const applied = [];
  const bridge = new RecommendationOutcomeBridge({ getStore: () => ({ applyOutcome: value => { applied.push(value); return 1; } }) });
  const track = { queueItemId: 'q-1', songId: '1', programId: 'p' };
  const previous = { queue: [track], currentIndex: 0, txn: { correlationId: 'c' }, phase: 'playing', activeListeningSessionId: 'room' };
  bridge.observe({ ...previous, txn: { correlationId: 'c2' } },
    { type: 'TRACK_ENDED', natural: true, songId: '1', programId: 'p', correlationId: 'c', playedSeconds: 180 }, previous);
  bridge.observe({ ...previous, txn: { correlationId: 'c2' } },
    { type: 'TRACK_ENDED', natural: true, songId: '1', programId: 'p', correlationId: 'stale' }, previous);
  assert.deepEqual(applied, [{ queueItemId: 'q-1', outcome: 'completed', playedSeconds: 180 }]);
});
