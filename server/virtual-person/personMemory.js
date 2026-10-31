import { evidenceKeys, isMemoryRevoked, revokeMemory } from '../memory/memoryProvenance.js';
import { createHash } from 'node:crypto';
import { retrieveForPrompt } from '../memory/retrieval.js';
import { recentReflectionInsights } from '../memory/reflectionInsights.js';
import { memoryApplies, parseEvidence, policyFromUserText } from '../memory/memoryPolicy.js';
import { createToolOutcome } from './VirtualPersonTypes.js';

export const PERSON_MEMORY_CAPABILITY = 'person.memory';

/**
 * 图式是否仍可注入（fix-release-blocking-defects）。
 *
 * 图式是 namespace 级、无条件注入的：它是派生副本，因此它的来源被撤回、收窄、过期或删除
 * 之后，副本也不能继续携带那份内容。这里在注入前逐条重验贡献来源；无法证明适用面的旧图式
 * 也不再注入（下一次蒸馏会写回带来源的图式）。
 */
function schemaContributorsStillApply(service, row) {
  const evidence = parseEvidence(row);
  if (evidence.scope !== 'widest-audience') return false;
  const ids = Array.isArray(evidence.contributorIds) ? evidence.contributorIds : [];
  if (!ids.length) return false;
  return ids.every(id => {
    const contributor = service.getMemory(id);
    return Boolean(contributor)
      && !isMemoryRevoked(service.store, contributor)
      && memoryApplies(contributor, { isGroup: true, sessionId: null });
  });
}

export function retrievePersonMemories(service, conversationStore, input) {
  const { namespace, virtualPersonId, sessionId, query } = input;
  const applicable = row => memoryApplies(row, input) && !isMemoryRevoked(service?.store, row);
  const sharedApplicable = row => ['user_explicit_feedback', 'manual_seed', 'station_seed'].includes(row.source)
    && (input.isSharedMemoryActive?.(row) ?? true) && applicable(row);
  const asMemory = (row, kind) => ({ ...row, kind, source: `${row.namespace}:${row.source}` });
  const relationships = service?.store ? service.searchMemory(undefined, { namespace, type: 'semantic', limit: 100 })
    .filter(row => ['user_explicit_feedback', 'manual_seed'].includes(row.source) && applicable(row))
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(row => asMemory(row, 'relationship')) : [];
  const privateRows = service?.store ? retrieveForPrompt(service, { namespace, query, topK: 8 })
    .filter(row => row.source !== 'station_seed' && !String(row.tags || '').includes('reflection-insight') && applicable(row)) : [];
  const sharedRows = service?.store ? [
    ...service.searchMemory(undefined, { namespace: 'station', type: 'semantic', limit: 30 }).filter(sharedApplicable).slice(0, 4),
    ...retrieveForPrompt(service, { namespace: 'station', query, topK: 6 }),
  ]
    .filter(sharedApplicable).sort((a, b) => Number(b.source !== 'station_seed') - Number(a.source !== 'station_seed')).slice(0, 3) : [];
  const seen = new Set(relationships.map(row => row.id));
  const memories = [...privateRows, ...sharedRows].filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  }).slice(0, 9).map(row => asMemory(row, 'memory'));
  const encounters = conversationStore?.recentEncounters(virtualPersonId, { excludeSessionId: sessionId, limit: 20 })
    .filter(applicable).slice(-8).map(turn => ({ kind: 'encounter', source: turn.turnId,
      content: `${turn.role === 'user' ? '用户' : `角色 ${turn.speakerVirtualPersonId}`}：${turn.visibleText.slice(0, 500)}`,
      createdAt: turn.createdAt })) || [];
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
  const reflections = recentReflectionInsights(service, namespace)
    .map(row => ({ row, original: service.getMemory(row.id) }))
    .filter(({ original }) => original && applicable(original))
    .map(({ row }) => row);
  return [...schema, ...relationships, ...memories, ...encounters, ...reflections];
}

function outcome(ok, code, text, facts = {}) {
  return createToolOutcome({ kind: ok ? 'success' : 'business_failure', code, facts,
    modelContext: text, presentation: { displayText: text, speak: false } });
}

