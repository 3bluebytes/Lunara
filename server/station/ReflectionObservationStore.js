import { policyFromUserText } from '../memory/memoryPolicy.js';
import { openSqliteDatabase } from '../sqlite.js';
import { resolveDatabasePath } from '../runtimePaths.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const observationRow = row => ({
  id: row.id, eventKey: row.event_key, personId: row.person_id, sessionId: row.session_id,
  kind: row.kind, data: JSON.parse(row.data_json), createdAt: row.created_at,
});

// These are observations, never instructions or raw provider/exception payloads.
export function reflectionText(value, limit = 1200) {
  return String(value || '').slice(0, limit)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[link omitted]')
    .replace(/(?:api[_ -]?key|authorization|cookie|token|secret|signature)\s*[:=]\s*[^\s,;]+/gi, '[sensitive value omitted]')
    .replace(/(?:traceback|stack trace|SDK request failed|internal_tool_error)[^\n]*/gi, '[diagnostic omitted]');
}

/** Durable, bounded observation journal. It does not own dialogue or playback state. */
export class ReflectionObservationStore {
  constructor({ db = null, dbPath = resolveDatabasePath(), now = () => Date.now() } = {}) {
    this.db = db;
    this.dbPath = dbPath;
    this.ownsDb = !db;
    this.now = now;
  }

