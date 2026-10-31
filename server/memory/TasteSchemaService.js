// TasteSchemaService.js — per-person taste schema distillation (add-taste-learning-loop P2)
//
// 反思洞察、显式记忆与播放统计账本是一个人味觉的散点证据；这里是把它们蒸馏成
// 单条可注入 prompt 的「口味图式」semantic 记忆行的地方。图式是推断不是原话，
// 用户显式陈述永远优先；被撤销的图式不得被重建。
//
// 数据流：insights + explicit + song_stats (+ 旧 taste.md 迁移) → LLM 蒸馏
// （失败/关闭时规则版兜底）→ 每 namespace 一条 tags=taste-schema 的 semantic 行。

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePackageRoot } from '../runtimePaths.js';
import * as llm from '../llm.js';
import { MemoryType, MemorySource } from './types.js';
import { writeMemoryWithEncoding } from './writeMemoryWithEncoding.js';
import { isMemoryRevoked } from './memoryProvenance.js';
import { memoryApplies } from './memoryPolicy.js';

const DAY = 24 * 60 * 60 * 1000;
const SCHEMA_TAG = 'taste-schema';
const CONTENT_LIMIT = 2000;
const OUTCOME_LABELS = { completed: '完整听完', partial: '中途离开', skipped: '跳过', banned: '拉黑', technical_failure: '技术失败' };

/** Same person→(service, namespace) resolution ReflectionAgent uses; station-mediated, never direct. */
export async function stationMemoryTarget(station, id) {
  if (!station) return null;
  const registry = station.virtualPersonRegistry;
  const entity = registry?.db ? registry.get(id) : null;
  const service = id === 'lunara' ? station.stationMemory : await station.getRadioHostMemoryService?.(id);
  const namespace = entity?.memoryNamespace || (id === 'lunara' ? 'person:lunara' : service?.namespace);
  return service && namespace ? { service, namespace } : null;
}

export function stationPersonIds(station) {
  const ids = ['lunara', ...(station?.listRadioHosts?.() || []).map(host => host.id)];
  return [...new Set(ids)];
}

export async function collectStationTasteSchemas(station) {
  if (!station) return [];
  const out = [];
  for (const id of stationPersonIds(station)) {
    const target = await stationMemoryTarget(station, id);
    if (!target) continue;
    const row = new TasteSchemaService({ memoryTarget: async () => target }).schemaRow(target.service, target.namespace);
    if (!row) continue;
    let revision = 0;
    try { revision = Number(JSON.parse(row.evidence || '{}')?.revision) || 0; } catch { /* revision unknown */ }
    out.push({ personId: id, memoryId: row.id, content: row.content, confidence: row.confidence,
      revision, updatedAt: row.updatedAt, source: 'db-schema' });
  }
  return out;
}

export class TasteSchemaService {
  constructor({
    memoryTarget,
    getSongStats = null,
    readLegacyFiles = null,
    llm: llmModule = llm,
    promptPath = resolve(resolvePackageRoot(), 'prompts', 'taste-schema.md'),
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.memoryTarget = memoryTarget;
    this.getSongStats = getSongStats;
    this.readLegacyFiles = readLegacyFiles;
    this.llm = llmModule;
    this.promptPath = promptPath;
    this.now = now;
    this.logger = logger;
  }

  schemaRow(service, namespace) {
    return service.searchMemory(undefined, { namespace, type: MemoryType.SEMANTIC, tags: SCHEMA_TAG, limit: 5 })
      .filter(row => !/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || ''))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  }

