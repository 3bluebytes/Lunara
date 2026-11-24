// contextUsage.js — 每轮交给模型的上下文构成统计（add-context-usage-observation）。
//
// 只读：输入是 AgentLoop 即将发送的消息数组与工具定义，输出一份只含数值和小节标题的统计，
// 由 VirtualPersonRuntime 写进会话 trace（`context_usage`）。不改变请求，不含记忆正文。
// token 是启发式估算（heuristic-v1）：中日韩字符每字约 0.7 token，其余按每 4 字节 1 token；
// 同一执行身份下的 model_response.usage.prompt_tokens 是供应商的真实数，用来校准。
//
// Python 伪代码：
//   sections = split(system, "## ") + split(本轮背景块, "## ")   # 背景块在最后一条 user 消息里
//   repeated = lines that appear in >= 2 sections (去掉列表符与 [来源] 前缀后比较)
//   total = system + history + tools + output_reserve

import { turnContextOf } from './contextBlocks.js';
import { resolveTaskBudget } from '../llmTasks.js';

const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/gu;
const CJK_TOKENS_PER_CHAR = 0.7;
const OTHER_BYTES_PER_TOKEN = 4;
const MIN_REPEATED_CHARS = 8;
const LEAD_TITLE = '(开头)';

export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  if (!value) return 0;
  const cjk = value.match(CJK)?.length || 0;
  const otherBytes = Buffer.byteLength(value.replace(CJK, ''));
  return Math.ceil(cjk * CJK_TOKENS_PER_CHAR + otherBytes / OTHER_BYTES_PER_TOKEN);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content);
}

function measure(text) {
  return { bytes: Buffer.byteLength(text), tokens: estimateTokens(text) };
}

/** 按行首 `## 标题` 拆系统提示；第一个标题之前的内容记为「(开头)」。 */
export function splitPromptSections(systemPrompt) {
  const sections = [];
  let title = LEAD_TITLE;
  let lines = [];
  const flush = () => {
    const body = lines.join('\n').trim();
    if (body || title !== LEAD_TITLE) sections.push({ title, body });
  };
  for (const line of String(systemPrompt || '').split('\n')) {
    const heading = /^## (.+)$/u.exec(line);
    if (heading) {
      flush();
      title = heading[1].trim();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections.map(({ title: name, body }) => ({ title: name, ...measure(body), body }));
}

// 不同小节给同一条记忆加的前缀不同（`- [memoryId=…]` 与 `- [source, memoryId=…]`），比较正文。
function normalizedLine(line) {
  return line.trim().replace(/^[-*]\s+/u, '').replace(/^\[[^\]]*\]\s*/u, '').trim();
}

function repeatedAcross(sections) {
  const owners = new Map();
  const idOwners = new Map();
  for (const section of sections) {
    for (const line of new Set(section.body.split('\n').map(normalizedLine))) {
      if ([...line].length < MIN_REPEATED_CHARS) continue;
      if (!owners.has(line)) owners.set(line, new Set());
      owners.get(line).add(section.title);
    }
    // 只认每条记忆自己的 id；整理目录的「来源 memoryId=a,b」是引用，不是重复注入。
    for (const match of section.body.matchAll(/(?<!来源 )memoryId=(\d+)/gu)) {
      if (!idOwners.has(match[1])) idOwners.set(match[1], new Set());
      idOwners.get(match[1]).add(section.title);
    }
  }
  const titles = new Set();
  let lines = 0;
  let bytes = 0;
  for (const [line, where] of owners) {
    if (where.size < 2) continue;
    lines += 1;
    bytes += Buffer.byteLength(line) * (where.size - 1);
    where.forEach(title => titles.add(title));
  }
  const memoryIds = [...idOwners.values()].filter(where => where.size > 1).length;
  return { lines, bytes, memoryIds, sections: sections.map(item => item.title).filter(title => titles.has(title)) };
}

/**
 * messages：即将发送的完整消息数组（第一条 system 是系统提示）；tools：工具定义；
 * outputReserveTokens：本次调用为输出预留的 token（来自任务预算）。
 */
export function measureContextUsage({ messages = [], tools = null, outputReserveTokens = null } = {}) {
  const list = (Array.isArray(messages) ? messages : []).filter(Boolean);
  const systemText = list.filter(message => message.role === 'system').map(message => textOf(message.content)).join('\n\n');
  const history = list.filter(message => message.role !== 'system');
  const historyText = history.map(message => textOf(message.content)
    + (Array.isArray(message.tool_calls) && message.tool_calls.length ? JSON.stringify(message.tool_calls) : '')).join('\n');
  const toolList = Array.isArray(tools) ? tools : [];
  // 每轮都变的小节在消息通道的「本轮背景」块里（contextBlocks.js）；它的字节已算在 history 里，这里只按小节拆开看。
  const turnContextText = turnContextOf(history);
  const sections = [...splitPromptSections(systemText), ...splitPromptSections(turnContextText)];
  const system = measure(systemText);
  const historyUsage = { messages: history.length, ...measure(historyText) };
  const toolUsage = { count: toolList.length, ...measure(toolList.length ? JSON.stringify(toolList) : '') };
  const reserve = Number.isFinite(outputReserveTokens) ? outputReserveTokens : 0;
  return {
    method: 'heuristic-v1',
    system,
    sections: sections.map(({ title, bytes, tokens }) => ({ title, bytes, tokens })),
    history: historyUsage,
    turnContext: measure(turnContextText),
    tools: toolUsage,
    outputReserveTokens: Number.isFinite(outputReserveTokens) ? outputReserveTokens : null,
    totalTokens: system.tokens + historyUsage.tokens + toolUsage.tokens + reserve,
    repeated: repeatedAcross(sections),
  };
}

/**
 * 每次调用模型前把上下文构成写进会话 trace（add-context-usage-observation）：只有数值与小节标题。
 * 输出预留按任务规格估（不含模型能力上限的收紧）；真实 prompt_tokens 见同一执行身份的 model_response。
 */
export function contextUsageRecorder(trace, traceContext) {
  if (!trace?.record) return null;
  return ({ round, recovery, taskId, messages, tools }) => {
    let outputReserveTokens = null;
    try { outputReserveTokens = resolveTaskBudget({ taskId }).effective; } catch { /* 未知任务不估预留 */ }
    trace.record(traceContext, { type: 'context_usage', round, recovery, taskId,
      ...measureContextUsage({ messages, tools, outputReserveTokens }) });
  };
}
