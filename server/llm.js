// llm.js — LLM 传输层：provider 注册表 + 四种协议适配器。
//
// 用户决策（unified-model-providers）：模型接入是 provider 注册表 + 全局"使用中"模型 +
// 会话级覆盖；协议支持 openai-completions / openai-responses / anthropic-messages /
// google-generative-ai。Lunara 内部消息/工具循环保持 **OpenAI 标准形**
// （system/user/assistant/tool 消息、tools[{type:'function',function:{...}}]、
// assistant.tool_calls）；每个适配器只做「标准形 ↔ 协议原生」双向转换，
// 统一返回 { message, finishReason, usage }。
//
// 端点解析链：options.endpoint 显式 → 会话覆盖 → 全局 activeModel → legacy（见 llmProviders.js）。
// AgentLoop、反思、打标、电台策划等全部经由本模块，不存在第二套 provider 分支。

import { randomUUID } from 'node:crypto';
import { getLLMConfig } from './llmConfig.js';
import { resolveModelEndpoint, resolveModelFailoverTargets } from './llmProviders.js';
import { createFailoverChat } from './llmFailover.js';
import { capabilityFromEndpoint, nativeStructuredForm } from './llmCapabilities.js';
import { budgetForAttempt, resolveTaskBudget } from './llmTasks.js';
import { conformMessages, validateRequestBody } from './llmMessages.js';

const TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS || '90000', 10);

// 传输层结果分类（design §3）：
//   ok            正常
//   truncated     被截断（finishReason=length）
//   reasoning_only 只有思考没有正文（思考把输出额度吃满的经典形态）
//   invalid_json  调用方声明结构化但正文不是可解析的 JSON 对象
// provider_error / cancelled 是异常路径（抛出），不是结果分类。
const RECOVERABLE_OUTCOMES = new Set(['truncated', 'reasoning_only', 'invalid_json']);
const EXHAUSTED_CODES = Object.freeze({
  truncated: 'LLM_TRUNCATED_CONTENT',
  reasoning_only: 'LLM_REASONING_ONLY',
  invalid_json: 'LLM_INVALID_JSON',
});

function classifyOutcome({ result, structured }) {
  const content = typeof result?.message?.content === 'string' ? result.message.content.trim() : '';
  const toolCalls = Array.isArray(result?.message?.tool_calls) ? result.message.tool_calls : [];
  const reasoning = typeof result?.reasoning === 'string' && result.reasoning.trim() ? result.reasoning : '';
  const reasoningTokens = Number.isInteger(result?.reasoningTokens) ? result.reasoningTokens : null;
  const finishReason = result?.finishReason ?? null;
  if (!content && !toolCalls.length) {
    if (reasoning) return 'reasoning_only';
    if (finishReason === 'length') {
      // 达到输出上限且没有正文：拿不到思考正文的模型用 reasoning token 证据同样判“只有思考”。
      return reasoningTokens != null && reasoningTokens > 0 ? 'reasoning_only' : 'truncated';
    }
    // JSON 任务的空回复不再当作 ok（审查缺口）：进入结构化不合法恢复阶梯；
    // 文本任务保持原状，空 + stop 交回 AgentLoop 的空回复处理。
    if (structured === 'json') return 'invalid_json';
    return 'ok';
  }
  if (finishReason === 'length') return 'truncated';
  if (structured === 'json' && !isJsonObjectLike(content)) return 'invalid_json';
  return 'ok';
}

function isJsonObjectLike(content) {
  const parsed = extractJson(content);
  return parsed != null && typeof parsed === 'object';
}

/** 截断响应里工具调用是否仍完整可用：参数可解析 = 下游能 fail-closed 地继续。 */
function usableToolCalls(result) {
  const toolCalls = Array.isArray(result?.message?.tool_calls) ? result.message.tool_calls : [];
  if (!toolCalls.length) return false;
  return toolCalls.every(call => {
    const raw = call?.function?.arguments;
    if (raw == null || raw === '') return true;
    if (typeof raw === 'object') return true;
    try { JSON.parse(String(raw)); return true; } catch { return false; }
  });
}

// ============================================================
// 观测钩子：组合根注入（会话记录），llm.js 不依赖其实现。
// 事件只带模型、适配后的请求 body 与公开响应字段；绝不带 url/headers/apiKey。
// 观察者异常一律吞掉，绝不影响真实模型调用。
// 相位：start（一次，带首次尝试的 body 与额度）/ attempt（每次尝试一条分类记录）/
// end（最终成功）/ error（供应方错误、取消或升级耗尽后失败）。
// ============================================================

let llmObserver = null;

export function setLlmObserver(fn) {
  llmObserver = typeof fn === 'function' ? fn : null;
}

function notifyObserver(event) {
  // 调用时读取模块级引用：注入/卸载不需要重建 createLlm 实例。
  const observer = llmObserver;
  if (!observer) return;
  try { observer(event); } catch {}
}

/**
 * 供应商错误正文只进该聊天的私有 session trace（add-peer-message-protocol D7）：
 * 先抹掉形似凭据的片段（Bearer/sk-/URL 查询里的 key、token），再截断。不进日志与可见文案。
 */
function redactProviderDetail(detail) {
  if (typeof detail !== 'string' || !detail) return null;
  return detail
    .replace(/Bearer\s+[^\s"',}]+/giu, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, 'sk-[redacted]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token|secret)=)[^&\s"']+/giu, '$1[redacted]')
    .slice(0, 300);
}

/**
 * traceContent=false（如主动唤醒的 ambient turn）：观测只留数值与分类——
 * 不记请求 body、回复正文、思考内容与工具参数；工具只留名字。用量与归属照常。
 */
function withoutContent(event) {
  return { ...event, ...('body' in event ? { body: null } : {}), ...('text' in event ? { text: null } : {}),
    ...('providerDetail' in event ? { providerDetail: null } : {}),
    ...('reasoning' in event ? { reasoning: null } : {}),
    ...(Array.isArray(event.toolCalls)
      ? { toolCalls: event.toolCalls.map(call => ({ name: String(call?.function?.name || call?.name || '') })) } : {}) };
}

// ============================================================
// 能力观测上报：组合根注入（把运行时证实的能力事实并入注册表）。
// 目前一条事实：某模型「能否关闭思考」——批量机械任务尝试一次关闭参数，
// 被拒或"发了但仍在思考"即记 false（负缓存），以后不再发送（任务 1.6a）。
// 与 llmObserver 同一纪律：只带模型与事实，异常一律吞掉。
// ============================================================

let capabilityObserver = null;

export function setCapabilityObserver(fn) {
  capabilityObserver = typeof fn === 'function' ? fn : null;
}

function reportCapabilityFact(fact) {
  const observer = capabilityObserver;
  if (!observer || !fact?.providerId) return;
  try { observer(fact); } catch {}
}

/** 观测接线是否在位：只有能把结论记住时，才值得“尝试一次关闭参数”（否则每次都会重试）。 */
function canReportCapabilityFacts() {
  return Boolean(capabilityObserver);
}

// ============================================================
// 日内预算守卫：组合根注入（server/llmUsageLedger.js）。
// 在真正 fetch 之前调用；返回 { ok:false } 即拒绝本次调用（fail closed，
// 抛 LLM_BUDGET_EXHAUSTED，不升级重试）。守卫只看到任务与额度数字，
// 绝不接触端点、请求体或凭据。缺省不启用（测试与纯 CLI 场景）。
// ============================================================

let budgetGuard = null;

export function setLlmBudgetGuard(fn) {
  budgetGuard = typeof fn === 'function' ? fn : null;
}

/**
 * 参数被网关拒绝：400/422 一律视为"这个参数用不了"（设计原文："被拒（400/未知字段）"）。
 * 候选请求与非候选请求的唯一差异就是该参数，所以 400 归因到参数是安全结论：
 * 负缓存记住后不再发送，真正的请求错误会在重跑时如实抛出。5xx/429 不是参数问题。
 */
function isParameterRejection(error) {
  const status = Number(error?.status);
  return status === 400 || status === 422;
}

function llmTemperature(fallback) {
  const value = Number.parseFloat(process.env.LLM_TEMPERATURE);
  return Number.isFinite(value) && value >= 0 && value <= 2 ? value : fallback;
}

// ============================================================
// 思考档位（reasoning effort）：词表、声明夹紧与 token 映射。
// 档位 = Provider 声明的事实（endpoint.reasoningEfforts）+ 用户偏好（options/端点生效档位）；
// 能力档案只描述协议旋钮，偏好绝不写回档案（design §Decisions）。
// ============================================================

const EFFORT_LEVELS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TOP_EFFORTS = new Set(['high', 'xhigh', 'max', 'ultra']);

function normalizeEffortLevel(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text || null;
}

/** 声明档位归一化：未知/坏值忽略，去重；空数组视为没有声明。 */
function normalizeDeclaredEfforts(value) {
  if (!Array.isArray(value)) return null;
  const levels = [];
  for (const item of value) {
    const level = normalizeEffortLevel(item);
    if (level && !levels.includes(level)) levels.push(level);
  }
  return levels.length ? levels : null;
}

function effortRank(level) {
  return EFFORT_LEVELS.indexOf(level);
}

/**
 * 已声明档位里比 current 更低的一档；current 未知/没有时给出最低可发送档位。
 * 未知档位不猜（返回 null），由调用方决定是否保持或放弃。
 */
function lowerDeclaredEffort(levels, current) {
  if (!Array.isArray(levels) || !levels.length) return null;
  const ranked = levels.filter(level => effortRank(level) >= 0);
  if (!ranked.length) return null;
  if (current == null) return ranked.reduce((lowest, level) => (effortRank(level) < effortRank(lowest) ? level : lowest));
  const currentRank = effortRank(current);
  if (currentRank < 0) return null;
  let target = null;
  for (const level of ranked) {
    const rank = effortRank(level);
    if (rank < currentRank && (target == null || rank > effortRank(target))) target = level;
  }
  return target;
}

/** 档位 → thinking token 预算（design §传输层夹紧）；未知档位返回 null，不猜。 */
function thinkingBudgetForLevel(level, range) {
  if (!Array.isArray(range) || range.length !== 2) return null;
  const [min, max] = range;
  if (level === 'none' || level === 'low') return min;
  if (level === 'medium') return Math.floor((min + max) / 2);
  if (TOP_EFFORTS.has(level)) return max;
  return null;
}

/**
 * `reasoning_only` 的降档目标：只从已声明档位里降；没有声明时 reasoning_effort 旋钮
 * 尝试 low，thinking_budget 旋钮用区间下界。返回 null = 没有可发送的档位能力，
 * 调用方保持既有升级阶梯。
 */
function lowerThinkingEffort({ knob, declaredEfforts, budgetRange, budgetChannel, plan }) {
  if (!knob || !plan || plan.disabled) return null;
  if (knob === 'reasoning_effort') {
    if (declaredEfforts) return lowerDeclaredEffort(declaredEfforts, plan.effort) ?? plan.effort ?? null;
    // 没有声明：该旋钮代表探测已证实接受过 low，因此只降/保持 low。
    return 'low';
  }
  if (!budgetChannel || !Array.isArray(budgetRange)) return null;
  const current = Number.isFinite(plan.budgetTokens) ? plan.budgetTokens : null;
  let target = null;
  for (const level of ['low', 'medium', 'high']) {
    const tokens = thinkingBudgetForLevel(level, budgetRange);
    if (tokens != null && current != null && tokens < current
      && (target == null || tokens > thinkingBudgetForLevel(target, budgetRange))) target = level;
  }
  return target ?? 'low';
}

export class LLMNotConfiguredError extends Error {
  constructor() {
    super('请先在设置里接入模型（Provider / API Key / 模型）');
    this.name = 'LLMNotConfiguredError';
    this.code = 'LLM_NOT_CONFIGURED';
  }
}

export function extractJson(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return null;
  try { return JSON.parse(text); } catch {}

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(text.slice(start, index + 1)); } catch { start = -1; }
      }
    }
  }
  return null;
}