export function registerPersonMemoryTools(toolRegistry, { getMemoryService, conversationStore, registry, onMemoryChanged = () => {} }) {
  toolRegistry.register('remember_person_fact', {
    capability: PERSON_MEMORY_CAPABILITY,
    definition: {
      description: '持久记住用户明确说过的称呼、你与用户的关系或口味。用户纠正的是你说话或介绍音乐的方式（例如结尾别总照听众说话、别重复某个口癖）时，kind 用 expression。当前角色跨聊天保持这些记忆。临时要求保持临时；工具成功后才能承诺已记住。',
      parameters: { type: 'object', additionalProperties: false, required: ['content', 'sourceQuote'], properties: {
        content: { type: 'string', description: '一句准确的事实，保留“和我一起听”等关系限定。' },
        sourceQuote: { type: 'string', description: '本轮用户原话中的连续片段，用作依据。' },
        kind: { type: 'string', enum: ['fact', 'expression'],
          description: '默认 fact；用户纠正的是表达/介绍方式（不是口味事实）时用 expression，串词会遵守它。' },
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
      const policy = policyFromUserText(context.userText, context.sessionId);
      const key = createHash('sha256').update(`${context.userTurnId}\0${person.id}\0${quote}`).digest('hex');
      if (isMemoryRevoked(service.store, { namespace: person.memoryNamespace, evidence: { writeKey: key, sourceTurnId: context.userTurnId } })) {
        return outcome(false, 'MEMORY_REVOKED', '这条来源已经撤销，不会重新记下。');
      }
      const existing = service.searchMemory(undefined, { namespace: person.memoryNamespace, limit: 500 })
        .find(row => parseEvidence(row).writeKey === key);
      if (existing) return isMemoryRevoked(service.store, existing) || !memoryApplies(existing, context)
        ? outcome(false, 'MEMORY_REVOKED', '这条来源已被撤销，不会再次记下。')
        : outcome(true, 'PERSON_MEMORY_SAVED', '已经记住了。', { memoryId: existing.id });
      const saved = service.addMemory({ namespace: person.memoryNamespace, type: policy.until ? 'working' : 'semantic',
        source: 'user_explicit_feedback', content, confidence: 0.7, importance: 8,
        tags: kind === 'expression' ? ['expression-preference'] : ['person-relationship'],
        expiresAt: policy.until, sessionId: context.sessionId,
        evidence: JSON.stringify({ schema: 2, writeKey: key, ownerId: person.id, sourceTurnId: context.userTurnId,
          originSessionId: context.sessionId, quote, kind, policy }),
      });
      if (saved.ok) onMemoryChanged({ sessionId: context.sessionId, affectsNarration: kind === 'expression' });
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
      const saved = service.addMemory({ namespace: 'station', type: 'semantic', source: 'user_explicit_feedback',
        content: args.content.trim(), confidence: 0.7, importance: 8, tags: ['shared-explicit'],
        evidence: JSON.stringify({ writeKey: key, sourceTurnId: context.userTurnId, originSessionId: context.sessionId, quote, policy }) });
      // 共享事实不带 expression 标签，不会进入串词语境，故不影响串词。
      if (saved.ok) onMemoryChanged({ sessionId: context.sessionId, affectsNarration: false });
      return outcome(saved.ok, saved.ok ? 'SHARED_MEMORY_SAVED' : 'MEMORY_WRITE_FAILED', saved.ok ? '已保存为大家可以参考的共享记忆。' : '这条共享记忆尚未保存成功。', { memoryId: saved.id });
    },
  });
  toolRegistry.register('forget_person_memory', {
    capability: PERSON_MEMORY_CAPABILITY,
    definition: { description: '仅在用户明确要求忘记或撤回时，撤销当前角色的指定记忆。memoryIds 来自上下文的记忆 ID。',
      parameters: { type: 'object', additionalProperties: false, required: ['memoryIds'],
        properties: { memoryIds: { type: 'array', maxItems: 20, items: { type: 'integer' } } } } },
    handler(args, context) {
      if (!/(?:忘掉|忘记|删除|撤回|别再记|不要记|不再记)/u.test(context.userText)) return outcome(false, 'FORGET_REQUEST_REQUIRED', '用户尚未要求撤销记忆。');
      const service = getMemoryService();
      const namespace = registry.get(context.virtualPersonId)?.memoryNamespace;
      const ids = [...new Set(args.memoryIds || [])].slice(0, 20);
      const rows = ids.map(id => service?.store?.getById(id)).filter(row => row?.namespace === namespace);
      if (!rows.length) return outcome(false, 'MEMORY_NOT_FOUND', '没有找到我可以撤销的这段记忆。');
      service.store.db.transaction(() => {
        for (const row of rows) {
          // Keep a tombstone and the original source so reflection cannot re-create the fact.
          revokeMemory(service.store, row.id);
        }
      })();
      // The services may use separate SQLite connections to the same file. Finish
      // the memory transaction before updating the conversation observation journal.
      for (const row of rows) {
        for (const source of evidenceKeys(row)) conversationStore.revokeObservation(context.virtualPersonId, source);
      }
      onMemoryChanged({ sessionId: context.sessionId,
        affectsNarration: rows.some(row => String(row.tags || '').includes('expression-preference')) });
      return outcome(true, 'PERSON_MEMORY_REVOKED', '已撤销这些记忆。', { memoryIds: rows.map(row => row.id) });
    },
  });
}