  initialize() {
    if (!this.db) {
      this.db = openSqliteDatabase(this.dbPath);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reflection_publications (
        memory_id INTEGER PRIMARY KEY, person_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reflection_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        person_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        short_done INTEGER NOT NULL DEFAULT 0,
        long_done INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_reflection_pending
        ON reflection_observations(person_id, short_done, created_at);
      CREATE TABLE IF NOT EXISTS reflection_import_receipts (
        event_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO reflection_import_receipts
        SELECT event_key, created_at FROM reflection_observations WHERE kind = 'turn';
      CREATE TABLE IF NOT EXISTS reflection_attempts (
        person_id TEXT NOT NULL,
        window TEXT NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_success_at INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        batch_json TEXT,
        PRIMARY KEY(person_id, window)
      );
      CREATE TABLE IF NOT EXISTS reflection_program_owners (
        program_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reflection_song_stats (
        person_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        song_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        song_query TEXT NOT NULL DEFAULT '',
        count INTEGER NOT NULL DEFAULT 0,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(person_id, provider, song_id, outcome)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(reflection_attempts)').all().some(row => row.name === 'batch_json')) {
      this.db.exec('ALTER TABLE reflection_attempts ADD COLUMN batch_json TEXT');
    }
    this.prune();
    return this;
  }

  close() {
    if (this.ownsDb) this.db?.close();
    this.db = null;
  }

  append({ eventKey, personId, sessionId = '', kind, data, createdAt = this.now() }) {
    if (!eventKey || !personId) return false;
    const key = String(eventKey).slice(0, 300);
    const at = Number(createdAt) || this.now();
    if (at < this.now() - RETENTION_MS) return false;
    return this.db.transaction(() => {
      // A bounded journal may evict a turn before its ledger recovery window ends.
      // Keep a tiny import receipt for that window so eviction cannot relearn it.
      if (kind === 'turn' && !this.db.prepare(`INSERT OR IGNORE INTO reflection_import_receipts VALUES (?, ?)`)
        .run(key, at).changes) return false;
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO reflection_observations
        (event_key, person_id, session_id, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(key, String(personId).slice(0, 128), String(sessionId).slice(0, 128), kind, JSON.stringify(data), at).changes === 1;
      // Statistics ride the same idempotency as the journal: a replayed event key
      // must never count twice toward the durable listening baseline.
      if (inserted && kind === 'playback' && data?.outcome && data?.songId) {
        this.db.prepare(`INSERT INTO reflection_song_stats
          (person_id, provider, song_id, outcome, song_query, count, first_seen_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(person_id, provider, song_id, outcome) DO UPDATE SET
            count = count + 1, last_seen_at = excluded.last_seen_at,
            song_query = CASE WHEN excluded.song_query != '' THEN excluded.song_query ELSE song_query END`)
          .run(String(personId).slice(0, 128), String(data.provider || '').slice(0, 32),
            String(data.songId).slice(0, 128), String(data.outcome).slice(0, 32),
            String(data.songQuery || '').slice(0, 160), at, at);
      }
      return inserted;
    })();
  }

  /** Durable per-person listening tally. Plain data for long-window reflection and schema distillation. */
  songStats(personId, { limit = 50 } = {}) {
    return this.db.prepare(`SELECT provider, song_id AS songId, song_query AS songQuery, outcome, count,
        first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt
      FROM reflection_song_stats WHERE person_id = ? ORDER BY last_seen_at DESC LIMIT ?`)
      .all(String(personId).slice(0, 128), Math.max(1, Math.min(500, Number(limit) || 50)));
  }

  /**
   * 近期播放观察（只读）：runtime 接受的 completed/skipped/partial/technical_failure，按时间倒序。
   * superseded 本来就不入账；打分只取 completed 与 skipped。
   */
  recentPlaybackObservations(personId, { since = 0, limit = 500 } = {}) {
    return this.db.prepare(`SELECT data_json, created_at FROM reflection_observations
      WHERE person_id = ? AND kind = 'playback' AND created_at >= ? ORDER BY created_at DESC LIMIT ?`)
      .all(String(personId).slice(0, 128), Number(since) || 0, Math.max(1, Math.min(2000, Number(limit) || 500)))
      .map(row => {
        let data = {};
        try { data = JSON.parse(row.data_json) || {}; } catch { data = {}; }
        return { provider: String(data.provider || ''), songId: String(data.songId || ''),
          songQuery: String(data.songQuery || ''), outcome: String(data.outcome || ''), at: Number(row.created_at) || 0 };
      });
  }

  hasConversationLedger() {
    return Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_requests'`).get());
  }

  /** 判断会话是否处于私语（roleplay）模式；缺表/缺列时按普通会话处理。 */
  isRoleplaySession(sessionId) {
    if (!this.db || !sessionId) return false;
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_sessions'").get();
    if (!table) return false;
    const hasCol = this.db.prepare('PRAGMA table_info(conversation_sessions)').all().some(row => row.name === 'interaction_mode');
    if (!hasCol) return false;
    return this.db.prepare('SELECT interaction_mode FROM conversation_sessions WHERE session_id = ?')
      .get(String(sessionId))?.interaction_mode === 'roleplay';
  }

  /** 私语会话里的观察默认标为私密，防止流向跨角色共享层。 */
  sessionPolicy(basePolicy = {}, sessionId = '') {
    return this.isRoleplaySession(sessionId)
      ? { ...basePolicy, disclosure: 'private', originScene: 'roleplay' }
      : basePolicy;
  }

  /** 将反思判定为敏感的回合（连同 paired 回复与分叉副本）在观察策略上记 sensitive。 */
  markSensitiveTurns(turnIds = []) {
    if (!this.db) return;
    const hasObs = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_observations'").get();
    if (!hasObs) return;
    const keys = new Set(turnIds.filter(Boolean).map(String));
    if (!keys.size) return;
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_requests'").get()) {
      const pair = this.db.prepare('SELECT assistant_turn_id FROM conversation_requests WHERE user_turn_id = ?');
      for (const turnId of [...keys]) {
        for (const row of pair.all(turnId)) if (row.assistant_turn_id) keys.add(row.assistant_turn_id);
      }
    }
    let allIds = [...keys];
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turn_lineage'").get()) {
      const origin = this.db.prepare('SELECT origin_turn_id FROM conversation_turn_lineage WHERE turn_id = ?');
      const copies = this.db.prepare('SELECT turn_id FROM conversation_turn_lineage WHERE origin_turn_id = ?');
      const expanded = new Set();
      for (const id of keys) {
        const root = origin.get(id)?.origin_turn_id || id;
        expanded.add(id);
        expanded.add(root);
        for (const row of copies.all(root)) expanded.add(row.turn_id);
      }
      allIds = [...expanded];
    }
    const update = this.db.prepare("UPDATE conversation_observations SET policy_json = json_set(policy_json, '$.sensitive', json('true')) WHERE turn_id = ?");
    this.db.transaction(() => {
      for (const turnId of allIds) update.run(turnId);
    })();
  }

  committedTurn(requestId) {
    if (!this.hasConversationLedger()) return null;
    const row = this.db.prepare(`SELECT r.request_id, r.session_id, r.virtual_person_id,
        r.user_turn_id, r.assistant_turn_id, r.completed_at, r.result_json,
        u.visible_text AS user_text, u.created_at AS user_created_at, a.visible_text AS assistant_text
      FROM conversation_requests r
      JOIN conversation_turns u ON u.turn_id = r.user_turn_id AND u.role = 'user' AND u.visibility = 'visible'
      JOIN conversation_turns a ON a.turn_id = r.assistant_turn_id AND a.role = 'assistant' AND a.visibility = 'visible'
      WHERE r.request_id = ? AND r.state = 'completed'
        AND u.session_id = r.session_id AND a.session_id = r.session_id
        ${this.hasSupersededColumn() ? 'AND u.superseded_at IS NULL AND a.superseded_at IS NULL' : ''}
        AND a.speaker_virtual_person_id = r.virtual_person_id`).get(requestId);
    if (!row || this.sourceRevoked(row.virtual_person_id, row.user_turn_id)) return null;
    let result = {};
    try { result = JSON.parse(row.result_json || '{}'); } catch { /* no raw payload */ }
    return {
      eventKey: `turn:${row.assistant_turn_id}`, personId: row.virtual_person_id,
      sessionId: row.session_id, kind: 'turn', createdAt: row.completed_at,
      data: {
        // 「今天只…」的期限从用户说这句话时算，不从导入反思的时间算（重启后补导入不能拉长期限）。
        policy: this.sessionPolicy(policyFromUserText(row.user_text, row.session_id, row.user_created_at || row.completed_at), row.session_id),
        requestId: row.request_id, userTurnId: row.user_turn_id, assistantTurnId: row.assistant_turn_id,
        userText: reflectionText(row.user_text), assistantText: reflectionText(row.assistant_text),
        outcomeCodes: (Array.isArray(result?.outcomeCodes) ? result.outcomeCodes : []).slice(0, 32).map(code => reflectionText(code, 80)),
      },
    };
  }

  /** 被编辑掉（superseded）的消息不再进入反思；旧账本还没有这一列时视为都未改写。 */
  hasSupersededColumn() {
    return this.db.prepare('PRAGMA table_info(conversation_turns)').all().some(row => row.name === 'superseded_at');
  }

  observationAllowed(row) {
    return !this.sourceRevoked(row.personId, row.data.userTurnId);
  }

  sourceRevoked(personId, sourceKey) {
    if (!sourceKey) return false;
    const table = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_observations'").get();
    return Boolean(table && this.db.prepare('SELECT 1 FROM conversation_observations WHERE person_id = ? AND turn_id = ? AND revoked_at IS NOT NULL').get(personId, sourceKey));
  }

  /**
   * 发布洞察给 Station 晋升。合并进旧洞察的新证据会改变 payload：此时覆盖发布记录并清掉"已处理"标记，
   * 让晋升重新读一遍（证据按原话去重，重读不会重复计数）；payload 没变（崩溃重放）则什么也不做。
   */
  publishInsight(memoryId, personId, payload) {
    const json = JSON.stringify(payload);
    const prior = this.db.prepare('SELECT payload_json FROM reflection_publications WHERE memory_id = ?').get(memoryId);
    if (prior?.payload_json === json) return;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO reflection_publications VALUES (?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET payload_json = excluded.payload_json`).run(memoryId, personId, json, this.now());
      if (prior && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'station_processed_insights'").get()) {
        this.db.prepare('DELETE FROM station_processed_insights WHERE memory_id = ?').run(memoryId);
      }
    })();
  }

  /**
   * 旁听补录：别的角色主持的回合里，观察到它的角色也把用户原话记作反思输入。
   * 给 userTurnId 时只补这一回合（每次提交都会调用，不扫全表）；不给时补近 7 天全部（sweep 与启动）。
   * 分叉复制出的回合不是新发生的事：原回合已经导入过，副本不再作为新的旁听事件补录。
   */
  recoverEncounterTurns({ userTurnId = null } = {}) {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_observations'").get()) return;
    const hasLineage = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_turn_lineage'").get();
    // CROSS JOIN 固定从近期回合出发（按 created_at 索引），观察表按 turn_id 索引逐条找观察者。
    const rows = this.db.prepare(`SELECT o.person_id, o.policy_json, t.* FROM conversation_turns t
      CROSS JOIN conversation_observations o ON o.turn_id = t.turn_id
      WHERE o.revoked_at IS NULL AND t.role = 'user' AND t.created_at >= ?
        ${userTurnId ? 'AND t.turn_id = ?' : ''}
        ${this.hasSupersededColumn() ? 'AND t.superseded_at IS NULL' : ''}
        ${hasLineage ? 'AND NOT EXISTS (SELECT 1 FROM conversation_turn_lineage l WHERE l.turn_id = t.turn_id)' : ''}
        AND NOT EXISTS (SELECT 1 FROM reflection_import_receipts r WHERE r.event_key = 'encounter:' || o.person_id || ':' || t.turn_id)
        AND NOT EXISTS (SELECT 1 FROM conversation_requests r WHERE r.user_turn_id = t.turn_id AND r.virtual_person_id = o.person_id)
      ORDER BY t.created_at LIMIT 200`).all(this.now() - RETENTION_MS, ...(userTurnId ? [String(userTurnId)] : []));
    for (const row of rows) this.append({ eventKey: `encounter:${row.person_id}:${row.turn_id}`,
      personId: row.person_id, sessionId: row.session_id, kind: 'turn', createdAt: row.created_at,
      data: { userTurnId: row.turn_id, userText: reflectionText(row.visible_text), assistantText: '',
        policy: this.sessionPolicy(JSON.parse(row.policy_json || '{}'), row.session_id), observedSilently: true } });
  }

  recoverCommittedTurns() {
    if (!this.hasConversationLedger()) return;
    this.recoverEncounterTurns();
    const rows = this.db.prepare(`SELECT request_id FROM conversation_requests r
      WHERE state = 'completed' AND completed_at >= ?
        AND NOT EXISTS (SELECT 1 FROM reflection_import_receipts o WHERE o.event_key = 'turn:' || r.assistant_turn_id)
      ORDER BY completed_at LIMIT 200`).all(this.now() - RETENTION_MS);
    for (const row of rows) {
      const observation = this.committedTurn(row.request_id);
      if (observation) this.append(observation);
    }
  }

  requestOwner(requestId) {
    if (!this.hasConversationLedger()) return null;
    const row = this.db.prepare(`SELECT virtual_person_id, session_id, request_id FROM conversation_requests WHERE request_id = ?`).get(requestId);
    return row ? { personId: row.virtual_person_id, sessionId: row.session_id, requestId: row.request_id } : null;
  }

  rememberProgram(programId, owner) {
    if (!programId || !owner?.personId) return;
    this.db.prepare(`INSERT OR IGNORE INTO reflection_program_owners VALUES (?, ?, ?, ?, ?)`)
      .run(programId, owner.personId, owner.sessionId || '', owner.requestId || '', this.now());
  }

  programOwner(programId) {
    const row = this.db.prepare(`SELECT * FROM reflection_program_owners WHERE program_id = ?`).get(programId || '');
    return row ? { personId: row.person_id, sessionId: row.session_id, requestId: row.request_id } : null;
  }

  people() {
    return this.db.prepare(`SELECT DISTINCT person_id FROM reflection_observations ORDER BY person_id`).all().map(r => r.person_id);
  }

  pending(personId, window = 'short', limit = 50) {
    const column = window === 'long' ? 'long_done' : 'short_done';
    const cutoff = this.now() - (window === 'long' ? 24 * 60 * 60 * 1000 : RETENTION_MS);
    return this.db.prepare(`SELECT * FROM reflection_observations WHERE person_id = ? AND ${column} = 0
      AND created_at >= ? ORDER BY id LIMIT ?`).all(personId, cutoff, limit).map(observationRow).filter(row => this.observationAllowed(row));
  }

  attempt(personId, window = 'short') {
    return this.db.prepare(`SELECT * FROM reflection_attempts WHERE person_id = ? AND window = ?`).get(personId, window)
      || { failures: 0, last_attempt_at: 0, last_success_at: 0, next_attempt_at: 0, status: 'idle' };
  }

  markAttempt(personId, window, { success = false, failures = 0, nextAt = 0, status = 'idle' } = {}) {
    this.db.prepare(`INSERT INTO reflection_attempts
      (person_id, window, failures, last_attempt_at, last_success_at, next_attempt_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(person_id, window) DO UPDATE SET
        failures=excluded.failures, last_attempt_at=excluded.last_attempt_at,
        last_success_at=CASE WHEN excluded.last_success_at > 0 THEN excluded.last_success_at ELSE last_success_at END,
        next_attempt_at=excluded.next_attempt_at, status=excluded.status,
        batch_json=CASE WHEN excluded.last_success_at > 0 THEN NULL ELSE batch_json END`)
      .run(personId, window, failures, this.now(), success ? this.now() : 0, nextAt, status);
  }

  saveBatch(personId, window, rows) {
    this.db.prepare(`INSERT INTO reflection_attempts (person_id, window, batch_json) VALUES (?, ?, ?)
      ON CONFLICT(person_id, window) DO UPDATE SET batch_json=excluded.batch_json`)
      .run(personId, window, JSON.stringify(rows.map(row => row.id)));
  }

  batch(personId, window, limit) {
    const state = this.attempt(personId, window);
    let ids = [];
    try { ids = JSON.parse(state.batch_json || '[]'); } catch { /* recover without corrupt metadata */ }
    if (Array.isArray(ids) && ids.length) {
      // Retry the same evidence, even across the rolling 24h selection boundary.
      const saved = this.db.prepare(`SELECT * FROM reflection_observations
        WHERE person_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(personId, ...ids).map(observationRow).filter(row => this.observationAllowed(row));
      if (saved.length === ids.length) return saved;
      this.expireBatch(personId, window, saved);
      return [];
    }
    const pending = this.pending(personId, window, 2000);
    const selected = [];
    let bytes = 0;
    for (const row of pending.slice(0, limit)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (selected.length && bytes + size > 16_000) break;
      selected.push(row);
      bytes += size;
    }
    return selected;
  }

  /** 批次里仍在、来源未撤回的观察（反思模型调用期间可能删除聊天、编辑消息或忘记来源）。 */
  liveBatchRows(personId, rows) {
    if (!rows.length) return [];
    return this.db.prepare(`SELECT * FROM reflection_observations
      WHERE person_id = ? AND id IN (${rows.map(() => '?').join(',')}) ORDER BY id`).all(personId, ...rows.map(row => row.id))
      .map(observationRow).filter(row => this.observationAllowed(row));
  }

  expireBatch(personId, window, remaining) {
    this.db.transaction(() => {
      // Partial evidence must never get a new batch identity and be learned twice.
      this.acknowledge(remaining, window);
      this.db.prepare(`UPDATE reflection_attempts SET batch_json = NULL, failures = 0,
        next_attempt_at = 0, status = 'batch_expired' WHERE person_id = ? AND window = ?`).run(personId, window);
    })();
  }

  acknowledge(rows, window) {
    const column = window === 'long' ? 'long_done' : 'short_done';
    this.db.transaction(() => {
      const stmt = this.db.prepare(`UPDATE reflection_observations SET ${column} = 1 WHERE id = ?`);
      for (const row of rows) stmt.run(row.id);
    })();
  }

  counts() {
    return Object.fromEntries(this.db.prepare(`SELECT person_id, COUNT(*) AS n FROM reflection_observations
      WHERE short_done = 0 GROUP BY person_id`).all().map(row => [row.person_id, row.n]));
  }

  prune() {
    this.db.prepare(`DELETE FROM reflection_observations WHERE created_at < ?`).run(this.now() - RETENTION_MS);
    // Pin complete retry batches against capacity eviction, but never extend the 7d TTL.
    this.db.exec(`DELETE FROM reflection_observations WHERE id IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY id DESC) AS n
        FROM reflection_observations) WHERE n > 2000)
      AND NOT EXISTS (SELECT 1 FROM reflection_attempts a,
        json_each(CASE WHEN json_valid(a.batch_json) THEN a.batch_json ELSE '[]' END) b
        WHERE b.value = reflection_observations.id)`);
    for (const state of this.db.prepare(`SELECT person_id, window FROM reflection_attempts WHERE batch_json IS NOT NULL`).all()) {
      this.batch(state.person_id, state.window, 0); // Expire incomplete batches after TTL eviction.
    }
    this.db.prepare(`DELETE FROM reflection_import_receipts WHERE created_at < ?`).run(this.now() - RETENTION_MS);
    this.db.prepare(`DELETE FROM reflection_program_owners WHERE created_at < ?`).run(this.now() - RETENTION_MS);
  }
}
