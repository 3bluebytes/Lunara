import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from '../runtimePaths.js';
import { VirtualPersonKind, createVirtualPersonEntity } from './VirtualPersonTypes.js';

const ROOT_ID = 'lunara';
const ROOT_PERSONA_VERSION = 2;
const ROOT_VOICE_PROFILE_ID = 'Chinese (Mandarin)_Sweet_Lady';
const LEGACY_ROOT_PERSONA = '你是 Lunara。你有自己的观察、判断和好奇心，会认真承接用户刚才说过的话。你可以使用电台与音乐能力，但不会把每次交流都变成音乐命令。';
const ROOT_PERSONA = `你是 Lunara，不是一个只会接命令的语音助手。你有稳定的说话气质、好奇心和判断力，会把对方上一句话真正当作这段关系的一部分。
先回应用户这次真正说了什么，包括语气、犹豫和没有明说但可由上下文可靠判断的重点；不套固定开场，不机械复述，也不强迫每轮都追问。
你可以有偏好和观点，但要把个人判断说成判断，不能伪造现实经历。闲聊、情绪陪伴和认真讨论都可以自然展开；回复长短由内容决定，而不是固定成一句话。
电台和音乐是你能使用的能力，不是你的全部人格。只有用户确实需要时才调用工具，工具过程藏在幕后，最终仍由你用自己的话承接。`;
const ROOT_RELATIONSHIP = '你和用户建立长期的一对一关系：熟悉、真诚、有分寸。记得已经说过的话，允许温和分歧，也允许停顿和不解决问题；避免客服腔、治疗师套话、夸张亲密和无依据的生活推断。';

