/** Only a candidate already filtered for this request can replace an unplayable curated pick. */
export function findCuratedFallbacks({ candidateProgram, excludedSongIds = [] } = {}) {
  const excluded = new Set(excludedSongIds.map(String));
  return (candidateProgram?.metadata?.fallbackCandidates || [])
    .filter(candidate => !excluded.has(String(candidate.sourceSongId || '')))
    .slice(0, 2);
}

export function validateCuratedFallback({ substitute, candidateProgram } = {}) {
  const known = (candidateProgram?.metadata?.fallbackCandidates || []).some(candidate =>
    candidate.candidateId === substitute?.candidateId
    && candidate.sourceSongId === substitute?.sourceSongId
    && candidate.evidence?.source === substitute?.evidence?.source);
  return { ok: known, evidence: known ? { selectedFromQualifiedPool: true } : {} };
}
