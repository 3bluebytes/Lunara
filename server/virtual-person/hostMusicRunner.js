// hostMusicRunner.js — 没有听众消息时 host 自己选歌的回合（续播、手动下一首、预热）。
//
// 这不是另一个 Agent：同一个人、同一段上下文，只是这一轮只开放选歌工具，普通文字不进聊天。
// 触发消息不入账。音乐落定后接一轮只能写串词的 line pass（VirtualPersonRuntime.startLinePass）。
//
//   def run(request):
//       ctx = host.assemble_host_context(person, session)        # 失败 -> 如实失败，不回退
//       loop.run(ctx.system, ctx.messages + [trigger], tools=[select_music, commit_music_selection])
//       if committed and has_targets: host.start_line_pass(...)  # 不等待，结果先返回给调用方

import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';
import { createLineCollector } from '../program/trackLinePass.js';

const TASK_TOOLS = Object.freeze(['select_music', 'commit_music_selection']);
// 一次正常任务至少要能走完 select → commit →（一次纠正后）commit：三轮工具回合
// 之外还可能有一轮用于重新取候选，所以预算留到 5 轮，而不是刚好卡在纠正序列上。
const DEFAULT_MAX_ROUNDS = 5;

const REASON_COPY = {
  auto_continue: '队列到边界了，为这个聊天续上接下来要听的歌',
  user_request: '用户要求换一批歌',
  manual_next: '用户手动要下一首',
};

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

