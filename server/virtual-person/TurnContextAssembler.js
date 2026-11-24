// TurnContextAssembler.js — 一次模型调用之前，把账本、记忆和运行时状态组装成系统提示与消息历史。
//
// 调用顺序（VirtualPersonRuntime 的普通回合、ambient 回合和后台 host 都走这里）：
//   1. 并行取检索记忆、运行时状态、环境；读她最新一份较早对话摘要（压缩边界）。
//   2. 取边界之后的账本回合，按可读性过滤，补全工具协议，逐条投影成模型消息（projectMessage）。
//   3. PromptAssembler 给出系统提示与本轮背景；ContextBudgeter 超预算时裁掉开头并回调写摘要。
//   4. 返回 { systemPrompt, turnContext, messages, storedMessages, storedTurns, noteView, capabilities, ... }。
// 只读账本，唯一的写入是 summarizeEvictedTurns 的较早对话摘要；不持有回合状态，不调模型。
//
// Python 伪代码：
//   summary = store.latest_summary(person); turns = store.turns(after=summary.to)
//   history = [summary_message] + [project(t) for t in turns if can_read(t)]
//   history = budgeter.prepare(history, on_summary=save_evicted)   # 超预算才压缩
//   return system_prompt, attach(history, turn_context)

import { TurnVisibility } from './VirtualPersonTypes.js';
import { discretionLabel } from '../memory/memoryPolicy.js';
import { INNER_NOTES_CAPABILITY } from '../presence/ambientTools.js';
import { currentTrackOf } from '../presence/ambientTurn.js';
import { stripSpeakerLabel } from './speakerLabel.js';
import { REAL_CLOCK_RESET_MS, historyTimeLabels, sessionElapsedMs, sessionGapLine } from './historyTime.js';
import { formatTurnVoiceEcho, REPLY_CAPABILITY, replayDeliveredBeatMessages } from './replyBeats.js';
import { escapePeerMarkers, mergeAdjacentUserMessages, peerEnvelope } from './peerMessage.js';
import { attachTurnContext, escapeContextMarkers, isSummaryMessage, summaryMessage, SYSTEM_RECORD_OPEN, systemRecordMessage } from './contextBlocks.js';

function trimPartialLeadingRequest(turns) {
  if (!turns.length || turns[0].role === 'user' || !turns[0].requestId) return turns;
  const partialRequestId = turns[0].requestId;
  return turns.filter(turn => turn.requestId !== partialRequestId);
}

