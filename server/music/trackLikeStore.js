// trackLikeStore.js — 「喜欢」意图的本地真相源。
//
// 以前「喜欢」是浏览器 localStorage 里的一条记录：换浏览器就没了，音乐源的
// 「我喜欢的音乐 / 我的收藏」也毫无变化。而远端不可能是真相源 —— 断网、未登录、
// 或者推荐里一首你还没收藏过的歌，远端都答不出「用户喜欢它吗」。
//
// 所以这一层只做一件事：把**用户意图**持久化。远端是否跟上了，是这一行的
// `remote_state`，不是意图本身。三条不可让步的规则：
//
// 1. 意图与远端事实分开存。写远端失败不回滚 intent；远端被外部改掉也不静默
//    改写 intent（只标漂移，交给服务层有界重试）。
// 2. `(provider, song_id)` 是唯一身份。跨源的「同名歌」不是同一首歌，这里
//    不做任何合并或回退查找。
// 3. 状态取值封闭。拼错的状态名会让 UI 显示错的东西，宁可在写入时拒绝。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from '../runtimePaths.js';

/** `remote_state` 的封闭取值，见 design.md D2。 */
export const REMOTE_STATES = Object.freeze(['local_only', 'pending', 'synced', 'failed']);

/** 连续失败上限：到这里就停止自动重试，只留用户显式重试。 */
export const MAX_AUTO_ATTEMPTS = 3;

function normalizeProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (!provider) throw new TypeError('track like requires provider');
  return provider;
}

function normalizeSongId(value) {
  const songId = String(value ?? '').trim();
  if (!songId) throw new TypeError('track like requires songId');
  return songId;
}

function normalizeDesired(value) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  if (value === 'true') return 1;
  if (value === 'false') return 0;
  throw new TypeError('track like requires a boolean desired');
}

export const LIKE_ORIGINS = Object.freeze(['user', 'adopted']);

function normalizeOrigin(value) {
  const origin = String(value ?? '').trim();
  if (!LIKE_ORIGINS.includes(origin)) throw new TypeError(`unknown like origin "${origin}"`);
  return origin;
}

function assertRemoteState(state) {
  if (!REMOTE_STATES.includes(state)) throw new TypeError(`unknown remote state "${state}"`);
  return state;
}

/**
 * 错误原因只接受**归类码**（`request_failed`、`code:500` 这种形状）。
 *
 * 不做「截断 + 脱敏」那种半吊子处理：上游原文里随机出现的 cookie 片段不会被
 * 任何截断规则认出来。这里用白名单，形状不符一律落成 `unknown_error`，
 * 保证数据库和界面里不可能出现凭据或上游原话。
 */
const SAFE_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,40}(:[0-9]{1,9})?$/;

function sanitizeError(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  return SAFE_ERROR_PATTERN.test(text) ? text : 'unknown_error';
}

export class TrackLikeStore {
  constructor({ dbPath = null, db = null, now = () => Date.now() } = {}) {
    this.db = db;
    this._ownsDb = !db;
    this.dbPath = dbPath;
    this.now = now;
  }