// ============================================================
// 协议适配器：标准形 → 原生请求 / 原生响应 → 标准形
// ============================================================

function toolArgumentsRaw(call) {
  const raw = call?.function?.arguments;
  return typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
}

function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')) || {}; } catch { return {}; }
}

function openaiToolsDefinition(tools) {
  return tools && tools.length ? tools.map(tool => ({
    type: 'function',
    function: {
      name: tool?.function?.name || tool?.name || '',
      ...(tool?.function?.description || tool?.description ? { description: tool.function?.description || tool.description } : {}),
      parameters: tool?.function?.parameters || tool?.parameters || { type: 'object', properties: {} },
    },
  })) : null;
}

// 思考控制（关闭 / effort 档位 / token budget）的唯一决策点在 chat()：适配器只按
// options.thinking 组装，绝不自行判断模型家族。未知模型不携带任何厂商私有字段。

/** 指定工具选择 → 工具名（兼容 OpenAI 形状与裸字符串）。模式串由调用方各自处理。 */
function toolChoiceName(toolChoice) {
  if (!toolChoice) return null;
  if (typeof toolChoice === 'string') {
    return ['auto', 'required', 'none', 'any'].includes(toolChoice) ? null : toolChoice;
  }
  const name = toolChoice?.function?.name || toolChoice?.name || null;
  return name ? String(name) : null;
}

/**
 * 归一化“思考计入输出的总输出 token”：
 * OpenAI/Anthropic 的 completion_tokens 已含思考；Google 分开返回，需要相加。
 */
function normalizedOutputTokens(api, result) {
  const completion = Number(result?.usage?.completion_tokens);
  if (!Number.isFinite(completion)) return null;
  const reasoning = Number(result?.reasoningTokens);
  const separate = api === 'google-generative-ai' && Number.isFinite(reasoning);
  return completion + (separate ? reasoning : 0);
}

/** 原生结构化请求（design §3）：按协议形态组装；形态不可用时返回 null，如实退回文本抽取。 */
function openaiResponseFormat(options) {
  if (!options.nativeStructured) return null;
  if (options.nativeStructured === 'json_object') return { type: 'json_object' };
  if (options.nativeStructured === 'json_schema' && options.jsonSchema) {
    return { type: 'json_schema', json_schema: {
      name: options.jsonSchemaName || 'lunara_output', schema: options.jsonSchema,
      ...(options.jsonSchemaStrict === true ? { strict: true } : {}),
    } };
  }
  return null;
}

/** openai-completions：Lunara 标准形即原生形状，透传。 */
function buildOpenaiCompletionsRequest({ endpoint, messages, tools, options }) {
  const body = {
    model: endpoint.model,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
    messages,
  };
  // 可选流式（add-streaming-transport-eval）：只有显式 options.stream === true 才请求 SSE。
  // include_usage 让供应商在 [DONE] 前补一个 usage chunk；网关不返回时用量保持 null，绝不写 0。
  // 非流式（默认）请求体不得出现这两个字段。
  if (options.stream === true || options.streamRequired === true) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (tools) body.tools = tools;
  if (options.toolChoice != null) {
    const choiceName = toolChoiceName(options.toolChoice);
    const raw = typeof options.toolChoice === 'object' ? options.toolChoice : null;
    body.tool_choice = raw || (choiceName ? { type: 'function', function: { name: choiceName } } : options.toolChoice);
  }
  // 思考控制按档案发送（design §5.1）：关闭/effort 由 chat() 决策，未知模型不发厂商私有字段。
  const thinking = options.thinking || {};
  if (thinking.mode) body.thinking = { type: thinking.mode };
  if (thinking.effort) body.reasoning_effort = thinking.effort;
  const responseFormat = openaiResponseFormat(options);
  if (responseFormat) body.response_format = responseFormat;
  return { url: `${endpoint.baseUrl}/chat/completions`, headers: bearerHeaders(endpoint.apiKey), body };
}

// 供应商返回的思考内容与推理 token 只有部分协议提供：拿不到就保持 null（未知），
// 绝不写成 0；调用方据此区分“没有思考”和“供应商没有返回”。
function textOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function joinedOrNull(parts) {
  return parts.length ? parts.join('\n') : null;
}

function parseOpenaiCompletionsResponse(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') {
    const error = new Error('LLM API response missing choices[0].message');
    error.code = 'LLM_INVALID_RESPONSE';
    throw error;
  }
  const reasoningTokens = integerOrNull(payload?.usage?.completion_tokens_details?.reasoning_tokens);
  return {
    message: {
      role: message.role || 'assistant',
      content: message.content ?? '',
      tool_calls: Array.isArray(message.tool_calls) ? message.tool_calls : null,
    },
    finishReason: payload?.choices?.[0]?.finish_reason || null,
    usage: payload?.usage || null,
    reasoning: textOrNull(message.reasoning_content) || textOrNull(message.reasoning),
    reasoningTokens,
  };
}

// ============================================================
// openai-completions 可选流式（add-streaming-transport-eval）
// ------------------------------------------------------------
// 只在 chat() 显式 options.stream === true 且协议是 openai-completions 时使用。
// SSE 增量在这里累积成 **与非流式等价的 payload**，再交给既有
// parseOpenaiCompletionsResponse —— 消息/工具调用归一只有一套逻辑，流式不另开分支。
// 行级宽容：空行、注释（`:` 开头）、event:/id:/retry: 字段与非 JSON chunk 一律跳过；
// `data: [DONE]` 结束读取。多行 data 事件（OpenAI-compatible 不产生）不拼接，按单行事件处理。
// 流内 error 对象是真实供应商失败（不是坏 chunk）：抛 LLM_API_ERROR，不静默当空回复。
// 没有任何可解析 chunk（例如网关忽略 stream 直接回普通 JSON）按 LLM_INVALID_RESPONSE 归类，
// 与 response.json() 解析失败同一条错误通道。
// ============================================================

const SSE_DATA_PREFIX = 'data:';

