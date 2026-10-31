// songTagStore.js — song_tags + artist_tags persistence (Phase A)
//
// 给每首歌打一组结构化标签（mood/energy/genre/language/...），存进 state.db，
// 让选歌从「歌名字符串模糊匹配」升级到「属性精确匹配」。
//
// 两张表：
//   song_tags   —— 歌曲级标签（21 列）
//   artist_tags —— 艺人级标签（性别/流派/地区），按 artist_key 去重缓存，一艺人打一次
//
// 设计要点（见 openspec/changes/song-structured-tags）：
//   - 与 memories/plays 同库（state.db），便于 JOIN；自开连接（同 MemoryStore 模式）
//   - TTL（默认 30 天）判定是否需重打；confidence=0 占位行也算「有行」，TTL 内不重试
//   - 缺行安全降级：getTags / getArtistTags 返 null 不抛
//   - upsert 幂等：同主键覆盖、bump updated_at、保留 created_at
//   - 无 bpm 列（真 BPM 是音频域，Phase B 再说）

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from '../runtimePaths.js';
import { getRecordingStore as getSharedRecordingStore } from '../music/recordingStore.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_TTL_DAYS = Number(process.env.SONG_TAG_TTL_DAYS) || 30;
const DEFAULT_PLACEHOLDER_RETRY_HOURS =
  Number(process.env.SONG_TAG_PLACEHOLDER_RETRY_HOURS) || 6;

function databasePath() {
  return resolveDatabasePath();
}

