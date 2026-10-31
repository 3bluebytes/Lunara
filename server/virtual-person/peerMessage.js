/**
 * 伙伴之间的数据面协议（add-peer-message-protocol D1/D2/D6）。
 *
 * 群聊里为某位伙伴组装模型历史时，只有他自己说过的话保留 assistant 角色；别人公开说的话
 * 放进 user 角色里的同伴消息信封：
 *
 *   <peer_message from="小满" member="radiohost_x" round="current">
 *   正文
 *   </peer_message>
 *
 * 信封只由历史投影生成。用户正文、同伴正文、工具结果、摘要里出现的同名标记一律把 `<`
 * 换成全角 `＜`，所以谁都不能在自己的话里伪造一段「别人说」。模型输出里出现的信封标记
 * 与旧式 `[历史说话人：…]` 标签在可见正文出口剥掉。
 */
import { stripSpeakerLabel } from './speakerLabel.js';

const MARKER = /<(\s*\/?\s*peer_message)/giu;
// 输出守卫：完整或残缺的开/闭标记（含已被转义的全角形式）。
const OUTPUT_MARKER = /[<＜]\s*\/?\s*peer_message\b[^>\n]*(?:>|$)/giu;

function escapeAttribute(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapePeerMarkers(text) {
  return typeof text === 'string' ? text.replace(MARKER, '＜$1') : text;
}

export function peerEnvelope({ name, memberId, round, text }) {
  const roundValue = round === 'current' ? 'current' : 'earlier';
  return `<peer_message from="${escapeAttribute(name)}" member="${escapeAttribute(memberId)}" round="${roundValue}">\n`
    + `${escapePeerMarkers(String(text ?? ''))}\n</peer_message>`;
}

/** @returns {{text: string|null, stripped: boolean}} */
export function stripPeerMarkers(text) {
  if (typeof text !== 'string') return { text, stripped: false };
  const cleaned = stripSpeakerLabel(text.replace(OUTPUT_MARKER, '')).trim();
  return { text: cleaned, stripped: cleaned !== text.trim() };
}

/**
 * 相邻的 user 消息合并成一条（段落之间空一行），请求因此不依赖供应商是否接受连续同角色消息。
 * sources[i] 是合并后第 i 条消息来自哪些输入下标，供摘要回调把下标换回账本 turn。
 */
export function mergeAdjacentUserMessages(messages) {
  const merged = [];
  const sources = [];
  messages.forEach((message, index) => {
    const previous = merged.at(-1);
    if (previous && previous.role === 'user' && message.role === 'user'
        && typeof previous.content === 'string' && typeof message.content === 'string') {
      merged[merged.length - 1] = { ...previous, content: `${previous.content}\n\n${message.content}` };
      sources.at(-1).push(index);
      return;
    }
    merged.push(message);
    sources.push([index]);
  });
  return { messages: merged, sources };
}
