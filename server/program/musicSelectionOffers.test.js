import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { MusicSelectionOfferStore, musicSelectionOfferTtlMs, normalizeOfferCandidates, normalizeOfferIndexes } from './musicSelectionOffers.js';
import { OFFER_MAX_CANDIDATES, OFFER_DEFAULT_TTL_MS } from './musicSelectionOffers.js';

function fixture(t, { now = Date.now, ttlMs = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-offers-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  const offers = new MusicSelectionOfferStore({ db: store.db, now, ttlMs });
  offers.initialize();
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return offers;
}

const candidates = [1, 2, 3].map(id => ({ songId: String(id), title: `歌${id}`, artist: '歌手', source: 'qq', album: '录音室', duration: 180 }));

test('候选规范化为 1 起始的 canonical 身份，最多 60 首', () => {
  const many = Array.from({ length: 65 }, (_, index) => ({ song_id: `s${index}`, title: `歌${index}`, artist: '歌手', source: 'qq:library' }));
  const normalized = normalizeOfferCandidates(many);
  assert.equal(normalized.length, OFFER_MAX_CANDIDATES);
  assert.deepEqual(normalized[0], { index: 1, source: 'qq', songId: 's0', title: '歌0', artist: '歌手', album: '', duration: 0 });
  assert.equal(normalized.at(-1).index, OFFER_MAX_CANDIDATES);
});

test('序号必须互不重复且在候选范围内', () => {
  assert.deepEqual(normalizeOfferIndexes([3, 1], 3), [1, 3]);
  assert.equal(normalizeOfferIndexes([1, 1], 3), null, '重复序号被拒绝');
  assert.equal(normalizeOfferIndexes([0], 3), null);
  assert.equal(normalizeOfferIndexes([4], 3), null);
  assert.equal(normalizeOfferIndexes([1.5], 3), null);
  assert.equal(normalizeOfferIndexes([], 3), null);
  assert.equal(normalizeOfferIndexes(Array.from({ length: 11 }, (_, index) => index + 1), 20), null);
});

test('offer 落库后可按 id 读回，单次认领与消费保持不可逆', (t) => {
  const offers = fixture(t);
  const offer = offers.create({ sessionId: 'room', personId: 'a', requestId: 'req-1', membershipToken: 7,
    membershipRevision: 3, request: { mode: 'discovery', delivery: 'append', count: 2 }, candidates });
  assert.match(offer.offerId, /^offer:/);
  assert.equal(offer.status, 'open');
  assert.equal(offer.expiresAt - offer.createdAt, OFFER_DEFAULT_TTL_MS, '默认 TTL 10 分钟');
  assert.deepEqual(offer.candidates, candidates.map((item, index) => ({ index: index + 1, ...item })));
  assert.equal(offers.get('missing'), null);

  assert.equal(offers.claim(offer.offerId), true);
  assert.equal(offers.claim(offer.offerId), false, '同一 offer 不能被认领两次');
  const claimed = offers.get(offer.offerId);
  assert.equal(claimed.status, 'claimed');
  assert.equal(offers.release(offer.offerId), true, '无副作用的失败可以放回 open');
  assert.equal(offers.claim(offer.offerId), true);
  assert.equal(offers.consume(offer.offerId, { ok: true, code: 'MUSIC_COMMITTED' }), true);
  const consumed = offers.get(offer.offerId);
  assert.equal(consumed.status, 'consumed');
  assert.deepEqual(consumed.result, { ok: true, code: 'MUSIC_COMMITTED' });
  assert.equal(offers.claim(offer.offerId), false, '已消费的 offer 永远不能再认领');
  assert.equal(offers.release(offer.offerId), false);
});

test('过期时间可配置，过期行在保留窗口之后被清理', (t) => {
  let now = 1_000_000;
  const offers = fixture(t, { now: () => now, ttlMs: 60_000 });
  const offer = offers.create({ sessionId: 'room', personId: 'a', request: { mode: 'discovery' }, candidates });
  assert.equal(offer.expiresAt, now + 60_000);
  now += 61_000;
  assert.equal(offers.get(offer.offerId)?.status, 'open', '过期判定由调用方按 expiresAt 完成，行仍在');
  now += 10 * 60_000;
  offers.create({ sessionId: 'room', personId: 'a', request: { mode: 'discovery' }, candidates });
  assert.equal(offers.get(offer.offerId), null, '超过保留窗口的过期行会被清理');
});

test('MUSIC_SELECTION_OFFER_TTL_MS 可覆盖默认 TTL，过小/非法值回落到默认', () => {
  assert.equal(musicSelectionOfferTtlMs({ MUSIC_SELECTION_OFFER_TTL_MS: '60000' }), 60_000);
  assert.equal(musicSelectionOfferTtlMs({ MUSIC_SELECTION_OFFER_TTL_MS: '1000' }), OFFER_DEFAULT_TTL_MS);
  assert.equal(musicSelectionOfferTtlMs({ MUSIC_SELECTION_OFFER_TTL_MS: 'nope' }), OFFER_DEFAULT_TTL_MS);
  assert.equal(musicSelectionOfferTtlMs({}), OFFER_DEFAULT_TTL_MS);
});

// ---- 预热：prepared 状态与 preparedFor 窄放宽 ----

const { MusicSelectionPreparedStore, musicSelectionPreparedTtlMs, prewarmBatchKey, PREPARED_DEFAULT_TTL_MS } =
  await import('./musicSelectionOffers.js');
const preparedFixture = (t, { now = Date.now, ttlMs = null, maxPerContext = null } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-prepared-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  const prepared = new MusicSelectionPreparedStore({ db: store.db, now, ttlMs,
    ...(maxPerContext == null ? {} : { maxPerContext }) });
  prepared.initialize();
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return prepared;
};

test('prepared 挂起只在同源 preparedFor 下可认领，普通认领被拒绝', (t) => {
  const offers = fixture(t);
  const offer = offers.create({ sessionId: 'room', personId: 'a', requestId: 'prep-1',
    request: { mode: 'discovery', delivery: 'append', count: 2 }, candidates });
  assert.equal(offers.holdForPreparation(offer.offerId, { indexes: [2, 1],
    preparedFor: { listeningSessionId: 'room', outputGeneration: 3, boundaryKey: null } }), true);
  const held = offers.get(offer.offerId);
  assert.equal(held.status, 'prepared');
  assert.deepEqual(held.preparedFor, { listeningSessionId: 'room', outputGeneration: 3, boundaryKey: null });
  assert.deepEqual(held.result, { ok: true, code: 'MUSIC_CANDIDATES_SELECTED', indexes: [2, 1] });
  assert.equal(offers.claim(offer.offerId), false, 'prepared offer 不能走普通认领');
  assert.equal(offers.claim(offer.offerId, { prepared: true }), true);
  assert.equal(offers.get(offer.offerId).status, 'claimed');
  // 无副作用的失败回到 prepared（而不是 open）：普通对话提交捡不到它。
  assert.equal(offers.release(offer.offerId, { toPrepared: true }), true);
  assert.equal(offers.get(offer.offerId).status, 'prepared');
  assert.equal(offers.claim(offer.offerId), false);
  assert.equal(offers.claim(offer.offerId, { prepared: true }), true);
  assert.equal(offers.consume(offer.offerId, { ok: true }), true);
  assert.equal(offers.claim(offer.offerId, { prepared: true }), false, '单次使用');
});

test('expiresAt 只增不减（预热批次等待消费时对齐 TTL）', (t) => {
  let now = 1_000_000;
  const offers = fixture(t, { now: () => now, ttlMs: 60_000 });
  const offer = offers.create({ sessionId: 'room', personId: 'a', request: { mode: 'discovery' }, candidates });
  assert.equal(offers.extend(offer.offerId, { expiresAt: now + 10_000 }), true);
  assert.equal(offers.get(offer.offerId).expiresAt, now + 60_000, '更短的有效期不改写');
  assert.equal(offers.extend(offer.offerId, { expiresAt: now + 5 * 60_000 }), true);
  assert.equal(offers.get(offer.offerId).expiresAt, now + 5 * 60_000);
});

test('prepared 批次：单次使用、按会话+角色查询、作废与过期可核对', (t) => {
  let now = 1_000_000;
  const prepared = preparedFixture(t, { now: () => now, ttlMs: 60_000 });
  const created = prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, boundaryKey: null,
    offerId: 'offer:1', indexes: [1, 2], request: { mode: 'discovery' }, prewarmKey: 'key-1' });
  assert.match(created.preparedId, /^prepared:/);
  assert.equal(created.status, 'prepared');
  assert.equal(created.expiresAt, now + 60_000);
  assert.equal(prepared.listReady({ sessionId: 'other', personId: 'a' }).length, 0, '跨会话不可见');
  assert.equal(prepared.listReady({ sessionId: 'room', personId: 'b' }).length, 0, '跨角色不可见');
  assert.equal(prepared.listReady({ sessionId: 'room', personId: 'a' }).length, 1);

  // 过期批次不再可查，标记为 expired 供诊断。
  now += 61_000;
  assert.equal(prepared.listReady({ sessionId: 'room', personId: 'a' }).length, 0);
  assert.equal(prepared.markExpired(), 1);
  assert.equal(prepared.get(created.preparedId).status, 'expired');

  const second = prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, offerId: 'offer:2',
    indexes: [3], request: { mode: 'discovery' }, prewarmKey: 'key-2' });
  assert.equal(prepared.markConsumed(second.preparedId, { ok: true }), true);
  assert.equal(prepared.get(second.preparedId).status, 'consumed');
  assert.deepEqual(prepared.get(second.preparedId).result, { ok: true });
  assert.equal(prepared.markConsumed(second.preparedId), true, '消费状态更新幂等（行仍在，供核对）');

  const third = prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, offerId: 'offer:3',
    indexes: [1], request: { mode: 'discovery' }, prewarmKey: 'key-3' });
  assert.equal(prepared.invalidate({ sessionId: 'other' }), 0);
  assert.equal(prepared.invalidate({ sessionId: 'room' }), 1);
  assert.equal(prepared.get(third.preparedId).status, 'invalidated');
  assert.equal(prepared.listReady({ sessionId: 'room', personId: 'a' }).length, 0);
});

