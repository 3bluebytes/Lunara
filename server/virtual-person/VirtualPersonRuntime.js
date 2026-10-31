import { randomUUID } from 'node:crypto';
import { RequestState, TurnVisibility, createCommittedTurnEvent, createRequestId } from './VirtualPersonTypes.js';
import { ROOT_ID } from './VirtualPersonRegistry.js';
import { SessionTurnQueue } from './SessionTurnQueue.js';
import { floorRequestId, planResponses, responseRequestId } from './responsePlan.js';
import { routingHistory, validResponsePlan } from './responseRouting.js';
import { createGroupFloor, floorBrief, floorCapabilities, revalidateHostSuggestion, revalidateInvitationEvidence } from './floorTools.js';
import { createFloorRun } from './floorRunner.js';
import { policyFromUserText } from '../memory/memoryPolicy.js';
import { MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';
import { resolveTaskSpec } from '../llmTasks.js';
import { presenceTurnId } from './ConversationStore.js';
import { AMBIENT_CAPABILITY, AMBIENT_RECOMMEND_CAPABILITY, AMBIENT_TOOLS, INNER_NOTES_CAPABILITY, RECOMMEND_TRACK_TOOL_NAME,
  mentionsTitle } from '../presence/ambientTools.js';
import { createNoteStage, stageHasChanges } from './companionNotes.js';
import { AMBIENT_PLAIN_TEXT_CORRECTION, ambientMemoryQuery, ambientResultOf, ambientTraceText, awayBucket, awayText,
  buildAmbientMarker, currentTrackOf } from '../presence/ambientTurn.js';
import { presenceTemperamentOf } from '../presence/presenceTemperament.js';
import { stripSpeakerLabel } from './speakerLabel.js';
import { assertsPlayback } from './committedLine.js';
import { escapePeerMarkers, mergeAdjacentUserMessages, peerEnvelope, stripPeerMarkers } from './peerMessage.js';

// Outcome codes whose turn hands the spoken channel to the track narration.
const VOICE_DELEGATED_TO_TRACK_NARRATION = new Set(['MUSIC_COMMITTED', 'NARRATION_REQUESTED']);
// 群聊追加段的截止：被邀请者与 A→B→A 收尾共用 budgetMs；剩余不足 minReturnMs 时不开始收尾。
export const FLOOR_LIMITS = Object.freeze({ budgetMs: 30_000, minReturnMs: 2_000 });

function defaultSessionId() {
  return 'conversation:default';
}

function safeFailure(error) {
  if (error?.code === 'LLM_API_ERROR' && (error.status === 401 || error.status === 403)) {
    return '模型连接的认证或访问权限未通过，暂时无法回复。请检查模型连接设置，或切换可用模型后重试。';
  }
  return '刚才这句话我没能接住。你愿意的话，再跟我说一次。';
}

const SAFE_TURN_FAILURE_CODES = new Set([
  'AGENT_TIMEOUT', 'AGENT_ROUND_LIMIT', 'EMPTY_ASSISTANT_RESPONSE',
  'EMPTY_TOOL_PRESENTATION', 'LLM_API_ERROR', 'LLM_INVALID_RESPONSE', 'LLM_TIMEOUT',
]);
// 回合截止与单次模型请求超时（含同端点重试后仍超时）对用户是同一件事：想得太久。
const TIMEOUT_FAILURE_CODES = new Set(['AGENT_TIMEOUT', 'LLM_TIMEOUT']);

function classifyTurnFailure(error) {
  return SAFE_TURN_FAILURE_CODES.has(error?.code) ? error.code : 'TURN_INTERNAL_ERROR';
}

function trimPartialLeadingRequest(turns) {
  if (!turns.length || turns[0].role === 'user' || !turns[0].requestId) return turns;
  const partialRequestId = turns[0].requestId;
  return turns.filter(turn => turn.requestId !== partialRequestId);
}

function keepCompleteToolProtocol(turns) {
  const safe = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const calls = turn.role === 'assistant' && Array.isArray(turn.message?.tool_calls)
      ? turn.message.tool_calls
      : [];
    if (calls.length) {
      const results = [];
      let cursor = index + 1;
      while (cursor < turns.length && turns[cursor].role === 'tool') results.push(turns[cursor++]);
      const declared = new Set(calls.map(call => String(call?.id || '')).filter(Boolean));
      const returned = new Set(results.map(item => String(item.message?.tool_call_id || '')).filter(Boolean));
      const complete = declared.size === calls.length
        && results.length === calls.length
        && [...declared].every(id => returned.has(id));
      if (complete) safe.push(turn, ...results);
      index = cursor - 1;
      continue;
    }
    if (turn.role !== 'tool') safe.push(turn);
  }
  return safe;
}

/**
 * 一条账本 turn 投影成给 selfId 看的模型消息（add-peer-message-protocol D1/D2）：
 * - 用户发言、工具结果：原样，只中和其中的同伴信封标记（谁都不能伪造「别人说」）。
 * - 自己的回复与工具调用：保持 assistant，不加任何标签（带标签模型会照着说出来）。
 * - peerProjection 时，其他成员的可见回复改为 user 角色里的同伴信封；没有正文的跳过（返回 null）。
 *   单人聊天里从没出现过别人的话，peerProjection 为假，投影与改动前逐字节一致。
 */
function projectMessage(turn, registry, { peerProjection = false, selfId = null, round = 'earlier' } = {}) {
  // 卡片、呈现类型、群聊交接与主动开口的调度元数据都是展示元数据，不进入模型历史。
  const { tracks, presentation, groupFloor, hostSuggestion, presence, musicRecommendation, ...message } = structuredClone(turn.message);
  if ((turn.role === 'user' || turn.role === 'tool') && typeof message.content === 'string') {
    return { ...message, content: escapePeerMarkers(message.content) };
  }
  if (turn.role !== 'assistant' || typeof message.content !== 'string') return message;
  const content = stripSpeakerLabel(message.content);
  const isPeer = peerProjection && turn.visibility === TurnVisibility.VISIBLE
    && turn.speakerVirtualPersonId && turn.speakerVirtualPersonId !== selfId;
  if (!isPeer) return { ...message, content };
  if (!content.trim()) return null;
  const speaker = registry.get(turn.speakerVirtualPersonId);
  return { role: 'user', content: peerEnvelope({ name: speaker?.displayName || turn.speakerVirtualPersonId,
    memberId: turn.speakerVirtualPersonId, round, text: content }) };
}

/**
 * 音乐权转移的第一步与收尾（第二步在被邀请者开始回应时）：
 * - 邀请者说完：本轮已有任何音乐候选/提交结果就拒绝转移，只交发言权；否则进入 pending。
 * - 被邀请者拒绝：负责人还给邀请者。被邀请者自己提交了音乐就记 committedMusic。
 * 被邀请者用不到邀请者的候选：offer 绑定创建者，commit 会拒绝别人的 offer。
 */
