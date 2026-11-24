// relationshipDigest.js — 关系记忆目录的后台整理（add-relationship-memory-digest）。
//
// 关系事实在字节预算内原样注入；超出预算的旧事实由这里在交互路径之外交给 LLM，
// 整理成按主题分组的条目（主题 + 一句复述 + 来源记忆 id），存成每个角色一行
// tags=relationship-digest 的记忆。目录是派生副本：原始事实、原话、来源与撤回墓碑都不动。
//
// 调用顺序（scheduler 每 30 分钟对每个角色调一次 refresh）：
//   relationshipFacts 切出预算内 / 超出预算 → 读旧目录，来源失效的条目直接删掉（不调模型）
//   → 超出预算、没被条目引用、也没交给过模型的事实 = 待整理 → 没有就结束
//   → 有就调 LLM → 校验（只认交给它的或旧目录引用过的 id、保密与普通不混条、条数与长度上限）
//   → 写回目录行。LLM 失败或未配置时保留旧目录。
// 注入（personMemory.retrievePersonMemories）在每轮再按当前聊天逐条重验来源。
//
// Python 伪代码：
//   kept, overflow = relationship_facts(ns)
//   entries = [e for e in old.entries if all(i in live for i in e.ids)]
//   pending = [f for f in overflow if f.id not in covered(entries) | old.offered]
//   if pending: entries = validate(llm(entries, pending)); offered |= ids(pending) - covered(entries)
//   save(entries, offered)
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolvePackageRoot } from '../runtimePaths.js';
import * as defaultLlm from '../llm.js';
import { MemorySource, MemoryType } from '../memory/types.js';
import { parseEvidence } from '../memory/memoryPolicy.js';
import { writeMemoryWithEncoding } from '../memory/writeMemoryWithEncoding.js';
import { DIGEST_BYTES, DIGEST_LINE_OVERHEAD, DIGEST_TAG, readRelationshipDigest, relationshipFacts } from './personMemory.js';

export const DIGEST_ENTRY_LIMIT = 30;
export const DIGEST_TEXT_CHARS = 120;
const DIGEST_TOPIC_CHARS = 16;
// 一次最多交给模型的待整理事实；更多的留到下一次检查。
export const DIGEST_INPUT_LIMIT = 200;
const FACT_CHARS = 300;

const isPrivate = row => parseEvidence(row).policy?.disclosure === 'private';
const clean = (value, limit) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, limit);

/**
 * 校验模型输出：每条的来源只能是 allowed 里的事实、一个事实只进一条、保密与普通不混条；
 * 旧目录里模型没再提到的条目原样保留（模型不能悄悄删掉已整理的事实）；最后按条数和字节截断。
 */
export function validateDigestEntries(raw, { allowed, previous = [] }) {
  const used = new Set();
  const entries = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, DIGEST_ENTRY_LIMIT * 2) : []) {
    const topic = clean(item?.topic, DIGEST_TOPIC_CHARS);
    const text = clean(item?.text, DIGEST_TEXT_CHARS);
    const ids = [...new Set((Array.isArray(item?.memoryIds) ? item.memoryIds : []).map(Number))]
      .filter(id => Number.isInteger(id) && allowed.has(id) && !used.has(id));
    if (!topic || !text || !ids.length) continue;
    if (new Set(ids.map(id => isPrivate(allowed.get(id)))).size > 1) continue;
    ids.forEach(id => used.add(id));
    entries.push({ topic, text, memoryIds: ids });
  }
  for (const entry of previous) {
    if (entry.memoryIds.some(id => used.has(id))) continue;
    entry.memoryIds.forEach(id => used.add(id));
    entries.push(entry);
  }
  const kept = [];
  let bytes = 0;
  for (const entry of entries.slice(0, DIGEST_ENTRY_LIMIT)) {
    bytes += Buffer.byteLength(`${entry.topic}${entry.text}`) + DIGEST_LINE_OVERHEAD;
    if (bytes > DIGEST_BYTES) break;
    kept.push(entry);
  }
  return kept;
}

