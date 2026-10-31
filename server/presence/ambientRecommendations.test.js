import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createAmbientRecommendations, RECOMMENDATION_LIMITS } from './ambientRecommendations.js';

const MIN = 60_000;
const item = (songId = '2') => ({ selectionId: `selection:${songId}`, provider: 'qq', songId, title: `歌${songId}`, artist: '歌手' });

function harness(t, { source = 'room', quiet = false, music = {} } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  let nowMs = Date.UTC(2026, 9, 20, 2, 0, 0);
  const snapshot = { activeListeningSessionId: source };
  const accepts = [];
  const service = {
    acceptRecommendation: async input => {
      accepts.push(input);
      if (music.accept) return music.accept(input);
      return { ok: true, code: 'MUSIC_COMMITTED', delivery: 'after_current', tracks: [{ songId: '2' }] };
    },
  };
  const rooms = { room: { sessionId: 'room', memberIds: ['a', 'b'], activeVirtualPersonId: 'a' },
    solo: { sessionId: 'solo', memberIds: ['a'], activeVirtualPersonId: 'a' } };
  const events = [];
  const recs = createAmbientRecommendations({ db, now: () => nowMs, timeZone: 'Asia/Shanghai',
    getMusicService: () => service, playbackRuntime: { snapshot: () => snapshot },
    conversationStore: { getSession: id => rooms[id] || null },
    trace: (sessionId, event) => events.push({ sessionId, ...event }),
    listenerQuiet: sessionId => quiet && sessionId === 'room' });
  return { recs, db, snapshot, accepts, events, advance: ms => { nowMs += ms; }, now: () => nowMs };
}
const wake = (extra = {}) => ({ id: 'w', reason: 'heartbeat', ...extra });

test('闸门：一起听的当前来源、未安静、无 pending、间隔与每日上限都满足才开', t => {
  const h = harness(t);
  assert.deepEqual(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake() }), { open: true, reason: null });
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake({ reason: 'app_open' }) }).reason, 'occasion');
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'b', wake: wake({ role: 'follower' }) }).reason, 'role');
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'b', wake: wake({ role: 'invited' }) }).reason, 'role');
  assert.equal(h.recs.gate({ sessionId: 'solo', personId: 'a', wake: wake() }).reason, 'not-listening-source');
});

test('闸门：被要求安静时不开', t => {
  const h = harness(t, { quiet: true });
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake() }).reason, 'quiet');
});

test('闸门：已有 pending、30 分钟内推荐过、当地一天已满 3 次时都不开', t => {
  const h = harness(t);
  h.recs.record({ turnId: 'presence:w1', sessionId: 'room', personId: 'a', item: item('1') });
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake() }).reason, 'pending');
  h.advance(RECOMMENDATION_LIMITS.ttlMs);
  assert.equal(h.recs.view('presence:w1').status, 'expired', '过期是惰性判定的');
  h.advance(-1);
  h.recs.expireSession('room');
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake() }).reason, 'interval');
  h.advance(1 + RECOMMENDATION_LIMITS.minIntervalMs - RECOMMENDATION_LIMITS.ttlMs);
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake() }).open, true);
  for (const id of ['w2', 'w3']) {
    h.recs.record({ turnId: `presence:${id}`, sessionId: 'room', personId: 'a', item: item(id) });
    h.recs.expireSession('room');
    h.advance(RECOMMENDATION_LIMITS.minIntervalMs);
  }
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake() }).reason, 'daily-cap');
  h.advance(24 * 60 * MIN);
  assert.equal(h.recs.gate({ sessionId: 'room', personId: 'a', wake: wake() }).open, true, '换了一天重新计数');
});

test('同一聊天新推荐让旧的 pending 过期；视图带推荐人与过期时间', t => {
  const h = harness(t);
  h.recs.record({ turnId: 'presence:old', sessionId: 'room', personId: 'a', item: item('1') });
  const fresh = h.recs.record({ turnId: 'presence:new', sessionId: 'room', personId: 'b', item: item('2') });
  assert.equal(h.recs.view('presence:old').status, 'expired');
  assert.deepEqual(fresh, { turnId: 'presence:new', sessionId: 'room', selectionId: 'selection:2', provider: 'qq', songId: '2',
    title: '歌2', artist: '歌手', recommendedBy: 'b', status: 'pending', expiresAt: h.now() + RECOMMENDATION_LIMITS.ttlMs });
  assert.equal(h.recs.pending('room').turnId, 'presence:new');
});

