import { randomUUID } from 'node:crypto';
import { selectionSignature } from '../program/musicSelectionRequest.js';

/**
 * Bounded preparation for actual listening demand. Never creates turns, speech or feedback.
 *
 * 预热（prepared）现在是“同一主 Agent 的受限任务”：`prepare` 回调把一次
 * preparation 运行交给 RadioRequestService（它驱动受限运行器并把结果落成可采用的
 * 批次）。定时/事件触发的 `refresh()` 只是**有界兜底**；权威触发点是 runtime 的
 * 低队列检测（REQUEST_CONTINUATION 路径），由组合根直接调用预热入口。
 * 这里的 `select` 分支保留给旧调用方（只产候选、不提交）。
 */
export class WarmPoolService {
  constructor({ select = null, prepare = null, getActiveDemand = () => null, intervalMin = 8,
    disabled = process.env.WARM_POOL_DISABLED === '1', now = Date.now } = {}) {
    Object.assign(this, { select, prepare, getActiveDemand, intervalMin, disabled, now });
    this.entries = new Map();
    this.running = null;
    this.timer = null;
    this.getPreparedStats = null;
    this.invalidatePrepared = null;
    this.stats = { hits: 0, misses: 0, generated: 0, consumed: 0, discarded: 0, failures: 0, mismatches: 0, selectionCalls: 0, modelCalls: 0, lastPreparationMs: 0 };
  }

  /** 由 MusicSelectionService 在 `service.pool = this` 时自动接线（统计 + 失效）。 */
  attachPreparedSource({ stats = null, invalidate = null } = {}) {
    if (typeof stats === 'function') this.getPreparedStats = stats;
    if (typeof invalidate === 'function') this.invalidatePrepared = invalidate;
    return this;
  }

  /** 预热可由 runner 执行（prepare），也可由旧候选供给执行（select）；两者都没有才算停用。 */
  get preparationSource() {
    return this.prepare || this.select || null;
  }

  async initialize() {
    if (!this.disabled && !this.timer && this.intervalMin > 0) {
      this.timer = setInterval(() => { void this.refresh(); }, this.intervalMin * 60_000);
      this.timer.unref?.();
    }
    return this;
  }

  shutdown() {
    clearInterval(this.timer);
    this.timer = null;
    this.running?.controller.abort();
    this.running = null;
    this.entries.clear();
  }

  invalidate({ sessionId = null } = {}) {
    for (const [id, entry] of this.entries) {
      if (!sessionId || entry.sessionId === sessionId) { this.entries.delete(id); this.stats.discarded++; }
    }
    if (!sessionId || this.running?.sessionId === sessionId) this.running?.controller.abort();
    // 记忆/标签/曲库/成员变化同样作废未采用的预热批次（单次使用，不可复活）。
    this.invalidatePrepared?.({ sessionId });
  }

  prune() {
    for (const [id, entry] of this.entries) {
      if (this.now() - entry.createdAt > Math.max(1, this.intervalMin) * 120_000) {
        this.entries.delete(id);
        this.stats.discarded++;
      }
    }
  }

  async refresh() {
    if (this.disabled || !this.preparationSource) return { skipped: 'disabled' };
    this.prune();
    const demand = this.getActiveDemand();
    if (!demand) { this.running?.controller.abort(); return { skipped: 'no-active-demand' }; }
    const signature = selectionSignature(demand.request, demand.context);
    if (this.running?.signature === signature) return { skipped: 'already-preparing' };
    if (this.running) { this.running.controller.abort(); return { skipped: 'cancelling-previous-demand' }; }
    // One background call at a time. A changed demand cancels the old generation.
    const run = { signature, sessionId: demand.context.sessionId, controller: new AbortController() };
    this.running = run;
    this.stats.selectionCalls++;
    const startedAt = this.now();
    try {
      if (this.prepare) {
        // 预热批次：一次受限 Agent 任务，产出挂起到边界采用；不提交、不触碰播放器。
        this.stats.modelCalls++;
        const prepared = await this.prepare({ request: demand.request, context: demand.context,
          signal: run.controller.signal, reason: 'auto_continue' });
        if (run.controller.signal.aborted || this.running !== run) return { skipped: 'cancelled' };
        if (!prepared?.ok || !prepared?.preparedId) {
          // 已有仍然有效的待采用批次不是失败：去重闸门挡下的第二个模型任务如实标记为跳过。
          if (prepared?.code === 'PREPARATION_ALREADY_HELD') {
            return { skipped: 'already-held', preparedId: prepared.preparedId || null };
          }
          if (prepared?.code === 'PREPARATION_IN_FLIGHT') return { skipped: 'already-preparing' };
          this.stats.failures++;
          return { ok: false, code: prepared?.code || 'PREPARATION_FAILED' };
        }
        this.stats.generated++;
        return { ok: true, preparedId: prepared.preparedId, offerId: prepared.offerId || null };
      }
      const selection = await this.select(demand.request, { ...demand.context, signal: run.controller.signal, background: true,
        onModelCall: () => { this.stats.modelCalls++; } });
      if (run.controller.signal.aborted || this.running !== run) return { skipped: 'cancelled' };
      const current = this.getActiveDemand();
      if (!current || selectionSignature(current.request, current.context) !== signature) return { skipped: 'demand-changed' };
      if (!selection?.ok || !selection.candidates?.length) { this.stats.failures++; return { ok: false }; }
      // Store candidates and the contract only, never persona/memory prompt material or synthesized speech.
      const entry = { id: randomUUID(), signature, sessionId: demand.context.sessionId,
        personId: demand.context.virtualPersonId, createdAt: this.now(), reserved: false,
        selection: { ok: true, request: selection.request, candidates: selection.candidates, signature } };
      this.entries.set(entry.id, entry);
      this.stats.generated++;
      while (this.entries.size > 3) { this.entries.delete(this.entries.keys().next().value); this.stats.discarded++; }
      return { ok: true, id: entry.id };
    } catch {
      if (!run.controller.signal.aborted) this.stats.failures++;
      return { ok: false };
    } finally {
      this.stats.lastPreparationMs = this.now() - startedAt;
      if (this.running === run) this.running = null;
    }
  }

  reserve(request, context) {
    if (this.disabled) return null;
    this.prune();
    const signature = selectionSignature(request, context);
    const entry = [...this.entries.values()].find(item => item.signature === signature && !item.reserved);
    if (!entry) {
      this.stats.misses++;
      if ([...this.entries.values()].some(item => item.sessionId === context.sessionId)) this.stats.mismatches++;
      return null;
    }
    entry.reserved = true;
    this.stats.hits++;
    return { id: entry.id, selection: structuredClone(entry.selection) };
  }

  release(id, { discard = false } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (discard) { this.entries.delete(id); this.stats.discarded++; }
    else entry.reserved = false;
  }

  consume(id) {
    if (this.entries.delete(id)) this.stats.consumed++;
  }

  /** 既有 status 形状保持兼容，预热统计并入 stats.prepared（JSON 可序列化）。 */
  getStatusSnapshot() {
    this.prune();
    return { enabled: !this.disabled, intervalMin: this.intervalMin,
      stats: { ...this.stats, prepared: this.getPreparedStats?.() || null },
      preparingConversationId: this.running?.sessionId || null,
      recentSets: [...this.entries.values()].map(entry => ({ id: entry.id, conversationId: entry.sessionId,
        radiohostId: entry.personId, mode: entry.selection.request.mode, reserved: entry.reserved,
        createdAt: entry.createdAt, songs: entry.selection.candidates.map(candidate => ({ q: candidate.query })) })) };
  }
}
