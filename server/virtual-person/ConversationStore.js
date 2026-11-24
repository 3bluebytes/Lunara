import { forgetLearnedFromSources } from '../memory/forgetSources.js';
import { openSqliteDatabase } from '../sqlite.js';
import { projectWebHistory } from '../web-access/projections.js';
import { createHash, randomUUID } from 'node:crypto';
import { floorRequestPrefix, isFloorRequestId, responseRequestId } from './responsePlan.js';
import { memoryApplies, policyFromUserText } from '../memory/memoryPolicy.js';
import { resolveDatabasePath } from '../runtimePaths.js';
import { CompanionNoteStore } from './companionNotes.js';
import { normalizeLineNote } from '../playback/playbackRuntimeTypes.js';
import {
  RequestState,
  TurnRole,
  TurnVisibility,
  createRequestId,
  createTurnId,
} from './VirtualPersonTypes.js';
import { assertInteractionMode, normalizeInteractionMode } from './roleplaySpeech.js';
import { beatSpokenText } from './replyBeats.js';

// 「较早对话摘要」每个聊天、每个角色最多回看这么多份；更早的写入时删掉。
const SUMMARY_READ_WINDOW = 100;
const TRACK_PERSPECTIVE_SCAN_LIMIT = 2048;

function trackPerspectiveKey(source, songId) {
  if (typeof source !== 'string' || !source || !['string', 'number'].includes(typeof songId) || String(songId) === '') return null;
  return JSON.stringify([source, String(songId)]);
}

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

/**
 * 回合自己所在聊天的历史里，「今天只…」的期限不让这段对话消失：期限约束的是由它推出的记忆和跨聊天的摘录。
 * 别的聊天读它（跨聊天摘录、翻查）时期限照常生效。
 */
function ownChatPolicy(policy, turnSessionId, readerSessionId) {
  if (!policy?.until || turnSessionId !== readerSessionId) return policy;
  const { until, ...rest } = policy;
  return rest;
}

export class ConversationStore {
  constructor({ dbPath = null, db = null, now = () => Date.now(), onNoteSettled = null } = {}) {
    this.dbPath = dbPath || resolveDatabasePath();
    this.db = db;
    this.ownsDb = !db;
    this.now = now;
    this.onNoteSettled = typeof onNoteSettled === 'function' ? onNoteSettled : null;
    this._stmts = {};
    // 内存会话修订号：成员、归档或删改时递增，供流式草稿零 DB 查询校验复用。
    this._sessionRevisions = new Map();
  }

  sessionRevision(sessionId) {
    return this._sessionRevisions.get(String(sessionId || '')) ?? 0;
  }

  _bumpSessionRevision(sessionId) {
    const sid = String(sessionId || '');
    if (!sid) return;
    this._sessionRevisions.set(sid, this.sessionRevision(sid) + 1);
  }

  initialize() {
    if (!this.db) {
      this.db = openSqliteDatabase(this.dbPath);
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
      -- 按用户回合找它的请求：撤回、反思补录（recoverEncounterTurns）每次提交都会查。
      CREATE INDEX IF NOT EXISTS idx_conversation_requests_user_turn
        ON conversation_requests(user_turn_id, virtual_person_id);
      -- 反思只补录近 7 天：按时间取近期回合与已完成请求，不扫全部历史。
      CREATE INDEX IF NOT EXISTS idx_conversation_turns_created
        ON conversation_turns(created_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_requests_completed
        ON conversation_requests(completed_at);
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
      getTurn: turnId => this.getTurn(turnId), getSession: sessionId => this.getSession(sessionId),
      markSensitiveSources: (personIds, turnIds) => this.markSensitiveSources(personIds, turnIds),
      onSettled: this.onNoteSettled }).initialize();
    this._prepare();
    this.recoverIncomplete();
    return this;
  }

