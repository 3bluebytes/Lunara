// performance/markers.js — Lunara 中立表演标记与 SpeechPerformance 规范化。
//
// 合同（见 openspec speech-performance）：
// - 行内表演只能写成白名单标记：{笑}{轻笑}{叹气}{换气}{清嗓子}{停顿:x}，x ∈ [0.2, 2.0] 秒。
//   这些标记只用于发声；显示、持久化的人读文本一律经 toPlainText 剥离。
// - 非白名单的花括号（如歌名 {Love}）按原文保留；看起来像标记的 1–4 个汉字花括号
//   记为 unknown_marker，供提交校验拒绝。
// - 段落风格 SpeechPerformance = { emotion, pace, intensity, direction }，全部可选；
//   未知枚举值归 null，direction 最多 60 字。供应商原生参数不经过这里。

export const PERFORMANCE_EMOTIONS = Object.freeze(['calm', 'warm', 'happy', 'playful', 'sad', 'surprised', 'serious']);
export const PERFORMANCE_PACES = Object.freeze(['slow', 'normal', 'fast']);
export const PERFORMANCE_INTENSITIES = Object.freeze(['soft', 'normal', 'strong']);
export const MAX_DIRECTION_CHARS = 60;
export const MAX_INLINE_EVENTS = 2;
export const MAX_PAUSES = 3;
export const PAUSE_RANGE = Object.freeze({ min: 0.2, max: 2.0 });

/** 中文标记 → 中立事件 id。 */
export const MARKER_EVENTS = Object.freeze({
  笑: 'laugh',
  轻笑: 'chuckle',
  叹气: 'sigh',
  换气: 'breath',
  清嗓子: 'clear_throat',
});
/** 中立事件 id → 中文标记（用于向模型列出可用标记）。 */
export const EVENT_MARKERS = Object.freeze(Object.fromEntries(Object.entries(MARKER_EVENTS).map(([marker, event]) => [event, `{${marker}}`])));

const BRACE = /\{([^{}\n]{1,24})\}/g;
const PAUSE = /^停顿\s*[:：]\s*(\d+(?:\.\d+)?)\s*(?:s|秒)?$/;
const MARKER_LIKE = /^[一-鿿]{1,4}$/;
const NATIVE_SYNTAX = [
  /<#\s*\d+(?:\.\d+)?\s*#>/g,
  /\[(?:笑|轻笑|叹气|换气|清嗓子|咳嗽)\]/g,
  /\((?:laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/g,
];
const CJK_PUNCT = '，。！？、；：…—「」『』《》（）';
const SPACE_AROUND_PUNCT = new RegExp(`\\s*([${CJK_PUNCT}])\\s*`, 'g');

/** 把一个花括号内容分类：event / pause / invalid / literal。 */
function classify(inner, literal) {
  const content = inner.trim();
  if (MARKER_EVENTS[content]) return { type: 'event', event: MARKER_EVENTS[content] };
  if (content.startsWith('停顿')) {
    const match = PAUSE.exec(content);
    if (!match) return { type: 'invalid', reason: 'pause_malformed' };
    const seconds = Number(match[1]);
    if (!(seconds >= PAUSE_RANGE.min && seconds <= PAUSE_RANGE.max)) return { type: 'invalid', reason: 'pause_out_of_range' };
    return { type: 'pause', seconds };
  }
  if (MARKER_LIKE.test(content) && !literal.has(`{${inner}}`)) return { type: 'invalid', reason: 'unknown_marker', strip: false };
  return { type: 'literal' };
}

/**
 * 解析含中立标记的发声文本。
 * @param {string} text
 * @param {{ literal?: string[] }} [options] literal：允许原样出现的花括号片段（如歌名）。
 * @returns {{ segments: Array<{type:'text',text:string}|{type:'event',event:string}|{type:'pause',seconds:number}>,
 *   eventCount: number, pauseCount: number, invalid: Array<{marker:string,reason:string}>, nativeSyntax: string[] }}
 */
export function parseSpokenText(text, { literal = [] } = {}) {
  const source = String(text ?? '');
  const literalSet = new Set(literal.map(String));
  const segments = [];
  const invalid = [];
  let buffer = '';
  let last = 0;
  const flush = () => { if (buffer) segments.push({ type: 'text', text: buffer }); buffer = ''; };
  for (const match of source.matchAll(BRACE)) {
    buffer += source.slice(last, match.index);
    last = match.index + match[0].length;
    const kind = classify(match[1], literalSet);
    if (kind.type === 'event' || kind.type === 'pause') {
      flush();
      segments.push(kind.type === 'event' ? { type: 'event', event: kind.event } : { type: 'pause', seconds: kind.seconds });
    } else if (kind.type === 'invalid') {
      invalid.push({ marker: match[0], reason: kind.reason });
      // 无效停顿一定剥离，绝不念出；未知中文标记保留原文，由提交校验退回。
      if (kind.strip === false) buffer += match[0];
    } else buffer += match[0];
  }
  buffer += source.slice(last);
  flush();
  const nativeSyntax = NATIVE_SYNTAX.flatMap(pattern => source.match(pattern) || []);
  return {
    segments,
    eventCount: segments.filter(segment => segment.type === 'event').length,
    pauseCount: segments.filter(segment => segment.type === 'pause').length,
    invalid,
    nativeSyntax,
  };
}

/** 规整剥离标记后留下的空白：合并连续空白，去掉中文标点两侧的空格。 */
export function tidySpacing(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(SPACE_AROUND_PUNCT, '$1')
    .trim();
}

/** 显示/持久化用的纯文本：剥离白名单标记与无效停顿；没有标记时原样返回（仅 trim）。 */
export function toPlainText(text) {
  const source = String(text ?? '');
  const parsed = parseSpokenText(source);
  const stripped = parsed.eventCount + parsed.pauseCount
    + parsed.invalid.filter(item => item.reason !== 'unknown_marker').length;
  if (!stripped) return source.trim();
  return tidySpacing(parsed.segments.map(segment => (segment.type === 'text' ? segment.text : ' ')).join(''));
}

const pick = (value, allowed) => (allowed.includes(value) ? value : null);

/** 规范化段落风格；没有任何有效字段时返回 null。 */
export function normalizePerformance(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const direction = String(raw.direction ?? '').trim().slice(0, MAX_DIRECTION_CHARS) || null;
  const performance = {
    emotion: pick(raw.emotion, PERFORMANCE_EMOTIONS),
    pace: pick(raw.pace, PERFORMANCE_PACES),
    intensity: pick(raw.intensity, PERFORMANCE_INTENSITIES),
    direction,
  };
  return Object.values(performance).some(value => value !== null) ? performance : null;
}

/** 风格是否真的要求了什么（normal 视同未指定）。 */
export function styleRequested(performance) {
  const style = normalizePerformance(performance);
  if (!style) return false;
  return Boolean(style.emotion || style.direction
    || (style.pace && style.pace !== 'normal') || (style.intensity && style.intensity !== 'normal'));
}

/** 这段发声是否带任何表演（行内标记或风格）。 */
export function hasPerformance(text, performance) {
  const parsed = parseSpokenText(text);
  return parsed.eventCount + parsed.pauseCount > 0 || styleRequested(performance);
}
