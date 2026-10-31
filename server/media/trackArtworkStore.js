// trackArtworkStore.js — 封面元数据的唯一持久缓存与解析入口。
//
// 为什么封面要单独存：封面不是「曲库导入事实」，而是任何 provider 曲目都可能缺、
// 又都必须能在下一次播放时被补上的展示元数据。缺封面的主体包括曲库行、日节目
// 存档和已经在队列里的 occurrence，因此缓存必须按 canonical 身份 (provider, songId)
// 索引，而不能挂在某一张业务表上。
//
// 两种终态都必须落库：
//   resolved —— 已拿到可用封面 URL；
//   absent   —— 已向 provider 确认这张录音没有专辑封面（否则每次播放都白查一次）。
// absent 不是永久否定：之后拿到真实封面时会覆盖它。
//
// 解析顺序固定为「进程内缓存 → 持久表 → provider 查询」。网络永远只在最后一步发生，
// 且必须是有界、可失败、不带凭据的：封面取不到只影响封面，绝不影响可播性判定。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from '../runtimePaths.js';

export const ARTWORK_STATE = Object.freeze({ RESOLVED: 'resolved', ABSENT: 'absent' });
export const MAX_ARTWORK_URL_LENGTH = 2048;
export const DEFAULT_ARTWORK_TIMEOUT_MS = 4000;
const STATES = new Set(Object.values(ARTWORK_STATE));

/** 只有绝对 http(s) URL 才是封面；其它一律当作「没有值」，避免把错误串塞进 <img>。 */
export function normalizeArtworkUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ARTWORK_URL_LENGTH) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
  return trimmed;
}

function identity(value) {
  const provider = String(value?.provider || '').trim().toLowerCase();
  const songId = String(value?.songId ?? value?.song_id ?? '').trim();
  if (!provider || !songId) return null;
  return { provider, songId };
}

