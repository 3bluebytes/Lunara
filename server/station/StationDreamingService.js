import { createHash } from 'node:crypto';
import { EventType, createEvent, StationAgentId } from './communication/messages.js';
import { parseEvidence } from '../memory/memoryPolicy.js';
import { revokeMemory } from '../memory/memoryProvenance.js';

const DAY = 86_400_000;
const sharedLanguage = text => /所有(?:的)?\s*(?:伙伴|人|聊天|会话)|全局|每(?:个|位)\s*(?:伙伴|人)|告诉其他|都可以知道/u.test(text);
const relationshipLanguage = text => /和你|跟你|咱俩|只跟|只和|与你|在你这|我们俩|你我之间|只告诉你|保密/u.test(text);
const feedbackLanguage = text => /喜欢|不喜欢|爱听|讨厌|偏好|更爱|最爱|favorite|prefer/iu.test(text);
const SHAREABLE_CLAIM_KEY = /^(?:music|taste|listening|recommendation|expression|narration|radio|song|track|artist|genre|mood|tempo|vocal|playlist|audio|voice)(?:[._:-]|$)/i;
const stripBookTitles = text => String(text || '').replace(/《[^》]*》/gu, '');
const nonShareableClaimText = text => /亲密|亲昵|肢体|性幻想|情欲|缠绵|调情|哄睡|侍寝|床第|欢好|抱抱|拥抱|亲吻|接吻|怜惜|放在对方梦里|关系性表达|开启对话|尚未表现出.*偏好/u.test(stripBookTitles(text));
const restrictedPolicy = policy => Boolean(policy?.disclosure === 'private' || policy?.sensitive === true || policy?.onlyConversationId || policy?.until);
const explicitShareIn = (quote, explicitQuote) => Boolean(explicitQuote && explicitQuote.length >= 4 && quote.includes(explicitQuote) && sharedLanguage(explicitQuote) && feedbackLanguage(explicitQuote));
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** 判断一条反思洞察是否满足自下而上的全局上报边界（非私密/敏感/限定，且为可共享的音乐电台偏好或明确共享原话）。 */
export function canReportToStation(evidence) {
  if (!evidence || typeof evidence !== 'object' || restrictedPolicy(evidence.policy)) return false;
  const claim = evidence.claim;
  if (!claim?.key || !claim.text || !['positive', 'negative'].includes(claim.polarity)) return false;
  const explicitQuote = String(claim.explicitSharedQuote || '');
  const hasExplicit = (evidence.originalEvidence || []).some(item => !restrictedPolicy(item?.policy)
    && explicitShareIn(String(item?.data?.userText || '').slice(0, 1200), String(item?.explicitSharedQuote ?? explicitQuote)));
  if (hasExplicit) return true;
  return claim.scope === 'shared_candidate' && SHAREABLE_CLAIM_KEY.test(claim.key) && !nonShareableClaimText(claim.text);
}

/** Durable promotion from verified original evidence, independent of notification delivery. */
export class StationDreamingService {
  constructor({ bus, stationMemoryService, now = Date.now, invalidate = () => {},
    minEvidence = 3, minDates = 2, minContexts = 2, ttlMs = 30 * DAY, capacity = 500 } = {}) {
    Object.assign(this, { bus, stationMemory: stationMemoryService, now, invalidate, minEvidence, minDates, minContexts, ttlMs, capacity });
  }

