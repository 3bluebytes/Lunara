import { reflectionText } from '../station/ReflectionObservationStore.js';
import { parseEvidence } from './memoryPolicy.js';

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
export function recentReflectionInsights(service, namespace, { now = Date.now(), limit } = {}) {
  if (!service?.store || !namespace) return [];
  const cap = limit ?? injectLimit();
  const rows = service.searchMemory(undefined, { namespace, type: 'semantic', tags: 'reflection-insight', limit: 50 })
    .filter(row => row.createdAt >= now - 7 * DAY
      && (!row.expiresAt || row.expiresAt > now)
      && !/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || ''));
  const scored = rows.map(row => {
    const claim = claimOf(row);
    const ageDays = (now - row.createdAt) / DAY;
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