  initialize() {
    if (!this.db) {
      const path = this.dbPath || resolveDatabasePath();
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
      this.db = new Database(path);
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS song_likes (
        provider     TEXT NOT NULL,
        song_id      TEXT NOT NULL,
        desired      INTEGER NOT NULL,
        remote_state TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        request_id   TEXT,
        -- 这一行的意图是谁的意思：
        --   user     = 用户在 Lunara 里点的，与远端冲突时以本地为准（有界重试）
        --   adopted  = 从远端只读结果采纳的，与远端冲突时以远端为准（静默跟随）
        -- 没有这个区分，「外部取消收藏后 Lunara 又把它加回去」就无从避免。
        origin       TEXT NOT NULL DEFAULT 'user',
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (provider, song_id)
      );
      CREATE INDEX IF NOT EXISTS idx_song_likes_state ON song_likes (remote_state, updated_at);
    `);
    // 已有库补列：origin 是后加的，旧行都是用户在 UI 上点出来的。
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('song_likes')").all().map(row => row.name);
    if (!columns.includes('origin')) {
      this.db.exec("ALTER TABLE song_likes ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
    }
    return this;
  }

  close() {
    if (this._ownsDb && this.db) {
      try { this.db.close(); } catch { /* 关闭失败不影响进程退出 */ }
    }
    this.db = null;
  }

  /** 单条意图。没有记录时返回 null —— 「没表达过」和「表达了不喜欢」是两件事。 */
  get(provider, songId) {
    const row = this.db.prepare(
      'SELECT provider, song_id, desired, remote_state, attempts, last_error, request_id, origin, updated_at FROM song_likes WHERE provider = ? AND song_id = ?',
    ).get(normalizeProvider(provider), normalizeSongId(songId));
    return row ? this._toLike(row) : null;
  }

  /**
   * 写入用户意图（last-write-wins）。
   *
   * 同一首歌连续两次相反意图以最后一次为准：喜欢是一个**设置状态**的动作，
   * 不是 toggle 队列，积压前一次没有意义。`attempts` 因意图变化而清零 ——
   * 用户重新表达过，就该重新给一次同步机会。
   */
  setDesired(provider, songId, desired, { remoteState = 'pending', requestId = null, origin = 'user' } = {}) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedSongId = normalizeSongId(songId);
    const want = normalizeDesired(desired);
    const state = assertRemoteState(remoteState);
    const source = normalizeOrigin(origin);
    const existing = this.get(normalizedProvider, normalizedSongId);
    // `desired` 在读出时是 boolean，比较前先归一，否则「重复同一意图」会被误判
    // 成意图变化而清零重试预算。
    const attempts = existing && existing.desired === (want === 1) ? existing.attempts : 0;
    const now = this.now();
    this.db.prepare(`
      INSERT INTO song_likes (provider, song_id, desired, remote_state, attempts, last_error, request_id, origin, updated_at)
      VALUES (@provider, @song_id, @desired, @remote_state, @attempts, NULL, @request_id, @origin, @updated_at)
      ON CONFLICT(provider, song_id) DO UPDATE SET
        desired = excluded.desired,
        remote_state = excluded.remote_state,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        request_id = excluded.request_id,
        origin = excluded.origin,
        updated_at = excluded.updated_at
    `).run({
      provider: normalizedProvider,
      song_id: normalizedSongId,
      desired: want,
      remote_state: state,
      attempts,
      request_id: requestId == null ? null : String(requestId),
      origin: source,
      updated_at: now,
    });
    return this.get(normalizedProvider, normalizedSongId);
  }

  /** 只改远端状态，不碰意图。 */
  markState(provider, songId, remoteState, { error = null, attempts = null, requestId = null } = {}) {
    const normalizedProvider = normalizeProvider(provider);
    const normalizedSongId = normalizeSongId(songId);
    const state = assertRemoteState(remoteState);
    this.db.prepare(`
      UPDATE song_likes
         SET remote_state = @remote_state,
             attempts = COALESCE(@attempts, attempts),
             last_error = @last_error,
             request_id = COALESCE(@request_id, request_id),
             updated_at = @updated_at
       WHERE provider = @provider AND song_id = @song_id
    `).run({
      provider: normalizedProvider,
      song_id: normalizedSongId,
      remote_state: state,
      attempts: Number.isInteger(attempts) ? attempts : null,
      last_error: sanitizeError(error),
      request_id: requestId == null ? null : String(requestId),
      updated_at: this.now(),
    });
    return this.get(normalizedProvider, normalizedSongId);
  }

  /** 记一次失败：attempts+1，达到上限就落到 failed，不再自动重试。 */
  recordFailure(provider, songId, error, { state = null } = {}) {
    const existing = this.get(provider, songId);
    if (!existing) return null;
    const attempts = existing.attempts + 1;
    const nextState = state || (attempts >= MAX_AUTO_ATTEMPTS ? 'failed' : 'pending');
    return this.markState(provider, songId, nextState, { error, attempts });
  }

  /** 成功：清零 attempts，落 synced。 */
  recordSuccess(provider, songId, { requestId = null } = {}) {
    return this.markState(provider, songId, 'synced', { error: null, attempts: 0, requestId });
  }

  /** requestId 回放：同一个请求重发时直接返回上次结果。 */
  findByRequestId(requestId) {
    const id = String(requestId ?? '').trim();
    if (!id) return null;
    const row = this.db.prepare(
      'SELECT provider, song_id, desired, remote_state, attempts, last_error, request_id, origin, updated_at FROM song_likes WHERE request_id = ? LIMIT 1',
    ).get(id);
    return row ? this._toLike(row) : null;
  }

  /** 引擎需要补同步的曲目（pending 且未超预算），按最近更新排序。 */
  listPending({ limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT provider, song_id, desired, remote_state, attempts, last_error, request_id, origin, updated_at
        FROM song_likes
       WHERE remote_state = 'pending' AND attempts < ?
       ORDER BY updated_at DESC
       LIMIT ?
    `).all(MAX_AUTO_ATTEMPTS, Math.max(1, Math.trunc(Number(limit) || 50)));
    return rows.map(row => this._toLike(row));
  }

  _toLike(row) {
    return Object.freeze({
      provider: row.provider,
      songId: row.song_id,
      desired: row.desired === 1,
      remoteState: row.remote_state,
      attempts: row.attempts,
      lastError: row.last_error,
      requestId: row.request_id,
      origin: row.origin || 'user',
      updatedAt: row.updated_at,
    });
  }
}

let _singleton = null;

export function getTrackLikeStore() {
  if (!_singleton) {
    _singleton = new TrackLikeStore();
    _singleton.initialize();
  }
  return _singleton;
}
