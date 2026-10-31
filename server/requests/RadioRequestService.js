import { randomUUID } from 'node:crypto';
import { effectiveRadioMode } from '../playback/PlaybackRuntime.js';
import { continuationSelection, normalizeMusicSelection } from '../program/musicSelectionRequest.js';
import { CONTINUATION_BATCH_SIZE } from '../program/continuationBudget.js';
import { roomCurator } from '../virtual-person/roomCurator.js';

const PREPARABLE_PHASES = ['playing', 'loading', 'awaiting_intro', 'paused'];

/** HTTP and continuation boundary. User language belongs to the conversation AgentLoop. */
export class RadioRequestService {
  constructor({ conversationService, musicService, playbackRuntime, conversationStore, getMusicSelectionAgent = null,
    sessionTrace = null, isPersonAvailable = () => true } = {}) {
    Object.assign(this, { conversationService, musicService, playbackRuntime, conversationStore, getMusicSelectionAgent, sessionTrace,
      isPersonAvailable });
    // 同一会话+输出代次一次只跑一个预热任务：权威触发点（runtime 低队列）与兜底
    // 刷新可能同时到达，重复的模型任务在这里被挡住，而不是靠调用方自觉。
    this.preparing = new Set();
    // 正在被实时任务解析的续播边界（会话:输出代次:边界 → 计数）。预热据此判断
    // 当前边界是否已经有实时任务在跑：有则为下一个边界准备，绝不绑定正在解析的边界。
    this.liveContinuations = new Map();
  }

  handleChat(input = {}) { return this.conversationService.handleChat(input); }

  /**
   * 续选/预热由谁来选：房间此刻的主持人（实时读，设置里改了下一次就换人）。
   * listeningPlan.curatorId 只是这份计划当初由谁发起的历史归属，不再决定续选人；
   * 否则群聊里某位成员的一次推荐会让她接管之后全部的自动续播。
   */
  _curatorOf(room) {
    return roomCurator(room, id => this.isPersonAvailable(id) === true);
  }

  preparationDemand() {
    const state = this.playbackRuntime.snapshot();
    if (!effectiveRadioMode(state) || !state.listeningPlan || !['playing', 'loading', 'awaiting_intro', 'paused'].includes(state.phase)) return null;
    try {
      const virtualPersonId = this._curatorOf(this.conversationStore.getSession(state.activeListeningSessionId));
      if (!virtualPersonId) return null;
      return { request: continuationSelection(state.listeningPlan.request,
        { previousTrack: state.queue[state.currentIndex] || null }), context: this.musicService.context({
        sessionId: state.activeListeningSessionId, virtualPersonId,
      }) };
    } catch { return null; }
  }

  async handleContinue({ sessionId, requestId, outputGeneration, signal, isCurrent } = {}) {
    signal?.throwIfAborted();
    const state = this.playbackRuntime.snapshot();
    if (!sessionId || sessionId !== state.activeListeningSessionId || outputGeneration !== state.outputGeneration
      || !effectiveRadioMode(state)) return { ok: false, code: 'STALE_CONTINUATION' };
    // 实时任务在跑期间，预热必须为“下一个边界”准备：登记这段在飞边界，供预热查询。
    const key = this._liveContinuationKey(sessionId, state.outputGeneration, state.pendingContinuation?.boundaryKey ?? null);
    this.liveContinuations.set(key, (this.liveContinuations.get(key) || 0) + 1);
    try {
      return await this._select(state, { sessionId, requestId, reason: 'auto_continue', outputGeneration, signal, isCurrent });
    } finally {
      const remaining = (this.liveContinuations.get(key) || 1) - 1;
      if (remaining > 0) this.liveContinuations.set(key, remaining);
      else this.liveContinuations.delete(key);
    }
  }

  _liveContinuationKey(sessionId, generation, boundaryKey) {
    return `${sessionId}:${generation}:${boundaryKey ?? ''}`;
  }

  _liveContinuationInFlight(sessionId, generation, boundaryKey) {
    if (boundaryKey == null) return false;
    return this.liveContinuations.has(this._liveContinuationKey(sessionId, generation, boundaryKey));
  }

