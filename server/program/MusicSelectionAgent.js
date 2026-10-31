import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from './musicSelectionRequest.js';

/**
 * 自动选歌任务运行器：自动续播、手动下一首等后台任务复用同一个 AgentLoop，
 * 但工具被限制为 select_music + commit_music_selection，并且不插入任何合成用户消息、
 * 不写对话账本。任务身份（会话、请求、原因、输出代次、isCurrent）随
 * `toolContext.musicTaskRequest` 一起交给工具：模型只能在这份锁定请求上选序号。
 */
const TASK_TOOLS = Object.freeze(['select_music', 'commit_music_selection']);
// 一次正常任务至少要能走完 select → commit →（一次纠正后）commit：三轮工具回合
// 之外还可能有一轮用于重新取候选，所以预算留到 5 轮，而不是刚好卡在纠正序列上。
const DEFAULT_MAX_ROUNDS = 5;

const REASON_COPY = {
  auto_continue: '队列到边界了，为这个聊天续上接下来要听的歌',
  user_request: '用户要求换一批歌',
  manual_next: '用户手动要下一首',
};

const TASK_SYSTEM_PROMPT = `你在为一个正在一起听的聊天完成一次自动选歌任务。这是系统任务，不是用户对话：
- 不要问候、不要复述聊天历史、不要向用户提问、不要输出面向用户的闲聊或解释。
- 只使用 select_music 与 commit_music_selection 两个工具；不要编造候选之外的歌曲、歌手、歌单或 songId，也不要改用其它搜索工具。
- 流程：1) 调用 select_music 取得候选（调用参数会被任务锁定的请求取代，所以直接传 {} 即可；
  不要从下面的「锁定请求」里抄字段，那里的 null 只是内部表示，作为工具参数非法）；2) 从返回的 candidates 里挑选 1 至 10 个 index；3) 用同一个 offerId 和选中的 indexes 调用 commit_music_selection。
- 候选不是已经播放的歌，提交也不等于已经出声；不要生成播报文案，也不要声称已经在播放。
- 硬约束、交付方式与数量由任务锁定：不要改写它们，也不要因为候选不合心意就放宽条件。
- 候选不合适时宁可少选几首或如实失败，也不要用候选以外的歌顶替。`;

// 角色身份（D2）：续播以当前音乐负责角色的身份挑歌，口味/反馈/近期收听都在 select_music 的 brief 里；
// 这里不注入聊天记录，也不新增合成的用户消息。
const BRIEF_FIRST = '先读 select_music 返回的 brief（选歌简报）和每首候选的 features，再选序号；简报不放宽锁定请求里的任何条件。';

export function personaLine(displayName) {
  const name = bounded(String(displayName || '').replace(/[\r\n]+/g, ' '), 40);
  return name ? `你是${name}，在为一起听的用户挑下一批歌。${BRIEF_FIRST}` : `你在为一起听的用户挑下一批歌。${BRIEF_FIRST}`;
}

const PREPARATION_NOTE = '本任务只准备候选：commit_music_selection 只登记你选中的序号，不会播放；后续由调用方自行解析可播放版本。';

function bounded(text, max = 300) {
  return String(text || '').trim().slice(0, max);
}

/**
 * 锁定请求在模型提示里的**公开视图**：内部归一化请求用 `null` 表示“没有这个条件”，
 * 但那是内部表示，不是工具参数。模型照抄 `playlist:null` / `constraints.requiredVersion:null`
 * 会被工具入口的 JSON schema 判非法（`$.playlist must be object`），白白浪费一轮修正。
 * 这里只列出真正存在的字段；schema 的严格性不动，`null` 在工具参数里依旧非法。
 */
function compactRequest(value) {
  if (Array.isArray(value)) return value.map(compactRequest);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item != null)
    .map(([key, item]) => [key, compactRequest(item)]));
}

export function publicRequestBrief(request) {
  try { return bounded(JSON.stringify(compactRequest(request) || {}), 1200); } catch { return '{}'; }
}

/**
 * 工具 outcome 的有限原因：优先显式 reason（如 `resolution failed (qq)`）；
 * 失败且没有显式 reason 时退到 modelContext 里第一段非“运行结果”的内部状态行。
 * 有界、非敏感：这是诊断字段，不是用户文案。
 */
function outcomeReason(outcome) {
  const facts = outcome?.facts && typeof outcome.facts === 'object' ? outcome.facts : {};
  const explicit = bounded(facts.reason, 200);
  if (explicit) return explicit;
  if (outcome?.ok === true) return '';
  const line = String(outcome?.modelContext || '').split('\n').map(text => text.trim())
    .find(text => text && !text.startsWith('运行结果')) || '';
  return bounded(line, 200);
}

