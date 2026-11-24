import { isSummaryMessage, summaryBody, summaryMessage } from './contextBlocks.js';

function byteSize(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
}

function cloneMessages(messages) {
  return structuredClone(Array.isArray(messages) ? messages : []);
}

function isToolResult(message) {
  return message?.role === 'tool' && Boolean(message.tool_call_id);
}

function hasToolCalls(message) {
  return message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function groupsFrom(messages) {
  const groups = [];
  for (let index = 0; index < messages.length; index++) {
    const current = messages[index];
    if (hasToolCalls(current)) {
      const ids = new Set(current.tool_calls.map(call => String(call.id || '')));
      const group = [current];
      while (index + 1 < messages.length && isToolResult(messages[index + 1])
          && ids.has(String(messages[index + 1].tool_call_id || ''))) {
        group.push(messages[++index]);
      }
      groups.push(group);
    } else {
      groups.push([current]);
    }
  }
  return groups;
}

function compactToolContent(message, maxToolResultBytes) {
  if (!isToolResult(message) || byteSize(message.content) <= maxToolResultBytes) return message;
  const text = String(message.content || '');
  return {
    ...message,
    content: `[Earlier tool result compacted; ${byteSize(text)} bytes]\n${text.slice(0, Math.max(80, maxToolResultBytes - 100))}`,
  };
}

// 超过上限后裁到上限的这个比例：一次裁掉一大段，之后很多轮都不用再裁，历史前缀在这期间逐字节不变。
const LOW_WATER = 0.5;
const MIN_KEPT_GROUPS = 3;

function fallbackSummary(head, removed, maxChars) {
  const lines = removed
    .filter(message => message.role === 'user' || (message.role === 'assistant' && !message.tool_calls?.length))
    .slice(-6)
    .map(message => `${message.role}: ${String(message.content || '').slice(0, 300)}`);
  const text = [summaryBody(head), ...lines].filter(Boolean).join('\n');
  return summaryMessage(text.length > maxChars ? text.slice(-maxChars) : text)
    || summaryMessage(`更早的 ${removed.length} 条消息已不在上下文里。`);
}

/**
 * 模型历史的预算（参考 s08 的分层压缩：便宜的先做，贵的后做）。
 * 1. 较早回合的工具结果截短（本回合的结果模型还要用，保持完整）；
 * 2. 没超上限就原样返回——历史只追加，前缀不变；
 * 3. 超了才裁：保留连续的一段结尾（不拆工具调用/结果，不留空洞，当前回合必留），裁到低水位；
 *    被裁掉的部分由 onSummary 并入较早对话摘要，摘要是历史的第一条消息。
 *
 * Python 伪代码：
 *   msgs = shrink_old_tool_results(msgs)
 *   if fits(msgs): return msgs
 *   kept = longest_suffix(groups(msgs), low_water)        # 至少含当前回合
 *   head = on_summary(removed) or fallback(removed)
 *   return [head] + kept
 */
export class ContextBudgeter {
  constructor({ maxBytes = 48_000, maxMessages = 24, maxToolResultBytes = 4000 } = {}) {
    this.maxBytes = Math.max(2000, Number(maxBytes) || 48_000);
    this.maxMessages = Math.max(4, Number(maxMessages) || 24);
    this.maxToolResultBytes = Math.max(256, Number(maxToolResultBytes) || 4000);
  }

  /**
   * onSummary({ removedCount, removedIndexes, keptFrom, method })：removedIndexes/keptFrom 是输入数组的下标。
   * 返回新的摘要消息（contextBlocks.summaryMessage）就用它做头；不返回时用确定性的兜底摘要。
   */
  async prepare(inputMessages, { aggressive = false, onSummary = null } = {}) {
    const effectiveMaxBytes = aggressive ? Math.max(2000, Math.floor(this.maxBytes * 0.55)) : this.maxBytes;
    const effectiveMaxMessages = aggressive ? Math.max(4, Math.floor(this.maxMessages * 0.6)) : this.maxMessages;
    const effectiveToolBytes = aggressive ? Math.max(256, Math.floor(this.maxToolResultBytes * 0.5)) : this.maxToolResultBytes;
    // 只压缩「较早」的工具结果：本回合（最后一条 user 之后）的结果是模型下一步要用的事实（如选歌 offer 的
    // offerId 与候选），截断会让它无法纠正地提交；aggressive 是 prompt 过长后的兜底，仍然全部压缩。
    const cloned = cloneMessages(inputMessages);
    const currentTurnStart = aggressive ? cloned.length : cloned.findLastIndex(message => message?.role === 'user');
    const messages = cloned.map((message, index) => (index > currentTurnStart
      ? message : compactToolContent(message, effectiveToolBytes)));
    if (messages.length <= effectiveMaxMessages && byteSize(messages) <= effectiveMaxBytes) return messages;

    const head = isSummaryMessage(messages[0]) ? messages[0] : null;
    const offset = head ? 1 : 0;
    const groups = groupsFrom(messages.slice(offset));
    const targetBytes = Math.floor(effectiveMaxBytes * LOW_WATER);
    const targetMessages = Math.max(MIN_KEPT_GROUPS, Math.floor(effectiveMaxMessages * LOW_WATER));
    // 当前回合（最后一条 user 起）和末尾几组无论多大都留。
    const lastUserGroup = groups.findLastIndex(group => group[0]?.role === 'user');
    const mustFrom = Math.max(0, Math.min(groups.length - MIN_KEPT_GROUPS, lastUserGroup < 0 ? groups.length : lastUserGroup));
    let start = groups.length;
    let count = offset;
    let bytes = head ? byteSize(head) : 0;
    for (let index = groups.length - 1; index >= 0; index--) {
      const size = byteSize(groups[index]);
      if (index < mustFrom && (count + groups[index].length > targetMessages || bytes + size > targetBytes)) break;
      start = index;
      count += groups[index].length;
      bytes += size;
    }
    // 保留段尽量从一条 user 消息开始：不把一次请求切成两半。
    while (start < mustFrom && groups[start][0]?.role !== 'user') start += 1;
    if (start <= 0) return messages;
    const removed = groups.slice(0, start).flat();
    const kept = groups.slice(start).flat();
    let nextHead = null;
    if (typeof onSummary === 'function') {
      nextHead = await onSummary({
        removedCount: removed.length,
        removedIndexes: removed.map((_message, index) => offset + index),
        keptFrom: offset + removed.length,
        method: 'budget-evicted-deterministic',
      });
    }
    if (!isSummaryMessage(nextHead)) nextHead = fallbackSummary(head, removed, aggressive ? 1800 : 4000);
    return [nextHead, ...kept];
  }
}

export { groupsFrom };
