import { evidenceKeys, isMemoryRevoked, revokeMemory } from '../memory/memoryProvenance.js';
import { memoryApplies, parseEvidence } from '../memory/memoryPolicy.js';
import { MemoryType } from '../memory/types.js';
import { ServiceError } from './ServiceError.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export class MemoryAdminService {
  constructor({
    getStation = () => null,
    getDreaming = () => null,
    conversationStore = null,
    invalidate = () => {},
    generateDailySummary,
    consolidateStation,
    now = () => Date.now(),
    env = process.env,
  } = {}) {
    Object.assign(this, { getStation, getDreaming, conversationStore, invalidate });
    this.generateDailySummary = generateDailySummary;
    this.consolidate = consolidateStation;
    this.now = now;
    this.env = env;
  }

  _station() {
    const station = this.getStation();
    if (!station) throw new ServiceError(503, 'station not initialized', 'station_unavailable');
    return station;
  }

  listPersonMemory(personId) {
    const station = this._station();
    const person = station.virtualPersonRegistry?.get(personId);
    if (!person) throw new ServiceError(404, 'person unavailable', 'person_not_found');
    return { ok: true, personId, memories: station.stationMemory.searchMemory(undefined, { namespace: person.memoryNamespace, limit: 100 })
      .filter(row => memoryApplies(row, {}) && !isMemoryRevoked(station.stationMemory.store, row))
      .map(row => ({ ...row, evidence: parseEvidence(row) })) };
  }

  sharedMemory() {
    return { ...this.listStationMemory({ limit: 100 }), candidates: this.getDreaming()?.candidatePool() || [] };
  }

  updateMemory(id, { content, forget = false } = {}) {
    if (!forget && !String(content || '').trim()) throw new ServiceError(400, '修正内容不能为空', 'content_required');
    const station = this._station();
    const store = station.stationMemory.store;
    const row = store.getById(Number(id));
    if (!row) throw new ServiceError(404, 'memory not found', 'memory_not_found');
    const evidence = parseEvidence(row);
    const replacement = store.db.transaction(() => {
      if (evidence.claimId) this.getDreaming()?.revoke(evidence.claimId);
      revokeMemory(store, row.id, this.now());
      if (forget) return null;
      const saved = station.stationMemory.addMemory({ namespace: row.namespace, type: 'semantic',
        content: String(content).trim().slice(0, 1000), source: 'user_explicit_feedback', confidence: 0.7, importance: 8,
        tags: row.namespace === 'station' ? ['shared-explicit'] : ['person-relationship'],
        evidence: JSON.stringify({ correctedMemoryId: row.id, policy: evidence.policy || {}, manualCorrection: true }) });
      if (!saved.ok) throw new ServiceError(500, 'memory correction failed', 'memory_write_failed');
      return saved;
    })();
    const person = station.virtualPersonRegistry?.list().find(entity => entity.memoryNamespace === row.namespace);
    if (person) for (const source of evidenceKeys(row)) this.conversationStore?.revokeObservation(person.id, source);
    this.getDreaming()?.reconcile();
    this.invalidate();
    return { ok: true, revokedMemoryId: row.id, memoryId: replacement?.id || null };
  }

  revokeCandidate(claimId) { return { ok: this.getDreaming()?.revoke(claimId) === true }; }

  async status() {
    const station = this.getStation();
    if (!station) return { enabled: false, error: 'station not initialized' };

    const result = {
      enabled: true,
      consolidationAuto: this.env.MEMORY_CONSOLIDATION_AUTO === '1',
      summaryAuto: this.env.MEMORY_SUMMARY_AUTO === '1',
      radiohosts: [],
    };
    for (const radiohost of station.listRadioHosts?.() || []) {
      try {
        const memory = await station.getRadioHostMemoryService(radiohost.id);
        if (!memory) continue;
        const oldest = memory.searchMemory(undefined, {
          namespace: memory.namespace,
          limit: 1,
        });
        const ageMs = oldest.length > 0 ? this.now() - oldest[0].createdAt : null;
        result.radiohosts.push({
          id: radiohost.id,
          name: radiohost.name,
          namespace: memory.namespace,
          counts: memory.stats(),
          oldestAgeDays: ageMs == null ? null : Math.round(ageMs / DAY_MS),
        });
      } catch (error) {
        result.radiohosts.push({ id: radiohost.id, error: error.message });
      }
    }
    return result;
  }

  async summarize({ radiohostId, date } = {}) {
    const station = this._station();
    const targets = radiohostId
      ? [station.getRadiohostMetadata?.(radiohostId)].filter(Boolean)
      : (station.listRadioHosts?.() || []);
    if (targets.length === 0) throw new ServiceError(400, 'no radiohost found', 'radiohost_not_found');
    if (typeof this.generateDailySummary !== 'function') {
      throw new ServiceError(503, 'summary service unavailable', 'summary_unavailable');
    }

    const now = new Date(this.now());
    const dateString = date || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const results = [];
    for (const radiohost of targets) {
      const memoryService = await station.getRadioHostMemoryService(radiohost.id);
      if (!memoryService) {
        results.push({ radiohostId: radiohost.id, error: 'no memory service' });
        continue;
      }
      const summary = await this.generateDailySummary({ memoryService, date: dateString });
      results.push({
        radiohostId: radiohost.id,
        date: dateString,
        written: !!summary,
        memoryId: summary?.id || null,
      });
    }
    return { ok: true, results };
  }

  stationStatus() {
    const station = this._station();
    return {
      ok: true,
      stationMemory: station.stationStats(),
      activeRadiohost: station.getActiveRadiohost(),
      radiohostCount: station.listRadioHosts().length,
      radiohosts: station.getRadiohostRegistrySummary(),
    };
  }

  listStationMemory({ type, limit } = {}) {
    const station = this._station();
    return {
      ok: true,
      memories: station.getStationMemory({
        type: type || MemoryType.SEMANTIC,
        limit: limit ? Number.parseInt(limit, 10) : 50,
      }).filter(row => memoryApplies(row) && !isMemoryRevoked(station.stationMemory.store, row))
        .map(row => ({ ...row, evidence: parseEvidence(row) })),
    };
  }

  addStationMemory({ content, source, tags } = {}) {
    const station = this._station();
    if (!String(content || '').trim()) {
      throw new ServiceError(400, 'content required', 'content_required');
    }
    return station.addStationMemory(content, source, tags);
  }

  consolidateStation() {
    const station = this._station();
    if (typeof this.consolidate !== 'function') {
      throw new ServiceError(503, 'station consolidation unavailable', 'consolidation_unavailable');
    }
    return { ok: true, ...this.consolidate(station.stationMemory) };
  }
}