test('超过保留窗口的过期批次会被清理，表大小有界', (t) => {
  let now = 1_000_000;
  const prepared = preparedFixture(t, { now: () => now, ttlMs: 60_000 });
  const old = prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, offerId: 'offer:old',
    indexes: [1], request: { mode: 'discovery' }, prewarmKey: 'old' });
  now += 60_000 + 10 * 60_000 + 1;
  prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, offerId: 'offer:new',
    indexes: [2], request: { mode: 'discovery' }, prewarmKey: 'new' });
  assert.equal(prepared.get(old.preparedId), null, '过期 + 保留窗口之后的行被删除');
  assert.equal(prepared.listReady({ sessionId: 'room', personId: 'a' }).length, 1);
});

test('prepared 批次在同一上下文只保留最近一份（同一代次最多一个待采用批次）', (t) => {
  const prepared = preparedFixture(t);
  const first = prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, offerId: 'offer:k1',
    indexes: [1], request: { mode: 'discovery' }, prewarmKey: 'k1' });
  prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, offerId: 'offer:k2',
    indexes: [1], request: { mode: 'discovery' }, prewarmKey: 'k2' });
  const ready = prepared.listReady({ sessionId: 'room', personId: 'a' });
  assert.equal(ready.length, 1);
  assert.equal(ready[0].prewarmKey, 'k2', '最新的批次取代旧批次');
  assert.equal(prepared.get(first.preparedId), null, '被取代的旧批次行被清理');
});

