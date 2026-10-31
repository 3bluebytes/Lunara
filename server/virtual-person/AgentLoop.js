import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';
import { IntentRouter } from './IntentRouter.js';
import { acceptCommittedLine } from './committedLine.js';

function normalizeAssistantMessage(message) {
  if (!message || typeof message !== 'object') {
    throw new AgentLoopError('LLM_INVALID_RESPONSE', 'model returned no assistant message');
  }
  return {
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : '',
    ...(Array.isArray(message.tool_calls) && message.tool_calls.length
      ? { tool_calls: structuredClone(message.tool_calls) }
      : {}),
  };
}

function toolResultForModel(outcome) {
  return JSON.stringify({
    ok: outcome.ok,
    kind: outcome.kind,
    code: outcome.code,
    facts: outcome.facts,
    context: outcome.modelContext,
  });
}

function parseArguments(call) {
  const raw = call?.function?.arguments;
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  return JSON.parse(String(raw));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function toolExecutionKey(name, args) {
  return `${String(name || '')}:${JSON.stringify(stableValue(args))}`;
}

function isPromptTooLong(error) {
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return error?.status === 413
    || code.includes('context_length')
    || code.includes('prompt_too_long')
    || /context.{0,20}(length|window)|prompt.{0,20}(long|large)|too many tokens/.test(message);
}

class AgentLoopError extends Error {
  constructor(code, message, outcomes = [], details = {}) {
    super(message);
    this.name = 'AgentLoopError';
    this.code = code;
    this.agentOutcomes = [...outcomes];
    this.finishReason = details.finishReason || null;
  }
}

function attachOutcomes(error, outcomes) {
  if (error && typeof error === 'object') error.agentOutcomes = [...outcomes];
  return error;
}

/** abort 事件只携带 signal.reason；非 Error 原因（极少见）统一降级为取消错误。 */
function abortReason(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('turn cancelled');
}

// 受限任务（选歌/串词等）以空历史启动时，模型请求至少要有 system + user 两条消息：
// 有的网关（GLM）会直接 400 拒绝 system-only。这条中性指令只进请求，不进对话账本，
// 也不冒充用户原话。
const RESTRICTED_TASK_USER_INSTRUCTION = '按系统说明执行本轮任务。';

/** 历史里没有任何非 system 消息时补一条中性 user 指令；已有聊天历史时原样返回。 */
function withMinimumUserTurn(history) {
  const messages = Array.isArray(history) ? history : [];
  return messages.some(message => message?.role && message.role !== 'system')
    ? messages
    : [...messages, { role: 'user', content: RESTRICTED_TASK_USER_INSTRUCTION }];
}

/**
 * 回合级截止/取消都在 turn 信号上：这里不再自建定时器，
 * 只把 run 的结束与信号 abort 竞速，保证忽略 signal 的实现也不会挂死。
 */
async function withinTurn(run, signal) {
  signal?.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

// 取消/超时后等待进行中的工具落定的上限：只用于识别“已经提交”的终止性结果，不延长回合。
// 同批只读调用的并发上限：搜索会打到外部音乐源，不能一次放出整批请求。
const MAX_PARALLEL_READ_ONLY_CALLS = 4;
const TERMINAL_SETTLE_GRACE_MS = 1500;

/** 在上限内等待 promise 落定；超时或失败返回 null。 */
async function settleWithin(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); timer.unref?.(); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class AgentLoop {
  constructor({
    chat,
    toolRegistry,
    contextBudgeter = null,
    intentRouter = new IntentRouter(),
    maxRounds = 6,
    timeoutMs = 30_000,
    modelProfiles = {},
  } = {}) {
    if (typeof chat !== 'function') throw new TypeError('AgentLoop requires chat()');
    if (!toolRegistry) throw new TypeError('AgentLoop requires toolRegistry');
    this.chat = chat;
    this.toolRegistry = toolRegistry;
    this.contextBudgeter = contextBudgeter;
    this.intentRouter = intentRouter;
    this.maxRounds = Math.max(1, Number(maxRounds) || 6);
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 30_000);
    this.modelProfiles = {
      // 数字不在这里：额度、思考倾向与超时都引用任务预算规格（server/llmTasks.js，
      // design §2）。profile 只保留采样温度与循环控制键。
      dialogue: { temperature: 0.8, taskId: 'chat_dialogue' },
      // 反思输出的是机械 JSON（观察/证据/claim），不靠思维链：请求关闭思考是**成本选择**，
      // 由传输层按档案决定是否真的发送「关闭」参数；额度仍由 reflection 规格保底。
      reflection: { temperature: 0.2, taskId: 'reflection', thinkingMode: 'disabled' },
      music_selection: { temperature: 0.7, taskId: 'music_selection' },
      narration: { temperature: 0.8, taskId: 'narration' },
      presence: { temperature: 0.9, taskId: 'presence_utterance' },
      // 心跳叫醒的一轮：traceContent=false 让模型观测只留数值与分类，运行时提示与草稿不进 trace。
      ambient: { temperature: 0.9, taskId: 'ambient_turn', traceContent: false },
      ...modelProfiles,
    };
  }

  async run({
    systemPrompt,
    messages = [],
    capabilities = null,
    modelProfileId = 'dialogue',
    correlationId = '',
    sessionId = null,
    toolContext = null,
    onMessage = null,
    signal = null,
    profileOverrides = null,
    toolNames = null,
    stream = false,
    streamRequired = false,
    onTextDelta = null,
    onStreamReset = null,
  } = {}) {
    let history = structuredClone(messages);
    // toolNames 是本次任务的工具白名单：模型看不到清单外的工具；即使凭历史记忆点名，
    // 也只得到 typed 失败结果，绝不执行未授权工具。
    const allowlist = Array.isArray(toolNames) ? new Set(toolNames.map(String)) : null;
    const definitions = this.toolRegistry.definitions({ capabilities })
      .filter(definition => !allowlist || allowlist.has(String(definition?.function?.name || '')));
    const baseProfile = this.modelProfiles[modelProfileId] || this.modelProfiles.dialogue;
    // 受限 profile（如选歌预热、串词任务）可以收紧回合数、重试与终止表现要求。
    const profile = { ...baseProfile, ...profileOverrides,
      ...(stream ? { stream: true } : {}), ...(streamRequired ? { streamRequired: true } : {}) };
    const visibleStream = profile.streamRequired === true;
    const maxRounds = Math.max(1, Number(profile.maxRounds) || this.maxRounds);
    const routedSystemPrompt = this.intentRouter.extendSystemPrompt(systemPrompt, { capabilities });
    // 所有模型调用（首轮、prompt-too-long 恢复、空回复重试）共用同一份补过消息的数组：
    // 空历史补最少 user 指令，已有聊天历史不改写；都不写入 history / 对话账本。
    const requestMessages = preparedHistory => [
      { role: 'system', content: routedSystemPrompt },
      ...withMinimumUserTurn(preparedHistory),
    ];
    const profileTimeoutMs = Number(profile.timeoutMs);
    const turnBudgetMs = Number.isFinite(profileTimeoutMs) && profileTimeoutMs > 0
      ? Math.min(this.timeoutMs, profileTimeoutMs) : this.timeoutMs;
    const suppliedDeadline = Number(profile.deadlineMs);
    const deadline = Math.min(Date.now() + turnBudgetMs,
      profile.deadlineMs != null && Number.isFinite(suppliedDeadline) ? suppliedDeadline : Infinity);
    const outcomes = [];
    const executionCache = new Map();
    // IntentRouter 在这次运行的各轮之间累计的记录（如连续选歌落空的次数）。
    const intentRun = {};
    let emptyRetryUsed = false;
    // plainTextCorrection（如 ambient 档案）：该走终止工具却回了纯文本时，追加一次纠正再给一轮；只纠正一次。
    let plainTextCorrected = false;
    let lastFinishReason = null;

    // 参数归一：必须先于 executionKey、只读预启动与执行。
    // registry 可能没有 prepareArguments（测试替身/旧实现），此时保持原行为。
    const prepareArguments = (name, args) => {
      const prepare = this.toolRegistry.prepareArguments;
      return typeof prepare === 'function' ? prepare.call(this.toolRegistry, name, args) : args;
    };
    const invalidArgumentsOutcome = () => createToolOutcome({
      kind: ToolOutcomeKind.BUSINESS_FAILURE,
      code: 'INVALID_TOOL_ARGUMENTS',
      modelContext: '工具参数无法归一，请按工具 schema 只传声明的字段；不要额外套 params/arguments 包装。',
      presentation: { displayText: '我没能正确理解这项操作。', speak: false, retryable: true },
      internal: { correlationId },
    });

    // 回合级取消信号：外层取消原样转发；截止时刻由定时器以 AGENT_TIMEOUT 中止。
    // chat() 与工具执行都拿这个信号，超时/取消能真正打断进行中的工作。
    const turnController = new AbortController();
    const turnSignal = turnController.signal;
    let draftActive = true;
    const currentDraft = () => draftActive && !turnSignal.aborted && toolContext?.isCurrent?.() !== false;
    const delta = onTextDelta || profile.onTextDelta;
    const reset = onStreamReset || profile.onStreamReset;
    const callProfile = { ...profile,
      onTextDelta: visibleStream && typeof delta === 'function'
        ? event => { if (currentDraft()) delta(event); } : undefined,
      onStreamReset: visibleStream && typeof reset === 'function'
        ? event => { if (currentDraft()) reset(event); } : undefined,
    };
    const throwIfTurnCancelled = () => {
      if (turnSignal.aborted) throw abortReason(turnSignal);
    };
    const forwardOuterAbort = () => turnController.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) forwardOuterAbort();
      else signal.addEventListener('abort', forwardOuterAbort, { once: true });
    }
    const turnTimer = setTimeout(
      () => turnController.abort(new AgentLoopError('AGENT_TIMEOUT', 'virtual person turn timed out', outcomes)),
      Math.max(1, deadline - Date.now()),
    );

    try {
      for (let round = 1; round <= maxRounds; round++) {
        throwIfTurnCancelled();
        if (Date.now() >= deadline) throw new AgentLoopError('AGENT_TIMEOUT', 'virtual person turn timed out', outcomes);
        const prepared = this.contextBudgeter ? await this.contextBudgeter.prepare(history) : history;
        let activePrepared = prepared;
        let response;
        try {
          response = await withinTurn(() => this.chat(
            requestMessages(prepared),
            definitions.length ? definitions : null,
            { ...callProfile, timeoutMs: Math.max(1, deadline - Date.now()), signal: turnSignal, sessionId },
          ), turnSignal);
        } catch (error) {
          if (profile.contextRecovery === false || !this.contextBudgeter || !isPromptTooLong(error)) throw error;
          const recovered = await this.contextBudgeter.prepare(history, { aggressive: true });
          activePrepared = recovered;
          response = await withinTurn(() => this.chat(
            requestMessages(recovered),
            definitions.length ? definitions : null,
            { ...callProfile, timeoutMs: Math.max(1, deadline - Date.now()), signal: turnSignal, sessionId },
          ), turnSignal);
        }
        let assistant = normalizeAssistantMessage(response?.message);
        lastFinishReason = response?.finishReason || null;
        throwIfTurnCancelled();
        if (!assistant.content.trim() && !assistant.tool_calls?.length && !emptyRetryUsed && profile.emptyRetry !== false) {
          // A truly empty response has produced no tool side effects. Retry once
          // inside the same deadline, without adding a ghost assistant turn.
          // 不再以「关闭思考」作为默认重试动作（design §3）：那会把有帮助的思考也关掉，
          // 失败分类与升级重试由传输层负责。
          emptyRetryUsed = true;
          response = await withinTurn(() => this.chat(
            requestMessages(activePrepared),
            definitions.length ? definitions : null,
            { ...callProfile, timeoutMs: Math.max(1, deadline - Date.now()), signal: turnSignal, sessionId },
          ), turnSignal);
          assistant = normalizeAssistantMessage(response?.message);
          lastFinishReason = response?.finishReason || null;
          throwIfTurnCancelled();
        }
        const toolCalls = assistant.tool_calls || [];
        if (!toolCalls.length) {
          const finalText = assistant.content.trim();
          if (!finalText) throw new AgentLoopError('EMPTY_ASSISTANT_RESPONSE', 'model returned empty assistant text', outcomes,
            { finishReason: ['length', 'stop', 'tool_calls', 'content_filter'].includes(response?.finishReason)
              ? response.finishReason : 'unknown' });
          const correction = typeof profile.plainTextCorrection === 'string' ? profile.plainTextCorrection.trim() : '';
          if (correction && !plainTextCorrected && round < maxRounds) {
            // 纯文本与纠正只活在这次 run 的 history 里；调用方决定是否入账，这里不写任何账本。
            plainTextCorrected = true;
            history.push({ role: 'assistant', content: finalText }, { role: 'user', content: correction });
            await onMessage?.({ kind: 'plain_text_correction', text: finalText, round });
            continue;
          }
          return { finalText, rounds: round, messages: history, outcomes, finishReason: lastFinishReason };
        }

        history.push(assistant);
        await onMessage?.({ kind: 'assistant_tool_calls', message: assistant, round });
        let terminalOutcome = null;
        // 同批重复调用只执行一次；跨轮复用由 executionCache 按只读/成败另行判断。
        const batchCache = new Map();
        const intentPlan = this.intentRouter.plan(toolCalls, intentRun);
        const startExecution = (name, args) => Promise.resolve().then(() => this.toolRegistry.execute(name, args, {
          correlationId,
          round,
          toolCallCount: toolCalls.length,
          capabilities,
          // 整响应的停止原因对工具可见：截断(len) 时不能当完整交付。
          finishReason: lastFinishReason,
          ...(toolContext && typeof toolContext === 'object' ? toolContext : {}),
          // 回合信号放在透传之后：超时/取消必须能真正打断工具内的工作。
          signal: turnSignal,
        }));
        // 连续的只读调用一起启动、按原顺序消费结果；副作用调用仍逐个执行，不与任何调用重叠。
        const prestarted = new Map();
        const readOnlyKey = call => {
          const name = String(call?.function?.name || '');
          if (!this.toolRegistry.isReadOnly?.(name) || intentPlan.blockedOutcome(call)) return null;
          if (allowlist && !allowlist.has(name)) return null;
          let args;
          try {
            // 只读预启动与主循环共用同一份归一参数：否则包装调用会拿到不同的执行键。
            args = prepareArguments(name, parseArguments(call));
          } catch { return null; }
          return { name, args, key: toolExecutionKey(name, args) };
        };
        const prestartReadOnlyRun = startIndex => {
          let started = 0;
          for (let index = startIndex; index < intentPlan.calls.length && started < MAX_PARALLEL_READ_ONLY_CALLS; index++) {
            const entry = readOnlyKey(intentPlan.calls[index]);
            if (!entry) break;
            if (batchCache.has(entry.key) || prestarted.has(entry.key)) continue;
            started++;
            const execution = startExecution(entry.name, entry.args);
            // 结果稍后按顺序 await；这里先挂上处理器，避免先完成的失败成为未处理拒绝。
            execution.catch(() => {});
            prestarted.set(entry.key, execution);
          }
        };
        for (const [callIndex, call] of intentPlan.calls.entries()) {
          // 已接受的 terminal mutation 之后：不再因取消改写结果，也不再执行同批剩余调用。
          if (!terminalOutcome) throwIfTurnCancelled();
          const name = String(call?.function?.name || '');
          let outcome = null;
          const blocked = intentPlan.blockedOutcome(call);
          if (terminalOutcome) {
            outcome = createToolOutcome({
              kind: ToolOutcomeKind.BUSINESS_FAILURE,
              code: 'SKIPPED_AFTER_TERMINAL',
              modelContext: '本轮已有终止性动作被接受，这个调用没有执行。',
              presentation: { displayText: '', speak: false, retryable: false },
              internal: { correlationId },
            });
          } else if (blocked) {
            outcome = blocked;
          } else if (allowlist && !allowlist.has(name)) {
            // 白名单外工具不执行：给模型可纠正的 typed 结果，循环继续。
            outcome = createToolOutcome({
              kind: ToolOutcomeKind.BUSINESS_FAILURE,
              code: 'TOOL_NOT_AVAILABLE',
              modelContext: `工具 ${name || '(未知)'} 不在本任务可用范围内，不能调用；请改用当前可用工具，或直接用自然语言回答。`,
              presentation: { displayText: '这项能力在当前任务里不可用。', speak: false, retryable: false },
              internal: { correlationId },
            });
          } else {
            let args = null;
            try {
              args = parseArguments(call);
            } catch {
              // 只有参数 JSON 解析失败才归类为 INVALID_TOOL_ARGUMENTS。
              outcome = createToolOutcome({
                kind: ToolOutcomeKind.BUSINESS_FAILURE,
                code: 'INVALID_TOOL_ARGUMENTS',
                modelContext: '工具参数不是合法 JSON，请修正参数或直接自然回答。',
                presentation: { displayText: '我没能正确理解这项操作。', speak: false, retryable: true },
                internal: { correlationId },
              });
            }
            if (!outcome) {
              try {
                // 归一失败 fail closed：typed INVALID_TOOL_ARGUMENTS，无副作用，循环可纠正。
                args = prepareArguments(name, args);
              } catch {
                outcome = invalidArgumentsOutcome();
              }
            }
            if (!outcome) {
              const executionKey = toolExecutionKey(name, args);
              if (batchCache.has(executionKey)) {
                outcome = batchCache.get(executionKey);
              } else if (executionCache.has(executionKey)) {
                outcome = executionCache.get(executionKey);
              } else {
                if (!prestarted.has(executionKey) && this.toolRegistry.isReadOnly?.(name)) prestartReadOnlyRun(callIndex);
                const execution = prestarted.get(executionKey) || startExecution(name, args);
                try {
                  outcome = await withinTurn(() => execution, turnSignal);
                } catch (error) {
                  // 其余执行异常不伪装成参数错误，原样上抛。
                  if (!turnSignal.aborted) throw error;
                  // 取消可能落在工具已经提交之后：给进行中的调用一个有界窗口落定；
                  // 已被接受的终止性结果如实保留，否则保留超时/取消的原始分类。
                  const settled = await settleWithin(execution, TERMINAL_SETTLE_GRACE_MS);
                  if (!(settled?.ok && settled.terminal)) throw abortReason(turnSignal);
                  outcome = settled;
                }
                batchCache.set(executionKey, outcome);
                // 跨轮只复用成功的副作用结果（防止重复写入）；只读查询与失败在后续轮次重新执行。
                if (outcome.ok && !this.toolRegistry.isReadOnly?.(name)) executionCache.set(executionKey, outcome);
              }
            }
          }
          outcomes.push(outcome);
          intentPlan.observe(call, outcome);
          if (!terminalOutcome && outcome.ok && outcome.terminal) terminalOutcome = outcome;
          const toolMessage = {
            role: 'tool',
            tool_call_id: String(call.id || ''),
            content: toolResultForModel(outcome),
          };
          history.push(toolMessage);
          await onMessage?.({ kind: 'tool_result', message: toolMessage, outcome, round });
        }
        if (terminalOutcome) {
          // 提交后不再调模型：可见回复是模型在同一条消息里写好且通过校验的话，否则是复核过的固定文案。
          const finalText = acceptCommittedLine(assistant.content, terminalOutcome.presentation?.modelLine)
            || terminalOutcome.presentation?.displayText?.trim();
          if (!finalText && profile.allowEmptyTerminalPresentation !== true) {
            throw new AgentLoopError('EMPTY_TOOL_PRESENTATION', 'terminal tool returned empty presentation', outcomes, { finishReason: lastFinishReason });
          }
          return { finalText: finalText || '', rounds: round, messages: history, outcomes, finishReason: lastFinishReason };
        }
        // 「没进展就停」由 IntentRouter 判断：它知道哪些工具与结果码属于音乐动作。
        const noProgressOutcome = intentPlan.noProgressOutcome?.() || null;
        if (noProgressOutcome) {
          const finalText = noProgressOutcome.presentation?.displayText?.trim();
          if (!finalText) throw new AgentLoopError('EMPTY_TOOL_PRESENTATION', 'no-match tool returned empty presentation', outcomes);
          return { finalText, rounds: round, messages: history, outcomes, finishReason: lastFinishReason };
        }
      }
      throw new AgentLoopError('AGENT_ROUND_LIMIT', 'virtual person turn reached round limit', outcomes, { finishReason: lastFinishReason });
    } catch (error) {
      // 所有出口异常都带上已发生的 tool outcomes；超时/取消原因保持原样。
      throw attachOutcomes(error, outcomes);
    } finally {
      draftActive = false;
      clearTimeout(turnTimer);
      if (signal) signal.removeEventListener('abort', forwardOuterAbort);
    }
  }
}
