// LifeContextStore — 今日生活数据的本地 SQLite 存储。
// 表结构与写入都为增量：不自动导入 user/routines.md，不动其他服务的表。
// 删除/撤回不保留正文，只留最小失效凭据（life_revocations），防止旧快照复活来源。

import { openSqliteDatabase } from '../sqlite.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export const LIFE_SCHEMA_VERSION = 5;

const LIFE_ENTRIES_CANONICAL = `
    CREATE TABLE life_entries (
      id                    TEXT PRIMARY KEY,
      type                  TEXT NOT NULL,
      title                 TEXT NOT NULL,
      content               TEXT,
      local_date            TEXT NOT NULL,
      end_date              TEXT,
      start_time            TEXT,
      end_time              TEXT,
      done                  INTEGER NOT NULL DEFAULT 0,
      yearly_repeat         INTEGER NOT NULL DEFAULT 0,
      use_for_companionship INTEGER NOT NULL DEFAULT 0,
      note_uses_title       INTEGER NOT NULL DEFAULT 0,
      companion_note        TEXT,
      allowed_person_ids    TEXT NOT NULL DEFAULT '[]',
      scene_tag              TEXT,
      mood                  TEXT,
      tags_json             TEXT NOT NULL DEFAULT '[]',
      pinned                INTEGER NOT NULL DEFAULT 0,
      archived              INTEGER NOT NULL DEFAULT 0,
      share_scope           TEXT NOT NULL DEFAULT 'summary',
      attached_track_json   TEXT,
      attached_tracks_json  TEXT NOT NULL DEFAULT '[]',
      attached_quotes_json  TEXT NOT NULL DEFAULT '[]',
      checklist_json        TEXT NOT NULL DEFAULT '[]',
      annotations_json      TEXT NOT NULL DEFAULT '[]',
      layout_variant        TEXT NOT NULL DEFAULT 'blank',
      revision              INTEGER NOT NULL DEFAULT 1,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    )`;

/**
 * 旧版 life_entries 把 type CHECK 在 ('event','todo','important_date')，
 * 新增的 note（随笔）写入会撞 SQLITE_CONSTRAINT。SQLite 无法删 CHECK，
 * 只能整表重建；迁移在 ALTER 补齐 content 之后执行，列必然齐全。
 */