function streamFailure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function applyOpenaiStreamChunk(chunk, state) {
  if (!chunk || typeof chunk !== 'object') return;
  if (chunk.error != null) {
    // 供应商在流内报告错误（配额/鉴权/超时等）：按 API 错误上抛，绝不当作正常空回复。
    const detail = typeof chunk.error?.message === 'string' ? chunk.error.message : '';
    const error = streamFailure('LLM API stream reported an error', 'LLM_API_ERROR');
    error.status = Number.isInteger(chunk.error?.status) ? chunk.error.status : null;
    error.detail = detail.slice(0, 300);
    throw error;
  }
  state.chunkCount += 1;
  // usage chunk 通常位于 [DONE] 之前且 choices 为空；任何 chunk 携带 usage 都记录（后者覆盖前者）。
  if (chunk.usage && typeof chunk.usage === 'object') state.usage = chunk.usage;
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
  if (!choice || typeof choice !== 'object') return;
  if (choice.finish_reason != null) state.finishReason = choice.finish_reason;
  const delta = choice.delta && typeof choice.delta === 'object' ? choice.delta : null;
  if (!delta) return;

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    state.content += delta.content;
    if (state.ttftMs == null) {
      state.ttftMs = Math.max(0, Date.now() - state.startedAt);
      state.onFirstContent?.(state.ttftMs);
    }
    state.onTextDelta?.(delta.content);
  }

  // 思考增量：DeepSeek/兼容网关用 reasoning_content；部分网关用 reasoning。两者都可能缺失。
  const reasoningDelta = typeof delta.reasoning_content === 'string' && delta.reasoning_content
    ? delta.reasoning_content
    : (typeof delta.reasoning === 'string' ? delta.reasoning : '');
  if (reasoningDelta) state.reasoning += reasoningDelta;

  // 工具调用只给片段：按 index 累积 id/type/name/arguments。缺失 index 视为 0；
  // 没有 id 就不伪造 id（下游按 name/arguments fail-closed 处理）。
  for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
    if (!fragment || typeof fragment !== 'object') continue;
    const index = Number.isInteger(fragment.index) ? fragment.index : 0;
    let call = state.toolCalls.get(index);
    if (!call) {
      call = { id: null, type: null, name: '', arguments: '' };
      state.toolCalls.set(index, call);
    }
    if (typeof fragment.id === 'string' && fragment.id) call.id = fragment.id;
    if (typeof fragment.type === 'string' && fragment.type) call.type = fragment.type;
    const fn = fragment.function && typeof fragment.function === 'object' ? fragment.function : null;
    if (!fn) continue;
    if (typeof fn.name === 'string' && fn.name) call.name += fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments) call.arguments += fn.arguments;
  }
}

/** 单行 SSE 处理：返回 true 表示收到 [DONE]（调用方停止读取）。 */
function consumeOpenaiStreamLine(rawLine, state) {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (!line) return false; // 空行：事件分隔
  if (line.startsWith(':')) return false; // 注释/心跳
  if (!line.startsWith(SSE_DATA_PREFIX)) return false; // event:/id:/retry: 或垃圾行
  const payload = line.slice(SSE_DATA_PREFIX.length).trim();
  if (!payload) return false;
  if (payload === '[DONE]') return true;
  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    if (state.strict) throw streamFailure('LLM stream contained an invalid event', 'LLM_STREAM_INCOMPLETE');
    return false; // 非展示型 eval 保留历史宽容行为
  }
  applyOpenaiStreamChunk(chunk, state);
  return false;
}

/**
 * 读取 SSE 流并累积为非流式等价 payload。
 * @param {Response} response fetch 响应（body 必须是可读流）
 * @param {{ startedAt: number, onFirstContent?: (ttftMs: number) => void }} params
 *   startedAt = fetch 发出时刻；onFirstContent 在首个非空正文 delta 时回调（用于观测事件）。
 * @returns {Promise<{ payload: object, ttftMs: number|null }>}
 */
async function readOpenaiCompletionsStream(response, { startedAt, onFirstContent = null,
  onTextDelta = null, signal = null, strict = false } = {}) {
  const body = response?.body;
  if (!body || typeof body.getReader !== 'function') {
    throw streamFailure('LLM API stream has no readable body', 'LLM_INVALID_RESPONSE');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const state = {
    startedAt,
    onFirstContent,
    onTextDelta,
    strict,
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    chunkCount: 0,
    ttftMs: null,
    toolCalls: new Map(),
  };
  let buffer = '';
  let done = false;

  const consumeBuffer = () => {
    let newline = buffer.indexOf('\n');
    while (!done && newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (consumeOpenaiStreamLine(line, state)) done = true;
      newline = buffer.indexOf('\n');
    }
  };

  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    while (!done) {
      const read = await reader.read();
      signal?.throwIfAborted();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      consumeBuffer();
    }
    if (!done) {
      // 流正常结束：flush 解码器、处理没有尾随换行的最后一行。
      buffer += decoder.decode();
      if (buffer.length) {
        consumeBuffer();
        if (!done && buffer.length && consumeOpenaiStreamLine(buffer, state)) done = true;
        buffer = '';
      }
    }
  } finally {
    // 读完、收到 [DONE] 或读取中断都释放底层读取器。已结束的流 cancel 无副作用；
    // 流已出错时 cancel 会以同一错误拒绝，这里不覆盖主错误。
    signal?.removeEventListener('abort', onAbort);
    // A broken stream may have an uncooperative cancel(); do not await cleanup.
    void reader.cancel().catch(() => {});
  }

  if (strict && (!done || state.finishReason == null)) {
    throw streamFailure('LLM stream ended without a terminal event', 'LLM_STREAM_INCOMPLETE');
  }

  // 原始 SSE 一行都没解析出来：网关可能忽略了 stream 直接返回普通 JSON（或流被截断在事件头），
  // 与 response.json() 解析失败同等归类，调用方仍需按真实请求结算用量。
  if (!state.chunkCount) throw streamFailure('LLM API stream contained no data', 'LLM_INVALID_RESPONSE');

  const toolCalls = [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({
      ...(call.id ? { id: call.id } : {}),
      type: call.type || 'function',
      function: { name: call.name, arguments: call.arguments },
    }));

  // 与非流式响应同形：既有 parser 负责 role/content/tool_calls/reasoning/usage 归一。
  const payload = {
    choices: [{
      message: {
        role: 'assistant',
        content: state.content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(state.reasoning ? { reasoning: state.reasoning } : {}),
      },
      finish_reason: state.finishReason,
    }],
    usage: state.usage,
  };
  return { payload, ttftMs: state.ttftMs };
}

/** openai-responses：messages → input 项；tool 结果 → function_call_output。 */
function buildOpenaiResponsesRequest({ endpoint, messages, tools, options }) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'system') {
      input.push({ role: 'system', content: message.content });
      continue;
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: String(message.tool_call_id || ''),
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (message.content) input.push({ role: 'assistant', content: [{ type: 'output_text', text: String(message.content) }] });
      for (const call of message.tool_calls) {
        input.push({ type: 'function_call', call_id: String(call.id || ''), name: call?.function?.name || '',
          arguments: toolArgumentsRaw(call) });
      }
      continue;
    }
    input.push({ role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(message.content ?? '') }] });
  }
  const body = {
    model: endpoint.model,
    max_output_tokens: options.maxTokens,
    temperature: options.temperature,
    input,
  };
  // Responses 协议的原生结构化走 text.format（与 completions 的 response_format 不同名）。
  if (options.nativeStructured === 'json_object') body.text = { format: { type: 'json_object' } };
  else if (options.nativeStructured === 'json_schema' && options.jsonSchema) {
    body.text = { format: { type: 'json_schema', name: options.jsonSchemaName || 'lunara_output',
      schema: options.jsonSchema, ...(options.jsonSchemaStrict === true ? { strict: true } : {}) } };
  }
  if (tools) {
    body.tools = tools.map(tool => ({
      type: 'function',
      name: tool?.function?.name || tool?.name || '',
      ...(tool?.function?.description || tool?.description ? { description: tool.function?.description || tool.description } : {}),
      parameters: tool?.function?.parameters || tool?.parameters || { type: 'object', properties: {} },
    }));
  }
  // 指定工具选择（审查缺口）：Responses 用 { type:'function', name }，模式串原样透传。
  const responsesChoiceName = toolChoiceName(options.toolChoice);
  if (responsesChoiceName) body.tool_choice = { type: 'function', name: responsesChoiceName };
  else if (typeof options.toolChoice === 'string' && ['auto', 'required', 'none'].includes(options.toolChoice)) {
    body.tool_choice = options.toolChoice;
  }
  const responsesThinking = options.thinking || {};
  if (responsesThinking.effort) body.reasoning = { effort: responsesThinking.effort };
  return { url: `${endpoint.baseUrl}/responses`, headers: bearerHeaders(endpoint.apiKey), body };
}

