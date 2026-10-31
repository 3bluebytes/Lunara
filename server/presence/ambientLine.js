// ambientLine.js — ambient turn 说出口的话的机械校验（纯函数，可单测；add-companion-heartbeat D2.4）。
//
// 输入：她要说的话、本轮任务（contextText = 本轮组装出的系统提示 + 历史 + 运行时提示；
//       recentLines = 她在这个聊天里最近 3 句可见的话）。
// 输出：违反的规则 id（封闭集合，只进 trace 统计）或 null。
// 只查是否真实、是否越界，不查情绪词：说什么、怎么说由她自己决定。
// 正则与相似度复用 presenceLine，旧 presence 路径删除后它们迁到这里。
//
// Python 伪代码：
//   rule = ambient_line_defect('《夜航星》真适合夜里听。', task)   # None 表示通过
import {
  INTERNAL_TERMS, PLAYBACK_CLAIMS, PRESENCE_SIMILARITY_LIMIT, TITLE_MARK, URL_LIKE, bigramSimilarity,
} from './presenceLine.js';

export const AMBIENT_LINE_MAX_CHARS = 80;
export const AMBIENT_LINE_MAX_SENTENCES = 2;

// 运行时与账本的内部标识：回合/请求 id 前缀，或一长串十六进制。
const INTERNAL_ID = /\b(?:turn|round|req|err|wake|ambient|intro|presence)[_:][\w:-]{4,}|\b[0-9a-f]{12,}\b/i;
const clean = value => String(value ?? '').trim();
const sentences = text => clean(text).split(/[。！？!?\r\n]+/u).map(part => part.trim()).filter(Boolean);

/** @returns 违反的规则 id；null 表示通过。 */
export function ambientLineDefect(text, task = {}) {
  const line = clean(text);
  if (!line) return 'empty_text';
  if (sentences(line).length > AMBIENT_LINE_MAX_SENTENCES) return 'too_many_sentences';
  if ([...line].length > AMBIENT_LINE_MAX_CHARS) return 'too_long';
  if (URL_LIKE.test(line)) return 'url';
  if (INTERNAL_TERMS.test(line)) return 'internal_terms';
  if (INTERNAL_ID.test(line)) return 'internal_id';
  if (PLAYBACK_CLAIMS.test(line)) return 'playback_claim';
  // 歌名只能是本轮上下文里真的出现过的：系统提示、历史或运行时提示。
  const contextText = String(task?.contextText || '');
  for (const [, title] of line.matchAll(TITLE_MARK)) {
    const name = clean(title);
    if (!name || !contextText.includes(name)) return 'entity_outside_context';
  }
  if ((task?.recentLines || []).some(previous => bigramSimilarity(line, previous) >= PRESENCE_SIMILARITY_LIMIT)) {
    return 'repeats_recent';
  }
  return null;
}

const RULE_FEEDBACK = Object.freeze({
  empty_text: '正文为空。想开口就写一两句话；不想说就提交 action=quiet。',
  too_many_sentences: `最多 ${AMBIENT_LINE_MAX_SENTENCES} 句话。`,
  too_long: `太长了：不超过 ${AMBIENT_LINE_MAX_CHARS} 个字。`,
  url: '不要出现链接。',
  internal_terms: '不要出现内部术语或技术机制，用平常说话的方式。',
  internal_id: '不要出现编号或内部标识。',
  playback_claim: '不要声称已经播放、切歌或安排好了什么。',
  entity_outside_context: '提到的歌名只能是你们上下文里真的出现过的歌。',
  repeats_recent: '和你最近说过的话几乎一样，换个说法，或者提交 action=quiet。',
  recommendation_not_mentioned: '你刚推荐了一首歌：这句话要提到那首歌名（就是刚确认能放的那首）；不想推荐了就提交 action=quiet。',
  unknown_note: 'noteIds 只能写这一轮「你心里记着的事」里列出的 n 编号；不确定就不填。',
});

export function ambientRuleFeedback(rule) {
  return RULE_FEEDBACK[rule] || '没有通过校验。';
}