  async distill(personId, { manual = false, signal } = {}) {
    const target = await this.memoryTarget(personId);
    if (!target?.service || !target?.namespace) return { ok: false, code: 'MEMORY_UNAVAILABLE' };
    const { service, namespace } = target;
    // A revoked schema stays revoked. The tombstone — not the search index — is the
    // source of truth: revokeMemory expires the row, which hides it from search.
    const db = service.store.db;
    const hasRevocations = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_revocations'`).get();
    if (hasRevocations
      && db.prepare(`SELECT 1 FROM memory_revocations r JOIN memories m ON m.id = r.memory_id
        WHERE m.namespace = ? AND m.tags LIKE '%taste-schema%' LIMIT 1`).get(namespace)) {
      return { ok: false, code: 'SCHEMA_REVOKED' };
    }
    const existing = this.schemaRow(service, namespace);
    if (!manual && existing && new Date(existing.updatedAt).toDateString() === new Date(this.now()).toDateString()) {
      return { ok: false, code: 'ALREADY_TODAY' };
    }
    const inputs = await this._collect(service, namespace, existing, personId);
    const rendered = await this._render(personId, existing, inputs, signal);
    const content = String(rendered.content || '').trim().slice(0, CONTENT_LIMIT);
    if (!content) return { ok: false, code: 'EMPTY_SCHEMA' };
    let priorRevision = 0;
    try { priorRevision = Number(JSON.parse(existing?.evidence || '{}')?.revision) || 0; } catch { /* first schema */ }
    const revision = priorRevision + 1;
    // A stable writeKey gives revokeMemory a tombstone key, so a later schema
    // row cannot be written into a namespace the user withdrew.
    const evidence = JSON.stringify({
      schema: 2, writeKey: `taste-schema:${namespace}`, revision, generatedBy: rendered.source,
      generatedAt: this.now(), inputs: inputs.summary,
      // 适用面与来源：注入前逐条重验，不靠「曾经合法过」继续携带。
      scope: 'widest-audience', contributorIds: inputs.contributorIds || [],
      ...(inputs.migratedFrom ? { migratedFrom: inputs.migratedFrom } : {}),
    });
    if (existing) {
      service.store.update(existing.id, { content, summary: `口味图式 r${revision}`, evidence });
      return { ok: true, id: existing.id, revision, source: rendered.source };
    }
    const result = writeMemoryWithEncoding(service, {
      namespace, type: MemoryType.SEMANTIC, source: MemorySource.AGENT_REFLECTION,
      content, summary: `口味图式 r${revision}`, tags: SCHEMA_TAG,
      confidence: 0.7, importance: 8, evidence, expiresAt: null,
    });
    if (!result.ok) return { ok: false, code: 'MEMORY_WRITE_FAILED' };
    return { ok: true, id: result.id, revision, source: rendered.source };
  }

