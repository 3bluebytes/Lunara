// llmMessages.js — 传输层的消息形状：一份可移植的规范形状 + 各协议译后校验。
//
// 调用顺序（llm.js 的 chat() 与 rawChatAttempt() 都走这里）：
//   规范消息（OpenAI chat 风格：system / user / assistant(+tool_calls) / tool）
//     → conformMessages()          统一修成「最严格公共形状」，与具体供应商无关
//     → ADAPTERS[api].build()      各协议只做翻译
//     → validateRequestBody()      检查翻译结果满足该协议的硬约束，不合格在发请求前 fail closed
//
// 为什么用「最严格公共形状」而不是按供应商打补丁：同一协议下供应商规则并不一致
// （例如 Zhipu GLM 走 openai-completions，却拒绝只有 system 的请求：1214「messages 参数非法」；
// Anthropic 要求 messages 非空且以 user 开头；Gemini 要求 contents 非空）。把所有协议都能接受的
// 交集作为唯一形状，新增供应商、协议或流式适配器时不需要再为消息形状单独适配。
//
// Python 伪代码：
//   def conform(messages):
//       system = merge(m for m in messages if m.role == 'system')
//       rest = [m for m in messages if m.role != 'system']
//       check_tool_pairs(rest)                       # 每个 tool 结果都回应一个未回应的 call，反之亦然
//       if not rest or rest[0].role != 'user':
//           rest.insert(0, user(TASK_INPUT_MARKER))  # 中性任务标记，不是伪造的用户话术
//       return ([system] if system else []) + rest

/** 首条非 system 消息不是 user 时补的中性任务标记：只出现在发出的请求里，不进历史或账本。 */
export const TASK_INPUT_MARKER = '（系统任务输入：请按上面的系统说明执行。）';

export class LlmMessageShapeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'LlmMessageShapeError';
    this.code = 'LLM_MESSAGE_SHAPE_INVALID';
    this.detail = detail;
  }
}

const textOf = content => (typeof content === 'string' ? content : content == null ? '' : JSON.stringify(content));

/**
 * 规范消息 → 可移植形状。不修改入参。
 * 不合法且无法无损修正的（孤立的 tool 结果、没有回应的 tool call、未知角色）直接抛
 * LlmMessageShapeError：宁可在本地给出可诊断的失败，也不把坏请求发给供应商换一个含糊的 400。
 */
export function conformMessages(messages) {
  if (!Array.isArray(messages)) throw new LlmMessageShapeError('messages must be an array');
  const systemParts = [];
  const rest = [];
  for (const [index, message] of messages.entries()) {
    const role = message?.role;
    if (role === 'system') {
      const text = textOf(message.content).trim();
      if (text) systemParts.push(text);
      continue;
    }
    if (!['user', 'assistant', 'tool'].includes(role)) {
      throw new LlmMessageShapeError(`unsupported message role at ${index}`, { index, role: role ?? null });
    }
    rest.push(message);
  }

  let pending = null; // 最近一条带 tool_calls 的 assistant 尚未回应的 call id
  for (const [index, message] of rest.entries()) {
    if (message.role === 'tool') {
      const id = String(message.tool_call_id || '');
      if (!pending?.has(id)) throw new LlmMessageShapeError('tool result without a matching pending tool call', { index });
      pending.delete(id);
      continue;
    }
    if (pending?.size) throw new LlmMessageShapeError('tool calls left unanswered before the next message', { index });
    pending = message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length
      ? new Set(message.tool_calls.map(call => String(call?.id || ''))) : null;
  }
  // 末尾未回应的 tool call 同样不可发送：所有协议都要求 call 之后紧跟结果。
  if (pending?.size) throw new LlmMessageShapeError('tool calls left unanswered at the end', { index: rest.length });

  const leading = rest[0]?.role === 'user' ? [] : [{ role: 'user', content: TASK_INPUT_MARKER }];
  return [
    ...(systemParts.length ? [{ role: 'system', content: systemParts.join('\n\n') }] : []),
    ...leading,
    ...rest,
  ];
}

const fail = (api, reason) => { throw new LlmMessageShapeError(`${api} request body invalid: ${reason}`, { api, reason }); };

/** 协议级译后校验：只看消息结构，不看厂商私有字段。 */
const BODY_RULES = {
  'openai-completions'(body) {
    const list = body?.messages;
    if (!Array.isArray(list) || !list.length) fail('openai-completions', 'empty messages');
    const firstNonSystem = list.find(message => message.role !== 'system');
    if (firstNonSystem?.role !== 'user') fail('openai-completions', 'first non-system message must be user');
    if (list.slice(1).some(message => message.role === 'system')) fail('openai-completions', 'system message after the head');
  },
  'openai-responses'(body) {
    const list = body?.input;
    if (!Array.isArray(list) || !list.length) fail('openai-responses', 'empty input');
    const firstNonSystem = list.find(item => item.role !== 'system');
    if (firstNonSystem?.role !== 'user') fail('openai-responses', 'first non-system input must be user');
  },
  'anthropic-messages'(body) {
    const list = body?.messages;
    if (!Array.isArray(list) || !list.length) fail('anthropic-messages', 'empty messages');
    if (list[0].role !== 'user') fail('anthropic-messages', 'first message must be user');
    if (list.some(message => message.role === 'system')) fail('anthropic-messages', 'system must be top-level');
  },
  'google-generative-ai'(body) {
    const list = body?.contents;
    if (!Array.isArray(list) || !list.length) fail('google-generative-ai', 'empty contents');
    if (list[0].role !== 'user') fail('google-generative-ai', 'first content must be user');
  },
};

export function validateRequestBody(api, body) {
  const rule = BODY_RULES[api];
  if (!rule) fail(String(api), 'unknown protocol');
  rule(body);
  return body;
}

export const VALIDATED_PROTOCOLS = Object.freeze(Object.keys(BODY_RULES));
