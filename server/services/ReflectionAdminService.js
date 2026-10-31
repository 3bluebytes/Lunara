import { ServiceError } from './ServiceError.js';
import { reflectionText } from '../station/ReflectionObservationStore.js';

export class ReflectionAdminService {
  constructor({ getStation, logger = console } = {}) {
    this.getStation = getStation;
    this.logger = logger;
  }

  async status() {
    const station = this.getStation?.();
    const reflection = station?.getReflectionAgent?.();
    if (!reflection) {
      return { enabled: false, error: 'station or reflectionAgent not initialized', recentInsights: [] };
    }
    const recentInsights = [];
    try {
      const people = station.virtualPersonRegistry?.list?.()
        || [{ id: 'lunara' }, ...(station.listRadioHosts?.() || [])];
      for (const person of people) {
        const target = reflection.memoryTarget ? await reflection.memoryTarget(person.id) : null;
        const memory = target?.service || (person.id === 'lunara' ? station.stationMemory : await station.getRadioHostMemoryService(person.id));
        if (!memory) continue;
        const rows = memory.searchMemory(undefined, {
          namespace: target?.namespace || (person.id === 'lunara' ? 'person:lunara' : memory.namespace),
          tags: 'reflection-insight',
          limit: 20,
        });
        for (const record of rows) {
          recentInsights.push({
            id: record.id,
            radiohostId: person.id,
            virtualPersonId: person.id,
            window: String(record.tags || '').includes('reflection-short') ? 'short' : 'long',
            tags: record.tags,
            confidence: record.confidence,
            createdAt: record.createdAt,
            observationPreview: reflectionText(record.content, 120),
          });
        }
      }
    } catch (error) {
      this.logger?.warn?.('[reflection] status insight lookup failed:', error.message);
    }
    recentInsights.sort((left, right) => right.createdAt - left.createdAt);
    return { ...reflection.getStatusSnapshot(), recentInsights: recentInsights.slice(0, 10) };
  }

  async run({ radiohostId, virtualPersonId, window } = {}) {
    radiohostId = virtualPersonId || radiohostId;
    if (!radiohostId || typeof radiohostId !== 'string') {
      throw new ServiceError(400, 'radiohostId required', 'invalid_radiohost');
    }
    if (window !== 'short' && window !== 'long') {
      throw new ServiceError(400, "window must be 'short' or 'long'", 'invalid_window');
    }
    const station = this.getStation?.();
    const reflection = station?.getReflectionAgent?.();
    if (!reflection) throw new ServiceError(503, 'ReflectionAgent not available', 'reflection_unavailable');
    if (radiohostId !== 'lunara' && !station.virtualPersonRegistry?.get?.(radiohostId) && !station.getRadiohostMetadata?.(radiohostId)) {
      throw new ServiceError(400, `unknown radiohostId: ${radiohostId}`, 'unknown_radiohost');
    }
    if (reflection.isInflight(radiohostId, window)) {
      throw new ServiceError(409, `reflection already in flight for ${radiohostId}/${window}`, 'reflection_inflight');
    }
    const insight = await reflection.runManual(radiohostId, window);
    return insight
      ? { ok: true, ran: true, insight }
      : { ok: true, ran: false, reason: 'no-data-or-llm-failed' };
  }

  /** Manual taste-schema distillation; bypasses the once-per-day gate. */
  async distillSchema({ radiohostId, virtualPersonId } = {}) {
    const personId = virtualPersonId || radiohostId || null;
    const station = this.getStation?.();
    if (!station) throw new ServiceError(503, 'station not available', 'station_unavailable');
    if (personId && personId !== 'lunara' && !station.virtualPersonRegistry?.get?.(personId) && !station.getRadiohostMetadata?.(personId)) {
      throw new ServiceError(400, `unknown personId: ${personId}`, 'unknown_person');
    }
    const { runTasteSchemaDistill } = await import('../scheduler.js');
    const result = await runTasteSchemaDistill({ personIds: personId ? [personId] : null, manual: true });
    const failed = (result.results || []).filter(entry => !entry.ok
      && !['ALREADY_TODAY', 'SCHEMA_REVOKED'].includes(entry.code));
    if (personId && failed.length) throw new ServiceError(502, `distill failed: ${failed[0].code}`, 'distill_failed');
    return result;
  }
}