export function keepCompleteToolProtocol(turns) {
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
function compactTrackIntroRecord(turn, { content, tracks, about, isPeer, registry }) {
  const title = String(tracks?.[0]?.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const rawGist = String(about || '').replace(/\s+/g, ' ').trim();
  const gist = rawGist
    ? (rawGist.length > 80 ? `${rawGist.slice(0, 79)}…` : rawGist)
    : (() => {
      const first = content.replace(/\s+/g, ' ').trim().split(/[。！？\n]/u)[0]?.trim() || '';
      return first.length > 48 ? `${first.slice(0, 47)}…` : first;
    })();
  const speaker = isPeer ? (registry?.get?.(turn.speakerVirtualPersonId)?.displayName || turn.speakerVirtualPersonId || '同伴') : '';
  const subject = speaker ? `${escapeContextMarkers(speaker)} 当时开播` : '你当时开播';
  const safeTitle = title ? `《${escapeContextMarkers(title)}》` : '那首歌';
  return {
    role: 'user',
    content: gist
      ? `${SYSTEM_RECORD_OPEN} ${subject}聊过${safeTitle}：${escapeContextMarkers(gist)}`
      : `${SYSTEM_RECORD_OPEN} ${subject}了${safeTitle}。`,
  };
}

export function projectMessage(turn, registry, { peerProjection = false, selfId = null, round = 'earlier', timeLabel = '', label = '', voiceEcho = '' } = {}) {
  // 卡片、呈现类型、群聊交接、分段、分拍与语音元数据都是展示元数据，不进入模型历史。
  const { tracks, presentation, groupFloor, hostSuggestion, presence, musicRecommendation, technicalFailure,
    about, queueItemId, segments, voice, beats, ...message } = structuredClone(turn.message);
  if ((turn.role === 'user' || turn.role === 'tool') && typeof message.content === 'string') {
    const content = escapeContextMarkers(escapePeerMarkers(message.content));
    if (turn.role !== 'user') return { ...message, content };
    // 来源标签放在原话之后：私下说的、比较私人的照样在历史里，提不提由她的分寸决定。
    const labelled = label ? `${content}${label}` : content;
    return { ...message, content: timeLabel ? `[${timeLabel}] ${labelled}` : labelled };
  }
  if (turn.role !== 'assistant' || typeof message.content !== 'string') return message;
  const content = stripSpeakerLabel(message.content);
  const isPeer = peerProjection && turn.visibility === TurnVisibility.VISIBLE
    && turn.speakerVirtualPersonId && turn.speakerVirtualPersonId !== selfId;
  // 没有正常回复的那一轮：界面上的固定提示句不进模型历史。自己的换成一条系统记录（她知道那一轮没接上），
  // 同伴的不投影（那不是同伴说的话）。
  if (technicalFailure) return isPeer ? null : systemRecordMessage(technicalFailure);
  // 所有历史串词统一折叠成紧凑系统记录，保持只增前缀缓存稳定并避免聊天被播音腔带偏。
  if (presentation === 'track_intro') return compactTrackIntroRecord(turn, { content, tracks, about, isPeer, registry });
  if (!isPeer) {
    if (!voiceEcho) return { ...message, content };
    return { ...message, content: content ? `${content}\n${voiceEcho}` : voiceEcho };
  }
  if (!content.trim()) return null;
  const speaker = registry.get(turn.speakerVirtualPersonId);
  return { role: 'user', content: peerEnvelope({ name: speaker?.displayName || turn.speakerVirtualPersonId,
    memberId: turn.speakerVirtualPersonId, round, text: escapeContextMarkers(content) }) };
}

function boundedCumulativeSummary(previousContent, deltaContent, max = 7600) {
  const combined = [previousContent, deltaContent].map(value => String(value || '').trim()).filter(Boolean).join('\n');
  if (combined.length <= max) return combined;
  const half = Math.floor((max - 80) / 2);
  return `${combined.slice(0, half)}\n[中间较早内容已压缩]\n${combined.slice(-half)}`;
}

// 一次取压缩边界之后的多少行账本（listTurns 的上限）。正常情况下预算会先触发压缩，取不满。
const HISTORY_ROW_LIMIT = 500;

export class TurnContextAssembler {
  constructor({ conversationStore, registry, promptAssembler, contextBudgeter = null, retrieveMemories = async () => [],
    getRuntimeState = () => null, getEnvironment = null, getLifeContext = null, logger = console } = {}) {
    this.conversationStore = conversationStore;
    this.registry = registry;
    this.promptAssembler = promptAssembler;
    this.contextBudgeter = contextBudgeter;
    this.retrieveMemories = retrieveMemories;
    this.getRuntimeState = getRuntimeState;
    this.getEnvironment = typeof getEnvironment === 'function' ? getEnvironment : null;
    this.getLifeContext = typeof getLifeContext === 'function' ? getLifeContext : null;
    this.logger = logger;
  }

  /**
   * 普通回合、ambient 回合与后台 host 共用的上下文组装：记忆、运行时状态、环境、今日计划、较早摘要、
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
  async assemble({ entity, sessionId, clientState = null, capabilities = [], memberIds, memoryQuery = '',
    musicOwnerId = entity.id, groupFloor = null, includeRequestId = null, canRead, persistSummaries = false,
    ambient = null, innerNotes = null, peerRecommendations = [], pendingRecommendation = null }) {
    const isGroup = memberIds.length > 1;
    const [memories, runtimeState, environment, lifeContext] = await Promise.all([
      this.retrieveMemories({
        query: String(memoryQuery || ''),
        namespace: entity.memoryNamespace,
        virtualPersonId: entity.id,
        sessionId,
        isGroup,
        memberIds,
      }),
      this.getRuntimeState({ entity, clientState, sessionId }),
      // 天气快照在组装前取好（env 内部有缓存）；失败不阻塞对话。
      this.getEnvironment
        ? Promise.resolve().then(() => this.getEnvironment({ entity, sessionId })).catch(() => null)
        : Promise.resolve(null),
      this.getLifeContext
        ? Promise.resolve(this.getLifeContext({ sessionId, entity, participants: memberIds })).catch(() => null)
        : Promise.resolve(null),
    ]);
    const normalizedQuery = String(memoryQuery || '').trim();
    const promptMemories = (Array.isArray(memories) ? memories : []).filter(item =>
      String(item?.content || item?.summary || '').trim() !== normalizedQuery);
    // scan：本轮两次读摘要共用一次可读性扫描（见 ConversationStore.listSummaries）。
    const summaryScope = { limit: 1, personId: entity.id, isGroup, scan: {} };
    const noteView = this.innerNoteView({ entity, sessionId, isGroup, runtimeState, options: innerNotes });
    const effectiveCapabilities = noteView.items.length && !capabilities.includes(INNER_NOTES_CAPABILITY)
      ? [...capabilities, INNER_NOTES_CAPABILITY] : capabilities;
    // 历史窗口 = 上次压缩边界（她最新一份可读摘要的 toSequence）之后的全部回合，只追加不滑动；
    // 超出预算时由 contextBudgeter 成批裁掉开头并推进边界（见下方 onSummary）。
    let summary = this.conversationStore.listSummaries(sessionId, summaryScope).at(-1) || null;
    const fetched = this.conversationStore.listTurns(sessionId, {
      limit: HISTORY_ROW_LIMIT,
      afterSequence: summary?.toSequence ?? 0,
      ...(includeRequestId ? { includeRequestId } : {}),
    });
    const rawStoredTurns = trimPartialLeadingRequest(fetched);
    // 边界之后的回合多到一次取不完（升级前的长聊天、摘要随来源撤回后重建）：先把取不到的那段并入摘要。
    if (persistSummaries && fetched.length >= HISTORY_ROW_LIMIT && rawStoredTurns.length) {
      this.summarizeEvictedTurns({ sessionId, entity, windowStart: rawStoredTurns[0],
        summaryScope: { ...summaryScope, scan: null }, canRead });
      summaryScope.scan = {};
      summary = this.conversationStore.listSummaries(sessionId, summaryScope).at(-1) || null;
    }
    const nowMs = this.promptAssembler.now?.()?.getTime?.() ?? Date.now();
    const visibleTurns = rawStoredTurns.filter(turn => canRead(turn));
    const room = typeof this.conversationStore.getSession === 'function' ? this.conversationStore.getSession(sessionId) : null;
    const interactionMode = room?.interactionMode === 'roleplay' ? 'roleplay' : 'radio';
    const promptInput = {
      entity,
      capabilities: effectiveCapabilities,
      runtimeState,
      environment,
      memories: promptMemories,
      participants: memberIds.map(id => this.registry.get(id)).filter(Boolean),
      musicOwnerId,
      companionMode: runtimeState?.companionMode || null,
      interactionMode: (interactionMode === 'roleplay' || effectiveCapabilities.includes(REPLY_CAPABILITY))
        ? interactionMode
        : null,
      groupFloor,
      ...(peerRecommendations.length ? { peerRecommendations } : {}),
      ...(pendingRecommendation ? { pendingRecommendation } : {}),
      lifeContext,
      ...(ambient ? { ambient } : {}),
      ...(noteView.items.length ? { innerNotes: { mode: innerNotes.mode, items: noteView.items } } : {}),
      sessionGap: sessionGapLine(visibleTurns, nowMs),
    };
    // 稳定小节进系统提示；每轮都变的小节（turnContext）附在最后一条 user 消息上，排在全部历史之后。
    const { systemPrompt, turnContext = '' } = typeof this.promptAssembler.assembleParts === 'function'
      ? this.promptAssembler.assembleParts(promptInput)
      : { systemPrompt: this.promptAssembler.assemble(promptInput) };
    const storedTurns = keepCompleteToolProtocol(visibleTurns);
    const timeLabels = historyTimeLabels(storedTurns, nowMs);
    const gapMs = sessionElapsedMs(visibleTurns, nowMs);
    const allowVoiceEcho = gapMs === null || gapMs < REAL_CLOCK_RESET_MS;
    const replayAllowsAction = interactionMode === 'roleplay' && !isGroup;
    // 只有本次调用开放了 deliver_reply 才按交付调用回放；ambient、串词等其他任务保持原投影。
    const replayEnabled = effectiveCapabilities.includes(REPLY_CAPABILITY);
    const replaysAsDelivered = turn => replayEnabled
      && turn.role === 'assistant'
      && turn.visibility === TurnVisibility.VISIBLE
      && turn.speakerVirtualPersonId === entity.id
      && Array.isArray(turn.message?.beats) && turn.message.beats.length > 0
      && turn.message?.presentation !== 'track_intro'
      && !turn.message?.technicalFailure;
    // 群聊，或历史里出现过别人说的话（单人聊天换过角色）时，按「自己/同伴」投影并合并相邻 user。
    const peerProjection = memberIds.length > 1 || storedTurns.some(turn => turn.visibility === TurnVisibility.VISIBLE
      && turn.role === 'assistant'
      && turn.speakerVirtualPersonId
      && turn.speakerVirtualPersonId !== entity.id);
    const projectTurnsToMessages = (turns, { includeVoiceEcho = allowVoiceEcho } = {}) => {
      const lastUserIndex = turns.findLastIndex(turn => turn.role === 'user');
      const voiceEchoes = new Map();
      if (includeVoiceEcho) {
        let remaining = 2;
        for (let i = turns.length - 1; i >= 0 && remaining > 0; i -= 1) {
          const turn = turns[i];
          if (turn.role !== 'assistant' || turn.visibility !== TurnVisibility.VISIBLE) continue;
          if (turn.speakerVirtualPersonId !== entity.id) continue;
          if (turn.message?.presentation === 'track_intro' || turn.message?.technicalFailure) continue;
          if (Number.isFinite(turn.createdAt) && turn.createdAt <= nowMs && nowMs - turn.createdAt >= REAL_CLOCK_RESET_MS) {
            continue;
          }
          const echo = formatTurnVoiceEcho(turn.message?.beats);
          if (!echo) continue;
          voiceEchoes.set(turn.turnId, echo);
          remaining -= 1;
        }
      }
      const projected = [];
      turns.forEach((turn, index) => {
        if (replaysAsDelivered(turn)) {
          // 自己的分拍回复以交付工具调用回放（replay-replies-as-delivered-beats）：历史示范真实交付方式。
          for (const message of replayDeliveredBeatMessages(turn, { allowAction: replayAllowsAction,
            voiceEcho: voiceEchoes.get(turn.turnId) || '' })) projected.push({ index, message });
          return;
        }
        const message = projectMessage(turn, this.registry, { peerProjection, selfId: entity.id,
          round: index > lastUserIndex ? 'current' : 'earlier', timeLabel: timeLabels.get(turn.turnId),
          label: index >= lastUserIndex ? '' : this.turnLabel(entity.id, turn),
          voiceEcho: voiceEchoes.get(turn.turnId) || '' });
        if (!message) return;
        projected.push({ index, message });
      });
      const merged = peerProjection
        ? mergeAdjacentUserMessages(projected.map(item => item.message))
        : { messages: projected.map(item => item.message), sources: projected.map((_, position) => [position]) };
      return {
        storedMessages: merged.messages,
        // 模型消息下标 → 账本 turn（合并后一条消息可能对应多条 turn），供摘要与复用切片使用。
        messageTurns: merged.sources.map(positions => positions.map(position => turns[projected[position].index])),
      };
    };
    const { storedMessages, messageTurns } = projectTurnsToMessages(storedTurns);
    // 较早对话摘要是历史的第一条消息；两次压缩之间它和后面的历史都逐字节不变。
    const head = summaryMessage(summary?.content);
    const headOffset = head ? 1 : 0;
    const onSummary = info => {
      // 预算裁剪在 await 之后回调，期间可能有撤回等写入，不复用本轮扫描。
      const scope = { ...summaryScope, scan: null };
      const firstKept = messageTurns[info.keptFrom - headOffset]?.[0];
      if (firstKept) this.summarizeEvictedTurns({ sessionId, entity, windowStart: firstKept, summaryScope: scope, canRead, method: info.method });
      return summaryMessage(this.conversationStore.listSummaries(sessionId, scope).at(-1)?.content);
    };
    const budgetInput = head ? [head, ...storedMessages] : storedMessages;
    const history = this.contextBudgeter
      ? await this.contextBudgeter.prepare(budgetInput, persistSummaries ? { onSummary } : {})
      : budgetInput;
    const finalMessages = attachTurnContext(history, turnContext);
    // 供同一回合结束后的 line pass 直接复用本轮上下文（不重查 DB/记忆），若存在历史串词则仅在内存剔除。
    const hasTrackIntros = storedTurns.some(turn => turn.message?.presentation === 'track_intro');
    const linePassMessages = async () => {
      if (!hasTrackIntros) return finalMessages;
      const keptSummaryHead = isSummaryMessage(history[0]) ? history[0] : null;
      const keptCount = history.length - (keptSummaryHead ? 1 : 0);
      const startMessageIndex = Math.max(0, storedMessages.length - keptCount);
      const cleanTurns = messageTurns.slice(startMessageIndex).flat()
        .filter(turn => turn.message?.presentation !== 'track_intro');
      const { storedMessages: cleanStored } = projectTurnsToMessages(cleanTurns, { includeVoiceEcho: false });
      const rawClean = keptSummaryHead ? [keptSummaryHead, ...cleanStored] : cleanStored;
      const budgetedClean = this.contextBudgeter ? await this.contextBudgeter.prepare(rawClean, {}) : rawClean;
      return attachTurnContext(budgetedClean, turnContext);
    };
    return { systemPrompt, turnContext, messages: finalMessages,
      historyEndsWithAssistant: history.at(-1)?.role === 'assistant'
        || (history.at(-1)?.role === 'tool' && String(history.at(-1)?.tool_call_id || '').startsWith('replay_')),
      preBudgeted: Boolean(this.contextBudgeter),
      linePassMessages,
      interactionMode,
      isGroup,
      storedMessages, storedTurns, runtimeState, noteView, lifeContext, capabilities: effectiveCapabilities };
  }

  summaryLine(turn, personId = null) {
    const speaker = turn.role === 'assistant'
      ? this.registry.get(turn.speakerVirtualPersonId)?.displayName || turn.speakerVirtualPersonId : 'user';
    const label = personId && turn.role === 'user' ? this.turnLabel(personId, turn) : '';
    return `${speaker}: ${String(turn.message?.content || '').slice(0, 500)}${label}`;
  }

  /** 用户原话在她历史与摘要里的来源标签；读不到或没有标记时为空。 */
  turnLabel(personId, turn) {
    if (turn.role !== 'user' || typeof this.conversationStore.readTurnAs !== 'function') return '';
    return discretionLabel(this.conversationStore.readTurnAs(personId, turn).policy || {});
  }

  /**
   * 把压缩边界之后、windowStart 之前的可见用户/助手消息并入较早摘要，并把边界推进到 windowStart 之前
   * （align-context-compaction-and-cache）。只在历史超出预算、要成批裁掉开头时调用：两次压缩之间摘要不变。
   * 确定性拼接，不调模型。摘要按聊天账本可见性过滤（listSummaries），撤回/改写时随来源隐藏，下次压缩时重建。
   * Python 伪代码：
   *   prev = latest_summary(); evicted = visible_turns(prev.to < seq < window_start)
   *   save_summary(prev.content + lines(evicted), to=window_start - 1)
   */
  summarizeEvictedTurns({ sessionId, entity, windowStart, summaryScope, canRead, method = 'window-evicted-deterministic' }) {
    if (!windowStart || typeof this.conversationStore.saveSummary !== 'function') return;
    const previous = this.conversationStore.listSummaries(sessionId, summaryScope).at(-1) || null;
    // 加入前的历史整段不扫：起点取她最早在场的回合，不把加入前的回合逐条记进排除清单。
    const first = this.conversationStore.firstPresentSequence?.(sessionId, entity.id);
    if (first === null) return;
    const after = Math.max(previous?.toSequence ?? 0, (first ?? 1) - 1);
    const boundary = windowStart.sequence - 1;
    if (boundary <= after) return;
    const evicted = [];
    let before = windowStart.sequence;
    while (before > after + 1) {
      const page = this.conversationStore.listTurns(sessionId, { limit: 500, beforeSequence: before, visibleOnly: true });
      if (!page.length) break;
      evicted.unshift(...page.filter(turn => turn.sequence > after));
      before = page[0].sequence;
      if (page.length < 500) break;
    }
    // 每条回合只判一次能否读（整段重建时回合数可达上万）。
    // 长期摘要只收她在场时的回合：加入前的公开历史只作有界的近期上下文，不滚进摘要。
    const present = turn => this.conversationStore.witnessedByAll?.(turn.turnId, [entity.id]) ?? true;
    const unreadable = new Set(evicted.filter(turn => !canRead(turn) || !present(turn)).map(turn => turn.turnId));
    // 固定的失败提示句不是谁说的话，不写进摘要。
    const lines = evicted.filter(turn => (turn.role === 'user' || turn.role === 'assistant') && !unreadable.has(turn.turnId)
      && !turn.message?.technicalFailure && String(turn.message?.content || '').trim());
    // 被裁掉的这段没有她能读的话：已有摘要时只推进边界；还没有摘要就不写（没有内容可写）。
    if (!lines.length && !previous) return;
    // 没写进摘要的读不到的 turn 记下来，读时不拿它们挡掉整份摘要；沿用旧摘要（无记录）时保持整段校验。
    const excludedTurnIds = previous && previous.excludedTurnIds == null ? null
      : [...(previous?.excludedTurnIds || []), ...unreadable];
    this.conversationStore.saveSummary({
      sessionId,
      personId: entity.id,
      fromSequence: previous?.fromSequence || lines[0].sequence,
      // 边界落在保留段的前一条：下一轮的窗口正好从保留段开始。
      toSequence: boundary,
      content: boundedCumulativeSummary(previous?.content, lines.map(turn => this.summaryLine(turn, entity.id)).join('\n')),
      method,
      excludedTurnIds,
    });
  }

  /** 心里话的只读视图：短编号只在这一轮有效，真实 noteId 不出现在提示词里。读失败等同没有心里话。 */
  innerNoteView({ entity, sessionId, isGroup, runtimeState, options }) {
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
        sensitive: note.sensitive, policy: { disclosure: note.policy?.disclosure } };
    });
    return { items, map };
  }
}
