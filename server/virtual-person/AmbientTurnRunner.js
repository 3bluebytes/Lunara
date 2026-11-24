// AmbientTurnRunner.js — 一起听歌时心跳叫醒的一轮（ambient turn）：没有用户消息，她自己决定说不说。
//
// VirtualPersonRuntime.handleAmbientTurn 的实现。和用户回合共用同一个 host、同一套上下文组装和同一个 AgentLoop，
// 不另起 Agent；模型调用在会话队列之外跑，入账时才进队列重验。进行中的 controller 登记在 runtime 的
// ambientControllers 里（构造时传入同一张表），用户一开口 runtime 就中止它。

import { TurnVisibility } from './VirtualPersonTypes.js';
import { presenceTurnId } from './ConversationStore.js';
import { resolveTaskSpec } from '../llmTasks.js';
import { AMBIENT_CAPABILITY, AMBIENT_RECOMMEND_CAPABILITY, AMBIENT_TOOLS, RECOMMEND_TRACK_TOOL_NAME,
  mentionsTitle } from '../presence/ambientTools.js';
import { createNoteStage, stageHasChanges } from './companionNotes.js';
import { AMBIENT_PLAIN_TEXT_CORRECTION, ambientMemoryQuery, ambientResultOf, ambientTraceText, awayBucket, awayText,
  buildAmbientMarker, currentTrackOf } from '../presence/ambientTurn.js';
import { presenceTemperamentOf } from '../presence/presenceTemperament.js';
import { contextUsageRecorder } from './contextUsage.js';
import { fallbackBeatsForPlainText } from './replyBeats.js';

// ambient 入账事务里 turn 没写进去时抛出，让同事务里已写的推荐一起回滚。
const STALE_COMMIT = Symbol('ambient-stale-commit');

export class AmbientTurnRunner {
  constructor({ conversationStore, registry, agentLoop, turnQueue, controllers, hostBusy, assembleContext,
    getRuntimeState = () => null, sessionTrace = null, ambientRecommendations = null, isLifeContextCurrent = null, logger = console } = {}) {
    this.conversationStore = conversationStore;
    this.registry = registry;
    this.agentLoop = agentLoop;
    this.turnQueue = turnQueue;
    this.controllers = controllers;
    this.hostBusy = hostBusy;
    this.assembleContext = assembleContext;
    this.getRuntimeState = getRuntimeState;
    this.sessionTrace = sessionTrace;
    this.ambientRecommendations = ambientRecommendations;
    this.isLifeContextCurrent = typeof isLifeContextCurrent === 'function' ? isLifeContextCurrent : null;
    this.logger = logger;
  }