  async _collect(service, namespace, existing, personId) {
    const live = row => !/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || '')
      && (!row.expiresAt || row.expiresAt > this.now());
    // 图式是 namespace 级、无条件注入的（会进群聊和其他会话）。因此蒸馏只收「最宽受众
    // 可用」的输入：会话限定与 private 记忆一旦被蒸进来，等于把私人事实升级成全局事实，
    // 而且之后再撤回原记忆也收不回图式里的副本。
    const usable = row => !isMemoryRevoked(service.store, row) && live(row)
      && memoryApplies(row, { isGroup: true, sessionId: null, now: this.now() });
    const insightRows = service.searchMemory(undefined, { namespace, type: MemoryType.SEMANTIC, tags: 'reflection-insight', limit: 50 })
      .filter(usable);
    const insights = insightRows.map(row => {
      let claim = null, occurrences = 1;
      try {
        const evidence = JSON.parse(row.evidence || '{}');
        claim = evidence.claim?.key ? { key: evidence.claim.key, polarity: evidence.claim.polarity } : null;
        occurrences = Number(evidence.occurrences) || 1;
      } catch { /* plain insight */ }
      return { observation: row.content, confidence: Number(row.confidence) || 0, claim, occurrences };
    });
    const explicitRows = service.searchMemory(undefined, { namespace, type: MemoryType.SEMANTIC, limit: 100 })
      .filter(row => row.source === 'user_explicit_feedback' && usable(row))
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    const explicit = explicitRows.map(row => row.content);
    // 贡献来源：注入前要逐条重验（撤回/收窄/过期后不能再由图式携带）。
    const contributorIds = [...new Set([...insightRows, ...explicitRows].map(row => row.id).filter(Boolean))].slice(0, 40);
    const stats = (this.getSongStats?.(personId) || []).slice(0, 30);
    const inputs = { insights, explicit, stats, contributorIds, legacy: null, migratedFrom: null,
      summary: { insights: insights.length, explicit: explicit.length, stats: stats.length } };
    // Migration: the global legacy files are folded into the first schema per namespace.
    if (!existing && this.readLegacyFiles) {
      try {
        const legacy = await this.readLegacyFiles();
        if (legacy && (legacy.taste || legacy.moodRules)) {
          inputs.legacy = legacy;
          inputs.migratedFrom = ['user/taste.md', 'user/mood-rules.md'].filter(Boolean);
          inputs.summary.legacy = true;
        }
      } catch (error) {
        this.logger?.warn?.('[taste-schema] legacy file read failed:', error.message);
      }
    }
    return inputs;
  }

  /** Rule-based deterministic distillation. Always available, zero cost, test-seeded. */
  _fallback(personId, inputs) {
    const lines = [`# ${personId} 的口味图式（规则版蒸馏，推断非原话）`];
    if (inputs.legacy?.taste) lines.push('## 迁移自旧口味档案', inputs.legacy.taste.trim().slice(0, 600));
    if (inputs.legacy?.moodRules) lines.push('## 迁移自旧情境规则', inputs.legacy.moodRules.trim().slice(0, 400));
    if (inputs.explicit.length) {
      lines.push('## 用户明确表达（最高优先）', ...inputs.explicit.map(text => `- ${text}`));
    }
    const claims = inputs.insights.filter(row => row.claim).sort((a, b) => b.confidence - a.confidence).slice(0, 10);
    if (claims.length) {
      lines.push('## 从反思中学到（可累积的推断）', ...claims.map(row =>
        `- [${row.claim.key}/${row.claim.polarity}] ${row.observation}（置信度 ${row.confidence.toFixed(2)}${row.occurrences > 1 ? `，×${row.occurrences}` : ''}）`));
    }
    const counted = inputs.stats.filter(row => row.outcome !== 'technical_failure');
    const statLines = ['completed', 'skipped'].flatMap(outcome => {
      const rows = counted.filter(row => row.outcome === outcome).slice(0, 3);
      return rows.length
        ? [`- ${OUTCOME_LABELS[outcome]}最多：`, ...rows.map(row => `  - ${row.songQuery || `${row.provider}:${row.songId}`} ×${row.count}`)]
        : [];
    });
    if (statLines.length) lines.push('## 听歌统计基线（事实计数，非偏好判断）', ...statLines);
    if (lines.length === 1) lines.push('（暂无足够证据形成图式。）');
    return lines.join('\n');
  }

  async _render(personId, existing, inputs, signal) {
    const fallback = this._fallback(personId, inputs);
    try {
      const template = await readFile(this.promptPath, 'utf8');
      const prompt = template
        .replaceAll('{{entity}}', personId)
        .replace('{{current_schema}}', existing?.content || '(empty)')
        .replace('{{insights_json}}', JSON.stringify(inputs.insights))
        .replace('{{explicit_json}}', JSON.stringify(inputs.explicit))
        .replace('{{stats_json}}', JSON.stringify(inputs.stats))
        .replace('{{legacy}}', inputs.legacy ? JSON.stringify(inputs.legacy) : '(none)')
        .replace('{{fallback}}', fallback);
      const raw = await this.llm.askText(prompt, {
        // 蒸馏输出是机械 JSON（content 为 Markdown 正文）：额度/超时来自 taste_schema 规格；
        // 关思考是成本选择，档案允许时才真的发送，截断由传输层升级阶梯兜底。
        signal, temperature: 0.2, thinkingMode: 'disabled', taskId: 'taste_schema',
      });
      const parsed = this.llm.extractJson ? this.llm.extractJson(raw)
        : JSON.parse(String(raw).match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (typeof parsed?.content === 'string' && parsed.content.trim()) {
        return { content: parsed.content, source: 'llm' };
      }
    } catch (error) {
      this.logger?.warn?.('[taste-schema] llm distillation failed, using fallback:', error.message);
    }
    return { content: fallback, source: 'fallback' };
  }
}

export default { TasteSchemaService, stationMemoryTarget, stationPersonIds, collectStationTasteSchemas };
