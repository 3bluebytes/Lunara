// companionNotes.js — 伙伴的「心里话」存储（add-companion-heartbeat D3，阶段 B/C）。
//
// 一条 note 是她自己心里挂着的事，不是记忆、不是偏好、不是观察：
//   - thought：ambient 回合里刚想到的（6 小时过期）；
//   - followup：她约自己「过几分钟 / 这首放完 / 下次一起听时」再想一想（最多 7 天）；
//   - open_loop：反思从你的原话里提炼的「没完的事」（到期 +1 天，没有日期 14 天）。
// 作用域是（伙伴 × 聊天）：不跨聊天、不跨伙伴、不进 Station 共享知识。
// 读时惰性过期，并按 canReadTurn 过滤来源回合——来源被撤回或不可读，这条就不可见。
//
// 调用顺序：
//   ambient 回合的工具 → NoteStage 暂存 → 入账时 applyStage（与可见回合同一事务）；
//   普通回合的 settle_thought → settle（立即、幂等）；
//   反思 → acceptOpenLoop（确定性 id，重放不重复；群聊要求全员可读来源）；
//   _assembleContext → listVisible → PromptAssembler 心里话小节；
//   CompanionHeartbeat → pendingFollowups（只读，决定提前叫醒）。
//
// Python 伪代码：
//   notes = CompanionNoteStore(db, now, can_read_turn)
//   visible = notes.list_visible(person_id='lunara', session_id=sid, mode='ambient', wake=wake)
//   with db.transaction(): notes.apply_stage(stage, person_id, session_id)
import { createHash } from 'node:crypto';

export const NOTE_KINDS = Object.freeze(['thought', 'open_loop', 'followup']);
export const NOTE_LIMITS = Object.freeze({
  textMax: 200, aboutMax: 120, openPerScope: 12, pendingFollowups: 3,
  thoughtMs: 6 * 60 * 60_000, undatedLoopMs: 14 * 24 * 60 * 60_000, followupMs: 7 * 24 * 60 * 60_000,
  dayMs: 24 * 60 * 60_000, raiseLimit: 2, raiseGapMs: 24 * 60 * 60_000,
});
const ACTIVE = "status IN ('open', 'raised')";
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };

/** 确定性 note id：同一来源同一序号重放只得到同一条。 */
export function noteIdOf(origin, originKey, index = 0) {
  return `note:${createHash('sha256').update(JSON.stringify([String(origin), String(originKey), Number(index)])).digest('hex').slice(0, 24)}`;
}

/** 本地日期 YYYY-MM-DD → 当天 00:00 的毫秒；不合法为 null。 */
export function localDateMs(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date.getTime() : null;
}

/** ambient 回合里工具写的暂存区：被打断或重验失败就整批丢掉。 */
export function createNoteStage() {
  return { creates: [], settles: [], raises: [], consumes: [] };
}

export function stageHasChanges(stage) {
  return Boolean(stage && (stage.creates.length || stage.settles.length || stage.raises.length || stage.consumes.length));
}

