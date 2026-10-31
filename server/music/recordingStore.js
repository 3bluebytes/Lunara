// recordingStore.js — 跨源「录音身份」层。
//
// 现状只有一层身份：`(provider, songId)`。它其实是**供给身份**（哪个源的哪条资源），
// 却被同时当成作品身份在用，于是同一首歌会变成好几份：曲目列表出现两行、
// song_tags 各打一次标（双倍模型费用）、节目去重按 provider 失效、偏好被拆散。
//
// 这一层补上缺失的中间层：
//
//   Recording（录音：这首歌）            ← 本模块
//    └ (provider, songId)（供给：哪个源的哪条资源）
//
// 三条不可让步的规则：
//
// 1. **1:1 fallback**：没有等价关系时，一首歌的 recording 就是它自己，且**不写任何行**。
//    未合并场景的行为与之前逐字一致，零迁移、零回归。
// 2. **只有用户确认与 ISRC 能落库**。指纹与元数据相似度只能生成提议（见
//    `link` 的 kind 白名单）——错误的合并（现场版与录音室版并成一首）不可发现，
//    而漏并只是列表多一行。错误方向不对称，所以默认不合并。
// 3. **供给身份仍然是唯一可播放的东西**。本模块不保存 URL、不碰音频资产、
//    不碰账号归属；它只回答「这两条资源是不是同一首歌」。
//
// 撤销保留凭据：`equivalence_decision.revoked_at` + 一条 `unlink` 审计行，
// 这样「谁在什么时候说它们是同一首、谁又撤回了」永远查得到。

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from '../runtimePaths.js';

/** 唯一能建立等价关系的两种证据。指纹与相似度不在此列，它们是提议。 */
export const EQUIVALENCE_KINDS = Object.freeze(['user-confirmed', 'isrc']);

const SELF_PREFIX = 'self:';

function normalizeProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (!provider) throw new TypeError('recording identity requires provider');
  return provider;
}

function normalizeSongId(value) {
  const songId = String(value ?? '').trim();
  if (!songId) throw new TypeError('recording identity requires songId');
  return songId;
}

function selfRecordingId(provider, songId) {
  return `${SELF_PREFIX}${provider}:${songId}`;
}

function identityOf(value) {
  const provider = normalizeProvider(value?.provider);
  const songId = normalizeSongId(value?.songId ?? value?.song_id);
  return { provider, songId };
}

function member(row) {
  return row ? { provider: row.provider, songId: row.song_id } : null;
}

export class RecordingStore {
  constructor({ dbPath = null, now = () => Date.now() } = {}) {
    this.db = null;
    this.dbPath = dbPath;
    this.now = now;
    this._stmts = {};
  }

