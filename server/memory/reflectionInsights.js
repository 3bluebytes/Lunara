import { reflectionText } from '../station/ReflectionObservationStore.js';
import { parseEvidence } from './memoryPolicy.js';

// 近况记忆（add-person-life-notes）：反思从 open loop 另存的伙伴级记忆，由 ReflectionAgent 写入。
export const LIFE_NOTE_TAG = 'reflection-life';

const DAY = 24 * 60 * 60 * 1000;
const injectLimit = () => Math.max(1, Math.min(10, Number.parseInt(process.env.REFLECTION_INJECT_LIMIT, 10) || 3));

function claimOf(row) {
  try {
    const claim = parseEvidence(row)?.claim;
    return claim?.key ? { key: String(claim.key), polarity: String(claim.polarity || '') } : null;
  } catch { return null; }
}

/**
 * Dedicated bounded slot: generic follow-ups need not match an insight's wording.
 *
 * Selection is value-ranked, not purely chronological: claim-tagged insights
 * (accumulated evidence) outrank keyless factual notes, confidence and recency
 * break ties, and one claim+polarity occupies at most one slot.
 */
export function recentReflectionInsights(service, namespace, { now = Date.now(), limit, accept = null } = {}) {
  if (!service?.store || !namespace) return [];
  const cap = limit ?? injectLimit();
  // 洞察的"新近"按最后一次累积证据的时间算：同一 claim 不断被合并强化的洞察不因首次写入满 7 天就消失。
  const freshAt = row => Number(parseEvidence(row)?.lastMergedAt) || row.createdAt;
  const rows = service.store.search({ namespace, type: 'semantic', tags: 'reflection-insight',
    excludeTags: ['revoked', 'superseded'], orderBy: 'updated_at_desc', limit: 50 })
    .filter(row => freshAt(row) >= now - 7 * DAY
      && (!row.expiresAt || row.expiresAt > now)
      && !/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || '')
      // 调用方的适用面判断在取前 cap 条之前做：群聊里滤掉的私密洞察不占名额。
      && (!accept || accept(row)));
  const scored = rows.map(row => {
    const claim = claimOf(row);
    const ageDays = (now - freshAt(row)) / DAY;
    const score = (claim ? 1 : 0) + Math.max(0, Number(row.confidence) || 0) + Math.max(0, 1 - ageDays / 7);
    return { row, claim, score };
  }).sort((a, b) => b.score - a.score);
  const seenClaims = new Set();
  const selected = [];
  for (const entry of scored) {
    if (selected.length >= cap) break;
    if (entry.claim) {
      const identity = `${entry.claim.key}|${entry.claim.polarity}`;
      if (seenClaims.has(identity)) continue;
      seenClaims.add(identity);
    }
    selected.push(entry.row);
  }
  return selected.map(row => {
    let evidence;
    try { evidence = JSON.parse(row.evidence || '{}'); } catch { evidence = {}; }
    const window = String(row.tags || '').includes('reflection-long') ? 'long' : 'short';
    return {
      id: row.id, namespace, source: `${namespace}:${row.source}`,
      content: reflectionText(row.content, 500), kind: 'reflection', window,
      confidence: Math.min(window === 'long' ? 0.7 : 0.4, Math.max(0, Number(row.confidence) || 0)),
      createdAt: row.createdAt, expiresAt: row.expiresAt || null,
      observedFrom: Number(evidence.from) || row.createdAt,
      observedTo: Number(evidence.to) || row.createdAt,
      evidence: (Array.isArray(evidence.eventKeys) ? evidence.eventKeys : Array.isArray(evidence) ? evidence : [])
        .slice(0, 10).map(value => reflectionText(value, 160)),
      scope: reflectionText(evidence.scope || 'historical-observation-not-a-fixed-preference', 120),
    };
  });
}

/**
 * 在聊天里把 open_loop 了结后，把同一批次（或同源同文）生成的伙伴级 reflection-life 记忆同步退场：
 * 打上 superseded 标签并即时过期，避免伙伴在其他聊天继续把已翻篇的事当近况提起。
 */
export function retireSettledLifeNotes(service, { namespace, lifeWriteKey = null, sessionId = null, text = null,
  turnIds = null, status = 'resolved', now = Date.now() } = {}) {
  if (!service?.store || !namespace) return 0;
  const rows = service.store.search({ namespace, type: 'semantic', tags: LIFE_NOTE_TAG,
    excludeTags: ['revoked', 'superseded'], limit: 200 });
  let count = 0;
  for (const row of rows) {
    if (/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || '')) continue;
    const evidence = parseEvidence(row);
    const keyMatched = Boolean(lifeWriteKey && evidence.writeKey === lifeWriteKey);
    const fallbackMatched = !lifeWriteKey
      && (!text || row.content === text)
      && (!sessionId || evidence.originSessionId === sessionId || evidence.sessions?.includes(sessionId))
      && (!turnIds?.size || (Array.isArray(evidence.sourceTurnIds) && evidence.sourceTurnIds.some(id => turnIds.has(String(id)))));
    if (!keyMatched && !fallbackMatched) continue;
    const tags = [...new Set([...String(row.tags || '').split(',').map(tag => tag.trim()).filter(Boolean), 'superseded'])].join(',');
    const updated = service.store.update(row.id, {
      tags,
      expiresAt: now - 1,
      evidence: JSON.stringify({ ...evidence, settledStatus: status, settledAt: now }),
    });
    if (updated) count += 1;
  }
  return count;
}