function parseOpenaiResponsesResponse(payload) {
  const output = Array.isArray(payload?.output) ? payload.output : [];
  let content = '';
  const toolCalls = [];
  const reasoningParts = [];
  for (const item of output) {
    if (item?.type === 'message') {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (block?.type === 'output_text' && block.text) content += (content ? '\n' : '') + block.text;
      }
    } else if (item?.type === 'reasoning') {
      const parts = [];
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const blocks = summary.length ? summary : (Array.isArray(item.content) ? item.content : []);
      for (const block of blocks) {
        if (typeof block?.text === 'string' && block.text) parts.push(block.text);
      }
      if (parts.length) reasoningParts.push(parts.join('\n'));
    } else if (item?.type === 'function_call') {
      toolCalls.push({ id: String(item.call_id || ''), type: 'function',
        function: { name: String(item.name || ''), arguments: String(item.arguments || '{}') } });
    }
  }
  const usage = payload?.usage ? {
    prompt_tokens: payload.usage.input_tokens,
    completion_tokens: payload.usage.output_tokens,
    total_tokens: (payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0),
  } : null;
  const incomplete = payload?.status === 'incomplete' || payload?.incomplete_details != null;
  return {
    message: { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : null },
    finishReason: incomplete ? 'length' : (toolCalls.length ? 'tool_calls' : 'stop'),
    usage,
    reasoning: joinedOrNull(reasoningParts),
    reasoningTokens: integerOrNull(payload?.usage?.output_tokens_details?.reasoning_tokens),
  };
}

/** anthropic-messages：system 提取、max_tokens 必填、tool_use/tool_result 块。 */
function buildAnthropicRequest({ endpoint, messages, tools, options }) {
  const systemParts = [];
  const converted = [];
  let pendingToolResults = null;

  const flushToolResults = () => {
    if (pendingToolResults) {
      converted.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = null;
    }
  };

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(String(message.content ?? ''));
      continue;
    }
    if (message.role === 'tool') {
      pendingToolResults ||= [];
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: String(message.tool_call_id || ''),
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      });
      continue;
    }
    flushToolResults();
    if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: String(message.content) });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        blocks.push({ type: 'tool_use', id: String(call.id || ''), name: call?.function?.name || '',
          input: parseToolArguments(call?.function?.arguments) });
      }
      converted.push({ role: 'assistant', content: blocks });
      continue;
    }
    converted.push({ role: 'user', content: String(message.content ?? '') });
  }
  flushToolResults();

  const body = {
    model: endpoint.model,
    // Anthropic 契约必填 max_tokens；AgentLoop profile 恒有值，这里兜底 2048。
    max_tokens: options.maxTokens || 2048,
    temperature: options.temperature,
    messages: converted,
  };
  if (systemParts.length) body.system = systemParts.join('\n\n');
  if (tools) {
    body.tools = tools.map(tool => ({
      name: tool?.function?.name || tool?.name || '',
      description: tool?.function?.description || tool?.description || '',
      input_schema: tool?.function?.parameters || tool?.parameters || { type: 'object', properties: {} },
    }));
  }
  // 指定工具选择（审查缺口）：Anthropic 用 { type:'tool', name }；模式串 'any' 走 { type:'any' }。
  const anthropicChoiceName = toolChoiceName(options.toolChoice);
  if (anthropicChoiceName) body.tool_choice = { type: 'tool', name: anthropicChoiceName };
  else if (options.toolChoice === 'any') body.tool_choice = { type: 'any' };
  // 思考 token budget（design §2）：额度 = 正文 + 思考余量，所以 max_tokens > budget_tokens 恒成立；
  // 扩展思考要求 temperature=1（协议约束，不能沿用采样温度）。
  const anthropicThinking = options.thinking || {};
  if (anthropicThinking.budgetTokens) {
    body.thinking = { type: 'enabled', budget_tokens: anthropicThinking.budgetTokens };
    body.temperature = 1;
  }
  // anthropic 没有 response_format：原生结构化用「强制工具」实现（design §3）。
  // 没有 schema 就不假装原生，退回文本抽取。
  if (options.nativeStructured === 'tool_force' && options.jsonSchema) {
    body.tools = [...(body.tools || []), {
      name: options.jsonSchemaName || 'structured_output',
      description: '把结果按给定 schema 作为 JSON 对象返回。',
      input_schema: options.jsonSchema,
    }];
    body.tool_choice = { type: 'tool', name: options.jsonSchemaName || 'structured_output' };
  }
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  if (endpoint.apiKey) headers['x-api-key'] = endpoint.apiKey;
  return { url: `${endpoint.baseUrl}/messages`, headers, body };
}

function parseAnthropicResponse(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  let content = '';
  const toolCalls = [];
  const reasoningParts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) content += (content ? '\n' : '') + block.text;
    else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
      reasoningParts.push(block.thinking);
    } else if (block?.type === 'tool_use') {
      toolCalls.push({ id: String(block.id || ''), type: 'function',
        function: { name: String(block.name || ''), arguments: JSON.stringify(block.input ?? {}) } });
    }
  }
  const finishReason = payload?.stop_reason === 'tool_use' ? 'tool_calls'
    : payload?.stop_reason === 'max_tokens' ? 'length' : 'stop';
  const usage = payload?.usage ? {
    prompt_tokens: payload.usage.input_tokens,
    completion_tokens: payload.usage.output_tokens,
    total_tokens: (payload.usage.input_tokens || 0) + (payload.usage.output_tokens || 0),
  } : null;
  return {
    message: { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : null },
    finishReason,
    usage,
    // anthropic 的 usage 没有独立推理 token 计数，输入/输出已含思考，不猜测拆分。
    reasoning: joinedOrNull(reasoningParts),
    reasoningTokens: null,
  };
}

/** google-generative-ai：systemInstruction、functionDeclarations、functionCall/Response。 */
function buildGoogleRequest({ endpoint, messages, tools, options }) {
  // id → name 映射：google 的 functionCall/functionResponse 都没有 id，按 name 对齐。
  const idToName = new Map();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) idToName.set(String(call.id), call?.function?.name || '');
      }
    }
  }

  const systemParts = [];
  const contents = [];
  let pendingFunctionResponses = null;

  const flushFunctionResponses = () => {
    if (pendingFunctionResponses) {
      contents.push({ role: 'user', parts: pendingFunctionResponses });
      pendingFunctionResponses = null;
    }
  };

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(String(message.content ?? ''));
      continue;
    }
    if (message.role === 'tool') {
      pendingFunctionResponses ||= [];
      pendingFunctionResponses.push({
        functionResponse: {
          name: idToName.get(String(message.tool_call_id || '')) || '',
          response: { result: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '') },
        },
      });
      continue;
    }
    flushFunctionResponses();
    const parts = [];
    if (message.content) parts.push({ text: String(message.content) });
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      parts.push({ functionCall: { name: call?.function?.name || '', args: parseToolArguments(call?.function?.arguments) } });
    }
    if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  flushFunctionResponses();

  const body = {
    contents,
    generationConfig: { temperature: options.temperature, maxOutputTokens: options.maxTokens },
  };
  // Gemini 的原生结构化：responseMimeType + 可选 responseSchema。
  if (options.nativeStructured) {
    body.generationConfig.responseMimeType = 'application/json';
    if (options.nativeStructured === 'json_schema' && options.jsonSchema) {
      body.generationConfig.responseSchema = options.jsonSchema;
    }
  }
  // 思考控制（design §2）：关闭走 thinkingBudget=0；token budget 走 thinkingBudget=额度。
  const googleThinking = options.thinking || {};
  if (googleThinking.mode === 'disabled') body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  else if (googleThinking.budgetTokens != null) {
    body.generationConfig.thinkingConfig = { thinkingBudget: googleThinking.budgetTokens };
  }
  if (systemParts.length) body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  if (tools) {
    body.tools = [{
      functionDeclarations: tools.map(tool => ({
        name: tool?.function?.name || tool?.name || '',
        description: tool?.function?.description || tool?.description || '',
        parameters: tool?.function?.parameters || tool?.parameters || { type: 'object', properties: {} },
      })),
    }];
  }
  // 指定工具选择（审查缺口）：Gemini 用 functionCallingConfig 的 ANY + allowedFunctionNames。
  const googleChoiceName = toolChoiceName(options.toolChoice);
  if (googleChoiceName) {
    body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [googleChoiceName] } };
  }
  const headers = { 'content-type': 'application/json' };
  if (endpoint.apiKey) headers['x-goog-api-key'] = endpoint.apiKey;
  return { url: `${endpoint.baseUrl}/models/${encodeURIComponent(endpoint.model)}:generateContent`, headers, body };
}