export class RelationshipDigestService {
  constructor({
    memoryTarget,
    llm = defaultLlm,
    promptPath = resolve(resolvePackageRoot(), 'prompts', 'relationship-digest.md'),
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.memoryTarget = memoryTarget;
    this.llm = llm;
    this.promptPath = promptPath;
    this.now = now;
    this.logger = logger;
    this.running = new Set();
    this.warned = new Set();
  }

  async refresh(personId, { signal } = {}) {
    const target = await this.memoryTarget(personId);
    if (!target?.service?.store || !target.namespace) return { ok: false, code: 'MEMORY_UNAVAILABLE' };
    const { service, namespace } = target;
    if (this.running.has(namespace)) return { ok: false, code: 'ALREADY_RUNNING' };
    this.running.add(namespace);
    try {
      return await this._refresh(personId, service, namespace, signal);
    } finally {
      this.running.delete(namespace);
    }
  }

  async _refresh(personId, service, namespace, signal) {
    // 不带聊天上下文：保密事实也参与整理（注入时按当前聊天再过滤），只限某次聊天的临时事实不参与。
    const { kept, overflow } = relationshipFacts(service, { namespace, now: this.now() });
    const live = new Map([...kept, ...overflow].map(row => [row.id, row]));
    const previous = readRelationshipDigest(service, namespace);
    const valid = previous.entries.filter(entry => entry.memoryIds.every(id => live.has(id)));
    const covered = new Set(valid.flatMap(entry => entry.memoryIds));
    const offered = new Set(previous.offeredIds.filter(id => live.has(id) && !covered.has(id)));
    const cleaned = valid.length !== previous.entries.length || offered.size !== previous.offeredIds.length;
    // 来源失效的条目先删掉：模型失败也不会让已撤回事实的复述留在目录行里。
    if (cleaned && previous.row) this._write(service, namespace, previous, valid, offered, 'cleanup');
    const pending = overflow.filter(row => !covered.has(row.id) && !offered.has(row.id)).slice(0, DIGEST_INPUT_LIMIT);
    if (!pending.length) return { ok: true, code: cleaned ? 'CLEANED' : 'UP_TO_DATE', entries: valid.length };

    let raw;
    try {
      raw = await this._ask(personId, valid, pending, signal);
    } catch (error) {
      const code = error?.code || error?.name || 'LLM_FAILED';
      if (!this.warned.has(code)) this.logger?.warn?.(`[relationship-digest] ${personId} 整理失败，保留旧目录：${code}`);
      this.warned.add(code);
      return { ok: false, code: 'DIGEST_LLM_FAILED' };
    }
    const allowed = new Map([...valid.flatMap(entry => entry.memoryIds), ...pending.map(row => row.id)]
      .map(id => [id, live.get(id)]));
    const entries = validateDigestEntries(raw, { allowed, previous: valid });
    const nowCovered = new Set(entries.flatMap(entry => entry.memoryIds));
    // 交给过模型却没进目录的（模型没收，或目录满了被截掉）记为已交过，不在每次检查时重发；
    // 它们仍以原话存在，可经按原话检索与语义召回想起。
    for (const id of allowed.keys()) if (!nowCovered.has(id)) offered.add(id);
    for (const id of offered) if (nowCovered.has(id)) offered.delete(id);
    const current = readRelationshipDigest(service, namespace);
    const written = this._write(service, namespace, current, entries, offered, 'llm');
    if (!written) return { ok: false, code: 'MEMORY_WRITE_FAILED' };
    return { ok: true, code: 'UPDATED', entries: entries.length, offered: pending.length };
  }

  async _ask(personId, entries, pending, signal) {
    const template = await readFile(this.promptPath, 'utf8');
    const facts = pending.map(row => JSON.stringify({ memoryId: row.id, content: String(row.content || '').slice(0, FACT_CHARS),
      private: isPrivate(row) })).join('\n');
    const prompt = template
      .replaceAll('{{entity}}', personId)
      .replace('{{current_entries_json}}', entries.length ? JSON.stringify(entries) : '(empty)')
      .replace('{{facts_json}}', facts);
    const text = await this.llm.askText(prompt, { signal, temperature: 0.2, thinkingMode: 'disabled', taskId: 'relationship_digest' });
    const parsed = this.llm.extractJson ? this.llm.extractJson(text)
      : JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}');
    if (!Array.isArray(parsed?.entries)) {
      const error = new Error('digest output has no entries');
      error.code = 'DIGEST_BAD_OUTPUT';
      throw error;
    }
    return parsed.entries;
  }

  _write(service, namespace, previous, entries, offered, generatedBy) {
    const revision = previous.revision + 1;
    const content = `关系记忆目录 r${revision}：${entries.length} 个主题`;
    const evidence = JSON.stringify({ schema: 2, writeKey: `${DIGEST_TAG}:${namespace}`, revision, generatedBy,
      generatedAt: this.now(), scope: 'per-entry-sources', entries, offeredIds: [...offered] });
    if (previous.row) return service.store.update(previous.row.id, { content, summary: content, evidence });
    const result = writeMemoryWithEncoding(service, { namespace, type: MemoryType.SEMANTIC, source: MemorySource.AGENT_REFLECTION,
      content, summary: content, tags: DIGEST_TAG, confidence: 0.7, importance: 8, evidence, expiresAt: null });
    return result.ok;
  }
}
