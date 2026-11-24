import { randomUUID } from 'node:crypto';
import { RequestState, createCommittedTurnEvent, createRequestId } from './VirtualPersonTypes.js';
import { ROOT_ID } from './VirtualPersonRegistry.js';
import { SessionTurnQueue } from './SessionTurnQueue.js';
import { planResponses, responseRequestId } from './responsePlan.js';
import { routingHistory, validResponsePlan } from './responseRouting.js';
import { createGroupFloor, floorBrief, floorCapabilities, revalidateInvitationEvidence } from './floorTools.js';
import { createFloorRun } from './floorRunner.js';
import { policyFromUserText } from '../memory/memoryPolicy.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';
import { createLineCollector } from '../program/trackLinePass.js';
import { ambientMemoryQuery, currentTrackOf } from '../presence/ambientTurn.js';
import { assertsPlayback, composeTerminalReply } from './committedLine.js';
import { stripPeerMarkers } from './peerMessage.js';
import { TIMEOUT_FAILURE_CODES, acceptedTerminal, classifyTurnFailure, safeFailure, safeOutcomeFallback, timeoutFallback, unsafeDiagnosticText } from './turnFailure.js';
import { TurnContextAssembler } from './TurnContextAssembler.js';
import { contextUsageRecorder } from './contextUsage.js';
import { FLOOR_LIMITS, GroupFloorResponses, settleMusicAuthority, turnFloorMetadata } from './groupFloorRound.js';
import { AmbientTurnRunner } from './AmbientTurnRunner.js';
import {
  DELIVER_REPLY_TOOL_NAME,
  REPLY_CAPABILITY,
  beatSpokenText,
  beatsToVisibleText,
  hasUnquotedStageDirection,
  normalizeReplyBeats,
  fallbackBeatsForPlainText,
} from './replyBeats.js';
import { parseRoleplaySegments } from './roleplaySpeech.js';

// Outcome codes whose turn hands the spoken channel to the track narration.
const VOICE_DELEGATED_TO_TRACK_NARRATION = new Set(['MUSIC_COMMITTED', 'NARRATION_REQUESTED']);
// 调用音乐/曲库工具时通知前端把长等待文案切换为真实挑歌阶段。
const MUSIC_PHASE_TOOLS = new Set([
  'select_music', 'commit_music_selection', 'search_music', 'search_library',
  'get_user_playlists', 'get_playlist_tracks',
]);
// 插话中止的原因：被用户的下一条消息顶掉，不是用户喊停。
const TURN_SUPERSEDED = 'TURN_SUPERSEDED';
function supersededReason() {
  return Object.assign(new Error('superseded by the next user message'), { name: 'AbortError', code: TURN_SUPERSEDED });
}
function isSuperseded(signal) {
  return Boolean(signal?.aborted) && signal.reason?.code === TURN_SUPERSEDED;
}
function defaultSessionId() {
  return 'conversation:default';
}

export class VirtualPersonRuntime {
  constructor({
    conversationStore,
    registry,
    promptAssembler,
    contextBudgeter,
    agentLoop,
    presentationService,
    turnQueue = new SessionTurnQueue(),
    retrieveMemories = async () => [],
    getRuntimeState = () => null,
    getEnvironment = null,
    getLifeContext = null,
    isLifeContextCurrent = null,
    capabilityResolver = () => [],
    onTurnCommitted = null,
    onActivity = null,
    basicPlaybackFallback = null,
    responsePlanner = null,
    // 会话执行记录门面（server/sessionTrace.js）。未注入时全部记录调用是 no-op。
    sessionTrace = null,
    webAccess = null,
    // 群聊追加回应（被邀请者 + A→B→A 的收尾）共用的剩余截止：第一位追加者开始时起算。
    floorBudgetMs = FLOOR_LIMITS.budgetMs,
    // ambient 推荐（add-ambient-music-recommendation）：闸门、暂存解析、同事务入账与确认。未注入时不推荐。
    ambientRecommendations = null,
    logger = console,
  } = {}) {
    if (!conversationStore) throw new TypeError('VirtualPersonRuntime requires conversationStore');
    if (!registry) throw new TypeError('VirtualPersonRuntime requires registry');
    if (!promptAssembler) throw new TypeError('VirtualPersonRuntime requires promptAssembler');
    if (!agentLoop) throw new TypeError('VirtualPersonRuntime requires agentLoop');
    if (!presentationService) throw new TypeError('VirtualPersonRuntime requires presentationService');
    this.conversationStore = conversationStore;
    this.registry = registry;
    this.promptAssembler = promptAssembler;
    this.contextBudgeter = contextBudgeter;
    this.agentLoop = agentLoop;
    this.presentationService = presentationService;
    this.turnQueue = turnQueue;
    this.userTurnListeners = new Set();
    this.roundSettledListeners = new Set();
    this.retrieveMemories = retrieveMemories;
    this.getRuntimeState = getRuntimeState;
    this.getEnvironment = typeof getEnvironment === 'function' ? getEnvironment : null;
    this.getLifeContext = typeof getLifeContext === 'function' ? getLifeContext : null;
    this.capabilityResolver = capabilityResolver;
    this.onTurnCommitted = typeof onTurnCommitted === 'function' ? onTurnCommitted : null;
    this.onActivity = typeof onActivity === 'function' ? onActivity : null;
    this.basicPlaybackFallback = typeof basicPlaybackFallback === 'function' ? basicPlaybackFallback : null;
    this.responsePlanner = typeof responsePlanner === 'function' ? responsePlanner : null;
    this.sessionTrace = sessionTrace;
    this.webAccess = webAccess;
    this.floorBudgetMs = Math.max(1, Number(floorBudgetMs) || FLOOR_LIMITS.budgetMs);
    this.ambientRecommendations = ambientRecommendations;
    this.logger = logger;
    this.initialized = false;
    this.controllers = new Map();
    // Includes queued turns so a fast interruption cannot miss a not-yet-started request.
    this.pendingTurns = new Map();
    // 进行中的 ambient turn（sessionId → AbortController）：用户一开口就中止。
    this.ambientControllers = new Map();
    this.presentationRounds = new Map();
    // 没有听众消息时的 host 活动（续播、预热、line pass）：不占回合队列，只让 ambient 知道她在忙。
    this.backgroundHostActivity = new Map();
    this.backgroundHostControllers = new Set();
    this.backgroundHostIdleWaiters = new Map();
    // 回窗问候的入场保留：只拦新后台活动，不计入 hostBusy，也不写播放状态。
    this.backgroundHostHolds = new Map();
    this.backgroundHostAdmissionWaiters = new Set();
    this.backgroundHostStopped = false;
    this.trackLinePass = null;
    this.contextAssembler = new TurnContextAssembler({ conversationStore, registry, promptAssembler, contextBudgeter,
      retrieveMemories, getRuntimeState, getEnvironment, getLifeContext, logger });
    this.floorResponses = new GroupFloorResponses({ conversationStore, registry, sessionTrace, floorBudgetMs: this.floorBudgetMs,
      runResponse: args => this._runResponse(args),
      notifyResponseCommitted: (input, response) => this._notifyResponseCommitted(input, response) });
    this.ambientTurns = new AmbientTurnRunner({ conversationStore, registry, agentLoop, turnQueue, getRuntimeState, sessionTrace,
      ambientRecommendations, isLifeContextCurrent, logger, controllers: this.ambientControllers, hostBusy: sessionId => this.hostBusy(sessionId),
      assembleContext: args => this.contextAssembler.assemble(args) });
  }

