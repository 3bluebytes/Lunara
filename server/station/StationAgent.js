// Station owns platform services and legacy radiohost registry metadata. People and rooms are routed by VirtualPersonRuntime.
import {
  MemoryService
} from '../memory/MemoryService.js';
import {
  MemoryType,
  MemorySource,
  createMemoryRecord,
  DEFAULT_NAMESPACE,
  radiohostNamespace
} from '../memory/types.js';
import {
  MemoryConsolidator
} from '../memory/MemoryConsolidator.js';
import * as VoiceDirectory from './VoiceDirectory.js';
import { createRadioHost, RadioHostRegistry } from './RadioHost.js';
import { generatePersona, personaToMarkdown } from './PersonaGenerator.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePersonaRoot } from '../runtimePaths.js';
import { buildDefaultPersonaRecords } from '../memory/seedPersonaMemory.js';
import { trace } from '../trace.js';

import { createBus } from './communication/AgentMessageBus.js';
import { ReflectionAgent } from './ReflectionAgent.js';
import { WarmPoolService } from '../agents/WarmPoolService.js';
import { EventType, StationAgentId, createEvent } from './communication/messages.js';
import { memoryApplies } from '../memory/memoryPolicy.js';
import { isMemoryRevoked } from '../memory/memoryProvenance.js';

export class StationAgent {
  /**
   * @param {object} [opts]
   * @param {object} [opts.bus] - AgentMessageBus; one is created if omitted.
   */
  constructor(opts = {}) {
    this.stationMemory = null; // MemoryService for 'station' namespace
    this.registry = new RadioHostRegistry();
    this.bus = opts.bus || createBus();
    this.virtualPersonRegistry = opts.virtualPersonRegistry || null;
    /** @type {Map<string, MemoryService>} */
    this._radiohostMemoryCache = new Map();
    this._initialized = false;
    this._activeTasteSources = new Map();
    /** @type {ReflectionAgent|null} 站点级反思 agent（add-reflection-layer change） */
    this._reflectionAgent = null;
    /** @type {WarmPoolService|null} v2 预热池（memory-system-v2 change） */
    this._warmPool = null;
  }

  async initialize() {
    if (this._initialized) return this;

    // 1. Station memory
    this.stationMemory = new MemoryService('station');
    await this.stationMemory.initialize();

    // 2. VoiceDirectory
    VoiceDirectory.initialize();

    // 3. RadioHost registry
    this.registry.initialize();

    // 6. Create default radiohost if none exists
    if (this.registry.count() === 0) {
      await this._createDefaultRadiohost();
    }

    // 9. ReflectionAgent — 带外反思（add-reflection-layer change）
    //    必须放在伙伴注册之后；REFLECTION_AGENT_DISABLED=1 时 initialize 内部会跳过订阅。
    try {
      this._reflectionAgent = new ReflectionAgent({ bus: this.bus, station: this });
      await this._reflectionAgent.initialize();
    } catch (e) {
      console.warn('[station] ReflectionAgent init failed (non-fatal):', e.message);
      this._reflectionAgent = null;
    }

    // Selection and active listening demand are bound by the application composition.
    try {
      this._warmPool = new WarmPoolService({
        intervalMin: parseInt(process.env.WARM_POOL_INTERVAL_MIN || '8', 10),
        disabled: process.env.WARM_POOL_DISABLED === '1',
      });
      await this._warmPool.initialize();
    } catch (e) {
      console.warn('[station] WarmPoolService init failed (non-fatal):', e.message);
      this._warmPool = null;
    }

    this._initialized = true;
    return this;
  }

  isInitialized() { return this._initialized; }

  /**
   * 站点级 ReflectionAgent 访问器（station-agent spec 新增要求）。
   * HTTP 层用它来实现 /api/reflection/status 和 /api/reflection/run，避免穿透私有字段。
   */
  getReflectionAgent() {
    return this._reflectionAgent;
  }

  /**
   * 站点级 WarmPoolService 访问器（v2: memory-system-v2 change）。
   * HTTP 层用它来实现 /api/warmpool/status 和 /api/warmpool/refresh。
   */
  getWarmPoolService() {
    return this._warmPool;
  }

  setActiveTasteSource(provider, accountUid) {
    this._activeTasteSources.set(String(provider), String(accountUid));
  }

  isStationSeedActive(record) {
    const tags = String(record?.tags || '').split(',').map(tag => tag.trim());
    if (!tags.includes('taste_bootstrap')) return true;
    const providerTag = tags.find(tag => tag.startsWith('provider:'));
    const accountTag = tags.find(tag => tag.startsWith('account_uid:'));
    if (!providerTag || !accountTag) return false;
    const provider = providerTag.slice('provider:'.length);
    const activeUid = this._activeTasteSources.get(provider);
    return activeUid != null && accountTag === `account_uid:${encodeURIComponent(activeUid)}`;
  }