  handleNext({ sessionId, requestId, delivery } = {}) {
    const state = this.playbackRuntime.snapshot();
    return this._select(state, { sessionId: sessionId || state.activeListeningSessionId, requestId, reason: 'user_request', delivery });
  }

  /**
   * 预热入口：软件 runtime 检测到本聊天待播歌曲不够（正是今天发起续播的那条
   * `REQUEST_CONTINUATION` 路径）时调用。它跑同一个受限 Agent 任务（同一个
   * AgentLoop、同样两个选歌工具），只是 mode='preparation'：把接下来要放的歌
   * 提前挂起为可采用的批次，等播到边界时直接采用，不再发起模型调用。
   *
   * 预热永远面向**下一个边界**：从续播边界钩子触发（boundaryInFlight）或当前
   * 边界已有实时任务在跑时，批次记录为 NULL 边界（接受第一个到来的边界），绝不
   * 记录实时任务正在解析的那个边界；同一 (会话, 输出代次) 已有待采用批次时不重复
   * 发起第二个模型任务。
   *
   * 这里是纯准备：不提交、不触碰播放器，当前歌曲照常播放。运行器缺失或任务
   * 失败都如实返回，不写任何用户可见文案。
   */
  async prepareContinuation({ signal = null, isCurrent = null, requestId = null, reason = 'auto_continue',
    sessionTrace = null, boundaryInFlight = null } = {}) {
    signal?.throwIfAborted();
    const state = this.playbackRuntime.snapshot();
    const sessionId = state.activeListeningSessionId;
    if (!sessionId || !effectiveRadioMode(state) || !PREPARABLE_PHASES.includes(state.phase)) {
      return { ok: false, code: 'NO_ACTIVE_DEMAND' };
    }
    const preparingKey = `${sessionId}:${state.outputGeneration}`;
    if (this.preparing.has(preparingKey)) return { ok: false, code: 'PREPARATION_IN_FLIGHT' };
    const room = this.conversationStore.getSession(sessionId);
    if (!room || room.archivedAt) return { ok: false, code: 'CONVERSATION_UNAVAILABLE' };
    // 去重闸门：同一代次已经有待采用批次时不再跑第二个预热任务（批次要么被下一个
    // 边界采用，要么在采用失败时作废，之后才能重新预热）。
    const virtualPersonId = this._curatorOf(room);
    // 房间里没有可用成员：不替任何人选歌。
    if (!virtualPersonId) return { ok: false, code: 'CONVERSATION_UNAVAILABLE' };
    const held = typeof this.musicService?.readyPrepared === 'function'
      ? this.musicService.readyPrepared({ sessionId, personId: virtualPersonId, outputGeneration: state.outputGeneration })
      : null;
    if (held) return { ok: false, code: 'PREPARATION_ALREADY_HELD', preparedId: held.preparedId, boundaryKey: held.boundaryKey };
    this.preparing.add(preparingKey);
    try {
      return await this._prepareContinuation({ state, sessionId, signal, isCurrent, requestId, reason, sessionTrace, boundaryInFlight });
    } finally {
      this.preparing.delete(preparingKey);
    }
  }