  initialize() {
    if (this.initialized) return this;
    this.registry.initialize();
    this.conversationStore.initialize();
    this.initialized = true;
    this.backgroundHostStopped = false;
    return this;
  }

  shutdown() {
    this.backgroundHostStopped = true;
    for (const controller of this.backgroundHostControllers) controller.abort(new Error('runtime shutdown'));
    this.backgroundHostHolds.clear();
    for (const wake of [...this.backgroundHostAdmissionWaiters]) wake();
    if (!this.initialized) return;
    for (const controller of this.controllers.values()) controller.abort();
    for (const turns of this.pendingTurns.values()) for (const entry of turns.values()) entry.controller.abort();
    for (const controller of this.ambientControllers.values()) controller.abort(new Error('runtime shutdown'));
    this.conversationStore.close?.();
    this.registry.close?.();
    this.initialized = false;
  }

  /** 组合根在 line pass 装好后接上（它依赖的素材源晚于 runtime 创建）。 */
  attachTrackLinePass(pass) {
    this.trackLinePass = pass;
  }

  /** 给启动/回窗问候预留入场；null 是首次可见前的全局保留。释放幂等，不中断已执行的工作。 */
  holdBackgroundHost(sessionId = null, { signal = null } = {}) {
    if (signal?.aborted || this.backgroundHostStopped) return () => {};
    const token = Symbol('foreground-host');
    this.backgroundHostHolds.set(token, sessionId == null ? null : String(sessionId));
    const release = () => {
      signal?.removeEventListener('abort', release);
      if (!this.backgroundHostHolds.delete(token)) return;
      for (const wake of [...this.backgroundHostAdmissionWaiters]) wake();
    };
    signal?.addEventListener('abort', release, { once: true });
    return release;
  }

