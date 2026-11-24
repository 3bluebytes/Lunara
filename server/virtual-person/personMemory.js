import { evidenceKeys, filterUnrevoked, isMemoryRevoked, restoreSuperseded, revokeMemory, schemaContributorsStillApply, supersededByAny } from '../memory/memoryProvenance.js';
import { createHash } from 'node:crypto';
import { getDayOfWeek, getTimeBucket } from '../env.js';
import { writeMemoryWithEncoding } from '../memory/writeMemoryWithEncoding.js';
import { retrieveForPrompt } from '../memory/retrieval.js';
import { LIFE_NOTE_TAG, recentReflectionInsights } from '../memory/reflectionInsights.js';
import { discretionLabel, memoryApplies, memoryDiscretionLabel, parseEvidence, policyForQuote, policyFromUserText } from '../memory/memoryPolicy.js';
import { createToolOutcome } from './VirtualPersonTypes.js';

export const PERSON_MEMORY_CAPABILITY = 'person.memory';
// 关系记忆（显式事实）在字节预算内按最近更新全部注入，由模型自己做语义联想；超出预算的才只能靠按原话检索想起。
// 每行按内容字节数加固定前缀估算，预算约容纳 130 条短事实。
export const RELATIONSHIP_MEMORY_BYTES = 16_000;
export const RELATIONSHIP_MEMORY_LIMIT = 200;
const RELATIONSHIP_LINE_OVERHEAD = 100;

function withinRelationshipBudget(rows) {
  const kept = [];
  let bytes = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(String(row.content || '')) + RELATIONSHIP_LINE_OVERHEAD;
    if (bytes > RELATIONSHIP_MEMORY_BYTES || kept.length >= RELATIONSHIP_MEMORY_LIMIT) break;
    kept.push(row);
  }
  return kept;
}
// 关系记忆目录（add-relationship-memory-digest）：后台把超出预算的旧事实整理成按主题分组的条目，
// 每个角色一行 tags=relationship-digest 的记忆，条目在 evidence.entries 里。注入字节上限见下。
export const DIGEST_TAG = 'relationship-digest';
export const DIGEST_BYTES = 6000;
// 每行的前缀与来源 id 列表（最多列 20 个）按固定字节估算。
export const DIGEST_LINE_OVERHEAD = 140;

/** 当前角色的目录行与条目；没有或已撤回时 entries 为空。 */
export function readRelationshipDigest(service, namespace) {
  if (!service?.store) return { row: null, entries: [], offeredIds: [], revision: 0 };
  const row = service.searchMemory(undefined, { namespace, type: 'semantic', tags: DIGEST_TAG, limit: 5 })
    .filter(item => !isMemoryRevoked(service.store, item) && !/(?:^|,)(?:revoked|superseded)(?:,|$)/u.test(item.tags || ''))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)[0] || null;
  const evidence = row ? parseEvidence(row) : {};
  const entries = (Array.isArray(evidence.entries) ? evidence.entries : [])
    .filter(entry => entry && Array.isArray(entry.memoryIds) && entry.memoryIds.length && entry.topic && entry.text);
  return { row, entries, offeredIds: Array.isArray(evidence.offeredIds) ? evidence.offeredIds : [],
    revision: Number(evidence.revision) || 0 };
}

/**
 * 可注入的目录条目：每条的来源事实必须都还在当前聊天生效（liveRows 已经过撤回、取代、过期与适用面过滤），
 * 且至少有一条来源不在预算内的常驻关系记忆里（本轮语义召回带出的不算）；按字节上限截断。
 */