  _migrateRooms() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(conversation_sessions)').all().map(row => row.name));
    const migration = this.db.transaction(() => {
      for (const [name, definition] of Object.entries({
        title: "TEXT NOT NULL DEFAULT ''", archived_at: 'INTEGER', membership_revision: 'INTEGER NOT NULL DEFAULT 0',
        pinned_at: 'INTEGER', unread_at: 'INTEGER', interaction_mode: "TEXT NOT NULL DEFAULT 'radio'",
        return_greeted_turn_id: 'TEXT',
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
        -- 按回合找观察者：反思补录从近期回合出发、忘记共享事实时找全部看过原话的角色。
        CREATE INDEX IF NOT EXISTS idx_conversation_observations_turn ON conversation_observations(turn_id);
        CREATE INDEX IF NOT EXISTS idx_conversation_turns_session_created ON conversation_turns(session_id, created_at, sequence);
        -- 分叉复制的回合记下最初那条原回合：忘记原话时副本一起撤回（分叉的分叉也指向同一条原回合）。
        CREATE TABLE IF NOT EXISTS conversation_turn_lineage (
          turn_id TEXT PRIMARY KEY, origin_turn_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_turn_lineage_origin ON conversation_turn_lineage(origin_turn_id);
      `);
      if (!this.db.prepare('PRAGMA table_info(conversation_observations)').all().some(row => row.name === 'policy_json')) {
        this.db.exec("ALTER TABLE conversation_observations ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}'");
      }
      if (!this.db.prepare('PRAGMA table_info(conversation_summaries)').all().some(row => row.name === 'person_id')) {
        this.db.exec('ALTER TABLE conversation_summaries ADD COLUMN person_id TEXT');
      }
      // 写摘要时因有人读不到而没写进去的 turn：读时不再拿它们把整份摘要挡掉。旧行为 NULL，按整段校验。
      if (!this.db.prepare('PRAGMA table_info(conversation_summaries)').all().some(row => row.name === 'excluded_turn_ids_json')) {
        this.db.exec('ALTER TABLE conversation_summaries ADD COLUMN excluded_turn_ids_json TEXT');
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
    this._stmts.lastUserTurnId = this.db.prepare(`
      SELECT turn_id FROM conversation_turns
      WHERE session_id = ? AND role = 'user' AND visibility = 'visible' AND superseded_at IS NULL
      ORDER BY sequence DESC LIMIT 1
    `);
  }

  close() {
    if (this.ownsDb) this.db?.close();
    this.db = null;
    this._stmts = {};
    this._sessionRevisions.clear();
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
      this._bumpSessionRevision(sid);
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
    this._bumpSessionRevision(sessionId);
    return this.getSession(sessionId);
  }

  resetActiveVirtualPerson(fromVirtualPersonId, toVirtualPersonId) {
    const from = requireId(fromVirtualPersonId, 'fromVirtualPersonId');
    const to = requireId(toVirtualPersonId, 'toVirtualPersonId');
    const rooms = this.db.prepare('SELECT session_id FROM conversation_members WHERE person_id = ? AND left_at IS NULL').all(from);
    for (const row of rooms) this.removeMember(row.session_id, from, to);
    return rooms.length;
  }

  createRoom({ sessionId = `conversation:${randomUUID()}`, title = '', memberIds = ['lunara'], hostId = memberIds[0], interactionMode = 'radio' } = {}) {
    const ids = [...new Set(memberIds.map(id => requireId(id, 'memberId')))];
    if (!ids.length || ids.length > 8 || !ids.includes(hostId)) throw new TypeError('room requires 1-8 members including its host');
    if (this.getSession(sessionId)) throw new Error('conversation already exists');
    const mode = interactionMode === undefined ? 'radio' : assertInteractionMode(interactionMode);
    return this.db.transaction(() => {
      this.ensureSession(sessionId, hostId);
      for (const id of ids) this.addMember(sessionId, id);
      return this.updateRoom(sessionId, { title, interactionMode: mode });
    })();
  }

  listRooms({ includeArchived = false } = {}) {
    return this.db.prepare(`SELECT * FROM conversation_sessions ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
      ORDER BY (pinned_at IS NULL) ASC, pinned_at DESC, last_turn_at DESC, session_id`)
      .all().map(row => this._mapSession(row));
  }

  updateRoom(sessionId, { title, archived, pinned, unread, interactionMode } = {}) {
    if (!this.getSession(sessionId)) throw new Error('conversation not found');
    if (interactionMode !== undefined) {
      const mode = assertInteractionMode(interactionMode);
      this.db.prepare('UPDATE conversation_sessions SET interaction_mode = ? WHERE session_id = ?')
        .run(mode, sessionId);
      this._bumpSessionRevision(sessionId);
    }
    if (title !== undefined) this.db.prepare('UPDATE conversation_sessions SET title = ? WHERE session_id = ?')
      .run(String(title).trim().slice(0, 80), sessionId);
    if (archived !== undefined) {
      this.db.prepare('UPDATE conversation_sessions SET archived_at = ? WHERE session_id = ?')
        .run(archived ? this.now() : null, sessionId);
      this._bumpSessionRevision(sessionId);
    }
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
      // 从这个聊天学到的记忆与聊天记录一起删；必须在 turn / request 删除前读来源。
      forgetLearnedFromSources(this.db, { sessionId, now: this.now() });
      const turnIds = this.db.prepare('SELECT turn_id FROM conversation_turns WHERE session_id = ?')
        .all(sessionId).map(row => row.turn_id);
      const deleteObservation = this.db.prepare('DELETE FROM conversation_observations WHERE turn_id = ?');
      const deleteLineage = this.db.prepare('DELETE FROM conversation_turn_lineage WHERE turn_id = ?');
      for (const turnId of turnIds) {
        deleteObservation.run(turnId);
        deleteLineage.run(turnId);
      }
      this.db.prepare('DELETE FROM conversation_turns WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_requests WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_rounds WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_summaries WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM conversation_members WHERE session_id = ?').run(sessionId);
      this.notes.deleteSession(sessionId);
      this.db.prepare('DELETE FROM conversation_sessions WHERE session_id = ?').run(sessionId);
      this._bumpSessionRevision(sessionId);
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
    this._bumpSessionRevision(sessionId);
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
    this._bumpSessionRevision(sessionId);
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

  /** 她在这个聊天里最近说过的可见话，供 presence 防复读；可选排除 track_intro 串词。 */
  recentSpokenLines(sessionId, personId, { limit = 3, excludeTrackIntros = false } = {}) {
    const spoken = excludeTrackIntros
      ? ` AND COALESCE(json_extract(message_json, '$.presentation'), '') <> 'track_intro'`
      : '';
    return this.db.prepare(`SELECT visible_text FROM conversation_turns WHERE session_id = ? AND role = 'assistant'
      AND speaker_virtual_person_id = ? AND visibility = 'visible' AND visible_text <> ''${spoken}
      ORDER BY sequence DESC LIMIT ?`).all(String(sessionId || ''), String(personId || ''), Math.max(1, Math.min(10, limit)))
      .map(row => row.visible_text).reverse();
  }

  recordTrackIntro({ sessionId, personId, correlationId, queueItemId = null, text, track, about = null }) {
    const contentIdentity = queueItemId || correlationId;
    const turnId = requireId(`intro:${contentIdentity}`, 'turnId');
    const existing = this.db.prepare('SELECT * FROM conversation_turns WHERE turn_id = ?').get(turnId);
    if (existing) return null;
    const room = this.getSession(sessionId);
    if (!room) return null;
    return this.db.transaction(() => {
      const turn = this._appendTurnRaw({ turnId, sessionId, role: 'assistant', speakerVirtualPersonId: personId,
        // about：她写这段话时自己记下的意思，只供之后写串词时回忆；不进聊天记录的对外投影。
        visibility: 'visible', message: { content: text, presentation: 'track_intro', queueItemId, ...(about ? { about } : {}),
          tracks: [{ queueItemId, songId: track.songId, title: track.title, artist: track.artist, source: track.source,
            pic_url: track.artwork, q: `${track.artist} — ${track.title}` }] } });
      this.observeTurns(room.memberIds, [turn.turnId]);
      return turn;
    })();
  }

  /** 按候选顺序返回过去的角度；只读真实开口账本，不保留副本。 */
  recallTrackPerspectives({ sessionId, personId, tracks }) {
    const keys = tracks.map(track => trackPerspectiveKey(track?.source, track?.songId));
    const needed = new Set(keys.filter(Boolean));
    const room = needed.size && sessionId && personId ? this.getSession(sessionId) : null;
    if (!room || room.archivedAt || !room.memberIds.includes(personId)) return keys.map(() => null);
    // 限制扫描的是账本行数（不只是返回条数）；匹配的是来源和原生 ID，不是曲名。
    const rows = this.db.prepare(`
      WITH recent AS MATERIALIZED (
        SELECT * FROM conversation_turns WHERE session_id = ? ORDER BY sequence DESC LIMIT ?
      )
      SELECT t.*, json_extract(t.message_json, '$.about') AS note,
        json_extract(t.message_json, '$.tracks[0].source') AS source,
        json_extract(t.message_json, '$.tracks[0].songId') AS song_id
      FROM recent t
      WHERE t.role = 'assistant' AND t.visibility = 'visible' AND t.speaker_virtual_person_id = ?
        AND t.superseded_at IS NULL AND json_extract(t.message_json, '$.presentation') = 'track_intro'
        AND json_type(t.message_json, '$.about') = 'text'
        AND NOT EXISTS (SELECT 1 FROM conversation_turn_lineage l WHERE l.turn_id = t.turn_id)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) m WHERE NOT EXISTS (
            SELECT 1 FROM conversation_observations o
            WHERE o.person_id = m.value AND o.turn_id = t.turn_id AND o.revoked_at IS NULL
          )
        )
      ORDER BY t.sequence DESC
    `).iterate(sessionId, TRACK_PERSPECTIVE_SCAN_LIMIT, personId, JSON.stringify(room.memberIds));
    const notes = new Map();
    for (const row of rows) {
      const key = trackPerspectiveKey(row.source, row.song_id);
      const note = normalizeLineNote(row.note);
      if (!needed.has(key) || !note) continue;
      if (!this.canReadTurn(personId, this._mapTurn(row))) continue;
      notes.set(key, note);
      needed.delete(key);
      if (!needed.size) break;
    }
    return keys.map(key => notes.get(key) ?? null);
  }

  /**
   * 她在其他聊天里最近的可见回合，按时间正序。perSession 给定时每个聊天各取最新的若干条（上限 30 个聊天）。
   * 跨聊天的平局（同一毫秒）按 rowid 即真实写入先后裁决：sequence 只在单个聊天内可比。
   * excludeTrackIntros 为真时不取串词（presentation = track_intro）。
   */
  recentEncounters(personId, { limit = 12, excludeSessionId = null, perSession = null, excludeTrackIntros = false } = {}) {
    // 串词按呈现形态排除：先排除再取每个聊天的最新 k 条，串词多的聊天才不会只剩串词。
    const spoken = excludeTrackIntros ? ` AND COALESCE(json_extract(t.message_json, '$.presentation'), '') <> 'track_intro'` : '';
    const where = `o.person_id = ? AND o.revoked_at IS NULL AND t.superseded_at IS NULL AND (? IS NULL OR t.session_id <> ?)${spoken}`;
    const map = row => ({
      ...this._mapTurn(row),
      policy: parseJson(row.policy_json, {}),
      interactionMode: normalizeInteractionMode(row.interaction_mode),
    });
    if (perSession) {
      // 每个聊天按 (session_id, created_at, sequence) 索引各取最新 k 条，再在 JS 里按时间合并：
      // 不对这个角色看过的全部回合开窗排序（随历史总量增长）。排序键与原来的窗口查询相同。
      const k = Math.min(30, Math.max(1, perSession));
      const top = this.db.prepare(`SELECT t.*, t.rowid AS write_order, o.policy_json FROM conversation_turns t
        JOIN conversation_observations o ON o.turn_id = t.turn_id AND o.person_id = ? AND o.revoked_at IS NULL
        WHERE t.session_id = ? AND t.superseded_at IS NULL${spoken} ORDER BY t.created_at DESC, t.sequence DESC LIMIT ?`);
      const cap = 30 * k;
      if (!this.db.prepare('SELECT 1 FROM conversation_observations WHERE person_id = ? LIMIT 1').get(personId)) return [];
      // 按聊天最近活跃时间从新到旧取；已凑够 cap 条、且下一个聊天最后一条都比第 cap 条旧时停下
      // （last_turn_at 不早于聊天里任何回合的 created_at，含沿用原时间的分叉副本），结果与逐个聊天全取相同。
      const rows = [];
      for (const { session_id: sid, last_turn_at: last, interaction_mode: mode } of this.db.prepare(`SELECT session_id, last_turn_at, interaction_mode FROM conversation_sessions
        WHERE session_id IS NOT ? ORDER BY last_turn_at DESC`).iterate(excludeSessionId)) {
        if (rows.length >= cap && last < rows[cap - 1].created_at) break;
        rows.push(...top.all(personId, sid, k).map(r => ({ ...r, interaction_mode: mode })));
        rows.sort((a, b) => b.created_at - a.created_at || b.write_order - a.write_order);
        if (rows.length > cap) rows.length = cap;
      }
      return rows.reverse().map(map);
    }
    return this.db.prepare(`SELECT t.*, o.policy_json, s.interaction_mode FROM conversation_observations o
      JOIN conversation_turns t ON t.turn_id = o.turn_id
      LEFT JOIN conversation_sessions s ON s.session_id = t.session_id
      WHERE ${where}
      ORDER BY t.created_at DESC, t.rowid DESC LIMIT ?`).all(personId, excludeSessionId, excludeSessionId, Math.min(30, Math.max(1, limit)))
      .reverse().map(map);
  }

  /**
   * 当前角色看过的可见回合里按关键词搜索（add-conversation-recall-tool）。只查观察表：观察未撤回、
   * 回合未被编辑取代、可见且有正文。按命中关键词数、再按时间倒序；披露策略、敏感与群聊在场
   * 由调用方的 accept 按当前聊天逐条判断，先过滤再取前 limit 条（最多扫描 scanLimit 条命中）。关键词按字面子串匹配（LIKE，转义 % _ \）。
   */
  searchObservedTurns(personId, { keywords = [], limit = 50, accept = null, scanLimit = 2000 } = {}) {
    const terms = [...new Set((Array.isArray(keywords) ? keywords : []).map(term => String(term || '').trim()).filter(Boolean))].slice(0, 5);
    if (!terms.length) return [];
    const patterns = terms.map(term => `%${term.replace(/[\\%_]/gu, match => `\\${match}`)}%`);
    const hits = terms.map(() => "(t.visible_text LIKE ? ESCAPE '\\')").join(' + ');
    // 只排一次序：一条查询取出前 scanLimit 条命中的 id 与命中数，再按顺序逐条取整行、过 accept。
    // 不在同一条语句上边迭代边查（accept 本身还要查库），也不用 OFFSET 翻页把全表 LIKE 与排序重跑多遍。
    const ranked = this.db.prepare(`SELECT t.turn_id, (${hits}) AS hits FROM conversation_observations o
      JOIN conversation_turns t ON t.turn_id = o.turn_id
      WHERE o.person_id = ? AND o.revoked_at IS NULL AND t.superseded_at IS NULL AND t.visibility = 'visible'
        AND t.visible_text <> '' AND (${hits}) > 0
      ORDER BY hits DESC, t.created_at DESC, t.rowid DESC LIMIT ?`)
      .all(...patterns, String(personId || ''), ...patterns, Math.max(1, scanLimit));
    const full = this.db.prepare(`SELECT t.*, o.policy_json FROM conversation_turns t
      JOIN conversation_observations o ON o.turn_id = t.turn_id AND o.person_id = ? WHERE t.turn_id = ?`);
    // 先按 accept 过滤再截取：读不了的命中再多，也不会把能读的挤出前 limit 条。
    const wanted = Math.min(200, Math.max(1, limit));
    const found = [];
    for (const { turn_id: turnId, hits: count } of ranked) {
      const row = full.get(String(personId || ''), turnId);
      if (!row) continue;
      const turn = { ...this._mapTurn(row), policy: parseJson(row.policy_json, {}), observed: true, hits: count };
      if (accept && !accept(turn)) continue;
      found.push(turn);
      if (found.length >= wanted) break;
    }
    return found;
  }

  /**
   * 同一聊天里某回合前后各若干条可见回合（含它自己），按聊天内顺序。带上该角色对每条的观察策略
   * （没观察过的 observed=false），由调用方逐条判断能否读。
   */
  turnsAround(personId, turnId, { before = 3, after = 3 } = {}) {
    const center = this.db.prepare('SELECT session_id, sequence FROM conversation_turns WHERE turn_id = ?').get(String(turnId || ''));
    if (!center) return [];
    const select = (comparison, order, count) => this.db.prepare(`SELECT t.*, o.policy_json, o.turn_id AS observed_turn
      FROM conversation_turns t LEFT JOIN conversation_observations o ON o.turn_id = t.turn_id AND o.person_id = ?
      WHERE t.session_id = ? AND t.sequence ${comparison} ? AND t.visibility = 'visible' AND t.superseded_at IS NULL AND t.visible_text <> ''
      ORDER BY t.sequence ${order} LIMIT ?`).all(String(personId || ''), center.session_id, center.sequence, count);
    const rows = [...select('<', 'DESC', Math.max(0, before)).reverse(), ...select('=', 'ASC', 1), ...select('>', 'ASC', Math.max(0, after))];
    return rows.map(row => ({ ...this._mapTurn(row), policy: parseJson(row.policy_json, {}), observed: row.observed_turn != null }));
  }

  /**
   * 反思判为敏感的来源（连同那一轮她的回复）不再作为跨聊天摘录出现：在观察的披露策略上记 sensitive。
   * 只收紧不放宽；原聊天里照常可读，心里话也照常保留。
   * 敏感是这句话本身的性质：标在每个看过它的角色的观察上（含已经离开群聊的成员），
   * 分叉复制出的副本一起标。personIds 是发现它的角色，保留参数以兼容调用方。
   */
  markSensitiveSources(personIds, turnIds) {
    void personIds;
    const keys = new Set(turnIds.filter(Boolean).map(String));
    const pair = this.db.prepare('SELECT assistant_turn_id FROM conversation_requests WHERE user_turn_id = ?');
    for (const turnId of [...keys]) for (const row of pair.all(turnId)) if (row.assistant_turn_id) keys.add(row.assistant_turn_id);
    const update = this.db.prepare(`UPDATE conversation_observations SET policy_json = json_set(policy_json, '$.sensitive', json('true'))
      WHERE turn_id = ?`);
    this.db.transaction(() => {
      for (const turnId of this._withForkCopies([...keys])) update.run(turnId);
    })();
  }

  revokeObservation(personId, turnId) {
    return this.db.transaction(() => {
      // 这一轮的用户原话与回应，连同分叉复制出的副本，一起撤回。
      const replies = this.db.prepare('SELECT assistant_turn_id FROM conversation_requests WHERE user_turn_id = ?')
        .all(turnId).map(row => row.assistant_turn_id).filter(Boolean);
      const turnIds = this._withForkCopies([turnId, ...replies]);
      const revoke = this.db.prepare('UPDATE conversation_observations SET revoked_at = COALESCE(revoked_at, ?) WHERE person_id = ? AND turn_id = ?');
      const now = this.now();
      let changes = 0;
      for (const id of turnIds) changes += revoke.run(now, personId, id).changes;
      const position = this.db.prepare('SELECT session_id, sequence FROM conversation_turns WHERE turn_id = ?');
      const dropSummaries = this.db.prepare('DELETE FROM conversation_summaries WHERE session_id = ? AND to_sequence >= ?');
      for (const id of turnIds) {
        const source = position.get(id);
        if (source) dropSummaries.run(source.session_id, source.sequence);
      }
      // 被忘记的来源不能经由心里话被重新提起。
      this.notes.dropBySourceTurns(turnIds, { personId });
      return changes > 0;
    })();
  }

  /**
   * 这些角色当时是否都在场：回复看它所答的那条用户消息（分叉副本看原回合），其余回合看它自己的观察；
   * 从不登记观察的回合（主动开口等）看原回合发生时角色是否已是那个聊天的成员。
   * 后来才加入的成员不算在场，也不借分叉副本补观察。
   */
  witnessedByAll(turnId, personIds) {
    const ids = [...new Set(personIds.map(String))];
    if (!ids.length) return true;
    const q = this._witnessStmts ||= {
      origin: this.db.prepare('SELECT origin_turn_id FROM conversation_turn_lineage WHERE turn_id = ?'),
      own: this.db.prepare(`SELECT r.user_turn_id FROM conversation_turns t
        JOIN conversation_requests r ON r.request_id = t.request_id WHERE t.turn_id = ?`),
      observers: this.db.prepare('SELECT person_id FROM conversation_observations WHERE turn_id = ?'),
      turn: this.db.prepare('SELECT session_id, created_at FROM conversation_turns WHERE turn_id = ?'),
      member: this.db.prepare(`SELECT 1 FROM conversation_members WHERE session_id = ? AND person_id = ?
        AND joined_at <= ? AND (left_at IS NULL OR left_at >= ?)`),
    };
    const id = String(turnId);
    const originId = q.origin.get(id)?.origin_turn_id;
    const anchor = q.own.get(id)?.user_turn_id || (originId && q.own.get(originId)?.user_turn_id) || id;
    const observers = new Set(q.observers.all(anchor).map(row => row.person_id));
    if (observers.size) return ids.every(person => observers.has(person));
    const origin = q.turn.get(originId || id);
    if (!origin) return false;
    return ids.every(person => Boolean(q.member.get(origin.session_id, person, origin.created_at, origin.created_at)));
  }

  /** 她在这个聊天里最早在场的回合序号（最早的观察或她自己说的话）；从未在场为 null。 */
  firstPresentSequence(sessionId, personId) {
    const q = this._firstPresentStmts ||= {
      observed: this.db.prepare(`SELECT MIN(t.sequence) AS seq FROM conversation_observations o
        JOIN conversation_turns t ON t.turn_id = o.turn_id WHERE o.person_id = ? AND t.session_id = ?`),
      spoke: this.db.prepare(`SELECT sequence AS seq FROM conversation_turns
        WHERE session_id = ? AND speaker_virtual_person_id = ? ORDER BY sequence LIMIT 1`),
    };
    const values = [q.observed.get(String(personId), String(sessionId))?.seq, q.spoke.get(String(sessionId), String(personId))?.seq]
      .filter(value => value != null);
    return values.length ? Math.min(...values) : null;
  }

  /** 观察过这一回合（含分叉副本）的角色。 */
  observersOf(turnId) {
    const ids = this._withForkCopies([turnId]);
    return this.db.prepare(`SELECT DISTINCT person_id FROM conversation_observations
      WHERE turn_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(row => row.person_id);
  }

  /** 回合 id 连同同一原回合的所有分叉副本（含原回合本身）。 */
  _withForkCopies(turnIds) {
    const origin = this.db.prepare('SELECT origin_turn_id FROM conversation_turn_lineage WHERE turn_id = ?');
    const copies = this.db.prepare('SELECT turn_id FROM conversation_turn_lineage WHERE origin_turn_id = ?');
    const all = new Set();
    for (const id of turnIds.map(String)) {
      const root = origin.get(id)?.origin_turn_id || id;
      all.add(id);
      all.add(root);
      for (const row of copies.all(root)) all.add(row.turn_id);
    }
    return [...all];
  }

  isTurnRevoked(personId, turn) {
    const request = turn.requestId ? this.getRequest(turn.requestId) : null;
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_observations WHERE person_id = ? AND revoked_at IS NOT NULL
      AND turn_id IN (?, ?)`).get(personId, turn.turnId, request?.userTurnId || ''));
  }

  canReadTurn(personId, turn, options = {}) {
    return this.readTurnAs(personId, turn, options).readable;
  }

  /**
   * 与 canReadTurn 同一套判断，另给出这条回合在她上下文里该带的来源标签（私下说的 / 比较私人）。
   * 返回 { readable, policy }；读不到时 policy 为 null。
   */
  readTurnAs(personId, turn, options = {}) {
    if (this.isTurnRevoked(personId, turn)) return { readable: false, policy: null };
    if (turn.visibility !== 'visible') {
      const readable = turn.speakerVirtualPersonId === personId;
      return { readable, policy: readable ? {} : null };
    }
    const observation = this.db.prepare('SELECT policy_json, revoked_at FROM conversation_observations WHERE person_id = ? AND turn_id = ?').get(personId, turn.turnId);
    // 分叉副本没有 request：回应的披露范围沿 lineage 回到原回合，按原回合那次请求的用户原话判断。
    const own = turn.requestId ? this.getRequest(turn.requestId) : null;
    const originId = !own && this.db.prepare('SELECT origin_turn_id FROM conversation_turn_lineage WHERE turn_id = ?').get(turn.turnId)?.origin_turn_id;
    const originRequestId = originId && this.db.prepare('SELECT request_id FROM conversation_turns WHERE turn_id = ?').get(originId)?.request_id;
    const request = own || (originRequestId ? this.getRequest(originRequestId) : null);
    const source = request && this.db.prepare('SELECT visible_text, created_at FROM conversation_turns WHERE turn_id = ?').get(request.userTurnId);
    const policy = observation ? parseJson(observation.policy_json, {})
      // 主动开口不是用户原话：不能拿它反推披露策略，按无标记的公开聊天处理。
      : policyFromUserText(turn.message?.presentation === 'presence' ? '' : (source?.visible_text || turn.visibleText),
        turn.sessionId, source?.created_at || turn.createdAt);
    // 她自己在场听到的，私下说的也照样记得（群聊里提不提是她的分寸）；
    // 没在场的只能读聊天里公开的历史，私下说的不给——那不是她经历过的事。
    const readerSession = options.sessionId ?? turn.sessionId;
    const readable = observation?.revoked_at == null && memoryApplies({ policy: ownChatPolicy(policy, turn.sessionId, readerSession) }, {
      sessionId: turn.sessionId, now: options.now, shared: !observation,
    });
    return { readable, policy: readable ? policy : null };
  }

  saveSummary({ sessionId, personId = null, fromSequence, toSequence, content, method = 'deterministic-fallback',
    excludedTurnIds = null } = {}) {
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
          (session_id, revision, from_sequence, to_sequence, content, method, created_at, person_id, excluded_turn_ids_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(sid, revision, from, to, summary.slice(0, 8000), String(method || 'deterministic-fallback').slice(0, 80), this.now(), personId,
        Array.isArray(excludedTurnIds) ? JSON.stringify([...new Set(excludedTurnIds.map(String))]) : null);
      this.db.prepare(`UPDATE conversation_sessions SET summary_revision = ? WHERE session_id = ?`).run(revision, sid);
      // 读取只看最近 SUMMARY_READ_WINDOW 份；同一聊天、同一角色更早的摘要永远读不到，写入时就删掉，表不随聊天长度无限增长。
      this.db.prepare(`DELETE FROM conversation_summaries WHERE session_id = ? AND person_id IS ? AND revision <= (
        SELECT revision FROM conversation_summaries WHERE session_id = ? AND person_id IS ?
        ORDER BY revision DESC LIMIT 1 OFFSET ?)`).run(sid, personId, sid, personId, SUMMARY_READ_WINDOW);
      return this.db.prepare(`SELECT * FROM conversation_summaries WHERE session_id = ? AND revision = ?`).get(sid, revision);
    });
    return this._mapSummary(transaction());
  }

  listSummaries(sessionId, { limit = 20, personId = null, scan = null } = {}) {
    const sid = requireId(sessionId, 'sessionId');
    const max = Math.max(1, Math.min(Number(limit) || 20, SUMMARY_READ_WINDOW));
    if (!personId) {
      return this.db.prepare('SELECT * FROM conversation_summaries WHERE session_id = ? ORDER BY revision DESC LIMIT ?')
        .all(sid, max).reverse().map(row => this._mapSummary(row));
    }
    // 先只取范围与排除清单，正文（最长 8000 字）只给通过校验的那几份读。
    const rows = this.db.prepare(`SELECT summary_id, from_sequence, to_sequence, excluded_turn_ids_json FROM conversation_summaries
      WHERE session_id = ? AND (person_id IS NULL OR person_id = ?)
      ORDER BY revision DESC LIMIT ?`).all(sid, personId, SUMMARY_READ_WINDOW);
    // 从新到旧逐份校验，凑够 max 份就停：累计摘要的范围都从头算起，逐份全量校验会随聊天长度平方增长。
    // 同一回合在一次调用里只判一次能否读。
    // 与 canReadTurn 同一判断，但观察、请求与来源原话在一次连接查询里取齐，免得每条回合四五次查询。
    // 有观察、没撤回、策略里没有限定聊天的回合在任何聊天里都能读，直接在 SQL 里放行；
    // 只把剩下的（没观察、已撤回、带限制或策略读不懂的）取出来逐条判断，也不取用不到的 message_json 全文。
    const turnsInRange = this.db.prepare(`SELECT t.turn_id, t.sequence, t.session_id, t.created_at, t.visible_text,
        CASE WHEN json_valid(t.message_json) THEN json_extract(t.message_json, '$.presentation') END AS presentation,
        o.turn_id AS obs_turn, o.policy_json AS obs_policy, o.revoked_at AS obs_revoked,
        uo.revoked_at AS user_obs_revoked, u.visible_text AS source_text, u.created_at AS source_created_at
      FROM conversation_turns t
      LEFT JOIN conversation_observations o ON o.person_id = ? AND o.turn_id = t.turn_id
      LEFT JOIN conversation_turn_lineage l ON t.request_id IS NULL AND l.turn_id = t.turn_id
      LEFT JOIN conversation_turns ot ON ot.turn_id = l.origin_turn_id
      LEFT JOIN conversation_requests r ON r.request_id = COALESCE(t.request_id, ot.request_id)
      LEFT JOIN conversation_observations uo ON uo.person_id = ? AND uo.turn_id = r.user_turn_id
      LEFT JOIN conversation_turns u ON u.turn_id = r.user_turn_id
      WHERE t.session_id = ? AND t.visibility = 'visible' AND t.sequence BETWEEN ? AND ?
        AND NOT (o.turn_id IS NOT NULL AND o.revoked_at IS NULL AND uo.revoked_at IS NULL
          AND (o.policy_json IS NULL OR o.policy_json = '{"disclosure":"normal"}'
            OR (json_valid(o.policy_json) AND json_type(o.policy_json) = 'object'
            AND json_extract(o.policy_json, '$.onlyConversationId') IS NULL
            AND json_extract(o.policy_json, '$.until') IS NULL)))`);
    const readable = new Map();
    const canRead = row => {
      if (!readable.has(row.turn_id)) {
        const revoked = row.obs_revoked != null || row.user_obs_revoked != null;
        const policy = row.obs_turn ? parseJson(row.obs_policy, {})
          : policyFromUserText(row.presentation === 'presence' ? '' : (row.source_text || row.visible_text || ''),
            row.session_id, row.source_created_at || row.created_at);
        readable.set(row.turn_id, !revoked && memoryApplies({ policy: ownChatPolicy(policy && typeof policy === 'object' ? policy : {},
          row.session_id, row.session_id) },
          { sessionId: row.session_id, shared: !row.obs_turn }));
      }
      return readable.get(row.turn_id);
    };
    if (!rows.length) return [];
    // 所有候选摘要的范围合起来只查一次：读不了的回合落在哪份摘要的范围里（且写入时没被排除），哪份就不给。
    // 逐份查询在某条回合变得读不了（如「今天只…」到期）时，100 份累计摘要会各自全量扫一遍。
    const lo = Math.min(...rows.map(row => row.from_sequence));
    const hi = Math.max(...rows.map(row => row.to_sequence));
    // 调用方可传一个 scan 对象，在一轮上下文组装里（先续写摘要、再读摘要）复用上一次扫描的原始行，只补扫新增的尾部。
    // 缓存的是 SQL 预筛后的原始行，每次都重新判断能否读，到期这类随时间变化的判断照样准确；
    // scan 只活在这一轮，两次读之间只有摘要写入，撤回、观察等写入不会落在中间。
    const key = `${sid}\u0000${personId}`;
    const cached = scan?.key === key && scan.lo <= lo ? scan : null;
    let candidates;
    if (cached && cached.hi >= hi) candidates = cached.rows;
    else if (cached) candidates = [...cached.rows, ...turnsInRange.all(personId, personId, sid, cached.hi + 1, hi)];
    else candidates = turnsInRange.all(personId, personId, sid, lo, hi);
    if (scan) Object.assign(scan, { key, lo: cached ? cached.lo : lo, hi: Math.max(hi, cached?.hi ?? hi), rows: candidates });
    const unreadable = candidates.filter(turn => turn.sequence >= lo && turn.sequence <= hi && !canRead(turn));
    const accepted = [];
    for (const row of rows) {
      if (accepted.length >= max) break;
      // A private excerpt or a revoked observation must not re-enter via an older summary.
      // Turns left out when the summary was written never entered it and do not hide it.
      const excluded = new Set(parseJson(row.excluded_turn_ids_json, []));
      if (unreadable.every(turn => turn.sequence < row.from_sequence || turn.sequence > row.to_sequence
        || excluded.has(turn.turn_id))) {
        accepted.push(row);
      }
    }
    const full = this.db.prepare('SELECT * FROM conversation_summaries WHERE summary_id = ?');
    return accepted.reverse().map(row => this._mapSummary(full.get(row.summary_id)));
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
        message: { role: TurnRole.ASSISTANT, content: safeText, technicalFailure: 'failed' },
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

  /** afterSequence：只取序号大于它的回合（压缩边界之后的窗口）；与 limit 一起时取其中最新的 limit 条。 */
  listTurns(sessionId, { limit = 50, beforeSequence = null, afterSequence = null, includeRequestId = null, visibleOnly = false } = {}) {
    const sid = requireId(sessionId, 'sessionId');
    const max = Math.max(1, Math.min(Number(limit) || 50, 500));
    const visibilityClause = visibleOnly ? `AND t.visibility = '${TurnVisibility.VISIBLE}'` : '';
    const rows = this.db.prepare(`
      SELECT t.*
      FROM conversation_turns t
      LEFT JOIN conversation_requests r ON r.request_id = t.request_id
      WHERE t.session_id = ?
        AND t.sequence < ?
        AND t.sequence > ?
        AND t.superseded_at IS NULL
        AND (t.request_id IS NULL OR r.state IN (?, ?) OR t.request_id = ?)
        ${visibilityClause}
      ORDER BY t.sequence DESC
      LIMIT ?
    `).all(sid, Number(beforeSequence) || Number.MAX_SAFE_INTEGER, Number(afterSequence) || 0, RequestState.COMPLETED, RequestState.FAILED, includeRequestId || '', max);
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
   * 覆盖它们的摘要删除、以它们为来源的心里话与学到的记忆撤回；请求、观察与 round 行保留。不碰播放。
   */
  rewindFromTurn(sessionId, turnId) {
    const target = this._branchPoint(sessionId, turnId);
    return this.db.transaction(() => {
      const ids = this.db.prepare(`SELECT turn_id FROM conversation_turns WHERE session_id = ? AND sequence >= ?
        AND superseded_at IS NULL`).all(target.sessionId, target.sequence).map(row => row.turn_id);
      this.db.prepare(`UPDATE conversation_turns SET superseded_at = ? WHERE session_id = ? AND sequence >= ?
        AND superseded_at IS NULL`).run(this.now(), target.sessionId, target.sequence);
      const greetedId = this.getReturnGreetedTurnId(target.sessionId);
      if (greetedId && ids.includes(greetedId)) {
        this.db.prepare('UPDATE conversation_sessions SET return_greeted_turn_id = NULL WHERE session_id = ?')
          .run(target.sessionId);
      }
      this.db.prepare('DELETE FROM conversation_summaries WHERE session_id = ? AND to_sequence >= ?')
        .run(target.sessionId, target.sequence);
      const people = this.db.prepare('SELECT DISTINCT person_id FROM conversation_members WHERE session_id = ?')
        .all(target.sessionId).map(row => row.person_id);
      for (const personId of people) this.notes.dropBySourceTurns(ids, { personId });
      // 被改写掉的消息里学到的记忆（显式事实、反思洞察、晋升证据）一并撤回。
      forgetLearnedFromSources(this.db, { turnIds: ids, now: this.now() });
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
      const room = this.createRoom({ title, memberIds: source.memberIds, hostId: source.activeVirtualPersonId,
        interactionMode: source.interactionMode || 'radio' });
      const observations = this.db.prepare('SELECT person_id, policy_json, revoked_at FROM conversation_observations WHERE turn_id = ?');
      const observe = this.db.prepare(`INSERT OR IGNORE INTO conversation_observations(person_id, turn_id, policy_json, revoked_at)
        VALUES (?, ?, ?, ?)`);
      const origin = this.db.prepare('SELECT origin_turn_id FROM conversation_turn_lineage WHERE turn_id = ?');
      const lineage = this.db.prepare('INSERT OR IGNORE INTO conversation_turn_lineage(turn_id, origin_turn_id) VALUES (?, ?)');
      for (const turn of history) {
        const { content, presentation, tracks, groupFloor, webSources, queueItemId, segments, voice, beats } = turn.message;
        const copy = this._appendTurnRaw({ sessionId: room.sessionId, role: turn.role, visibility: TurnVisibility.VISIBLE,
          speakerVirtualPersonId: turn.speakerVirtualPersonId, createdAt: turn.createdAt,
          message: { content, ...(presentation ? { presentation } : {}), ...(tracks ? { tracks } : {}),
            ...(groupFloor ? { groupFloor } : {}), ...(webSources ? { webSources } : {}), ...(queueItemId ? { queueItemId } : {}),
            ...(segments ? { segments } : {}), ...(voice ? { voice } : {}), ...(beats ? { beats } : {}) } });
        // 用户 turn 的撤销登记在原 turn 上，它的回应只经 request 关联；副本没有 request，所以撤销状态并到回应上。
        const request = turn.requestId ? this.getRequest(turn.requestId) : null;
        const revokedVia = request && request.userTurnId !== turn.turnId
          ? new Map(observations.all(request.userTurnId).filter(row => row.revoked_at != null).map(row => [row.person_id, row.revoked_at]))
          : new Map();
        for (const row of observations.all(turn.turnId)) {
          observe.run(row.person_id, copy.turnId, row.policy_json, row.revoked_at ?? revokedVia.get(row.person_id) ?? null);
        }
        lineage.run(copy.turnId, origin.get(turn.turnId)?.origin_turn_id || turn.turnId);
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

  getReturnGreetedTurnId(sessionId) {
    const row = this._stmts.session.get(requireId(sessionId, 'sessionId'));
    return row?.return_greeted_turn_id || null;
  }

  setReturnGreetedTurnId(sessionId, turnId) {
    const sid = requireId(sessionId, 'sessionId');
    if (!this._stmts.session.get(sid)) throw new Error(`conversation not found: ${sid}`);
    const tid = turnId == null || String(turnId).trim() === '' ? null : String(turnId).trim().slice(0, 128);
    this.db.prepare('UPDATE conversation_sessions SET return_greeted_turn_id = ? WHERE session_id = ?').run(tid, sid);
    this._bumpSessionRevision(sid);
    return this.getSession(sid);
  }

  /** 将语音合成结果（整组或单拍缓存）写回一条可见 turn 的 message_json.voice / message_json.beats。 */
  updateTurnVoice(turnId, patch) {
    const id = String(turnId || '').trim();
    if (!id || !patch || typeof patch !== 'object') return null;
    const row = this.db.prepare('SELECT * FROM conversation_turns WHERE turn_id = ? AND superseded_at IS NULL').get(id);
    if (!row) return null;
    const message = parseJson(row.message_json, { role: row.role, content: row.visible_text || '' });
    let nextBeats = patch.beats === null
      ? null
      : (Array.isArray(message.beats) ? structuredClone(message.beats) : null);

    if (Array.isArray(patch.beats)) {
      nextBeats = patch.beats.map((item, idx) => {
        const existing = nextBeats?.find((b, pos) => (Number.isInteger(b?.index) ? b.index : pos) === (Number.isInteger(item?.index) ? item.index : idx)) || {};
        return {
          ...existing,
          ...item,
          index: Number.isInteger(item?.index) ? item.index : idx,
        };
      });
    } else if (Number.isInteger(patch.beatIndex) && patch.beatIndex >= 0 && Array.isArray(nextBeats)) {
      const targetIdx = nextBeats.findIndex((b, pos) => (Number.isInteger(b?.index) ? b.index : pos) === patch.beatIndex);
      if (targetIdx >= 0) {
        const prevBeat = nextBeats[targetIdx] && typeof nextBeats[targetIdx] === 'object' ? nextBeats[targetIdx] : {};
        nextBeats[targetIdx] = {
          ...prevBeat,
          ...(patch.audioUrl !== undefined ? { audioUrl: patch.audioUrl } : {}),
          ...(patch.hash !== undefined ? { hash: patch.hash } : {}),
          ...(Number.isFinite(patch.durationMs) ? { durationMs: patch.durationMs } : {}),
        };
      }
    } else if (Array.isArray(nextBeats) && nextBeats.length === 1 && patch.audioUrl) {
      nextBeats[0] = {
        ...nextBeats[0],
        audioUrl: patch.audioUrl,
        ...(patch.hash ? { hash: patch.hash } : {}),
        ...(Number.isFinite(patch.durationMs) ? { durationMs: patch.durationMs } : {}),
      };
    }

    const { beatIndex: _beatIndex, beats: _patchBeats, ...voiceFields } = patch;
    const prevVoice = message.voice && typeof message.voice === 'object' ? { ...message.voice } : {};
    const nextVoice = { ...prevVoice, ...voiceFields };

    if (Array.isArray(nextBeats) && nextBeats.length > 0 && (Number.isInteger(patch.beatIndex) || Array.isArray(patch.beats))) {
      const speakableBeats = nextBeats.filter(beat => Boolean(beatSpokenText(beat)));
      const readyBeats = speakableBeats.filter(beat => Boolean(beat?.audioUrl));
      const allReady = speakableBeats.length > 0 && readyBeats.length === speakableBeats.length;
      if (allReady) {
        const firstReady = readyBeats[0];
        const totalDuration = readyBeats.reduce((sum, b) => sum + (Number.isFinite(Number(b.durationMs)) ? Number(b.durationMs) : 0), 0);
        const hasAnyDuration = readyBeats.some(b => Number.isFinite(Number(b.durationMs)));
        nextVoice.audioUrl = firstReady.audioUrl;
        if (firstReady.hash) nextVoice.hash = firstReady.hash;
        if (hasAnyDuration) nextVoice.durationMs = totalDuration;
        if (!nextVoice.synthesizedAt) nextVoice.synthesizedAt = this.now();
      } else {
        delete nextVoice.audioUrl;
        delete nextVoice.hash;
        delete nextVoice.durationMs;
      }
    }

    const next = {
      ...message,
      ...(Object.keys(nextVoice).length ? { voice: nextVoice } : {}),
      ...(nextBeats ? { beats: nextBeats } : {}),
    };
    if (patch.beats === null) delete next.beats;
    this.db.prepare('UPDATE conversation_turns SET message_json = ? WHERE turn_id = ?').run(JSON.stringify(next), id);
    return this.getTurn(id);
  }

  /** 读取一组 turn（如将删除的会话、将改写的后缀）中曾绑定的 voice.hash 与 beats[*].hash。 */
  voiceHashesForSession(sessionId) {
    const sid = requireId(sessionId, 'sessionId');
    return this.db.prepare(`SELECT json_extract(message_json, '$.voice.hash') AS hash
      FROM conversation_turns WHERE session_id = ? AND json_valid(message_json)
        AND json_type(message_json, '$.voice.hash') = 'text'
      UNION
      SELECT json_extract(b.value, '$.hash') AS hash
      FROM conversation_turns t, json_each(t.message_json, '$.beats') b
      WHERE t.session_id = ? AND json_valid(t.message_json)
        AND json_type(t.message_json, '$.beats') = 'array'
        AND json_type(b.value, '$.hash') = 'text'`).all(sid, sid)
      .map(row => String(row.hash || '').trim()).filter(Boolean);
  }

  voiceHashesFromTurn(sessionId, fromSequence) {
    const sid = requireId(sessionId, 'sessionId');
    const seq = Number(fromSequence) || 0;
    return this.db.prepare(`SELECT json_extract(message_json, '$.voice.hash') AS hash
      FROM conversation_turns WHERE session_id = ? AND sequence >= ? AND superseded_at IS NULL
        AND json_valid(message_json) AND json_type(message_json, '$.voice.hash') = 'text'
      UNION
      SELECT json_extract(b.value, '$.hash') AS hash
      FROM conversation_turns t, json_each(t.message_json, '$.beats') b
      WHERE t.session_id = ? AND t.sequence >= ? AND t.superseded_at IS NULL
        AND json_valid(t.message_json) AND json_type(t.message_json, '$.beats') = 'array'
        AND json_type(b.value, '$.hash') = 'text'`).all(sid, seq, sid, seq)
      .map(row => String(row.hash || '').trim()).filter(Boolean);
  }

  voiceHashesForPerson(personId) {
    const pid = requireId(personId, 'personId');
    if (!this.db) return [];
    return this.db.prepare(`SELECT json_extract(message_json, '$.voice.hash') AS hash
      FROM conversation_turns WHERE speaker_virtual_person_id = ?
        AND json_valid(message_json) AND json_type(message_json, '$.voice.hash') = 'text'
      UNION
      SELECT json_extract(b.value, '$.hash') AS hash
      FROM conversation_turns t, json_each(t.message_json, '$.beats') b
      WHERE t.speaker_virtual_person_id = ? AND json_valid(t.message_json)
        AND json_type(t.message_json, '$.beats') = 'array'
        AND json_type(b.value, '$.hash') = 'text'`).all(pid, pid)
      .map(row => String(row.hash || '').trim()).filter(Boolean);
  }

  /** 返回仍被未撤回/未改写回合引用的全部 voice.hash 与 beats[*].hash 集合。 */
  referencedVoiceHashes() {
    if (!this.db) return new Set();
    const rows = this.db.prepare(`SELECT json_extract(message_json, '$.voice.hash') AS hash
      FROM conversation_turns WHERE superseded_at IS NULL AND json_valid(message_json)
        AND json_type(message_json, '$.voice.hash') = 'text'
      UNION
      SELECT json_extract(b.value, '$.hash') AS hash
      FROM conversation_turns t, json_each(t.message_json, '$.beats') b
      WHERE t.superseded_at IS NULL AND json_valid(t.message_json)
        AND json_type(t.message_json, '$.beats') = 'array'
        AND json_type(b.value, '$.hash') = 'text'`).all();
    return new Set(rows.map(row => String(row.hash || '').trim()).filter(Boolean));
  }

  /** 给定一批 turnId（如手帐引用），返回它们当前绑定的 voice.hash 与 beats[*].hash 集合。 */
  voiceHashesForTurnIds(turnIds = []) {
    const ids = [...new Set((Array.isArray(turnIds) ? turnIds : []).map(id => String(id || '').trim()).filter(Boolean))];
    if (!ids.length || !this.db) return new Set();
    const stmt = this.db.prepare(`SELECT json_extract(message_json, '$.voice.hash') AS hash
      FROM conversation_turns WHERE turn_id = ? AND json_valid(message_json) AND json_type(message_json, '$.voice.hash') = 'text'
      UNION
      SELECT json_extract(b.value, '$.hash') AS hash
      FROM conversation_turns t, json_each(t.message_json, '$.beats') b
      WHERE t.turn_id = ? AND json_valid(t.message_json) AND json_type(t.message_json, '$.beats') = 'array'
        AND json_type(b.value, '$.hash') = 'text'`);
    const out = new Set();
    for (const id of ids) {
      for (const row of stmt.all(id, id)) {
        if (typeof row.hash === 'string' && row.hash.trim()) out.add(row.hash.trim());
      }
    }
    return out;
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

  _appendTurnRaw({ sessionId, turnId = createTurnId(), requestId = null, role, message, speakerVirtualPersonId = null, visibility,
    createdAt = null } = {}) {
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
      // 分叉的副本沿用原回合说话的时间：摘录、翻查与历史里的时间都指那句话本身，不是分叉时刻。
      createdAt: createdAt ?? this.now(),
    };
    this._stmts.insertTurn.run(row);
    this._stmts.bumpSequence.run(this.now(), sid);
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
      interactionMode: normalizeInteractionMode(row.interaction_mode),
      returnGreetedTurnId: row.return_greeted_turn_id || null,
      lastUserTurnId: this._stmts.lastUserTurnId?.get(row.session_id)?.turn_id || null,
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
      excludedTurnIds: row.excluded_turn_ids_json == null ? null : parseJson(row.excluded_turn_ids_json, []),
    });
  }
}