  /** 后台先等问候保留释放，才登记为忙；等待中的取消/关停不会启动模型或占用 host。 */
  async acquireBackgroundHost(sessionId, { signal = null } = {}) {
    const sid = String(sessionId || '');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    this.backgroundHostControllers.add(controller);
    try {
      const held = () => [...this.backgroundHostHolds.values()].some(id => id == null || id === sid);
      while (held() && !controller.signal.aborted) {
        await new Promise(resolve => {
          const done = () => {
            this.backgroundHostAdmissionWaiters.delete(done);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          this.backgroundHostAdmissionWaiters.add(done);
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
      controller.signal.throwIfAborted();
      if (this.backgroundHostStopped) throw new Error('runtime shutdown');
      return this.enterBackgroundHost(sid);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.backgroundHostControllers.delete(controller);
    }
  }

  /** 登记一段已经获准入场的后台 host 活动；返回这段活动的取消信号和离开函数。 */
  enterBackgroundHost(sessionId) {
    const sid = String(sessionId || '');
    const controller = new AbortController();
    this.backgroundHostControllers.add(controller);
    this.backgroundHostActivity.set(sid, (this.backgroundHostActivity.get(sid) || 0) + 1);
    let left = false;
    return { signal: controller.signal, leave: () => {
      if (left) return;
      left = true;
      this.backgroundHostControllers.delete(controller);
      const remaining = (this.backgroundHostActivity.get(sid) || 1) - 1;
      if (remaining > 0) { this.backgroundHostActivity.set(sid, remaining); return; }
      this.backgroundHostActivity.delete(sid);
      for (const resolve of this.backgroundHostIdleWaiters.get(sid) || []) resolve();
      this.backgroundHostIdleWaiters.delete(sid);
    } };
  }

  /** 这个聊天的后台 host 活动（选歌、写串词）全部结束时 resolve。 */
  whenBackgroundHostIdle(sessionId) {
    const sid = String(sessionId || '');
    if (!this.backgroundHostActivity.get(sid)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.backgroundHostIdleWaiters.get(sid) || [];
      waiters.push(resolve);
      this.backgroundHostIdleWaiters.set(sid, waiters);
    });
  }

  /** 这个聊天的 host 正在做事：聊天回合、ambient 或后台活动。预热据此跳过，等下一个触发点。 */
  hostBusy(sessionId) {
    const sid = String(sessionId || '');
    return this.turnQueue.has(sid) || this.ambientControllers.has(sid) || (this.backgroundHostActivity.get(sid) || 0) > 0;
  }

  /**
   * host 在没有听众消息时用的上下文：和聊天回合同一套组装，只读（不写摘要）。
   * 已说出口的串词不进历史，否则模型会照着旧串词写。
   */
  async assembleHostContext({ entity, sessionId, requestId = null, includeRequestId = null,
    capabilities = [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY] } = {}) {
    this.initialize();
    const sid = String(sessionId || '');
    const store = this.conversationStore;
    const room = store.getSession(sid);
    if (!entity || !room || room.archivedAt || !room.memberIds.includes(entity.id)) {
      throw Object.assign(new Error('host context unavailable'), { code: 'HOST_CONTEXT_UNAVAILABLE' });
    }
    const memberIds = room.memberIds;
    const recentUser = store.listTurns(sid, { limit: 20, visibleOnly: true }).reverse()
      .find(turn => turn.role === 'user' && store.canReadTurn(entity.id, turn, { isGroup: memberIds.length > 1 }));
    const memoryQuery = ambientMemoryQuery({ lastUserText: recentUser?.visibleText,
      currentTrack: currentTrackOf(await this.getRuntimeState({ entity, sessionId: sid })) });
    const assembled = await this.contextAssembler.assemble({ entity, sessionId: sid, capabilities, memberIds, memoryQuery,
      includeRequestId, persistSummaries: false,
      canRead: turn => turn.message?.presentation !== 'track_intro' && store.canReadTurn(entity.id, turn) });
    const traceContext = { sessionId: sid, requestId, roundId: requestId, virtualPersonId: entity.id };
    this.sessionTrace?.record(traceContext, { type: 'context_assembled', systemPrompt: assembled.systemPrompt,
      turnContext: assembled.turnContext,
      preparedMessages: assembled.messages.length, capabilities: assembled.capabilities, modelProfileId: entity.modelProfileId });
    return { ...assembled, onContextUsage: contextUsageRecorder(this.sessionTrace, traceContext) };
  }

  /**
   * 音乐落定后写串词：不等待、不占回合队列、不继承发起它的那一轮的取消信号。
   * 成员变了或人被归档时这一轮作废（写入前 write_track_lines 再核一次）。
   */
  startLinePass({ entity, sessionId, requestId = null, targets = [], listenerAsked = false, assembled = null,
    extraMessages = [], isOwner = null, playbackGap = null } = {}) {
    const release = reason => {
      for (const target of targets) { try { target.fail(reason); } catch { /* 这首歌安静播放 */ } }
    };
    if (!targets.length) return Promise.resolve(null);
    const pass = this.trackLinePass;
    if (!pass || !entity) {
      release('pass-unavailable');
      return Promise.resolve(null);
    }
    const sid = String(sessionId || '');
    const store = this.conversationStore;
    let activity = null;
    const token = store.membershipToken(sid, entity.id);
    const isCurrent = () => {
      if (!activity || activity.signal.aborted) return false;
      const room = store.getSession(sid);
      if (!room || room.archivedAt || !room.memberIds.includes(entity.id)) return false;
      if (store.membershipToken(sid, entity.id) !== token) return false;
      if (this.registry.get(entity.id)?.status === 'archived') return false;
      return isOwner?.() !== false;
    };
    return (async () => {
      try {
        activity = await this.acquireBackgroundHost(sid);
        if (!isCurrent()) { release('stale'); return null; }
        const context = assembled || await this.assembleHostContext({ entity, sessionId: sid, requestId, includeRequestId: requestId });
        return await pass.run({ sessionId: sid, personId: entity.id, systemPrompt: context.systemPrompt,
          messages: [...context.messages, ...extraMessages], targets, listenerAsked, requestId, isCurrent,
          signal: activity.signal, onContextUsage: context.onContextUsage, playbackGap });
      } catch {
        release('context-unavailable');
        return null;
      } finally {
        activity?.leave();
      }
    })();
  }

  claimPresentation(requestId) {
    this.initialize();
    return this.conversationStore.claimPresentation(requestId);
  }

  completePresentation(requestId) {
    this.initialize();
    return this.conversationStore.completePresentation(requestId);
  }

  releasePresentation(requestId) {
    this.initialize();
    return this.conversationStore.releasePresentation(requestId);
  }

  async handleTurn({
    sessionId = defaultSessionId(),
    virtualPersonId = null,
    requestId = createRequestId(),
    userText,
    clientState = null,
    speak = true,
    mentionedPersonIds = [],
    onResponseCommitted = null,
    mode = 'ordinary',
    onDraft = null,
    interruptRequestId = null,
    signal = null,
  } = {}) {
    this.initialize();
    const sid = String(sessionId || defaultSessionId());
    const turns = this.pendingTurns.get(sid) || new Map();
    const inflight = turns.get(requestId);
    if (inflight && mode === 'text_stream') throw Object.assign(new Error('request is already streaming'),
      { code: 'REQUEST_ALREADY_STREAMING', statusCode: 409 });
    if (inflight) return inflight.promise;
    const prior = this.conversationStore.getRound(requestId) || this.conversationStore.getRequest(requestId);
    if (prior && prior.sessionId !== sid) throw new Error('request id belongs to a different session');
    if (prior?.result) return prior.result;
    // A replay of an old request must never cancel a newer active turn.
    if (interruptRequestId && interruptRequestId !== requestId && !prior) {
      // 插话：用户话没说完又发了一条。上一轮以 superseded 中止，与用户点停止区分开。
      this.cancel(sid, String(interruptRequestId), { reason: supersededReason() });
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    // 用户一开口，正在生成的 ambient turn 立即中止：用户回合不等它，它也不再入账。
    this.ambientControllers.get(sid)?.abort(new Error('user turn started'));
    // 用户一开口，正在准备的主动开口立即作废（presence 订阅；监听者异常不影响回合）。
    for (const listener of this.userTurnListeners) {
      try { listener(sid, { roundId: requestId }); } catch { this.logger?.warn?.('[virtual-person] user-turn listener failed'); }
    }
    const trace = this.sessionTrace;
    trace?.record({ sessionId: sid, requestId, roundId: requestId },
      { type: 'turn_input', userText: String(userText ?? ''), mentionedPersonIds, speak: Boolean(speak) });
    const run = () => this._handleRound({
      sessionId: sid,
      virtualPersonId,
      requestId,
      userText,
      clientState,
      speak,
      mentionedPersonIds,
      mode: mode === 'text_stream' ? 'text_stream' : 'ordinary',
      onDraft: typeof onDraft === 'function' ? onDraft : null,
      turnController: controller,
      onResponseCommitted: typeof onResponseCommitted === 'function' ? onResponseCommitted : null,
    });
    const entry = { controller, promise: null };
    turns.set(requestId, entry);
    this.pendingTurns.set(sid, turns);
    entry.promise = this.turnQueue.run(sid, () => (trace?.enter
      ? trace.enter({ sessionId: sid, requestId, roundId: requestId }, run)
      : run())).finally(() => {
      signal?.removeEventListener('abort', forwardAbort);
      if (turns.get(requestId) === entry) turns.delete(requestId);
      if (!turns.size && this.pendingTurns.get(sid) === turns) this.pendingTurns.delete(sid);
    });
    return entry.promise;
  }

  cancel(sessionId, expectedRoundId = null, { reason } = {}) {
    const queued = expectedRoundId ? this.pendingTurns.get(sessionId)?.get(expectedRoundId) : null;
    const matches = !expectedRoundId || this.presentationRounds.get(sessionId) === expectedRoundId;
    const controller = queued?.controller || (matches ? this.controllers.get(sessionId) : null);
    controller?.abort(reason);
    // A stale interrupt for an already committed round must not silence its pending TTS.
    if (matches && controller) this.presentationRounds.delete(sessionId);
    return Boolean(controller);
  }

  /** 订阅「用户开始了一个回合」；返回取消订阅函数。 */
  onUserTurn(listener) {
    if (typeof listener !== 'function') throw new TypeError('onUserTurn requires a listener');
    this.userTurnListeners.add(listener);
    return () => this.userTurnListeners.delete(listener);
  }

  /** 订阅「一轮处理已终局（提交/控制/取消/失败）」；返回取消订阅函数。 */
  onRoundSettled(listener) {
    if (typeof listener !== 'function') throw new TypeError('onRoundSettled requires a listener');
    this.roundSettledListeners.add(listener);
    return () => this.roundSettledListeners.delete(listener);
  }

  /** presence 入账与用户回合共享同一会话队列：用户回合进行中时 presence 只能排在其后。 */
  runPresenceExclusive(sessionId, work) {
    return this.turnQueue.run(sessionId, work);
  }

  /** presence 的只读在场信号：会话是否有回合在跑、最近一次用户发言时间。 */
  presenceActivity(sessionId) {
    return { busy: this.turnQueue.has(sessionId),
      lastUserTurnAtMs: this.conversationStore.lastUserTurnAt?.(sessionId) ?? null };
  }

  /**
   * 一起听歌时心跳叫醒的一轮（ambient turn）：没有用户消息。实现与调用顺序见 AmbientTurnRunner.run。
   * @returns {{action:'speak', turn, entity, delivery} | {action:'quiet'} | {action:'silent', reason}} 失败从不抛出到调用方。
   */
  async handleAmbientTurn(input = {}) {
    this.initialize();
    return this.ambientTurns.run(input);
  }

  /**
   * 「正在输入」（add-companion-expression-and-reception D4）：只来自 runtime 真正开始的回合，
   * 每个 composing 都以 idle 收尾。不进账本、不碰播放；观察者异常不影响回合。
   * outcome='committed' 表示这句已入账、气泡马上就到（客户端可以撑到气泡出现）；'ended' 是安静/失败/中止。
   */
  emitActivity({ sessionId, personId, correlationId, state, outcome = null, phase = null }) {
    if (!this.onActivity || !sessionId || !personId || !correlationId) return;
    try {
      this.onActivity(Object.freeze({ sessionId, personId, correlationId, state,
        ...(state === 'composing' && phase ? { phase } : {}),
        ...(state === 'idle' ? { outcome: outcome === 'committed' ? 'committed' : 'ended' } : {}), at: Date.now() }));
    } catch {
      this.logger?.warn?.('[virtual-person] activity observer failed');
    }
  }

  isPresentationCurrent(sessionId, roundId) {
    return this.presentationRounds.get(sessionId) === roundId;
  }

  async _handleRound(input) {
    const { sessionId, virtualPersonId, requestId, userText, mentionedPersonIds } = input;
    const prior = this.conversationStore.getRound(requestId);
    if (prior) {
      if (prior.sessionId !== sessionId) throw new Error('request id belongs to a different session');
      if (prior.result) return prior.result;
      throw new Error('request is already running');
    }
    // Requests committed before the room migration retain their original replay identity.
    const existing = this.conversationStore.getRequest(requestId);
    if (existing) {
      if (existing.sessionId !== sessionId) throw new Error('request id belongs to a different session');
      if (existing.result) return existing.result;
      throw new Error('request is already running');
    }

    let room = this.conversationStore.ensureSession(sessionId, ROOT_ID);
    if (virtualPersonId) room = this.conversationStore.setActiveVirtualPerson(sessionId, virtualPersonId);
    for (const id of room.memberIds) {
      if (!this.registry.get(id) || this.registry.get(id).status === 'archived') room = this.conversationStore.removeMember(sessionId, id);
    }
    const controller = input.turnController || new AbortController();
    const persons = this.registry.list();
    const routingInput = { room, persons, userText, mentionedPersonIds, sessionId, requestId };
    let plannedResponses = planResponses(routingInput);
    if (this.responsePlanner && input.mode !== 'text_stream' && !controller.signal.aborted) {
      const tokens = new Map(room.memberIds.map(id => [id, this.conversationStore.membershipToken(sessionId, id)]));
      const isCurrent = () => !controller.signal.aborted && room.memberIds.every(id =>
        this.conversationStore.membershipToken(sessionId, id) === tokens.get(id)
        && this.registry.get(id)?.status !== 'archived');
      const routed = await this.responsePlanner({ ...routingInput, signal: controller.signal, isCurrent,
        history: routingHistory(this.conversationStore, room, persons) });
      controller.signal.throwIfAborted();
      // 判断期间被移出/重加的成员不能沿用旧资格；重读房间后保守走直接分发。
      const latest = this.conversationStore.getSession(sessionId);
      const members = latest.memberIds.map(id => this.registry.get(id)).filter(p => p && p.status !== 'archived');
      const unchanged = isCurrent() && latest.activeVirtualPersonId === room.activeVirtualPersonId
        && latest.memberIds.length === room.memberIds.length;
      plannedResponses = unchanged && validResponsePlan(routed?.plan, members) ? routed.plan
        : planResponses({ ...routingInput, room: latest, persons: members });
      room = latest;
      this.sessionTrace?.record({ sessionId, requestId, roundId: requestId }, { type: 'response_routing',
        source: unchanged ? routed?.source : 'fallback', reason: unchanged ? routed?.reason : 'membership-changed',
        responsePlan: plannedResponses });
    }
    // A text stream owns one connection and one official result: multi-speaker group
    // routing stays on the ordinary endpoint, where each response has its own identity.
    const responsePlan = input.mode === 'text_stream'
      ? [room.activeVirtualPersonId && room.memberIds.includes(room.activeVirtualPersonId)
        ? room.activeVirtualPersonId : plannedResponses[0]].filter(Boolean)
      : plannedResponses;
    const round = this.conversationStore.beginRound({ sessionId, roundId: requestId, userText, responsePlan });
    round.memberTokens = Object.fromEntries(round.memberIds.map(id => [id, this.conversationStore.membershipToken(sessionId, id)]));
    this.sessionTrace?.record({ sessionId, requestId, roundId: requestId }, { type: 'round_started',
      userTurnId: round.userTurnId, memberIds: round.memberIds, responsePlan });
    this.controllers.set(sessionId, controller);
    if (!controller.signal.aborted) this.presentationRounds.set(sessionId, requestId);
    const responses = [];
    // Earlier participants can propose candidates. Only the final responder may commit the collected music action.
    const groupAction = { recommendations: [], ownerId: responsePlan.at(-1) };
    // 群聊交接只在多人房间存在；单聊没有任何 floor 能力或提示词。
    const groupFloor = input.mode !== 'text_stream' && round.memberIds.length > 1 ? createGroupFloor({
      plan: responsePlan, memberIds: round.memberIds, userTurnId: round.userTurnId, hostId: room.activeVirtualPersonId,
      persons: round.memberIds.map(id => this.registry.get(id)).filter(person => person && person.status !== 'archived'),
    }) : null;
    // 谁接下一句由 FloorRunner 决定（与 ambient 一拍共用的发言权协议）：计划成员按顺序，
    // 被接受的邀请插到队首，A→B→A 之后不再交接。音乐提交权的两阶段转移在 groupFloorRound.js。
    const floorRun = createFloorRun({ kind: 'listener', memberIds: round.memberIds,
      initial: responsePlan.map(personId => ({ personId, role: 'planned' })),
      canOpenInvite: personId => Boolean(groupFloor) && groupFloor.inviterId === personId });
    if (groupFloor) groupFloor.run = floorRun;
    let floorOutcome = null;
    let returnOutcome = null;
    let plannedIndex = -1;
    let settledResult = null;
    try {
      for (let entry = floorRun.next(); entry; entry = floorRun.next()) {
        if (controller.signal.aborted) { floorRun.interrupt('cancelled'); break; }
        const { personId } = entry;
        if (entry.role === 'invited') {
          floorOutcome = await this.floorResponses.runInvited({ input, round, groupFloor, groupAction, controller, responses });
          floorRun.settle(personId, { spoke: ['answered', 'declined'].includes(floorOutcome.status),
            declined: groupFloor.declined === true, terminalMutation: groupFloor.mutationAccepted });
          continue;
        }
        if (entry.role === 'returned') {
          returnOutcome = await this.floorResponses.runReturn({ input, round, groupFloor, groupAction, controller, responses });
          floorRun.settle(personId, { spoke: returnOutcome.status === 'answered' });
          continue;
        }
        plannedIndex += 1;
        const index = plannedIndex;
        const currentRoom = this.conversationStore.getSession(sessionId);
        const entity = this.registry.get(personId);
        if (currentRoom.archivedAt || this.conversationStore.membershipToken(sessionId, personId) !== round.memberTokens[personId]
            || !entity || entity.status === 'archived') {
          floorRun.settle(personId);
          continue;
        }
        const floorRole = groupFloor?.inviterId === personId && index === responsePlan.length - 1 ? 'inviter' : null;
        const runResponse = () => this._runResponse({ ...input, requestId: responseRequestId(requestId, personId, index),
          entity, round, signal: controller.signal, groupAction, groupFloor, floorRole });
        const response = await (this.sessionTrace?.enter
          ? this.sessionTrace.enter({ sessionId, requestId: responseRequestId(requestId, personId, index),
              roundId: requestId, virtualPersonId: personId }, runResponse)
          : runResponse());
        // 被插话静默结束的回应没有可见 turn：不入列，回合按 cancelled 收束。
        if (!response) { floorRun.settle(personId); continue; }
        responses.push(response);
        this.conversationStore.observeTurns(round.memberIds.filter(id => this.conversationStore.membershipToken(sessionId, id) === round.memberTokens[id]),
          [response.sourceTurnId], policyFromUserText(userText, sessionId));
        if (groupFloor) this._notifyResponseCommitted(input, response);
        // 邀请者出现已接受的音乐 mutation 时不再交接；计划里其他成员的回合照常（只有最后一位能提交音乐）。
        floorRun.settle(personId, { spoke: response?.ok === true,
          terminalMutation: floorRole === 'inviter' && groupFloor.mutationAccepted });
      }
      // 邀请已登记但被邀请者没能开始（邀请者失败、mutation、取消）：按原语义记 skipped。
      if (groupFloor?.invitation && !floorOutcome) {
        floorOutcome = this.floorResponses.skip({ input, round, groupFloor, groupAction, controller,
          inviterResponse: responses.find(response => response.virtualPersonId === groupFloor.invitation.fromPersonId) });
      }
      if (floorOutcome && returnOutcome) floorOutcome = Object.freeze({ ...floorOutcome, returned: returnOutcome });
      const first = responses[0];
      const result = responses.length === 1 && responsePlan.length === 1 && !floorOutcome ? first : {
        ...(first || { requestId, sessionId, displayText: isSuperseded(controller.signal) ? '' : '已停止这轮对话。' }),
        requestId, ok: responses.some(response => response.ok), roundId: requestId, responses,
        cancelled: controller.signal.aborted,
        partial: responses.length < responsePlan.length || responses.some(response => !response.ok)
          || floorOutcome?.status === 'failed' || groupFloor?.incomplete === true,
        ...(floorOutcome ? { floor: floorOutcome } : {}),
      };
      this.conversationStore.completeRound(requestId, result, controller.signal.aborted ? 'cancelled' : 'completed');
      this.sessionTrace?.record({ sessionId, requestId, roundId: requestId }, { type: 'round_completed',
        status: controller.signal.aborted ? 'cancelled' : 'completed',
        responses: responses.map(response => ({ requestId: response.requestId, ok: response.ok,
          outcomeCodes: response.outcomeCodes || [] })) });
      settledResult = result;
      return result;
    } finally {
      if (this.controllers.get(sessionId) === controller) this.controllers.delete(sessionId);
      const outcomeCodes = responses.flatMap(response => response.outcomeCodes || []);
      const settledEvent = {
        sessionId,
        roundId: requestId,
        ok: Boolean(settledResult?.ok),
        cancelled: Boolean(controller.signal.aborted || settledResult?.cancelled),
        outcomeCodes,
      };
      for (const listener of this.roundSettledListeners) {
        try { listener(settledEvent); } catch { this.logger?.warn?.('[virtual-person] round-settled listener failed'); }
      }
    }
  }

  /**
   * 群聊里每位发言人提交后立即交给调用方提前交付，后面的人还在生成时前面的话已经可见。
   * 只通知不等待：交付（含 TTS）与下一位的生成并行；观察者异常不影响回合。
   */
  _notifyResponseCommitted(input, response) {
    if (!input.onResponseCommitted || !response?.presentation) return;
    try {
      Promise.resolve(input.onResponseCommitted(response, { roundId: input.requestId }))
        .catch(error => this.logger?.warn?.('[virtual-person] early delivery failed', error?.code || error?.name || 'error'));
    } catch (error) {
      this.logger?.warn?.('[virtual-person] early delivery failed', error?.code || error?.name || 'error');
    }
  }

  async _runResponse({ sessionId, requestId, userText, clientState, speak, entity, round, signal, groupAction,
    groupFloor = null, floorRole = null, deadlineAt = null, mode = 'ordinary', onDraft = null }) {
    const isCurrent = () => !signal.aborted && !this.conversationStore.getSession(sessionId)?.archivedAt
      && this.conversationStore.membershipToken(sessionId, entity.id) === round.memberTokens[entity.id];
    const started = this.conversationStore.beginRequest({
      sessionId,
      requestId,
      virtualPersonId: entity.id,
      userText,
      userTurnId: round.userTurnId,
    });
    if (started.replayed && started.result) return started.result;
    const trace = this.sessionTrace;
    const traceContext = { sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id };
    trace?.record(traceContext, { type: 'response_started', userTurnId: round.userTurnId });

    const baseCapabilities = this.capabilityResolver(entity, { userText, clientState, musicOwnerId: groupAction.ownerId }) || [];
    // 只有握有本轮音乐提交权的邀请者能把选歌一起让出去。
    const canTransferMusic = floorRole === 'inviter' && groupAction.ownerId === entity.id
      && baseCapabilities.includes(MUSIC_MUTATION_CAPABILITY);
    // 主持建议只给本轮开始时的主持人，在自己的计划回应里（不在被邀请/回传的追加句里）。
    const canSuggestHost = Boolean(groupFloor?.hostId) && groupFloor.hostId === entity.id
      && (floorRole === null || floorRole === 'inviter');
    const streaming = mode === 'text_stream';
    const capabilities = [...baseCapabilities, ...floorCapabilities(floorRole, { canTransferMusic, canSuggestHost })];
    const hasRevision = typeof this.conversationStore.sessionRevision === 'function';
    let cachedRevision = null;
    const isDraftCurrent = () => {
      if (signal.aborted) return false;
      if (hasRevision && cachedRevision !== null && this.conversationStore.sessionRevision(sessionId) === cachedRevision) {
        return true;
      }
      const current = isCurrent();
      if (hasRevision && current) cachedRevision = this.conversationStore.sessionRevision(sessionId);
      return current;
    };
    let draftOpen = streaming;
    let draftText = '';
    let draftSent = '';
    let draftBlocked = false;
    const emitDraft = event => {
      if (!draftOpen || !isDraftCurrent()) return;
      try { onDraft?.({ ...event, sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id }); }
      catch { /* a presentation observer cannot grant authority or stop a commit */ }
    };
    // Drafts carry the same anti-leak guard as the committed line. Keep the cumulative
    // text so a credential or peer marker split across provider deltas cannot slip out.
    const draft = event => {
      if (!draftOpen || !isDraftCurrent()) return;
      if (event.type === 'reset') {
        draftText = ''; draftSent = ''; draftBlocked = false;
        emitDraft(event);
        return;
      }
      if (event.type !== 'delta' || draftBlocked) return;
      draftText = (draftText + String(event.text || '')).slice(0, 32_000);
      if (unsafeDiagnosticText(draftText) || assertsPlayback(draftText)) {
        draftBlocked = true; draftSent = ''; draftText = '';
        emitDraft({ type: 'reset', attempt: event.attempt });
        return;
      }
      const safe = stripPeerMarkers(draftText).text;
      if (safe === draftSent) return;
      if (!safe.startsWith(draftSent)) emitDraft({ type: 'reset', attempt: event.attempt });
      const next = safe.startsWith(draftSent) ? safe.slice(draftSent.length) : safe;
      draftSent = safe;
      if (next) emitDraft({ type: 'delta', text: next, attempt: event.attempt });
    };
    // 还没处理的 ambient 推荐：只给本轮音乐负责人一个短引用 r1（真实 selection 只留在工具上下文）。
    let pendingRecommendation = null;
    if (this.ambientRecommendations && groupAction.ownerId === entity.id && capabilities.includes(MUSIC_MUTATION_CAPABILITY)) {
      try { pendingRecommendation = this.ambientRecommendations.pending(sessionId); } catch { pendingRecommendation = null; }
    }
    let composing = false;
    const lineCollector = createLineCollector();
    let committedLine = false;
    let assembled = null;
    const linePassTail = [];
    let committedReply = '';
    try {
      const isGroup = round.memberIds.length > 1;
      assembled = await this.contextAssembler.assemble({
        entity, sessionId, clientState, capabilities,
        memberIds: round.memberIds,
        memoryQuery: userText,
        musicOwnerId: groupAction.ownerId,
        // 负责人看得到本轮同伴已登记、已核实的推荐（add-peer-message-protocol D5）。
        peerRecommendations: groupAction.ownerId === entity.id
          ? (groupAction.recommendations || []).filter(item => item.personId !== entity.id)
            .map(item => ({ personId: item.personId, displayName: this.registry.get(item.personId)?.displayName || item.personId,
              tracks: item.tracks || [] }))
          : [],
        groupFloor: floorBrief(groupFloor, floorRole, { canTransferMusic, canSuggestHost }),
        includeRequestId: requestId,
        canRead: turn => turn.turnId === round.userTurnId
          || this.conversationStore.canReadTurn(entity.id, turn, { isGroup }),
        persistSummaries: true,
        innerNotes: { mode: 'ordinary' },
        pendingRecommendation: pendingRecommendation ? { title: pendingRecommendation.title, artist: pendingRecommendation.artist,
          recommenderName: pendingRecommendation.recommendedBy === entity.id ? '你'
            : this.registry.get(pendingRecommendation.recommendedBy)?.displayName || '同伴' } : null,
      });
      const { systemPrompt, messages, storedMessages, noteView } = assembled;
      // 有心里话时多出 presence.notes（只开放 settle_thought）；没有时与原能力集相同。
      const turnCapabilities = assembled.capabilities;
      if (!isCurrent()) throw new Error('speaker membership changed');
      if (hasRevision) cachedRevision = this.conversationStore.sessionRevision(sessionId);
      // 群聊回应的请求必须以 user（用户发言或同伴信封）结尾：以自己的回复结尾说明上下文不完整，
      // 不拼一句假用户话凑数，直接 fail closed（add-peer-message-protocol D1）。
      // 看的是附加本轮背景之前的历史末尾：背景块不是谁说的话，不能拿它充当 user 结尾。
      if (isGroup && assembled.historyEndsWithAssistant) {
        trace?.record(traceContext, { type: 'context_rejected', reason: 'context-ends-with-self' });
        throw Object.assign(new Error('group context ends with own reply'), { code: 'CONTEXT_ENDS_WITH_SELF' });
      }
      // 组装结果的结构面：系统提示正文 + 每条消息的 role/长度/工具名。实际发送给
      // 模型的完整 body 由 llm 观测钩子按同一执行身份记录，两者互相印证。
      trace?.record(traceContext, { type: 'context_assembled', systemPrompt, turnContext: assembled.turnContext,
        messages: storedMessages.map(message => ({ role: message.role,
          chars: String(message.content ?? '').length,
          ...(Array.isArray(message.tool_calls) && message.tool_calls.length
            ? { toolNames: message.tool_calls.map(call => call?.function?.name || '') } : {}) })),
        preparedMessages: messages.length, capabilities: turnCapabilities, modelProfileId: entity.modelProfileId });
      const toolNames = new Map();
      const webEvidence = [];
      this.emitActivity({ sessionId, personId: entity.id, correlationId: requestId, state: 'composing' });
      composing = true;
      const runtimeInteractionMode = assembled.interactionMode
        || (this.conversationStore.getSession(sessionId)?.interactionMode === 'roleplay' ? 'roleplay' : 'radio');
      const roleplayPlainTextCorrection = !streaming
        && turnCapabilities.includes(REPLY_CAPABILITY)
        && runtimeInteractionMode === 'roleplay'
        && !isGroup
        ? text => {
          const candidate = String(text || '').trim();
          if (!candidate) return '';
          if (!hasUnquotedStageDirection(candidate) && !/\n\s*\n/.test(candidate)) return '';
          return [
            '你刚才直接输出了带括号动作或分段的纯文本，没有调用 deliver_reply 工具。',
            '请立刻调用 deliver_reply({ beats }) 重新提交这一次回复（1..4 拍）：',
            '1. 把每拍的括号（…）或星号动作/神态描写放进 action 字段，绝不要写进 say 或 spoken；',
            '2. 把要念出口的台词放进 say（歌名/书名括号如《明年今日（2007 Live）》原样保留）；',
            '3. 按节奏设 pauseAfterMs，仅真实生理发声变化时填 voice，平常留空。',
          ].join('\n');
        }
        : null;
      const runOverrides = (Number.isFinite(deadlineAt) || turnCapabilities.includes('web.read') || roleplayPlainTextCorrection)
        ? {
          ...(Number.isFinite(deadlineAt) ? { deadlineMs: deadlineAt } : {}),
          ...(turnCapabilities.includes('web.read') ? { traceContent: false } : {}),
          ...(roleplayPlainTextCorrection ? { plainTextCorrection: roleplayPlainTextCorrection } : {}),
        }
        : null;
      const result = await this.agentLoop.run({
        systemPrompt,
        messages,
        preBudgeted: Boolean(assembled.preBudgeted),
        onContextUsage: contextUsageRecorder(trace, traceContext),
        ...(streaming ? { stream: true, streamRequired: true, isDraftCurrent,
          onTextDelta: event => draft({ type: 'delta', text: event.text, attempt: event.attempt }),
          onStreamReset: event => draft({ type: 'reset', attempt: event.attempt }) } : {}),
        capabilities: turnCapabilities,
        modelProfileId: entity.modelProfileId,
        correlationId: requestId,
        sessionId,
        signal,
        // 网页可能在模型思考/协议适配中被复述：开启联网的回合沿用现有
        // structure-only 观测，避免仅过滤工具字段却遗漏模型 reasoning/body。
        // 未授予 web.read 的回合保持原观测语义。
        profileOverrides: runOverrides,
        toolContext: {
          sessionId,
          requestId,
          virtualPersonId: entity.id,
          memoryNamespace: entity.memoryNamespace,
          voiceProfileId: entity.voiceProfileId,
          userTurnId: round.userTurnId,
          roundId: round.roundId,
          interactionMode: runtimeInteractionMode,
          isGroup,
          recordWebSources: evidence => webEvidence.push(evidence),
          memberIds: round.memberIds,
          groupAction,
          groupFloor: groupFloor ? { state: groupFloor, role: floorRole } : null,
          signal,
          isCurrent,
          userText: String(userText || ''),
          clientState,
          linePass: lineCollector,
          innerNotes: { map: noteView.map, stage: null, store: this.conversationStore.notes,
            personId: entity.id, sessionId },
          ...(pendingRecommendation ? { recommendationRef: {
            ref: 'r1', turnId: pendingRecommendation.turnId, selectionId: pendingRecommendation.selectionId,
            recommendedBy: pendingRecommendation.recommendedBy,
            // 提交被 runtime 接受后才写 queued；失败与重试都留 pending。
            markQueued: () => this.ambientRecommendations.markQueued(pendingRecommendation.turnId) } } : {}),
        },
        onMessage: async event => {
          if (event.kind === 'assistant_tool_calls') {
            const calls = Array.isArray(event.message.tool_calls) ? event.message.tool_calls : [];
            // A tool-bearing turn invalidates any prelims: only the committed result may claim an action.
            if (streaming) draft({ type: 'reset', attempt: 0 });
            let hasMusicTool = false;
            for (const call of calls) {
              const fnName = call?.function?.name || '';
              toolNames.set(String(call?.id || ''), fnName);
              if (MUSIC_PHASE_TOOLS.has(fnName)) hasMusicTool = true;
            }
            if (hasMusicTool) {
              this.emitActivity({ sessionId, personId: entity.id, correlationId: requestId, state: 'composing', phase: 'music' });
              if (streaming) emitDraft({ type: 'activity', phase: 'music' });
            }
            trace?.record(traceContext, { type: 'tool_proposed', round: event.round,
              calls: calls.map(call => ({ id: String(call?.id || ''),
                name: call?.function?.name || '', arguments: call?.function?.arguments ?? null })) });
            // deliver_reply 是结构化终局表达出口，不写入冗余 internal 账本行以保护 24 条上下文窗口。
            const nonReplyCalls = calls.filter(call => call?.function?.name !== DELIVER_REPLY_TOOL_NAME);
            if (nonReplyCalls.length > 0) {
              const persistedMessage = nonReplyCalls.length === calls.length
                ? event.message
                : { ...event.message, tool_calls: nonReplyCalls };
              linePassTail.push(persistedMessage);
              this.conversationStore.appendMessage({
                sessionId,
                requestId,
                role: 'assistant',
                message: persistedMessage,
                speakerVirtualPersonId: entity.id,
                visibility: 'internal',
              });
            }
          } else if (event.kind === 'tool_result') {
            const callId = String(event.message.tool_call_id || '');
            const fnName = toolNames.get(callId) || null;
            trace?.record(traceContext, { type: 'tool_result', round: event.round, toolCallId: callId,
              name: fnName, code: event.outcome?.code || null,
              ok: event.outcome?.ok === true, terminal: event.outcome?.terminal === true,
              kind: event.outcome?.kind || null });
            if (fnName !== DELIVER_REPLY_TOOL_NAME) {
              linePassTail.push(event.message);
              this.conversationStore.appendMessage({
                sessionId,
                requestId,
                role: 'tool',
                message: event.message,
                speakerVirtualPersonId: entity.id,
                visibility: 'internal',
              });
            }
          } else if (event.kind === 'plain_text_correction') {
            trace?.record(traceContext, { type: 'roleplay_plain_text_corrected', round: event.round,
              chars: String(event.text ?? '').trim().length });
          }
        },
      }).catch(async error => {
        let recovered = null;
        try {
          recovered = await this.basicPlaybackFallback?.({
            error, userText, sessionId, requestId, roundId: round.roundId,
            virtualPersonId: entity.id, userTurnId: round.userTurnId,
            groupAction, capabilities, signal, isCurrent, clientState,
          });
        } catch {
          this.logger?.warn?.('[virtual-person] basic playback fallback failed');
        }
        if (recovered) return recovered;
        throw error;
      });
      const committed = acceptedTerminal(result.outcomes);
      // 拒绝接话是被邀请者自己的一句话，不是播放 mutation。
      if (groupFloor && committed && committed.code !== 'FLOOR_DECLINED') groupFloor.mutationAccepted = true;
      if (groupFloor) settleMusicAuthority({ groupFloor, groupAction, floorRole, outcomes: result.outcomes, committed });
      if (!committed) signal.throwIfAborted();
      // 提交后才到达的取消/成员变化：按已提交结果入账，只是不再播报语音。
      const stillCurrent = isCurrent();
      if (!stillCurrent && !committed && !result.outcomes.some(item => item.code === 'PERSONA_ACTIVATED')) throw new Error('speaker membership changed');
      // 迟到结果只保留已发生的动作；过期角色的独立答话不向变化后的听众交付。
      const reply = !stillCurrent && committed?.presentation?.independentDialogue
        ? committed.presentation.displayText : result.finalText;
      const diagnosticFallback = unsafeDiagnosticText(reply)
        ? safeOutcomeFallback(result.outcomes) || '这次操作没有顺利完成，你可以稍后再试。'
        : '';
      // 输出守卫（add-peer-message-protocol D6）：模型模仿的信封标记与旧说话人标签不进可见正文与 TTS。
      const guarded = stripPeerMarkers(String(reply ?? ''));
      if (guarded.stripped) trace?.record(traceContext, { type: 'peer-envelope-stripped' });
      if (!diagnosticFallback && guarded.stripped && !guarded.text && !committed) {
        throw Object.assign(new Error('assistant reply empty after peer marker stripping'), { code: 'EMPTY_ASSISTANT_RESPONSE' });
      }
      const finalText = diagnosticFallback
        || (!guarded.stripped ? reply : guarded.text || safeOutcomeFallback(result.outcomes) || '');
      if (floorRole === 'inviter' && groupFloor?.invitation) {
        // 交付前重验邀请证据（D4）：对方的公开自述这一轮里被改写或撤掉，邀请降级为中性。
        const downgraded = revalidateInvitationEvidence(groupFloor, this.registry.get(groupFloor.invitation.toPersonId));
        if (downgraded) trace?.record(traceContext, { type: 'floor_evidence_downgraded', toPersonId: groupFloor.invitation.toPersonId, reason: downgraded });
      }
      // Sources come exclusively from the host callback, never model-supplied IDs/hrefs.
      const webSources = webEvidence.filter(item => this.webAccess?.policy.snapshot().enabled
        && item.revision === this.webAccess.policy.snapshot().revision)
        .flatMap(item => item.sources.map(source => ({ ...source, provider:item.provider,
          retrievedAt:item.retrievedAt, contentKind:item.contentKind })))
        .filter((source,index,all) => all.findIndex(item=>item.url===source.url)===index).slice(0,5);
      const sourceMetadata = webSources.length ? { webSources } : {};
      const floorMetadata = turnFloorMetadata(groupFloor, floorRole);
      const hostSuggestion = canSuggestHost ? this.floorResponses.settleHostSuggestion(groupFloor, round, traceContext) : null;
      const activeRoom = this.conversationStore.getSession(sessionId);
      const isRoleplay = activeRoom?.interactionMode === 'roleplay';
      const allowAction = isRoleplay && round.memberIds.length <= 1;
      const committedBeats = !diagnosticFallback
        && Array.isArray(committed?.presentation?.beats)
        && committed.presentation.beats.length > 0
        && (stillCurrent || committed.code !== 'MUSIC_COMMITTED')
        ? normalizeReplyBeats(committed.presentation.beats, { allowAction })
        : null;
      const rawFallbackBeats = !diagnosticFallback && !committedBeats?.length
        ? fallbackBeatsForPlainText(finalText, { allowAction })
        : [];
      const beats = diagnosticFallback
        ? []
        : (committedBeats?.length ? committedBeats : rawFallbackBeats);
      const committedText = committedBeats?.length ? beatsToVisibleText(committedBeats) : finalText;
      const spokenForTurn = !diagnosticFallback
        ? (beats.length
          ? beats.map(beatSpokenText).filter(Boolean).join(' ').trim()
          : String(parseRoleplaySegments(committedText).spokenText || '').trim())
        : '';
      const voiceMeta = spokenForTurn
        ? { voice: { spokenText: spokenForTurn, voiceProfileId: entity.voiceProfileId || null } }
        : {};
      const completion = this.conversationStore.completeRequest({
        requestId,
        virtualPersonId: entity.id,
        message: { role: 'assistant', content: committedText,
          ...(beats.length ? { beats } : {}),
          ...sourceMetadata, ...(floorMetadata ? { groupFloor: floorMetadata } : {}),
          ...(hostSuggestion ? { hostSuggestion } : {}), ...voiceMeta },
        result: {
          ok: true,
          requestId,
          sessionId,
          conversationId: sessionId,
          virtualPersonId: entity.id,
          displayText: committedText,
          ...(beats.length ? { beats } : {}),
          rounds: result.rounds,
          outcomeCodes: result.outcomes.map(item => item.code),
          ...sourceMetadata,
          ...(floorMetadata ? { groupFloor: floorMetadata } : {}),
          ...(hostSuggestion ? { hostSuggestion } : {}),
        },
      });
      const basePresentation = this.presentationService.create({
        text: committedText,
        ...(isRoleplay
          ? { spokenText: spokenForTurn }
          : (spokenForTurn ? { spokenText: spokenForTurn } : {})),
        entity,
        sourceTurnId: completion.turn.turnId,
        correlationId: requestId,
        speak: !isRoleplay && speak && stillCurrent && !diagnosticFallback && Boolean(spokenForTurn)
          && !result.outcomes.some(item => VOICE_DELEGATED_TO_TRACK_NARRATION.has(item.code)),
        conversationId: sessionId,
      });
      const presentation = beats.length
        ? Object.freeze({ ...basePresentation, beats })
        : basePresentation;
      const response = Object.freeze({ ...completion.result, presentation });
      trace?.record(traceContext, { type: 'response_committed', displayText: committedText,
        rounds: result.rounds, finishReason: result.finishReason || null,
        outcomeCodes: result.outcomes.map(item => item.code),
        diagnosticFallback: Boolean(diagnosticFallback), speak: presentation.speak !== false });
      this.conversationStore.updateRequestResult(requestId, response);
      committedLine = Boolean(committedText);
      committedReply = String(committedText || '');
      queueMicrotask(() => {
        Promise.resolve(this.onTurnCommitted?.(createCommittedTurnEvent({
          sessionId,
          requestId,
          virtualPersonId: entity.id,
          userTurnId: started.request.userTurnId,
          assistantTurnId: completion.turn.turnId,
          displayText: committedText,
          outcomeCodes: result.outcomes.map(item => item.code),
        }))).catch(error => this.logger?.warn?.('[virtual-person] TURN_COMMITTED observer failed', error));
      });
      return response;
    } catch (error) {
      const errorId = `err_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const failureCode = classifyTurnFailure(error);
      // 被用户的下一条消息顶掉、又没有已接受的终止性动作：静默结束，不写停止提示。
      // 用户这条消息留在账本里，与下一条相邻，由下一轮一起回应。
      if (isSuperseded(signal) && !acceptedTerminal(error?.agentOutcomes)) {
        this.conversationStore.abortRequest(requestId);
        trace?.record(traceContext, { type: 'response_superseded' });
        return null;
      }
      if (floorRole === 'invited' || floorRole === 'returned') {
        // 追加回应（被邀请者、回传收尾）失败/超时/取消/成员变化：不提交安全失败句或替身句，已说的话保持不变。
        this.conversationStore.abortRequest(requestId);
        this.logger?.warn?.(`[virtual-person] floor response failed errorId=${errorId} code=${failureCode}`);
        trace?.record(traceContext, { type: 'floor_failed', failureCode, errorId, errorCode: error?.code || null,
          cancelled: !isCurrent() });
        return null;
      }
      this.logger?.error?.(`[virtual-person] turn failed errorId=${errorId} code=${failureCode}${error?.finishReason ? ` finishReason=${error.finishReason}` : ''}`);
      trace?.record(traceContext, { type: 'response_failed', failureCode, errorId,
        errorCode: error?.code || null, finishReason: error?.finishReason || null, cancelled: !isCurrent() });
      const committedPresentation = acceptedTerminal(error?.agentOutcomes)?.presentation;
      const committedText = isCurrent() ? composeTerminalReply(committedPresentation) : committedPresentation?.displayText?.trim();
      const text = committedText || (!isCurrent() ? '已停止这轮对话。'
        : TIMEOUT_FAILURE_CODES.has(failureCode) ? timeoutFallback(error?.agentOutcomes)
          : safeOutcomeFallback(error?.agentOutcomes) || safeFailure(error));
      const completion = this.conversationStore.completeRequest({
        requestId,
        virtualPersonId: entity.id,
        // 已提交动作的展示文案是事实，照常进历史；其余是固定提示句，标出来（见 TurnContextAssembler.js 的 projectMessage）。
        message: { role: 'assistant', content: text,
          ...(committedText ? {} : { technicalFailure: isCurrent() ? 'failed' : 'stopped' }) },
        result: {
          ok: false,
          code: 'VIRTUAL_PERSON_TURN_FAILED',
          failureCode,
          requestId,
          sessionId,
          virtualPersonId: entity.id,
          displayText: text,
          errorId,
        },
        state: RequestState.FAILED,
        errorId,
      });
      const presentation = this.presentationService.create({
        text,
        entity,
        sourceTurnId: completion.turn.turnId,
        correlationId: requestId,
        speak: false,
      });
      const response = Object.freeze({ ...completion.result, presentation });
      this.conversationStore.updateRequestResult(requestId, response);
      committedLine = Boolean(text);
      return response;
    } finally {
      if (draftOpen) {
        draftOpen = false;
        try { onDraft?.({ type: 'end', sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id }); } catch {}
      }
      if (composing) this.emitActivity({ sessionId, personId: entity.id, correlationId: requestId, state: 'idle',
        outcome: committedLine ? 'committed' : 'ended' });
      // 回合已结束、输入已释放，这时才写这一轮提交的歌的串词。
      if (lineCollector.targets.length) {
        const snapshotAssembled = assembled;
        const canReuseAssembled = snapshotAssembled != null
          && (!hasRevision || this.conversationStore.sessionRevision(sessionId) === cachedRevision)
          && !this.conversationStore.getSession(sessionId)?.archivedAt
          && this.conversationStore.membershipToken(sessionId, entity.id) === round.memberTokens[entity.id];
        const extraMessages = canReuseAssembled
          ? [...linePassTail, ...(committedReply ? [{ role: 'assistant', content: committedReply }] : [])]
          : [];
        queueMicrotask(() => {
          void (async () => {
            let reusedContext = null;
            if (canReuseAssembled) {
              try {
                const baseMessages = typeof snapshotAssembled.linePassMessages === 'function'
                  ? await snapshotAssembled.linePassMessages() : snapshotAssembled.messages;
                reusedContext = {
                  systemPrompt: snapshotAssembled.systemPrompt,
                  messages: baseMessages,
                  onContextUsage: contextUsageRecorder(trace, traceContext),
                };
              } catch {
                reusedContext = null;
              }
            }
            return this.startLinePass({ entity, sessionId, requestId, targets: lineCollector.targets, listenerAsked: true,
              ...(reusedContext ? { assembled: reusedContext, extraMessages } : {}),
              isOwner: () => !groupAction || groupAction.ownerId === entity.id });
          })();
        });
      }
    }
  }
}