test('确认：提交成功才写 queued；提交人是当前主持，推荐人另记', async t => {
  const h = harness(t);
  h.recs.record({ turnId: 'presence:w', sessionId: 'room', personId: 'b', item: item('2') });
  const result = await h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  assert.equal(result.ok, true);
  assert.equal(result.recommendation.status, 'queued');
  assert.deepEqual(h.accepts, [{ sessionId: 'room', turnId: 'presence:w', selectionId: 'selection:2',
    recommenderId: 'b', committerId: 'a' }]);
  const again = await h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  assert.deepEqual([again.ok, again.recommendation.status], [true, 'queued']);
  assert.equal(h.accepts.length, 1, '已排上的不再调用提交');
});

test('确认：并发双击只提交一次，两次结果相同', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness(t, { music: { accept: async () => { await gate; return { ok: true, code: 'MUSIC_COMMITTED' }; } } });
  h.recs.record({ turnId: 'presence:w', sessionId: 'room', personId: 'a', item: item('2') });
  const first = h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  const second = h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(h.accepts.length, 1);
  assert.deepEqual(a, b);
});

test('确认：解析失败写 unavailable，不替歌；runtime 拒绝或忙时保持 pending 可重试', async t => {
  let next = { ok: false, code: 'MUSIC_NOT_COMMITTED', reason: 'resolution failed (qq)' };
  const h = harness(t, { music: { accept: async () => next } });
  h.recs.record({ turnId: 'presence:w', sessionId: 'room', personId: 'a', item: item('2') });
  next = { ok: false, code: 'MUSIC_ACTION_IN_PROGRESS' };
  const busy = await h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  assert.deepEqual([busy.ok, busy.retryable, busy.recommendation.status], [false, true, 'pending']);
  next = { ok: false, code: 'MUSIC_NOT_COMMITTED', reason: 'commit rejected: stale listening queue version' };
  assert.equal((await h.recs.accept({ sessionId: 'room', turnId: 'presence:w' })).recommendation.status, 'pending');
  next = { ok: false, code: 'MUSIC_NOT_COMMITTED', reason: 'resolution failed (qq)' };
  const failed = await h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  assert.deepEqual([failed.ok, failed.code, failed.recommendation.status], [false, 'RECOMMENDATION_UNAVAILABLE', 'unavailable']);
});

test('确认：过期或不是当前听歌来源时拒绝，不调用提交、不切换来源', async t => {
  const h = harness(t);
  h.recs.record({ turnId: 'presence:w', sessionId: 'room', personId: 'a', item: item('2') });
  h.snapshot.activeListeningSessionId = 'solo';
  const notSource = await h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  assert.deepEqual([notSource.ok, notSource.code], [false, 'RECOMMENDATION_NOT_LISTENING_SOURCE']);
  assert.equal(h.snapshot.activeListeningSessionId, 'solo');
  assert.equal(h.recs.view('presence:w').status, 'expired', '换了听歌来源的推荐作废');
  h.snapshot.activeListeningSessionId = 'room';
  h.recs.record({ turnId: 'presence:w2', sessionId: 'room', personId: 'a', item: item('3') });
  h.advance(RECOMMENDATION_LIMITS.ttlMs + 1);
  const expired = await h.recs.accept({ sessionId: 'room', turnId: 'presence:w2' });
  assert.deepEqual([expired.ok, expired.code], [false, 'RECOMMENDATION_NOT_PENDING']);
  assert.equal((await h.recs.accept({ sessionId: 'solo', turnId: 'presence:w2' })).code, 'RECOMMENDATION_NOT_FOUND');
  assert.equal(h.accepts.length, 0);
});

test('trace 只记封闭原因码与 provider/songId，不含歌单、URL 或凭据', async t => {
  const h = harness(t);
  h.recs.record({ turnId: 'presence:w', sessionId: 'room', personId: 'a', item: { ...item('2'), url: 'https://x/secret' } });
  await h.recs.accept({ sessionId: 'room', turnId: 'presence:w' });
  assert.deepEqual(h.events.map(event => event.type), ['ambient_recommendation_recorded', 'recommendation_accept']);
  assert.equal(JSON.stringify(h.events).includes('secret'), false);
  assert.equal(h.events[1].outcome, 'queued');
});
