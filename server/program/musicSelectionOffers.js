import { createHash, randomUUID } from 'node:crypto';

/**
 * 候选 offer：开放式选歌不再由工具内部替用户挑歌，而是给本次 Agent 一轮
 * 有界、稳定、可核对的候选窗口（默认 40 首，`MUSIC_OFFER_WINDOW` 可调 20–60）。Agent 从窗口里选序号，再由
 * `commit_music_selection` 按同一 offer 做 canonical 解析与硬约束校验后提交。
 *
 * 持久化在既有 conversationStore.db：服务器重启后 offer 仍按同一份锁定请求校验，
 * 过期/已消费/跨会话/跨角色的 offer 一律 fail closed。
 *
 * 预热（prepared）：受限运行器在 preparation 模式下把候选窗口“挂起”成
 * `prepared` 状态，并记下 `preparedFor`（会话、输出代次、边界）。这是同一轮
 * requestId 规则的**唯一**放宽点：只有携带同源 `preparedAccept` 的续播边界
 * 才能认领这种 offer，普通对话提交仍然必须同轮。
 */
// 窗口硬上限；实际大小由 offerWindowSize() 决定（默认 40）。
export const OFFER_MAX_CANDIDATES = 60;
export const OFFER_MIN_CANDIDATES = 20;
export const OFFER_DEFAULT_CANDIDATES = 40;
export const OFFER_DEFAULT_TTL_MS = 10 * 60_000;
// 过期后仍保留一小段时间用于诊断；真正生效的判定始终是 expires_at。
export const OFFER_RETENTION_MS = 10 * 60_000;
// 预热批次要跨越“当前这首还在播”的等待窗口，默认比普通 offer 留得更久。
export const PREPARED_DEFAULT_TTL_MS = 30 * 60_000;
const OFFER_STATUSES = Object.freeze({ OPEN: 'open', CLAIMED: 'claimed', CONSUMED: 'consumed', PREPARED: 'prepared' });
const PREPARED_STATUSES = Object.freeze({ PREPARED: 'prepared', CONSUMED: 'consumed', FAILED: 'failed', INVALIDATED: 'invalidated', EXPIRED: 'expired' });

export { OFFER_STATUSES, PREPARED_STATUSES };

export function musicSelectionOfferTtlMs(env = process.env) {
  const value = Number(env?.MUSIC_SELECTION_OFFER_TTL_MS);
  return Number.isFinite(value) && value >= 30_000 ? Math.floor(value) : OFFER_DEFAULT_TTL_MS;
}

/** 模型可见窗口大小：`MUSIC_OFFER_WINDOW`，默认 40，夹在 20–60。 */
export function offerWindowSize(env = process.env) {
  const value = Number(env?.MUSIC_OFFER_WINDOW);
  if (!Number.isFinite(value) || value <= 0) return OFFER_DEFAULT_CANDIDATES;
  return Math.min(OFFER_MAX_CANDIDATES, Math.max(OFFER_MIN_CANDIDATES, Math.floor(value)));
}

/** 预热批次 TTL：默认不短于普通 offer，可用 MUSIC_PREWARM_TTL_MS 覆盖。 */
export function musicSelectionPreparedTtlMs(env = process.env) {
  const value = Number(env?.MUSIC_PREWARM_TTL_MS);
  if (Number.isFinite(value) && value >= 30_000) return Math.floor(value);
  return Math.max(musicSelectionOfferTtlMs(env), PREPARED_DEFAULT_TTL_MS);
}

function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

/**
 * 预热批次的可核对身份：硬条件 + 归属。
 *
 * 刻意不含 `preferredArtists`：那是由“当时正在播的那一首”派生的软排序锚点，
 * 会随边界推进自然漂移；它从不改变候选成员，也不放宽任何硬约束，因此不能
 * 让一份仍然合法的批次作废。真正的硬条件（mode/delivery/constraints/数量）
 * 全部参与签名，采用时还会重新做 canonical 解析与硬约束校验。
 */
export function prewarmBatchKey({ request = null, sessionId = '', personId = '' } = {}) {
  const { preferredArtists: _softAnchor, ...durable } = request || {};
  return createHash('sha256').update(JSON.stringify(stable({ request: durable,
    sessionId: String(sessionId || ''), personId: String(personId || '') })))
    .digest('hex');
}