export class TrackArtworkStore {
  /**
   * @param {object} options
   * @param {(provider: string, songId: string) => Promise<{state: string, artwork?: string|null}>} options.lookup
   *   按 songId 向 provider 取封面。抛错或返回空表示「这次没查到」，不会被记成 absent。
   */
  constructor({
    dbPath = resolveDatabasePath(),
    now = () => Date.now(),
    lookup = null,
    timeoutMs = DEFAULT_ARTWORK_TIMEOUT_MS,
    memoryLimit = 1000,
    trace = null,
  } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    this.lookup = typeof lookup === 'function' ? lookup : null;
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_ARTWORK_TIMEOUT_MS);
    this.memoryLimit = Math.max(1, Number(memoryLimit) || 1000);
    this.trace = typeof trace === 'function' ? trace : null;
    this.memory = new Map();
    this.inflight = new Map();
    this.db = null;
    this._stmts = {};
  }

  initialize() {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    // 幂等：既有库补建这张附加表，不改任何既有表结构。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS track_artwork (
        provider    TEXT NOT NULL,
        song_id     TEXT NOT NULL,
        artwork     TEXT,
        state       TEXT NOT NULL CHECK (state IN ('resolved', 'absent')),
        resolved_at INTEGER NOT NULL,
        PRIMARY KEY (provider, song_id)
      );
    `);
    this._stmts.read = this.db.prepare(
      `SELECT artwork, state FROM track_artwork WHERE provider = ? AND song_id = ?`,
    );
    this._stmts.upsert = this.db.prepare(`
      INSERT INTO track_artwork (provider, song_id, artwork, state, resolved_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider, song_id) DO UPDATE SET
        artwork = excluded.artwork,
        state = excluded.state,
        resolved_at = excluded.resolved_at
    `);
    return this;
  }

  close() {
    try { this.db?.close(); } catch { /* 关闭失败不影响调用方 */ }
    this.db = null;
    this.memory.clear();
    this.inflight.clear();
  }

  _remember(provider, songId, record) {
    const key = `${provider}:${songId}`;
    this.memory.delete(key);
    this.memory.set(key, record);
    while (this.memory.size > this.memoryLimit) {
      this.memory.delete(this.memory.keys().next().value);
    }
  }

  _emit(event) {
    try { this.trace?.(event); } catch { /* 诊断失败不影响封面 */ }
  }

  /** 同步读取：内存 → 表 → null。{ state, artwork }。 */
  read(provider, songId) {
    const id = identity({ provider, songId });
    if (!id) return null;
    const key = `${id.provider}:${id.songId}`;
    const cached = this.memory.get(key);
    if (cached) return cached;
    const row = this._stmts.read?.get(id.provider, id.songId);
    if (!row) return null;
    const record = Object.freeze({
      state: row.state,
      artwork: row.state === ARTWORK_STATE.RESOLVED ? normalizeArtworkUrl(row.artwork) : null,
    });
    this._remember(id.provider, id.songId, record);
    return record;
  }

  /** 同步取「已知封面」：absent 与未缓存都返回 null。展示与候选投影只关心这个。 */
  peek(provider, songId) {
    const record = this.read(provider, songId);
    return record?.state === ARTWORK_STATE.RESOLVED ? record.artwork : null;
  }

  /**
   * 批量预览：曲库候选一次要投影上千行，逐条查询会把一次投影变成上千次 SQL。
   * 只读缓存与表，绝不发网络请求。
   */
  peekMany(provider, songIds = []) {
    const name = String(provider || '').trim().toLowerCase();
    const ids = [...new Set((songIds || []).map(id => String(id ?? '').trim()).filter(Boolean))];
    const out = new Map();
    if (!name || !ids.length) return out;
    for (const songId of ids) {
      const cached = this.memory.get(`${name}:${songId}`);
      if (cached) out.set(songId, cached.state === ARTWORK_STATE.RESOLVED ? cached.artwork : null);
    }
    const missing = ids.filter(songId => !this.memory.has(`${name}:${songId}`));
    const chunkSize = 400;
    for (let start = 0; start < missing.length; start += chunkSize) {
      const chunk = missing.slice(start, start + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db.prepare(
        `SELECT song_id, artwork, state FROM track_artwork WHERE provider = ? AND song_id IN (${placeholders})`,
      ).all(name, ...chunk);
      for (const row of rows) {
        const record = Object.freeze({
          state: row.state,
          artwork: row.state === ARTWORK_STATE.RESOLVED ? normalizeArtworkUrl(row.artwork) : null,
        });
        this._remember(name, row.song_id, record);
        out.set(row.song_id, record.state === ARTWORK_STATE.RESOLVED ? record.artwork : null);
      }
    }
    return out;
  }

  put({ provider, songId, artwork } = {}) {
    const id = identity({ provider, songId });
    const url = normalizeArtworkUrl(artwork);
    if (!id || !url) return null;
    this._write(id, { state: ARTWORK_STATE.RESOLVED, artwork: url });
    // 新事实推翻旧的 absent 记录，这是允许的：absent 只是缓存，不是永久否定。
    return url;
  }

  markAbsent({ provider, songId } = {}) {
    const id = identity({ provider, songId });
    if (!id) return false;
    this._write(id, { state: ARTWORK_STATE.ABSENT, artwork: null });
    return true;
  }

  _write(id, record) {
    this._stmts.upsert?.run(id.provider, id.songId, record.artwork, record.state, this.now());
    this._remember(id.provider, id.songId, Object.freeze(record));
  }

  /**
   * 导入播种：provider snapshot 已经给了封面 URL 就不要等到解析时再查网络。
   * 这是纯写入，不做网络查询。
   */
  seed(provider, tracks = []) {
    const name = String(provider || '').trim().toLowerCase();
    if (!name) return 0;
    let written = 0;
    for (const track of tracks) {
      const songId = String(track?.song_id ?? track?.songId ?? track?.id ?? '').trim();
      if (!songId) continue;
      const url = normalizeArtworkUrl(track?.pic_url ?? track?.artwork ?? '');
      if (!url) continue;
      if (this.put({ provider: name, songId, artwork: url })) written += 1;
    }
    return written;
  }

  /**
   * 异步解析：命中缓存直接返回；否则向 provider 查一次并落库。
   * 任何失败都返回 null，且**不**写 absent —— 「没查到」与「确认没有」是两件事。
   */
  async resolve(provider, songId, { signal } = {}) {
    const id = identity({ provider, songId });
    if (!id) return null;
    const cached = this.read(id.provider, id.songId);
    if (cached) return cached.state === ARTWORK_STATE.RESOLVED ? cached.artwork : null;
    if (!this.lookup) return null;
    if (signal?.aborted) return null;

    const key = `${id.provider}:${id.songId}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = this._lookupAndStore(id).finally(() => {
      if (this.inflight.get(key) === task) this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  async _lookupAndStore({ provider, songId }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let result;
    try {
      // provider 实现不一定会理会 signal；本身也必须被超时打断。
      const deadline = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('artwork lookup timeout')), { once: true });
      });
      result = await Promise.race([this.lookup(provider, songId, { signal: controller.signal }), deadline]);
    } catch {
      this._emit({ event: 'track-artwork', phase: 'query-failed', provider, songId,
        reason: controller.signal.aborted ? 'timeout' : 'provider-error' });
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!result || !STATES.has(result.state)) {
      this._emit({ event: 'track-artwork', phase: 'query-empty', provider, songId });
      return null;
    }
    if (result.state === ARTWORK_STATE.ABSENT) {
      this.markAbsent({ provider, songId });
      this._emit({ event: 'track-artwork', phase: 'absent', provider, songId });
      return null;
    }
    const url = normalizeArtworkUrl(result.artwork);
    if (!url) {
      // 「解析出来但不是可用 URL」= 这次没查到，不当作 absent。
      this._emit({ event: 'track-artwork', phase: 'query-invalid', provider, songId });
      return null;
    }
    this.put({ provider, songId, artwork: url });
    this._emit({ event: 'track-artwork', phase: 'resolved', provider, songId });
    return url;
  }
}

export function createTrackArtworkStore(options = {}) {
  return new TrackArtworkStore(options).initialize();
}
