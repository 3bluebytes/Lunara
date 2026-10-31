/**
 * 引用一条历史消息到输入框（add-chat-message-quote）。
 *
 * 引用不是隐藏上下文：它是一段人可读、可编辑的文本，进输入框、随消息一起发送，
 * 账本、模型和气泡看到的是同一段字。所以这里只做三件小事——把消息压成短摘要、
 * 认出草稿开头的引用块、把新引用块拼到草稿前面。
 */

/** 引用摘要上限：够指认是哪句，又不把输入框或气泡顶成一面墙。 */
export const QUOTE_MAX_CHARS = 140;

const QUOTE_LINE_OPEN = /^\s*>/u;
const QUOTE_LINE_PREFIX = /^\s*>\s?/u;

function flatten(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function plainTextOf({ text, segments } = {}) {
  if (typeof text === 'string' && text.trim()) return text;
  if (Array.isArray(segments)) {
    const joined = segments.map(segment => String(segment?.content ?? '')).filter(part => part.trim()).join('\n');
    if (joined.trim()) return joined;
  }
  return '';
}

/** 曲目卡消息：正文是空的，引用它就要指认是哪首歌，而不是给一段空气。 */
function trackSummary(tracks) {
  const items = (Array.isArray(tracks) ? tracks : [])
    .filter(track => track && (track.title || track.songId))
    .slice(0, 2)
    .map(track => {
      const title = flatten(track.title).replace(/[《》]/gu, '');
      if (!title) return '';
      const artist = flatten(track.artist);
      return artist ? `《${title}》— ${artist}` : `《${title}》`;
    })
    .filter(Boolean);
  return items.join('、');
}

function truncate(value) {
  const chars = Array.from(value);
  return chars.length > QUOTE_MAX_CHARS ? `${chars.slice(0, QUOTE_MAX_CHARS).join('')}…` : value;
}

/**
 * 生成引用行（不含 `> ` 前缀，由写入输入框时统一加）。
 * 说话人：用户自己就是「我」，伙伴用自己的名字；两者都不认识时不给引用。
 */
export function buildQuoteText({ role = null, speakerName = '', text = '', segments = null, tracks = null } = {}) {
  const plain = flatten(plainTextOf({ text, segments })) || trackSummary(tracks);
  if (!plain) return '';
  const speaker = role === 'user' ? '我' : (flatten(speakerName) || 'Lunara');
  return `引用 ${speaker}：${truncate(plain)}`;
}

/**
 * 取出正文开头连续的 `> ` 行。引用只认开头：中间或结尾的 `>` 行当普通正文，
 * 免得一段代码或长文里恰好以 `>` 开头就被改写排版。
 */
export function splitLeadingQuote(text) {
  const raw = String(text ?? '');
  if (!raw) return { quote: [], body: '' };
  const lines = raw.split('\n');
  const quote = [];
  let index = 0;
  while (index < lines.length && QUOTE_LINE_OPEN.test(lines[index])) {
    quote.push(lines[index].replace(QUOTE_LINE_PREFIX, '').trim());
    index += 1;
  }
  if (!quote.length) return { quote: [], body: raw };
  return { quote, body: lines.slice(index).join('\n').replace(/^\n+/u, '') };
}

/**
 * 把引用块写到草稿前面：保留已有草稿，替换掉旧的引用块（不叠加两段引用）。
 * 返回的新草稿末尾留一个空行，方便直接从下一段开始写。
 */
export function applyQuoteToDraft(draft = '', quoteText = '') {
  const current = String(draft ?? '');
  const lines = String(quoteText ?? '')
    .split('\n')
    .map(line => flatten(line.replace(QUOTE_LINE_PREFIX, '')))
    .filter(Boolean)
    .map(line => `> ${line}`);
  if (!lines.length) return current;
  const block = lines.join('\n');
  if (current === block || current.startsWith(`${block}\n`)) return current;
  const rest = splitLeadingQuote(current).body.replace(/^\n+/u, '');
  return rest ? `${block}\n\n${rest}` : `${block}\n\n`;
}