function digestItems(service, namespace, liveRows, shownIds) {
  const { row, entries } = readRelationshipDigest(service, namespace);
  if (!row) return [];
  const items = [];
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.memoryIds.every(id => liveRows.has(id)) || entry.memoryIds.every(id => shownIds.has(id))) continue;
    bytes += Buffer.byteLength(`${entry.topic}${entry.text}`) + DIGEST_LINE_OVERHEAD;
    if (bytes > DIGEST_BYTES) break;
    items.push({ kind: 'digest', id: row.id, source: `${namespace}:${row.source}`,
      topic: entry.topic, content: entry.text, memoryIds: [...entry.memoryIds],
      // 整理时私下与普通不混条，看第一条来源就知道这一条的标签。
      label: memoryDiscretionLabel(liveRows.get(entry.memoryIds[0])) });
  }
  if (items.length) service.getMemory(row.id); // 注入计作访问，与图式一致
  return items;
}

// 近况条数：最近提到的在前。
export const LIFE_NOTE_LIMIT = 5;
export const ENCOUNTER_LIMIT = 8;

/**
 * 跨聊天摘录在聊天之间轮流取：从最近活跃的聊天起，每个聊天每轮取一条最新的，直到 8 条。
 * 一个聊得很多的聊天不会把其他聊天里刚提过的事全挤掉；只有一个其他聊天时仍能带满 8 条。
 * 结果保持输入（recentEncounters）的时间正序；不用 sequence 重排，它只在单个聊天内可比。
 */
function fairExcerpts(turns) {
  const position = new Map(turns.map((turn, index) => [turn, index]));
  const bySession = new Map();
  for (const turn of [...turns].reverse()) {
    if (!bySession.has(turn.sessionId)) bySession.set(turn.sessionId, []);
    bySession.get(turn.sessionId).push(turn);
  }
  const queues = [...bySession.values()];
  const picked = [];
  for (let round = 0; picked.length < ENCOUNTER_LIMIT && queues.some(queue => queue.length > round); round += 1) {
    for (const queue of queues) if (queue[round] && picked.length < ENCOUNTER_LIMIT) picked.push(queue[round]);
  }
  return picked.sort((a, b) => position.get(a) - position.get(b));
}

/**
 * 当前角色生效的显式关系事实，按最近更新排序，切成预算内（kept）与超出预算（overflow）两段。
 * overflow 是语义召回的候选：已经过适用面与撤回过滤。
 */
const RELATIONSHIP_SOURCES = ['user_explicit_feedback', 'manual_seed'];
// 候选上限只是防失控；正常用户的显式事实远低于此。
const RELATIONSHIP_CANDIDATE_LIMIT = 5000;

export function relationshipFacts(service, input) {
  if (!service?.store) return { kept: [], overflow: [] };
  // 来源、撤回与取代标签在 SQL 里先筛：反思洞察、被取代的旧行再多也不占候选名额。
  const applicable = service.store.search({ namespace: input.namespace, type: 'semantic', sources: RELATIONSHIP_SOURCES,
    excludeTags: ['revoked', 'superseded'], orderBy: 'updated_at_desc', limit: RELATIONSHIP_CANDIDATE_LIMIT })
    .filter(row => memoryApplies(row, input));
  const all = filterUnrevoked(service.store, applicable)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  const kept = withinRelationshipBudget(all);
  return { kept, overflow: all.slice(kept.length) };
}

/**
 * input.semanticRecall：语义召回提名的超出预算事实 id（按相似度降序，见 memory/embedding/semanticMemory.js）。
 * 只认 overflow 里的 id，因此提名不能绕过适用面与撤回过滤。
 */