/** 选歌触发消息：不入账，也不是听众说的话。 */
export function renderSelectionTrigger({ reason, request, preparation = false }) {
  const content = [
    `（这不是听众的消息。）${REASON_COPY[reason] || reason}。`,
    '流程：1) 调用 select_music 取得候选（条件已锁定，直接传 {}；不要从下面抄字段，null 作为工具参数非法）；2) 先读返回的 brief 和每首候选的 features，再挑 1 至 10 个序号，简报不放宽锁定条件；3) 用同一个 offerId 和选中的 indexes 调用 commit_music_selection；可以顺手在 notes 里给每首留一句你为什么这会儿想放它，之后写串词时你会看到。',
    '只从 candidates 里挑，不编造候选之外的歌。不合适就少选几首或如实失败，不要放宽条件。提交不等于已经出声。这一步写的普通文字听众看不到，也不会进聊天。',
    `锁定请求（只读，工具据此执行）：${publicRequestBrief(request)}`,
    preparation ? PREPARATION_NOTE : '',
  ].filter(Boolean).join('\n');
  return { role: 'user', content };
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

/** 工具结果追踪事件：只记身份与有限原因，不记完整 prompt/上下文。 */
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

const traceApi = value => Boolean(value && (typeof value.enter === 'function'
  || typeof value.record === 'function' || typeof value.recordScoped === 'function'));

export function createHostMusicRunner({ agentLoop, toolRegistry, host, registry, maxRounds = DEFAULT_MAX_ROUNDS, sessionTrace = null } = {}) {
  if (!agentLoop || typeof agentLoop.run !== 'function') throw new TypeError('createHostMusicRunner requires agentLoop.run()');
  if (!toolRegistry || typeof toolRegistry.definitions !== 'function') throw new TypeError('createHostMusicRunner requires toolRegistry');
  if (!host || typeof host.assembleHostContext !== 'function') throw new TypeError('createHostMusicRunner requires host.assembleHostContext()');
  if (!registry || typeof registry.get !== 'function') throw new TypeError('createHostMusicRunner requires registry');
  const registered = new Set(toolRegistry.definitions({ capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY] })
    .map(definition => String(definition?.function?.name || '')));
  const missing = TASK_TOOLS.filter(name => !registered.has(name));
  if (missing.length) throw new TypeError(`createHostMusicRunner requires registered tools: ${missing.join(', ')}`);
  const rounds = Math.max(1, Number(maxRounds) || DEFAULT_MAX_ROUNDS);
  // 预热的结果 → 这一轮的上下文：批次存下之后写串词要接着同一段上下文。
  const preparedRuns = new WeakMap();

  return Object.freeze({
    isBusy: sessionId => host.hostBusy?.(sessionId) === true,
    whenIdle: sessionId => host.whenBackgroundHostIdle?.(sessionId) ?? Promise.resolve(),

    /**
     * @param input {{ request: object, planRequest?: object|null, context?: object, reason?: string, sessionId?: string,
     *   signal?: AbortSignal, isCurrent?: Function, mode?: 'playback'|'preparation',
     *   sessionTrace?: object|null }}
     */
    async run({ request, planRequest = null, context = null, reason = 'user_request', sessionId = null, signal = null,
      isCurrent = null, mode = 'playback', sessionTrace: runTrace = null } = {}) {
      const preparation = mode === 'preparation';
      const guard = typeof isCurrent === 'function' ? isCurrent
        : (typeof context?.isCurrent === 'function' ? context.isCurrent : null);
      const taskReason = String(reason || 'user_request');
      const taskRequest = request || null;
      const taskSessionId = sessionId || context?.sessionId || null;
      const requestId = context?.requestId || null;
      const personId = context?.virtualPersonId || null;
      const identity = { requestId, roundId: context?.roundId || null, virtualPersonId: personId };
      // 任务事实：触发原因与输出代次只从锁定任务来，模型无法改写。
      const musicTaskRequest = Object.freeze({
        request: taskRequest,
        // 提交后存回 runtime 的计划（续播时不带这一轮的软锚点）；null 表示就用 request。
        planRequest: planRequest || null,
        reason: taskReason,
        sessionId: taskSessionId,
        outputGeneration: context?.outputGeneration ?? null,
        isCurrent: guard,
        mode: preparation ? 'preparation' : 'playback',
        resolveOnly: preparation,
        // 预热凭据：preparation 模式由 commitSelection 记到 offer 上，供边界核对后采用。
        preparedFor: context?.preparedFor && typeof context.preparedFor === 'object' ? context.preparedFor : null,
      });
      const trace = traceApi(runTrace) ? runTrace : (traceApi(sessionTrace) ? sessionTrace : null);
      const recordTrace = event => {
        if (!trace) return;
        try {
          if (typeof trace.recordScoped === 'function') trace.recordScoped(taskSessionId, event, identity);
          else if (typeof trace.record === 'function') trace.record({ sessionId: taskSessionId, ...identity }, event);
        } catch { /* 追踪失败不影响任务结果 */ }
      };
      const toolNames = new Map();
      const results = [];
      const tail = [];
      const collector = createLineCollector();
      const memberToken = host.conversationStore?.membershipToken?.(taskSessionId, personId);
      const activity = typeof host.acquireBackgroundHost === 'function'
        ? await host.acquireBackgroundHost(taskSessionId, { signal })
        : host.enterBackgroundHost?.(taskSessionId) || null;
      const loopSignal = [signal, activity?.signal].filter(Boolean);
      const taskSignal = loopSignal.length > 1 ? AbortSignal.any(loopSignal) : loopSignal[0] || null;
      let assembled = null;
      let trigger = null;
      let entity = null;
      let loopError = null;
      const taskRun = async () => {
        taskSignal?.throwIfAborted();
        if (guard && !guard()) throw Object.assign(new Error('host task is stale'), { code: 'STALE_HOST_TASK' });
        if (memberToken != null && host.conversationStore.membershipToken(taskSessionId, personId) !== memberToken) {
          throw Object.assign(new Error('host membership changed'), { code: 'HOST_UNAVAILABLE' });
        }
        entity = registry.get(personId);
        if (!entity) throw Object.assign(new Error('host unavailable'), { code: 'HOST_UNAVAILABLE' });
        // 上下文取不到就是这轮失败：没有“简化提示词”的回退路径。
        assembled = await host.assembleHostContext({ entity, sessionId: taskSessionId, requestId });
        taskSignal?.throwIfAborted();
        if (guard && !guard()) throw Object.assign(new Error('host task is stale'), { code: 'STALE_HOST_TASK' });
        trigger = renderSelectionTrigger({ reason: taskReason, request: taskRequest, preparation });
        await agentLoop.run({
          systemPrompt: assembled.systemPrompt,
          messages: [...assembled.messages, trigger],
          onContextUsage: assembled.onContextUsage,
          capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
          modelProfileId: 'music_selection',
          profileOverrides: { maxRounds: rounds, emptyRetry: false },
          correlationId: context?.correlationId || requestId || '',
          sessionId: taskSessionId,
          toolNames: [...TASK_TOOLS],
          toolContext: {
            sessionId: taskSessionId,
            requestId,
            roundId: context?.roundId || null,
            virtualPersonId: personId,
            groupAction: context?.groupAction || null,
            reason: taskReason,
            outputGeneration: musicTaskRequest.outputGeneration,
            isCurrent: guard,
            preparedFor: musicTaskRequest.preparedFor,
            musicTaskRequest,
            ...(preparation ? {} : { linePass: collector }),
          },
          // 这些消息只留给接下来的 line pass，不进账本；放在回调里收是因为模型调用抛错也不能丢已提交的结果。
          onMessage: event => {
            if (event?.kind === 'assistant_tool_calls') {
              tail.push(event.message);
              for (const call of event.message?.tool_calls || []) {
                toolNames.set(String(call?.id || ''), String(call?.function?.name || ''));
              }
            } else if (event?.kind === 'tool_result') {
              tail.push(event.message);
              const toolCallId = String(event.message?.tool_call_id || '');
              const name = toolNames.get(toolCallId) || null;
              results.push({ name, outcome: event.outcome, toolCallId });
              recordTrace(toolResultTraceEvent(name, event.outcome, toolCallId));
            }
          },
          signal: taskSignal,
        });
      };
      try {
        if (typeof trace?.enter === 'function' && taskSessionId) await trace.enter({ sessionId: taskSessionId, ...identity }, taskRun);
        else await taskRun();
      } catch (error) {
        // 工具结果优先于循环异常：已接受的提交不因为后续回合失败而丢失。
        loopError = error;
      }
      const passMessages = () => [trigger, ...tail];
      const finalize = result => {
        // 音乐已经落定：写串词另起一轮，不让调用方（和开播）等它。
        if (result.ok === true && collector.targets.length && assembled) {
          void host.startLinePass?.({ entity, sessionId: taskSessionId, requestId, targets: collector.targets,
            assembled, extraMessages: passMessages() });
        } else if (collector.targets.length) {
          for (const target of collector.targets) { try { target.fail('selection-failed'); } catch { /* 安静播放 */ } }
        }
        if (result.ok === true && preparation && assembled) {
          preparedRuns.set(result, { assembled, entity, sessionId: taskSessionId, requestId, messages: passMessages() });
        }
        activity?.leave();
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
        const failureReason = outcomeReason(failedCommit.outcome);
        const failure = { ok: false, code: bounded(failedCommit.outcome?.code || 'MUSIC_NOT_COMMITTED', 80),
          message: failureReason || bounded(failedCommit.outcome?.presentation?.displayText, 300) || '这次没有完成选歌提交。' };
        if (failureReason) failure.reason = failureReason;
        if (loopError) failure.loopErrorCode = bounded(loopError.code || 'MUSIC_SELECTION_FAILED', 80);
        return finalize(failure);
      }
      if (loopError) {
        return finalize({ ok: false, code: bounded(loopError.code || 'MUSIC_SELECTION_FAILED', 80),
          message: bounded(loopError.message || '这次选歌没有完成。') });
      }
      if (offer) {
        return finalize({ ok: false, code: bounded(offer.outcome?.code || 'MUSIC_NOT_COMMITTED', 80),
          offerId: offer.outcome?.facts?.offerId || null,
          message: bounded(offer.outcome?.presentation?.displayText || '这次没有做到提交，队列没有变化。') });
      }
      return finalize({ ok: false, code: 'MUSIC_NOT_COMMITTED', message: '这次没有做到提交，队列没有变化。' });
    },

    /** 预热批次存好之后，接着那一轮的上下文写串词。targets 由音乐服务按批次给出。 */
    writePreparedLines(result, targets = []) {
      const run = preparedRuns.get(result);
      if (!run || !targets.length) return null;
      preparedRuns.delete(result);
      return host.startLinePass?.({ entity: run.entity, sessionId: run.sessionId, requestId: run.requestId, targets,
        assembled: run.assembled, extraMessages: run.messages }) || null;
    },
  });
}
