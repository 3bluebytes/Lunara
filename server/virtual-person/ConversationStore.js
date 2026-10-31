import Database from 'better-sqlite3';
import { projectWebHistory } from '../web-access/projections.js';
import { createHash, randomUUID } from 'node:crypto';
import { floorRequestPrefix, isFloorRequestId, responseRequestId } from './responsePlan.js';
import { memoryApplies, policyFromUserText } from '../memory/memoryPolicy.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from '../runtimePaths.js';
import { CompanionNoteStore } from './companionNotes.js';
import {
  RequestState,
  TurnRole,
  TurnVisibility,
  createRequestId,
  createTurnId,
} from './VirtualPersonTypes.js';

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function requireId(value, name) {
  const result = String(value || '').trim();
  if (!result) throw new TypeError(`${name} is required`);
  return result.slice(0, 128);
}

function normalizeMessage(role, message) {
  const value = message && typeof message === 'object'
    ? projectWebHistory(message)
    : { role, content: String(message || '') };
  value.role = role;
  if (role === TurnRole.TOOL) {
    value.tool_call_id = requireId(value.tool_call_id, 'tool_call_id');
    value.content = String(value.content ?? '');
    return value;
  }
  value.content = value.content == null ? '' : String(value.content);
  if (role === TurnRole.ASSISTANT && value.tool_calls != null && !Array.isArray(value.tool_calls)) {
    throw new TypeError('assistant tool_calls must be an array');
  }
  return value;
}

function visibleText(message) {
  return typeof message?.content === 'string' ? message.content.trim() : '';
}

export function presenceTurnId(triggerKey) {
  return `presence:${createHash('sha256').update(String(triggerKey)).digest('hex').slice(0, 32)}`;
}

export class ConversationStore {
  constructor({ dbPath = null, db = null, now = () => Date.now() } = {}) {
    this.dbPath = dbPath || resolveDatabasePath();
    this.db = db;
    this.ownsDb = !db;
    this.now = now;
    this._stmts = {};
  }