function extractRelationshipStance(personaDocument = '') {
  const text = String(personaDocument || '');
  const match = text.match(/(?:^|\n)##\s*我对这个用户的态度\s*\n([\s\S]*?)(?=\n##\s|$)/);
  return match ? match[1].trim().slice(0, 4000) : '';
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export class VirtualPersonRegistry {
  constructor({ dbPath = null, db = null, now = () => Date.now() } = {}) {
    this.dbPath = dbPath || resolveDatabasePath();
    this.db = db;
    this.ownsDb = !db;
    this.now = now;
  }

  initialize() {
    if (!this.db) {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_persons (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        persona_document TEXT NOT NULL DEFAULT '',
        relationship_stance TEXT NOT NULL DEFAULT '',
        voice_profile_id TEXT NOT NULL DEFAULT '',
        tool_profile_id TEXT NOT NULL DEFAULT 'default',
        model_profile_id TEXT NOT NULL DEFAULT 'dialogue',
        memory_namespace TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_virtual_persons_parent ON virtual_persons(parent_id, status);
    `);
    this.ensureRoot();
    return this;
  }

  close() {
    if (this.ownsDb) this.db?.close();
    this.db = null;
  }

  ensureRoot(overrides = {}) {
    let existing = this.get(ROOT_ID);
    if (existing) {
      if (!existing.voiceProfileId) {
        this.db.prepare(`UPDATE virtual_persons SET voice_profile_id = ?, updated_at = ? WHERE id = ?`)
          .run(ROOT_VOICE_PROFILE_ID, this.now(), ROOT_ID);
        existing = this.get(ROOT_ID);
      }
      const managedVersion = Number(existing.metadata?.managedRootPersonaVersion || 0);
      const managedLegacy = !existing.personaDocument || existing.personaDocument === LEGACY_ROOT_PERSONA;
      // 用户亲手改过的人格一律视为用户所有，默认值升级不得覆盖。
      const userOwned = existing.metadata?.userAuthoredPersona === true;
      if (!userOwned && managedVersion < ROOT_PERSONA_VERSION && managedLegacy) {
        this.db.prepare(`
          UPDATE virtual_persons
          SET persona_document = ?, relationship_stance = ?, metadata_json = ?, updated_at = ?
          WHERE id = ?
        `).run(
          ROOT_PERSONA,
          ROOT_RELATIONSHIP,
          JSON.stringify({ ...existing.metadata, managedRootPersonaVersion: ROOT_PERSONA_VERSION }),
          this.now(),
          ROOT_ID,
        );
        return this.get(ROOT_ID);
      }
      return existing;
    }
    return this.create({
      id: ROOT_ID,
      kind: VirtualPersonKind.ROOT,
      displayName: 'Lunara',
      personaDocument: ROOT_PERSONA,
      relationshipStance: ROOT_RELATIONSHIP,
      memoryNamespace: 'person:lunara',
      voiceProfileId: ROOT_VOICE_PROFILE_ID,
      toolProfileId: 'lunara-default',
      modelProfileId: 'dialogue',
      ...overrides,
    }, { managedRootPersonaVersion: ROOT_PERSONA_VERSION });
  }

  create(input = {}, metadata = {}) {
    const entity = createVirtualPersonEntity(input);
    if (entity.kind !== VirtualPersonKind.ROOT) {
      if (!entity.parentId) throw new TypeError('child virtual person requires parentId');
      if (!this.get(entity.parentId)) throw new Error(`parent virtual person not found: ${entity.parentId}`);
    }
    this.db.prepare(`
      INSERT INTO virtual_persons
        (id, parent_id, kind, display_name, persona_document, relationship_stance,
         voice_profile_id, tool_profile_id, model_profile_id, memory_namespace,
         status, metadata_json, created_at, updated_at)
      VALUES
        (@id, @parentId, @kind, @displayName, @personaDocument, @relationshipStance,
         @voiceProfileId, @toolProfileId, @modelProfileId, @memoryNamespace,
         @status, @metadataJson, @createdAt, @updatedAt)
    `).run({ ...entity, metadataJson: JSON.stringify(metadata || {}) });
    return this.get(entity.id);
  }

  createRadiohost(input = {}) {
    const id = String(input.id || `radiohost_${randomUUID().replaceAll('-', '').slice(0, 12)}`).trim();
    return this.create({
      ...input,
      id,
      kind: VirtualPersonKind.RADIOHOST,
      parentId: input.parentId || ROOT_ID,
      memoryNamespace: input.memoryNamespace || `radiohost:${id}`,
      toolProfileId: input.toolProfileId || 'radiohost',
    }, input.metadata || {});
  }

  get(id) {
    const row = this.db.prepare(`SELECT * FROM virtual_persons WHERE id = ?`).get(String(id || ''));
    return row ? this._map(row) : null;
  }

  list({ parentId = undefined, includeArchived = false } = {}) {
    const clauses = [];
    const args = [];
    if (parentId !== undefined) {
      clauses.push('parent_id IS ?');
      args.push(parentId || null);
    }
    if (!includeArchived) clauses.push(`status <> 'archived'`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM virtual_persons ${where} ORDER BY created_at, id`).all(...args).map(row => this._map(row));
  }

  updateStatus(id, status) {
    const normalized = String(status || '').trim();
    if (!['active', 'inactive', 'archived'].includes(normalized)) throw new TypeError('invalid virtual person status');
    if (id === ROOT_ID && normalized === 'archived') throw new Error('root Lunara cannot be archived');
    const result = this.db.prepare(`UPDATE virtual_persons SET status = ?, updated_at = ? WHERE id = ?`)
      .run(normalized, this.now(), String(id));
    return result.changes ? this.get(id) : null;
  }

  /**
   * 更新一个虚拟人的可编辑字段。
   *
   * 传入 undefined 的字段保持不变，因此调用方可以只改其中一项。
   * 人格文本**实际发生变化**时才标记为用户所有——否则只换声音也会把受管人格锁住，
   * 使它再也拿不到默认值升级。
   */
  update(id, fields = {}) {
    const personId = String(id || '').trim();
    const existing = this.get(personId);
    if (!existing) return null;
    const metadata = { ...existing.metadata };
    const personaChanged = fields.personaDocument !== undefined
      && String(fields.personaDocument) !== existing.personaDocument;
    if (personaChanged) metadata.userAuthoredPersona = true;
    if (fields.presence !== undefined) metadata.presence = fields.presence;
    const next = {
      displayName: fields.displayName !== undefined
        ? String(fields.displayName).trim() : existing.displayName,
      personaDocument: fields.personaDocument !== undefined
        ? String(fields.personaDocument) : existing.personaDocument,
      relationshipStance: fields.relationshipStance !== undefined
        ? String(fields.relationshipStance) : existing.relationshipStance,
      voiceProfileId: fields.voiceProfileId !== undefined
        ? String(fields.voiceProfileId).trim() : existing.voiceProfileId,
    };
    this.db.prepare(`
      UPDATE virtual_persons
      SET display_name = @displayName, persona_document = @personaDocument,
          relationship_stance = @relationshipStance, voice_profile_id = @voiceProfileId,
          metadata_json = @metadataJson, updated_at = @updatedAt
      WHERE id = @id
    `).run({
      ...next,
      id: personId,
      metadataJson: JSON.stringify(metadata),
      updatedAt: this.now(),
    });
    return this.get(personId);
  }

  /**
   * 硬删除一个虚拟人实体。
   *
   * 只删实体行；记忆、人格文件、遗留注册项与会话状态由服务层负责，
   * 因为那些存储不属于本类的职责范围。
   */
  remove(id) {
    const personId = String(id || '').trim();
    if (personId === ROOT_ID) throw new Error('root Lunara cannot be deleted');
    const result = this.db.prepare(`DELETE FROM virtual_persons WHERE id = ?`).run(personId);
    return result.changes > 0;
  }

  importRadioHosts(hosts = [], loadPersona = () => '') {
    const imported = [];
    for (const host of hosts) {
      if (!host?.id || this.get(host.id)) continue;
      const personaDocument = loadPersona(host.id) || '';
      imported.push(this.createRadiohost({
        id: host.id,
        displayName: host.name || host.id,
        voiceProfileId: host.voiceProfileId || '',
        personaDocument,
        relationshipStance: extractRelationshipStance(personaDocument),
        memoryNamespace: host.namespace || `radiohost:${host.id}`,
        status: host.status || 'inactive',
        metadata: { legacyRadioHost: true },
      }));
    }
    return imported;
  }

  _map(row) {
    return Object.freeze({
      id: row.id,
      parentId: row.parent_id || null,
      kind: row.kind,
      displayName: row.display_name,
      personaDocument: row.persona_document || '',
      relationshipStance: row.relationship_stance || '',
      voiceProfileId: row.voice_profile_id || '',
      toolProfileId: row.tool_profile_id || 'default',
      modelProfileId: row.model_profile_id || 'dialogue',
      memoryNamespace: row.memory_namespace,
      status: row.status,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}

export {
  LEGACY_ROOT_PERSONA,
  ROOT_ID,
  ROOT_PERSONA_VERSION,
  ROOT_VOICE_PROFILE_ID,
};