export function retrievePersonMemories(service, conversationStore, input) {
  const { namespace, virtualPersonId, sessionId, query } = input;
  const nowDate = input.now ? new Date(input.now) : new Date();
  const stateEncoding = {
    currentMood: input.currentMood ?? null,
    currentTimeBucket: input.currentTimeBucket ?? getTimeBucket(nowDate),
    currentDayOfWeek: input.currentDayOfWeek ?? getDayOfWeek(nowDate),
  };
  const applicable = row => memoryApplies(row, input) && !isMemoryRevoked(service?.store, row);
  const sharedApplicable = row => ['user_explicit_feedback', 'manual_seed', 'station_seed'].includes(row.source)
    && (input.isSharedMemoryActive?.(row) ?? true) && applicable(row);
  const asMemory = (row, kind) => ({ ...row, kind, source: `${row.namespace}:${row.source}` });
  // input.relationships：调用方确认库没变过时传入的同一轮 relationshipFacts 结果，省掉重复的检索与墓碑过滤。
  const { kept, overflow } = input.relationships || relationshipFacts(service, input);
  const overflowById = new Map(overflow.map(row => [row.id, row]));
  const recalled = [...new Set(Array.isArray(input.semanticRecall) ? input.semanticRecall : [])]
    .map(id => overflowById.get(id)).filter(Boolean);
  // 召回的事实带 recalled：它们随本轮原话变化，提示词把它们放进本轮背景而不是系统提示（PromptAssembler）。
  const relationships = [...kept.map(row => asMemory(row, 'relationship')),
    ...recalled.map(row => ({ ...asMemory(row, 'relationship'), recalled: true }))];
  // 目录只和预算内的常驻事实去重：它在系统提示里，不能跟着每轮的召回结果增减。
  const digest = digestItems(service, namespace, new Map([...kept, ...overflow].map(row => [row.id, row])),
    new Set(kept.map(row => row.id)));
  // 先过滤再截取：反思、近况、整理目录、口味图式各有自己的小节（图式还要另过来源校验），
  // 已在关系记忆里的也不重复；这些都不占「相关长期记忆」的名额。
  const relationshipIds = new Set(relationships.map(row => row.id));
  const privateRows = service?.store ? retrieveForPrompt(service, { namespace, query, topK: 8, ...stateEncoding,
    accept: row => row.source !== 'station_seed' && !relationshipIds.has(row.id)
      && !/reflection-(?:insight|life)|relationship-digest|taste-schema/.test(String(row.tags || '')) && applicable(row) }) : [];
  // 共享事实：按本轮原话命中的在前、最近的在后，去重后用户/角色写下的排在种子前，取 3 条。
  const sharedRows = service?.store ? [...new Map([
    ...retrieveForPrompt(service, { namespace: 'station', query, topK: 6, ...stateEncoding, accept: sharedApplicable }),
    ...service.searchMemory(undefined, { namespace: 'station', type: 'semantic', limit: 30 }).filter(sharedApplicable).slice(0, 4),
  ].map(row => [row.id, row])).values()]
    .sort((a, b) => Number(b.source !== 'station_seed') - Number(a.source !== 'station_seed')).slice(0, 3) : [];
  const seen = new Set(relationshipIds);
  const memories = [...privateRows, ...sharedRows].filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }).slice(0, 9).map(row => asMemory(row, 'memory'));
  // 跨聊天摘录：她自己在场观察过的回合（recentEncounters 只取她的观察）。私下说的、敏感的也带上，
  // 附来源标签；进了群聊提不提、怎么提，是她的分寸，不在这里滤掉。
  // 串词不算：它是放歌时的独白，不是交流；带进系统提示会被当成说话的范例，把旧的说法一直带下去。
  const encounters = fairExcerpts((conversationStore?.recentEncounters(virtualPersonId,
    { excludeSessionId: sessionId, perSession: ENCOUNTER_LIMIT, excludeTrackIntros: true }) || [])
    .filter(applicable))
    .map(turn => {
      const speakerPrefix = `${turn.role === 'user' ? '用户' : `角色 ${turn.speakerVirtualPersonId}`}：`;
      const rawText = turn.visibleText.slice(0, 500);
      const discretion = discretionLabel(turn.policy);
      return {
        kind: 'encounter',
        source: turn.turnId,
        originInteractionMode: turn.interactionMode || 'radio',
        speakerPrefix,
        rawText,
        discretion,
        content: `${speakerPrefix}${rawText}${discretion}`,
        createdAt: turn.createdAt,
      };
    });
  const schemaRows = service?.store ? service.searchMemory(undefined, { namespace, type: 'semantic', tags: 'taste-schema', limit: 1 }) : [];
  const schema = schemaRows
    .filter(row => !isMemoryRevoked(service.store, row) && !/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || '')
      && (!row.expiresAt || row.expiresAt > Date.now()))
    .filter(row => schemaContributorsStillApply(service, row))
    .slice(0, 1)
    .map(row => {
      service.getMemory(row.id); // Unconditional injection counts as access for decay bookkeeping.
      return { ...row, kind: 'schema', source: `${namespace}:${row.source}` };
    });
  // 近况在群聊里也注入：她记得对方的生活安排，当着大家提不提由她拿捏（私下说的带标签）。
  const lifeNotes = service?.store
    ? (typeof service.store.search === 'function'
      ? service.store.search({ namespace, type: 'semantic', tags: LIFE_NOTE_TAG, excludeTags: ['revoked', 'superseded'], limit: 50 })
      : service.searchMemory(undefined, { namespace, type: 'semantic', tags: LIFE_NOTE_TAG, limit: 50 }))
      .filter(applicable)
      .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id).slice(0, LIFE_NOTE_LIMIT)
      .map(row => {
        const evidence = parseEvidence(row);
        return { ...asMemory(row, 'life'), dueDate: evidence.dueDate || null, mentionedAt: evidence.mentionedAt || row.createdAt };
      }) : [];
  const reflections = recentReflectionInsights(service, namespace, { accept: applicable })
    .map(row => ({ row, original: service.getMemory(row.id) }))
    .filter(({ original }) => original && applicable(original))
    .map(({ row }) => row);
  return [...schema, ...relationships, ...digest, ...lifeNotes, ...memories, ...encounters, ...reflections];
}