// ---- 归一化主艺人 key：取第一个艺人，去分隔符/feat、trim、小写、压空格 ----
export function artistKeyOf(artist) {
  if (!artist) return '';
  const primary = String(artist)
    .split(/\s*[/、,，&|]\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+vs\.?\s+/i)[0] || '';
  return primary.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ---- JSON 数组列的序列化 / 反序列化 ----
function toJsonArray(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { const p = JSON.parse(s); if (Array.isArray(p)) return p.length ? s : null; } catch { /* not json */ }
    return JSON.stringify([s]);
  }
  return JSON.stringify(v);
}
function parseJsonArray(s) {
  if (!s) return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ---- 数值/布尔安全转换（undefined → null，避免 better-sqlite3 抛错）----
function num(v) { return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }
function intOrNull(v) { const n = num(v); return n == null ? null : Math.trunc(n); }
function boolInt(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  if (Number.isFinite(n)) return n ? 1 : 0;
  return null;
}
function str(v) { return v == null ? null : String(v); }

export function providerOf(value) {
  const provider = String(value || '').trim().toLowerCase().split(':')[0];
  return provider === 'ncm' || provider === 'qq' || provider === 'legacy'
    ? provider
    : 'legacy';
}

const SONG_COLUMNS = [
  'provider', 'song_id', 'title', 'artist', 'artist_key', 'source', 'year', 'language',
  'genre', 'instruments', 'mood', 'energy', 'valence', 'tempo', 'has_vocal',
  'vocal_softness', 'scenes', 'themes', 'confidence', 'source_text',
  'created_at', 'updated_at',
];

// 行 → 对外形状。recordingId 有值时说明这份标签属于整首「歌」而不是某一个源。
function decorate(row, recordingId) {
  return {
    ...row,
    ...(recordingId ? { recordingId } : {}),
    has_vocal: row.has_vocal == null ? null : Boolean(row.has_vocal),
    instruments: parseJsonArray(row.instruments),
    scenes: parseJsonArray(row.scenes),
    themes: parseJsonArray(row.themes),
  };
}

// song_tags 的一行 → recording_tags 的一行（只换归属键）。
function toRecordingRow(recordingId, row) {
  const out = { recording_id: recordingId };
  for (const column of SONG_COLUMNS) out[column] = row[column] ?? null;
  return out;
}

export class SongTagStore {
  constructor({ dbPath = null, db = null, migrationHook = null, now = () => Date.now(), getRecordingStore = null } = {}) {
    this.db = db;
    this._ownsDb = !db;
    this._stmts = {};
    this.dbPath = dbPath;
    this.migrationHook = migrationHook;
    this.now = now;
    // 录音身份层：默认用进程内共享实例；测试可注入 null 关掉。
    this._getRecordingStore = getRecordingStore === null ? getSharedRecordingStore : getRecordingStore;
  }

  /**
   * 这条供给身份所属的录音。返回 null 表示「没有跨源合并」——调用方按原来的
   * (provider, song_id) 键工作，行为与改动前完全一致。
   */
  _recordingOf(provider, songId) {
    try {
      const store = this._getRecordingStore?.();
      if (!store) return null;
      const identity = store.recordingOf(provider, songId);
      if (!identity || identity.isSelf) return null;
      const members = typeof store.membersOf === 'function' ? store.membersOf(identity.recordingId) : [];
      return { ...identity, members: Array.isArray(members) ? members : [] };
    } catch {
      return null; // 身份层不可用不能拖垮标签读写，退回供给身份即可。
    }
  }

  initialize() {
    const dbPath = this.dbPath || databasePath();
    mkdirSync(dirname(dbPath), { recursive: true });
    if (!this.db) this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS song_tags (
        provider       TEXT NOT NULL DEFAULT 'legacy',
        song_id        TEXT NOT NULL,
        title          TEXT,
        artist         TEXT,
        artist_key     TEXT,
        source         TEXT,
        year           INTEGER,
        language       TEXT,
        genre          TEXT,
        instruments    TEXT,
        mood           TEXT,
        energy         REAL,
        valence        REAL,
        tempo          TEXT,
        has_vocal      INTEGER,
        vocal_softness REAL,
        scenes         TEXT,
        themes         TEXT,
        confidence     REAL,
        source_text    TEXT,
        created_at     INTEGER,
        updated_at     INTEGER,
        PRIMARY KEY (provider, song_id)
      );

      -- 录音级标签：同一首歌在多源只存一行，避免打两次标（双倍模型费用）
      -- 以及同一首歌出现互相矛盾的 mood。未合并的歌继续用 song_tags。
      CREATE TABLE IF NOT EXISTS recording_tags (
        recording_id   TEXT PRIMARY KEY,
        provider       TEXT NOT NULL DEFAULT 'legacy',
        song_id        TEXT NOT NULL,
        title          TEXT,
        artist         TEXT,
        artist_key     TEXT,
        source         TEXT,
        year           INTEGER,
        language       TEXT,
        genre          TEXT,
        instruments    TEXT,
        mood           TEXT,
        energy         REAL,
        valence        REAL,
        tempo          TEXT,
        has_vocal      INTEGER,
        vocal_softness REAL,
        scenes         TEXT,
        themes         TEXT,
        confidence     REAL,
        source_text    TEXT,
        created_at     INTEGER,
        updated_at     INTEGER
      );

      CREATE TABLE IF NOT EXISTS artist_tags (
        artist_key   TEXT PRIMARY KEY,
        artist_name  TEXT,
        gender       TEXT,
        genre        TEXT,
        region       TEXT,
        confidence   REAL,
        source       TEXT,
        created_at   INTEGER,
        updated_at   INTEGER
      );

    `);

    this._migrateSongTagsIfNeeded();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_song_tags_identity   ON song_tags(provider, song_id);
      CREATE INDEX IF NOT EXISTS idx_song_tags_mood       ON song_tags(mood);
      CREATE INDEX IF NOT EXISTS idx_song_tags_genre      ON song_tags(genre);
      CREATE INDEX IF NOT EXISTS idx_song_tags_has_vocal  ON song_tags(has_vocal);
      CREATE INDEX IF NOT EXISTS idx_song_tags_language   ON song_tags(language);
      CREATE INDEX IF NOT EXISTS idx_song_tags_artist_key ON song_tags(artist_key);
    `);

    this._prepare();
    return this;
  }

  _migrateSongTagsIfNeeded() {
    const columns = this.db.prepare(`PRAGMA table_info(song_tags)`).all();
    const provider = columns.find(column => column.name === 'provider');
    const songId = columns.find(column => column.name === 'song_id');
    if (provider?.pk === 1 && songId?.pk === 2) return { migrated: false, legacyRows: 0 };

    let report = null;
    const migrate = this.db.transaction(() => {
      this.db.exec(`DROP TABLE IF EXISTS song_tags_provider_shadow`);
      this.db.exec(`
        CREATE TABLE song_tags_provider_shadow (
          provider       TEXT NOT NULL,
          song_id        TEXT NOT NULL,
          title          TEXT,
          artist         TEXT,
          artist_key     TEXT,
          source         TEXT,
          year           INTEGER,
          language       TEXT,
          genre          TEXT,
          instruments    TEXT,
          mood           TEXT,
          energy         REAL,
          valence        REAL,
          tempo          TEXT,
          has_vocal      INTEGER,
          vocal_softness REAL,
          scenes         TEXT,
          themes         TEXT,
          confidence     REAL,
          source_text    TEXT,
          created_at     INTEGER,
          updated_at     INTEGER,
          PRIMARY KEY (provider, song_id)
        )
      `);
      const oldHasProvider = columns.some(column => column.name === 'provider');
      const providerExpr = oldHasProvider
        ? `CASE WHEN provider IN ('ncm','qq','legacy') THEN provider ELSE 'legacy' END`
        : `CASE
            WHEN lower(COALESCE(source,'')) = 'ncm' OR lower(COALESCE(source,'')) LIKE 'ncm:%' THEN 'ncm'
            WHEN lower(COALESCE(source,'')) = 'qq' OR lower(COALESCE(source,'')) LIKE 'qq:%' THEN 'qq'
            ELSE 'legacy'
          END`;
      const copyColumns = SONG_COLUMNS.filter(name => name !== 'provider').join(', ');
      this.db.exec(`
        INSERT INTO song_tags_provider_shadow (provider, ${copyColumns})
        SELECT ${providerExpr}, ${copyColumns} FROM song_tags
      `);
      const before = this.db.prepare(`SELECT COUNT(*) AS n FROM song_tags`).get().n;
      const after = this.db.prepare(`SELECT COUNT(*) AS n FROM song_tags_provider_shadow`).get().n;
      const legacyRows = this.db.prepare(`
        SELECT COUNT(*) AS n FROM song_tags_provider_shadow WHERE provider = 'legacy'
      `).get().n;
      if (before !== after) throw new Error(`song_tags migration row-count mismatch: ${before} != ${after}`);
      this.migrationHook?.({ stage: 'before-replace', before, after, legacyRows });
      this.db.exec(`ALTER TABLE song_tags RENAME TO song_tags_pre_provider_migration`);
      this.db.exec(`ALTER TABLE song_tags_provider_shadow RENAME TO song_tags`);
      this.db.exec(`DROP TABLE song_tags_pre_provider_migration`);
      report = { migrated: true, rows: after, legacyRows };
    });
    migrate();
    return report;
  }

  _prepare() {
    const cols = SONG_COLUMNS.join(', ');
    const vals = SONG_COLUMNS.map(c => `@${c}`).join(', ');
    // 冲突时更新除 identity / created_at 外的所有列（created_at 保留）
    const updates = SONG_COLUMNS
      .filter(c => c !== 'provider' && c !== 'song_id' && c !== 'created_at')
      .map(c => `${c}=excluded.${c}`)
      .join(', ');

    this._stmts.upsertSong = this.db.prepare(`
      INSERT INTO song_tags (${cols}) VALUES (${vals})
      ON CONFLICT(provider, song_id) DO UPDATE SET ${updates}
    `);
    this._stmts.getSong = this.db.prepare(`SELECT * FROM song_tags WHERE provider = ? AND song_id = ?`);
    this._stmts.getSongsById = this.db.prepare(`SELECT * FROM song_tags WHERE song_id = ? ORDER BY provider`);
    this._stmts.deleteSong = this.db.prepare(`DELETE FROM song_tags WHERE provider = ? AND song_id = ?`);
    this._stmts.getRecordingTags = this.db.prepare(`SELECT * FROM recording_tags WHERE recording_id = ?`);
    this._stmts.upsertRecordingTags = this.db.prepare(`
      INSERT INTO recording_tags (recording_id, ${cols}) VALUES (@recording_id, ${vals})
      ON CONFLICT(recording_id) DO UPDATE SET ${updates}
    `);
    this._stmts.deleteRecordingTags = this.db.prepare(`DELETE FROM recording_tags WHERE recording_id = ?`);
    this._stmts.countSongs = this.db.prepare(`SELECT COUNT(*) AS n FROM song_tags`);
    this._stmts.countTagged = this.db.prepare(`SELECT COUNT(*) AS n FROM song_tags WHERE confidence > 0`);
    // 标签库浏览：title/artist 大小写不敏感搜索（LIKE 通配符已转义）+ 稳定排序分页。
    const LIST_WHERE = `
      WHERE (:search = ''
        OR lower(COALESCE(title, '')) LIKE :pattern ESCAPE '\\'
        OR lower(COALESCE(artist, '')) LIKE :pattern ESCAPE '\\')
    `;
    this._stmts.listSongs = this.db.prepare(`
      SELECT * FROM song_tags ${LIST_WHERE}
      ORDER BY updated_at DESC, provider, song_id
      LIMIT :limit OFFSET :offset
    `);
    this._stmts.countSongsFiltered = this.db.prepare(
      `SELECT COUNT(*) AS n FROM song_tags ${LIST_WHERE}`);
    // needsTagging 豁免：source='user' 的行视为始终新鲜（用户手工修正是权威数据）。

    this._stmts.upsertArtist = this.db.prepare(`
      INSERT INTO artist_tags
        (artist_key, artist_name, gender, genre, region, confidence, source, created_at, updated_at)
      VALUES
        (@artist_key, @artist_name, @gender, @genre, @region, @confidence, @source, @created_at, @updated_at)
      ON CONFLICT(artist_key) DO UPDATE SET
        artist_name=excluded.artist_name, gender=excluded.gender, genre=excluded.genre,
        region=excluded.region, confidence=excluded.confidence, source=excluded.source,
        updated_at=excluded.updated_at
    `);
    this._stmts.getArtist = this.db.prepare(`SELECT * FROM artist_tags WHERE artist_key = ?`);
    this._stmts.artistUpdatedAt = this.db.prepare(`SELECT updated_at FROM artist_tags WHERE artist_key = ?`);
  }

  // ---------- song_tags ----------

  identitiesForSong(songId) {
    return this._stmts.getSongsById.all(String(songId || '')).map(row => ({
      provider: row.provider, song_id: row.song_id, title: row.title, artist: row.artist,
    }));
  }

  /**
   * Upsert 一首歌的标签（幂等，按 song_id）。
   * @param {object} tags - 至少含 song_id；其余字段缺省为 null。
   * @returns {object} 写入后的标签（已 parse JSON 数组）
   */
  upsert(tags) {
    if (!tags || !tags.song_id) throw new Error('songTagStore.upsert: song_id required');
    const now = this.now();
    const provider = providerOf(tags.provider ?? tags.source);
    const artistKey = tags.artist_key != null && tags.artist_key !== ''
      ? String(tags.artist_key)
      : artistKeyOf(tags.artist);
    const row = {
      provider,
      song_id: String(tags.song_id),
      title: str(tags.title),
      artist: str(tags.artist),
      artist_key: artistKey || null,
      source: str(tags.source),
      year: intOrNull(tags.year),
      language: str(tags.language),
      genre: str(tags.genre),
      instruments: toJsonArray(tags.instruments),
      mood: str(tags.mood),
      energy: num(tags.energy),
      valence: num(tags.valence),
      tempo: str(tags.tempo),
      has_vocal: boolInt(tags.has_vocal),
      vocal_softness: num(tags.vocal_softness),
      scenes: toJsonArray(tags.scenes),
      themes: toJsonArray(tags.themes),
      confidence: num(tags.confidence) ?? 0,
      source_text: str(tags.source_text),
      created_at: now,
      updated_at: now,
    };
    // 合并过的歌：一次打标服务整组，第二个源读到的就是这一份，不会再打一次。
    const recording = this._recordingOf(provider, row.song_id);
    if (recording) {
      const existing = this._stmts.getRecordingTags.get(recording.recordingId);
      const merged = toRecordingRow(recording.recordingId, row);
      // 保留原始 created_at，避免纠正一次就把「第一次打标时间」抹掉。
      if (existing?.created_at != null) merged.created_at = existing.created_at;
      this._stmts.upsertRecordingTags.run(merged);
      return this.getTags(row.song_id, provider);
    }
    this._stmts.upsertSong.run(row);
    return this.getTags(row.song_id, provider);
  }

  /** 读一首歌的标签；缺行返 null（不抛）。JSON 数组列已 parse。 */
  getTags(songId, provider = undefined) {
    if (!songId) return null;
    const id = String(songId);
    const providerValue = provider != null && provider !== '' ? providerOf(provider) : null;

    // 合并过的歌：标签属于「这首歌」，不属于某一个源。
    if (providerValue) {
      const recording = this._recordingOf(providerValue, id);
      if (recording) {
        const merged = this._stmts.getRecordingTags.get(recording.recordingId);
        if (merged) return decorate(merged, recording.recordingId);
        // 合并之前可能已经用某个源的身份打过标：把它提升过来，而不是重打一遍。
        const promoted = this._promoteRecordingTags(recording);
        if (promoted) return decorate(promoted, recording.recordingId);
      }
    }

    let row;
    if (providerValue) {
      row = this._stmts.getSong.get(providerValue, id);
    } else {
      const rows = this._stmts.getSongsById.all(id);
      row = rows.length === 1 ? rows[0] : rows.find(item => item.provider === 'legacy');
    }
    if (!row) return null;
    return decorate(row, null);
  }

  /**
   * 批量读同一 provider 的标签（ground-music-selection-in-taste 2.2）：未跨源合并的歌一次 IN 查询，
   * 合并过的歌（少数）仍走 getTags 的录音级读取，结果与逐条 getTags 一致。返回 Map<songId, tags|null>。
   */
  getTagsMany(provider, songIds = []) {
    const out = new Map();
    const ids = [...new Set((songIds || []).map(id => String(id ?? '')).filter(Boolean))];
    if (!ids.length) return out;
    if (provider == null || provider === '') {
      for (const id of ids) out.set(id, this.getTags(id));
      return out;
    }
    const providerValue = providerOf(provider);
    for (const id of ids) out.set(id, null); // 结果顺序与入参一致
    let merged;
    try {
      const recordings = this._getRecordingStore?.();
      merged = !recordings ? new Set()
        : typeof recordings.memberSongIds === 'function' ? recordings.memberSongIds(providerValue, ids) : null;
    } catch {
      merged = new Set(); // 身份层不可用时与 _recordingOf 一样退回供给身份。
    }
    if (!merged) {
      for (const id of ids) out.set(id, this.getTags(id, providerValue));
      return out;
    }
    const plain = ids.filter(id => !merged.has(id));
    for (let start = 0; start < plain.length; start += 400) {
      const chunk = plain.slice(start, start + 400);
      const rows = this.db.prepare(`SELECT * FROM song_tags WHERE provider = ? AND song_id IN (${chunk.map(() => '?').join(',')})`)
        .all(providerValue, ...chunk);
      const byId = new Map(rows.map(row => [String(row.song_id), row]));
      for (const id of chunk) out.set(id, byId.has(id) ? decorate(byId.get(id), null) : null);
    }
    for (const id of ids) if (merged.has(id)) out.set(id, this.getTags(id, providerValue));
    return out;
  }

  /**
   * 合并前已经存在的标签不能丢：从该录音任一成员的既有行里挑一条最好的，
   * 写进 recording_tags，之后整组共享。挑「真有标签（confidence>0）」优先，
   * 其次更新时间最新。
   */
  _promoteRecordingTags(recording) {
    let best = null;
    for (const member of recording.members || []) {
      const songId = String(member.songId ?? member.song_id ?? '').trim();
      const row = songId ? this._stmts.getSong.get(providerOf(member.provider), songId) : null;
      if (!row) continue;
      if (!best) { best = row; continue; }
      const better = (Number(row.confidence) || 0) > (Number(best.confidence) || 0)
        || ((Number(row.confidence) || 0) === (Number(best.confidence) || 0)
          && (Number(row.updated_at) || 0) > (Number(best.updated_at) || 0));
      if (better) best = row;
    }
    if (!best) return null;
    this._stmts.upsertRecordingTags.run(toRecordingRow(recording.recordingId, best));
    return this._stmts.getRecordingTags.get(recording.recordingId);
  }

  /**
   * 分页浏览标签库（设置 → 歌曲标签）。
   * @param {object} [opts]
   * @param {string} [opts.search] - title/artist 大小写不敏感子串；LIKE 通配符按字面匹配
   * @param {number} [opts.limit] - 默认 200，夹取到 1..500
   * @param {number} [opts.offset] - 默认 0，负值归零
   * @returns {{ items: object[], total: number, limit: number, offset: number }}
   *   items 为 getTags 形态（JSON 数组已 parse、has_vocal 已转布尔），按 updated_at 倒序
   */
  /** 这些 (provider, song_id) 里有多少行真的存在：列表折行后用它修正总数。 */
  countSongTagRows(pairs = []) {
    const list = (Array.isArray(pairs) ? pairs : []).filter(pair => pair?.provider && pair?.songId).slice(0, 500);
    if (!list.length) return 0;
    let count = 0;
    for (const pair of list) {
      if (this._stmts.getSong.get(String(pair.provider), String(pair.songId))) count += 1;
    }
    return count;
  }

  listTags({ search = '', limit = 200, offset = 0 } = {}) {
    const term = String(search ?? '').trim().toLowerCase();
    const cappedLimit = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200)));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const pattern = `%${term.replace(/[\\%_]/gu, char => `\\${char}`)}%`;
    const params = { search: term, pattern, limit: cappedLimit, offset: safeOffset };
    const items = this._stmts.listSongs.all(params).map(row => ({
      ...row,
      has_vocal: row.has_vocal == null ? null : Boolean(row.has_vocal),
      instruments: parseJsonArray(row.instruments),
      scenes: parseJsonArray(row.scenes),
      themes: parseJsonArray(row.themes),
    }));
    return { items, total: this._stmts.countSongsFiltered.get(params).n, limit: cappedLimit, offset: safeOffset };
  }

  /**
   * 是否需要（重新）打标：缺行 → true；updated_at 超过 ttlDays → true。
   * confidence=0 占位行也算「有行」，TTL 内不重试。
   * source='user' 的行是用户手工修正的权威数据：无论多旧都视为新鲜，绝不自动重打。
   */
  needsTagging(songId, providerOrTtl = undefined, ttlDays = DEFAULT_TTL_DAYS) {
    if (!songId) return true;
    const provider = typeof providerOrTtl === 'number' ? undefined : providerOrTtl;
    const successTtlDays = typeof providerOrTtl === 'number' ? providerOrTtl : ttlDays;
    const row = this.getTags(String(songId), provider);
    if (!row) return true;
    if (row.source === 'user') return false;
    const ttlMs = Number(row.confidence) > 0
      ? successTtlDays * DAY_MS
      : DEFAULT_PLACEHOLDER_RETRY_HOURS * 60 * 60 * 1000;
    return (this.now() - row.updated_at) > ttlMs;
  }

  /**
   * 局部更新一首歌的标签（read → merge → upsert）。
   *
   * upsert 会覆盖所有列，直接调它会把没传的字段抹成 null；纠错场景只想改几个字段，
   * 所以先读现有行、用 patch 覆盖、再整行写回。缺行时以 patch 起一张新行（song_id 必填）。
   * @param {string} songId
   * @param {object} patch - 只含要改的字段（其余沿用现值）
   * @returns {object|null} 写回后的标签（store.getTags 形态）；songId 缺失返 null
   */
  patchTags(songId, patch = {}, provider = undefined) {
    const id = songId != null ? String(songId) : '';
    if (!id) return null;
    const resolvedProvider = providerOf(provider ?? patch.provider ?? patch.source);
    const existing = this.getTags(id, provider == null && patch.provider == null && patch.source == null
      ? undefined
      : resolvedProvider) || {};
    const merged = { ...existing, ...patch, provider: existing.provider || resolvedProvider, song_id: id };
    return this.upsert(merged);
  }

  /** 删一首歌的标签行；返回删除的行数（0=本就没有）。 */
  deleteTags(songId, provider = undefined) {
    const id = songId != null ? String(songId) : '';
    if (!id) return 0;
    if (provider == null || provider === '') {
      const existing = this.getTags(id);
      if (!existing) return 0;
      provider = existing.provider;
    }
    return this._stmts.deleteSong.run(providerOf(provider), id).changes || 0;
  }

  // ---------- artist_tags ----------

  /** Upsert 艺人级标签（幂等，按 artist_key）。artist_key 缺省时从 artist_name 推。 */
  upsertArtist(a) {
    if (!a) throw new Error('songTagStore.upsertArtist: input required');
    const key = a.artist_key != null && a.artist_key !== ''
      ? String(a.artist_key)
      : artistKeyOf(a.artist_name || a.artist);
    if (!key) throw new Error('songTagStore.upsertArtist: artist_key/artist_name required');
    const now = this.now();
    const row = {
      artist_key: key,
      artist_name: str(a.artist_name ?? a.artist),
      gender: str(a.gender),
      genre: str(a.genre),
      region: str(a.region),
      confidence: num(a.confidence) ?? 0,
      source: str(a.source),
      created_at: now,
      updated_at: now,
    };
    this._stmts.upsertArtist.run(row);
    return this.getArtistTags(key);
  }

  /** 读艺人标签；缺行返 null（不抛）。 */
  getArtistTags(artistKey) {
    if (!artistKey) return null;
    const row = this._stmts.getArtist.get(String(artistKey));
    return row || null;
  }

  /** 艺人是否需要（重新）打标：缺行 → true；超 TTL → true。 */
  needsArtistTagging(artistKey, ttlDays = DEFAULT_TTL_DAYS) {
    if (!artistKey) return true;
    const row = this._stmts.artistUpdatedAt.get(String(artistKey));
    if (!row) return true;
    return (Date.now() - row.updated_at) > ttlDays * DAY_MS;
  }

  // ---------- 统计（/api/songtags/status 用，PR3）----------

  /** 覆盖率统计：total（含占位）/ tagged（confidence>0）。 */
  /**
   * 撤销跨源关系之前调用：把录音级标签回填成每个成员各自的供给级标签，
   * 这样拆开之后两条都还读得到此前打好的标（撤销不得丢数据）。
   * 不删除 recording_tags 行——留作审计，读取时只在合并态才看它。
   */
  preserveTagsAcrossUnlink({ recordingId, members = [] } = {}) {
    const key = String(recordingId ?? '').trim();
    if (!key) return { ok: false, reason: 'no-recording' };
    const row = this._stmts.getRecordingTags.get(key);
    if (!row) return { ok: true, copied: 0 };
    let copied = 0;
    for (const member of Array.isArray(members) ? members : []) {
      const provider = providerOf(member?.provider);
      const songId = String(member?.songId ?? member?.song_id ?? '').trim();
      if (!provider || !songId) continue;
      // 拆分不能用共享推断覆盖成员原先的独立标签（尤其是用户手工修正）。
      if (this._stmts.getSong.get(provider, songId)) continue;
      const target = { ...row, provider, song_id: songId };
      delete target.recording_id;
      this._stmts.upsertSong.run(target);
      copied += 1;
    }
    return { ok: true, copied };
  }

  stats() {
    const total = this._stmts.countSongs.get().n;
    const tagged = this._stmts.countTagged.get().n;
    return { total, tagged, placeholders: total - tagged };
  }

  close() {
    if (this.db && this._ownsDb) this.db.close();
    this.db = null;
  }
}

// ---- 进程内单例（应用侧用）----
let _singleton = null;
export function getSongTagStore() {
  if (!_singleton) {
    _singleton = new SongTagStore();
    _singleton.initialize();
  }
  return _singleton;
}