function rebuildLegacyLifeEntries(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'life_entries'`).get();
  if (!row || !/CHECK\s*\(/i.test(row.sql || '')) return;
  const rebuild = db.transaction(() => {
    db.exec(`ALTER TABLE life_entries RENAME TO life_entries_legacy;
      ${LIFE_ENTRIES_CANONICAL};
      INSERT INTO life_entries (id, type, title, content, local_date, end_date, start_time, end_time, done,
        yearly_repeat, use_for_companionship, note_uses_title, companion_note, allowed_person_ids, scene_tag,
        revision, created_at, updated_at)
        SELECT id, type, title, content, local_date, end_date, start_time, end_time, done,
        yearly_repeat, use_for_companionship, note_uses_title, companion_note, allowed_person_ids, scene_tag,
        revision, created_at, updated_at FROM life_entries_legacy;
      DROP TABLE life_entries_legacy;`);
  });
  rebuild();
}

function createLifeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS life_routine (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      time_zone       TEXT NOT NULL,
      work_days       TEXT NOT NULL DEFAULT '[]',
      work_start_time TEXT,
      work_end_time   TEXT,
      revision        INTEGER NOT NULL DEFAULT 1,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS life_day_overrides (
      local_date TEXT PRIMARY KEY,
      day_type   TEXT NOT NULL CHECK (day_type IN ('work', 'rest')),
      start_time TEXT,
      end_time   TEXT,
      revision   INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS life_entries (
      id                    TEXT PRIMARY KEY,
      type                  TEXT NOT NULL,
      title                 TEXT NOT NULL,
      content               TEXT,
      local_date            TEXT NOT NULL,
      end_date              TEXT,
      start_time            TEXT,
      end_time              TEXT,
      done                  INTEGER NOT NULL DEFAULT 0,
      yearly_repeat         INTEGER NOT NULL DEFAULT 0,
      use_for_companionship INTEGER NOT NULL DEFAULT 0,
      note_uses_title       INTEGER NOT NULL DEFAULT 0,
      companion_note        TEXT,
      allowed_person_ids    TEXT NOT NULL DEFAULT '[]',
      scene_tag             TEXT,
      mood                  TEXT,
      tags_json             TEXT NOT NULL DEFAULT '[]',
      pinned                INTEGER NOT NULL DEFAULT 0,
      archived              INTEGER NOT NULL DEFAULT 0,
      share_scope           TEXT NOT NULL DEFAULT 'summary',
      attached_track_json   TEXT,
      attached_tracks_json  TEXT NOT NULL DEFAULT '[]',
      attached_quotes_json  TEXT NOT NULL DEFAULT '[]',
      checklist_json        TEXT NOT NULL DEFAULT '[]',
      annotations_json      TEXT NOT NULL DEFAULT '[]',
      layout_variant        TEXT NOT NULL DEFAULT 'blank',
      revision              INTEGER NOT NULL DEFAULT 1,
      created_at            INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS life_scene_defaults (
      scene_tag  TEXT PRIMARY KEY,
      mode_id    TEXT NOT NULL,
      revision   INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS life_revocations (
      source_id   TEXT NOT NULL,
      source_type TEXT NOT NULL,
      revision    INTEGER NOT NULL,
      revoked_at  INTEGER NOT NULL,
      PRIMARY KEY (source_id, source_type)
    );

    -- 删除条目后保留请求身份；不存标题/正文，也不使用会随删除级联清理的外键。
    CREATE TABLE IF NOT EXISTS life_entry_create_requests (
      request_id   TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      entry_id     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS life_meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  try {
    db.exec(`ALTER TABLE life_entries ADD COLUMN content TEXT;`);
  } catch {
    // 字段已存在或表刚建，忽略
  }
  rebuildLegacyLifeEntries(db);
}

export class LifeContextStore {
  constructor({ db = null, dbPath = null, now = () => Date.now() } = {}) {
    this.now = now;
    this.dbPath = dbPath;
    this.ownsDb = !db;
    this.db = db;
    this.initialize();
  }

  initialize() {
    if (this.db?.open && this.statements) return;
    if (this.ownsDb && !this.db?.open) {
      this.db = openSqliteDatabase(this.dbPath);
    }
    const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='life_entries'").get();
    const existingCols = existing ? new Set(this.db.prepare('PRAGMA table_info(life_entries)').all().map(column => column.name)) : null;
    const hasUpgradeV4 = Boolean(existingCols && !existingCols.has('mood'));
    const hasUpgradeV5 = Boolean(existingCols && (!existingCols.has('attached_tracks_json') || !existingCols.has('annotations_json')));
    const needsUpgrade = Boolean(existingCols && !existingCols.has('repeat_frequency')) || hasUpgradeV4 || hasUpgradeV5;
    let migrationRows = null;
    if (needsUpgrade) {
      // VACUUM INTO is a consistent SQLite snapshot including committed WAL rows.
      const backupDir = mkdtempSync(join(tmpdir(), 'lunara-life-upgrade-'));
      this.migrationBackupPath = join(backupDir, 'life.sqlite');
      this.db.prepare('VACUUM INTO ?').run(this.migrationBackupPath);
      const backup = openSqliteDatabase(this.migrationBackupPath, { readonly: true });
      try {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        migrationRows = [];
        for (const { name } of tables) {
          const quoted = '"' + name.replaceAll('"', '""') + '"';
          const before = this.db.prepare(`SELECT * FROM ${quoted}`).all();
          migrationRows.push({ quoted, rows: before });
          const copied = backup.prepare(`SELECT * FROM ${quoted}`).all();
          if (JSON.stringify(before) !== JSON.stringify(copied)) throw new Error('Life backup table verification failed');
        }
      } finally { backup.close(); }
    }
    this.db.transaction(() => {
      createLifeSchema(this.db);
      const columns = this.db.prepare('PRAGMA table_info(life_entries)').all();
      const colNames = new Set(columns.map(column => column.name));
      if (!colNames.has('repeat_frequency')) {
        this.db.exec("ALTER TABLE life_entries ADD COLUMN repeat_frequency TEXT NOT NULL DEFAULT 'none'; ALTER TABLE life_entries ADD COLUMN repeat_weekdays TEXT NOT NULL DEFAULT '[]'; UPDATE life_entries SET repeat_frequency = 'yearly' WHERE yearly_repeat = 1;");
      }
      if (!colNames.has('mood')) this.db.exec('ALTER TABLE life_entries ADD COLUMN mood TEXT;');
      if (!colNames.has('tags_json')) this.db.exec("ALTER TABLE life_entries ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';");
      if (!colNames.has('pinned')) this.db.exec('ALTER TABLE life_entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
      if (!colNames.has('archived')) this.db.exec('ALTER TABLE life_entries ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;');
      if (!colNames.has('share_scope')) this.db.exec("ALTER TABLE life_entries ADD COLUMN share_scope TEXT NOT NULL DEFAULT 'summary';");
      if (!colNames.has('attached_track_json')) this.db.exec('ALTER TABLE life_entries ADD COLUMN attached_track_json TEXT;');
      if (!colNames.has('attached_tracks_json')) {
        this.db.exec("ALTER TABLE life_entries ADD COLUMN attached_tracks_json TEXT NOT NULL DEFAULT '[]';");
        this.db.exec("UPDATE life_entries SET attached_tracks_json = json_array(json(attached_track_json)) WHERE attached_track_json IS NOT NULL AND attached_track_json != '';");
      }
      if (!colNames.has('attached_quotes_json')) this.db.exec("ALTER TABLE life_entries ADD COLUMN attached_quotes_json TEXT NOT NULL DEFAULT '[]';");
      if (!colNames.has('checklist_json')) this.db.exec("ALTER TABLE life_entries ADD COLUMN checklist_json TEXT NOT NULL DEFAULT '[]';");
      if (!colNames.has('annotations_json')) this.db.exec("ALTER TABLE life_entries ADD COLUMN annotations_json TEXT NOT NULL DEFAULT '[]';");
      if (!colNames.has('layout_variant')) this.db.exec("ALTER TABLE life_entries ADD COLUMN layout_variant TEXT NOT NULL DEFAULT 'blank';");
      this.db.exec(`CREATE TABLE IF NOT EXISTS life_entry_completions (
        entry_id TEXT NOT NULL, occurrence_date TEXT NOT NULL, completed_at INTEGER NOT NULL,
        PRIMARY KEY(entry_id, occurrence_date));`);
      for (const { quoted, rows } of migrationRows || []) {
        const columns = rows.length ? Object.keys(rows[0]).map(name => '"' + name.replaceAll('"', '""') + '"').join(', ') : '*';
        const after = this.db.prepare(`SELECT ${columns} FROM ${quoted}`).all();
        if (JSON.stringify(after) !== JSON.stringify(rows)) throw new Error('Life migration table verification failed');
      }
    })();
    this.statements = {
      getMeta: this.db.prepare('SELECT v FROM life_meta WHERE k = ?'),
      setMeta: this.db.prepare('INSERT INTO life_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
      getRoutine: this.db.prepare('SELECT * FROM life_routine WHERE id = 1'),
      upsertRoutine: this.db.prepare(`INSERT INTO life_routine (id, time_zone, work_days, work_start_time, work_end_time, revision, updated_at)
        VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET time_zone = excluded.time_zone, work_days = excluded.work_days,
        work_start_time = excluded.work_start_time, work_end_time = excluded.work_end_time, revision = excluded.revision, updated_at = excluded.updated_at`),
      getOverride: this.db.prepare('SELECT * FROM life_day_overrides WHERE local_date = ?'),
      upsertOverride: this.db.prepare(`INSERT INTO life_day_overrides (local_date, day_type, start_time, end_time, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(local_date) DO UPDATE SET day_type = excluded.day_type, start_time = excluded.start_time,
        end_time = excluded.end_time, revision = excluded.revision, updated_at = excluded.updated_at`),
      deleteOverride: this.db.prepare('DELETE FROM life_day_overrides WHERE local_date = ?'),
      listOverrides: this.db.prepare('SELECT * FROM life_day_overrides ORDER BY local_date'),
      listEntries: this.db.prepare('SELECT * FROM life_entries ORDER BY local_date, start_time IS NULL, start_time, id'),
      listQuotedJson: this.db.prepare("SELECT attached_quotes_json FROM life_entries WHERE attached_quotes_json IS NOT NULL AND attached_quotes_json != '[]'"),
      getEntry: this.db.prepare('SELECT * FROM life_entries WHERE id = ?'),
      getEntryCreateRequest: this.db.prepare('SELECT * FROM life_entry_create_requests WHERE request_id = ?'),
      insertEntryCreateRequest: this.db.prepare('INSERT INTO life_entry_create_requests (request_id, payload_hash, entry_id) VALUES (?, ?, ?)'),
      insertEntry: this.db.prepare(`INSERT INTO life_entries (id, type, title, content, local_date, end_date, start_time, end_time, done,
        yearly_repeat, use_for_companionship, note_uses_title, companion_note, allowed_person_ids, scene_tag,
        mood, tags_json, pinned, archived, share_scope, attached_track_json,
        attached_tracks_json, attached_quotes_json, checklist_json, annotations_json, layout_variant,
        revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`),
      updateEntry: this.db.prepare(`UPDATE life_entries SET type = ?, title = ?, content = ?, local_date = ?, end_date = ?, start_time = ?, end_time = ?,
        done = ?, yearly_repeat = ?, use_for_companionship = ?, note_uses_title = ?, companion_note = ?, allowed_person_ids = ?,
        scene_tag = ?, mood = ?, tags_json = ?, pinned = ?, archived = ?, share_scope = ?, attached_track_json = ?,
        attached_tracks_json = ?, attached_quotes_json = ?, checklist_json = ?, annotations_json = ?, layout_variant = ?,
        revision = ?, updated_at = ? WHERE id = ?`),
      deleteEntry: this.db.prepare('DELETE FROM life_entries WHERE id = ?'),
      getSceneDefault: this.db.prepare('SELECT * FROM life_scene_defaults WHERE scene_tag = ?'),
      upsertSceneDefault: this.db.prepare(`INSERT INTO life_scene_defaults (scene_tag, mode_id, revision, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(scene_tag) DO UPDATE SET mode_id = excluded.mode_id, revision = excluded.revision, updated_at = excluded.updated_at`),
      listSceneDefaults: this.db.prepare('SELECT * FROM life_scene_defaults ORDER BY scene_tag'),
      deleteSceneDefault: this.db.prepare('DELETE FROM life_scene_defaults WHERE scene_tag = ?'),
      insertRevocation: this.db.prepare(`INSERT INTO life_revocations (source_id, source_type, revision, revoked_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(source_id, source_type) DO UPDATE SET revision = excluded.revision, revoked_at = excluded.revoked_at`),
      getRevocation: this.db.prepare('SELECT * FROM life_revocations WHERE source_id = ? AND source_type = ?'),
    };
    if (!this.statements.getMeta.get('context_revision')) {
      this.statements.setMeta.run('context_revision', '0');
    }
  }

  close() {
    if (this.ownsDb && this.db?.open) this.db.close();
  }

  transaction(work) {
    return this.db.transaction(work)();
  }

  contextRevision() {
    return Number.parseInt(this.statements.getMeta.get('context_revision')?.v || '0', 10) || 0;
  }

  bumpContextRevision() {
    const next = this.contextRevision() + 1;
    this.statements.setMeta.run('context_revision', String(next));
    return next;
  }

  getRoutine() {
    return this.statements.getRoutine.get() || null;
  }

  saveRoutine(row) {
    this.statements.upsertRoutine.run(row.timeZone, JSON.stringify(row.workDays ?? []),
      row.workStartTime ?? null, row.workEndTime ?? null, row.revision, this.now());
    return this.bumpContextRevision();
  }

  getOverride(localDate) {
    return this.statements.getOverride.get(localDate) || null;
  }

  listOverrides() {
    return this.statements.listOverrides.all();
  }

  saveOverride(row) {
    this.statements.upsertOverride.run(row.localDate, row.dayType, row.startTime ?? null, row.endTime ?? null,
      row.revision, this.now());
    return this.bumpContextRevision();
  }

  deleteOverride(localDate) {
    this.statements.deleteOverride.run(localDate);
    return this.bumpContextRevision();
  }

  listEntries() {
    const completions = new Map();
    for (const row of this.db.prepare('SELECT entry_id, occurrence_date FROM life_entry_completions ORDER BY entry_id, occurrence_date').all()) {
      let list = completions.get(row.entry_id);
      if (!list) { list = []; completions.set(row.entry_id, list); }
      list.push(row.occurrence_date);
    }
    return this.statements.listEntries.all().map(row => ({ ...row, completed_dates: completions.get(row.id) || [] }));
  }

  getEntry(id) {
    const row = this.statements.getEntry.get(id);
    return row ? { ...row, completed_dates: this.completedDates(id) } : null;
  }

  completedDates(id) {
    return this.db.prepare('SELECT occurrence_date FROM life_entry_completions WHERE entry_id = ? ORDER BY occurrence_date').all(id).map(row => row.occurrence_date);
  }

  setOccurrenceDone(id, date, done) {
    if (done) this.db.prepare('INSERT OR IGNORE INTO life_entry_completions VALUES (?, ?, ?)').run(id, date, this.now());
    else this.db.prepare('DELETE FROM life_entry_completions WHERE entry_id = ? AND occurrence_date = ?').run(id, date);
  }

  saveRepeatRule(id, row) {
    this.db.prepare('UPDATE life_entries SET repeat_frequency = ?, repeat_weekdays = ? WHERE id = ?')
      .run(row.repeatFrequency ?? (row.yearlyRepeat ? 'yearly' : 'none'), JSON.stringify(row.repeatWeekdays || []), id);
  }

  getEntryCreateRequest(requestId) {
    return this.statements.getEntryCreateRequest.get(requestId) || null;
  }

  recordEntryCreateRequest(requestId, payloadHash, entryId) {
    this.statements.insertEntryCreateRequest.run(requestId, payloadHash, entryId);
  }

  insertEntry(row) {
    this.statements.insertEntry.run(row.id, row.type, row.title, row.content ?? null, row.localDate, row.endDate ?? null,
      row.startTime ?? null, row.endTime ?? null, row.done ? 1 : 0, row.yearlyRepeat ? 1 : 0,
      row.useForCompanionship ? 1 : 0, row.noteUsesTitle ? 1 : 0, row.companionNote ?? null,
      JSON.stringify(row.allowedPersonIds ?? []), row.sceneTag ?? null,
      row.mood ?? null, JSON.stringify(row.tags ?? []), row.pinned ? 1 : 0, row.archived ? 1 : 0,
      row.shareScope === 'note' ? 'note' : 'summary',
      row.attachedTrack ? JSON.stringify(row.attachedTrack) : null,
      JSON.stringify(row.attachedTracks ?? []),
      JSON.stringify(row.attachedQuotes ?? []),
      JSON.stringify(row.checklist ?? []),
      JSON.stringify(row.annotations ?? []),
      row.layoutVariant || 'blank',
      this.now(), this.now());
    this.saveRepeatRule(row.id, row);
    return this.bumpContextRevision();
  }

  updateEntry(id, row) {
    this.statements.updateEntry.run(row.type, row.title, row.content ?? null, row.localDate, row.endDate ?? null, row.startTime ?? null,
      row.endTime ?? null, row.done ? 1 : 0, row.yearlyRepeat ? 1 : 0, row.useForCompanionship ? 1 : 0,
      row.noteUsesTitle ? 1 : 0, row.companionNote ?? null, JSON.stringify(row.allowedPersonIds ?? []),
      row.sceneTag ?? null,
      row.mood ?? null, JSON.stringify(row.tags ?? []), row.pinned ? 1 : 0, row.archived ? 1 : 0,
      row.shareScope === 'note' ? 'note' : 'summary',
      row.attachedTrack ? JSON.stringify(row.attachedTrack) : null,
      JSON.stringify(row.attachedTracks ?? []),
      JSON.stringify(row.attachedQuotes ?? []),
      JSON.stringify(row.checklist ?? []),
      JSON.stringify(row.annotations ?? []),
      row.layoutVariant || 'blank',
      row.revision, this.now(), id);
    this.saveRepeatRule(id, row);
    return this.bumpContextRevision();
  }

  /** 删除正文，保留最小失效凭据：来源 id + 删除时的全局 revision。 */
  deleteEntry(id) {
    const entry = this.getEntry(id);
    if (!entry) return this.contextRevision();
    this.db.prepare('DELETE FROM life_entry_completions WHERE entry_id = ?').run(id);
    this.statements.deleteEntry.run(id);
    this.statements.insertRevocation.run(id, 'entry', entry.revision, this.now());
    return this.bumpContextRevision();
  }

  /** 撤回陪伴授权：保留正文（仍是本地私有数据），只撤模型可见性。 */
  revokeEntryCompanionship(id) {
    const entry = this.getEntry(id);
    if (!entry || !entry.use_for_companionship) return this.contextRevision();
    this.statements.updateEntry.run(entry.type, entry.title, entry.content ?? null, entry.local_date, entry.end_date, entry.start_time,
      entry.end_time, entry.done, entry.yearly_repeat, 0, entry.note_uses_title, entry.companion_note,
      entry.allowed_person_ids, entry.scene_tag,
      entry.mood ?? null, entry.tags_json ?? '[]', entry.pinned ?? 0, entry.archived ?? 0,
      entry.share_scope ?? 'summary', entry.attached_track_json ?? null,
      entry.attached_tracks_json ?? '[]', entry.attached_quotes_json ?? '[]',
      entry.checklist_json ?? '[]', entry.annotations_json ?? '[]',
      entry.layout_variant ?? 'blank',
      entry.revision + 1, this.now(), id);
    this.statements.insertRevocation.run(id, 'entry-authorization', entry.revision, this.now());
    return this.bumpContextRevision();
  }

  getRevocation(sourceId, sourceType) {
    return this.statements.getRevocation.get(sourceId, sourceType) || null;
  }

  getSceneDefault(sceneTag) {
    return this.statements.getSceneDefault.get(sceneTag) || null;
  }

  listSceneDefaults() {
    return this.statements.listSceneDefaults.all();
  }

  saveSceneDefault(sceneTag, modeId, revision) {
    this.statements.upsertSceneDefault.run(sceneTag, modeId, revision, this.now());
    return this.bumpContextRevision();
  }

  deleteSceneDefault(sceneTag) {
    this.statements.deleteSceneDefault.run(sceneTag);
    return this.bumpContextRevision();
  }

  /** 返回所有未被删除的手账条目所引用的对话 turnId 集合，用于音频防淘汰。 */
  listQuotedTurnIds() {
    const turnIds = new Set();
    for (const row of this.statements.listQuotedJson.all()) {
      try {
        const list = JSON.parse(row.attached_quotes_json || '[]');
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const id = typeof item?.turnId === 'string' ? item.turnId.trim() : '';
          if (id) turnIds.add(id);
        }
      } catch {
        // 脏数据跳过，不阻断只读引用统计
      }
    }
    return turnIds;
  }
}
