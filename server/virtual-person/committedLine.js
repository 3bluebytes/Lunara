// committedLine.js — 播放提交是终止性动作，提交后不再调模型；可见回复要么是复核过的固定文案，
// 要么是模型在发起提交的同一条消息里已经写好的那句话。这里机械判断后者能不能直接给用户看。
//
// 输入：模型那条消息的 content；工具给的放行策略 { allowedTitles, othersTitles }
//      （已提交曲目的歌名；其中由本轮其他成员推荐的歌名）。
// 输出：可以采用的文本；不能采用时返回 ''，由调用方退回固定文案。
//
// Python 伪代码：
//   line = accept_committed_line('我挑了《特别的人》。', {'allowedTitles': ['特别的人']})  # '' 表示不用
import { stripPeerMarkers } from './peerMessage.js';

export const COMMITTED_LINE_MAX_CHARS = 200;

const normalizeTitle = value => String(value || '').replace(/[《》\s]/gu, '').toLowerCase();
// 提交只代表「已安排」：说已经在放、已经响起、已经切过去都超出了证据。
const SOUNDING_CLAIM = /(正在|已经在|已在|现在在)(为你|给你)?(播|放|响)|已经?(开始)?(播放|播上|放上|响起|开始播|开始放|切到|切好|切过去|换好)|(响起来|放起来)了/u;
// 群聊提交机制与运行时内部词不是用户要听的话。
const MECHANICS = /(提交|候选|排歌的人|负责排歌|负责提交|队列|工具|模型|系统|token|prompt|queue)/iu;
const URL_LIKE = /(https?:\/\/|www\.|\.(com|cn|net|io)\b)/i;
// 自称归属：「我挑了/我推荐的/我选的是《X》」。X 若是别人推荐的，这句就把来源说错了。
const SELF_CLAIM = /我(?:自己)?(?:挑|选|推荐|推|找)[^《。！？\n]{0,4}《([^》]{1,80})》/gu;

// 仅供流式草稿使用：正文在提交前就断言"已在播放"时，不能提前展示。
export function assertsPlayback(text) {
  return SOUNDING_CLAIM.test(String(text || ''));
}

export function acceptCommittedLine(text, policy) {
  const allowed = new Set((Array.isArray(policy?.allowedTitles) ? policy.allowedTitles : []).map(normalizeTitle).filter(Boolean));
  if (!allowed.size) return '';
  const line = stripPeerMarkers(String(text || '')).text;
  if (!line || [...line].length > COMMITTED_LINE_MAX_CHARS) return '';
  if (SOUNDING_CLAIM.test(line) || MECHANICS.test(line) || URL_LIKE.test(line)) return '';
  for (const match of line.matchAll(/《([^》]{1,80})》/gu)) {
    if (!allowed.has(normalizeTitle(match[1]))) return '';
  }
  const others = new Set((Array.isArray(policy?.othersTitles) ? policy.othersTitles : []).map(normalizeTitle).filter(Boolean));
  for (const match of line.matchAll(SELF_CLAIM)) {
    if (others.has(normalizeTitle(match[1]))) return '';
  }
  return line;
}