  initialize() {
    this.db = this.stationMemory.store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reflection_publications (
        memory_id INTEGER PRIMARY KEY, person_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS station_claims (
        id TEXT PRIMARY KEY, claim_key TEXT NOT NULL, polarity TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', memory_id INTEGER, revision INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS station_claim_evidence (
        claim_id TEXT NOT NULL, original_key TEXT NOT NULL, person_id TEXT NOT NULL,
        insight_id INTEGER NOT NULL, data_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(claim_id, original_key, person_id)
      );
      CREATE TABLE IF NOT EXISTS station_processed_insights (memory_id INTEGER PRIMARY KEY, processed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS station_promotion_receipts (
        promotion_key TEXT PRIMARY KEY, claim_id TEXT NOT NULL, memory_id INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS station_claim_revocations (claim_id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL);
      -- 反向 claim 按 claim_key 查（evaluate 每条 claim 都要查一次）。
      CREATE INDEX IF NOT EXISTS idx_station_claims_key ON station_claims(claim_key);
    `);
    // Keep old candidates for inspection, without treating their summed confidence as verified evidence.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'station_dream_candidates'").get()) {
      this.db.prepare(`INSERT OR IGNORE INTO station_claims (id, claim_key, polarity, content, status, first_seen_at, last_seen_at)
        SELECT 'legacy:' || id, 'legacy:' || id, 'positive', normalized_observation, 'unverified', first_seen_at, last_seen_at
        FROM station_dream_candidates ORDER BY last_seen_at DESC LIMIT ?`).run(this.capacity);
    }
    this.unsubscribe = this.bus?.subscribe(EventType.REFLECTION_INSIGHT_PUBLISHED, () => this.reconcile());
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), 60 * 60_000);
    this.timer.unref?.();
    return this;
  }

  shutdown() { this.unsubscribe?.(); clearInterval(this.timer); this.db = null; }

  reconcile() {
    if (!this.db) return;
    // The memory write can precede the publication record. Recover that gap from its durable provenance.
    for (const row of this.db.prepare(`SELECT id, namespace, evidence, created_at FROM memories
      WHERE tags LIKE '%reflection-insight%' AND created_at >= ?
        AND json_valid(evidence) = 1
        AND json_extract(evidence, '$.claim.key') IS NOT NULL
        AND COALESCE(json_extract(evidence, '$.policy.disclosure'), 'normal') <> 'private'
        AND COALESCE(json_extract(evidence, '$.policy.sensitive'), 0) <> 1
        AND NOT EXISTS (SELECT 1 FROM reflection_publications p WHERE p.memory_id = memories.id)
      ORDER BY id DESC LIMIT 200`).all(this.now() - this.ttlMs)) {
      const evidence = parseEvidence(row);
      if (!canReportToStation(evidence)) continue;
      this.db.prepare('INSERT OR IGNORE INTO reflection_publications VALUES (?, ?, ?, ?)')
        .run(row.id, evidence.originalEvidence?.[0]?.personId || row.namespace, JSON.stringify(evidence), row.created_at);
    }
    for (const row of this.db.prepare(`SELECT * FROM reflection_publications p
      WHERE NOT EXISTS (SELECT 1 FROM station_processed_insights s WHERE s.memory_id = p.memory_id)
      ORDER BY memory_id LIMIT 200`).all()) {
      this.db.transaction(() => {
        this.ingest(row);
        this.db.prepare('INSERT OR IGNORE INTO station_processed_insights VALUES (?, ?)').run(row.memory_id, this.now());
      })();
    }
    const changed = [];
    this.db.transaction(() => {
      // 洞察行已被删掉（过期清理、来源遗忘）的发布记录不再有用：它的证据已经进了 claim 证据表，
      // 发布记录本身是整份 evidence 的拷贝，不清就随反思次数无界增长。
      this.db.prepare('DELETE FROM reflection_publications WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = reflection_publications.memory_id)').run();
      this.db.prepare('DELETE FROM station_processed_insights WHERE NOT EXISTS (SELECT 1 FROM reflection_publications p WHERE p.memory_id = station_processed_insights.memory_id)').run();
      this.db.prepare('DELETE FROM station_claim_evidence WHERE created_at < ?').run(this.now() - this.ttlMs);
      for (const claim of this.db.prepare("SELECT * FROM station_claims WHERE status NOT IN ('revoked', 'unverified') ORDER BY last_seen_at DESC LIMIT ?").all(this.capacity)) {
        if (this.evaluate(claim)) changed.push(claim.id);
      }
      const excess = this.db.prepare("SELECT id FROM station_claims WHERE status IN ('pending', 'expired', 'unverified') ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?").all(this.capacity);
      for (const row of excess) {
        this.db.prepare('DELETE FROM station_claim_evidence WHERE claim_id = ?').run(row.id);
        this.db.prepare('DELETE FROM station_claims WHERE id = ?').run(row.id);
      }
    })();
    if (changed.length) this.notify(changed);
  }

  ingest(publication) {
    const payload = JSON.parse(publication.payload_json);
    if (!canReportToStation(payload)) return;
    const claim = payload.claim;
    const id = hash(`${claim.key}:${claim.polarity}`);
    // 合并过的洞察按时间追加原话证据：取最新的 10 条，较新的原话才能参与晋升。
    let sources = (payload.originalEvidence || []).slice(-10).filter(item => item.originalKey && item.namespace && item.createdAt >= this.now() - this.ttlMs);
    const explicitQuote = String(claim.explicitSharedQuote || '');
    const itemExplicit = (item, quote) => explicitShareIn(quote, String(item.explicitSharedQuote ?? explicitQuote));
    const revocation = this.db.prepare('SELECT revoked_at FROM station_claim_revocations WHERE claim_id = ?').get(id);
    if (revocation) {
      // 撤回之后只有用户在之后的回合里再次明确说「告诉大家…」才重新打开这条 claim；推断出来的证据不能让它复活。
      sources = sources.filter(item => item.createdAt > revocation.revoked_at);
      if (!sources.some(item => itemExplicit(item, String(item.data?.userText || '').slice(0, 1200)))) return;
      this.db.prepare('DELETE FROM station_claim_revocations WHERE claim_id = ?').run(id);
      this.db.prepare("UPDATE station_claims SET status = 'pending' WHERE id = ?").run(id);
    }
    const isRevokedSource = this.db.prepare('SELECT 1 FROM memory_revocations WHERE namespace IN (?, ?) AND source_key = ?');
    const prepared = [];
    for (const item of sources) {
      const quote = String(item.data?.userText || '').slice(0, 1200);
      const verifiedShared = itemExplicit(item, quote);
      const scope = item.claimScope || claim.scope;
      const policy = item.policy || {};
      const feedback = ['turn', 'feedback'].includes(item.kind) && feedbackLanguage(quote);
      const relationshipOnly = relationshipLanguage(quote) && !verifiedShared;
      if (restrictedPolicy(policy) || relationshipOnly || !feedback || !['turn', 'feedback'].includes(item.kind)) continue;
      if (!verifiedShared && (scope !== 'shared_candidate' || !SHAREABLE_CLAIM_KEY.test(claim.key) || nonShareableClaimText(claim.text))) continue;
      if (isRevokedSource.get(item.namespace, 'station', item.originalKey)) continue;
      prepared.push({ item, data: { namespace: item.namespace, sessionId: item.sessionId, scope, claimText: claim.text.slice(0, 300),
        policy, kind: item.kind, quote, explicitShared: verifiedShared, feedback, relationshipOnly } });
    }
    if (!prepared.length) return;
    this.db.prepare(`INSERT INTO station_claims (id, claim_key, polarity, content, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        content = CASE WHEN status = 'expired' THEN excluded.content ELSE content END,
        last_seen_at = excluded.last_seen_at`)
      .run(id, claim.key, claim.polarity, claim.text.slice(0, 300), this.now(), this.now());
    for (const { item, data } of prepared) {
      this.db.prepare('INSERT OR IGNORE INTO station_claim_evidence VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, item.originalKey, item.personId, publication.memory_id, JSON.stringify(data), item.createdAt);
    }
  }

  evidenceFor(id) {
    return this.db.prepare('SELECT * FROM station_claim_evidence WHERE claim_id = ? ORDER BY created_at DESC LIMIT 100').all(id)
      .map(row => ({ ...row, data: JSON.parse(row.data_json) }));
  }

  eligibleEvidence(claim) {
    return this.evidenceFor(claim.id).filter(row => {
      const data = row.data;
      if (restrictedPolicy(data.policy) || data.relationshipOnly || !data.feedback || !['turn', 'feedback'].includes(data.kind)) return false;
      if (!data.explicitShared && (data.scope !== 'shared_candidate'
        || !SHAREABLE_CLAIM_KEY.test(claim.claim_key)
        || nonShareableClaimText(data.claimText || claim.content))) return false;
      return !this.db.prepare('SELECT 1 FROM memory_revocations WHERE namespace IN (?, ?) AND source_key = ?')
        .get(data.namespace, 'station', row.original_key);
    });
  }

  evaluate(claim) {
    const originals = [...new Map(this.eligibleEvidence(claim).map(row => [row.original_key, row])).values()];
    const explicit = originals.some(row => row.data.explicitShared);
    const dates = new Set(originals.map(row => new Date(row.created_at).toISOString().slice(0, 10)));
    const contexts = new Set(originals.map(row => row.data.sessionId || row.person_id));
    // Repeated interactions with a single person cannot establish a universal taste by themselves.
    const people = new Set(originals.map(row => row.person_id));
    const opposing = this.db.prepare(`SELECT * FROM station_claims WHERE claim_key = ? AND polarity <> ?
      AND status NOT IN ('revoked', 'unverified', 'expired')`).all(claim.claim_key, claim.polarity)
      .flatMap(other => this.eligibleEvidence(other));
    const latestExplicit = rows => Math.max(0, ...rows.filter(row => row.data.explicitShared).map(row => row.created_at));
    // Conflicting observations remain reviewable. Only a later explicit shared correction resolves them.
    const conflict = opposing.length > 0 && (!explicit || latestExplicit(originals) <= latestExplicit(opposing));
    const enough = !conflict && (explicit || (originals.length >= this.minEvidence && dates.size >= this.minDates
      && contexts.size >= this.minContexts && people.size >= 2));
    if (!enough) {
      if (claim.memory_id && claim.status === 'promoted') {
        if (conflict) {
          const row = this.stationMemory.store.getById(claim.memory_id);
          if (row && !/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || '')) {
            this.stationMemory.store.update(row.id, {
              tags: `${row.tags ? row.tags + ',' : ''}superseded`,
              expiresAt: this.now() - 1,
            });
          }
        } else {
          revokeMemory(this.stationMemory.store, claim.memory_id, this.now());
        }
      }
      if (!originals.length) {
        if (!claim.memory_id) {
          this.db.prepare('DELETE FROM station_claim_evidence WHERE claim_id = ?').run(claim.id);
          this.db.prepare('DELETE FROM station_claims WHERE id = ?').run(claim.id);
          return true;
        }
        const wasActive = claim.status !== 'expired';
        this.db.prepare("UPDATE station_claims SET status = 'expired' WHERE id = ?").run(claim.id);
        return claim.status === 'promoted' || wasActive;
      }
      const status = claim.last_seen_at < this.now() - this.ttlMs ? 'expired' : 'pending';
      this.db.prepare('UPDATE station_claims SET status = ? WHERE id = ?').run(status, claim.id);
      return claim.status === 'promoted';
    }
    const existing = claim.memory_id && this.stationMemory.store.getById(claim.memory_id);
    if (claim.status === 'promoted' && existing && existing.expiresAt > this.now() && !String(existing.tags).includes('revoked')) return false;
    const content = [...originals].sort((a, b) => b.created_at - a.created_at).find(row => row.data.claimText)?.data.claimText
      || claim.content;
    if (content !== claim.content) this.db.prepare('UPDATE station_claims SET content = ? WHERE id = ?').run(content, claim.id);
    const revision = claim.memory_id ? claim.revision + 1 : claim.revision;
    const promotionKey = `${claim.id}:${revision}`;
    const saved = this.stationMemory.addMemory({ namespace: 'station', type: 'semantic',
      content, summary: explicit ? '用户明确共享的偏好' : '待验证的共享观察',
      source: explicit ? 'user_explicit_feedback' : 'station_seed',
      confidence: explicit ? 0.7 : 0.6, importance: explicit ? 7 : 5,
      expiresAt: this.now() + Math.min(this.ttlMs, 30 * DAY), tags: ['station_seed', explicit ? 'shared-explicit' : 'shared-hypothesis'],
      evidence: JSON.stringify({ promotionKey, claimId: claim.id, revision, claimKey: claim.claim_key, polarity: claim.polarity,
        inferred: !explicit, originalEvidence: originals.slice(0, 10).map(row => ({ originalKey: row.original_key,
          personId: row.person_id, sessionId: row.data.sessionId, createdAt: row.created_at, quote: row.data.quote.slice(0, 240) })) }),
    });
    if (!saved.ok) throw new Error('shared memory write failed');
    this.db.prepare('INSERT INTO station_promotion_receipts VALUES (?, ?, ?, ?)').run(promotionKey, claim.id, saved.id, this.now());
    this.db.prepare("UPDATE station_claims SET status = 'promoted', memory_id = ?, revision = ? WHERE id = ?").run(saved.id, revision, claim.id);
    return true;
  }

  revoke(claimId) {
    const row = this.db.prepare('SELECT * FROM station_claims WHERE id = ?').get(claimId);
    if (!row) return false;
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO station_claim_revocations VALUES (?, ?)').run(claimId, this.now());
      this.db.prepare("UPDATE station_claims SET status = 'revoked' WHERE id = ?").run(claimId);
      if (row.memory_id) revokeMemory(this.stationMemory.store, row.memory_id, this.now());
      this.db.prepare('DELETE FROM station_claim_evidence WHERE claim_id = ?').run(claimId);
    })();
    this.notify([claimId]);
    return true;
  }

  notify(claimIds) {
    this.invalidate();
    this.bus?.publishEvent(createEvent({ type: EventType.STATION_MEMORY_UPDATED, sourceAgentId: StationAgentId,
      payload: { cause: 'dreaming', claimIds } }));
  }

  candidatePool() {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM station_claims ORDER BY last_seen_at DESC LIMIT ?').all(this.capacity)
      .map(row => ({ ...row, evidence: (row.status === 'unverified' ? this.evidenceFor(row.id) : this.eligibleEvidence(row))
        .map(item => ({ originalKey: item.original_key, personId: item.person_id, sessionId: item.data.sessionId,
          at: item.created_at, quote: item.data.quote.slice(0, 240), scope: item.data.scope })) }));
  }
}
