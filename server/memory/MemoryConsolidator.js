// MemoryConsolidator.js — Dreaming / Consolidation Pipeline
//
// Implements the "dreaming" mechanism: background processing that scans
// Working / Episodic memories, finds patterns, promotes stable preferences
// to Semantic Memory, and prunes low-value records.
//
// All 8 steps are rule-based (no LLM calls), keeping the process fast and
// deterministic. The goal is to produce a consolidation report on each run.
//
// Triggerable via:
//   - Manual call to consolidateMemories()
//   - Application startup
//   - Periodic timer (default every 60 minutes)
//   - Session-end (forgetMemories)

import { MemoryType, MemorySource, createMemoryRecord, contentSimilarity, tagOverlap, parseTags } from './types.js';

export class MemoryConsolidator {
  constructor(memoryService, namespace) {
    this.service = memoryService;
    this.store = memoryService.getStore();
    this._namespace = namespace || 'station';
  }

  /**
   * Run the full consolidation pipeline scoped to this._namespace.
   * Steps:
   *   1. Working → Episodic conversion (pre-expiry salvage)
   *   2. Pattern detection in Working + Episodic
   *   3. Duplicate merge (content overlap ≥ 80%)
   *   4. Temporal compression (same-tag events within 1h)
   *   5. Semantic promotion (pattern → long-term memory)
   *   6. Conflict demotion (contradicting new vs old)
   *   7. Decay stale memories
   *   8. Archive low-value memories
   *
   * @returns {object} Report with counts
   */
  consolidateMemories() {
    const ns = this._namespace;
    const before = this.store.count(); // raw DB count

    const result = {
      converted: 0,
      merged: 0,
      compressed: 0,
      promoted: 0,
      demoted: 0,
      decayed: 0,
      pruned: 0,
      totalBefore: before,
      totalAfter: 0,
    };

    // Load all eligible memories in this namespace
    const allMemories = this.store.getAllForConsolidation(ns);

    // Step 1: Working → Episodic conversion
    const { converted, remainingWorking } = this._convertWorkingToEpisodic(allMemories);
    result.converted = converted;

    // Step 2-3-4 combined: pattern detection + duplicate merge + compression
    const episodicMemories = allMemories.filter(m => m.type === MemoryType.EPISODIC);

    // Step 3: Duplicate merge
    const { merged, afterMerge } = this._mergeDuplicates(episodicMemories);
    result.merged = merged;

    // Step 4: Temporal compression
    const { compressed, afterCompression } = this._compressEvents(afterMerge);
    result.compressed = compressed;

    // Step 2 + 5: Pattern detection → Semantic promotion
    const remainingEpi = afterCompression.filter(m => m.type === MemoryType.EPISODIC || !m._merged);
    const { promoted } = this._promotePatterns(remainingEpi);
    result.promoted = promoted;

    // Step 6: Conflict demotion
    const { demoted } = this._demoteConflicts();
    result.demoted = demoted;

    // Step 7: Decay stale
    const { decayed } = this._decayStale(remainingWorking);
    result.decayed = decayed;

    // Step 8: Archive low-value
    const { pruned: archived } = this._archiveLowValue();
    result.pruned = archived;

    result.totalAfter = this.store.count();
    return result;
  }

  // ===================== Step 1: Working → Episodic =====================

  /**
   * Convert high-importance working memories approaching expiry to episodic.
   * Working memories with importance ≥ 5 and expiresAt within 2 hours get promoted.
   */
  _convertWorkingToEpisodic(allMemories) {
    const working = allMemories.filter(m => m.type === MemoryType.WORKING);
    const now = Date.now();
    const twoHours = 2 * 60 * 60 * 1000;
    let converted = 0;

    const remainingWorking = [];

    for (const m of working) {
      if (!m.expiresAt) {
        remainingWorking.push(m);
        continue;
      }

      const timeLeft = m.expiresAt - now;

      if (timeLeft < twoHours && timeLeft > 0 && m.importance >= 5) {
        // Convert to episodic before it expires
        const epiRec = createMemoryRecord(MemoryType.EPISODIC, {
          namespace: this._namespace,
          content: m.content,
          summary: m.summary,
          tags: m.tags,
          source: MemorySource.CONSOLIDATION,
          importance: Math.min(m.importance, 6), // cap importance on conversion
          confidence: m.confidence * 0.8,
          evidence: m.evidence || JSON.stringify({ convertedFrom: 'working', originalId: m.id }),
        });
        this.store.insert(epiRec);
        this.store.delete(m.id);
        converted++;
      } else {
        remainingWorking.push(m);
      }
    }

    return { converted, remainingWorking };
  }

