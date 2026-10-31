// presenceTools.js — presence_utterance 受限任务的两个 typed 工具。
//
// 合同：
// - get_presence_brief（只读、非终端）：返回锁定任务的证据清单、写作要求与校验规则。
// - submit_presence_utterance（终端）：action=silence 直接接受为沉默（空呈现）；
//   action=speak 按 presenceLineDefect 机械校验，通过才登记 facts.text/evidenceRefs。
//   拒绝是可纠正的 typed 失败。工具不调模型、不写账本、不写播放状态，接受也不代表已经出声。
import { createToolOutcome, ToolOutcomeKind } from '../virtual-person/VirtualPersonTypes.js';
import { buildPresenceBrief, presenceLineDefect, presenceRuleFeedback } from './presenceLine.js';

export const PRESENCE_CAPABILITY = 'presence';
export const PRESENCE_BRIEF_TOOL_NAME = 'get_presence_brief';
export const PRESENCE_SUBMIT_TOOL_NAME = 'submit_presence_utterance';
export const PRESENCE_TASK_TOOLS = Object.freeze([PRESENCE_BRIEF_TOOL_NAME, PRESENCE_SUBMIT_TOOL_NAME]);

const failure = (code, modelContext, context, { retryable = false, facts = {} } = {}) => createToolOutcome({
  kind: ToolOutcomeKind.BUSINESS_FAILURE, code, facts, modelContext,
  presentation: { displayText: '', speak: false, retryable },
  internal: { correlationId: context?.correlationId },
});

export function registerPresenceTools(registry) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('registerPresenceTools requires a tool registry');
  const registered = new Set(typeof registry.definitions === 'function'
    ? registry.definitions({ capabilities: [PRESENCE_CAPABILITY] }).map(definition => String(definition?.function?.name || ''))
    : []);
  if (!registered.has(PRESENCE_BRIEF_TOOL_NAME)) {
    registry.register(PRESENCE_BRIEF_TOOL_NAME, {
      capability: PRESENCE_CAPABILITY,
      readOnly: true,
      definition: {
        description: '读取这一刻可以依据的事实（带 ref）、你最近说过的话、写作要求与校验规则。任务提示词末尾已附同样内容；只在需要重读时调用。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      handler: (args, context = {}) => {
        const task = context.presenceTaskRequest;
        if (!task) return failure('PRESENCE_TASK_UNAVAILABLE', '这次没有可用的素材，本任务到此结束。', context);
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS, code: 'PRESENCE_BRIEF', facts: buildPresenceBrief(task),
          modelContext: '以上是这一刻的全部素材。想开口就用 submit_presence_utterance 提交一句话，不想说就提交 silence。',
          presentation: { displayText: '', speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
  }
  if (!registered.has(PRESENCE_SUBMIT_TOOL_NAME)) {
    registry.register(PRESENCE_SUBMIT_TOOL_NAME, {
      capability: PRESENCE_CAPABILITY,
      definition: {
        description: '提交这一刻的结果：action=speak 时给出一句话 text 和它依据的 evidenceRefs；action=silence 表示这次安静陪着、不开口。提交会被机械校验，被拒绝时按提示修改或改为 silence；接受即结束本任务，不代表已经出声。',
        parameters: {
          type: 'object', additionalProperties: false, required: ['action'],
          properties: {
            action: { type: 'string', enum: ['speak', 'silence'] },
            text: { type: 'string', maxLength: 120, description: '一句话，直接可以念出来的纯文本。' },
            evidenceRefs: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 40 } },
          },
        },
      },
      handler: (args, context = {}) => {
        const task = context.presenceTaskRequest;
        if (!task) return failure('PRESENCE_TASK_UNAVAILABLE', '这次没有可用的素材，本任务到此结束。', context);
        if (context.signal?.aborted || (typeof context.isCurrent === 'function' && !context.isCurrent())) {
          return failure('STALE_PRESENCE_TASK', '这一刻已经过去了（对方开口或聊天已切换），不要再提交。', context);
        }
        if (context.finishReason != null && context.finishReason !== 'tool_calls') {
          return failure('PRESENCE_TRUNCATED', '上一次响应没有完整结束，请重新提交。', context, { retryable: true });
        }
        if (args.action === 'silence') {
          return createToolOutcome({
            kind: ToolOutcomeKind.SUCCESS, code: 'PRESENCE_SILENCE', terminal: true,
            facts: { action: 'silence' }, modelContext: '已记为安静陪着，本任务结束。',
            presentation: { displayText: '', speak: false },
            internal: { correlationId: context.correlationId },
          });
        }
        if (args.action !== 'speak') {
          return failure('PRESENCE_INVALID_ACTION', 'action 只能是 speak 或 silence。', context, { retryable: true });
        }
        const text = String(args.text || '').trim();
        const evidenceRefs = Array.isArray(args.evidenceRefs) ? args.evidenceRefs.map(ref => String(ref).trim()).filter(Boolean) : [];
        const rule = presenceLineDefect(text, evidenceRefs, task);
        if (rule) {
          return failure('PRESENCE_LINE_REJECTED', `${presenceRuleFeedback(rule)}\n修改后重新提交一次，或者提交 action=silence。`,
            context, { retryable: true, facts: { rejectedRule: rule } });
        }
        return createToolOutcome({
          kind: ToolOutcomeKind.SUCCESS, code: 'PRESENCE_LINE_ACCEPTED', terminal: true,
          facts: { action: 'speak', text, evidenceRefs: [...new Set(evidenceRefs)] },
          modelContext: '这句话已通过校验并被接受，本任务结束；不要再提交，也不要声称已经出声。',
          // 呈现文本留空：由 presence 运行器在入账成功后自己交付，AgentLoop 不产出可见回复。
          presentation: { displayText: '', speak: false },
          internal: { correlationId: context.correlationId },
        });
      },
    });
  }
  return registry;
}

export default registerPresenceTools;