  /**
   * 清理 station 持有的订阅与定时器。测试和未来的优雅退出会用到。
   */
  async shutdown() {
    if (this._reflectionAgent) {
      try { this._reflectionAgent.shutdown(); } catch (e) { console.warn('[station] reflection shutdown error:', e.message); }
      this._reflectionAgent = null;
    }
    if (this._warmPool) {
      try { this._warmPool.shutdown(); } catch (e) { console.warn('[station] warmpool shutdown error:', e.message); }
      this._warmPool = null;
    }
    for (const memoryService of this._radiohostMemoryCache.values()) {
      try { await memoryService.shutdown?.(); } catch (e) { console.warn('[station] radiohost memory shutdown error:', e.message); }
    }
    this._radiohostMemoryCache.clear();
    if (this.stationMemory) {
      try { await this.stationMemory.shutdown?.(); } catch (e) { console.warn('[station] station memory shutdown error:', e.message); }
      this.stationMemory = null;
    }
    try { this.registry.close?.(); } catch (e) { console.warn('[station] registry shutdown error:', e.message); }
    this._initialized = false;
  }

  activateRadiohost(radiohostId, correlationId) {
    // Compatibility metadata for legacy endpoints. Conversation routing owns the actual speaker.
    trace(`station.activateRadiohost: radiohostId=${radiohostId}`);
    const r = this._activateRadiohostImpl(radiohostId);
    if (r) {
      this.bus.publishEvent(createEvent({
        type: EventType.RADIOHOST_ACTIVATED,
        sourceAgentId: StationAgentId,
        payload: { radiohostId: r.current?.id || radiohostId, previousRadiohostId: r.previous || null },
        correlationId,
      }));

    }
    return r;
  }

  /**
   * Delete a radiohost and all its memories.
   * @param {string} radiohostId
   * @returns {Promise<boolean>} true if deleted
   */
  async deleteRadioHost(radiohostId) {
    trace(`station.deleteRadioHost: radiohostId=${radiohostId}`);
    const host = this.registry.get(radiohostId);
    if (!host) return false;
    // Deactivate if active
    if (host.status === 'active') {
      this._deactivateRadiohostImpl(radiohostId);
    }
    // Delete all memories for this radiohost's namespace
    const radiohostMem = this._radiohostMemoryCache.get(radiohostId);
    if (radiohostMem) {
      const deleted = radiohostMem.store.deleteByNamespace(host.namespace);
      trace(`station.deleteRadioHost: deleted ${deleted} memories from namespace=${host.namespace}`);
      await radiohostMem.shutdown?.();
      this._radiohostMemoryCache.delete(radiohostId);
    }
    // Remove from registry
    this.registry.unregister(radiohostId);
    trace(`station.deleteRadioHost: done`);
    return true;
  }

  getActiveRadiohost() {
    return this.registry.getActive();
  }

  listRadioHosts() {
    return this.registry.list();
  }

  getRadiohostMetadata(id) {
    return this.registry.get(id);
  }

  // ===================== Station Memory =====================

  /**
   * Add a global preference to station memory.
   * Publishes STATION_MEMORY_UPDATED on success.
   */
  addStationMemory(content, source, tags) {
    const rec = createMemoryRecord(MemoryType.SEMANTIC, {
      namespace: DEFAULT_NAMESPACE,
      content,
      source: source || MemorySource.USER_EXPLICIT_FEEDBACK,
      tags: Array.isArray(tags) ? tags.join(',') : tags,
    });
    const r = this.stationMemory.addMemory(rec);
    if (r.ok) {
      this.bus.publishEvent(createEvent({
        type: EventType.STATION_MEMORY_UPDATED,
        sourceAgentId: StationAgentId,
        payload: { memoryIds: [r.id], cause: 'manual' },
      }));
    }
    return r;
  }

  getStationMemory(opts = {}) {
    return this.stationMemory.searchMemory(opts.query, {
      type: opts.type || MemoryType.SEMANTIC,
      tags: opts.tags,
      limit: opts.limit || 50,
      minConfidence: opts.minConfidence,
    }).filter(row => this.isStationSeedActive(row) && memoryApplies(row) && !isMemoryRevoked(this.stationMemory.store, row));
  }

  stationStats() {
    return this.stationMemory.stats();
  }

  // ===================== RadioHost Memory Helpers =====================

  /**
   * Get the cached MemoryService for a specific radiohost. Initialized lazily.
   */
  async getRadioHostMemoryService(radiohostId) {
    const host = this.registry.get(radiohostId);
    if (!host) return null;
    let svc = this._radiohostMemoryCache.get(radiohostId);
    if (!svc) {
      svc = new MemoryService(host.namespace);
      await svc.initialize();
      this._radiohostMemoryCache.set(radiohostId, svc);
    }
    return svc;
  }