  // ===================== Step 3: Duplicate Merge =====================

  /**
   * Find and merge near-duplicate memories (content similarity ≥ 80%).
   */
  _mergeDuplicates(memories) {
    let merged = 0;
    const toDelete = new Set();

    for (let i = 0; i < memories.length; i++) {
      if (toDelete.has(memories[i].id)) continue;
      for (let j = i + 1; j < memories.length; j++) {
        if (toDelete.has(memories[j].id)) continue;

        const sim = contentSimilarity(memories[i].content, memories[j].content);
        if (sim >= 0.8) {
          // Merge j into i: keep higher importance
          const target = memories[i];
          const source = memories[j];

          if (source.importance > target.importance) {
            this.store.update(target.id, { importance: source.importance });
          }

          // Combine evidence
          const evA = safeParseEvidence(target.evidence);
          const evB = safeParseEvidence(source.evidence);
          const combined = [...new Set([...evA, ...evB, `merged_from_${source.id}`])];
          this.store.update(target.id, {
            evidence: JSON.stringify(combined),
            confidence: Math.max(target.confidence, source.confidence),
          });

          toDelete.add(source.id);
          merged++;
        }
      }
    }

    // Delete merged duplicates
    for (const id of toDelete) {
      this.store.delete(id);
    }

    const afterMerge = memories.filter(m => !toDelete.has(m.id));
    return { merged, afterMerge };
  }

  // ===================== Step 4: Temporal Compression =====================

  /**
   * Compress same-tag events within 1-hour window into single record.
   * The compressed record gets a count field in evidence.
   */
  _compressEvents(memories) {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    let compressed = 0;
    const toDelete = new Set();

    // Group by tag signature
    const groups = {};
    for (const m of memories) {
      if (m.type !== MemoryType.EPISODIC) continue;
      const key = m.tags || 'untagged';
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }

    for (const [, group] of Object.entries(groups)) {
      // Sort by creation time
      group.sort((a, b) => a.createdAt - b.createdAt);

      let current = null;
      let count = 1;

      for (const m of group) {
        if (!current) {
          current = m;
          count = 1;
          continue;
        }

        const timeDiff = m.createdAt - current.createdAt;
        if (timeDiff < oneHour) {
          count++;
          toDelete.add(m.id);
        } else {
          // Finalize current group if count > 1
          if (count > 1) {
            const evidence = safeParseEvidence(current.evidence);
            evidence.push(`compressed_${count}_events`);
            this.store.update(current.id, {
              evidence: JSON.stringify(evidence),
              summary: current.summary || `${count} similar events`,
            });
            compressed += count - 1;
          }
          current = m;
          count = 1;
        }
      }

      // Handle last group
      if (current && count > 1) {
        const evidence = safeParseEvidence(current.evidence);
        evidence.push(`compressed_${count}_events`);
        this.store.update(current.id, {
          evidence: JSON.stringify(evidence),
          summary: current.summary || `${count} similar events`,
        });
        compressed += count - 1;
      }
    }

    for (const id of toDelete) {
      this.store.delete(id);
    }

    const afterCompression = memories.filter(m => !toDelete.has(m.id));
    return { compressed, afterCompression };
  }

  // ===================== Step 2+5: Pattern → Semantic Promotion =====================

