import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveDatabasePath } from '../runtimePaths.js';
import { getTrackArtworkStore } from '../media/sharedTrackArtwork.js';
import { dedupKey } from './dedupKey.js';
import { playlistLooksLiked } from './tasteBootstrap.js';
import { providerRegistry } from '../music/providerRegistry.js';

// 源名单来自注册表；库层只接受可播源的曲目。
const PROVIDERS = new Set(providerRegistry.defaultSourceCandidates());
const IMPORT_STATES = new Set(['pending', 'importing', 'partial', 'complete', 'failed']);
const SYNC_STATES = new Set(['never', 'syncing', 'complete', 'partial', 'failed']);
const PLAYLIST_SYNC_STATES = new Set(['never', 'complete', 'partial', 'failed']);
const TASTE_BOOTSTRAP_STATES = new Set(['pending', 'running', 'complete', 'failed']);
const TASTE_ENRICHMENT_STATES = new Set(['disabled', 'pending', 'running', 'partial', 'complete', 'failed']);
const MAX_SAMPLE_JSON_BYTES = 64 * 1024;
const MAX_PROFILE_JSON_BYTES = 32 * 1024;

function text(value) {
  return value == null ? null : String(value);
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function sourceKey(provider, accountUid) {
  const p = String(provider || '').trim();
  const uid = String(accountUid || '').trim();
  if (!PROVIDERS.has(p)) throw new Error(`unsupported library provider: ${p || '(empty)'}`);
  if (!uid) throw new Error('accountUid is required');
  return { provider: p, accountUid: uid };
}

function boundedJson(value, maxBytes, field) {
  if (value == null) return null;
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error(`${field} must be valid JSON`); }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) throw new Error(`${field} exceeds ${maxBytes} bytes`);
  return JSON.stringify(parsed);
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export class LibraryStore {
  constructor({ dbPath = resolveDatabasePath(), now = () => Date.now(), artworkStore = null } = {}) {
    this.dbPath = dbPath;
    this.now = now;
    // 封面播种的目标。注入点存在只为测试与无封面环境；生产走进程内单例。
    this.artworkStore = typeof artworkStore === 'function' ? artworkStore : () => getTrackArtworkStore();
    this.db = null;
    this._stmts = {};
  }

  initialize() {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS library_sources (
        provider               TEXT NOT NULL,
        account_uid            TEXT NOT NULL,
        import_status          TEXT NOT NULL DEFAULT 'pending',
        last_sync_status       TEXT NOT NULL DEFAULT 'never',
        first_imported_at      INTEGER,
        last_import_attempt_at INTEGER,
        run_started_at         INTEGER,
        last_synced_at         INTEGER,
        last_error             TEXT,
        PRIMARY KEY (provider, account_uid)
      );

      CREATE TABLE IF NOT EXISTS library_playlists (
        provider            TEXT NOT NULL,
        account_uid         TEXT NOT NULL,
        playlist_id         TEXT NOT NULL,
        playlist_name       TEXT,
        remote_track_count  INTEGER,
        first_seen_at       INTEGER NOT NULL,
        last_seen_at        INTEGER NOT NULL,
        last_reconciled_at  INTEGER,
        sync_status         TEXT NOT NULL DEFAULT 'never',
        removed_at          INTEGER,
        last_error          TEXT,
        PRIMARY KEY (provider, account_uid, playlist_id),
        FOREIGN KEY (provider, account_uid)
          REFERENCES library_sources(provider, account_uid)
      );

      CREATE TABLE IF NOT EXISTS library_tracks (
        provider       TEXT NOT NULL,
        account_uid    TEXT NOT NULL,
        playlist_id    TEXT NOT NULL,
        song_id        TEXT NOT NULL,
        playlist_name  TEXT,
        dedup_key      TEXT,
        title          TEXT,
        artist         TEXT,
        album          TEXT,
        duration       INTEGER,
        first_seen_at  INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        removed_at     INTEGER,
        PRIMARY KEY (provider, account_uid, playlist_id, song_id),
        FOREIGN KEY (provider, account_uid, playlist_id)
          REFERENCES library_playlists(provider, account_uid, playlist_id)
      );

      CREATE TABLE IF NOT EXISTS taste_profiles (
        provider                   TEXT NOT NULL,
        account_uid                TEXT NOT NULL,
        bootstrap_status           TEXT NOT NULL DEFAULT 'pending',
        enrichment_status          TEXT NOT NULL DEFAULT 'disabled',
        profile_version            TEXT NOT NULL,
        library_signature          TEXT,
        representative_sample_json TEXT,
        profile_json               TEXT,
        started_at                 INTEGER,
        completed_at               INTEGER,
        updated_at                 INTEGER NOT NULL,
        last_error                 TEXT,
        PRIMARY KEY (provider, account_uid),
        FOREIGN KEY (provider, account_uid)
          REFERENCES library_sources(provider, account_uid)
      );

      CREATE INDEX IF NOT EXISTS idx_library_sources_provider
        ON library_sources(provider, account_uid);
      CREATE INDEX IF NOT EXISTS idx_library_playlists_active
        ON library_playlists(provider, account_uid, removed_at);
      CREATE INDEX IF NOT EXISTS idx_library_tracks_song
        ON library_tracks(provider, account_uid, song_id);
      CREATE INDEX IF NOT EXISTS idx_library_tracks_dedup
        ON library_tracks(dedup_key);
      CREATE INDEX IF NOT EXISTS idx_library_tracks_playlist_active
        ON library_tracks(provider, account_uid, playlist_id, removed_at);
      CREATE INDEX IF NOT EXISTS idx_taste_profiles_status
        ON taste_profiles(bootstrap_status, enrichment_status, updated_at);
    `);
    this._prepare();
    return this;
  }

  _prepare() {
    this._stmts.ensureSource = this.db.prepare(`
      INSERT INTO library_sources (provider, account_uid, import_status, last_sync_status)
      VALUES (?, ?, 'pending', 'never')
      ON CONFLICT(provider, account_uid) DO NOTHING
    `);
    this._stmts.getSource = this.db.prepare(`
      SELECT * FROM library_sources WHERE provider = ? AND account_uid = ?
    `);
    this._stmts.listSources = this.db.prepare(`
      SELECT * FROM library_sources ORDER BY provider, account_uid
    `);
    this._stmts.upsertPlaylist = this.db.prepare(`
      INSERT INTO library_playlists (
        provider, account_uid, playlist_id, playlist_name, remote_track_count,
        first_seen_at, last_seen_at, sync_status, removed_at, last_error
      ) VALUES (
        @provider, @account_uid, @playlist_id, @playlist_name, @remote_track_count,
        @seen_at, @seen_at, 'never', NULL, NULL
      )
      ON CONFLICT(provider, account_uid, playlist_id) DO UPDATE SET
        playlist_name = excluded.playlist_name,
        remote_track_count = excluded.remote_track_count,
        last_seen_at = excluded.last_seen_at,
        removed_at = NULL
    `);
    this._stmts.upsertTrack = this.db.prepare(`
      INSERT INTO library_tracks (
        provider, account_uid, playlist_id, song_id, playlist_name, dedup_key,
        title, artist, album, duration, first_seen_at, last_seen_at, removed_at
      ) VALUES (
        @provider, @account_uid, @playlist_id, @song_id, @playlist_name, @dedup_key,
        @title, @artist, @album, @duration, @seen_at, @seen_at, NULL
      )
      ON CONFLICT(provider, account_uid, playlist_id, song_id) DO UPDATE SET
        playlist_name = excluded.playlist_name,
        dedup_key = excluded.dedup_key,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        duration = excluded.duration,
        last_seen_at = excluded.last_seen_at,
        removed_at = NULL
    `);
    this._stmts.activePlaylists = this.db.prepare(`
      SELECT * FROM library_playlists
      WHERE provider = ? AND account_uid = ? AND removed_at IS NULL
      ORDER BY playlist_id
    `);
    this._stmts.activeTracksForPlaylist = this.db.prepare(`
      SELECT * FROM library_tracks
      WHERE provider = ? AND account_uid = ? AND playlist_id = ? AND removed_at IS NULL
      ORDER BY song_id
    `);
    this._stmts.activeMembershipCount = this.db.prepare(`
      SELECT COUNT(*) AS n FROM library_tracks
      WHERE provider = ? AND account_uid = ? AND playlist_id = ? AND removed_at IS NULL
    `);
  }

  ensureSource(provider, accountUid) {
    const key = sourceKey(provider, accountUid);
    this._stmts.ensureSource.run(key.provider, key.accountUid);
    return this.getSource(key.provider, key.accountUid);
  }

  getSource(provider, accountUid) {
    const key = sourceKey(provider, accountUid);
    return this._stmts.getSource.get(key.provider, key.accountUid) || null;
  }

  listSources() {
    return this._stmts.listSources.all();
  }

  setSourceState(provider, accountUid, patch = {}) {
    const key = sourceKey(provider, accountUid);
    this.ensureSource(key.provider, key.accountUid);
    const allowed = [
      'import_status', 'last_sync_status', 'first_imported_at',
      'last_import_attempt_at', 'run_started_at', 'last_synced_at', 'last_error',
    ];
    const entries = Object.entries(patch).filter(([name]) => allowed.includes(name));
    if (entries.length === 0) return this.getSource(key.provider, key.accountUid);
    if (patch.import_status != null && !IMPORT_STATES.has(patch.import_status)) {
      throw new Error(`invalid import_status: ${patch.import_status}`);
    }
    if (patch.last_sync_status != null && !SYNC_STATES.has(patch.last_sync_status)) {
      throw new Error(`invalid last_sync_status: ${patch.last_sync_status}`);
    }
    const assignments = entries.map(([name]) => `${name} = @${name}`).join(', ');
    this.db.prepare(`
      UPDATE library_sources SET ${assignments}
      WHERE provider = @provider AND account_uid = @account_uid
    `).run({ provider: key.provider, account_uid: key.accountUid, ...Object.fromEntries(entries) });
    return this.getSource(key.provider, key.accountUid);
  }

  beginRun(provider, accountUid, { kind = 'import', at = this.now() } = {}) {
    const patch = kind === 'sync'
      ? { last_sync_status: 'syncing', run_started_at: at, last_error: null }
      : { import_status: 'importing', last_import_attempt_at: at, run_started_at: at, last_error: null };
    return this.setSourceState(provider, accountUid, patch);
  }

  finishImport(provider, accountUid, { complete, error = null, at = this.now() } = {}) {
    const current = this.ensureSource(provider, accountUid);
    const patch = {
      import_status: complete ? 'complete' : 'partial',
      run_started_at: null,
      last_error: error ? String(error) : null,
    };
    if (complete && current.first_imported_at == null) patch.first_imported_at = at;
    return this.setSourceState(provider, accountUid, patch);
  }

  failImport(provider, accountUid, error) {
    return this.setSourceState(provider, accountUid, {
      import_status: 'failed', run_started_at: null, last_error: String(error || 'import failed'),
    });
  }

  finishSync(provider, accountUid, { complete, error = null, at = this.now() } = {}) {
    const patch = {
      last_sync_status: complete ? 'complete' : 'partial',
      run_started_at: null,
      last_error: error ? String(error) : null,
    };
    if (complete) patch.last_synced_at = at;
    return this.setSourceState(provider, accountUid, patch);
  }

  failSync(provider, accountUid, error) {
    return this.setSourceState(provider, accountUid, {
      last_sync_status: 'failed', run_started_at: null, last_error: String(error || 'sync failed'),
    });
  }

  recoverStaleRuns() {
    const rows = this.db.prepare(`
      SELECT provider, account_uid, import_status, last_sync_status
      FROM library_sources
      WHERE run_started_at IS NOT NULL
        OR import_status = 'importing'
        OR last_sync_status = 'syncing'
    `).all();
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        const patch = { run_started_at: null, last_error: 'stale run recovered after restart' };
        if (row.import_status === 'importing') patch.import_status = 'partial';
        if (row.last_sync_status === 'syncing') patch.last_sync_status = 'partial';
        this.setSourceState(row.provider, row.account_uid, patch);
      }
    });
    tx();
    return rows.length;
  }

  upsertPlaylist(provider, accountUid, playlist, at = this.now()) {
    const key = sourceKey(provider, accountUid);
    this.ensureSource(key.provider, key.accountUid);
    const playlistId = String(playlist?.id ?? playlist?.playlist_id ?? '').trim();
    if (!playlistId) throw new Error('playlist id is required');
    this._stmts.upsertPlaylist.run({
      provider: key.provider,
      account_uid: key.accountUid,
      playlist_id: playlistId,
      playlist_name: text(playlist?.name ?? playlist?.playlist_name),
      remote_track_count: integer(playlist?.trackCount ?? playlist?.remote_track_count),
      seen_at: at,
    });
    return this.db.prepare(`
      SELECT * FROM library_playlists
      WHERE provider = ? AND account_uid = ? AND playlist_id = ?
    `).get(key.provider, key.accountUid, playlistId);
  }

  listActivePlaylists(provider, accountUid) {
    const key = sourceKey(provider, accountUid);
    return this._stmts.activePlaylists.all(key.provider, key.accountUid);
  }

  setPlaylistState(provider, accountUid, playlistId, patch = {}) {
    const key = sourceKey(provider, accountUid);
    const allowed = ['sync_status', 'last_reconciled_at', 'last_error', 'remote_track_count'];
    const entries = Object.entries(patch).filter(([name]) => allowed.includes(name));
    if (patch.sync_status != null && !PLAYLIST_SYNC_STATES.has(patch.sync_status)) {
      throw new Error(`invalid playlist sync_status: ${patch.sync_status}`);
    }
    if (!entries.length) return null;
    const assignments = entries.map(([name]) => `${name} = @${name}`).join(', ');
    this.db.prepare(`
      UPDATE library_playlists SET ${assignments}
      WHERE provider = @provider AND account_uid = @account_uid AND playlist_id = @playlist_id
    `).run({
      provider: key.provider, account_uid: key.accountUid, playlist_id: String(playlistId),
      ...Object.fromEntries(entries),
    });
    return this.db.prepare(`
      SELECT * FROM library_playlists
      WHERE provider = ? AND account_uid = ? AND playlist_id = ?
    `).get(key.provider, key.accountUid, String(playlistId)) || null;
  }

  reconcilePlaylistSet(provider, accountUid, playlists, { complete, at = this.now() } = {}) {
    const key = sourceKey(provider, accountUid);
    const observed = new Set();
    const tx = this.db.transaction(() => {
      for (const playlist of playlists || []) {
        const id = String(playlist?.id ?? playlist?.playlist_id ?? '').trim();
        if (!id) continue;
        observed.add(id);
        this.upsertPlaylist(key.provider, key.accountUid, playlist, at);
      }
      if (complete) {
        for (const local of this.listActivePlaylists(key.provider, key.accountUid)) {
          if (!observed.has(String(local.playlist_id))) {
            this._tombstonePlaylistInTransaction(key.provider, key.accountUid, local.playlist_id, at);
          }
        }
      }
    });
    tx();
    return this.listActivePlaylists(key.provider, key.accountUid);
  }

  _tombstonePlaylistInTransaction(provider, accountUid, playlistId, at) {
    this.db.prepare(`
      UPDATE library_playlists SET removed_at = ?
      WHERE provider = ? AND account_uid = ? AND playlist_id = ? AND removed_at IS NULL
    `).run(at, provider, accountUid, String(playlistId));
    this.db.prepare(`
      UPDATE library_tracks SET removed_at = ?
      WHERE provider = ? AND account_uid = ? AND playlist_id = ? AND removed_at IS NULL
    `).run(at, provider, accountUid, String(playlistId));
  }

  tombstonePlaylist(provider, accountUid, playlistId, at = this.now()) {
    const key = sourceKey(provider, accountUid);
    const tx = this.db.transaction(() => {
      this._tombstonePlaylistInTransaction(key.provider, key.accountUid, playlistId, at);
    });
    tx();
  }

  reconcileTracks(provider, accountUid, playlist, tracks, {
    complete, at = this.now(), error = null,
  } = {}) {
    const key = sourceKey(provider, accountUid);
    const playlistRow = this.upsertPlaylist(key.provider, key.accountUid, playlist, at);
    const playlistId = String(playlistRow.playlist_id);
    const observed = new Set();
    const tx = this.db.transaction(() => {
      for (const track of tracks || []) {
        const songId = String(track?.song_id ?? track?.songId ?? track?.id ?? '').trim();
        if (!songId) continue;
        observed.add(songId);
        this._stmts.upsertTrack.run({
          provider: key.provider,
          account_uid: key.accountUid,
          playlist_id: playlistId,
          song_id: songId,
          playlist_name: text(playlistRow.playlist_name),
          dedup_key: dedupKey(track?.title, track?.artist),
          title: text(track?.title),
          artist: text(track?.artist),
          album: text(track?.album),
          duration: integer(track?.duration),
          seen_at: at,
        });
      }
      if (complete) {
        for (const local of this._stmts.activeTracksForPlaylist.all(key.provider, key.accountUid, playlistId)) {
          if (!observed.has(String(local.song_id))) {
            this.db.prepare(`
              UPDATE library_tracks SET removed_at = ?
              WHERE provider = ? AND account_uid = ? AND playlist_id = ? AND song_id = ?
                AND removed_at IS NULL
            `).run(at, key.provider, key.accountUid, playlistId, local.song_id);
          }
        }
      }
      this.setPlaylistState(key.provider, key.accountUid, playlistId, {
        sync_status: complete ? 'complete' : 'partial',
        last_reconciled_at: complete ? at : playlistRow.last_reconciled_at,
        last_error: error ? String(error) : null,
      });
    });
    tx();
    // 播种必须发生在事务提交之后：封面缓存在自己的连接/表上，WAL 下两个写者
    // 同时开会撞 SQLITE_BUSY。封面是展示元数据，失败绝不能让导入失败。
    this._seedArtwork(key.provider, tracks);
    return this._stmts.activeTracksForPlaylist.all(key.provider, key.accountUid, playlistId);
  }

  /** provider snapshot 自带的封面 URL 直接落缓存，省掉后续一次网络查询。 */
  _seedArtwork(provider, tracks) {
    try {
      this.artworkStore?.()?.seed?.(provider, tracks || []);
    } catch { /* 封面播种失败不影响导入 */ }
  }

  activeMembershipCount(provider, accountUid, playlistId) {
    const key = sourceKey(provider, accountUid);
    return this._stmts.activeMembershipCount.get(key.provider, key.accountUid, String(playlistId)).n;
  }

  listActiveMemberships(provider, accountUid) {
    const key = sourceKey(provider, accountUid);
    return this.db.prepare(`
      SELECT playlist_id, playlist_name, song_id, title, artist, album, duration, last_seen_at
      FROM library_tracks
      WHERE provider = ? AND account_uid = ? AND removed_at IS NULL
      ORDER BY playlist_id, song_id
    `).all(key.provider, key.accountUid);
  }

  librarySignature(provider, accountUid) {
    const key = sourceKey(provider, accountUid);
    const rows = this.db.prepare(`
      SELECT playlist_id, song_id, COALESCE(title,'') title, COALESCE(artist,'') artist
      FROM library_tracks
      WHERE provider = ? AND account_uid = ? AND removed_at IS NULL
      ORDER BY playlist_id, song_id
    `).all(key.provider, key.accountUid);
    const hash = createHash('sha256');
    for (const row of rows) hash.update(`${row.playlist_id}\u0000${row.song_id}\u0000${row.title}\u0000${row.artist}\n`);
    return `sha256:${hash.digest('hex')}`;
  }

  getTasteProfile(provider, accountUid) {
    const key = sourceKey(provider, accountUid);
    const row = this.db.prepare(`
      SELECT * FROM taste_profiles WHERE provider = ? AND account_uid = ?
    `).get(key.provider, key.accountUid);
    if (!row) return null;
    return {
      ...row,
      representative_sample: parseJsonObject(row.representative_sample_json),
      profile: parseJsonObject(row.profile_json),
    };
  }

  listTasteProfiles() {
    return this.db.prepare(`SELECT provider, account_uid FROM taste_profiles ORDER BY provider, account_uid`)
      .all().map(row => this.getTasteProfile(row.provider, row.account_uid));
  }

  upsertTasteProfile(provider, accountUid, patch = {}) {
    const key = sourceKey(provider, accountUid);
    this.ensureSource(key.provider, key.accountUid);
    const current = this.getTasteProfile(key.provider, key.accountUid);
    const profileVersion = String(patch.profile_version ?? current?.profile_version ?? '').trim();
    if (!profileVersion) throw new Error('profile_version is required');
    const bootstrapStatus = patch.bootstrap_status ?? current?.bootstrap_status ?? 'pending';
    const enrichmentStatus = patch.enrichment_status ?? current?.enrichment_status ?? 'disabled';
    if (!TASTE_BOOTSTRAP_STATES.has(bootstrapStatus)) throw new Error(`invalid bootstrap_status: ${bootstrapStatus}`);
    if (!TASTE_ENRICHMENT_STATES.has(enrichmentStatus)) throw new Error(`invalid enrichment_status: ${enrichmentStatus}`);
    const sampleJson = Object.hasOwn(patch, 'representative_sample_json') || Object.hasOwn(patch, 'representative_sample')
      ? boundedJson(patch.representative_sample_json ?? patch.representative_sample, MAX_SAMPLE_JSON_BYTES, 'representative_sample_json')
      : current?.representative_sample_json ?? null;
    const profileJson = Object.hasOwn(patch, 'profile_json') || Object.hasOwn(patch, 'profile')
      ? boundedJson(patch.profile_json ?? patch.profile, MAX_PROFILE_JSON_BYTES, 'profile_json')
      : current?.profile_json ?? null;
    const row = {
      provider: key.provider,
      account_uid: key.accountUid,
      bootstrap_status: bootstrapStatus,
      enrichment_status: enrichmentStatus,
      profile_version: profileVersion,
      library_signature: patch.library_signature ?? current?.library_signature ?? null,
      representative_sample_json: sampleJson,
      profile_json: profileJson,
      started_at: Object.hasOwn(patch, 'started_at') ? patch.started_at : current?.started_at ?? null,
      completed_at: Object.hasOwn(patch, 'completed_at') ? patch.completed_at : current?.completed_at ?? null,
      updated_at: patch.updated_at ?? this.now(),
      last_error: Object.hasOwn(patch, 'last_error') ? patch.last_error : current?.last_error ?? null,
    };
    this.db.prepare(`
      INSERT INTO taste_profiles (
        provider, account_uid, bootstrap_status, enrichment_status, profile_version,
        library_signature, representative_sample_json, profile_json, started_at,
        completed_at, updated_at, last_error
      ) VALUES (
        @provider, @account_uid, @bootstrap_status, @enrichment_status, @profile_version,
        @library_signature, @representative_sample_json, @profile_json, @started_at,
        @completed_at, @updated_at, @last_error
      ) ON CONFLICT(provider, account_uid) DO UPDATE SET
        bootstrap_status=excluded.bootstrap_status,
        enrichment_status=excluded.enrichment_status,
        profile_version=excluded.profile_version,
        library_signature=excluded.library_signature,
        representative_sample_json=excluded.representative_sample_json,
        profile_json=excluded.profile_json,
        started_at=excluded.started_at,
        completed_at=excluded.completed_at,
        updated_at=excluded.updated_at,
        last_error=excluded.last_error
    `).run(row);
    return this.getTasteProfile(key.provider, key.accountUid);
  }

  recoverStaleTasteProfiles({ staleBefore = this.now() } = {}) {
    const info = this.db.prepare(`
      UPDATE taste_profiles
      SET bootstrap_status=CASE WHEN bootstrap_status='running' THEN 'pending' ELSE bootstrap_status END,
          enrichment_status=CASE
            WHEN enrichment_status='running' THEN 'pending' ELSE enrichment_status END,
          started_at=NULL, updated_at=?, last_error='stale taste bootstrap recovered after restart'
      WHERE (bootstrap_status='running' OR enrichment_status='running')
        AND started_at IS NOT NULL AND started_at < ?
    `).run(this.now(), staleBefore);
    return info.changes;
  }

  listActiveSongs({ limit = null } = {}) {
    const bounded = limit != null && Number.isFinite(Number(limit))
      ? Math.max(0, Math.trunc(Number(limit)))
      : null;
    const sql = `
      SELECT provider, song_id,
             MAX(title) AS title, MAX(artist) AS artist, MAX(album) AS album,
             MAX(duration) AS duration, MAX(last_seen_at) AS last_seen_at
      FROM library_tracks
      WHERE removed_at IS NULL
      GROUP BY provider, song_id
      ORDER BY MAX(last_seen_at) DESC, provider, song_id
      ${bounded == null ? '' : 'LIMIT ?'}
    `;
    return bounded == null ? this.db.prepare(sql).all() : this.db.prepare(sql).all(bounded);
  }

  /** Persistent collection references; no account identifiers or playlist text leave this projection. */
  listCollectionTracks() {
    const rows = this.db.prepare(`
      SELECT t.provider, t.song_id, t.title, t.artist, t.album, t.duration, p.playlist_name
      FROM library_tracks t JOIN library_playlists p
        ON p.provider=t.provider AND p.account_uid=t.account_uid AND p.playlist_id=t.playlist_id
      WHERE t.removed_at IS NULL AND p.removed_at IS NULL
      ORDER BY t.last_seen_at DESC, t.provider, t.song_id
    `).all();
    const songs = new Map();
    for (const row of rows) {
      const key = `${row.provider}:${row.song_id}`;
      if (!songs.has(key)) {
        const { playlist_name: _privateName, ...track } = row;
        songs.set(key, { ...track, source: `${row.provider}:library`, collectionKind: 'playlist' });
      }
      // Conservative default-list labels rank sources only; never infer a remote heart.
      if (/^(?:我喜欢(?:的音乐)?|我的收藏|liked(?: songs)?|favou?rites?)$/i.test(String(row.playlist_name || '').trim())) {
        songs.get(key).collectionKind = 'liked';
      }
    }
    return [...songs.values()];
  }

  listLikedArtists() {
    // The import already marks liked membership by playlist name; use the same
    // narrow rule as taste bootstrap, without treating every imported song as familiar.
    return [...new Set(this.db.prepare(`SELECT artist, playlist_name FROM library_tracks
      WHERE removed_at IS NULL AND artist IS NOT NULL AND artist <> ''`).all()
      .filter(row => playlistLooksLiked(row.playlist_name)).map(row => row.artist))];
  }

  hasAnyMembership() {
    return this.db.prepare(`SELECT 1 AS yes FROM library_tracks LIMIT 1`).get()?.yes === 1;
  }

  sourceStatus(provider, accountUid) {
    const key = sourceKey(provider, accountUid);
    const source = this.getSource(key.provider, key.accountUid);
    if (!source) return null;
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM library_playlists
          WHERE provider=@provider AND account_uid=@account_uid AND removed_at IS NULL) active_playlists,
        (SELECT COUNT(*) FROM library_playlists
          WHERE provider=@provider AND account_uid=@account_uid AND removed_at IS NOT NULL) tombstoned_playlists,
        (SELECT COUNT(*) FROM library_tracks
          WHERE provider=@provider AND account_uid=@account_uid AND removed_at IS NULL) active_memberships,
        (SELECT COUNT(*) FROM library_tracks
          WHERE provider=@provider AND account_uid=@account_uid AND removed_at IS NOT NULL) tombstoned_memberships,
        (SELECT COUNT(DISTINCT song_id) FROM library_tracks
          WHERE provider=@provider AND account_uid=@account_uid AND removed_at IS NULL) distinct_songs,
        (SELECT COUNT(*) FROM library_playlists
          WHERE provider=@provider AND account_uid=@account_uid AND removed_at IS NULL
            AND sync_status IN ('partial','failed')) incomplete_playlists
    `).get({ provider: key.provider, account_uid: key.accountUid });
    const taste = this.getTasteProfile(key.provider, key.accountUid);
    return {
      ...source,
      ...counts,
      taste: taste ? {
        bootstrap_status: taste.bootstrap_status,
        enrichment_status: taste.enrichment_status,
        profile_version: taste.profile_version,
        library_signature: taste.library_signature,
        sample_size: taste.representative_sample?.items?.length || 0,
        coverage: taste.profile?.coverage || null,
        started_at: taste.started_at,
        completed_at: taste.completed_at,
        updated_at: taste.updated_at,
        last_error: taste.last_error,
      } : null,
    };
  }

  allSourceStatuses() {
    return this.listSources().map(row => this.sourceStatus(row.provider, row.account_uid));
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }
}

let singleton = null;
export function getLibraryStore() {
  if (!singleton) singleton = new LibraryStore().initialize();
  return singleton;
}