function settleMusicAuthority({ groupFloor, groupAction, floorRole, outcomes, committed }) {
  const invitation = groupFloor.invitation;
  if (!invitation?.transferMusicAuthority) return;
  if (floorRole === 'inviter') {
    const touchedMusic = outcomes.some(item => item.ok && !String(item.code).startsWith('FLOOR_')
      && (String(item.code).startsWith('MUSIC_') || item.facts?.offerId));
    groupFloor.musicAuthority = touchedMusic || groupFloor.mutationAccepted ? 'rejected' : 'pending';
    return;
  }
  if (floorRole === 'invited' && groupFloor.musicAuthority === 'transferred') {
    groupFloor.committedMusic = Boolean(committed && committed.code !== 'FLOOR_DECLINED');
    if (groupFloor.declined) returnMusicAuthority(groupFloor, groupAction);
  }
}

/** round result 里的交接摘要；待转移的音乐权在交接结束时还给邀请者。 */
function floorSummary(groupFloor, groupAction, status) {
  const invitation = groupFloor.invitation;
  if (invitation.transferMusicAuthority && groupFloor.musicAuthority === 'pending') returnMusicAuthority(groupFloor, groupAction);
  return Object.freeze({ fromPersonId: invitation.fromPersonId, toPersonId: invitation.toPersonId, status,
    ...(invitation.transferMusicAuthority ? { musicAuthority: groupFloor.musicAuthority } : {}) });
}

function returnMusicAuthority(groupFloor, groupAction) {
  groupAction.ownerId = groupFloor.invitation.fromPersonId;
  groupFloor.musicAuthority = 'returned';
}

/** 交接关系写在双方的 turn 上：邀请者记录交给谁，被邀请者记录在回复谁（设计稿的「回复 X」）。 */
function turnFloorMetadata(groupFloor, floorRole) {
  const invitation = groupFloor?.invitation;
  if (!invitation) return null;
  if (floorRole === 'inviter' && !groupFloor.mutationAccepted) {
    return { role: 'inviter', targetPersonId: invitation.toPersonId, reasonKind: invitation.reasonKind,
      ...(invitation.ask ? { ask: invitation.ask } : {}),
      // 邀请者落账时转移还没生效（要等被邀请者开始回应），所以只记「让出了选歌」。
      ...(groupFloor.musicAuthority === 'pending' ? { musicAuthority: 'offered' } : {}) };
  }
  if (floorRole === 'invited') {
    const authority = invitation.transferMusicAuthority && groupFloor.musicAuthority !== 'rejected'
      ? { musicAuthority: groupFloor.musicAuthority, committedMusic: groupFloor.committedMusic === true } : {};
    const returned = groupFloor.returnInvitation && !groupFloor.declined ? { returnedTo: groupFloor.returnInvitation.toPersonId } : {};
    return { role: 'invited', fromPersonId: invitation.fromPersonId,
      replyToTurnId: groupFloor.replyToTurnId || null, declined: groupFloor.declined === true, ...authority, ...returned,
      ...(invitation.ask ? { ask: invitation.ask } : {}) };
  }
  if (floorRole === 'returned' && groupFloor.returnInvitation) {
    return { role: 'returned', fromPersonId: groupFloor.returnInvitation.fromPersonId,
      replyToTurnId: groupFloor.returnReplyToTurnId || null };
  }
  return null;
}

function unsafeDiagnosticText(text) {
  return /\berr_[a-f0-9]{8,}\b|INTERNAL_TOOL_ERROR|(?:stack\s*trace|traceback)|(?:api[_ -]?key|authorization|cookie|token|secret)\s*[:=]|https?:\/\/\S*[?&](?:token|key|auth|signature)=/i
    .test(String(text || ''));
}

/** 已被接受的终止性 mutation：播放器/账本已经改变，之后的取消不能把它说成没做。 */
function acceptedTerminal(outcomes = []) {
  return (Array.isArray(outcomes) ? outcomes : []).find(outcome => outcome?.ok && outcome.terminal) || null;
}

// 回合截止时模型往往还在改正上一步（如重选解析失败的歌）：上一个非终止失败的文案是改正前的中间态，
// 不能当作结论。超时只如实说「太久了」；尝试过音乐动作时补一句没有改动（未提交本身是事实）。
function timeoutFallback(outcomes = []) {
  const triedMusic = (Array.isArray(outcomes) ? outcomes : []).some(outcome => /^MUSIC_/u.test(String(outcome?.code || '')));
  return triedMusic
    ? '这次我想得太久，超时了，队列和播放状态都没有变化。你再说一次，我重新来。'
    : '这次我想得太久，超时了。你愿意的话，再跟我说一次。';
}

function safeOutcomeFallback(outcomes = []) {
  return [...outcomes].reverse().find(outcome => outcome?.presentation?.displayText)?.presentation?.displayText || '';
}

function boundedCumulativeSummary(previousContent, deltaContent, max = 7600) {
  const combined = [previousContent, deltaContent].map(value => String(value || '').trim()).filter(Boolean).join('\n');
  if (combined.length <= max) return combined;
  const half = Math.floor((max - 80) / 2);
  return `${combined.slice(0, half)}\n[中间较早内容已压缩]\n${combined.slice(-half)}`;
}