test('prepared 批次保留数量可配置（测试与诊断可用 maxPerContext）', (t) => {
  const prepared = preparedFixture(t, { maxPerContext: 2 });
  for (const key of ['k1', 'k2', 'k3']) {
    prepared.create({ sessionId: 'room', personId: 'a', outputGeneration: 3, offerId: `offer:${key}`,
      indexes: [1], request: { mode: 'discovery' }, prewarmKey: key });
  }
  const ready = prepared.listReady({ sessionId: 'room', personId: 'a' });
  assert.equal(ready.length, 2);
  assert.equal(ready[0].prewarmKey, 'k3', '最新的在前');
  assert.equal(ready[1].prewarmKey, 'k2');
});

test('预热批次签名忽略软歌手锚点，但保留硬条件与归属', () => {
  const base = { mode: 'discovery', delivery: 'append', count: 3, artist: '',
    constraints: { tags: { language: 'yue' } }, softPreferences: '夜里听' };
  const key = (overrides = {}) => prewarmBatchKey({ request: { ...base, ...overrides },
    sessionId: 'room', personId: 'a' });
  assert.equal(key({ preferredArtists: ['歌手 A'] }), key({ preferredArtists: ['歌手 B'] }),
    '软锚点漂移不能让仍然合法的批次作废');
  assert.notEqual(key(), key({ constraints: { tags: { language: 'zh' } } }), '硬条件参与签名');
  assert.notEqual(key(), key({ count: 2 }));
  assert.notEqual(key(), key({ delivery: 'replace_now' }));
  assert.notEqual(key(), prewarmBatchKey({ request: base, sessionId: 'room', personId: 'b' }), '归属参与签名');
});

test('MUSIC_PREWARM_TTL_MS 可覆盖预热 TTL，过小/非法值回落到不短于 offer TTL', () => {
  assert.equal(musicSelectionPreparedTtlMs({ MUSIC_PREWARM_TTL_MS: '90000' }), 90_000);
  assert.equal(musicSelectionPreparedTtlMs({ MUSIC_PREWARM_TTL_MS: '1000' }), PREPARED_DEFAULT_TTL_MS);
  assert.equal(musicSelectionPreparedTtlMs({}), PREPARED_DEFAULT_TTL_MS);
  assert.equal(musicSelectionPreparedTtlMs({ MUSIC_SELECTION_OFFER_TTL_MS: '3600000' }), 3_600_000,
    '至少不短于普通 offer 的有效期');
});