  initialize() {
    const dbPath = this.dbPath || resolveDatabasePath();
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recording (
        recording_id             TEXT PRIMARY KEY,
        representative_provider  TEXT,
        representative_song_id   TEXT,
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recording_member (
        provider     TEXT NOT NULL,
        song_id      TEXT NOT NULL,
        recording_id TEXT NOT NULL,
        added_at     INTEGER NOT NULL,
        PRIMARY KEY (provider, song_id)
      );

      CREATE TABLE IF NOT EXISTS equivalence_decision (
        decision_id  INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id TEXT NOT NULL,
        kind         TEXT NOT NULL,
        evidence     TEXT,
        decided_by   TEXT,
        confidence   REAL,
        created_at   INTEGER NOT NULL,
        revoked_at   INTEGER
      );

      -- 代表源的切换只记事实（谁换到谁、为什么），不参与等价判定。
      CREATE TABLE IF NOT EXISTS recording_representative_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        recording_id TEXT NOT NULL,
        from_provider TEXT, from_song_id TEXT,
        to_provider   TEXT NOT NULL, to_song_id TEXT NOT NULL,
        reason      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recording_member_recording ON recording_member(recording_id);
      CREATE INDEX IF NOT EXISTS idx_representative_log_recording ON recording_representative_log(recording_id);
      CREATE INDEX IF NOT EXISTS idx_equivalence_decision_recording ON equivalence_decision(recording_id);
    `);
    this._prepare();
    return this;
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
    this._stmts = {};
  }

  _prepare() {
    this._stmts = {
      memberOf: this.db.prepare('SELECT provider, song_id, recording_id FROM recording_member WHERE provider = ? AND song_id = ?'),
      memberRecording: this.db.prepare('SELECT r.representative_provider, r.representative_song_id FROM recording r WHERE r.recording_id = ?'),
      membersOf: this.db.prepare('SELECT provider, song_id FROM recording_member WHERE recording_id = ? ORDER BY added_at, provider'),
      recording: this.db.prepare('SELECT * FROM recording WHERE recording_id = ?'),
      insertRecording: this.db.prepare('INSERT INTO recording (recording_id, representative_provider, representative_song_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
      deleteRecording: this.db.prepare('DELETE FROM recording WHERE recording_id = ?'),
      insertMember: this.db.prepare('INSERT OR REPLACE INTO recording_member (provider, song_id, recording_id, added_at) VALUES (?, ?, ?, ?)'),
      deleteMember: this.db.prepare('DELETE FROM recording_member WHERE provider = ? AND song_id = ?'),
      moveMembers: this.db.prepare('UPDATE recording_member SET recording_id = ? WHERE recording_id = ?'),
      setRepresentative: this.db.prepare('UPDATE recording SET representative_provider = ?, representative_song_id = ?, updated_at = ? WHERE recording_id = ?'),
      touchRecording: this.db.prepare('UPDATE recording SET updated_at = ? WHERE recording_id = ?'),
      insertDecision: this.db.prepare('INSERT INTO equivalence_decision (recording_id, kind, evidence, decided_by, confidence, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)'),
      decisions: this.db.prepare('SELECT * FROM equivalence_decision WHERE recording_id = ? ORDER BY decision_id'),
      repointDecisions: this.db.prepare('UPDATE equivalence_decision SET recording_id = ? WHERE recording_id = ?'),
      revokeDecisions: this.db.prepare('UPDATE equivalence_decision SET revoked_at = ? WHERE recording_id = ? AND revoked_at IS NULL'),
      counts: this.db.prepare('SELECT (SELECT COUNT(*) FROM recording) AS recordings, (SELECT COUNT(*) FROM recording_member) AS members'),
      insertRepresentativeLog: this.db.prepare('INSERT INTO recording_representative_log (recording_id, from_provider, from_song_id, to_provider, to_song_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      representativeLog: this.db.prepare('SELECT * FROM recording_representative_log WHERE recording_id = ? ORDER BY id'),
    };
  }

  /**
   * 批量判断：这些供给身份里哪些已经并入了某个录音（有 recording_member 行）。
   * 只返回 songId 集合，供标签批量读取决定哪些走单条的录音级读取。
   */
  memberSongIds(provider, songIds = []) {
    const normalized = normalizeProvider(provider);
    const ids = [...new Set((songIds || []).map(id => String(id ?? '').trim()).filter(Boolean))];
    const found = new Set();
    for (let start = 0; start < ids.length; start += 400) {
      const chunk = ids.slice(start, start + 400);
      const rows = this.db.prepare(`SELECT song_id FROM recording_member WHERE provider = ? AND song_id IN (${chunk.map(() => '?').join(',')})`)
        .all(normalized, ...chunk);
      for (const row of rows) found.add(String(row.song_id));
    }
    return found;
  }

  /**
   * 一首歌属于哪个录音。没有等价关系时返回自我身份，且不落任何行。
   */
  recordingOf(provider, songId) {
    const id = identityOf({ provider, songId });
    const row = this._stmts.memberOf.get(id.provider, id.songId);
    if (!row) {
      return {
        recordingId: selfRecordingId(id.provider, id.songId),
        isSelf: true,
        members: id,
        representative: null,
      };
    }
    const recordRow = this._stmts.memberRecording.get(row.recording_id);
    return {
      recordingId: row.recording_id,
      isSelf: false,
      members: { provider: row.provider, songId: row.song_id },
      // 展示与点播应当落在同一个源上，否则「我的歌」会随展示时机变来变去。
      representative: recordRow?.representative_provider
        ? { provider: recordRow.representative_provider, songId: recordRow.representative_song_id }
        : null,
    };
  }

  membersOf(recordingId) {
    const key = String(recordingId ?? '').trim();
    if (!key || key.startsWith(SELF_PREFIX)) return [];
    return this._stmts.membersOf.all(key).map(member);
  }

  representativeOf(recordingId) {
    const key = String(recordingId ?? '').trim();
    if (!key || key.startsWith(SELF_PREFIX)) return null;
    const row = this._stmts.recording.get(key);
    if (!row?.representative_provider) return null;
    return { provider: row.representative_provider, songId: row.representative_song_id };
  }

  /** 代表源粘性：只有明确要求才改，合并与展示都不动它。 */
  setRepresentative({ recordingId, provider, songId, reason = 'explicit', from = null } = {}) {
    const key = String(recordingId ?? '').trim();
    if (!key || key.startsWith(SELF_PREFIX)) return { ok: false, reason: 'not-a-recording' };
    const id = identityOf({ provider, songId });
    if (this._stmts.memberOf.get(id.provider, id.songId)?.recording_id !== key) {
      return { ok: false, reason: 'not-a-member' };
    }
    const previous = this.representativeOf(key);
    this.db.transaction(() => {
      this._stmts.setRepresentative.run(id.provider, id.songId, this.now(), key);
      this._stmts.insertRepresentativeLog.run(key, previous?.provider ?? null, previous?.songId ?? null,
        id.provider, id.songId, String(reason).slice(0, 48), this.now());
    })();
    void from;
    return { ok: true, previous };
  }

  /**
   * 记录「这首歌真的以某个源播出来了」。
   *
   * 代表源是**粘性**的：第一次播出决定它；之后再从另一个成员播出来，只留一条漂移
   * 观察，不自动改代表源——否则用户今天在网易云点了同一首歌，明天「我的歌」就换源了，
   * 这比重复更伤。真正的切换必须带原因（该源不可播 / 用户明确要求），走
   * `setRepresentative({ reason })`。
   */
  notePlayback({ provider, songId } = {}) {
    const identity = this.recordingOf(provider, songId);
    if (!identity || identity.isSelf) return { ok: false, reason: 'not-merged' };
    const member = identityOf({ provider, songId });
    const current = this.representativeOf(identity.recordingId);
    if (!current) {
      this.setRepresentative({ recordingId: identity.recordingId, provider: member.provider,
        songId: member.songId, reason: 'first-playback' });
      return { ok: true, changed: true, reason: 'first-playback' };
    }
    if (current.provider === member.provider && current.songId === member.songId) {
      return { ok: true, changed: false, reason: 'representative-played' };
    }
    this._stmts.insertRepresentativeLog.run(identity.recordingId, current.provider, current.songId,
      member.provider, member.songId, 'played-other-member', this.now());
    return { ok: true, changed: false, reason: 'played-other-member' };
  }

  /** 代表源的切换事实（不含任何原文）：谁换到谁、为什么。 */
  representativeHistory(recordingId) {
    const key = String(recordingId ?? '').trim();
    if (!key || key.startsWith(SELF_PREFIX)) return [];
    return this._stmts.representativeLog.all(key).map(row => ({
      recordingId: row.recording_id,
      from: row.from_provider ? { provider: row.from_provider, songId: row.from_song_id } : null,
      to: { provider: row.to_provider, songId: row.to_song_id },
      reason: row.reason,
      at: row.created_at,
    }));
  }

  /**
   * 建立等价关系。kind 只能取 EQUIVALENCE_KINDS —— 指纹与相似度是**提议**，
   * 不是结论；把它们写成结论的代价（错并不可发现）远大于漏并。
   */
  link({ a, b, kind, evidence = null, decidedBy = null, confidence = null } = {}) {
    const kindValue = String(kind ?? '').trim();
    if (!EQUIVALENCE_KINDS.includes(kindValue)) {
      throw new TypeError(`recording link requires kind ∈ ${EQUIVALENCE_KINDS.join(' | ')}, got "${kindValue}"`);
    }
    const left = identityOf(a);
    const right = identityOf(b);
    const at = this.now();
    const transaction = this.db.transaction(() => {
      const leftHold = this._stmts.memberOf.get(left.provider, left.songId);
      const rightHold = this._stmts.memberOf.get(right.provider, right.songId);

      // 同一组（或同一身份）：幂等，不制造重复成员，也不重复记录决定。
      if (leftHold && rightHold && leftHold.recording_id === rightHold.recording_id) {
        return { ok: true, recordingId: leftHold.recording_id, created: false, merged: false };
      }
      if (!leftHold && !rightHold && left.provider === right.provider && left.songId === right.songId) {
        return { ok: true, recordingId: selfRecordingId(left.provider, left.songId), created: false, merged: false };
      }

      let recordingId;
      let created = false;
      let merged = false;

      if (leftHold && !rightHold) {
        recordingId = leftHold.recording_id;
      } else if (!leftHold && rightHold) {
        recordingId = rightHold.recording_id;
      } else if (leftHold && rightHold) {
        // 两组合并：保留先建立的一组（它的代表源已经在用），把另一组的成员与决定搬过来。
        recordingId = leftHold.recording_id;
        const absorbed = rightHold.recording_id;
        if (absorbed !== recordingId) {
          this._stmts.moveMembers.run(recordingId, absorbed);
          this._stmts.repointDecisions.run(recordingId, absorbed);
          this._stmts.deleteRecording.run(absorbed);
          merged = true;
        }
      } else {
        recordingId = `rec:${randomUUID()}`;
        this._stmts.insertRecording.run(recordingId, left.provider, left.songId, at, at);
        created = true;
      }

      this._stmts.insertMember.run(left.provider, left.songId, recordingId, at);
      this._stmts.insertMember.run(right.provider, right.songId, recordingId, at);
      this._stmts.insertDecision.run(
        recordingId, kindValue,
        evidence == null ? null : JSON.stringify(evidence),
        decidedBy == null ? null : String(decidedBy),
        Number.isFinite(Number(confidence)) ? Number(confidence) : null,
        at,
      );
      this._stmts.touchRecording.run(at, recordingId);
      return { ok: true, recordingId, created, merged };
    });
    return transaction();
  }

  /**
   * 撤销一条成员资格。成员只剩一个时整组解散（回到各自独立）。
   * 已生成的标签不在这里处理：标签归属由 song_tags 的读路径决定，撤销不得丢数据。
   */
  unlink({ recordingId, provider, songId, decidedBy = null } = {}) {
    const key = String(recordingId ?? '').trim();
    if (!key || key.startsWith(SELF_PREFIX)) return { ok: false, reason: 'not-a-recording' };
    const id = identityOf({ provider, songId });
    const at = this.now();
    const transaction = this.db.transaction(() => {
      const hold = this._stmts.memberOf.get(id.provider, id.songId);
      if (!hold || hold.recording_id !== key) return { ok: false, reason: 'not-a-member' };
      this._stmts.deleteMember.run(id.provider, id.songId);
      this._stmts.revokeDecisions.run(at, key);
      this._stmts.insertDecision.run(key, 'unlink', JSON.stringify({ provider: id.provider, songId: id.songId }),
        decidedBy == null ? null : String(decidedBy), null, at);

      const rest = this._stmts.membersOf.all(key);
      if (rest.length < 2) {
        for (const row of rest) this._stmts.deleteMember.run(row.provider, row.song_id);
        this._stmts.deleteRecording.run(key);
        return { ok: true, dissolved: true };
      }
      const representative = this._stmts.recording.get(key);
      if (representative?.representative_provider === id.provider
        && representative?.representative_song_id === id.songId) {
        const next = rest[0];
        this._stmts.setRepresentative.run(next.provider, next.song_id, at, key);
      }
      this._stmts.touchRecording.run(at, key);
      return { ok: true, dissolved: false };
    });
    return transaction();
  }

  /** 审计：谁在什么时候说了什么，以及有没有被撤回。evidence 已解析成对象。 */
  decisions(recordingId) {
    const key = String(recordingId ?? '').trim();
    if (!key) return [];
    return this._stmts.decisions.all(key).map(row => ({
      decisionId: row.decision_id,
      recordingId: row.recording_id,
      kind: row.kind,
      evidence: parseEvidence(row.evidence),
      decidedBy: row.decided_by,
      confidence: row.confidence,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    }));
  }

  /** 仅供本地整理界面的只读投影；不修改队列或供给身份。 */
  groups() {
    return this.db.prepare('SELECT * FROM recording ORDER BY created_at, recording_id').all().map(row => ({
      recordingId: row.recording_id,
      members: this.membersOf(row.recording_id),
      representative: this.representativeOf(row.recording_id),
    }));
  }

  /** 调用方在同一 SQLite 事务内先保留标签，再解散该组。审计行永远保留。 */
  dissolve({ recordingId, evidence = null } = {}) {
    return this.db.transaction(() => {
      if (!this._stmts.recording.get(recordingId)) return { ok: false, reason: 'not-a-recording' };
      this._stmts.revokeDecisions.run(this.now(), recordingId);
      this.db.prepare('DELETE FROM recording_member WHERE recording_id = ?').run(recordingId);
      this._stmts.deleteRecording.run(recordingId);
      this._stmts.insertDecision.run(recordingId, 'unlink', JSON.stringify(evidence), 'listener', null, this.now());
      return { ok: true };
    })();
  }

  stats() {
    const row = this._stmts.counts.get();
    return { recordings: row?.recordings || 0, members: row?.members || 0 };
  }
}

function parseEvidence(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

let singleton = null;

export function getRecordingStore() {
  if (!singleton) singleton = new RecordingStore().initialize();
  return singleton;
}

/** 测试与迁移用：丢掉进程内单例，让下一次 getRecordingStore() 重新打开。 */
export function resetRecordingStore() {
  if (singleton) singleton.close();
  singleton = null;
}