// ambient 入账事务里 turn 没写进去时抛出，让同事务里已写的推荐一起回滚。
const STALE_COMMIT = Symbol('ambient-stale-commit');

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
  }

  initialize() {
    if (this.initialized) return this;
    this.registry.initialize();
    this.conversationStore.initialize();
    this.initialized = true;
    return this;
  }

  shutdown() {
    if (!this.initialized) return;
    for (const controller of this.controllers.values()) controller.abort();
    for (const turns of this.pendingTurns.values()) for (const entry of turns.values()) entry.controller.abort();
    for (const controller of this.ambientControllers.values()) controller.abort(new Error('runtime shutdown'));
    this.conversationStore.close?.();
    this.registry.close?.();
    this.initialized = false;
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
      this.cancel(sid, String(interruptRequestId));
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    // 用户一开口，正在生成的 ambient turn 立即中止：用户回合不等它，它也不再入账。
    this.ambientControllers.get(sid)?.abort(new Error('user turn started'));
    // 用户一开口，正在准备的主动开口立即作废（presence 订阅；监听者异常不影响回合）。
    for (const listener of this.userTurnListeners) {
      try { listener(sid); } catch { this.logger?.warn?.('[virtual-person] user-turn listener failed'); }
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

  cancel(sessionId, expectedRoundId = null) {
    const queued = expectedRoundId ? this.pendingTurns.get(sessionId)?.get(expectedRoundId) : null;
    const matches = !expectedRoundId || this.presentationRounds.get(sessionId) === expectedRoundId;
    const controller = queued?.controller || (matches ? this.controllers.get(sessionId) : null);
    controller?.abort();
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
   * 一起听歌时心跳叫醒的一轮（ambient turn，add-companion-heartbeat D2）：没有用户消息。
   *
   * 调用顺序：
   *   1. 前置检查：角色是这个聊天的成员、聊天未归档、这个 wake id 还没入账过（重放不调模型）。
   *   2. 记下成员令牌与账本头序号；与普通回合共用 _assembleContext（群聊历史只取全员可读的回合，
   *      不写摘要），加 ambient 小节；末尾追加一条临时运行时提示（不入账、不投影、不进 trace）。
   *   3. 在会话队列之外跑 AgentLoop：工具白名单是 AMBIENT_TOOLS（presence_respond 与心里话工具）；
   *      工具往返不写账本，心里话改动只进本轮的 noteStage。
   *      用户回合不等它；用户一开口（handleTurn）或心跳撤销（wake.signal）就中止。
   *   4. 进入会话队列重验：未被中止、头序号没变、成员没变、聊天仍在、isCurrent()。
   *      通过才 recordPresenceTurn（triggerKey = wake.id，kind = 'ambient'，幂等），并在同一事务里落 noteStage；
   *      安静但暂存了心里话时也进队列重验，只落 noteStage（不落 raises）；重验失败整批丢弃。
   *   5. 出队后调用 deliver（交付与出声由 presence 侧决定；中止状态经 isCurrent 透传）。
   *
   * @returns {{action:'speak', turn, entity, delivery} | {action:'quiet'} | {action:'silent', reason}}
   *   reason 属于 CompanionHeartbeat 的封闭原因码；失败从不抛出到调用方。
   */
  async handleAmbientTurn({ sessionId, personId, wake, floor = null, isCurrent = () => true, deliver = null } = {}) {
    this.initialize();
    const sid = String(sessionId || '');
    const silent = reason => ({ action: 'silent', reason });
    const store = this.conversationStore;
    const entity = this.registry.get(personId);
    const room = sid ? store.getSession(sid) : null;
    if (!wake?.id || !entity || !room || room.archivedAt || !room.memberIds.includes(entity.id)) return silent('stale');
    if (store.getTurn(presenceTurnId(wake.id))) return silent('stale');
    if (wake.signal?.aborted) return silent('interrupted');
    if (this.turnQueue.has(sid) || this.ambientControllers.has(sid)) return silent('turn-busy');

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(wake.signal?.reason);
    wake.signal?.addEventListener?.('abort', forwardAbort, { once: true });
    this.ambientControllers.set(sid, controller);
    const current = () => {
      try { return !controller.signal.aborted && isCurrent() !== false; } catch { return false; }
    };
    const trace = this.sessionTrace;
    const traceContext = { sessionId: sid, requestId: wake.id, roundId: wake.id, virtualPersonId: entity.id };
    const memberIds = room.memberIds;
    const isGroup = memberIds.length > 1;
    const memberTokens = memberIds.map(id => store.membershipToken(sid, id));
    const head = store.headSequence(sid);
    // 群聊里这一句可以点名谁：短编号 m1.. 只在本轮有效，模型看不到真实 id（FloorRunner 裁定预算）。
    const floorTargets = isGroup && Array.isArray(floor?.targets) ? floor.targets.filter(item => memberIds.includes(item.personId)) : [];
    const floorRefs = new Map(floorTargets.map((item, index) => [`m${index + 1}`, item.personId]));
    const ambientFloor = isGroup && typeof floor?.invite === 'function'
      ? { refs: floorRefs, invite: personId => floor.invite(personId) } : null;
    let task = { contextText: '', recentLines: [] };
    // 推荐闸门在叫醒时算一次；关着就既不给工具，也不在提示里提推荐。
    const recommendations = this.ambientRecommendations;
    let recommendGate = null;
    if (recommendations) {
      try { recommendGate = recommendations.gate({ sessionId: sid, personId: entity.id, wake }); }
      catch { recommendGate = { open: false, reason: 'error' }; }
      trace?.record(traceContext, { type: 'ambient_recommendation_gate', open: recommendGate.open === true,
        reason: recommendGate.reason || null });
    }
    const canRecommend = recommendGate?.open === true;
    const recommendation = canRecommend ? {
      stage: null,
      resolve: target => recommendations.resolve(target, { sessionId: sid, virtualPersonId: entity.id, requestId: wake.id,
        roundId: wake.id, signal: controller.signal, isCurrent: current }),
    } : null;
    const dropRecommendation = reason => {
      if (recommendation?.stage) trace?.record(traceContext, { type: 'ambient_recommendation_dropped', reason });
    };
    try {
      const recentUser = store.listTurns(sid, { limit: 20, visibleOnly: true }).reverse()
        .find(turn => turn.role === 'user' && store.canReadTurn(entity.id, turn, { isGroup }));
      const memoryQuery = ambientMemoryQuery({ lastUserText: recentUser?.visibleText,
        currentTrack: currentTrackOf(await this.getRuntimeState({ entity, sessionId: sid })) });
      const assembled = await this._assembleContext({
        entity, sessionId: sid, capabilities: [AMBIENT_CAPABILITY, ...(canRecommend ? [AMBIENT_RECOMMEND_CAPABILITY] : [])],
        memberIds, memoryQuery,
        // 群聊里她说出口的话所有人都看得见：只拿所有成员都能读的回合当素材。
        canRead: turn => (isGroup
          ? memberIds.every(id => store.canReadTurn(id, turn, { isGroup: true }))
          : store.canReadTurn(entity.id, turn, { isGroup: false })),
        persistSummaries: false,
        ambient: { hint: wake.policy?.hint || '', style: presenceTemperamentOf(entity).style,
          // 回来了（add-app-open-greeting）：换「刚打开 app」的情境，离开时长只给粗粒度档位。
          ...(wake.reason === 'app_open' ? { occasion: 'app_open', away: awayText(awayBucket(wake.awayMs)) } : {}),
          ...(wake.role === 'follower' ? { follower: true } : {}),
          ...(canRecommend ? { recommend: true } : {}),
          ...(isGroup ? { floor: { role: wake.role || 'holder', fromName: wake.invitedBy?.displayName || '',
            targets: floorTargets.map((item, index) => ({ ref: `m${index + 1}`, name: item.displayName || item.personId })) } } : {}) },
        innerNotes: { mode: 'ambient', wake },
      });
      const { systemPrompt, messages, storedTurns, runtimeState, noteView, capabilities } = assembled;
      // 心里话改动先暂存，只在入账时与这一轮同事务落库；被打断/过期的轮次一条也不写。
      // 这一轮看到的到期 followup 视为已经「想起来」：无论说话还是安静，入账后都不再叫醒。
      const noteStage = createNoteStage();
      noteStage.consumes.push(...noteView.items.filter(item => item.kind === 'followup' && item.due).map(item => item.noteId));
      const currentQueueItemId = currentTrackOf(runtimeState)?.queueItemId || null;
      const spoke = [...storedTurns].reverse().find(turn => turn.role === 'assistant'
        && turn.speakerVirtualPersonId === entity.id && turn.visibility === TurnVisibility.VISIBLE);
      const marker = buildAmbientMarker({ wake, lastUserTurnAtMs: store.lastUserTurnAt(sid),
        lastSpokeAtMs: spoke?.createdAt ?? null, currentTrack: currentTrackOf(runtimeState) });
      task = {
        // 《》标题必须出现在她这一轮真正看到的内容里：系统提示、历史与运行时提示。
        contextText: [systemPrompt, ...messages.map(message => String(message?.content ?? '')), marker].join('\n'),
        recentLines: store.recentSpokenLines(sid, entity.id, { limit: 3 }),
      };
      // 只记结构，不记正文：运行时提示、历史、系统提示与心里话正文都不进 ambient trace；
      // 心里话只记这一轮可见的条数（按种类），用来查没完的事为什么一直没被提起。
      const innerNoteCounts = {};
      for (const item of noteView.items) innerNoteCounts[item.kind] = (innerNoteCounts[item.kind] || 0) + 1;
      trace?.record(traceContext, { type: 'ambient_context_assembled', systemPromptChars: systemPrompt.length,
        messages: messages.map(message => ({ role: message.role, chars: String(message.content ?? '').length })),
        markerChars: marker.length, capabilities, innerNotes: innerNoteCounts });
      const toolNames = new Map();
      const runLoop = () => this.agentLoop.run({
        systemPrompt,
        messages: [...messages, { role: 'user', content: marker }],
        capabilities,
        modelProfileId: 'ambient',
        profileOverrides: { maxRounds: 3, emptyRetry: false, allowEmptyTerminalPresentation: true,
          timeoutMs: resolveTaskSpec('ambient_turn').timeoutMs, plainTextCorrection: AMBIENT_PLAIN_TEXT_CORRECTION },
        correlationId: wake.id,
        sessionId: sid,
        signal: controller.signal,
        toolNames: [...AMBIENT_TOOLS, ...(canRecommend ? [RECOMMEND_TRACK_TOOL_NAME] : [])],
        toolContext: { sessionId: sid, requestId: wake.id, roundId: wake.id, virtualPersonId: entity.id,
          memberIds, ambientTask: task, ambientFloor, ambientRecommendation: recommendation,
          innerNotes: { map: noteView.map, stage: noteStage, store: store.notes, personId: entity.id, sessionId: sid,
            originKey: wake.id, sourceRefs: recentUser ? [`turn:${recentUser.turnId}`] : [], currentQueueItemId,
            nowMs: () => store.now() } },
        onMessage: event => {
          if (event.kind === 'plain_text_correction') {
            // 她绕过 presence_respond 的那句（截过长度）；纠正本身是运行时提示，不进 trace。
            trace?.record(traceContext, { type: 'ambient_plain_text_corrected', round: event.round,
              chars: String(event.text ?? '').trim().length, text: ambientTraceText(event.text) });
          } else if (event.kind === 'assistant_tool_calls') {
            for (const call of event.message.tool_calls || []) toolNames.set(String(call?.id || ''), call?.function?.name || '');

          } else if (event.kind === 'tool_result') {
            trace?.record(traceContext, { type: 'ambient_tool_result', round: event.round,
              name: toolNames.get(String(event.message.tool_call_id || '')) || null,
              code: event.outcome?.code || null, ok: event.outcome?.ok === true, terminal: event.outcome?.terminal === true,
              ...(event.outcome?.facts?.rejectedRule ? { rejectedRule: event.outcome.facts.rejectedRule } : {}) });
          }
        },
      });
      let result = null;
      let error = null;
      try {
        result = await (trace?.enter ? trace.enter(traceContext, runLoop) : runLoop());
      } catch (caught) { error = caught; }
      // 被丢的纯文本是这一轮唯一进 trace 的正文（她自己的那句，截过长度），不随结果往外传。
      const { droppedText, ...decision } = ambientResultOf({ result, error, aborted: controller.signal.aborted });
      if (decision.dropped) {
        trace?.record(traceContext, { type: 'ambient_line_dropped', reason: decision.dropped,
          chars: String(result?.finalText ?? '').trim().length, text: droppedText });
      }
      const speaking = decision.action === 'speak';
      // 推荐只随点到它的那句话入账：安静（含被丢弃的纯文本）、沉默或没点到歌名都整条丢弃。
      const staged = recommendation?.stage || null;
      const bound = staged && speaking && mentionsTitle(decision.text, staged.title) ? staged : null;
      if (staged && !bound) dropRecommendation(speaking ? 'unbound' : decision.action === 'quiet' ? 'quiet' : decision.reason);
      // 安静也可能想了点什么：只有暂存了心里话改动时才为安静进队列入账，其余安静/沉默照旧直接返回。
      if (!speaking && !(decision.action === 'quiet' && stageHasChanges(noteStage))) return decision;
      if (!speaking) noteStage.raises.length = 0;

      const committed = await this.turnQueue.run(sid, () => {
        if (controller.signal.aborted) return silent('interrupted');
        const latest = store.getSession(sid);
        if (!latest || latest.archivedAt || store.headSequence(sid) !== head
          || latest.memberIds.length !== memberIds.length
          || memberIds.some((id, index) => store.membershipToken(sid, id) !== memberTokens[index])
          || !current()) return silent('stale');
        try {
          return store.db.transaction(() => {
            if (!speaking) {
              store.notes.applyStage(noteStage, { personId: entity.id, sessionId: sid });
              return decision;
            }
            // 推荐与这句话同一事务：先落推荐（顺带让同聊天旧的 pending 过期），turn 没入账就整体回滚。
            const view = bound ? recommendations.record({ turnId: presenceTurnId(wake.id), sessionId: sid, personId: entity.id,
              item: bound }) : null;
            const turn = store.recordPresenceTurn({ sessionId: sid, personId: entity.id, triggerKey: wake.id,
              kind: 'ambient', text: decision.text, sourceRefs: [],
              extra: view ? { musicRecommendation: { selectionId: view.selectionId, provider: view.provider, songId: view.songId,
                title: view.title, artist: view.artist, recommendedBy: view.recommendedBy, status: view.status,
                expiresAt: view.expiresAt } } : null });
            if (!turn) throw STALE_COMMIT;
            store.notes.applyStage(noteStage, { personId: entity.id, sessionId: sid });
            return { action: 'speak', turn, entity };
          })();
        } catch (error) {
          if (error === STALE_COMMIT) return silent('stale');
          throw error;
        }
      });
      if (bound && committed.action !== 'speak') dropRecommendation(committed.reason || 'stale');
      if (!speaking) return committed.action === 'quiet' ? decision : committed;
      if (committed.action !== 'speak') return committed;
      let delivery = null;
      if (typeof deliver === 'function') {
        try {
          delivery = await deliver({ turn: committed.turn, entity, isCurrent: current });
        } catch {
          // 已入账的话刷新后仍可见；交付失败不补发。
          this.logger?.warn?.('[virtual-person] ambient delivery failed');
        }
      }
      return { ...committed, delivery };
    } catch {
      this.logger?.warn?.('[virtual-person] ambient turn failed');
      return silent(controller.signal.aborted ? 'interrupted' : 'error');
    } finally {
      wake.signal?.removeEventListener?.('abort', forwardAbort);
      if (this.ambientControllers.get(sid) === controller) this.ambientControllers.delete(sid);
    }
  }

  /**
   * 「正在输入」（add-companion-expression-and-reception D4）：只来自 runtime 真正开始的回合，
   * 每个 composing 都以 idle 收尾。不进账本、不碰播放；观察者异常不影响回合。
   * outcome='committed' 表示这句已入账、气泡马上就到（客户端可以撑到气泡出现）；'ended' 是安静/失败/中止。
   */
  emitActivity({ sessionId, personId, correlationId, state, outcome = null }) {
    if (!this.onActivity || !sessionId || !personId || !correlationId) return;
    try {
      this.onActivity(Object.freeze({ sessionId, personId, correlationId, state,
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
    // 被接受的邀请插到队首，A→B→A 之后不再交接。音乐提交权的两阶段转移仍在本文件。
    const floorRun = createFloorRun({ kind: 'listener', memberIds: round.memberIds,
      initial: responsePlan.map(personId => ({ personId, role: 'planned' })),
      canOpenInvite: personId => Boolean(groupFloor) && groupFloor.inviterId === personId });
    if (groupFloor) groupFloor.run = floorRun;
    let floorOutcome = null;
    let returnOutcome = null;
    let plannedIndex = -1;
    try {
      for (let entry = floorRun.next(); entry; entry = floorRun.next()) {
        if (controller.signal.aborted) { floorRun.interrupt('cancelled'); break; }
        const { personId } = entry;
        if (entry.role === 'invited') {
          floorOutcome = await this._runFloorResponse({ input, round, groupFloor, groupAction, controller, responses });
          floorRun.settle(personId, { spoke: ['answered', 'declined'].includes(floorOutcome.status),
            declined: groupFloor.declined === true, terminalMutation: groupFloor.mutationAccepted });
          continue;
        }
        if (entry.role === 'returned') {
          returnOutcome = await this._runFloorReturn({ input, round, groupFloor, groupAction, controller, responses });
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
        floorOutcome = this._skipFloor({ input, round, groupFloor, groupAction, controller,
          inviterResponse: responses.find(response => response.virtualPersonId === groupFloor.invitation.fromPersonId) });
      }
      if (floorOutcome && returnOutcome) floorOutcome = Object.freeze({ ...floorOutcome, returned: returnOutcome });
      const first = responses[0];
      const result = responses.length === 1 && responsePlan.length === 1 && !floorOutcome ? first : {
        ...(first || { requestId, sessionId, displayText: '已停止这轮对话。' }),
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
      return result;
    } finally {
      if (this.controllers.get(sessionId) === controller) this.controllers.delete(sessionId);
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

  /**
   * 计划回应全部结束后，按已接受的 invite_floor 追加一位被邀请者。
   * 追加前重验：邀请者已正常提交、本轮没有已接受的播放 mutation、未取消、目标仍是成员。
   * 被邀请者失败不写替身句，只把回合标 partial；返回值是 round result 的 floor 摘要。
   */
  async _runFloorResponse({ input, round, groupFloor, groupAction, controller, responses }) {
    const { sessionId } = input;
    const invitation = groupFloor.invitation;
    const summary = status => floorSummary(groupFloor, groupAction, status);
    const inviterResponse = responses.find(response => response.virtualPersonId === invitation.fromPersonId);
    const entity = this.registry.get(invitation.toPersonId);
    const room = this.conversationStore.getSession(sessionId);
    if (controller.signal.aborted || groupFloor.mutationAccepted || !inviterResponse?.ok || !entity
        || entity.status === 'archived' || room?.archivedAt
        || this.conversationStore.membershipToken(sessionId, entity.id) !== round.memberTokens[entity.id]) {
      return this._skipFloor({ input, round, groupFloor, groupAction, controller, inviterResponse });
    }
    const requestId = floorRequestId(round.roundId, entity.id);
    groupFloor.replyToTurnId = inviterResponse.sourceTurnId;
    // round 级剩余截止（D 失败收束）：追加段从这里起算，被邀请者与回传收尾共用；超时按 floor 失败收束。
    groupFloor.deadlineAt ??= Date.now() + this.floorBudgetMs;
    if (groupFloor.musicAuthority === 'pending') {
      // 两阶段的第二步：被邀请者真正开始回应时才成为本轮唯一音乐负责人。
      groupAction.ownerId = entity.id;
      groupFloor.musicAuthority = 'transferred';
      this.sessionTrace?.record({ sessionId, requestId, roundId: round.roundId },
        { type: 'music_authority_transfer_started', toPersonId: entity.id });
    }
    const run = () => this._runResponse({ ...input, requestId, entity, round, signal: controller.signal,
      groupAction, groupFloor, floorRole: 'invited', deadlineAt: groupFloor.deadlineAt });
    const response = await (this.sessionTrace?.enter
      ? this.sessionTrace.enter({ sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id }, run)
      : run());
    if (!response) {
      if (groupFloor.musicAuthority === 'transferred') returnMusicAuthority(groupFloor, groupAction);
      return summary('failed');
    }
    responses.push(response);
    this.conversationStore.observeTurns(round.memberIds.filter(id => this.conversationStore.membershipToken(sessionId, id) === round.memberTokens[id]),
      [response.sourceTurnId], policyFromUserText(input.userText, sessionId));
    this._notifyResponseCommitted(input, response);
    return summary(groupFloor.declined ? 'declined' : 'answered');
  }

  /**
   * 邀请已登记但被邀请者没有开始。已接受的播放 mutation 是本轮正常的终点；其余原因
   * （取消、邀请者失败、成员或房间变化）都是追加回应缺失，回合记 partial。
   */
  /**
   * 主持建议入账前重验（P2）：对象仍是成员、证据仍有效才写到建议者这一轮的消息上，
   * status 固定 pending。是否已应用由界面对照房间的权威 activeVirtualPersonId 判断，
   * 不在这里另存第二份「谁是主持」。这里绝不改 activeVirtualPersonId。
   */
  _settleHostSuggestion(groupFloor, round, traceContext) {
    const suggestion = groupFloor?.hostSuggestion;
    if (!suggestion) return null;
    const { sessionId } = traceContext;
    const target = this.registry.get(suggestion.toPersonId);
    const dropped = revalidateHostSuggestion(groupFloor, target, {
      isMember: this.conversationStore.membershipToken(sessionId, suggestion.toPersonId) === round.memberTokens[suggestion.toPersonId],
    });
    if (dropped) {
      this.sessionTrace?.record(traceContext, { type: 'host_suggestion_dropped', toPersonId: suggestion.toPersonId, reason: dropped });
      return null;
    }
    this.sessionTrace?.record(traceContext, { type: 'host_suggestion_recorded', toPersonId: suggestion.toPersonId,
      reasonKind: suggestion.reasonKind });
    return { toPersonId: suggestion.toPersonId, reasonKind: suggestion.reasonKind, evidenceRefs: [...suggestion.evidenceRefs],
      ...(suggestion.reason ? { reason: suggestion.reason } : {}), status: 'pending' };
  }

  _skipFloor({ input, round, groupFloor, groupAction, controller = null, inviterResponse = null }) {
    const reason = controller?.signal.aborted ? 'cancelled'
      : groupFloor.mutationAccepted ? 'mutation'
        : inviterResponse && !inviterResponse.ok ? 'inviter-failed'
          : !inviterResponse ? 'inviter-missing' : 'membership';
    groupFloor.incomplete = reason !== 'mutation';
    this.sessionTrace?.record({ sessionId: input.sessionId, requestId: round.roundId, roundId: round.roundId },
      { type: 'floor_skipped', toPersonId: groupFloor.invitation.toPersonId, reason });
    return floorSummary(groupFloor, groupAction, 'skipped');
  }

  /**
   * A→B→A 的最后一跳：被邀请者用 return_floor 交回后，原邀请者再收一句尾。
   * 与 _runFloorResponse 同样重验（未取消、无已接受 mutation、被邀请者已正常提交、仍是成员）；
   * 失败不写替身句。音乐提交权不随回传移动：仍在本轮当前负责人手里。
   */
  async _runFloorReturn({ input, round, groupFloor, groupAction, controller, responses }) {
    const { sessionId } = input;
    const hop = groupFloor.returnInvitation;
    const summary = status => Object.freeze({ fromPersonId: hop.fromPersonId, toPersonId: hop.toPersonId, status });
    const invitedResponse = responses.findLast(response => response.virtualPersonId === hop.fromPersonId);
    const entity = this.registry.get(hop.toPersonId);
    if (controller.signal.aborted || groupFloor.mutationAccepted || !invitedResponse?.ok || !entity
        || entity.status === 'archived' || this.conversationStore.getSession(sessionId)?.archivedAt
        || this.conversationStore.membershipToken(sessionId, entity.id) !== round.memberTokens[entity.id]) {
      this.sessionTrace?.record({ sessionId, requestId: round.roundId, roundId: round.roundId },
        { type: 'floor_return_skipped', toPersonId: hop.toPersonId });
      if (!groupFloor.mutationAccepted) groupFloor.incomplete = true;
      return summary('skipped');
    }
    // 被邀请者用掉了大半截止：剩下的时间不够收一句尾，就不开始。
    if (!(groupFloor.deadlineAt - Date.now() >= FLOOR_LIMITS.minReturnMs)) {
      this.sessionTrace?.record({ sessionId, requestId: round.roundId, roundId: round.roundId },
        { type: 'floor_return_skipped', toPersonId: hop.toPersonId, reason: 'deadline' });
      groupFloor.incomplete = true;
      return summary('skipped');
    }
    const requestId = floorRequestId(round.roundId, entity.id);
    groupFloor.returnReplyToTurnId = invitedResponse.sourceTurnId;
    const run = () => this._runResponse({ ...input, requestId, entity, round, signal: controller.signal,
      groupAction, groupFloor, floorRole: 'returned', deadlineAt: groupFloor.deadlineAt });
    const response = await (this.sessionTrace?.enter
      ? this.sessionTrace.enter({ sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id }, run)
      : run());
    if (!response) {
      groupFloor.incomplete = true;
      return summary('failed');
    }
    responses.push(response);
    this.conversationStore.observeTurns(round.memberIds.filter(id => this.conversationStore.membershipToken(sessionId, id) === round.memberTokens[id]),
      [response.sourceTurnId], policyFromUserText(input.userText, sessionId));
    this._notifyResponseCommitted(input, response);
    return summary(response.ok ? 'answered' : 'failed');
  }

  /**
   * 普通回合与 ambient 回合共用的上下文组装：记忆、运行时状态、环境、今日计划、较早摘要、
   * 提示词、可读历史投影与上下文预算。普通回合的结果必须与抽取前逐字节一致
   * （VirtualPersonRuntime.context.test.js）。
   *
   * - memoryQuery：检索记忆的查询文本；与它完全相同的记忆条目不再重复进提示词。
   * - canRead(turn)：哪些已入账回合可以进入本次历史；群聊 ambient 传入「全员可读」。
   * - persistSummaries：只有普通回合把预算裁掉的部分写成较早摘要；ambient 只读不写。
   * - ambient：可选的 ambient 小节资料，交给 PromptAssembler。
   * - innerNotes：{mode:'ordinary'|'ambient', wake} 时读她在这个聊天里记着的心里话（add-companion-heartbeat 阶段 B）。
   *   有可见条目才加「你心里记着的事」小节与 presence.notes 能力；没有时提示词与能力集逐字不变。
   *   返回 noteView = {items, map(短编号 n1.. → noteId)} 与实际使用的 capabilities。
   */
  async _assembleContext({ entity, sessionId, clientState = null, capabilities = [], memberIds, memoryQuery = '',
    musicOwnerId = entity.id, groupFloor = null, includeRequestId = null, canRead, persistSummaries = false,
    ambient = null, innerNotes = null, peerRecommendations = [], pendingRecommendation = null }) {
    const isGroup = memberIds.length > 1;
    const [memories, runtimeState, environment] = await Promise.all([
      this.retrieveMemories({
        query: String(memoryQuery || ''),
        namespace: entity.memoryNamespace,
        virtualPersonId: entity.id,
        sessionId,
        isGroup,
      }),
      this.getRuntimeState({ entity, clientState, sessionId }),
      // 天气快照在组装前取好（env 内部有缓存）；失败不阻塞对话。
      this.getEnvironment
        ? Promise.resolve().then(() => this.getEnvironment({ entity, sessionId })).catch(() => null)
        : Promise.resolve(null),
    ]);
    const normalizedQuery = String(memoryQuery || '').trim();
    const promptMemories = (Array.isArray(memories) ? memories : []).filter(item =>
      String(item?.content || item?.summary || '').trim() !== normalizedQuery);
    const summaryScope = { limit: 1, personId: entity.id, isGroup };
    const conversationSummaries = this.conversationStore.listSummaries(sessionId, summaryScope);
    const noteView = this._innerNoteView({ entity, sessionId, isGroup, runtimeState, options: innerNotes });
    const effectiveCapabilities = noteView.items.length && !capabilities.includes(INNER_NOTES_CAPABILITY)
      ? [...capabilities, INNER_NOTES_CAPABILITY] : capabilities;
    const systemPrompt = this.promptAssembler.assemble({
      entity,
      capabilities: effectiveCapabilities,
      runtimeState,
      environment,
      memories: promptMemories,
      conversationSummaries,
      participants: memberIds.map(id => this.registry.get(id)).filter(Boolean),
      musicOwnerId,
      companionMode: runtimeState?.companionMode || null,
      groupFloor,
      ...(peerRecommendations.length ? { peerRecommendations } : {}),
      ...(pendingRecommendation ? { pendingRecommendation } : {}),
      lifeContext: this.getLifeContext
        ? await Promise.resolve(this.getLifeContext({ sessionId, entity, participants: memberIds }))
          .catch(() => null)
        : null,
      ...(ambient ? { ambient } : {}),
      ...(noteView.items.length ? { innerNotes: { mode: innerNotes.mode, items: noteView.items } } : {}),
    });
    const rawStoredTurns = trimPartialLeadingRequest(this.conversationStore.listTurns(sessionId, {
      limit: 100,
      ...(includeRequestId ? { includeRequestId } : {}),
    }));
    const storedTurns = keepCompleteToolProtocol(rawStoredTurns.filter(turn => canRead(turn)));
    // 群聊，或历史里出现过别人说的话（单人聊天换过角色）时，按「自己/同伴」投影并合并相邻 user。
    const peerProjection = memberIds.length > 1 || storedTurns.some(turn => turn.visibility === TurnVisibility.VISIBLE
      && turn.role === 'assistant'
      && turn.speakerVirtualPersonId
      && turn.speakerVirtualPersonId !== entity.id);
    const lastUserIndex = storedTurns.findLastIndex(turn => turn.role === 'user');
    const projected = [];
    storedTurns.forEach((turn, index) => {
      const message = projectMessage(turn, this.registry, { peerProjection, selfId: entity.id,
        round: index > lastUserIndex ? 'current' : 'earlier' });
      if (!message) return;
      projected.push({ index, message });
    });
    const merged = peerProjection
      ? mergeAdjacentUserMessages(projected.map(item => item.message))
      : { messages: projected.map(item => item.message), sources: projected.map((_, position) => [position]) };
    const storedMessages = merged.messages;
    // 模型消息下标 → 账本 turn（合并后一条消息可能对应多条 turn），供摘要回调使用。
    const messageTurns = merged.sources.map(positions => positions.map(position => storedTurns[projected[position].index]));
    const onSummary = info => {
      const previous = this.conversationStore.listSummaries(sessionId, summaryScope).at(-1) || null;
      const removedTurns = info.removedIndexes
        .flatMap(index => messageTurns[index] || [])
        .filter(turn => turn?.visibility === TurnVisibility.VISIBLE)
        .filter(turn => !previous || turn.sequence > previous.toSequence);
      if (!removedTurns.length) return previous;
      const delta = removedTurns
        .map(turn => `${turn.role === 'assistant' ? this.registry.get(turn.speakerVirtualPersonId)?.displayName || turn.speakerVirtualPersonId : 'user'}: ${String(turn.message?.content || '').slice(0, 500)}`)
        .join('\n');
      const sequences = removedTurns.map(turn => turn.sequence);
      return this.conversationStore.saveSummary({
        sessionId,
        personId: entity.id,
        fromSequence: previous?.fromSequence || Math.min(...sequences),
        toSequence: Math.max(...sequences),
        content: boundedCumulativeSummary(previous?.content, delta),
        method: info.method,
      });
    };
    const messages = this.contextBudgeter
      ? await this.contextBudgeter.prepare(storedMessages, persistSummaries ? { onSummary } : {})
      : storedMessages;
    return { systemPrompt, messages, storedMessages, storedTurns, runtimeState, noteView,
      capabilities: effectiveCapabilities };
  }

  /** 心里话的只读视图：短编号只在这一轮有效，真实 noteId 不出现在提示词里。读失败等同没有心里话。 */
  _innerNoteView({ entity, sessionId, isGroup, runtimeState, options }) {
    const empty = { items: [], map: new Map() };
    const notes = this.conversationStore.notes;
    if (!options || !notes) return empty;
    let visible = [];
    try {
      visible = notes.listVisible({ personId: entity.id, sessionId, isGroup, mode: options.mode, wake: options.wake || null,
        currentQueueItemId: currentTrackOf(runtimeState)?.queueItemId || null });
    } catch {
      this.logger?.warn?.('[virtual-person] inner notes unavailable');
      return empty;
    }
    const map = new Map();
    const items = visible.map((note, index) => {
      const shortId = `n${index + 1}`;
      map.set(shortId, note.noteId);
      return { shortId, noteId: note.noteId, kind: note.kind, text: note.text, dueAt: note.dueAt,
        wakeCondition: note.wakeCondition, due: note.due, origin: note.origin, createdAt: note.createdAt,
        sensitive: note.sensitive };
    });
    return { items, map };
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
    let draftOpen = streaming;
    let draftText = '';
    let draftSent = '';
    let draftBlocked = false;
    const emitDraft = event => {
      if (!draftOpen || !isCurrent()) return;
      try { onDraft?.({ ...event, sessionId, requestId, roundId: round.roundId, virtualPersonId: entity.id }); }
      catch { /* a presentation observer cannot grant authority or stop a commit */ }
    };
    // Drafts carry the same anti-leak guard as the committed line. Keep the cumulative
    // text so a credential or peer marker split across provider deltas cannot slip out.
    const draft = event => {
      if (!draftOpen || !isCurrent()) return;
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
    let committedLine = false;
    try {
      const isGroup = round.memberIds.length > 1;
      const assembled = await this._assembleContext({
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
      // 群聊回应的请求必须以 user（用户发言或同伴信封）结尾：以自己的回复结尾说明上下文不完整，
      // 不拼一句假用户话凑数，直接 fail closed（add-peer-message-protocol D1）。
      if (isGroup && messages.at(-1)?.role === 'assistant') {
        trace?.record(traceContext, { type: 'context_rejected', reason: 'context-ends-with-self' });
        throw Object.assign(new Error('group context ends with own reply'), { code: 'CONTEXT_ENDS_WITH_SELF' });
      }
      // 组装结果的结构面：系统提示正文 + 每条消息的 role/长度/工具名。实际发送给
      // 模型的完整 body 由 llm 观测钩子按同一执行身份记录，两者互相印证。
      trace?.record(traceContext, { type: 'context_assembled', systemPrompt,
        messages: storedMessages.map(message => ({ role: message.role,
          chars: String(message.content ?? '').length,
          ...(Array.isArray(message.tool_calls) && message.tool_calls.length
            ? { toolNames: message.tool_calls.map(call => call?.function?.name || '') } : {}) })),
        preparedMessages: messages.length, capabilities: turnCapabilities, modelProfileId: entity.modelProfileId });
      const toolNames = new Map();
      const webEvidence = [];
      this.emitActivity({ sessionId, personId: entity.id, correlationId: requestId, state: 'composing' });
      composing = true;
      const result = await this.agentLoop.run({
        systemPrompt,
        messages,
        ...(streaming ? { stream: true, streamRequired: true,
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
        profileOverrides: (Number.isFinite(deadlineAt) || turnCapabilities.includes('web.read'))
          ? { ...(Number.isFinite(deadlineAt) ? { deadlineMs: deadlineAt } : {}),
            ...(turnCapabilities.includes('web.read') ? { traceContent:false } : {}) } : null,
        toolContext: {
          sessionId,
          requestId,
          virtualPersonId: entity.id,
          memoryNamespace: entity.memoryNamespace,
          voiceProfileId: entity.voiceProfileId,
          userTurnId: round.userTurnId,
          roundId: round.roundId,
          recordWebSources: evidence => webEvidence.push(evidence),
          memberIds: round.memberIds,
          groupAction,
          groupFloor: groupFloor ? { state: groupFloor, role: floorRole } : null,
          signal,
          isCurrent,
          userText: String(userText || ''),
          clientState,
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
            // A tool-bearing turn invalidates any prelims: only the committed result may claim an action.
            if (streaming) draft({ type: 'reset', attempt: 0 });
            for (const call of event.message.tool_calls || []) toolNames.set(String(call?.id || ''), call?.function?.name || '');
            trace?.record(traceContext, { type: 'tool_proposed', round: event.round,
              calls: (event.message.tool_calls || []).map(call => ({ id: String(call?.id || ''),
                name: call?.function?.name || '', arguments: call?.function?.arguments ?? null })) });
            this.conversationStore.appendMessage({
              sessionId,
              requestId,
              role: 'assistant',
              message: event.message,
              speakerVirtualPersonId: entity.id,
              visibility: 'internal',
            });
          } else if (event.kind === 'tool_result') {
            const callId = String(event.message.tool_call_id || '');
            trace?.record(traceContext, { type: 'tool_result', round: event.round, toolCallId: callId,
              name: toolNames.get(callId) || null, code: event.outcome?.code || null,
              ok: event.outcome?.ok === true, terminal: event.outcome?.terminal === true,
              kind: event.outcome?.kind || null });
            this.conversationStore.appendMessage({
              sessionId,
              requestId,
              role: 'tool',
              message: event.message,
              speakerVirtualPersonId: entity.id,
              visibility: 'internal',
            });
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
      const diagnosticFallback = unsafeDiagnosticText(result.finalText)
        ? safeOutcomeFallback(result.outcomes) || '这次操作没有顺利完成，你可以稍后再试。'
        : '';
      // 输出守卫（add-peer-message-protocol D6）：模型模仿的信封标记与旧说话人标签不进可见正文与 TTS。
      const guarded = stripPeerMarkers(String(result.finalText ?? ''));
      if (guarded.stripped) trace?.record(traceContext, { type: 'peer-envelope-stripped' });
      if (!diagnosticFallback && guarded.stripped && !guarded.text && !committed) {
        throw Object.assign(new Error('assistant reply empty after peer marker stripping'), { code: 'EMPTY_ASSISTANT_RESPONSE' });
      }
      const finalText = diagnosticFallback
        || (!guarded.stripped ? result.finalText : guarded.text || safeOutcomeFallback(result.outcomes) || '');
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
      const hostSuggestion = canSuggestHost ? this._settleHostSuggestion(groupFloor, round, traceContext) : null;
      const completion = this.conversationStore.completeRequest({
        requestId,
        virtualPersonId: entity.id,
        message: { role: 'assistant', content: finalText, ...sourceMetadata, ...(floorMetadata ? { groupFloor: floorMetadata } : {}),
          ...(hostSuggestion ? { hostSuggestion } : {}) },
        result: {
          ok: true,
          requestId,
          sessionId,
          conversationId: sessionId,
          virtualPersonId: entity.id,
          displayText: finalText,
          rounds: result.rounds,
          outcomeCodes: result.outcomes.map(item => item.code),
          ...sourceMetadata,
          ...(floorMetadata ? { groupFloor: floorMetadata } : {}),
          ...(hostSuggestion ? { hostSuggestion } : {}),
        },
      });
      const presentation = this.presentationService.create({
        text: finalText,
        ...(webEvidence.length ? { spokenText: String(finalText).replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g,'$1').replace(/https?:\/\/[^\s<>]+/g,'') } : {}),
        entity,
        sourceTurnId: completion.turn.turnId,
        correlationId: requestId,
        speak: speak && stillCurrent && !diagnosticFallback
          && !result.outcomes.some(item => VOICE_DELEGATED_TO_TRACK_NARRATION.has(item.code)),
        conversationId: sessionId,
      });
      const response = Object.freeze({ ...completion.result, presentation });
      trace?.record(traceContext, { type: 'response_committed', displayText: finalText,
        rounds: result.rounds, finishReason: result.finishReason || null,
        outcomeCodes: result.outcomes.map(item => item.code),
        diagnosticFallback: Boolean(diagnosticFallback), speak: presentation.speak !== false });
      this.conversationStore.updateRequestResult(requestId, response);
      committedLine = Boolean(finalText);
      queueMicrotask(() => {
        Promise.resolve(this.onTurnCommitted?.(createCommittedTurnEvent({
          sessionId,
          requestId,
          virtualPersonId: entity.id,
          userTurnId: started.request.userTurnId,
          assistantTurnId: completion.turn.turnId,
          displayText: finalText,
          outcomeCodes: result.outcomes.map(item => item.code),
        }))).catch(error => this.logger?.warn?.('[virtual-person] TURN_COMMITTED observer failed', error));
      });
      return response;
    } catch (error) {
      const errorId = `err_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      const failureCode = classifyTurnFailure(error);
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
      const committedText = acceptedTerminal(error?.agentOutcomes)?.presentation?.displayText?.trim();
      const text = committedText || (!isCurrent() ? '已停止这轮对话。'
        : TIMEOUT_FAILURE_CODES.has(failureCode) ? timeoutFallback(error?.agentOutcomes)
          : safeOutcomeFallback(error?.agentOutcomes) || safeFailure(error));
      const completion = this.conversationStore.completeRequest({
        requestId,
        virtualPersonId: entity.id,
        message: { role: 'assistant', content: text },
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
    }
  }
}

export {
  keepCompleteToolProtocol,
};