/** 受限任务的工具结果追踪事件：只记身份与有限原因，不记完整 prompt/上下文。 */
function toolResultTraceEvent(name, outcome, toolCallId) {
  return {
    type: 'task_tool_result',
    name: name || null,
    toolCallId: toolCallId || null,
    ok: outcome?.ok === true,
    code: outcome?.code || null,
    terminal: outcome?.terminal === true,
    reason: outcomeReason(outcome),
    message: bounded(outcome?.presentation?.displayText, 200),
  };
}

function commitResult(outcome, fallbackOfferId = null) {
  const facts = outcome?.facts && typeof outcome.facts === 'object' ? outcome.facts : {};
  const result = {
    ok: true,
    code: outcome?.code || 'MUSIC_COMMITTED',
    tracks: Array.isArray(facts.tracks) ? facts.tracks : [],
    delivery: facts.delivery || null,
    selectionId: facts.selectionId || null,
    message: bounded(outcome?.presentation?.displayText || ''),
  };
  if (Array.isArray(facts.indexes)) {
    result.offeredIndexes = facts.indexes;
    result.indexes = facts.indexes;
  }
  const offerId = facts.offerId ? String(facts.offerId) : fallbackOfferId ? String(fallbackOfferId) : null;
  if (offerId) result.offerId = offerId;
  if (facts.prepared === true) result.prepared = true;
  return result;
}