  /**
   * 一起听歌时心跳叫醒的一轮（ambient turn，add-companion-heartbeat D2）：没有用户消息。
   *
   * 调用顺序：
   *   1. 前置检查：角色是这个聊天的成员、聊天未归档、这个 wake id 还没入账过（重放不调模型）。
   *   2. 记下成员令牌与账本头序号；与普通回合共用 TurnContextAssembler.assemble（群聊历史只取全员可读的回合，
   *      不写摘要），加 ambient 小节；末尾追加一条临时运行时提示（不入账、不投影、不进 trace）。
   *   3. 在会话队列之外跑 AgentLoop：工具白名单是 AMBIENT_TOOLS（presence_respond 与心里话工具）；
   *      工具往返不写账本，心里话改动只进本轮的 noteStage。
   *      用户回合不等它；用户一开口（VirtualPersonRuntime.handleTurn）或心跳撤销（wake.signal）就中止。
   *   4. 进入会话队列重验：未被中止、头序号没变、成员没变、聊天仍在、isCurrent()。
   *      通过才 recordPresenceTurn（triggerKey = wake.id，kind = 'ambient'，幂等），并在同一事务里落 noteStage；
   *      安静但暂存了心里话时也进队列重验，只落 noteStage（不落 raises）；重验失败整批丢弃。
   *   5. 出队后调用 deliver（交付与出声由 presence 侧决定；中止状态经 isCurrent 透传）。
   *
   * @returns {{action:'speak', turn, entity, delivery} | {action:'quiet'} | {action:'silent', reason}}
   *   reason 属于 CompanionHeartbeat 的封闭原因码；失败从不抛出到调用方。
   */
  async run({ sessionId, personId, wake, floor = null, isCurrent = () => true, deliver = null } = {}) {
    const sid = String(sessionId || '');
    const silent = reason => ({ action: 'silent', reason });
    const store = this.conversationStore;
    const entity = this.registry.get(personId);
    const room = sid ? store.getSession(sid) : null;
    if (!wake?.id || !entity || !room || room.archivedAt || !room.memberIds.includes(entity.id)) return silent('stale');
    if (room.interactionMode === 'roleplay' && wake.reason !== 'app_open') return silent('roleplay-mode');
    if (store.getTurn(presenceTurnId(wake.id))) return silent('stale');
    if (wake.signal?.aborted) return silent('interrupted');
    if (this.hostBusy(sid)) return silent('turn-busy');

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(wake.signal?.reason);
    wake.signal?.addEventListener?.('abort', forwardAbort, { once: true });
    this.controllers.set(sid, controller);
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
      const assembled = await this.assembleContext({
        entity, sessionId: sid, capabilities: [AMBIENT_CAPABILITY, ...(canRecommend ? [AMBIENT_RECOMMEND_CAPABILITY] : [])],
        memberIds, memoryQuery,
        // 素材是她自己读得到的回合；群聊里当着大家说什么、私下的提不提，是她的分寸。
        canRead: turn => store.canReadTurn(entity.id, turn),
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
        recentLines: store.recentSpokenLines(sid, entity.id, { limit: 3, excludeTrackIntros: true }),
      };
      // 只记结构，不记正文：运行时提示、历史、系统提示与心里话正文都不进 ambient trace；
      // 心里话只记这一轮可见的条数（按种类），用来查没完的事为什么一直没被提起。
      const innerNoteCounts = {};
      for (const item of noteView.items) innerNoteCounts[item.kind] = (innerNoteCounts[item.kind] || 0) + 1;
      trace?.record(traceContext, { type: 'ambient_context_assembled', systemPromptChars: systemPrompt.length,
        turnContextChars: assembled.turnContext.length,
        messages: messages.map(message => ({ role: message.role, chars: String(message.content ?? '').length })),
        markerChars: marker.length, capabilities, innerNotes: innerNoteCounts });
      const toolNames = new Map();
      const runLoop = () => this.agentLoop.run({
        systemPrompt,
        messages: [...messages, { role: 'user', content: marker }],
        onContextUsage: contextUsageRecorder(trace, traceContext),
        capabilities,
        modelProfileId: 'ambient',
        profileOverrides: { maxRounds: 3, emptyRetry: false, allowEmptyTerminalPresentation: true,
          timeoutMs: resolveTaskSpec('ambient_turn').timeoutMs, plainTextCorrection: AMBIENT_PLAIN_TEXT_CORRECTION },
        correlationId: wake.id,
        sessionId: sid,
        interactionMode: room.interactionMode,
        isGroup,
        signal: controller.signal,
        toolNames: [...AMBIENT_TOOLS, ...(canRecommend ? [RECOMMEND_TRACK_TOOL_NAME] : [])],
        toolContext: { sessionId: sid, requestId: wake.id, roundId: wake.id, virtualPersonId: entity.id,
          memberIds, interactionMode: room.interactionMode, isGroup, ambientOccasion: wake.reason,
          ambientTask: task, ambientFloor, ambientRecommendation: recommendation,
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
        if (assembled.lifeContext && this.isLifeContextCurrent && !this.isLifeContextCurrent(assembled.lifeContext)) {
          return silent('stale');
        }
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
            const persistedBeats = Array.isArray(decision.beats) && decision.beats.length
              ? decision.beats
              : (room.interactionMode === 'roleplay' ? fallbackBeatsForPlainText(decision.text, { allowAction: true }) : null);
            const extra = {
              ...(persistedBeats?.length ? { beats: persistedBeats } : {}),
              ...(view ? { musicRecommendation: { selectionId: view.selectionId, provider: view.provider, songId: view.songId,
                title: view.title, artist: view.artist, recommendedBy: view.recommendedBy, status: view.status,
                expiresAt: view.expiresAt } } : {}),
            };
            const turn = store.recordPresenceTurn({ sessionId: sid, personId: entity.id, triggerKey: wake.id,
              kind: 'ambient', text: decision.text, sourceRefs: [],
              extra: Object.keys(extra).length ? extra : null });
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
      if (this.controllers.get(sid) === controller) this.controllers.delete(sid);
    }
  }
}