export class CompanionNoteStore {
  constructor({ db, now = () => Date.now(), canReadTurn = () => true, getTurn = () => null, getSession = () => null } = {}) {
    if (!db) throw new TypeError('CompanionNoteStore requires db');
    Object.assign(this, { db, now, canReadTurn, getTurn, getSession });
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_notes (
        note_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        origin TEXT NOT NULL,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        policy_json TEXT NOT NULL DEFAULT '{}',
        sensitive INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        due_at INTEGER,
        wake_condition TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        raised_count INTEGER NOT NULL DEFAULT 0,
        raised_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_companion_notes_scope ON companion_notes(person_id, session_id, status);
      CREATE INDEX IF NOT EXISTS idx_companion_notes_session ON companion_notes(session_id, kind, status);
    `);
    return this;
  }

  /**
   * 反思提炼的「没完的事」（阶段 C）：只在来源回合仍属于这个聊天、她仍是成员、来源她（群聊里是全体成员）
   * 都读得到、且披露范围没有限定到别的聊天时写入。id = noteIdOf('reflection', batchTag, index)。
   */
  acceptOpenLoop({ personId, sessionId, batchTag, index = 0, text, dueDate = null, sourceTurnIds = [], sensitive = false,
    policy = {}, confidence = null } = {}) {
    const room = this.getSession?.(sessionId);
    if (!batchTag || !room || room.archivedAt || !room.memberIds?.includes(personId)) return false;
    if (policy?.onlyConversationId && policy.onlyConversationId !== sessionId) return false;
    const isGroup = room.memberIds.length > 1;
    const readers = isGroup ? room.memberIds : [personId];
    const ids = [...new Set(sourceTurnIds.filter(Boolean).map(String))];
    if (!ids.length) return false;
    for (const turnId of ids) {
      const turn = this.getTurn(turnId);
      if (!turn || turn.sessionId !== sessionId || readers.some(id => this.canReadTurn(id, turn, { isGroup }) !== true)) return false;
    }
    const dueAt = dueDate ? localDateMs(dueDate) : null;
    if (dueDate && dueAt == null) return false;
    return this.create({ noteId: noteIdOf('reflection', batchTag, index), personId, sessionId, kind: 'open_loop', text,
      origin: 'reflection', sourceRefs: ids.map(id => `turn:${id}`), policy, sensitive,
      confidence: Number.isFinite(Number(confidence)) && confidence != null ? Number(confidence) : null, dueAt });
  }

  /**
   * 新建一条（INSERT OR IGNORE：同一确定性 id 重放不重复）。返回是否真的新增。
   * 超出上限时淘汰同一作用域里最早过期的：open 最多 12 条，待触发 followup 最多 3 条。
   */
  create({ noteId, personId, sessionId, kind, text, origin, sourceRefs = [], policy = {}, sensitive = false,
    confidence = null, dueAt = null, wakeCondition = null, expiresAt = null } = {}) {
    const body = clean(text, NOTE_LIMITS.textMax);
    if (!noteId || !personId || !sessionId || !NOTE_KINDS.includes(kind) || !body) return false;
    const createdAt = this.now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO companion_notes
      (note_id, person_id, session_id, kind, text, origin, source_refs_json, policy_json, sensitive, confidence,
       due_at, wake_condition, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(noteId, personId, sessionId, kind, body,
      String(origin || 'ambient'), JSON.stringify([...new Set(sourceRefs.map(String))].slice(0, 12)), JSON.stringify(policy || {}),
      sensitive ? 1 : 0, Number.isFinite(confidence) ? confidence : null, Number.isFinite(dueAt) ? dueAt : null,
      wakeCondition ? String(wakeCondition) : null, createdAt,
      Number.isFinite(expiresAt) ? expiresAt : this._defaultExpiry(kind, createdAt, dueAt));
    if (!result.changes) return false;
    if (kind === 'followup') this._evict(personId, sessionId, "kind = 'followup' AND status = 'open'", NOTE_LIMITS.pendingFollowups);
    this._evict(personId, sessionId, "status = 'open'", NOTE_LIMITS.openPerScope);
    return true;
  }

  /** 了结一条：只对 open / raised 生效，重复调用不再改变什么。返回是否改变。 */
  settle({ personId, sessionId, noteId, status }) {
    if (!['resolved', 'dropped'].includes(status)) return false;
    return this.db.prepare(`UPDATE companion_notes SET status = ? WHERE note_id = ? AND person_id = ? AND session_id = ? AND ${ACTIVE}`)
      .run(status, noteId, personId, sessionId).changes > 0;
  }

  /** 说出口时引用了这些 note：标为 raised、计数加一。 */
  markRaised({ personId, sessionId, noteIds = [] }) {
    const update = this.db.prepare(`UPDATE companion_notes SET status = 'raised', raised_count = raised_count + 1, raised_at = ?
      WHERE note_id = ? AND person_id = ? AND session_id = ? AND ${ACTIVE}`);
    const at = this.now();
    for (const noteId of new Set(noteIds)) update.run(at, noteId, personId, sessionId);
  }

  /** ambient 回合的暂存变更落库。调用方负责把它和可见回合放进同一个事务。 */
  applyStage(stage, { personId, sessionId }) {
    if (!stageHasChanges(stage)) return;
    for (const note of stage.creates) this.create({ ...note, personId, sessionId });
    // 到期的 followup 已经在这一轮给她看过：想过了就了结，不再反复叫醒。
    for (const noteId of stage.consumes) this.settle({ personId, sessionId, noteId, status: 'resolved' });
    for (const { noteId, status } of stage.settles) this.settle({ personId, sessionId, noteId, status });
    this.markRaised({ personId, sessionId, noteIds: stage.raises });
  }

  /**
   * 这一轮她能看到的心里话（已按过期、来源可读性与模式过滤），按创建时间排序，最多 12 条。
   * mode='ambient' 另外排除：敏感条目、提过 2 次或 24 小时内提过的 open loop、还没到期的 followup。
   * followup 到期 = 约定时间已过；或 afterCurrentTrack 绑定的那首已经不在放；或这次唤醒正是为它；
   * 或 nextListening 且这是一起听的开场。
   */
  listVisible({ personId, sessionId, isGroup = false, mode = 'ordinary', wake = null, currentQueueItemId = null } = {}) {
    const nowMs = this.now();
    this._expire(personId, sessionId, nowMs);
    const rows = this.db.prepare(`SELECT * FROM companion_notes WHERE person_id = ? AND session_id = ? AND ${ACTIVE}
      ORDER BY created_at, note_id`).all(String(personId || ''), String(sessionId || ''));
    const wakeNoteIds = new Set(Array.isArray(wake?.followupNoteIds) ? wake.followupNoteIds : []);
    return rows.map(row => this._map(row))
      .filter(note => this._sourcesReadable(personId, note, isGroup))
      .map(note => ({ ...note, due: note.kind !== 'followup' || this._followupDue(note, { nowMs, wake, wakeNoteIds, currentQueueItemId }) }))
      .filter(note => mode !== 'ambient' || (!note.sensitive && note.due && (note.kind !== 'open_loop'
        || (note.raisedCount < NOTE_LIMITS.raiseLimit && (note.raisedAt == null || nowMs - note.raisedAt >= NOTE_LIMITS.raiseGapMs)))))
      .slice(-NOTE_LIMITS.openPerScope);
  }

  /** 心跳只读：这个聊天里还在等的 followup（任一成员约的）。 */
  pendingFollowups(sessionId) {
    const nowMs = this.now();
    return this.db.prepare(`SELECT note_id, person_id, text, due_at, wake_condition FROM companion_notes
      WHERE session_id = ? AND kind = 'followup' AND status = 'open' AND expires_at > ? ORDER BY created_at LIMIT 12`)
      .all(String(sessionId || ''), nowMs)
      .map(row => ({ noteId: row.note_id, personId: row.person_id, about: row.text, dueAtMs: row.due_at,
        condition: row.wake_condition || null }));
  }

  /** 来源回合被撤回或忘记：引用它的 note 一律作废。 */
  dropBySourceTurns(turnIds = [], { personId } = {}) {
    const update = this.db.prepare(`UPDATE companion_notes SET status = 'dropped'
      WHERE person_id = ? AND ${ACTIVE} AND source_refs_json LIKE ?`);
    for (const turnId of new Set(turnIds.filter(Boolean))) update.run(String(personId || ''), `%${JSON.stringify(`turn:${turnId}`)}%`);
  }

  deleteSession(sessionId) {
    this.db.prepare('DELETE FROM companion_notes WHERE session_id = ?').run(String(sessionId || ''));
  }

  get(noteId) {
    const row = this.db.prepare('SELECT * FROM companion_notes WHERE note_id = ?').get(String(noteId || ''));
    return row ? this._map(row) : null;
  }

  _defaultExpiry(kind, createdAt, dueAt) {
    if (kind === 'thought') return createdAt + NOTE_LIMITS.thoughtMs;
    if (kind === 'followup') return createdAt + NOTE_LIMITS.followupMs;
    return Number.isFinite(dueAt) ? dueAt + 2 * NOTE_LIMITS.dayMs : createdAt + NOTE_LIMITS.undatedLoopMs;
  }

  _evict(personId, sessionId, where, keep) {
    const extra = this.db.prepare(`SELECT note_id FROM companion_notes WHERE person_id = ? AND session_id = ? AND ${where}
      ORDER BY expires_at DESC, created_at DESC, note_id DESC LIMIT -1 OFFSET ?`).all(personId, sessionId, keep);
    const update = this.db.prepare("UPDATE companion_notes SET status = 'expired' WHERE note_id = ?");
    for (const row of extra) update.run(row.note_id);
  }

  _expire(personId, sessionId, nowMs) {
    this.db.prepare(`UPDATE companion_notes SET status = 'expired' WHERE person_id = ? AND session_id = ? AND ${ACTIVE} AND expires_at <= ?`)
      .run(String(personId || ''), String(sessionId || ''), nowMs);
  }

  _sourcesReadable(personId, note, isGroup) {
    for (const ref of note.sourceRefs) {
      if (!ref.startsWith('turn:')) continue;
      const turn = this.getTurn(ref.slice('turn:'.length));
      if (!turn || this.canReadTurn(personId, turn, { isGroup }) !== true) return false;
    }
    return true;
  }

  _followupDue(note, { nowMs, wake, wakeNoteIds, currentQueueItemId }) {
    if (wakeNoteIds.has(note.noteId)) return true;
    if (Number.isFinite(note.dueAt)) return note.dueAt <= nowMs;
    const condition = String(note.wakeCondition || '');
    if (condition.startsWith('afterCurrentTrack:')) return condition.slice('afterCurrentTrack:'.length) !== String(currentQueueItemId || '');
    if (condition === 'nextListening') return wake?.reason === 'session_open';
    return false;
  }

  _map(row) {
    return {
      noteId: row.note_id, personId: row.person_id, sessionId: row.session_id, kind: row.kind, text: row.text,
      origin: row.origin, sourceRefs: parse(row.source_refs_json, []), policy: parse(row.policy_json, {}),
      sensitive: row.sensitive === 1, confidence: row.confidence, dueAt: row.due_at, wakeCondition: row.wake_condition,
      status: row.status, raisedCount: row.raised_count, raisedAt: row.raised_at, createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
}