export function createMusicSelectionAgent({ agentLoop, toolRegistry, maxRounds = DEFAULT_MAX_ROUNDS, sessionTrace = null,
  registry = null } = {}) {
  if (!agentLoop || typeof agentLoop.run !== 'function') throw new TypeError('createMusicSelectionAgent requires agentLoop.run()');
  if (!toolRegistry || typeof toolRegistry.definitions !== 'function') throw new TypeError('createMusicSelectionAgent requires toolRegistry');
  const registered = new Set(toolRegistry.definitions({ capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY] })
    .map(definition => String(definition?.function?.name || '')));
  const missing = TASK_TOOLS.filter(name => !registered.has(name));
  if (missing.length) throw new TypeError(`createMusicSelectionAgent requires registered tools: ${missing.join(', ')}`);
  const rounds = Math.max(1, Number(maxRounds) || DEFAULT_MAX_ROUNDS);
  // 只取显示名：人设正文、声音与记忆不进任务提示（伙伴审美已由简报单独标注）。
  const displayNameOf = personId => {
    if (!personId) return '';
    try { return registry?.get?.(personId)?.displayName || ''; } catch { return ''; }
  };

  return Object.freeze({
    /**
     * @param input {{ request: object, context?: object, reason?: string, sessionId?: string,
     *   signal?: AbortSignal, isCurrent?: Function, mode?: 'playback'|'preparation',
     *   sessionTrace?: object|null }}
     */
    async run({ request, context = null, reason = 'user_request', sessionId = null, signal = null,
      isCurrent = null, mode = 'playback', sessionTrace: runTrace = null } = {}) {
      const preparation = mode === 'preparation';
      const guard = typeof isCurrent === 'function' ? isCurrent
        : (typeof context?.isCurrent === 'function' ? context.isCurrent : null);
      const taskReason = String(reason || 'user_request');
      const taskRequest = request || null;
      const taskSessionId = sessionId || context?.sessionId || null;
      // 任务事实：触发原因与输出代次只从锁定任务来，模型无法改写。
      const musicTaskRequest = Object.freeze({
        request: taskRequest,
        reason: taskReason,
        sessionId: taskSessionId,
        outputGeneration: context?.outputGeneration ?? null,
        isCurrent: guard,
        mode: preparation ? 'preparation' : 'playback',
        resolveOnly: preparation,
        // 预热凭据：preparation 模式由 commitSelection 记到 offer 上，供边界核对后采用。
        preparedFor: context?.preparedFor && typeof context.preparedFor === 'object' ? context.preparedFor : null,
      });
      const toolNames = new Map();
      const results = [];
      let loopError = null;
      // 运行时触发的预热/续播也是同一个主 Agent 的执行流程：进入同一会话的 JSONL
      // 追踪上下文，nested 工具与模型观测事件因此落在同一个聊天文件里。
      // 只提供 record/recordScoped 的门面同样能收事件（enter 可选）。
      const traceApi = value => Boolean(value && (typeof value.enter === 'function'
        || typeof value.record === 'function' || typeof value.recordScoped === 'function'));
      const trace = traceApi(runTrace) ? runTrace : (traceApi(sessionTrace) ? sessionTrace : null);
      // 受限任务此前不记任何工具结果：失败原因（如 MUSIC_NOT_COMMITTED 的解析摘要）
      // 在追踪里没有着落。每个捕获到的工具结果记一条 task_tool_result，收尾记
      // task_completed；只记身份与有限原因，不记完整 prompt/上下文（模型观测已覆盖请求）。
      const recordTrace = event => {
        if (!trace) return;
        const identity = { requestId: context?.requestId || null, roundId: context?.roundId || null,
          virtualPersonId: context?.virtualPersonId || null };
        try {
          if (typeof trace.recordScoped === 'function') trace.recordScoped(taskSessionId, event, identity);
          else if (typeof trace.record === 'function') trace.record({ sessionId: taskSessionId, ...identity }, event);
        } catch { /* 追踪失败不影响任务结果 */ }
      };
      const taskRun = () => agentLoop.run({
          // 纯任务系统提示：没有伪造的用户话术，也不往对话账本写任何轮次。
          systemPrompt: [
            TASK_SYSTEM_PROMPT,
            personaLine(displayNameOf(context?.virtualPersonId)),
            `本次任务：${REASON_COPY[taskReason] || taskReason}。`,
            `锁定请求（只读，工具据此执行；不要把这些字段抄进工具参数）：${publicRequestBrief(taskRequest)}`,
            preparation ? PREPARATION_NOTE : '',
          ].filter(Boolean).join('\n'),
          messages: [],
          capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
          modelProfileId: 'music_selection',
          profileOverrides: { maxRounds: rounds, emptyRetry: false },
          correlationId: context?.correlationId || context?.requestId || '',
          sessionId: taskSessionId,
          toolNames: [...TASK_TOOLS],
          toolContext: {
            sessionId: taskSessionId,
            requestId: context?.requestId || null,
            roundId: context?.roundId || null,
            virtualPersonId: context?.virtualPersonId || null,
            groupAction: context?.groupAction || null,
            reason: taskReason,
            outputGeneration: musicTaskRequest.outputGeneration,
            isCurrent: guard,
            preparedFor: musicTaskRequest.preparedFor,
            musicTaskRequest,
          },
          onMessage: event => {
            if (event?.kind === 'assistant_tool_calls') {
              for (const call of event.message?.tool_calls || []) {
                toolNames.set(String(call?.id || ''), String(call?.function?.name || ''));
              }
            } else if (event?.kind === 'tool_result') {
              const toolCallId = String(event.message?.tool_call_id || '');
              const name = toolNames.get(toolCallId) || null;
              results.push({ name, outcome: event.outcome, toolCallId });
              recordTrace(toolResultTraceEvent(name, event.outcome, toolCallId));
            }
          },
          signal,
        });
      try {
        if (typeof trace?.enter === 'function' && taskSessionId) {
          await trace.enter({ sessionId: taskSessionId, requestId: context?.requestId || null,
            roundId: context?.roundId || null, virtualPersonId: context?.virtualPersonId || null }, taskRun);
        } else {
          await taskRun();
        }
      } catch (error) {
        // 工具结果优先于循环异常：已接受的提交不因为后续回合失败而丢失。
        loopError = error;
      }
      const finalize = result => {
        recordTrace({ type: 'task_completed', mode: preparation ? 'preparation' : 'playback', reason: taskReason,
          ok: result.ok === true, code: result.code || null, message: bounded(result.message, 200),
          ...(result.loopErrorCode ? { loopErrorCode: result.loopErrorCode } : {}) });
        return result;
      };
      const lastOf = name => [...results].reverse().find(entry => entry.name === name) || null;
      const commit = [...results].reverse().find(entry => entry.name === 'commit_music_selection' && entry.outcome?.ok === true);
      const offer = lastOf('select_music');
      const offeredId = offer?.outcome?.facts?.offerId || null;
      if (commit) return finalize(commitResult(commit.outcome, offeredId));
      // 具体业务失败优先于通用循环错误：回合额度只是“没走完”，不能掩盖真正没提交上的原因。
      const failedCommit = lastOf('commit_music_selection');
      if (failedCommit) {
        const reason = outcomeReason(failedCommit.outcome);
        const failure = { ok: false, code: bounded(failedCommit.outcome?.code || 'MUSIC_NOT_COMMITTED', 80),
          message: reason || bounded(failedCommit.outcome?.presentation?.displayText, 300) || '这次没有完成选歌提交。' };
        if (reason) failure.reason = reason;
        if (loopError) failure.loopErrorCode = bounded(loopError.code || 'MUSIC_SELECTION_AGENT_FAILED', 80);
        return finalize(failure);
      }
      if (loopError) {
        return finalize({ ok: false, code: bounded(loopError.code || 'MUSIC_SELECTION_AGENT_FAILED', 80),
          message: bounded(loopError.message || '自动选歌任务没有完成。') });
      }
      if (offer) {
        return finalize({ ok: false, code: bounded(offer.outcome?.code || 'MUSIC_NOT_COMMITTED', 80),
          offerId: offer.outcome?.facts?.offerId || null,
          message: bounded(offer.outcome?.presentation?.displayText || '这次没有做到提交，队列没有变化。') });
      }
      return finalize({ ok: false, code: 'MUSIC_NOT_COMMITTED', message: '这次没有做到提交，队列没有变化。' });
    },
  });
}

export { TASK_SYSTEM_PROMPT };