/**
 * 新事实取代旧事实：旧行打 superseded 标签（不再注入，也不写撤回墓碑），证据里记下取代它的记忆 id；
 * 取代它的新事实被撤回或随来源删除时，forgetSources 会把旧行恢复。
 */
function supersedeMemories(store, rows, byId) {
  const update = store.db.prepare('UPDATE memories SET tags = ?, evidence = ?, updated_at = ? WHERE id = ?');
  const now = Date.now();
  store.db.transaction(() => {
    for (const row of rows) {
      update.run(`${row.tags || ''},superseded`, JSON.stringify({ ...parseEvidence(row), supersededBy: byId }), now, row.id);
    }
  })();
}

function outcome(ok, code, text, facts = {}) {
  return createToolOutcome({ kind: ok ? 'success' : 'business_failure', code, facts,
    modelContext: text, presentation: { displayText: text, speak: false } });
}

/**
 * 撤回一条记忆后，撤回它来源回合上的观察（聊天里的忘记与管理页的修正/删除共用）。
 * 自己的记忆只撤回主人的观察；共享事实是大家的：看过这句原话的每位伙伴都撤回观察，并在各自记忆里记下墓碑
 * （memory_id 指向这条共享事实），他们从这句话反思出的内容随之失效、也不会重新学回；他们各自记下的显式事实不受影响。
 */
export function revokeSourceObservations({ conversationStore, registry, store, row, ownerId = null, now = Date.now() }) {
  if (!conversationStore || !row) return;
  const owner = ownerId || registry?.list?.().find(entity => entity.memoryNamespace === row.namespace)?.id || null;
  for (const source of evidenceKeys(row)) {
    const observers = row.namespace === 'station'
      ? [...new Set([owner, ...(conversationStore.observersOf?.(source) || [])].filter(Boolean))] : [owner].filter(Boolean);
    for (const personId of observers) {
      conversationStore.revokeObservation(personId, source);
      const observerNamespace = registry?.get?.(personId)?.memoryNamespace;
      if (row.namespace === 'station' && observerNamespace && store?.db) {
        store.db.prepare('INSERT OR IGNORE INTO memory_revocations VALUES (?, ?, ?, ?)').run(observerNamespace, source, row.id, now);
      }
    }
  }
}