function parseGoogleResponse(payload) {
  const candidate = payload?.candidates?.[0] || {};
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  let content = '';
  const toolCalls = [];
  const reasoningParts = [];
  for (const part of parts) {
    // thought=true 是模型内部思考：归入 reasoning，绝不能混进可见正文。
    if (part?.thought === true) {
      if (typeof part?.text === 'string' && part.text) reasoningParts.push(part.text);
    } else if (part?.text) content += part.text;
    else if (part?.functionCall?.name) {
      const name = String(part.functionCall.name);
      toolCalls.push({ id: `gcall_${name}`, type: 'function',
        function: { name, arguments: JSON.stringify(part.functionCall.args ?? {}) } });
    }
  }
  const finishRaw = String(candidate?.finishReason || '').toUpperCase();
  const finishReason = finishRaw === 'MAX_TOKENS' ? 'length' : (toolCalls.length ? 'tool_calls' : 'stop');
  const usage = payload?.usageMetadata ? {
    prompt_tokens: payload.usageMetadata.promptTokenCount,
    completion_tokens: payload.usageMetadata.candidatesTokenCount,
    total_tokens: payload.usageMetadata.totalTokenCount
      || (payload.usageMetadata.promptTokenCount || 0) + (payload.usageMetadata.candidatesTokenCount || 0),
  } : null;
  return {
    message: { role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : null },
    finishReason,
    usage,
    reasoning: joinedOrNull(reasoningParts),
    reasoningTokens: integerOrNull(payload?.usageMetadata?.thoughtsTokenCount),
  };
}

const ADAPTERS = {
  'openai-completions': { build: buildOpenaiCompletionsRequest, parse: parseOpenaiCompletionsResponse },
  'openai-responses': { build: buildOpenaiResponsesRequest, parse: parseOpenaiResponsesResponse },
  'anthropic-messages': { build: buildAnthropicRequest, parse: parseAnthropicResponse },
  'google-generative-ai': { build: buildGoogleRequest, parse: parseGoogleResponse },
};

