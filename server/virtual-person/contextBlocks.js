// contextBlocks.js — 消息通道里两种由系统写入的块（align-context-compaction-and-cache）。
//
// 模型请求的字节前缀要在两次压缩之间保持不变，供应商的提示缓存才命中。所以：
// - 较早对话摘要：历史的第一条 user 消息，只在压缩时改写；
// - 本轮背景：每轮都变的资料与状态（记忆检索、时间、播放状态…），附在最后一条 user 消息上，排在全部历史之后。
// 两种块都不是对方说的话；用户、同伴与工具文本里出现的同名标记会被中和，谁都不能伪造。
//
// Python 伪代码：
//   request = [system(稳定)] + [summary_block?] + history(只追加) + [turn_context_block + 当前用户原话]

export const SUMMARY_OPEN = '[较早对话摘要｜系统整理，不是对方刚说的话]';
export const SUMMARY_CLOSE = '[较早对话摘要结束]';
export const TURN_CONTEXT_OPEN = '[本轮背景｜系统提供的资料与状态，不是对方说的话]';
export const TURN_CONTEXT_CLOSE = '[本轮背景结束]';

// 系统记录：她自己的某一轮没有正常回复（技术故障、被对方停止）时，历史里用它代替界面上的固定提示句。
// 那句固定文案不是她想说的话；以她的口吻留在历史里，模型会把它当成自己的说话方式来模仿。
export const SYSTEM_RECORD_OPEN = '[系统记录｜不是对方说的话]';
const SYSTEM_RECORDS = Object.freeze({
  failed: '你上一条没能回复：当时出了技术故障，对方只看到一句固定的提示。这不是你说的话，不用为它反复道歉；对方问起就如实说刚才出了点状况。',
  stopped: '你上一条还没说完，就被对方停止了。',
});

export function systemRecordMessage(kind) {
  return { role: 'user', content: `${SYSTEM_RECORD_OPEN} ${SYSTEM_RECORDS[kind] || SYSTEM_RECORDS.failed}` };
}

const FORGED_MARKER = /\[(较早对话摘要|本轮背景|系统记录)/gu;

/** 用户、同伴、工具文本里的块标记换成全角括号：读起来一样，但不再是块边界。 */
export function escapeContextMarkers(text) {
  return typeof text === 'string' ? text.replace(FORGED_MARKER, '［$1') : text;
}

export function summaryMessage(body) {
  const text = escapeContextMarkers(String(body || '').trim());
  return text ? { role: 'user', content: `${SUMMARY_OPEN}\n${text}\n${SUMMARY_CLOSE}` } : null;
}

export function isSummaryMessage(message) {
  return message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SUMMARY_OPEN);
}

export function isSystemRecordMessage(message) {
  return message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith(SYSTEM_RECORD_OPEN);
}

export function summaryBody(message) {
  if (!isSummaryMessage(message)) return '';
  const text = message.content.slice(SUMMARY_OPEN.length);
  const end = text.lastIndexOf(SUMMARY_CLOSE);
  return (end >= 0 ? text.slice(0, end) : text).trim();
}

export function turnContextBlock(text) {
  const body = String(text || '').trim();
  return body ? `${TURN_CONTEXT_OPEN}\n${body}\n${TURN_CONTEXT_CLOSE}` : '';
}

/**
 * 把本轮背景附到历史末尾：最后一条是 user 原话就放在原话之前（原话仍是最后说的话），否则单独成一条 user 消息。
 * 不改传入的数组。
 */
export function attachTurnContext(messages, text) {
  const block = turnContextBlock(text);
  const list = Array.isArray(messages) ? messages : [];
  if (!block) return list;
  const last = list.at(-1);
  if (last?.role === 'user' && typeof last.content === 'string' && !isSummaryMessage(last) && !isSystemRecordMessage(last)) {
    return [...list.slice(0, -1), { ...last, content: `${block}\n\n${last.content}` }];
  }
  return [...list, { role: 'user', content: block }];
}

/** 从消息数组里取出本轮背景块的正文（没有则为空串），供上下文构成统计按小节计量。 */
export function turnContextOf(messages) {
  for (const message of [...(Array.isArray(messages) ? messages : [])].reverse()) {
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    const start = message.content.indexOf(TURN_CONTEXT_OPEN);
    if (start < 0) continue;
    const end = message.content.indexOf(TURN_CONTEXT_CLOSE, start);
    if (end < 0) continue;
    return message.content.slice(start + TURN_CONTEXT_OPEN.length, end).trim();
  }
  return '';
}

/**
 * 去掉本轮背景后的消息数组：带背景的 user 消息只剩原话，只有背景的那条整条去掉。
 * 看「对话本身长什么样」时用（诊断脚本、测试）；发给模型的请求不经过它。
 */
export function withoutTurnContext(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user' || typeof message.content !== 'string') { out.push(message); continue; }
    const start = message.content.indexOf(TURN_CONTEXT_OPEN);
    const end = start < 0 ? -1 : message.content.indexOf(TURN_CONTEXT_CLOSE, start);
    if (end < 0) { out.push(message); continue; }
    const rest = `${message.content.slice(0, start)}${message.content.slice(end + TURN_CONTEXT_CLOSE.length)}`.trim();
    if (rest) out.push({ ...message, content: rest });
  }
  return out;
}
