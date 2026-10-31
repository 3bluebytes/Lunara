// PresenceUtterance.js — presence_utterance 受限任务运行器（与 NarrationAgent 同构）。
//
// 调用顺序：PresenceRuntime 给出冻结任务 → 本运行器调用主 AgentLoop：messages 为空、
// 工具白名单只有 get_presence_brief / submit_presence_utterance、素材内联进系统提示、
// allowEmptyTerminalPresentation（沉默是正常终止）。工具结果经 onMessage 捕获。
// 输出永远是 { action: 'speak', text, evidenceRefs } 或 { action: 'silence', reason }：
// 模型超时、报错、被拒到预算耗尽或主动沉默都只是沉默，不写兜底句。这里不写账本、不交付。
import { resolveTaskSpec } from '../llmTasks.js';
import { buildPresenceBrief } from './presenceLine.js';
import {
  PRESENCE_CAPABILITY, PRESENCE_SUBMIT_TOOL_NAME, PRESENCE_TASK_TOOLS, registerPresenceTools,
} from './presenceTools.js';

const clean = value => String(value ?? '').trim();
export const PRESENCE_MAX_ROUNDS = 2;

export const PRESENCE_TASK_PROMPT = `你正在和对方一起听歌。这一刻没有人在对你说话，你可以自然地说一句，也可以不说。
- 本提示词末尾附上的，就是你此刻真正知道的事：这首为什么在放（你们那次怎么聊的、你当时怎么回的）、你们刚才在聊什么、这首歌在你们之间的来历。yourWay 是你自己的在场方式。
- 有想说的，就像你平时那样随口说一句：接刚才的话题、说说你挑这首的心思，都可以；没有就安静陪着，沉默完全正常。
- 只依据这些事实。你不知道的（对方此刻在做什么、心情怎样），不要假装知道，也不要为了有话说给自己编一个反应。
- 不要回复聊天模板、不要客服式关心、不要提技术机制、不要说已经播放或已经切歌。
- 素材与 get_presence_brief 的返回逐字一致，不必先调用读取工具；直接调用 submit_presence_utterance：speak 带一句话和它依据的 evidenceRefs，或者 silence。`;

export function createPresenceUtterance({ agentLoop, toolRegistry, sessionTrace = null,
  timeoutMs = resolveTaskSpec('presence_utterance').timeoutMs, maxRounds = PRESENCE_MAX_ROUNDS } = {}) {
  if (!agentLoop || typeof agentLoop.run !== 'function') throw new TypeError('createPresenceUtterance requires agentLoop.run()');
  registerPresenceTools(toolRegistry);

  return Object.freeze({
    /**
     * @param task 由 buildPresenceTask 冻结的任务
     * @param options {{ persona?: { displayName, personaDocument }, signal?: AbortSignal, isCurrent?: Function }}
     */
    async generate(task, { persona = null, signal = null, isCurrent = null } = {}) {
      if (signal?.aborted) return { action: 'silence', reason: 'aborted' };
      const correlationId = `presence:${task.triggerKey}`;
      const systemPrompt = [
        `你是 ${clean(persona?.displayName) || task.personName || 'Lunara'}。`,
        clean(persona?.personaDocument),
        PRESENCE_TASK_PROMPT,
        `这一刻的素材（JSON）：${JSON.stringify(buildPresenceBrief(task))}`,
      ].filter(Boolean).join('\n');
      const results = [];
      const toolNames = new Map();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort(signal?.reason);
      signal?.addEventListener?.('abort', forwardAbort, { once: true });
      let timer = null;
      let timedOut = false;
      let failed = null;
      const guard = typeof isCurrent === 'function' ? isCurrent : () => !controller.signal.aborted;
      try {
        const runTask = () => agentLoop.run({
          systemPrompt,
          messages: [],
          capabilities: [PRESENCE_CAPABILITY],
          modelProfileId: 'presence',
          profileOverrides: { maxRounds, emptyRetry: false, timeoutMs, deadlineMs: Date.now() + timeoutMs,
            allowEmptyTerminalPresentation: true },
          correlationId,
          sessionId: task.sessionId,
          toolNames: [...PRESENCE_TASK_TOOLS],
          toolContext: { sessionId: task.sessionId, requestId: correlationId, roundId: correlationId,
            isCurrent: guard, presenceTaskRequest: task },
          onMessage: event => {
            if (event?.kind === 'assistant_tool_calls') {
              for (const call of event.message?.tool_calls || []) toolNames.set(String(call?.id || ''), String(call?.function?.name || ''));
            } else if (event?.kind === 'tool_result') {
              results.push({ name: toolNames.get(String(event.message?.tool_call_id || '')) || null, outcome: event.outcome });
            }
          },
          signal: controller.signal,
        });
        const run = typeof sessionTrace?.enter === 'function'
          ? () => sessionTrace.enter({ sessionId: task.sessionId, requestId: correlationId, roundId: correlationId }, runTask)
          : runTask;
        await Promise.race([
          run().catch(error => { failed = error; }),
          new Promise(resolve => {
            timer = setTimeout(() => { timedOut = true; controller.abort(new Error('presence budget expired')); resolve(); }, timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', forwardAbort);
      }
      if (signal?.aborted) return { action: 'silence', reason: 'aborted' };
      const submissions = results.filter(entry => entry.name === PRESENCE_SUBMIT_TOOL_NAME);
      const accepted = [...submissions].reverse().find(entry => entry.outcome?.ok === true && entry.outcome?.terminal);
      if (accepted?.outcome?.facts?.action === 'speak' && clean(accepted.outcome.facts.text)) {
        return { action: 'speak', text: clean(accepted.outcome.facts.text), evidenceRefs: accepted.outcome.facts.evidenceRefs };
      }
      if (accepted) return { action: 'silence', reason: 'model-silence' };
      if (timedOut || failed?.code === 'AGENT_TIMEOUT') return { action: 'silence', reason: 'timeout' };
      const rejected = [...submissions].reverse().find(entry => entry.outcome?.ok !== true);
      if (rejected) return { action: 'silence', reason: 'rejected', rejectedRule: rejected.outcome?.facts?.rejectedRule || null };
      return { action: 'silence', reason: failed ? 'error' : 'no-submission' };
    },
  });
}

export default createPresenceUtterance;