  getRadiohostRegistrySummary() {
    return this.registry.list().map(h => ({
      id: h.id,
      name: h.name,
      voiceProfileId: h.voiceProfileId,
      status: h.status,
      memoryStats: h.memoryStats,
    }));
  }

  async createRadioHost(opts) {
    const { voiceProfileId, personaPresetId, personaHint, personaDraft, displayName, correlationId } = opts;

    // 声音仍要校验存在，但它**只决定怎么念，不参与人格**。
    const voiceProfile = VoiceDirectory.getVoiceProfile(voiceProfileId);
    if (!voiceProfile) throw new Error(`Voice profile not found: ${voiceProfileId}`);

    // 人格来源只有预令人设、调用方 Agent 的草稿与用户描述，不传 voiceProfile。
    const persona = await generatePersona({ personaPreset: personaPresetId, personaHint, personaDraft });

    // 名字不得从声音推导（spec：name MUST NOT be derived from a voice）。
    // persona.name 由预令人设候选/用户描述构造，恒非空。
    const name = displayName || persona.name;
    const host = createRadioHost({
      id: opts.id,
      voiceProfileId,
      name,
      status: 'inactive',  // 只注册不激活 —— 激活由显式的 activateRadiohost 负责
    });

    this.registry.register(host);

    // Persona is stored separately. Shared preferences are read by reference at each turn.
    const radiohostMemory = new MemoryService(host.namespace);
    await radiohostMemory.initialize();
    this._radiohostMemoryCache.set(host.id, radiohostMemory);

    try {
      const personaDir = resolve(resolvePersonaRoot(), host.id);
      mkdirSync(personaDir, { recursive: true });
      const personaPath = resolve(personaDir, 'persona.md');
      if (!existsSync(personaPath)) {
        const markdown = personaToMarkdown(persona, host.name);
        writeFileSync(personaPath, markdown, 'utf8');
        trace(`[station] persona.md written: ${personaPath}`);
      } else {
        trace(`[station] persona.md already exists for ${host.id}, preserving user's edits`);
      }
    } catch (e) {
      console.warn(`[station] persona.md write failed for ${host.id}: ${e.message}`);
    }

    // 3) Refresh registry stats
    // v2: persona 不在 DB 里，stats 里 persona 字段固定为 1（如 markdown 存在）或 0
    const stats = radiohostMemory.stats();
    const personaExists = (() => {
      try { return existsSync(resolve(resolvePersonaRoot(), host.id, 'persona.md')); }
      catch { return false; }
    })();
    this.registry.updateStats(host.id, {
      persona: personaExists ? 1 : 0,
      semantic: stats.semantic || 0,
      episodic: stats.episodic || 0,
      working: stats.working || 0,
    });

    this.bus.publishEvent(createEvent({ type: EventType.RADIOHOST_CREATED, sourceAgentId: StationAgentId,
      payload: { radiohostId: host.id, name: host.name, voiceProfileId }, correlationId }));

    return this.registry.get(host.id);
  }

  _activateRadiohostImpl(radiohostId) {
    const prev = this.registry.getActive();
    const next = this.registry.setActive(radiohostId);
    if (!next) return null;
    return { previous: prev?.id || null, current: next };
  }

  _deactivateRadiohostImpl(radiohostId) {
    const host = this.registry.get(radiohostId);
    if (!host) return null;
    if (host.status === 'active') {
      host.status = 'inactive';
      host.updatedAt = Date.now();
      this.registry.register(host);
    }
    return host;
  }

  async _createDefaultRadiohost() {
    const vp = VoiceDirectory.getVoiceProfile('vp_radio_host') ||
               VoiceDirectory.getVoiceProfile('Chinese (Mandarin)_Radio_Host') ||
               VoiceDirectory.listVoiceProfiles()[0] || null;

    if (!vp) {
      // No voice profile available — minimal local host, initialize its own default persona.
      const host = createRadioHost({
        id: 'default',
        voiceProfileId: '',
        name: 'Lunara',
        status: 'inactive',
      });
      this.registry.register(host);

      const radiohostMemory = new MemoryService(host.namespace);
      await radiohostMemory.initialize();
      this._radiohostMemoryCache.set(host.id, radiohostMemory);

      const defaultRecords = buildDefaultPersonaRecords(host.namespace);
      for (const record of defaultRecords) radiohostMemory.addMemory(record);

      const stats = radiohostMemory.stats();
      this.registry.updateStats(host.id, {
        persona: defaultRecords.length,
        semantic: stats.semantic || 0,
        episodic: stats.episodic || 0,
        working: stats.working || 0,
      });
      return;
    }

    await this.createRadioHost({
      voiceProfileId: vp.id,
      personaPresetId: 'retro_broadcaster',
      displayName: 'Lunara',
      personaHint: '',
    });
  }
}