  /**
   * Find stable patterns in Episodic Memories and promote to Semantic Memory.
   *
   * Pattern detection: group by tag overlap (≥ 2 common tags).
   * If a group has ≥ 3 members with consistent direction → create Semantic.
   */
  _promotePatterns(episodicMemories) {
    let promoted = 0;

    // Group by tag clusters
    const groups = [];
    const assigned = new Set();

    for (let i = 0; i < episodicMemories.length; i++) {
      if (assigned.has(i)) continue;
      const group = [episodicMemories[i]];
      assigned.add(i);

      for (let j = i + 1; j < episodicMemories.length; j++) {
        if (assigned.has(j)) continue;
        const overlap = tagOverlap(episodicMemories[i].tags, episodicMemories[j].tags, 2);
        if (overlap >= 2) {
          group.push(episodicMemories[j]);
          assigned.add(j);
        }
      }

      if (group.length >= 3) {
        groups.push(group);
      }
    }

    // For each qualifying group, create a Semantic Memory
    for (const group of groups) {
      const tagSet = new Set();
      const contents = [];
      let totalConfidence = 0;
      const evidenceIds = [];

      for (const m of group) {
        parseTags(m.tags).forEach(t => tagSet.add(t));
        contents.push(m.content);
        totalConfidence += m.confidence;
        evidenceIds.push(m.id);
      }

      // Check if a similar semantic already exists
      const existingSemantic = this.store.search({
        type: MemoryType.SEMANTIC,
        tags: [...tagSet].join(','),
        limit: 5,
      });

      const alreadyCovered = existingSemantic.some(s =>
        parseTags(s.tags).some(t => tagSet.has(t))
      );

      if (alreadyCovered) continue;

      // Build a summary from content patterns
      const avgConfidence = totalConfidence / group.length;
      const summary = this._summarizePattern(contents, [...tagSet]);

      if (!summary) continue;

      const semanticRec = createMemoryRecord(MemoryType.SEMANTIC, {
        namespace: this._namespace,
        content: summary,
        summary: `从 ${group.length} 条情景记忆提炼的长期偏好`,
        tags: [...tagSet].join(','),
        source: MemorySource.CONSOLIDATION,
        importance: 6,
        confidence: Math.min(avgConfidence * 1.2, 0.85),
        evidence: JSON.stringify({ promotedFrom: evidenceIds, sources: contents }),
      });

      this.store.insert(semanticRec);
      promoted++;
    }

    return { promoted };
  }

  /**
   * Crude pattern summarizer: extracts the most common distinctive phrases.
   * In a real system this could call LLM, but rule-based keeps it fast.
   */
  _summarizePattern(contents, tags) {
    if (!contents.length) return null;

    // Extract commonly shared words
    const tokenSets = contents.map(c => {
      const tokens = c.toLowerCase().split(/\s+/);
      return new Set(tokens);
    });

    // Find words present in most entries
    const commonTokens = {};
    for (const set of tokenSets) {
      for (const t of set) {
        commonTokens[t] = (commonTokens[t] || 0) + 1;
      }
    }

    const threshold = Math.ceil(contents.length / 2);
    const shared = Object.entries(commonTokens)
      .filter(([, count]) => count >= threshold)
      .map(([word]) => word)
      .filter(w => w.length > 1 && !/^(的|了|是|在|有|我|和|就|不|人|都|一|个|上|也|很|到|说|要|去|你|会|着|没有|看|好|自己|这)$/.test(w));

    const tagContext = tags.join('、');
    if (shared.length >= 2) {
      return `用户表现出对${tagContext}相关的稳定偏好。关键词: ${shared.slice(0, 8).join(', ')}。`;
    }

    // Fallback: use top content as base
    return `用户在 ${tagContext} 场景下有稳定的偏好模式。`;
  }

  // ===================== Step 6: Conflict Demotion =====================