export function registerPersonMemoryTools(toolRegistry, { getMemoryService, conversationStore, registry, getDreaming = () => null, onMemoryChanged = () => {} }) {
  toolRegistry.register('remember_person_fact', {
    capability: PERSON_MEMORY_CAPABILITY,
    definition: {
      description: '持久记住用户明确说过的称呼、你与用户的关系或口味。用户纠正的是你说话或介绍音乐的方式（例如结尾别总照听众说话、别重复某个口癖）时，kind 用 expression。当前角色跨聊天保持这些记忆。临时要求保持临时；工具成功后才能承诺已记住。',
      parameters: { type: 'object', additionalProperties: false, required: ['content', 'sourceQuote'], properties: {
        content: { type: 'string', description: '一句准确的事实，保留“和我一起听”等关系限定。' },
        sourceQuote: { type: 'string', description: '本轮用户原话中的连续片段，用作依据。' },
        kind: { type: 'string', enum: ['fact', 'expression'],
          description: '默认 fact；用户纠正的是表达/介绍方式（不是口味事实）时用 expression，串词会遵守它。' },
        replacesMemoryIds: { type: 'array', maxItems: 5, items: { type: 'integer' },
          description: '这条新事实让上下文里哪些旧的关系记忆不再成立（例如搬家、换工作、改名）；填它们的 memoryId。只是补充、不冲突时不填。' },
      } },
    },
    handler(args, context) {
      const quote = String(args.sourceQuote || '').trim();
      const content = String(args.content || '').trim().slice(0, 1000);
      const kind = args.kind === 'expression' ? 'expression' : 'fact';
      if (!content || quote.length < 2 || !context.userText.includes(quote)) {
        return outcome(false, 'MEMORY_SOURCE_REQUIRED', '没有找到对应的用户原话，不能把推测记成事实。');
      }
      const service = getMemoryService();
      const person = registry.get(context.virtualPersonId);
      if (!service?.store || !person) return outcome(false, 'MEMORY_UNAVAILABLE', '记忆暂时没有保存成功。');
      const policy = policyForQuote(context.userText, quote, context.sessionId);
      // 先认同一来源已经写过的那条：成功之后重试（换了措辞、整轮重跑）原样返回已保存，不因旧事实已被取代而报错。
      const key = createHash('sha256').update(`${context.userTurnId}\0${person.id}\0${quote}`).digest('hex');
      if (isMemoryRevoked(service.store, { namespace: person.memoryNamespace, evidence: { writeKey: key, sourceTurnId: context.userTurnId } })) {
        return outcome(false, 'MEMORY_REVOKED', '这条来源已经撤销，不会重新记下。');
      }
      const existing = service.searchMemory(undefined, { namespace: person.memoryNamespace, limit: 500 })
        .find(row => parseEvidence(row).writeKey === key);
      if (existing) return isMemoryRevoked(service.store, existing) || !memoryApplies(existing, context)
        ? outcome(false, 'MEMORY_REVOKED', '这条来源已被撤销，不会再次记下。')
        : outcome(true, 'PERSON_MEMORY_SAVED', '已经记住了。', { memoryId: existing.id });
      // 被取代的旧事实必须是当前角色仍然生效的显式记忆；有一条不合格就整体拒绝，让模型改正后重试。
      const replaceIds = [...new Set(args.replacesMemoryIds || [])];
      // 只限这次聊天、到期即失效的临时事实不能取代长期事实：到期后两条都会消失，旧事实也不会恢复。
      if (replaceIds.length && (policy.until || policy.onlyConversationId)) {
        return outcome(false, 'MEMORY_REPLACE_SCOPE_MISMATCH',
          '这句话里有"这次/今天只…"之类的限定，新事实只会临时保存，不能取代长期记忆。不填 replacesMemoryIds 再记；需要长期更新时请用户单独说一句。');
      }
      const replaced = replaceIds.map(id => service.store.getById(id)).filter(row => row?.namespace === person.memoryNamespace
        && ['user_explicit_feedback', 'manual_seed'].includes(row.source) && !isMemoryRevoked(service.store, row)
        && !/(?:^|,)superseded(?:,|$)/u.test(row.tags || ''));
      if (replaced.length !== replaceIds.length) {
        return outcome(false, 'MEMORY_REPLACE_INVALID', 'replacesMemoryIds 里有不是当前角色生效关系记忆的 id；只填上下文里列出的旧事实。');
      }
      const saved = writeMemoryWithEncoding(service, { namespace: person.memoryNamespace, type: 'semantic',
        source: 'user_explicit_feedback', content, confidence: 0.7, importance: 8,
        tags: kind === 'expression' ? ['expression-preference'] : ['person-relationship'],
        expiresAt: policy.until, sessionId: context.sessionId,
        evidence: JSON.stringify({ schema: 2, writeKey: key, ownerId: person.id, sourceTurnId: context.userTurnId,
          originSessionId: context.sessionId, quote, kind, policy }),
      }, { session_id: context.sessionId });
      if (saved.ok && replaced.length) supersedeMemories(service.store, replaced, saved.id);
      // 取代旧说法也算：没说出口的串词可能还照着旧说法写。
      if (saved.ok) onMemoryChanged({ sessionId: context.sessionId, affectsNarration: kind === 'expression' || replaced.length > 0 });
      return outcome(saved.ok, saved.ok ? 'PERSON_MEMORY_SAVED' : 'MEMORY_WRITE_FAILED',
        saved.ok ? '已经保存到我与你的记忆中。' : '这次记忆没有保存成功，不能承诺已经记住。', { memoryId: saved.id || null });
    },
  });
  toolRegistry.register('remember_shared_fact', {
    capability: PERSON_MEMORY_CAPABILITY,
    definition: { description: '只有用户明确让所有伙伴或其他聊天都知道时，持久保存一条共享事实。角色专属喜好或保密内容不能共享。成功后才能承诺大家会记得。',
      parameters: { type: 'object', additionalProperties: false, required: ['content', 'sourceQuote'],
        properties: { content: { type: 'string', minLength: 1, maxLength: 1000 }, sourceQuote: { type: 'string', minLength: 4, maxLength: 1000 } } } },
    handler(args, context) {
      const quote = args.sourceQuote.trim();
      const policy = policyFromUserText(context.userText, context.sessionId);
      if (!context.userText.includes(quote) || !/所有(?:的)?\s*(?:伙伴|人|聊天|会话)|全局|每(?:个|位)\s*(?:伙伴|人)|告诉其他|都可以知道/u.test(quote)
        || policy.disclosure === 'private' || policy.onlyConversationId) return outcome(false, 'SHARED_PERMISSION_REQUIRED', '用户没有明确允许把这件事共享给大家。');
      const service = getMemoryService();
      if (!service?.store) return outcome(false, 'MEMORY_UNAVAILABLE', '共享记忆暂时没有保存成功。');
      const key = createHash('sha256').update(`${context.userTurnId}:station:${quote}`).digest('hex');
      if (isMemoryRevoked(service.store, { namespace: 'station', evidence: { writeKey: key, sourceTurnId: context.userTurnId } })) {
        return outcome(false, 'MEMORY_REVOKED', '这条共享来源已经撤销，不会重新记下。');
      }
      const existing = service.searchMemory(undefined, { namespace: 'station', limit: 500 }).find(row => parseEvidence(row).writeKey === key);
      if (existing) return outcome(!isMemoryRevoked(service.store, existing), 'SHARED_MEMORY_EXISTS', '这条共享记忆已经处理过。', { memoryId: existing.id });
      const saved = writeMemoryWithEncoding(service, { namespace: 'station', type: 'semantic', source: 'user_explicit_feedback',
        content: args.content.trim(), confidence: 0.7, importance: 8, tags: ['shared-explicit'],
        evidence: JSON.stringify({ writeKey: key, sourceTurnId: context.userTurnId, originSessionId: context.sessionId, quote, policy }) },
      { session_id: context.sessionId });
      // 共享事实不带 expression 标签，不会进入串词语境，故不影响串词。
      if (saved.ok) onMemoryChanged({ sessionId: context.sessionId, affectsNarration: false });
      return outcome(saved.ok, saved.ok ? 'SHARED_MEMORY_SAVED' : 'MEMORY_WRITE_FAILED', saved.ok ? '已保存为大家可以参考的共享记忆。' : '这条共享记忆尚未保存成功。', { memoryId: saved.id });
    },
  });
  toolRegistry.register('forget_person_memory', {
    capability: PERSON_MEMORY_CAPABILITY,
    definition: { description: '仅在用户明确要求忘记或撤回时，撤销当前角色的指定记忆（含大家共享的事实与近期听歌观察）。memoryIds 来自上下文的记忆 ID。',
      parameters: { type: 'object', additionalProperties: false, required: ['memoryIds'],
        properties: { memoryIds: { type: 'array', maxItems: 20, items: { type: 'integer' } },
          restoreReplaced: { type: 'boolean', description: '这条记忆当初取代过旧说法时：用户说新说法记错了、旧说法仍然成立才填 true；只是要求忘掉就不填。' } } } },
    handler(args, context) {
      if (!/(?:忘掉|忘记|删除|撤回|别再记|不要记|不再记)/u.test(context.userText)) return outcome(false, 'FORGET_REQUEST_REQUIRED', '用户尚未要求撤销记忆。');
      const service = getMemoryService();
      const namespace = registry.get(context.virtualPersonId)?.memoryNamespace;
      const ids = [...new Set(args.memoryIds || [])].slice(0, 20);
      // 自己的记忆，或大家共享的事实与从聊天里晋升的共享推测（带 claimId）；产品预置的 station_seed 不能撤回。
      const rows = ids.map(id => service?.store?.getById(id))
        .filter(row => row?.namespace === namespace
          || (row?.namespace === 'station' && (row.source !== 'station_seed' || parseEvidence(row).claimId)));
      if (!rows.length) return outcome(false, 'MEMORY_NOT_FOUND', '没有找到我可以撤销的这段记忆。');
      // 忘掉新说法不等于旧说法重新成立：默认旧说法保持失效，用户确认旧说法仍成立时才恢复。
      const restoreReplaced = args.restoreReplaced === true;
      const restored = service.store.db.transaction(() => rows.flatMap(row => {
        // Keep a tombstone and the original source so reflection cannot re-create the fact.
        if (!String(row.tags || '').split(',').includes('revoked')) revokeMemory(service.store, row.id, Date.now(), { restore: false });
        return restoreReplaced ? restoreSuperseded(service.store.db, [row.id]) : [];
      }))();
      const stillReplaced = restoreReplaced ? 0 : supersededByAny(service.store.db, rows.map(row => row.id));
      // 晋升出的共享记忆连同它的 claim 一起撤回：claim 证据表里更早的原话不能让它在下一次 reconcile 重新晋升。
      for (const row of rows) {
        const claimId = row.namespace === 'station' ? parseEvidence(row).claimId : null;
        if (claimId) getDreaming()?.revoke(claimId);
      }
      // The services may use separate SQLite connections to the same file. Finish
      // the memory transaction before updating the conversation observation journal.
      for (const row of rows) {
        revokeSourceObservations({ conversationStore, registry, store: service.store, row, ownerId: context.virtualPersonId });
      }
      onMemoryChanged({ sessionId: context.sessionId, affectsNarration: true });
      const note = restored.length ? `它们当初取代的 ${restored.length} 条旧说法已恢复。`
        : stillReplaced ? '它们当初取代的旧说法仍保持失效；用户若说旧说法仍然成立，再调用一次并把 restoreReplaced 设为 true。' : '';
      return outcome(true, 'PERSON_MEMORY_REVOKED', `已撤销这些记忆。${note}`,
        { memoryIds: rows.map(row => row.id), restoredMemoryIds: restored });
    },
  });
}