  async _prepareContinuation({ state, sessionId, signal = null, isCurrent = null, requestId = null,
    reason = 'auto_continue', sessionTrace = null, boundaryInFlight = null } = {}) {
    const room = this.conversationStore.getSession(sessionId);
    if (!room || room.archivedAt) return { ok: false, code: 'CONVERSATION_UNAVAILABLE' };
    const listening = this.playbackRuntime.listeningSnapshot(sessionId);
    const plan = listening.listeningPlan;
    const generation = state.outputGeneration;
    // 预热面向“下一个边界”，不绑定正在被解析的边界：
    // - 边界钩子显式告知在飞边界（runtime 的 REQUEST_CONTINUATION 处理里同时发起
    //   实时任务与预热）；
    // - 或者服务自己看到该边界已有实时任务在跑（兜底刷新与实时任务重叠）。
    // 两种情况都记录 NULL：现有设计里 NULL = 接受第一个到来的边界。
    const pendingBoundaryKey = state.pendingContinuation?.boundaryKey ?? null;
    const resolvedBoundary = boundaryInFlight != null
      ? String(boundaryInFlight)
      : (this._liveContinuationInFlight(sessionId, generation, pendingBoundaryKey) ? String(pendingBoundaryKey) : null);
    const boundaryKey = pendingBoundaryKey != null && String(pendingBoundaryKey) === resolvedBoundary ? null : pendingBoundaryKey;
    const previousTrack = listening.currentIndex >= 0 ? listening.queue[listening.currentIndex] || null : null;
    const request = normalizeMusicSelection(plan ? continuationSelection(plan.request, { previousTrack })
      : { mode: 'discovery', delivery: 'append', count: CONTINUATION_BATCH_SIZE });
    const runner = typeof this.getMusicSelectionAgent === 'function' ? this.getMusicSelectionAgent() : this.getMusicSelectionAgent;
    if (!runner || typeof runner.run !== 'function') {
      return { ok: false, code: 'MUSIC_SELECTION_UNAVAILABLE', message: '本机没有可用的自动选歌运行器。' };
    }
    const virtualPersonId = this._curatorOf(room);
    // 房间里没有可用成员：不替任何人选歌。
    if (!virtualPersonId) return { ok: false, code: 'CONVERSATION_UNAVAILABLE' };
    const guard = () => {
      if (signal?.aborted || (isCurrent && !isCurrent())) return false;
      const current = this.playbackRuntime.snapshot();
      return current.activeListeningSessionId === sessionId && current.outputGeneration === generation
        && effectiveRadioMode(current);
    };
    const result = await runner.run({
      request, reason, sessionId, signal, isCurrent: guard, mode: 'preparation',
      sessionTrace: sessionTrace || this.sessionTrace,
      context: {
        requestId: requestId || `prewarm:${randomUUID()}`,
        virtualPersonId,
        outputGeneration: generation,
        preparedFor: { listeningSessionId: sessionId, outputGeneration: generation, boundaryKey },
      },
    });
    signal?.throwIfAborted();
    if (!result?.ok || !result.offerId || typeof this.musicService?.savePreparedBatch !== 'function') {
      return { ...result, boundaryKey };
    }
    const saved = this.musicService.savePreparedBatch({
      offerId: result.offerId,
      indexes: result.indexes || result.offeredIndexes || null,
      sessionId, personId: virtualPersonId,
      // 提前量位置（用于诊断与“批次是在队列哪一版准备的”核对）。
      position: { queueVersion: listening.queueVersion, queueLength: listening.queue.length,
        currentIndex: listening.currentIndex ?? -1, phase: state.phase },
    });
    return { ...result, preparedId: saved?.preparedId || null, prepared: saved?.ok === true, boundaryKey };
  }