  /**
   * Find Semantic Memories that contradict new patterns and demote them.
   * Contradiction = same tags, low content similarity.
   */
  _demoteConflicts() {
    const semantics = this.store.search({ namespace: this._namespace, type: MemoryType.SEMANTIC, limit: 200 });
    let demoted = 0;

    // Group by tags to find potential contradictions
    const byTag = {};
    for (const s of semantics) {
      const key = s.tags || 'untagged';
      if (!byTag[key]) byTag[key] = [];
      byTag[key].push(s);
    }

    for (const [, group] of Object.entries(byTag)) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const sim = contentSimilarity(group[i].content, group[j].content);
          if (sim < 0.3 && sim >= 0) {
            // Potential contradiction — demote the lower-confidence one
            const toDemote = group[i].confidence <= group[j].confidence ? group[i] : group[j];
            const newConf = Math.max(0, toDemote.confidence - 0.1);
            this.store.update(toDemote.id, { confidence: newConf });
            demoted++;

            // Low-confidence conflict can be soft-deleted if importance also low
            if (newConf < 0.2 && toDemote.importance < 4) {
              this.store.update(toDemote.id, { importance: toDemote.importance - 1 });
            }
          }
        }
      }
    }

    return { demoted };
  }

  // ===================== Step 7: Decay Stale =====================

  /**
   * Decrease importance of episodic memories that haven't been accessed.
   * Criteria: lastAccessedAt > 14 days, accessCount < 3
   */
  _decayStale(workingMemories) {
    const ns = this._namespace;
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const candidates = this.store.search({
      namespace: ns,
      type: MemoryType.EPISODIC,
      limit: 500,
    });

    let decayed = 0;
    for (const m of candidates) {
      if (m.lastAccessedAt < cutoff && m.accessCount < 3) {
        const newImportance = Math.max(1, m.importance - 1);
        if (newImportance !== m.importance) {
          this.store.update(m.id, { importance: newImportance });
          decayed++;
        }
      }
    }

    return { decayed };
  }

  // ===================== Step 8: Archive Low-Value =====================

  /**
   * Delete memories that are very low value.
   * Criteria: importance < 2, confidence < 0.2, lastAccessedAt > 30 days
   */
  _archiveLowValue() {
    const ns = this._namespace;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const candidates = this.store.search({
      namespace: ns,
      type: MemoryType.EPISODIC,
      limit: 500,
    });

    let pruned = 0;
    for (const m of candidates) {
      if (m.importance < 2 && m.confidence < 0.2 && m.lastAccessedAt < cutoff) {
        this.store.delete(m.id);
        pruned++;
      }
    }

    return { pruned };
  }

  // ===================== Forgetting =====================

  /**
   * Run consolidation + cleanup cycle.
   * Never removes persona memories.
   *
   * @param {object} [options]
   * @param {string} [options.type] - Filter by type
   * @param {number} [options.olderThan] - Epoch ms
   * @param {number} [options.minImportance]
   * @param {number} [options.minConfidence]
   * @returns {object} forget report
   */
  forgetMemories(options = {}) {
    const ns = this._namespace;

    // First run consolidation
    const consolidateReport = this.consolidateMemories();

    let forgotten = 0;

    // Delete expired working memories
    const expiredCount = this.store.deleteExpired(ns);
    forgotten += expiredCount;

    // Prune low-value
    const pruneResult = this.store.prune({
      namespace: ns,
      minImportance: options.minImportance ?? 2,
      minConfidence: options.minConfidence ?? 0.2,
      maxAgeDays: 30,
    });
    forgotten += pruneResult.deleted;

    // Type-specific eviction
    if (options.type && options.type !== MemoryType.PERSONA) {
      this.store.evict(options.type, 100, ns);
    }

    // Per-namespace evictions (don't evict persona)
    this.store.evict(MemoryType.WORKING, 200, ns);
    this.store.evict(MemoryType.EPISODIC, 1000, ns);
    this.store.evict(MemoryType.SEMANTIC, 500, ns);

    return {
      ...consolidateReport,
      forgotten,
      expiredDeleted: expiredCount,
      prunedLowValue: pruneResult.deleted,
    };
  }
}

// ===================== Helpers =====================

function safeParseEvidence(evidence) {
  if (!evidence) return [];
  try {
    const parsed = JSON.parse(evidence);
    return Array.isArray(parsed) ? parsed : [evidence];
  } catch {
    return [evidence];
  }
}