function bearerHeaders(apiKey) {
  const headers = { 'content-type': 'application/json' };
  // 本地网关常不设 key：只有真有 key 才带 Authorization，绝不发空 Bearer。
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

// （思考参数的家族判定已迁入 llmCapabilities.capabilityFromEndpoint 的过渡桥；
//  适配器只按 options.capability 决定是否携带厂商字段。）

// ============================================================
// 传输入口
// ============================================================

// 会话覆盖由组合根注入（state prefs 支撑的 get/set 对），llm.js 不直接依赖 state 模块，
// 避免测试在 import 时打开真实数据库。
let sessionModelOverrides = null;
export function setSessionModelOverrides(overrides) {
  sessionModelOverrides = overrides || null;
}

async function resolveCallEndpoint(options = {}) {
  if (options.endpoint && options.endpoint.baseUrl && options.endpoint.model) {
    return { ...options.endpoint, api: options.endpoint.api || 'openai-completions' };
  }
  const resolved = await resolveModelEndpoint({
    sessionId: options.sessionId ?? null,
    overrides: sessionModelOverrides,
  });
  if (resolved) return resolved;
  // 兜底：注册表为空但 legacy 设置接口写入了旧三元组（未迁移场景）。
  const config = await getLLMConfig();
  if (config.baseUrl && config.apiKey && config.model) {
    return { baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
      api: 'openai-completions', source: 'legacy-config' };
  }
  throw new LLMNotConfiguredError();
}

export function createLlm({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  resolveEndpoint = resolveCallEndpoint,
  resolveFallbacks = resolveEndpoint === resolveCallEndpoint ? resolveModelFailoverTargets : async () => [],
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createLlm requires a fetch implementation');

  async function chatOnce(rawMessages, tools = null, options = {}) {
    // 规范消息先修成可移植形状（llmMessages.js），各协议适配器只做翻译。
    const messages = conformMessages(rawMessages);
    const observe = event => notifyObserver(options.traceContent === false ? withoutContent(event) : event);
    const endpoint = options.endpoint || await resolveEndpoint(options);
    const adapterApi = Object.hasOwn(ADAPTERS, endpoint.api) ? endpoint.api : 'openai-completions';
    const adapter = ADAPTERS[adapterApi];
    if (options.streamRequired === true && adapterApi !== 'openai-completions') {
      throw streamFailure('This model protocol does not support visible streaming', 'LLM_STREAM_UNSUPPORTED');
    }
    const capability = capabilityFromEndpoint(endpoint);

    // 声明档位是 Provider 事实；生效档位 = 调用方显式偏好 > 端点解析（会话覆盖/模型默认）> null。
    const declaredEfforts = normalizeDeclaredEfforts(endpoint.reasoningEfforts);
    const requestedEffort = normalizeEffortLevel(options.reasoningEffort)
      ?? normalizeEffortLevel(endpoint.reasoningEffort) ?? null;
    // 旋钮以能力档案为准；档案没有旋钮但 Provider 声明了枚举档位时，声明本身就是
    // reasoning_effort 通道的证据（枚举档位没有别的协议形态）。
    const effortKnob = capability.thinking?.budgetKnob || (declaredEfforts ? 'reasoning_effort' : null);
    const budgetRange = capability.thinking?.budgetRange ?? null;
    const budgetChannel = adapterApi === 'anthropic-messages' || adapterApi === 'google-generative-ai';
    // 档位枚举只有 openai 两种协议有字段；没有字段就如实跳过，不假装发过。
    const effortChannel = adapterApi === 'openai-completions' || adapterApi === 'openai-responses';

    // 关闭思考是否真能表达：只有协议有对应字段、且档案已证实可关时才按“已关闭”减少思考余量；
    // 其它情况保留余量，绝不静默扣除（审查修复：关闭被拒/被无视后的额度必须恢复）。
    const disableExpressible = (adapterApi === 'openai-completions' || adapterApi === 'google-generative-ai')
      && capability.thinking.canDisable === true;
    // 档位 none：能作为 reasoning_effort 枚举发送就不必走关闭通道；否则在 canDisable 已证实时
    // 按现有的关闭通道表达（用户偏好优先于任务成本默认）。
    const effortNoneAsEnum = effortKnob === 'reasoning_effort' && declaredEfforts?.includes('none') === true;
    let preferenceDisables = requestedEffort === 'none' && !effortNoneAsEnum && disableExpressible;
    const resolveBudget = thinkingMode => resolveTaskBudget({
      taskId: options.taskId ?? null,
      capability,
      maxTokens: options.maxTokens ?? null,
      thinkingMode,
    });
    // 预算唯一来源：任务规格 + 覆盖层（design §2）。生效额度 = 正文 + 思考余量（或覆盖总额）。
    // budget 是 let：关闭参数被拒或被无视后按保守计划重算（不是升级）。
    let budget = resolveBudget((options.thinkingMode === 'disabled' || preferenceDisables) && disableExpressible
      ? 'disabled' : undefined);
    // 负缓存（任务 1.6a）：批量机械任务 + 档案尚未证实 => 尝试一次关闭参数；
    // 被拒或被无视（仍在思考）即记 false 并从此不再发送。只有 openai-completions 有候选形态，
    // 且只在观测接线在位（结论真的能被记住）时尝试。
    let disableArmed = budget.disableThinking || preferenceDisables
      || (canReportCapabilityFacts() && adapterApi === 'openai-completions'
        && capability.thinking.canDisable == null
        && options.thinkingMode === 'disabled' && budget.spec.reasoning === 'wasteful');

    const requestedTemperature = Number(options.temperature);
    const temperature = Number.isFinite(requestedTemperature) && requestedTemperature >= 0
      && requestedTemperature <= 2 ? requestedTemperature : llmTemperature(0.7);
    const requestedTimeout = Number.parseInt(options.timeoutMs, 10);
    const timeoutMs = Number.isInteger(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout : (budget.timeoutMs ?? TIMEOUT_MS);

    /**
     * 思考控制（design §2/§5.1 与 reasoning-effort-control，唯一决策点）：
     * 关闭 / effort 档位 / token budget。优先级：重试降档 > 调用方/端点偏好 > 任务成本默认。
     * 发送前按能力旋钮与 Provider 声明夹紧；发不出去时记录 effortSkipped，绝不静默假装已生效。
     */
    const thinkingPlan = (armed, current, attemptBudget, effortOverride = null) => {
      const disabled = Boolean(preferenceDisables || armed || current.disableThinking);
      const preference = effortOverride ?? requestedEffort;
      // light：需要思考但不必深想，同样发送较低档位；关闭思考只属于 wasteful（见上方 disableArmed）。
      const costChoice = current.spec.reasoning === 'wasteful' || current.spec.reasoning === 'light';
      const level = preference ?? (costChoice ? 'low' : null);
      const next = {
        disabled,
        mode: disabled ? 'disabled'
          : (options.thinkingMode === 'enabled' && capability.thinking.canDisable === true ? 'enabled' : undefined),
        effort: null,
        budgetTokens: null,
        // 实际生效的档位（发送了枚举 / 映射成预算 / 以关闭表达 none）；什么也没发时为 null。
        reasoningEffort: disabled && level === 'none' ? 'none' : null,
        effortSkipped: undefined,
      };
      if (disabled || level == null) return next;

      if (effortKnob === 'reasoning_effort') {
        // 已请求档位时按档位发送；没有偏好时 light/wasteful 仍走 low（可发送时）。
        if (!effortChannel) {
          next.effortSkipped = 'protocol_has_no_effort_channel';
          return next;
        }
        if (level === 'none') {
          if (declaredEfforts?.includes('none')) {
            next.effort = 'none';
            next.reasoningEffort = 'none';
          } else {
            // 关闭通道不可用时不能把 none 伪装成 low，也不发未声明的枚举。
            next.effortSkipped = 'cannot_disable_thinking';
          }
          return next;
        }
        const sendable = declaredEfforts
          ? declaredEfforts.includes(level)
          // 没有声明时，该旋钮代表探测已证实接受过 low，因此只允许 low。
          : level === 'low';
        if (!sendable) {
          next.effortSkipped = declaredEfforts ? 'level_not_declared' : 'level_not_confirmed';
          return next;
        }
        next.effort = level;
        next.reasoningEffort = level;
        return next;
      }

      if (effortKnob === 'thinking_budget') {
        if (level === 'none') {
          // 已请求关闭但没有可表达的关闭通道：用区间下界（thinking 的最低预算）如实降档。
          if (!budgetChannel) {
            next.effortSkipped = 'protocol_has_no_budget_channel';
            return next;
          }
          if (!Array.isArray(budgetRange)) {
            next.effortSkipped = 'no_budget_range';
            return next;
          }
          next.budgetTokens = budgetRange[0];
          next.reasoningEffort = 'none';
          return next;
        }
        if (preference == null) {
          // 没有偏好：保持既有任务成本默认（allowance 通道），行为不变；
          // 协议没有预算字段时不谎报档位已生效。
          if (!budgetChannel) {
            next.effortSkipped = 'protocol_has_no_budget_channel';
            return next;
          }
          next.budgetTokens = current.thinkingBudget ?? current.allowance;
          next.reasoningEffort = level;
          return next;
        }
        if (!budgetChannel) {
          next.effortSkipped = 'protocol_has_no_budget_channel';
          return next;
        }
        if (!Array.isArray(budgetRange)) {
          next.effortSkipped = 'no_budget_range';
          return next;
        }
        const mapped = thinkingBudgetForLevel(level, budgetRange);
        if (mapped == null) {
          next.effortSkipped = 'level_not_mappable';
          return next;
        }
        // 区间夹紧；anthropic 要求 budget_tokens < max_tokens，超出的映射如实降为可发送上限，
        // 连区间下界都放不下时跳过（不发会被 400 的参数）。
        let tokens = Math.min(Math.max(mapped, budgetRange[0]), budgetRange[1]);
        if (adapterApi === 'anthropic-messages') {
          tokens = Math.min(tokens, Math.max(1, (attemptBudget?.effective ?? current.effective) - 1));
          if (tokens < budgetRange[0]) {
            next.effortSkipped = 'budget_exceeds_output_limit';
            return next;
          }
        }
        next.budgetTokens = tokens;
        next.reasoningEffort = level;
        return next;
      }

      // 没有旋钮、也没有声明：fail-closed，不发送任何厂商私有字段。
      next.effortSkipped = 'no_effort_control';
      return next;
    };

    /** 观测事件里的档位事实：实际发送的档位（或 null）与跳过原因。 */
    const effortFields = plan => ({
      reasoningEffort: plan.reasoningEffort ?? null,
      ...(plan.effortSkipped ? { effortSkipped: plan.effortSkipped } : {}),
    });
    const syncObservationPlan = plan => {
      observation.thinkingMode = plan.disabled ? 'disabled' : (plan.mode ?? null);
      observation.thinkingBudget = plan.budgetTokens ?? null;
    };

    const firstAttemptBudget = budgetForAttempt(budget, 1);
    const plan = thinkingPlan(disableArmed, budget, firstAttemptBudget);

    // 结构化优先（design §3）：只有协议真能表达该形态才携带原生约束；json_schema 但没有具体
    // schema 时降级为真实可用的 json_object（anthropic 无此形态则如实退回文本抽取）。
    const structuredForm = budget.structured === 'json' ? nativeStructuredForm(capability) : null;
    const expressibleForms = {
      'openai-completions': ['json_schema', 'json_object'],
      'openai-responses': ['json_schema', 'json_object'],
      'anthropic-messages': ['tool_force'],
      'google-generative-ai': ['json_schema', 'json_object'],
    }[adapterApi] || [];
    const nativeStructured = !structuredForm || !expressibleForms.includes(structuredForm) ? null
      : structuredForm === 'tool_force' ? (options.jsonSchema ? 'tool_force' : null)
        : structuredForm === 'json_schema' && !options.jsonSchema ? 'json_object'
          : structuredForm;
    const structuredMeans = budget.structured === 'json'
      ? (nativeStructured ? 'native' : 'text_extraction') : null;
    // 可选流式只对 openai-completions 生效；其它协议显式传 stream 也保持非流式（契约 Scenario 4）。
    // 观测与结果都按「这次调用是否真的走了 SSE」如实标注，不把选项当成已发生的事实。
    const streamRequested = adapterApi === 'openai-completions'
      && (options.stream === true || options.streamRequired === true);

    const observation = {
      // 归属语义由 sessionTrace.recordModel 决定：缺省（undefined）回退到当前追踪上下文，
      // 显式 null/'' 表示"无归属"（后台打标/回填），不写进任何聊天记录。这里原样透传。
      sessionId: options.sessionId,
      model: endpoint.model,
      api: adapterApi,
      source: endpoint.source || null,
      providerId: endpoint.providerId || null,
      taskId: budget.taskId,
      timeoutMs,
      temperature,
      thinkingMode: plan.disabled ? 'disabled' : (plan.mode ?? null),
      thinkingBudget: plan.budgetTokens ?? null,
      toolChoice: options.toolChoice ?? null,
      structuredMeans,
      overrideSources: budget.overrideSources,
      capabilitySource: capability.source,
      // 流式事实：start 时 ttftMs 尚不可知（null）；attempt/end/error 在首个正文 delta 后回填。
      // 非流式调用 streamed=false、ttftMs 恒为 null，消费方不得把 null 当作 0。
      streamed: streamRequested,
      ttftMs: null,
      toolNames: Array.isArray(tools)
        ? tools.map(tool => String(tool?.function?.name || tool?.tool?.name || '')).filter(Boolean)
        : [],
    };
    const startedAt = Date.now();
    const callSignal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let streamAttempt = 0;

    const budgetSnapshot = attemptBudget => ({
      requested: budget.requested, effective: attemptBudget.effective, allowance: attemptBudget.allowance,
      reservedTokens: attemptBudget.effective, taskId: budget.taskId, overrideSources: budget.overrideSources,
    });

    /**
     * 单次尝试：预留预算 → fetch → 解析。
     * 每个**实际发出的请求**都先写一条 attempt 事件（成功/失败/取消都算），再释放日内预留；
     * 账本据 attemptId 幂等落账（审查修复：失败与探测调用不再漏账）。
     */
    const attempt = async (request, attemptBudget, attemptNumber, armed, escalatedFromValue, attemptPlan) => {
      const attemptId = randomUUID();
      let reservation = null;
      if (options.budget && typeof options.budget.reserve === 'function') {
        // 预算在真正 fetch 之前结算：超预算则先拒绝，绝不先发请求再判断。
        reservation = options.budget.reserve({ messages, tools, maxTokens: attemptBudget.effective });
      }
      // 日内上限守卫：同样在 fetch 之前判断（超限 = 显式拒绝，不是供应方错误）。
      let guardRelease = null;
      if (budgetGuard) {
        const verdict = budgetGuard({ taskId: budget.taskId, sessionId: options.sessionId ?? null,
          tokens: attemptBudget.effective, attemptId, api: adapterApi,
          providerId: endpoint.providerId ?? null, model: endpoint.model, attempt: attemptNumber });
        if (verdict?.ok === false) {
          const error = new Error('LLM daily token budget exhausted');
          error.code = 'LLM_BUDGET_EXHAUSTED';
          error.taskId = budget.taskId;
          error.cap = verdict.cap ?? null;
          error.used = verdict.used ?? null;
          error.budget = budgetSnapshot(attemptBudget);
          throw error;
        }
        guardRelease = typeof verdict?.release === 'function' ? verdict.release : null;
      }
      const attemptStartedAt = Date.now();
      const emitAttempt = payload => observe({ phase: 'attempt', ...observation,
        ...effortFields(attemptPlan ?? plan),
        attemptId, attempt: attemptNumber, escalatedFrom: escalatedFromValue ?? null,
        budget: budgetSnapshot(attemptBudget), durationMs: Date.now() - attemptStartedAt, ...payload });
      try {
        callSignal.throwIfAborted();
        if (streamRequested) {
          streamAttempt++;
          observation.ttftMs = null;
          options.onStreamReset?.({ attempt: streamAttempt });
        }
        const attemptResult = await fetchAndParse(request, attemptBudget, reservation);
        const outcome = classifyOutcome({ result: attemptResult.result, structured: budget.structured });
        emitAttempt({ outcome, truncated: outcome === 'truncated',
          finishReason: attemptResult.result.finishReason ?? null, usage: attemptResult.result.usage ?? null,
          reasoningTokens: attemptResult.result.reasoningTokens ?? null,
          outputTokens: normalizedOutputTokens(adapterApi, attemptResult.result) });
        return attemptResult;
      } catch (error) {
        // 超时（本次计时器、包装层单次上限或回合截止）与调用方取消分开记账。
        const reason = options.signal?.aborted ? options.signal.reason : callSignal.aborted ? callSignal.reason : null;
        const timedOut = [error, reason].some(item => item?.name === 'TimeoutError'
          || ['LLM_TIMEOUT', 'AGENT_TIMEOUT'].includes(item?.code));
        const cancelled = !timedOut && (error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
          || options.signal?.aborted === true);
        emitAttempt({ outcome: timedOut ? 'timeout' : cancelled ? 'cancelled' : 'provider_error', truncated: false,
          finishReason: null, usage: null, reasoningTokens: null, outputTokens: null,
          errorCode: error?.code || null, status: error?.status ?? null });
        throw error;
      } finally {
        guardRelease?.();
      }
    };

    const fetchAndParse = async (request, attemptBudget, reservation) => {
      // ttftMs 的零点：fetch 真正发出的时刻（不是 chat 入口，也不是第一次 read）。
      const fetchStartedAt = Date.now();
      // 每次尝试独立计首字时间：升级/降档重试后不允许沿用上一次尝试的数字。
      if (streamRequested) observation.ttftMs = null;
      let response;
      try {
        response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: callSignal,
        });
      } catch (error) {
        // 传输失败/结果不确定：保留预留，不能当成零费用。
        reservation?.settle(null);
        if (options.signal?.aborted) throw error;
        const failure = new Error('LLM transport failed');
        failure.code = 'LLM_API_ERROR';
        failure.transportFailure = true;
        throw failure;
      }

      if (!response.ok) {
        reservation?.settle(null);
        const detail = await response.text().catch(() => '');
        // 供应商错误正文可能回显请求内容或端点细节：只作为内部属性保留，
        // 不放进 message（message 会进入日志/设置页/失败原因等可见面）。
        const error = new Error(`LLM API request failed (status ${response.status})`);
        error.code = 'LLM_API_ERROR';
        error.status = response.status;
        error.detail = String(detail).slice(0, 300);
        throw error;
      }

      let payload;
      let streamedResult = null;
      if (streamRequested) {
        // SSE 路径：读取失败与 response.json() 失败走同一条错误通道。
        // 预留保持（settle(null)）：已消费的思考/token 绝不按零成本结算。
        try {
          streamedResult = await readOpenaiCompletionsStream(response, {
            startedAt: fetchStartedAt,
            onFirstContent: ttftMs => { observation.ttftMs = ttftMs; },
            onTextDelta: text => { if (!callSignal.aborted) options.onTextDelta?.({ text, attempt: streamAttempt }); },
            signal: callSignal,
            strict: options.streamRequired === true,
          });
          payload = streamedResult.payload;
        } catch (error) {
          reservation?.settle(null);
          if (options.signal?.aborted) throw error;
          if (error?.code) throw error;
          const failure = new Error('LLM API stream is not readable');
          failure.code = 'LLM_API_ERROR';
          failure.transportFailure = true;
          throw failure;
        }
      } else {
        try {
          payload = await response.json();
        } catch (error) {
          reservation?.settle(null);
          if (options.signal?.aborted) throw error;
          const failure = new Error('LLM API response is not valid JSON');
          failure.code = error instanceof SyntaxError ? 'LLM_INVALID_RESPONSE' : 'LLM_API_ERROR';
          if (!(error instanceof SyntaxError)) failure.transportFailure = true;
          throw failure;
        }
      }

      let parsed;
      try {
        parsed = adapter.parse(payload);
      } catch (error) {
        reservation?.settle(null);
        if (options.signal?.aborted) throw error;
        if (error?.code) throw error;
        const failure = new Error('LLM API response is not valid JSON');
        failure.code = 'LLM_INVALID_RESPONSE';
        throw failure;
      }
      reservation?.settle(parsed.usage);
      // 流式事实只在真的走了 SSE 时公开；非流式不设这两个字段（调用方以 !== true 判断）。
      if (streamRequested) {
        parsed.streamed = true;
        parsed.ttftMs = streamedResult?.ttftMs ?? null;
      }
      // anthropic 强制工具：把 structured_output 工具调用还原为正文 JSON。
      if (nativeStructured === 'tool_force' && Array.isArray(parsed.message?.tool_calls)) {
        const calls = parsed.message.tool_calls;
        const name = options.jsonSchemaName || 'structured_output';
        if (calls.length === 1 && calls[0]?.function?.name === name) {
          parsed = { ...parsed, message: { ...parsed.message,
            content: String(calls[0].function.arguments || '{}'), tool_calls: null } };
        }
      }
      return { request, result: parsed };
    };

    const finalize = (result, { outcome, attemptNumber, escalatedFrom, attemptBudget }) => {
      result.outcome = outcome;
      result.truncated = outcome === 'truncated';
      result.attempt = attemptNumber;
      result.escalatedFrom = escalatedFrom;
      result.budget = { requested: budget.requested, effective: attemptBudget.effective,
        allowance: attemptBudget.allowance, taskId: budget.taskId, overrideSources: budget.overrideSources };
      result.structuredMeans = structuredMeans;
      return result;
    };

    const buildRequest = (attemptBudget, armed, effortOverride = null) => {
      // 每次实际尝试都重新组装思考计划与请求体（降档重试绝不能复用旧 request）。
      const thinking = thinkingPlan(Boolean(armed), budget, attemptBudget, effortOverride);
      const request = adapter.build({
        endpoint,
        messages,
        tools: tools && tools.length ? openaiToolsDefinition(tools) : null,
        options: { ...options, maxTokens: attemptBudget.effective, temperature, capability,
          thinking, nativeStructured },
      });
      // 结构校验沿用本分支的新防线：任何协议组装完都先验一遍再发。
      validateRequestBody(adapterApi, request.body);
      return { request, plan: thinking };
    };

    /** 降档重试的输出额度上限：不高于首次尝试（不因 reasoning_only 放大额度）。 */
    const capDowngradeBudget = (frame, cap) => {
      if (!frame || cap == null) return frame;
      const effective = Math.min(frame.effective, cap);
      return { ...frame, effective, allowance: Math.max(0, effective - budget.requested) };
    };

    let escalatedFrom = null;
    let firstEffective = null;
    let downgradeQuota = null;
    let effortOverride = null;
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      let attemptBudget = budgetForAttempt(budget, attemptNumber);
      if (!attemptBudget) break;
      attemptBudget = capDowngradeBudget(attemptBudget, downgradeQuota);
      let built = buildRequest(attemptBudget, disableArmed, effortOverride);
      let attemptPlan = built.plan;
      syncObservationPlan(attemptPlan);
      if (attemptNumber === 1) {
        firstEffective = attemptBudget.effective;
        observe({ phase: 'start', ...observation, ...effortFields(attemptPlan),
          maxTokens: attemptBudget.effective,
          budget: { requested: budget.requested, effective: attemptBudget.effective, allowance: attemptBudget.allowance },
          body: built.request.body });
      }
      let attemptResult;
      for (;;) {
        try {
          attemptResult = await attempt(built.request, attemptBudget, attemptNumber, disableArmed, escalatedFrom, attemptPlan);
          break;
        } catch (error) {
          if ((disableArmed || preferenceDisables) && isParameterRejection(error)) {
            // 网关拒绝关闭参数：记负缓存（以后不再发送），移除参数、恢复思考余量后同额度重跑一次。
            reportCapabilityFact({ providerId: endpoint.providerId, model: endpoint.model,
              api: adapterApi, source: 'observed', thinking: { canDisable: false } });
            disableArmed = false;
            preferenceDisables = false;
            budget = resolveBudget(undefined);
            attemptBudget = capDowngradeBudget(budgetForAttempt(budget, attemptNumber), downgradeQuota);
            built = buildRequest(attemptBudget, false, effortOverride);
            attemptPlan = built.plan;
            syncObservationPlan(attemptPlan);
            continue;
          }
          // 供应方错误与取消不升级（design §3）：原样上抛。
          observe({ phase: 'error', ...observation, ...effortFields(attemptPlan),
            durationMs: Date.now() - startedAt,
            attempt: attemptNumber, errorCode: error?.code || null, status: error?.status ?? null,
            providerDetail: redactProviderDetail(error?.detail) });
          throw error;
        }
      }
      if (disableArmed) {
        // 尝试结果即观测：没有思考证据 = 关闭被接受；仍在思考 = 参数被无视，同样记不可关。
        const reasoningText = attemptResult.result?.reasoning;
        const reasoningTokens = Number(attemptResult.result?.reasoningTokens);
        const sawReasoning = (typeof reasoningText === 'string' && reasoningText.trim().length > 0)
          || (Number.isInteger(reasoningTokens) && reasoningTokens > 0);
        reportCapabilityFact({ providerId: endpoint.providerId, model: endpoint.model,
          api: adapterApi, source: 'observed', thinking: { canDisable: !sawReasoning } });
        disableArmed = false;
        if (sawReasoning) {
          // 关闭被无视：恢复保守额度，升级阶梯按含思考余量的基数计算（不再静默扣余量）。
          budget = resolveBudget(undefined);
          observation.thinkingMode = null;
          observation.thinkingBudget = null;
        }
      }
      const { result } = attemptResult;
      const outcome = classifyOutcome({ result, structured: budget.structured });

      const nextBudget = budgetForAttempt(budget, attemptNumber + 1);
      const recoverable = RECOVERABLE_OUTCOMES.has(outcome);
      // 截断但工具调用完整可用：下游能 fail-closed 地继续，不当作不可用丢弃。
      const terminalOutcome = recoverable && outcome === 'truncated' && usableToolCalls(result) ? false : recoverable;
      if (!terminalOutcome || !nextBudget) {
        if (terminalOutcome && budget.onExhausted === 'typed_failure') {
          const error = new Error(`LLM response is not usable after ${attemptNumber} attempt(s)`);
          error.code = EXHAUSTED_CODES[outcome];
          error.outcome = outcome;
          error.attempt = attemptNumber;
          error.finishReason = result.finishReason ?? null;
          error.usage = result.usage ?? null;
          error.reasoningTokens = result.reasoningTokens ?? null;
          error.budget = { requested: budget.requested, effective: attemptBudget.effective,
            allowance: attemptBudget.allowance, taskId: budget.taskId, overrideSources: budget.overrideSources };
          error.structuredMeans = structuredMeans;
          error.result = result;
          observe({ phase: 'error', ...observation, ...effortFields(attemptPlan),
            durationMs: Date.now() - startedAt,
            attempt: attemptNumber, errorCode: error.code, status: null, outcome, finishReason: result.finishReason ?? null });
          throw error;
        }
        finalize(result, { outcome, attemptNumber, escalatedFrom, attemptBudget });
        observe({ phase: 'end', ...observation, ...effortFields(attemptPlan),
          durationMs: Date.now() - startedAt,
          attempt: attemptNumber, escalatedFrom, outcome,
          budget: { requested: budget.requested, effective: attemptBudget.effective, allowance: attemptBudget.allowance },
          finishReason: result.finishReason ?? null, usage: result.usage ?? null,
          reasoning: result.reasoning ?? null, reasoningTokens: result.reasoningTokens ?? null,
          text: result.message.content, toolCalls: result.message.tool_calls ?? null });
        return result;
      }
      // 只有思考：优先降一档思考并保持额度；没有可发送档位能力时维持既有升级阶梯。
      // truncated / invalid_json 不改变思考档位，照旧升级。
      const downgrade = outcome === 'reasoning_only'
        ? lowerThinkingEffort({ knob: effortKnob, declaredEfforts, budgetRange, budgetChannel, plan: attemptPlan })
        : null;
      if (downgrade) {
        effortOverride = downgrade;
        downgradeQuota = firstEffective;
        escalatedFrom = null;
      } else {
        escalatedFrom = attemptBudget.effective;
      }
    }
    // 阶梯耗尽仍未产出：正常不可达（attempts 首项恒为 1）；兜底为供应方错误。
    const error = new Error('LLM transport exhausted its attempt ladder');
    error.code = 'LLM_API_ERROR';
    throw error;
  }

  const chat = createFailoverChat({ chat: chatOnce, resolveEndpoint, resolveFallbacks,
    resolveTimeout: options => resolveTaskBudget({ taskId: options.taskId }).timeoutMs ?? TIMEOUT_MS,
    resolveAttemptTimeout: options => resolveTaskBudget({ taskId: options.taskId }).attemptTimeoutMs });

  async function askText(prompt, options = {}) {
    const result = await chat([{ role: 'user', content: String(prompt || '') }], null, options);
    return typeof result.message.content === 'string' ? result.message.content : '';
  }

  async function ask(prompt, options = {}) {
    return extractJson(await askText(prompt, options));
  }

  return Object.freeze({ chat, askText, ask });
}