  /**
   * 自动续播/手动下一首都先看本会话有没有可采用的预热批次：命中就直接用同一套
   * canonical 解析 + 硬约束校验提交，**零模型调用、零 Agent 运行**；没有命中才
   * 进入受限选歌 Agent 运行器。两条路径共用同一份身份守卫与任务锁定。
   */
  async _select(state, { sessionId, requestId = `music:${randomUUID()}`, reason, outputGeneration, delivery, signal, isCurrent }) {
    const generation = state.outputGeneration;
    const boundaryKey = state.pendingContinuation?.boundaryKey ?? null;
    const room = this.conversationStore.getSession(sessionId);
    if (!room || room.archivedAt) return { ok: false, code: 'CONVERSATION_UNAVAILABLE' };
    const listening = this.playbackRuntime.listeningSnapshot(sessionId);
    const plan = listening.listeningPlan;
    const previousTrack = listening.currentIndex >= 0 ? listening.queue[listening.currentIndex] || null : null;
    const base = plan ? continuationSelection(plan.request, { previousTrack })
      : normalizeMusicSelection({ mode: 'discovery',
        // 续播永远是追加：提前续选发起时队列里还有正在播的歌，replace_now
        // 会清掉队列打断它；耗尽边界追加也不影响激活第一首新歌。
        delivery: reason === 'auto_continue' ? 'append' : 'replace_now', count: CONTINUATION_BATCH_SIZE });
    const request = delivery ? normalizeMusicSelection({ ...base, delivery }) : base;
    const guard = () => {
      if (signal?.aborted || (isCurrent && !isCurrent())) return false;
      if (reason !== 'auto_continue') return true;
      const current = this.playbackRuntime.snapshot();
      return current.activeListeningSessionId === sessionId && current.outputGeneration === generation
        && effectiveRadioMode(current) && current.pendingContinuation?.boundaryKey === (boundaryKey ?? undefined);
    };
    // 没有预热能力的服务（旧装配/测试替身）保持同步进入运行器，不额外引入等待。
    const virtualPersonId = this._curatorOf(room);
    // 房间里没有可用成员：不替任何人选歌。
    if (!virtualPersonId) return { ok: false, code: 'CONVERSATION_UNAVAILABLE' };
    const preparedAdoption = typeof this.musicService?.consumePrepared === 'function' && request.delivery !== 'recommend_only'
      ? await this._adoptPrepared({ request, sessionId, virtualPersonId, requestId, generation, boundaryKey,
        signal, guard, isCurrent })
      : null;
    if (preparedAdoption) return preparedAdoption;
    const runner = typeof this.getMusicSelectionAgent === 'function' ? this.getMusicSelectionAgent() : this.getMusicSelectionAgent;
    if (!runner || typeof runner.run !== 'function') {
      return { ok: false, code: 'MUSIC_SELECTION_UNAVAILABLE',
        message: '本机没有可用的自动选歌运行器，队列没有变化。' };
    }
    const result = await runner.run({
      request, reason, sessionId, signal, isCurrent: guard, mode: 'playback',
      sessionTrace: this.sessionTrace,
      context: {
        requestId,
        virtualPersonId,
        outputGeneration: generation,
        groupAction: null,
      },
    });
    signal?.throwIfAborted();
    if (isCurrent && !isCurrent()) return { ok: false, code: 'STALE_CONTINUATION' };
    return result;
  }

  /**
   * 边界先尝试采用预热批次。返回 null 表示没有可用批次（回落到实时选歌）；
   * 返回对象表示本次选择已经定论（成功或 fail closed 的失败）。
   */
  async _adoptPrepared({ request, sessionId, virtualPersonId, requestId, generation, boundaryKey,
    signal, guard = null, isCurrent = null }) {
    const consume = this.musicService?.consumePrepared;
    if (typeof consume !== 'function') return null;
    // 只推荐不播放：没有任何“采用后播放”的语义，预热批次也不该被用来交差。
    if (request.delivery === 'recommend_only') return null;
    signal?.throwIfAborted();
    // 采用前先用边界守卫核对：批次还没被消费，此刻的边界失配直接回落实时路径。
    if (guard && !guard()) {
      this.musicService?.notePrewarmFallback?.({ reason: 'stale-boundary' });
      return null;
    }
    let outcome;
    try {
      outcome = await consume.call(this.musicService, {
        request, sessionId, virtualPersonId, requestId, outputGeneration: generation, boundaryKey,
        // 提交侧的守卫仍然是边界感知的：边界在提交前消失就不提交。
        signal, isCurrent: guard,
        preparedAccept: { listeningSessionId: sessionId, outputGeneration: generation, boundaryKey, planRequest: request },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      // 采用本身出错：不假装没发生，也不在异常里悄悄换取一首；交由 runtime 的
      // 续播失败/有界重试路径处理，下次尝试自然走实时选歌。
      this.musicService?.notePrewarmFallback?.({ reason: 'error' });
      return { ok: false, code: String(error?.code || 'PREPARED_NOT_RESOLVED').slice(0, 80),
        message: '预热批次没有完成提交，队列没有变化。' };
    }
    if (!outcome || outcome.matched !== true) {
      this.musicService?.notePrewarmFallback?.({ reason: outcome?.reason || 'none' });
      return null;
    }
    if (outcome.ok !== true) return outcome.result;
    // 提交成功后边界被 runtime 正常清除，因此只再核对调用方的生命周期守卫。
    signal?.throwIfAborted();
    if (isCurrent && !isCurrent()) return { ok: false, code: 'STALE_CONTINUATION' };
    return outcome.result;
  }
}
