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

function mustPreserve(message) {
  const state = message?.contextState || message?.metadata?.contextState || {};
  return message?.preserveInContext === true
    || state.unresolvedQuestion === true
    || state.commitment === true
    || state.validReferent === true;
}

function groupMustPreserve(group, index, groups) {
  if (group.some(mustPreserve)) return true;
  // The active user request and its immediately preceding visible exchange are
  // never candidates for eviction, even when no semantic marker was supplied.
  return index >= Math.max(0, groups.length - 3);
}

function compactToolContent(message, maxToolResultBytes) {
  if (!isToolResult(message) || byteSize(message.content) <= maxToolResultBytes) return message;
  const text = String(message.content || '');
  return {
    ...message,
    content: `[Earlier tool result compacted; ${byteSize(text)} bytes]\n${text.slice(0, Math.max(80, maxToolResultBytes - 100))}`,
  };
}

export class ContextBudgeter {
  constructor({ maxBytes = 48_000, maxMessages = 24, maxToolResultBytes = 4000, summarize = null } = {}) {
    this.maxBytes = Math.max(2000, Number(maxBytes) || 48_000);
    this.maxMessages = Math.max(4, Number(maxMessages) || 24);
    this.maxToolResultBytes = Math.max(256, Number(maxToolResultBytes) || 4000);
    this.summarize = typeof summarize === 'function' ? summarize : null;
  }

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

    const groups = groupsFrom(messages);
    const protectedIndices = new Set(groups
      .map((group, index) => groupMustPreserve(group, index, groups) ? index : -1)
      .filter(index => index >= 0));
    const selected = new Set(protectedIndices);
    for (let index = groups.length - 1; index >= 0; index--) {
      if (selected.has(index)) continue;
      const candidate = [...selected, index].sort((a, b) => a - b).flatMap(i => groups[i]);
      if (candidate.length > effectiveMaxMessages || byteSize(candidate) > effectiveMaxBytes) continue;
      selected.add(index);
    }
    let keptGroups = [...selected].sort((a, b) => a - b).map(index => ({ index, group: groups[index] }));
    let kept = keptGroups.flatMap(entry => entry.group);
    const removedGroups = groups.filter((_group, index) => !selected.has(index));
    const removed = removedGroups.flat();
    const removedCount = removed.length;
    if (removedCount <= 0) return kept;
    const summarySource = removed.filter(message => message.role === 'user'
      || (message.role === 'assistant' && !message.tool_calls?.length));
    let summary = '';
    if (this.summarize) {
      try { summary = String(await this.summarize(summarySource) || '').trim(); } catch { summary = ''; }
    }
    if (!summary) {
      summary = summarySource
        .slice(-6)
        .map(message => `${message.role}: ${String(message.content || '').slice(0, 300)}`)
        .join('\n');
    }
    let summaryMessage = summary
      ? { role: 'system', content: `[较早对话摘要，来源 ${removedCount} 条已提交消息]\n${summary.slice(0, aggressive ? 1800 : 4000)}` }
      : null;
    let compacted = summaryMessage ? [summaryMessage, ...kept] : kept;
    // Evict complete, non-protected groups only. Never splice individual tool
    // messages, which could create an orphaned call/result pair.
    while (keptGroups.length > 1 && byteSize(compacted) > effectiveMaxBytes) {
      const removable = keptGroups.findIndex(entry => !protectedIndices.has(entry.index));
      if (removable < 0) break;
      keptGroups.splice(removable, 1);
      kept = keptGroups.flatMap(entry => entry.group);
      compacted = summaryMessage ? [summaryMessage, ...kept] : kept;
    }
    if (summaryMessage && byteSize(compacted) > effectiveMaxBytes) {
      const allowance = Math.max(160, effectiveMaxBytes - byteSize(kept) - 100);
      summaryMessage = { ...summaryMessage, content: summaryMessage.content.slice(0, allowance) };
      compacted = [summaryMessage, ...kept];
    }
    if (summaryMessage && typeof onSummary === 'function') {
      await onSummary({
        content: summaryMessage.content,
        removedCount,
        removedIndexes: removed.map(message => messages.indexOf(message)).filter(index => index >= 0),
        method: this.summarize ? 'provider-or-deterministic-fallback' : 'deterministic-fallback',
      });
    }
    return compacted;
  }
}

export { groupsFrom };