  initialize() {
    if (!this.db) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_sessions (
        session_id TEXT PRIMARY KEY,
        active_virtual_person_id TEXT NOT NULL,
        next_sequence INTEGER NOT NULL DEFAULT 1,
        summary_revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_turn_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        virtual_person_id TEXT NOT NULL,
        state TEXT NOT NULL,
        user_turn_id TEXT NOT NULL,
        assistant_turn_id TEXT,
        result_json TEXT,
        error_id TEXT,
        presentation_state TEXT NOT NULL DEFAULT 'pending',
        presentation_claimed_at INTEGER,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY(session_id) REFERENCES conversation_sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        request_id TEXT,
        role TEXT NOT NULL,
        speaker_virtual_person_id TEXT,
        visibility TEXT NOT NULL,
        message_json TEXT NOT NULL,
        visible_text TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, sequence),
        FOREIGN KEY(session_id) REFERENCES conversation_sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        summary_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        from_sequence INTEGER NOT NULL,
        to_sequence INTEGER NOT NULL,
        content TEXT NOT NULL,
        method TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_sequence
        ON conversation_turns(session_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_request
        ON conversation_turns(request_id);
      CREATE INDEX IF NOT EXISTS idx_conversation_requests_session_state
        ON conversation_requests(session_id, state);
    `);
    const requestColumns = new Set(this.db.prepare(`PRAGMA table_info(conversation_requests)`).all().map(row => row.name));
    if (!requestColumns.has('presentation_state')) {
      this.db.exec(`ALTER TABLE conversation_requests ADD COLUMN presentation_state TEXT NOT NULL DEFAULT 'pending'`);
    }
    if (!requestColumns.has('presentation_claimed_at')) {
      this.db.exec(`ALTER TABLE conversation_requests ADD COLUMN presentation_claimed_at INTEGER`);
    }
    // The previous schema used "claimed" as a terminal at-most-once marker.
    // Preserve that behavior across migration rather than replaying old speech.
    this.db.prepare(`UPDATE conversation_requests SET presentation_state = 'delivered' WHERE presentation_state = 'claimed'`).run();
    this._migrateRooms();
    // 心里话（add-companion-heartbeat D3）：纯新增表，读时按本账本的回合可读性过滤来源。
    this.notes = new CompanionNoteStore({ db: this.db, now: this.now,
      canReadTurn: (personId, turn, options) => this.canReadTurn(personId, turn, options),
      getTurn: turnId => this.getTurn(turnId), getSession: sessionId => this.getSession(sessionId) }).initialize();
    this._prepare();
    this.recoverIncomplete();
    return this;
  }

  _migrateRooms() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(conversation_sessions)').all().map(row => row.name));
    const migration = this.db.transaction(() => {
      for (const [name, definition] of Object.entries({
        title: "TEXT NOT NULL DEFAULT ''", archived_at: 'INTEGER', membership_revision: 'INTEGER NOT NULL DEFAULT 0',
        pinned_at: 'INTEGER', unread_at: 'INTEGER',
      })) {
        if (!columns.has(name)) this.db.exec(`ALTER TABLE conversation_sessions ADD COLUMN ${name} ${definition}`);
      }
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_members (
          session_id TEXT NOT NULL, person_id TEXT NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER,
          PRIMARY KEY(session_id, person_id)
        );
        CREATE TABLE IF NOT EXISTS conversation_rounds (
          round_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_turn_id TEXT NOT NULL,
          plan_json TEXT NOT NULL, members_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'running',
          result_json TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS conversation_observations (
          person_id TEXT NOT NULL, turn_id TEXT NOT NULL, revoked_at INTEGER, policy_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY(person_id, turn_id)
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_round_session ON conversation_rounds(session_id, created_at);
      `);
      if (!this.db.prepare('PRAGMA table_info(conversation_observations)').all().some(row => row.name === 'policy_json')) {
        this.db.exec("ALTER TABLE conversation_observations ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (!this.db.prepare('PRAGMA table_info(conversation_summaries)').all().some(row => row.name === 'person_id')) {
        this.db.exec('ALTER TABLE conversation_summaries ADD COLUMN person_id TEXT');
      }
      // 改写（add-chat-edit-and-fork）：被改写的 turn 只打标记，账本行保留作审计与回滚依据。
      if (!this.db.prepare('PRAGMA table_info(conversation_turns)').all().some(row => row.name === 'superseded_at')) {
        this.db.exec('ALTER TABLE conversation_turns ADD COLUMN superseded_at INTEGER');
      }
      // Run the legacy attribution once. Joining a room later never imports its old private history.
      if (!columns.has('membership_revision')) {
        this.db.exec(`
          INSERT OR IGNORE INTO conversation_members(session_id, person_id, joined_at)
            SELECT session_id, active_virtual_person_id, created_at FROM conversation_sessions;
          INSERT OR IGNORE INTO conversation_observations(person_id, turn_id)
            SELECT r.virtual_person_id, t.turn_id FROM conversation_turns t
            JOIN conversation_requests r ON t.request_id = r.request_id
            WHERE t.visibility = 'visible';
        `);
      }
    });
    migration();
  }

  _prepare() {
    this._stmts.session = this.db.prepare(`SELECT * FROM conversation_sessions WHERE session_id = ?`);
    this._stmts.insertSession = this.db.prepare(`
      INSERT INTO conversation_sessions
        (session_id, active_virtual_person_id, next_sequence, summary_revision, created_at, last_turn_at)
      VALUES (?, ?, 1, 0, ?, ?)
    `);
    this._stmts.updateActive = this.db.prepare(`
      UPDATE conversation_sessions SET active_virtual_person_id = ?, last_turn_at = ? WHERE session_id = ?
    `);
    this._stmts.bumpSequence = this.db.prepare(`
      UPDATE conversation_sessions SET next_sequence = next_sequence + 1, last_turn_at = ? WHERE session_id = ?
    `);
    this._stmts.insertTurn = this.db.prepare(`
      INSERT INTO conversation_turns
        (turn_id, session_id, sequence, request_id, role, speaker_virtual_person_id,
         visibility, message_json, visible_text, created_at)
      VALUES (@turnId, @sessionId, @sequence, @requestId, @role, @speakerVirtualPersonId,
              @visibility, @messageJson, @visibleText, @createdAt)
    `);
    this._stmts.request = this.db.prepare(`SELECT * FROM conversation_requests WHERE request_id = ?`);
    this._stmts.insertRequest = this.db.prepare(`
      INSERT INTO conversation_requests
        (request_id, session_id, virtual_person_id, state, user_turn_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this._stmts.completeRequest = this.db.prepare(`
      UPDATE conversation_requests
      SET state = ?, assistant_turn_id = ?, result_json = ?, error_id = ?, completed_at = ?
      WHERE request_id = ? AND state = ?
    `);
  }

  close() {
    if (this.ownsDb) this.db?.close();
    this.db = null;
    this._stmts = {};
  }

  ensureSession(sessionId, virtualPersonId) {
    const sid = requireId(sessionId, 'sessionId');
    const pid = requireId(virtualPersonId, 'virtualPersonId');
    let row = this._stmts.session.get(sid);
    if (!row) {
      const now = this.now();
      this._stmts.insertSession.run(sid, pid, now, now);
      this.db.prepare('INSERT OR IGNORE INTO conversation_members(session_id, person_id, joined_at) VALUES (?, ?, ?)')
        .run(sid, pid, now);
      row = this._stmts.session.get(sid);
    }
    return this._mapSession(row);
  }

  setActiveVirtualPerson(sessionId, virtualPersonId) {
    const room = this.ensureSession(sessionId, virtualPersonId);
    // Legacy single-person activation replaces that room's partner only. A group changes its host.
    if (room.memberIds.length <= 1) {
      this.db.prepare('UPDATE conversation_members SET left_at = ? WHERE session_id = ? AND person_id <> ? AND left_at IS NULL')
        .run(this.now(), sessionId, virtualPersonId);
    }
    this.addMember(sessionId, virtualPersonId);
    this._stmts.updateActive.run(requireId(virtualPersonId, 'virtualPersonId'), this.now(), requireId(sessionId, 'sessionId'));
    return this.getSession(sessionId);
  }

  resetActiveVirtualPerson(fromVirtualPersonId, toVirtualPersonId) {
    const from = requireId(fromVirtualPersonId, 'fromVirtualPersonId');
    const to = requireId(toVirtualPersonId, 'toVirtualPersonId');
    const rooms = this.db.prepare('SELECT session_id FROM conversation_members WHERE person_id = ? AND left_at IS NULL').all(from);
    for (const row of rooms) this.removeMember(row.session_id, from, to);
    return rooms.length;
  }

  createRoom({ sessionId = `conversation:${randomUUID()}`, title = '', memberIds = ['lunara'], hostId = memberIds[0] } = {}) {
    const ids = [...new Set(memberIds.map(id => requireId(id, 'memberId')))];
    if (!ids.length || ids.length > 8 || !ids.includes(hostId)) throw new TypeError('room requires 1-8 members including its host');
    if (this.getSession(sessionId)) throw new Error('conversation already exists');
    return this.db.transaction(() => {
      this.ensureSession(sessionId, hostId);
      for (const id of ids) this.addMember(sessionId, id);
      return this.updateRoom(sessionId, { title });
    })();
  }

  listRooms({ includeArchived = false } = {}) {
    return this.db.prepare(`SELECT * FROM conversation_sessions ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, last_turn_at DESC, session_id`)
      .all().map(row => this._mapSession(row));
  }

  updateRoom(sessionId, { title, archived, pinned, unread } = {}) {
    if (!this.getSession(sessionId)) throw new Error('conversation not found');
    if (title !== undefined) this.db.prepare('UPDATE conversation_sessions SET title = ? WHERE session_id = ?')
      .run(String(title).trim().slice(0, 80), sessionId);
    if (archived !== undefined) this.db.prepare('UPDATE conversation_sessions SET archived_at = ? WHERE session_id = ?')
      .run(archived ? this.now() : null, sessionId);
    // 置顶/未读是纯列表标记：只动时间戳，不触碰成员、轮次或播放状态。
    if (pinned !== undefined) this.db.prepare('UPDATE conversation_sessions SET pinned_at = ? WHERE session_id = ?')
      .run(pinned ? this.now() : null, sessionId);
    if (unread !== undefined) this.db.prepare('UPDATE conversation_sessions SET unread_at = ? WHERE session_id = ?')
      .run(unread ? this.now() : null, sessionId);
    return this.getSession(sessionId);
  }

  /** 硬删除：会话及其全部从属记录在一个事务内清理，观察记录按 turn_id 反查。 */
  deleteRoom(sessionId) {
    if (!this.getSession(sessionId)) throw new Error('conversation not found');
    return this.db.transaction(() => {
      const turnIds = this.db.prepare('SELECT turn_id FROM conversation_turns WHERE session_id = ?')
        .all(sessionId).map(row => row.turn_id);
      const deleteObservation = this.db.prepare('DELETE FROM conversation_observations WHERE turn_id = ?');
      for (const turnId of turnIds) deleteObservation.run(turnId);
      this.db.prepare('DELETE FROM conversation_turns WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_requests WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_rounds WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_summaries WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_members WHERE session_id = ?').run(sessionId);
      this.notes.deleteSession(sessionId);
      this.db.prepare('DELETE FROM conversation_sessions WHERE session_id = ?').run(sessionId);
      return true;
    })();
  }

  addMember(sessionId, personId) {
    const room = this.getSession(sessionId);
    if (!room || room.archivedAt) throw new Error('conversation not available');
    if (room.memberIds.includes(personId)) return room;
    if (room.memberIds.length >= 8) throw new Error('a conversation supports up to 8 virtual persons');
    this.db.prepare(`INSERT INTO conversation_members(session_id, person_id, joined_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id, person_id) DO UPDATE SET
        joined_at = MAX(excluded.joined_at, COALESCE(conversation_members.left_at, conversation_members.joined_at) + 1), left_at = NULL`)
      .run(sessionId, requireId(personId, 'personId'), this.now());
    this.db.prepare('UPDATE conversation_sessions SET membership_revision = membership_revision + 1 WHERE session_id = ?').run(sessionId);
    return this.getSession(sessionId);
  }

  removeMember(sessionId, personId, fallbackId = 'lunara') {
    const room = this.getSession(sessionId);
    if (!room) throw new Error('conversation not found');
    if (!room.memberIds.includes(personId)) return room;
    this.db.transaction(() => {
      this.db.prepare('UPDATE conversation_members SET left_at = ? WHERE session_id = ? AND person_id = ? AND left_at IS NULL')
        .run(this.now(), sessionId, personId);
      const remaining = room.memberIds.filter(id => id !== personId);
      const host = remaining.includes(room.activeVirtualPersonId) ? room.activeVirtualPersonId : remaining[0] || fallbackId;
      if (!remaining.length) {
        this.db.prepare(`INSERT INTO conversation_members(session_id, person_id, joined_at) VALUES (?, ?, ?)
          ON CONFLICT(session_id, person_id) DO UPDATE SET
            joined_at = MAX(excluded.joined_at, COALESCE(conversation_members.left_at, conversation_members.joined_at) + 1), left_at = NULL`).run(sessionId, host, this.now());
      }
      this.db.prepare('UPDATE conversation_sessions SET active_virtual_person_id = ?, membership_revision = membership_revision + 1 WHERE session_id = ?')
        .run(host, sessionId);
    })();
    return this.getSession(sessionId);
  }

  membershipToken(sessionId, personId) {
    return this.db.prepare(`SELECT joined_at FROM conversation_members
      WHERE session_id = ? AND person_id = ? AND left_at IS NULL`).get(sessionId, personId)?.joined_at ?? null;
  }

  beginRound({ sessionId, roundId, userText, responsePlan }) {
    const existing = this.getRound(roundId);
    if (existing) {
      if (existing.sessionId !== sessionId) throw new Error('request id belongs to a different session');
      return existing;
    }
    const room = this.getSession(sessionId);
    if (!room || room.archivedAt) throw new Error('conversation not available');
    const content = String(userText || '').trim();
    if (!content) throw new TypeError('userText must not be empty');
    return this.db.transaction(() => {
      const turn = this._appendTurnRaw({ sessionId, role: 'user', message: { content }, visibility: 'visible' });
      this.db.prepare(`INSERT INTO conversation_rounds(round_id, session_id, user_turn_id, plan_json, members_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(roundId, sessionId, turn.turnId, JSON.stringify(responsePlan), JSON.stringify(room.memberIds), this.now());
      this.observeTurns(room.memberIds, [turn.turnId], policyFromUserText(content, sessionId, this.now()));
      return this.getRound(roundId);
    })();
  }

  getRound(roundId) {
    const row = this.db.prepare('SELECT * FROM conversation_rounds WHERE round_id = ?').get(String(roundId));
    return row ? { roundId: row.round_id, sessionId: row.session_id, userTurnId: row.user_turn_id,
      responsePlan: parseJson(row.plan_json, []), memberIds: parseJson(row.members_json, []),
      state: row.state, result: parseJson(row.result_json, null) } : null;
  }

  completeRound(roundId, result, state = 'completed') {
    this.db.prepare(`UPDATE conversation_rounds SET state = ?, result_json = ?, completed_at = ? WHERE round_id = ? AND state = 'running'`)
      .run(state, JSON.stringify(result), this.now(), roundId);
    return this.getRound(roundId);
  }

  observeTurns(personIds, turnIds, policy = {}) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO conversation_observations(person_id, turn_id, policy_json) VALUES (?, ?, ?)');
    for (const personId of personIds) for (const turnId of turnIds) if (turnId) insert.run(personId, turnId, JSON.stringify(policy));
  }

  /** 聊天账本的头序号：任何一行入账都会推进。ambient turn 用它判断模型调用期间聊天是否前进；不存在为 null。 */
  headSequence(sessionId) {
    return this.db.prepare('SELECT next_sequence FROM conversation_sessions WHERE session_id = ?')
      .get(String(sessionId || ''))?.next_sequence ?? null;
  }

  /** 最近一条已提交的用户 turn 时间；没有则 null。presence 只用它做「用户在场」门控。 */
  lastUserTurnAt(sessionId) {
    const row = this.db.prepare("SELECT MAX(created_at) AS at FROM conversation_turns WHERE session_id = ? AND role = 'user'")
      .get(String(sessionId || ''));
    return row?.at ?? null;
  }

  /**
   * 主动开口（presence_line）入账：确定性 turnId 幂等写入一条可见 assistant turn。
   * 不写 user turn、不开 request/round、不登记 observation（不形成喜恶或关系观察）；
   * message.presence 只是调度元数据，模型投影时剥掉。
   */
  // extra：随这句话一起入账的展示元数据（如 ambient 推荐 musicRecommendation），不进模型历史正文。
  recordPresenceTurn({ sessionId, personId, triggerKey, kind, text, sourceRefs = [], extra = null }) {
    const content = String(text || '').trim();
    if (!content || !String(triggerKey || '').trim()) return null;
    const turnId = presenceTurnId(triggerKey);
    if (this.db.prepare('SELECT 1 FROM conversation_turns WHERE turn_id = ?').get(turnId)) return null;
    const room = this.getSession(sessionId);
    if (!room || !room.memberIds?.includes(personId)) return null;
    return this.db.transaction(() => this._appendTurnRaw({ turnId, sessionId, role: 'assistant',
      speakerVirtualPersonId: personId, visibility: 'visible',
      message: { content, presentation: 'presence',
        presence: { kind: String(kind || ''), triggerKey: String(triggerKey), sourceRefs: [...sourceRefs].map(String) },
        ...(extra && typeof extra === 'object' ? extra : {}) } }))();
  }

  /** 她在这个聊天里最近说过的可见话（任何呈现形态），供 presence 防复读。 */
  recentSpokenLines(sessionId, personId, { limit = 3 } = {}) {
    return this.db.prepare(`SELECT visible_text FROM conversation_turns WHERE session_id = ? AND role = 'assistant'
      AND speaker_virtual_person_id = ? AND visibility = 'visible' AND visible_text <> ''
      ORDER BY sequence DESC LIMIT ?`).all(String(sessionId || ''), String(personId || ''), Math.max(1, Math.min(10, limit)))
      .map(row => row.visible_text).reverse();
  }

  recordTrackIntro({ sessionId, personId, correlationId, queueItemId = null, text, track }) {
    const contentIdentity = queueItemId || correlationId;
    const turnId = requireId(`intro:${contentIdentity}`, 'turnId');
    const existing = this.db.prepare('SELECT * FROM conversation_turns WHERE turn_id = ?').get(turnId);
    if (existing) return null;
    const room = this.getSession(sessionId);
    if (!room) return null;
    return this.db.transaction(() => {
      const turn = this._appendTurnRaw({ turnId, sessionId, role: 'assistant', speakerVirtualPersonId: personId,
        visibility: 'visible', message: { content: text, presentation: 'track_intro', queueItemId,
          tracks: [{ queueItemId, songId: track.songId, title: track.title, artist: track.artist, source: track.source,
            pic_url: track.artwork, q: `${track.artist} — ${track.title}` }] } });
      this.observeTurns(room.memberIds, [turn.turnId]);
      return turn;
    })();
  }

  recentEncounters(personId, { limit = 12, excludeSessionId = null } = {}) {
    return this.db.prepare(`SELECT t.*, o.policy_json FROM conversation_observations o JOIN conversation_turns t ON t.turn_id = o.turn_id
      WHERE o.person_id = ? AND o.revoked_at IS NULL AND t.superseded_at IS NULL AND (? IS NULL OR t.session_id <> ?)
      ORDER BY t.created_at DESC, t.sequence DESC LIMIT ?`).all(personId, excludeSessionId, excludeSessionId, Math.min(30, Math.max(1, limit)))
      .reverse().map(row => ({ ...this._mapTurn(row), policy: parseJson(row.policy_json, {}) }));
  }

  revokeObservation(personId, turnId) {
    return this.db.transaction(() => {
      const result = this.db.prepare(`UPDATE conversation_observations SET revoked_at = ? WHERE person_id = ?
        AND (turn_id = ? OR turn_id IN (SELECT assistant_turn_id FROM conversation_requests WHERE user_turn_id = ?))`)
        .run(this.now(), personId, turnId, turnId);
      const source = this.db.prepare('SELECT session_id, sequence FROM conversation_turns WHERE turn_id = ?').get(turnId);
      if (source) this.db.prepare('DELETE FROM conversation_summaries WHERE session_id = ? AND to_sequence >= ?')
        .run(source.session_id, source.sequence);
      // 被忘记的来源不能经由心里话被重新提起。
      const replies = this.db.prepare('SELECT assistant_turn_id FROM conversation_requests WHERE user_turn_id = ?')
        .all(turnId).map(row => row.assistant_turn_id);
      this.notes.dropBySourceTurns([turnId, ...replies], { personId });
      return result.changes > 0;
    })();
  }

  isTurnRevoked(personId, turn) {
    const request = turn.requestId ? this.getRequest(turn.requestId) : null;
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_observations WHERE person_id = ? AND revoked_at IS NOT NULL
      AND turn_id IN (?, ?)`).get(personId, turn.turnId, request?.userTurnId || ''));
  }

  canReadTurn(personId, turn, options = {}) {
    if (this.isTurnRevoked(personId, turn)) return false;
    if (turn.visibility !== 'visible') return turn.speakerVirtualPersonId === personId;
    const observation = this.db.prepare('SELECT policy_json, revoked_at FROM conversation_observations WHERE person_id = ? AND turn_id = ?').get(personId, turn.turnId);
    const request = turn.requestId ? this.getRequest(turn.requestId) : null;
    const source = request && this.db.prepare('SELECT visible_text, created_at FROM conversation_turns WHERE turn_id = ?').get(request.userTurnId);
    const policy = observation ? parseJson(observation.policy_json, {})
      // 主动开口不是用户原话：不能拿它反推披露策略，按无标记的公开聊天处理。
      : policyFromUserText(turn.message?.presentation === 'presence' ? '' : (source?.visible_text || turn.visibleText),
        turn.sessionId, source?.created_at || turn.createdAt);
    // Joining permits bounded public room history for context, not private excerpts or retroactive personal observations.
    return observation?.revoked_at == null && memoryApplies({ policy }, {
      sessionId: turn.sessionId, ...options, isGroup: options.isGroup || !observation,
    });
  }

  saveSummary({ sessionId, personId = null, fromSequence, toSequence, content, method = 'deterministic-fallback' } = {}) {
    const sid = requireId(sessionId, 'sessionId');
    const from = Math.max(1, Number(fromSequence) || 1);
    const to = Math.max(from, Number(toSequence) || from);
    const summary = String(content || '').trim();
    if (!summary) throw new TypeError('summary content is required');
    const existing = this.db.prepare(`
      SELECT * FROM conversation_summaries
      WHERE session_id = ? AND from_sequence = ? AND to_sequence = ? AND content = ? AND person_id IS ?
      ORDER BY revision DESC LIMIT 1
    `).get(sid, from, to, summary, personId);
    if (existing) return this._mapSummary(existing);
    const transaction = this.db.transaction(() => {
      const session = this._stmts.session.get(sid);
      if (!session) throw new Error(`session not found: ${sid}`);
      const revision = session.summary_revision + 1;
      this.db.prepare(`
        INSERT INTO conversation_summaries
          (session_id, revision, from_sequence, to_sequence, content, method, created_at, person_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sid, revision, from, to, summary.slice(0, 8000), String(method || 'deterministic-fallback').slice(0, 80), this.now(), personId);
      this.db.prepare(`UPDATE conversation_sessions SET summary_revision = ? WHERE session_id = ?`).run(revision, sid);
      return this.db.prepare(`SELECT * FROM conversation_summaries WHERE session_id = ? AND revision = ?`).get(sid, revision);
    });
    return this._mapSummary(transaction());
  }

  listSummaries(sessionId, { limit = 20, personId = null, isGroup = false } = {}) {
    const sid = requireId(sessionId, 'sessionId');
    const max = Math.max(1, Math.min(Number(limit) || 20, 100));
    return this.db.prepare(`
      SELECT * FROM conversation_summaries WHERE session_id = ? ORDER BY revision DESC LIMIT ?
    `).all(sid, personId ? 100 : max).reverse().filter(row => {
      if (!personId) return true;
      if (row.person_id && row.person_id !== personId) return false;
      // A private excerpt or a revoked observation must not re-enter via an older summary.
      return this.db.prepare(`SELECT * FROM conversation_turns WHERE session_id = ? AND visibility = 'visible'
        AND sequence BETWEEN ? AND ?`).all(sid, row.from_sequence, row.to_sequence)
        .every(turn => this.canReadTurn(personId, this._mapTurn(turn), { isGroup }));
    }).slice(-max).map(row => this._mapSummary(row));
  }

  getSession(sessionId) {
    const row = this._stmts.session.get(requireId(sessionId, 'sessionId'));
    return row ? this._mapSession(row) : null;
  }

  beginRequest({ sessionId, requestId = createRequestId(), virtualPersonId, userText, userTurnId = null } = {}) {
    const sid = requireId(sessionId, 'sessionId');
    const rid = requireId(requestId, 'requestId');
    const pid = requireId(virtualPersonId, 'virtualPersonId');
    const text = String(userText || '').trim();
    if (!text) throw new TypeError('userText must not be empty');

    const existing = this._stmts.request.get(rid);
    if (existing) {
      if (existing.session_id !== sid || existing.virtual_person_id !== pid) throw new Error('request identity mismatch');
      return { replayed: true, request: this._mapRequest(existing), result: parseJson(existing.result_json, null) };
    }

    const transaction = this.db.transaction(() => {
      this.ensureSession(sid, pid);
      const prior = userTurnId ? this.db.prepare("SELECT * FROM conversation_turns WHERE turn_id = ? AND session_id = ? AND role = 'user'").get(userTurnId, sid) : null;
      if (userTurnId && !prior) throw new Error('round user turn not found');
      const turn = prior ? this._mapTurn(prior) : this._appendTurnRaw({
        sessionId: sid,
        requestId: rid,
        role: TurnRole.USER,
        message: { role: TurnRole.USER, content: text },
        visibility: TurnVisibility.VISIBLE,
      });
      const now = this.now();
      this._stmts.insertRequest.run(rid, sid, pid, RequestState.RUNNING, turn.turnId, now);
      if (!prior) this.observeTurns([pid], [turn.turnId], policyFromUserText(text, sid, now));
      return turn;
    });
    const turn = transaction();
    return { replayed: false, request: this._mapRequest(this._stmts.request.get(rid)), turn };
  }

  appendMessage({ sessionId, requestId, role, message, speakerVirtualPersonId = null, visibility = TurnVisibility.INTERNAL } = {}) {
    const request = this._stmts.request.get(requireId(requestId, 'requestId'));
    if (!request || request.state !== RequestState.RUNNING) {
      throw new Error('cannot append message to a non-running request');
    }
    if (request.session_id !== String(sessionId)) throw new Error('request/session mismatch');
    return this._appendTurnRaw({ sessionId, requestId, role, message, speakerVirtualPersonId, visibility });
  }

  completeRequest({ requestId, message, virtualPersonId, result = null, state = RequestState.COMPLETED, errorId = null } = {}) {
    const rid = requireId(requestId, 'requestId');
    const request = this._stmts.request.get(rid);
    if (!request) throw new Error(`request not found: ${rid}`);
    if (request.state !== RequestState.RUNNING) {
      return { replayed: true, request: this._mapRequest(request), result: parseJson(request.result_json, null) };
    }
    if (![RequestState.COMPLETED, RequestState.FAILED].includes(state)) {
      throw new TypeError('completion state must be completed or failed');
    }
    const transaction = this.db.transaction(() => {
      const turn = this._appendTurnRaw({
        sessionId: request.session_id,
        requestId: rid,
        role: TurnRole.ASSISTANT,
        message,
        speakerVirtualPersonId: virtualPersonId || request.virtual_person_id,
        visibility: TurnVisibility.VISIBLE,
      });
      const storedResult = result && typeof result === 'object' ? { ...result, sourceTurnId: turn.turnId } : result;
      const updated = this._stmts.completeRequest.run(
        state,
        turn.turnId,
        storedResult == null ? null : JSON.stringify(storedResult),
        errorId ? String(errorId) : null,
        this.now(),
        rid,
        RequestState.RUNNING,
      );
      if (updated.changes !== 1) throw new Error('request completion race');
      const source = this.db.prepare('SELECT visible_text FROM conversation_turns WHERE turn_id = ?').get(request.user_turn_id);
      this.observeTurns([request.virtual_person_id], [turn.turnId], policyFromUserText(source?.visible_text, request.session_id, this.now()));
      return { turn, result: storedResult };
    });
    const completed = transaction();
    return { replayed: false, request: this._mapRequest(this._stmts.request.get(rid)), ...completed };
  }

  /**
   * 结束一个不该留下可见 turn 的请求（群聊被邀请者失败/取消）：只改状态，不写 assistant turn。
   * aborted 请求的内部工具轮不会再进入 listTurns，避免半截工具调用污染后续上下文。
   */
  abortRequest(requestId) {
    const rid = requireId(requestId, 'requestId');
    return this.db.prepare(`UPDATE conversation_requests SET state = ?, completed_at = ? WHERE request_id = ? AND state = ?`)
      .run(RequestState.ABORTED, this.now(), rid, RequestState.RUNNING).changes === 1;
  }

  recoverIncomplete({ safeText = '上一轮对话意外中断了。' } = {}) {
    const rows = this.db.prepare(`SELECT * FROM conversation_requests WHERE state = ? ORDER BY created_at`).all(RequestState.RUNNING);
    for (const row of rows) {
      // 追加的被邀请回应不复活、不补安全失败句：只结束请求，所在回合按 partial 收束。
      if (isFloorRequestId(row.request_id)) {
        this.abortRequest(row.request_id);
        continue;
      }
      this.completeRequest({
        requestId: row.request_id,
        virtualPersonId: row.virtual_person_id,
        message: { role: TurnRole.ASSISTANT, content: safeText },
        result: { ok: false, code: 'RECOVERED_INCOMPLETE_TURN', displayText: safeText },
        state: RequestState.FAILED,
      });
    }
    for (const row of this.db.prepare("SELECT round_id FROM conversation_rounds WHERE state = 'running'").all()) {
      const round = this.getRound(row.round_id);
      const responses = round.responsePlan.map((id, index) => this.getRequest(responseRequestId(round.roundId, id, index)))
        .concat(this.db.prepare(`SELECT request_id FROM conversation_requests WHERE substr(request_id, 1, ?) = ? AND state = ?`)
          .all(floorRequestPrefix(round.roundId).length, floorRequestPrefix(round.roundId), RequestState.COMPLETED)
          .map(row => this.getRequest(row.request_id)))
        .filter(Boolean).map(request => request.result);
      const result = { ...(responses[0] || {}), requestId: round.roundId, sessionId: round.sessionId,
        ok: false, partial: true, cancelled: true, code: 'RECOVERED_INCOMPLETE_TURN', responses,
        displayText: safeText };
      this.completeRound(round.roundId, result, 'interrupted');
    }
    return rows.length;
  }

  listTurns(sessionId, { limit = 50, beforeSequence = null, includeRequestId = null, visibleOnly = false } = {}) {
    const sid = requireId(sessionId, 'sessionId');
    const max = Math.max(1, Math.min(Number(limit) || 50, 500));
    const visibilityClause = visibleOnly ? `AND t.visibility = '${TurnVisibility.VISIBLE}'` : '';
    const rows = this.db.prepare(`
      SELECT t.*
      FROM conversation_turns t
      LEFT JOIN conversation_requests r ON r.request_id = t.request_id
      WHERE t.session_id = ?
        AND t.sequence < ?
        AND t.superseded_at IS NULL
        AND (t.request_id IS NULL OR r.state IN (?, ?) OR t.request_id = ?)
        ${visibilityClause}
      ORDER BY t.sequence DESC
      LIMIT ?
    `).all(sid, Number(beforeSequence) || Number.MAX_SAFE_INTEGER, RequestState.COMPLETED, RequestState.FAILED, includeRequestId || '', max);
    return rows.reverse().map(row => this._mapTurn(row));
  }

  /** 可作为改写/分叉起点的用户 turn：同一聊天、可见、未被改写。 */
  _branchPoint(sessionId, turnId) {
    const sid = requireId(sessionId, 'sessionId');
    const row = this.db.prepare(`SELECT * FROM conversation_turns WHERE turn_id = ? AND session_id = ?
      AND visibility = 'visible' AND superseded_at IS NULL`).get(String(turnId || ''), sid);
    if (!row) throw new Error('message not found');
    if (row.role !== TurnRole.USER) throw new TypeError('only a user message can be edited or forked');
    return this._mapTurn(row);
  }

  /**
   * 编辑发送前的软回退：目标用户 turn 及其后全部 turn 记 superseded_at，不再进入转录与模型上下文。
   * 覆盖它们的摘要删除、以它们为来源的心里话作废；请求、观察与 round 行保留。不碰播放与显式记忆。
   */
  rewindFromTurn(sessionId, turnId) {
    const target = this._branchPoint(sessionId, turnId);
    return this.db.transaction(() => {
      const ids = this.db.prepare(`SELECT turn_id FROM conversation_turns WHERE session_id = ? AND sequence >= ?
        AND superseded_at IS NULL`).all(target.sessionId, target.sequence).map(row => row.turn_id);
      this.db.prepare(`UPDATE conversation_turns SET superseded_at = ? WHERE session_id = ? AND sequence >= ?
        AND superseded_at IS NULL`).run(this.now(), target.sessionId, target.sequence);
      this.db.prepare('DELETE FROM conversation_summaries WHERE session_id = ? AND to_sequence >= ?')
        .run(target.sessionId, target.sequence);
      const people = this.db.prepare('SELECT DISTINCT person_id FROM conversation_members WHERE session_id = ?')
        .all(target.sessionId).map(row => row.person_id);
      for (const personId of people) this.notes.dropBySourceTurns(ids, { personId });
      return { turnId: target.turnId, text: target.visibleText, supersededCount: ids.length };
    })();
  }

  /**
   * 从一条用户消息分叉：同成员、同主持的新聊天，复制这条之前的可见 user/assistant turn。
   * 副本不挂 request，只留正文与展示元数据；观察记录（含策略与撤销）按原样复制，私密与限定范围不因分叉放宽。
   */
  forkFromTurn(sessionId, turnId) {
    const target = this._branchPoint(sessionId, turnId);
    const source = this.getSession(target.sessionId);
    const history = this.listTurns(target.sessionId, { limit: 500, beforeSequence: target.sequence, visibleOnly: true })
      .filter(turn => turn.role === TurnRole.USER || turn.role === TurnRole.ASSISTANT);
    const title = source.title ? `${source.title.slice(0, 76)}（分叉）` : '分叉的聊天';
    return this.db.transaction(() => {
      const room = this.createRoom({ title, memberIds: source.memberIds, hostId: source.activeVirtualPersonId });
      const observations = this.db.prepare('SELECT person_id, policy_json, revoked_at FROM conversation_observations WHERE turn_id = ?');
      const observe = this.db.prepare(`INSERT OR IGNORE INTO conversation_observations(person_id, turn_id, policy_json, revoked_at)
        VALUES (?, ?, ?, ?)`);
      for (const turn of history) {
        const { content, presentation, tracks, groupFloor, webSources, queueItemId } = turn.message;
        const copy = this._appendTurnRaw({ sessionId: room.sessionId, role: turn.role, visibility: TurnVisibility.VISIBLE,
          speakerVirtualPersonId: turn.speakerVirtualPersonId,
          message: { content, ...(presentation ? { presentation } : {}), ...(tracks ? { tracks } : {}),
            ...(groupFloor ? { groupFloor } : {}), ...(webSources ? { webSources } : {}), ...(queueItemId ? { queueItemId } : {}) } });
        // 用户 turn 的撤销登记在原 turn 上，它的回应只经 request 关联；副本没有 request，所以撤销状态并到回应上。
        const request = turn.requestId ? this.getRequest(turn.requestId) : null;
        const revokedVia = request && request.userTurnId !== turn.turnId
          ? new Map(observations.all(request.userTurnId).filter(row => row.revoked_at != null).map(row => [row.person_id, row.revoked_at]))
          : new Map();
        for (const row of observations.all(turn.turnId)) {
          observe.run(row.person_id, copy.turnId, row.policy_json, row.revoked_at ?? revokedVia.get(row.person_id) ?? null);
        }
      }
      return { room: this.getSession(room.sessionId), text: target.visibleText };
    })();
  }

  listModelMessages(sessionId, options = {}) {
    return this.listTurns(sessionId, options).map(turn => structuredClone(turn.message));
  }

  /** 按 id 读一条 turn；不存在为 null。可读性由调用方用 canReadTurn 判定。 */
  getTurn(turnId) {
    const id = String(turnId || '').trim();
    if (!id) return null;
    const row = this.db.prepare('SELECT * FROM conversation_turns WHERE turn_id = ?').get(id);
    return row ? this._mapTurn(row) : null;
  }

  getRequest(requestId) {
    const row = this._stmts.request.get(requireId(requestId, 'requestId'));
    return row ? this._mapRequest(row) : null;
  }

  updateRequestResult(requestId, result) {
    const rid = requireId(requestId, 'requestId');
    const updated = this.db.prepare(`
      UPDATE conversation_requests SET result_json = ? WHERE request_id = ? AND state IN (?, ?)
    `).run(JSON.stringify(result ?? null), rid, RequestState.COMPLETED, RequestState.FAILED);
    if (updated.changes !== 1) throw new Error(`completed request not found: ${rid}`);
    return this.getRequest(rid);
  }

  claimPresentation(requestId, { leaseMs = 30_000 } = {}) {
    const rid = requireId(requestId, 'requestId');
    const now = this.now();
    const expiredBefore = now - Math.max(1_000, Number(leaseMs) || 30_000);
    const result = this.db.prepare(`
      UPDATE conversation_requests
      SET presentation_state = 'delivering', presentation_claimed_at = ?
      WHERE request_id = ? AND state IN (?, ?)
        AND (presentation_state = 'pending'
          OR (presentation_state = 'delivering' AND COALESCE(presentation_claimed_at, 0) <= ?))
    `).run(now, rid, RequestState.COMPLETED, RequestState.FAILED, expiredBefore);
    return result.changes === 1;
  }

  completePresentation(requestId) {
    const rid = requireId(requestId, 'requestId');
    return this.db.prepare(`
      UPDATE conversation_requests
      SET presentation_state = 'delivered'
      WHERE request_id = ? AND presentation_state = 'delivering'
    `).run(rid).changes === 1;
  }

  releasePresentation(requestId) {
    const rid = requireId(requestId, 'requestId');
    return this.db.prepare(`
      UPDATE conversation_requests
      SET presentation_state = 'pending', presentation_claimed_at = NULL
      WHERE request_id = ? AND presentation_state = 'delivering'
    `).run(rid).changes === 1;
  }

  _appendTurnRaw({ sessionId, turnId = createTurnId(), requestId = null, role, message, speakerVirtualPersonId = null, visibility } = {}) {
    if (!Object.values(TurnRole).includes(role)) throw new TypeError(`invalid turn role: ${role}`);
    if (!Object.values(TurnVisibility).includes(visibility)) throw new TypeError(`invalid turn visibility: ${visibility}`);
    const sid = requireId(sessionId, 'sessionId');
    const session = this._stmts.session.get(sid);
    if (!session) throw new Error(`session not found: ${sid}`);
    const normalized = normalizeMessage(role, message);
    const row = {
      turnId,
      sessionId: sid,
      sequence: session.next_sequence,
      requestId: requestId ? requireId(requestId, 'requestId') : null,
      role,
      speakerVirtualPersonId: speakerVirtualPersonId ? requireId(speakerVirtualPersonId, 'speakerVirtualPersonId') : null,
      visibility,
      messageJson: JSON.stringify(normalized),
      visibleText: visibility === TurnVisibility.VISIBLE ? visibleText(normalized) : '',
      createdAt: this.now(),
    };
    this._stmts.insertTurn.run(row);
    this._stmts.bumpSequence.run(row.createdAt, sid);
    return this._mapTurn({
      turn_id: row.turnId,
      session_id: sid,
      sequence: row.sequence,
      request_id: row.requestId,
      role,
      speaker_virtual_person_id: row.speakerVirtualPersonId,
      visibility,
      message_json: row.messageJson,
      visible_text: row.visibleText,
      created_at: row.createdAt,
    });
  }

  _mapSession(row) {
    return Object.freeze({
      sessionId: row.session_id,
      activeVirtualPersonId: row.active_virtual_person_id,
      title: row.title || '',
      archivedAt: row.archived_at || null,
      membershipRevision: row.membership_revision || 0,
      memberIds: this.db.prepare('SELECT person_id FROM conversation_members WHERE session_id = ? AND left_at IS NULL ORDER BY joined_at, person_id')
        .all(row.session_id).map(member => member.person_id),
      nextSequence: row.next_sequence,
      summaryRevision: row.summary_revision,
      createdAt: row.created_at,
      lastTurnAt: row.last_turn_at,
      pinnedAt: row.pinned_at || null,
      unreadAt: row.unread_at || null,
    });
  }

  _mapRequest(row) {
    return Object.freeze({
      requestId: row.request_id,
      sessionId: row.session_id,
      virtualPersonId: row.virtual_person_id,
      state: row.state,
      userTurnId: row.user_turn_id,
      assistantTurnId: row.assistant_turn_id || null,
      result: parseJson(row.result_json, null),
      errorId: row.error_id || null,
      presentationState: row.presentation_state || 'pending',
      presentationClaimedAt: row.presentation_claimed_at || null,
      createdAt: row.created_at,
      completedAt: row.completed_at || null,
    });
  }

  _mapTurn(row) {
    return Object.freeze({
      turnId: row.turn_id,
      sessionId: row.session_id,
      sequence: row.sequence,
      requestId: row.request_id || null,
      role: row.role,
      speakerVirtualPersonId: row.speaker_virtual_person_id || null,
      visibility: row.visibility,
      message: parseJson(row.message_json, { role: row.role, content: '' }),
      visibleText: row.visible_text || '',
      createdAt: row.created_at,
      ...(row.superseded_at ? { supersededAt: row.superseded_at } : {}),
    });
  }

  _mapSummary(row) {
    return Object.freeze({
      summaryId: row.summary_id,
      sessionId: row.session_id,
      revision: row.revision,
      fromSequence: row.from_sequence,
      toSequence: row.to_sequence,
      content: row.content,
      method: row.method,
      createdAt: row.created_at,
    });
  }
}