const defaultLlm = createLlm();
export const chat = defaultLlm.chat;
export const askText = defaultLlm.askText;
export const ask = defaultLlm.ask;

/**
 * 探测专用裸请求（server/llmProbe.js 使用）：走同一套协议适配器与鉴权，
 * 但允许按协议对请求体打补丁（思考/结构化候选参数），也不做任务级升级阶梯。
 * 与正常调用同一纪律（审查修复）：每个实际请求在 fetch 之前经过日内预算守卫，
 * 结束后写一条 attempt 事件（成败都算，账本据 attemptId 幂等），探测调用不再漏账。
 * 返回 { ok, status, code, detail, result }；ok=false 且 status=null 表示传输层失败。
 * detail 截断自错误报文，只用于判断“参数被拒”，调用方不得回显给用户。
 */
export async function rawChatAttempt({
  endpoint,
  messages = [{ role: 'user', content: '只回复两个字：正常' }],
  tools = null,
  maxTokens = 2048,
  temperature = 0,
  patch = null,
  timeoutMs = 20_000,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  signal = null,
  taskId = 'capability_probe',
  sessionId = null,
  taskType = 'capability_probe',
  traceTaskId = `${endpoint?.providerId || 'provider'}:${endpoint?.model || 'model'}`,
  probeKind = null,
  attempt: attemptNumber = 1,
  budget: budgetMeta = null,
} = {}) {
  if (!endpoint?.baseUrl || !endpoint?.model) throw new TypeError('rawChatAttempt requires an endpoint');
  const adapterApi = Object.hasOwn(ADAPTERS, endpoint.api) ? endpoint.api : 'openai-completions';
  const adapter = ADAPTERS[adapterApi];
  const request = adapter.build({
    endpoint, messages: conformMessages(messages), tools,
    // 裸请求不携带任何厂商私有字段：补丁由探测按协议显式给出。
    options: { maxTokens, temperature, capability: { thinking: { canDisable: null } } },
  });
  if (typeof patch === 'function') patch(request.body, { api: adapterApi });
  validateRequestBody(adapterApi, request.body);

  const attemptId = randomUUID();
  let guardRelease = null;
  if (budgetGuard) {
    const verdict = budgetGuard({ taskId, sessionId, tokens: maxTokens, attemptId, api: adapterApi,
      providerId: endpoint.providerId ?? null, model: endpoint.model, attempt: attemptNumber });
    if (verdict?.ok === false) {
      return { ok: false, status: null, code: 'LLM_BUDGET_EXHAUSTED', detail: 'budget exhausted', result: null };
    }
    guardRelease = typeof verdict?.release === 'function' ? verdict.release : null;
  }
  const startedAt = Date.now();
  const budgetSnapshot = {
    requested: Number(budgetMeta?.requested ?? maxTokens), effective: Number(budgetMeta?.effective ?? maxTokens),
    allowance: Number(budgetMeta?.allowance ?? 0), reservedTokens: maxTokens,
    taskId, overrideSources: budgetMeta?.overrideSources || [],
  };
  const emit = payload => notifyObserver({ phase: 'attempt', sessionId, taskType, traceTaskId,
    model: endpoint.model, api: adapterApi, source: endpoint.source ?? null,
    providerId: endpoint.providerId ?? null, taskId, probeKind, attemptId, attempt: attemptNumber,
    escalatedFrom: budgetMeta?.escalatedFrom ?? null, budget: budgetSnapshot,
    durationMs: Date.now() - startedAt, ...payload });
  const timeoutSignal = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 20_000));
  try {
    let response;
    try {
      response = await fetchImpl(request.url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch {
      const cancelled = signal?.aborted === true;
      emit({ outcome: cancelled ? 'cancelled' : 'provider_error', usage: null, reasoningTokens: null,
        outputTokens: null, finishReason: null, errorCode: 'LLM_API_ERROR', status: null });
      return { ok: false, status: null, code: cancelled ? 'CANCELLED' : 'LLM_API_ERROR',
        detail: 'transport failed', result: null };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      emit({ outcome: 'provider_error', usage: null, reasoningTokens: null, outputTokens: null,
        finishReason: null, errorCode: 'LLM_API_ERROR', status: response.status });
      return { ok: false, status: response.status, code: 'LLM_API_ERROR',
        detail: String(detail).slice(0, 300), result: null };
    }
    try {
      const payload = await response.json();
      const result = adapter.parse(payload);
      emit({ outcome: 'ok', usage: result.usage ?? null, reasoningTokens: result.reasoningTokens ?? null,
        outputTokens: normalizedOutputTokens(adapterApi, result), finishReason: result.finishReason ?? null });
      return { ok: true, status: response.status, code: null, detail: null, result };
    } catch {
      emit({ outcome: 'provider_error', usage: null, reasoningTokens: null, outputTokens: null,
        finishReason: null, errorCode: 'LLM_INVALID_RESPONSE', status: response.status });
      return { ok: false, status: response.status, code: 'LLM_INVALID_RESPONSE', detail: 'invalid response', result: null };
    }
  } finally {
    guardRelease?.();
  }
}