export function initializeMusicSelectionOffers(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS music_selection_offers (
    offer_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    request_id TEXT,
    round_id TEXT,
    membership_token INTEGER,
    membership_revision INTEGER NOT NULL DEFAULT 0,
    request_json TEXT NOT NULL,
    candidates_json TEXT NOT NULL,
    status TEXT NOT NULL,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_at INTEGER
  )`);
  // 旧库补列：preparedFor 是预热采用的窄放宽凭据，缺失时按 NULL（普通 offer）处理。
  ensureColumn(db, 'music_selection_offers', 'prepared_for_json', 'prepared_for_json TEXT');
  // 候选特征（结构化、无正文）：与 candidates 按序号对齐，供决策账本快照；旧行为 NULL。
  ensureColumn(db, 'music_selection_offers', 'features_json', 'features_json TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_music_selection_offers_session
    ON music_selection_offers(session_id, created_at)`);
}

export function initializeMusicSelectionPrepared(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS music_selection_prepared (
    prepared_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    output_generation INTEGER,
    boundary_key TEXT,
    offer_id TEXT NOT NULL,
    indexes_json TEXT NOT NULL,
    request_json TEXT NOT NULL,
    prewarm_key TEXT NOT NULL,
    position_json TEXT,
    membership_token INTEGER,
    membership_revision INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_music_selection_prepared_session
    ON music_selection_prepared(session_id, person_id, created_at)`);
}

/** 面向上帝视角的 canonical 候选：只保留稳定身份与展示字段，1 起始序号。 */
export function normalizeOfferCandidate(track, index) {
  return {
    index: index + 1,
    source: String(track?.source || track?.provider || '').split(/[:-]/)[0],
    songId: String(track?.songId || track?.song_id || ''),
    title: String(track?.title || ''),
    artist: String(track?.artist || ''),
    album: String(track?.album || ''),
    duration: Number(track?.duration) || 0,
  };
}

export function normalizeOfferCandidates(tracks = [], limit = OFFER_MAX_CANDIDATES) {
  return (Array.isArray(tracks) ? tracks : []).slice(0, Math.max(0, limit))
    .map((track, index) => normalizeOfferCandidate(track, index))
    .filter(candidate => candidate.songId && candidate.title && candidate.artist);
}

/** `indexes` 必须是 1..size 内互不重复的整数；重复或越界都属于模型可纠正的坏选择。 */
export function normalizeOfferIndexes(value, size) {
  const list = Array.isArray(value) ? value : null;
  if (!list || !list.length || list.length > 10) return null;
  const unique = [...new Set(list)];
  if (unique.length !== list.length) return null;
  if (unique.some(index => !Number.isInteger(index) || index < 1 || index > size)) return null;
  return unique.sort((a, b) => a - b);
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function hydrate(row) {
  if (!row) return null;
  return Object.freeze({
    offerId: row.offer_id,
    sessionId: row.session_id,
    virtualPersonId: row.person_id,
    requestId: row.request_id || null,
    roundId: row.round_id || null,
    membershipToken: row.membership_token,
    membershipRevision: Number(row.membership_revision) || 0,
    request: parseJson(row.request_json, null),
    candidates: parseJson(row.candidates_json, []),
    features: row.features_json ? parseJson(row.features_json, null) : null,
    status: row.status,
    result: row.result_json ? parseJson(row.result_json, null) : null,
    // 预热凭据：只有它在场时，非同一轮 requestId 的 prepared 认领才被允许。
    preparedFor: row.prepared_for_json ? parseJson(row.prepared_for_json, null) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}

/** 单表 store：create/get/claim/consume/release/prune，状态迁移都在 SQL 里原子完成。 */
export class MusicSelectionOfferStore {
  constructor({ db, now = Date.now, ttlMs = null } = {}) {
    if (!db) throw new TypeError('MusicSelectionOfferStore requires db');
    this.db = db;
    this.now = typeof now === 'function' ? now : Date.now;
    this.ttlMs = Number(ttlMs) > 0 ? Number(ttlMs) : musicSelectionOfferTtlMs();
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return this;
    initializeMusicSelectionOffers(this.db);
    this.initialized = true;
    return this;
  }

  /** 新 offer 落库前顺手清掉早已过期的行，表大小因此有界。 */
  prune() {
    this.initialize();
    this.db.prepare('DELETE FROM music_selection_offers WHERE expires_at < ?').run(this.now() - OFFER_RETENTION_MS);
  }

  create({ sessionId, personId, requestId = null, roundId = null, membershipToken = null, membershipRevision = 0,
    request, candidates = [], features = null, ttlMs = null } = {}) {
    this.initialize();
    this.prune();
    // 序号由这里统一编：候选只以稳定身份 + 序号进入存储，调用方无法改口径。
    const canonical = normalizeOfferCandidates(candidates);
    // 特征与输入候选并列传入；按 (source, songId) 对齐到编号后的候选，被丢弃的候选不留特征。
    const featureByKey = new Map((Array.isArray(features) ? features : []).map((item, index) => {
      const track = candidates[index] || {};
      return [`${String(track.source || '').split(/[:-]/)[0]}:${track.songId}`, item];
    }));
    const aligned = Array.isArray(features) ? canonical.map(candidate => featureByKey.get(`${candidate.source}:${candidate.songId}`) || null) : null;
    const offerId = `offer:${randomUUID().replaceAll('-', '')}`;
    const createdAt = this.now();
    const expiresAt = createdAt + (Number(ttlMs) > 0 ? Number(ttlMs) : this.ttlMs);
    this.db.prepare(`INSERT INTO music_selection_offers
      (offer_id, session_id, person_id, request_id, round_id, membership_token, membership_revision,
        request_json, candidates_json, status, result_json, created_at, expires_at, claimed_at, prepared_for_json, features_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL, NULL, ?)`)
      .run(offerId, String(sessionId || ''), String(personId || ''), requestId ? String(requestId) : null,
        roundId ? String(roundId) : null, membershipToken == null ? null : Number(membershipToken),
        Number(membershipRevision) || 0, JSON.stringify(request || null), JSON.stringify(canonical),
        createdAt, expiresAt, aligned ? JSON.stringify(aligned) : null);
    return this.get(offerId);
  }

  get(offerId) {
    this.initialize();
    return hydrate(this.db.prepare('SELECT * FROM music_selection_offers WHERE offer_id = ?').get(String(offerId || '')));
  }

  /**
   * 单次认领：默认只有 'open' 才能变成 'claimed'。
   * `prepared: true` 是给续播边界采用的窄通道：'prepared' 状态的 offer 在同一
   * preparedFor 凭据下认领，原子完成，竞争时只有一个边界能赢。
   */
  claim(offerId, { prepared = false } = {}) {
    this.initialize();
    const result = prepared
      ? this.db.prepare(`UPDATE music_selection_offers SET status = 'claimed', claimed_at = ?
          WHERE offer_id = ? AND status = 'prepared'`).run(this.now(), String(offerId || ''))
      : this.db.prepare(`UPDATE music_selection_offers SET status = 'claimed', claimed_at = ?
          WHERE offer_id = ? AND status = 'open'`).run(this.now(), String(offerId || ''));
    return result.changes === 1;
  }

  /**
   * preparation 模式把选中的序号挂起为 'prepared'（登记而不提交）：只改写状态与
   * preparedFor/序号，不解析、不触碰播放器。此后只有同源 preparedAccept 能认领。
   */
  holdForPreparation(offerId, { indexes = null, preparedFor = null } = {}) {
    this.initialize();
    const result = this.db.prepare(`UPDATE music_selection_offers SET status = 'prepared',
        prepared_for_json = ?, result_json = ?, claimed_at = NULL
      WHERE offer_id = ? AND status IN ('open', 'claimed')`)
      .run(preparedFor ? JSON.stringify(preparedFor) : null,
        JSON.stringify({ ok: true, code: 'MUSIC_CANDIDATES_SELECTED', indexes: Array.isArray(indexes) ? indexes : [] }),
        String(offerId || ''));
    return result.changes === 1;
  }

  /** 预热批次等待消费期间把 offer 的有效期对齐到批次 TTL，避免候选先过期。 */
  extend(offerId, { expiresAt } = {}) {
    this.initialize();
    const value = Number(expiresAt);
    if (!Number.isFinite(value)) return false;
    return this.db.prepare('UPDATE music_selection_offers SET expires_at = MAX(expires_at, ?) WHERE offer_id = ?')
      .run(Math.floor(value), String(offerId || '')).changes === 1;
  }

  /** 提交成功后 offer 永久失效（单次使用）。 */
  consume(offerId, result = null) {
    this.initialize();
    return this.db.prepare(`UPDATE music_selection_offers SET status = 'consumed', result_json = ?, claimed_at = COALESCE(claimed_at, ?)
      WHERE offer_id = ?`).run(result ? JSON.stringify(result) : null, this.now(), String(offerId || '')).changes === 1;
  }

  /**
   * 失败（无副作用）放回可重试状态：普通轮次回到 'open'（同一轮可以用修正后的
   * 序号重试）；预热采用失败则回到 'prepared'（仍然只能被边界采用，不会被普通
   * 对话提交捡走）。
   */
  release(offerId, { toPrepared = false } = {}) {
    this.initialize();
    return toPrepared
      ? this.db.prepare(`UPDATE music_selection_offers SET status = 'prepared'
          WHERE offer_id = ? AND status = 'claimed'`).run(String(offerId || '')).changes === 1
      : this.db.prepare(`UPDATE music_selection_offers SET status = 'open', claimed_at = NULL
          WHERE offer_id = ? AND status = 'claimed'`).run(String(offerId || '')).changes === 1;
  }
}

function hydratePrepared(row) {
  if (!row) return null;
  return Object.freeze({
    preparedId: row.prepared_id,
    sessionId: row.session_id,
    virtualPersonId: row.person_id,
    outputGeneration: row.output_generation == null ? null : Number(row.output_generation),
    boundaryKey: row.boundary_key || null,
    offerId: row.offer_id,
    indexes: parseJson(row.indexes_json, []),
    request: parseJson(row.request_json, null),
    prewarmKey: row.prewarm_key,
    position: row.position_json ? parseJson(row.position_json, null) : null,
    membershipToken: row.membership_token,
    membershipRevision: Number(row.membership_revision) || 0,
    status: row.status,
    result: row.result_json ? parseJson(row.result_json, null) : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
}

/**
 * 预热批次：把一次受限 preparation 任务的产出（offer + 选中序号 + 身份）持久化，
 * 供续播边界在不发起模型调用的前提下采用。单次使用；会话/角色/输出代次/成员
 * 令牌/边界/请求签名在采用时逐项核对，任何一项不符都回到实时选歌路径。
 */
export class MusicSelectionPreparedStore {
  constructor({ db, now = Date.now, ttlMs = null, maxPerContext = 1 } = {}) {
    if (!db) throw new TypeError('MusicSelectionPreparedStore requires db');
    this.db = db;
    this.now = typeof now === 'function' ? now : Date.now;
    this.ttlMs = Number(ttlMs) > 0 ? Number(ttlMs) : musicSelectionPreparedTtlMs();
    this.maxPerContext = Math.max(1, Number(maxPerContext) || 1);
    this.initialized = false;
  }

  initialize() {
    if (this.initialized) return this;
    initializeMusicSelectionPrepared(this.db);
    this.initialized = true;
    return this;
  }

  /** 过期行保留一小段时间用于诊断后清理，表大小因此有界。 */
  prune() {
    this.initialize();
    this.db.prepare('DELETE FROM music_selection_prepared WHERE expires_at < ?').run(this.now() - OFFER_RETENTION_MS);
  }

  create({ sessionId, personId, outputGeneration = null, boundaryKey = null, offerId,
    indexes = [], request = null, prewarmKey = '', position = null, membershipToken = null, membershipRevision = 0,
    ttlMs = null } = {}) {
    this.initialize();
    this.prune();
    const preparedId = `prepared:${randomUUID().replaceAll('-', '')}`;
    const createdAt = this.now();
    const expiresAt = createdAt + (Number(ttlMs) > 0 ? Number(ttlMs) : this.ttlMs);
    this.db.prepare(`INSERT INTO music_selection_prepared
      (prepared_id, session_id, person_id, output_generation, boundary_key, offer_id, indexes_json, request_json,
        prewarm_key, position_json, membership_token, membership_revision, status, result_json, created_at, expires_at, consumed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, NULL)`)
      .run(preparedId, String(sessionId || ''), String(personId || ''), outputGeneration == null ? null : Number(outputGeneration),
        boundaryKey ? String(boundaryKey) : null, String(offerId || ''), JSON.stringify(indexes),
        JSON.stringify(request || null), String(prewarmKey || ''), position ? JSON.stringify(position) : null,
        membershipToken == null ? null : Number(membershipToken), Number(membershipRevision) || 0,
        JSON.stringify({ ok: true, code: 'MUSIC_PREPARED' }), createdAt, expiresAt);
    // 同一 (会话, 角色, 输出代次) 只保留最近一份待采用批次：新一代批次直接取代旧批次，
    // 既避免旧批次里已经播过的歌被反复捡起，也保证“同一代次最多一个待采用批次”的预热去重。
    const stale = this.db.prepare(`SELECT prepared_id FROM music_selection_prepared
      WHERE session_id = ? AND person_id = ? AND output_generation IS ?
        AND status = 'prepared' ORDER BY created_at DESC, rowid DESC`).all(String(sessionId || ''), String(personId || ''),
      outputGeneration == null ? null : Number(outputGeneration)).slice(this.maxPerContext);
    for (const row of stale) this.db.prepare('DELETE FROM music_selection_prepared WHERE prepared_id = ?').run(row.prepared_id);
    return this.get(preparedId);
  }

  get(preparedId) {
    this.initialize();
    return hydratePrepared(this.db.prepare('SELECT * FROM music_selection_prepared WHERE prepared_id = ?').get(String(preparedId || '')));
  }

  /** 待采用批次：同一会话 + 同一角色，按创建时间从新到旧；是否可用由调用方逐项核对。 */
  listReady({ sessionId, personId = null } = {}) {
    this.initialize();
    const rows = this.db.prepare(`SELECT * FROM music_selection_prepared
      WHERE session_id = ? AND status = 'prepared' AND expires_at > ? ORDER BY created_at DESC, rowid DESC`)
      .all(String(sessionId || ''), this.now());
    return rows.map(hydratePrepared).filter(entry => !personId || entry.virtualPersonId === String(personId));
  }

  markConsumed(preparedId, result = null) {
    this.initialize();
    return this.db.prepare(`UPDATE music_selection_prepared SET status = 'consumed', result_json = ?, consumed_at = ?
      WHERE prepared_id = ?`).run(result ? JSON.stringify(result) : null, this.now(), String(preparedId || '')).changes === 1;
  }

  markFailed(preparedId, result = null) {
    this.initialize();
    return this.db.prepare(`UPDATE music_selection_prepared SET status = 'failed', result_json = ?, consumed_at = ?
      WHERE prepared_id = ?`).run(result ? JSON.stringify(result) : null, this.now(), String(preparedId || '')).changes === 1;
  }

  /** 记忆/标签/曲库或会话失效：待采用批次立刻作废（单次使用，不可复活）。 */
  invalidate({ sessionId = null } = {}) {
    this.initialize();
    return (sessionId
      ? this.db.prepare(`UPDATE music_selection_prepared SET status = 'invalidated'
          WHERE status = 'prepared' AND session_id = ?`).run(String(sessionId))
      : this.db.prepare(`UPDATE music_selection_prepared SET status = 'invalidated' WHERE status = 'prepared'`).run()).changes;
  }

  invalidateById(preparedId) {
    this.initialize();
    return this.db.prepare(`UPDATE music_selection_prepared SET status = 'invalidated'
      WHERE status = 'prepared' AND prepared_id = ?`).run(String(preparedId || '')).changes === 1;
  }

  /** 过期批次标记为 expired（诊断用），真正的可用性判定始终是 expires_at。 */
  markExpired() {
    this.initialize();
    return this.db.prepare(`UPDATE music_selection_prepared SET status = 'expired'
      WHERE status = 'prepared' AND expires_at <= ?`).run(this.now()).changes;
  }
}
