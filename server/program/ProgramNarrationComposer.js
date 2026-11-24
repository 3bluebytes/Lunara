// ProgramNarrationComposer.js — 串词的确定性校验 + 已持久化串词的 TTS 资产解析。
//
// 串词正文只能由 host 在提交选歌后的 line pass 里写成（见 trackLineTools.js），本模块不调用模型：
//   - lyricExcerpt / lyricCredits / NARRATION_MIN_LENGTH：歌词节选、创作署名、串词的长度下限
//   - overusedPhrases：最近实际说出的串词里用滥的片段
//   - narrationDefect / narrationRuleFeedback：逐条校验与可纠正的规则提示
//   - resolveTrackNarrationAsset：已持久化串词的 TTS 资产解析

import { normalizePerformance, toPlainText } from '../tts/performance/markers.js';
import { synthesizeWithin } from '../tts/boundedSynthesis.js';
import { NARRATION_EXECUTION_LIMITS } from '../llmTasks.js';

const cleanText = value => String(value ?? '').trim();
const cleanList = value => (Array.isArray(value) ? value : []).map(cleanText).filter(Boolean).slice(0, 4);
/** 校验用的目录事实：专辑和年份。正文说的年份、专辑和这里对不上才算错。 */
export function narrationFacts(track, context = {}) {
  const year = Number(context.trackFacts?.song?.year);
  return {
    album: cleanText(track.album),
    year: Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null,
  };
}

export function sentenceCount(text) {
  return (cleanText(text).match(/[。！？!?](?:[”’』】》"]*)/gu) || []).length;
}

// ── 篇幅：说多长由 host 自己定，不给写作目标；机械校验只检查下限和异常上限（650 字 / 12 句） ──
export const NARRATION_MIN_LENGTH = Object.freeze({ minChars: 12, minSentences: 1 });

// ── 歌词节选：有界、去时间轴与署名、去重叠句；是不可信数据，不是指令 ──────────────
const LYRIC_EXCERPT_LIMIT = 400;
const LYRIC_CREDIT = /^(?:作词|作曲|编曲|词|曲|制作人?|监制|混音|母带|录音|和声|配唱|出品|发行|企划|统筹|OP|SP|lyrics?|composer|arranger|producer)\s*[:：]/iu;
const LYRIC_PLACEHOLDER = /纯音乐|没有填词|instrumental|暂无歌词/iu;

// 创作署名：歌词文件开头的“作词：某人”这些行。节选里去掉它们，另作创作信息给 host 看。
const CREATION_CREDIT = /^(?:作词|作曲|编曲|词|曲|制作人?|监制|lyrics?|composer|arranger|producer)\s*[:：]\s*\S/iu;
const CREDIT_LIMIT = 6;
const CREDIT_MAX_CHARS = 60;

export function lyricCredits(lyric) {
  const raw = typeof lyric === 'string' ? lyric : lyric?.lrc;
  if (!cleanText(raw)) return [];
  const credits = [];
  for (const line of String(raw).split(/\r?\n/u)) {
    const text = line.replace(/\[[^\]]*\]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!CREATION_CREDIT.test(text)) continue;
    const credit = text.replace(/\s*[:：]\s*/u, '：').slice(0, CREDIT_MAX_CHARS);
    if (!credits.includes(credit)) credits.push(credit);
    if (credits.length >= CREDIT_LIMIT) break;
  }
  return credits;
}

export function lyricExcerpt(lyric) {
  const raw = typeof lyric === 'string' ? lyric : lyric?.lrc;
  if (!cleanText(raw) || LYRIC_PLACEHOLDER.test(raw)) return null;
  const seen = new Set();
  const lines = [];
  let length = 0;
  for (const line of String(raw).split(/\r?\n/u)) {
    const text = line.replace(/\[[^\]]*\]/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!text || LYRIC_CREDIT.test(text) || seen.has(text)) continue;
    seen.add(text);
    const next = length + (lines.length ? 3 : 0) + text.length;
    if (next > LYRIC_EXCERPT_LIMIT) break;
    lines.push(text);
    length = next;
  }
  return lines.length ? lines.join(' / ') : null;
}

const IDENTITY_SPLITTERS = /[/、,，;；]|feat\.?|ft\.?|&/giu;

/**
 * Equivalent forms of a catalogue identity. "袁娅维TIA RAY" → also "袁娅维";
 * "如诗般 宁静 (钢琴版)" → also "如诗般宁静". Verification accepts a core form
 * so a correct narration is not rejected for not repeating the full string.
 */
function identityForms(value) {
  const full = cleanText(value).replace(/\s+/gu, '');
  if (!full) return [];
  const forms = new Set([full]);
  const bare = full.replace(/[（(][^）)]*[）)]/gu, '');
  if (bare) forms.add(bare);
  for (const part of full.split(IDENTITY_SPLITTERS)) {
    const trimmed = cleanText(part).replace(/\s+/gu, '');
    if (!trimmed) continue;
    if (trimmed.length >= 2) forms.add(trimmed);
    const cjk = trimmed.match(/[\u3400-\u9fff]{2,}/u);
    if (cjk) forms.add(cjk[0]);
  }
  return [...forms];
}

export function mentionsIdentity(text, value) {
  const haystack = cleanText(text).replace(/\s+/gu, '');
  if (!haystack) return false;
  return identityForms(value).some(form => haystack.includes(form));
}

const LISTENER_ECHO_WINDOW = 8;
const LYRIC_RECITE_WINDOW = 31;
const MEMORY_QUOTE_WINDOW = 12;

function withoutPunctuation(value) {
  return cleanText(value).replace(/[\s，。！？!?、；：:”“‘’"'《》〈〉「」『』·…—\-/~～]/gu, '');
}

function sharesWindow(haystack, source, size, exempt = () => false) {
  if (source.length < size) return false;
  for (let index = 0; index + size <= source.length; index += 1) {
    const window = source.slice(index, index + size);
    if (haystack.includes(window) && !exempt(window)) return true;
  }
  return false;
}

// 本来就属于这首歌的文字（歌名、歌手、歌词）说出来不算复述听众，也不算照念记忆。
function songTextExemption(track, lyrics = '') {
  const title = withoutPunctuation(track?.title);
  const artist = withoutPunctuation(track?.artist);
  const owned = [title, artist, `${title}${artist}`, `${artist}${title}`, `${artist}的${title}`, withoutPunctuation(lyrics)]
    .filter(Boolean);
  return window => owned.some(text => text.includes(window));
}

/** A narration that reuses the listener's own words is not addressed to the listener. */
function echoesListenerText(text, recentConversation, exempt) {
  const haystack = withoutPunctuation(text);
  if (!haystack) return false;
  return (Array.isArray(recentConversation) ? recentConversation : [])
    .some(turn => turn?.role === 'user' && sharesWindow(haystack, withoutPunctuation(turn.text), LISTENER_ECHO_WINDOW, exempt));
}

// 歌词节选的第一行是“歌名 - 歌手”这类元数据行：串词本来就必须点名，比对时不能把它算成借歌词，
// 否则“《Special One (feat. Eason Chan)》，AGA / 陈奕迅”这种合规开头会被判成照念歌词。
// 返回已经去标点的歌词行；只由歌名歌手组成的行不算歌词。
function lyricLines(lyrics, track = {}) {
  const owned = [track?.title, track?.artist].flatMap(value => identityForms(value).map(withoutPunctuation));
  return String(lyrics || '').split(' / ').map(withoutPunctuation).filter(Boolean).filter(line => {
    let rest = line;
    for (const form of owned) if (form) rest = rest.split(form).join('');
    return rest.length >= LYRIC_FRAGMENT_MIN;
  });
}

// 一句短引用可以；连续 30 字以上与歌词相同就是在念歌词。逐行比较，不把分行拼成假的长引用。
function recitesLyrics(text, lyrics, track) {
  const haystack = withoutPunctuation(text);
  return lyricLines(lyrics, track).some(line => sharesWindow(haystack, line, LYRIC_RECITE_WINDOW));
}

// ── 复述歌词：把歌词当内容讲一遍，比照念更难看出来 ───────────────────────────
// 串词里出现成串的歌词（多段、合计十几字以上）几乎是同一件事：模型在按歌词白描剧情。
// 歌词节选按行切分后逐行找最长公共段，互不包含的段才算一条；
// 歌名歌手本来就要说，落在它们里面的段不算借歌词。
const LYRIC_FRAGMENT_MIN = 6;
const LYRIC_LONG_QUOTE = 16;
const LYRIC_PAIR_TOTAL = 12;
const LYRIC_TOTAL_MAX = 20;

function borrowedLyricRuns(text, lyrics, track = {}) {
  const haystack = withoutPunctuation(text);
  if (!haystack || !lyrics) return [];
  const owned = [track?.title, track?.artist].map(value => withoutPunctuation(value)).filter(Boolean);
  const found = new Set();
  for (const source of lyricLines(lyrics, track)) {
    for (let start = 0; start + LYRIC_FRAGMENT_MIN <= source.length; start += 1) {
      let length = 0;
      while (source[start + length] !== undefined
        && haystack.includes(source.slice(start, start + length + 1))) length += 1;
      if (length >= LYRIC_FRAGMENT_MIN) found.add(source.slice(start, start + length));
    }
  }
  const runs = [...found];
  return runs
    .filter(run => !runs.some(other => other !== run && other.includes(run)))
    .filter(run => !owned.some(name => name.includes(run)));
}

// 一条短的引用可以；两段以上合计十几字、或整段照搬十几字，就是在复述歌词内容。
function retellsLyrics(text, lyrics, track) {
  const runs = borrowedLyricRuns(text, lyrics, track);
  if (!runs.length) return false;
  const total = runs.reduce((sum, run) => sum + run.length, 0);
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return longest >= LYRIC_LONG_QUOTE
    || (runs.length >= 2 && total >= LYRIC_PAIR_TOTAL)
    || total >= LYRIC_TOTAL_MAX;
}

// 记忆是素材，要用自己的话说；长段照抄会把内部摘要腔（“听众说……”）念出来。
function quotesMemory(text, memories, exempt) {
  const haystack = withoutPunctuation(text);
  return (Array.isArray(memories) ? memories : [])
    .some(memory => sharesWindow(haystack, withoutPunctuation(memory), MEMORY_QUOTE_WINDOW, exempt));
}

// Album attribution in any common wording. Metaphors like "把情绪收在皮肤底下" stay
// outside the claim check because 专辑/《 must directly follow the verb.
const ALBUM_CLAIM_PATTERN = /(?:收录[于在]|收[在进](?:专辑|《))/u;

const RELEASE_CLAUSE = /[^，。！？,.!?；;\n]*(?:发行|发布|推出|问世|首发)[^，。！？,.!?；;\n]*/gu;

/**
 * 只拦和曲库对不上的两件事：曲库记了年份，正文把发行说成别的年份；曲库记了专辑，正文把它归到别的专辑。
 * 创作背景、时长、听感由 host 凭自己知道的和感受到的说，这里不判。
 */
function contradictsCatalogue(text, facts) {
  if (facts?.year) {
    const years = (cleanText(text).match(RELEASE_CLAUSE) || [])
      .flatMap(clause => [...clause.matchAll(/(?:19|20)\d{2}/gu)].map(match => Number(match[0])));
    if (years.some(year => year !== facts.year)) return true;
  }
  if (facts?.album && ALBUM_CLAIM_PATTERN.test(text) && !cleanText(text).includes(facts.album)) return true;
  return false;
}

// 串词写在实际前一首确定之前：任何“紧接的上一首/下一首”说法都可能不成立，一律拒绝。
// 跨曲自由联想（同歌手、同专辑、让人想起另一首）没有这种说法，不受影响。
const IMMEDIATE_REFERENCE_PATTERN = /上一首|上一曲|前一首|前面[那这]?一?首|下一首|刚才|刚刚|接着是|接着上一首|延续上一首/u;

function withoutNames(text, names) {
  return names.flatMap(identityForms).sort((a, b) => b.length - a.length)
    .reduce((rest, form) => rest.split(form).join(' '), cleanText(text).replace(/\s+/gu, ''));
}

// 声称听众说过或想要什么。只有听众本回合的请求或关于本曲的记忆可以作依据；“如果你喜欢”不是声称。
const LISTENER_CLAIM_PATTERN = /(?<!如果|要是|若是|假如)你(?:之前|先前|上次|以前|曾经|前面|刚才|也|还)?(?:说|提过|提到|讲过|要的|想要|想找|要找|夸|喜欢|点的|点过)/u;

function claimsListener(text, { listenerAsked, memories, liked }) {
  const match = cleanText(text).match(LISTENER_CLAIM_PATTERN);
  if (!match) return false;
  if (listenerAsked === true || (Array.isArray(memories) && memories.length > 0)) return false;
  return !(liked === true && match[0].includes('喜欢'));
}

// 套话句式：「没把 X 唱成 Y，反而…」「最 X 的地方是…」。一小时实机里几乎每条都套这两个骨架。
const STOCK_PHRASING_PATTERNS = [
  /(?:没|不)(?:有)?(?:打算|想|肯)?把[^，。！？,.!?；;]{1,10}(?:唱|写|说|讲|当|弄|变|演)[^，。！？,.!?；;]{0,8}[，,]?[^。！？!?]{0,16}?(?:反而|而是|倒像|倒是|只是)/u,
  /最(?!初|开始|早|后)[\u3400-\u9fff]{1,3}的地方/u,
];

// 跟听众谈素材本身：素材只是给你看的，听众不知道有这么一份东西。
const MATERIAL_TALK_PATTERN = /(?:没|没有)(?:拿到|看到|找到|查到)(?:它的|这首的)?歌词|歌词[^，。！？,.!?；;]{0,6}(?:没|没有)(?:拿到|看到|找到|查到)|素材|资料里|歌词节选/u;

// 拿来对比的别的歌（书名号里不是这首歌名、也不是它专辑的那些）。
function referencedTitles(text, own = []) {
  const skip = new Set(own.map(withoutPunctuation).filter(Boolean));
  return [...cleanText(text).matchAll(/《([^》]+)》/gu)].map(match => withoutPunctuation(match[1]))
    .filter(title => title && !skip.has(title));
}

/** 同一批、待念、最近说过的别的串词已经拿某首歌来对比过，这条再提就是重复。 */
function repeatsReference(text, otherLines, track, facts) {
  const lines = Array.isArray(otherLines) ? otherLines : [];
  if (!lines.length) return false;
  const mine = referencedTitles(text, [track?.title, facts?.album]);
  if (!mine.length) return false;
  const used = new Set(lines.flatMap(line => {
    const entry = typeof line === 'string' ? { text: line } : (line || {});
    return referencedTitles(entry.text, [entry.title, entry.album]);
  }));
  return mine.some(title => used.has(title));
}

// ── 用滥句式：换了词也还是同一个骨架 ─────────────────────────────────────────
// 2026-11-07 实机：大多数串词都是“这首歌最…的不是 A，是 B——……”，片段检查拦不住换词。
const SHAPE_WINDOW = 6;
const SHAPE_MIN_LINES = 3;
const SHAPE_PATTERNS = [
  ['contrast', /(?:不是|并不是|并非|不在于)[^。！？!?]{1,30}?[，,；;—]+[^。！？!?]{0,4}?(?:而是|是|倒是|反而|恰恰)/u],
  ['dash', /——|—/u],
  ['song-verdict', /(?:这首歌?|这歌)[^，。！？,!?]{0,3}?(?:最|狠|厉害|妙|好在|写的|唱的|问的|说的)/u],
];
export const SHAPE_LABELS = { contrast: '“不是 A，是 B”的对比', dash: '破折号接一句解读', 'song-verdict': '拿“这首歌最…/这歌狠”评歌' };

/** 一条串词用了哪些句式；书名号里的歌名不算。 */
export function lineShapes(text) {
  const body = String(text || '').replace(/《[^》]*》/gu, '《》');
  return new Set(SHAPE_PATTERNS.filter(([, pattern]) => pattern.test(body)).map(([shape]) => shape));
}

/** 最近 6 条（从旧到新）里有 3 条以上用了的句式。 */
export function overusedShapes(lines) {
  const counts = new Map();
  for (const line of (Array.isArray(lines) ? lines : []).slice(-SHAPE_WINDOW)) {
    const text = typeof line === 'string' ? line : line?.text;
    for (const shape of lineShapes(text)) counts.set(shape, (counts.get(shape) || 0) + 1);
  }
  return SHAPE_PATTERNS.map(([shape]) => shape).filter(shape => (counts.get(shape) || 0) >= SHAPE_MIN_LINES);
}

function repeatedShapes(text, otherLines) {
  const overused = overusedShapes(otherLines);
  if (!overused.length) return [];
  const mine = lineShapes(text);
  return overused.filter(shape => mine.has(shape));
}

// ── 用滥词：最近实际说出的串词里 3 条以上共有的 2–4 字片段 ────────────────────
const OVERUSED_WINDOW = 8;
const OVERUSED_MIN_LINES = 3;
const OVERUSED_LIMIT = 20;
const OVERUSED_STOPWORDS = new Set(['一个', '一首', '一些', '一点', '一样', '一直', '这个', '这首', '这些', '这样', '这种', '这里', '那个',
  '那些', '那样', '那种', '那里', '不是', '就是', '也是', '还是', '只是', '但是', '可是', '因为', '所以', '如果', '可以', '没有', '什么',
  '怎么', '时候', '自己', '我们', '你们', '他们', '它们', '有点', '已经', '还有', '首歌', '这首歌', '那首歌', '一首歌']);
const OVERUSED_EDGE = /^[的了着也和都在是与及而]|[的了着也和都在是与及而]$/u;

/**
 * lines 是最近实际说出的串词，从旧到新；元素可以是字符串，也可以带上 title/artist（那条自己的歌手不算）。
 * 只留最长的片段：“不碍事”算进来时，同样几条共有的“碍事”不再单列。
 */
export function overusedPhrases(lines) {
  const seen = new Map();
  (Array.isArray(lines) ? lines : []).slice(-OVERUSED_WINDOW).forEach((line, index) => {
    const entry = typeof line === 'string' ? { text: line } : (line || {});
    const body = withoutNames(String(entry.text || '').replace(/《[^》]*》/gu, ' '), [entry.title, entry.artist]);
    for (const run of body.match(/[\u3400-\u9fff]{2,}/gu) || []) {
      for (let size = 2; size <= 4; size += 1) {
        for (let start = 0; start + size <= run.length; start += 1) {
          const fragment = run.slice(start, start + size);
          if (!seen.has(fragment)) seen.set(fragment, new Set());
          seen.get(fragment).add(index);
        }
      }
    }
  });
  const qualified = [...seen].filter(([fragment, indexes]) => indexes.size >= OVERUSED_MIN_LINES
    && !OVERUSED_STOPWORDS.has(fragment) && !OVERUSED_EDGE.test(fragment));
  return qualified
    .filter(([fragment, indexes]) => !qualified.some(([other, others]) => other !== fragment && other.includes(fragment)
      && others.size === indexes.size))
    .sort((a, b) => b[1].size - a[1].size || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, OVERUSED_LIMIT)
    .map(([fragment]) => fragment);
}

function usedOverusedPhrase(text, phrases, track) {
  const list = Array.isArray(phrases) ? phrases : [];
  if (!list.length) return null;
  const body = withoutNames(String(text || '').replace(/《[^》]*》/gu, ' '), [track?.title, track?.artist]);
  return list.find(phrase => body.includes(phrase)) || null;
}

/**
 * 聊天里已经向听众报过这张专辑时，串词再报同一张就是 12:06/12:07 那种重复介绍——
 * 这条用机械比较兜住，不依赖模型自觉。聊天没报过专辑时，串词报专辑不受影响。
 */
function repeatsChatIntroduction(text, facts, chatIntroduced, recentConversation) {
  if (!chatIntroduced || !facts.album) return false;
  const album = withoutPunctuation(facts.album);
  if (!album) return false;
  const chatMentionedAlbum = (Array.isArray(recentConversation) ? recentConversation : [])
    .some(turn => turn?.role && turn.role !== 'user' && turn.presentation !== 'track_intro'
      && withoutPunctuation(turn.text || '').includes(album));
  return chatMentionedAlbum && withoutPunctuation(text).includes(album);
}

// 只拦内部 id 与字段名（带下划线或驼峰，不会出现在正常中文串词里）；“停一拍”这类自然中文不拦。
const INTERNAL_DIRECTIVE_PATTERN = /openingMode|closingMode|narrationPlan|writingGuide|acceptanceRules|descriptiveTags|catalogMetadata|artistTags|previousActualTrack|recentHostIntroductions|recentIntroductions|requestResponse|request_response|listening_pause|title_first|listening_detail|recommendation_reason|listener_context|occasion|voiceOfTurn|followsInRequest|aboutThisSong|listenerLatest|partOfDay|soundTags|knowledge|named_request|chosen_for_request|lengthTarget|untrusted|expressionPreferences/u;

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const SELF_CLAIMED_PICK = /我(?:自己|亲自)?(?:挑|选|推荐|推|找|安排)(?:的|了|出)/u;
const PICK_WORDS = '(?:推荐|推的|挑的|选的|安利|分享)';

/**
 * 推荐人的歌的归属校验：只在有推荐人时检查。只看归属是否交代、是否自称、是否归错人，
 * 不规定怎么说——措辞完全由模型用自己的话完成。
 */
function recommendationDefect(text, recommendation) {
  const recommender = cleanText(recommendation?.recommender);
  if (!recommender) return null;
  if (!text.includes(recommender)) return 'missing-recommender';
  if (SELF_CLAIMED_PICK.test(text)) return 'self-claims-recommendation';
  for (const name of Array.isArray(recommendation.otherNames) ? recommendation.otherNames : []) {
    const other = escapeRegExp(cleanText(name));
    if (!other || recommender.includes(cleanText(name))) continue;
    if (new RegExp(`${other}[^。！？!?\n]{0,6}${PICK_WORDS}|(?:来自|推荐人是)[^。！？!?\n]{0,4}${other}`, 'u').test(text)) {
      return 'wrong-recommender';
    }
  }
  return null;
}

/**
 * 风格类检查：只提醒、不拦截。line pass 里同一首只退回一次，再交或最后一轮就不再判（见 trackLineTools）。
 * 串词风格上的新问题改素材、触发消息和统计，不往这里加新的拦截规则：词表和正则只认得见过的说法，
 * 换个说法就绕过去，拦下的歌却会安静播放。
 */
export const STYLE_RULES = Object.freeze(new Set(['stock-phrasing', 'overused-phrase', 'repeats-reference', 'repeats-shape']));

/**
 * 串词被拒绝的原因，判定都是确定性的。歌名必须提及，歌手和位置不限。第一处命中即返回规则名。
 * 事实与正确性类先判，风格类（STYLE_RULES）最后判；styleChecks: false 时风格类不判。
 */
export function narrationDefect(candidate, { track, facts, recentConversation, minSentences = 1, chatIntroduced, minChars = 12,
  recommendation = null, lyricExcerpt: lyrics = null, memories = [], liked = null, listenerAsked = false, overusedPhrases: overused = [],
  otherLines = [], styleChecks = true }) {
  const text = String(candidate || '').trim();
  if (text.length < minChars) return 'too-short';
  if (text.length > NARRATION_MAX_CHARS) return 'too-long';
  const sentences = sentenceCount(text);
  if (sentences < minSentences || sentences > NARRATION_MAX_SENTENCES) return 'sentence-count';
  if (!mentionsIdentity(text, track.title)) return 'missing-title';
  const attribution = recommendationDefect(text, recommendation);
  if (attribution) return attribution;
  if (/https?:\/\/|缓存|预热|命中|我(?:刚|已经).{0,8}(?:搜|找遍)/u.test(text)) return 'technical-or-claiming-search';
  // 歌名/歌手本身含这些英文词时不算外泄（例如一首叫 Knowledge 的歌）。
  const spoken = [track?.title, track?.artist].map(cleanText).filter(Boolean)
    .reduce((rest, name) => rest.split(name).join(' '), text);
  if (INTERNAL_DIRECTIVE_PATTERN.test(spoken)) return 'internal-directive';
  if (contradictsCatalogue(text, facts)) return 'unsupported-fact';
  if (IMMEDIATE_REFERENCE_PATTERN.test(withoutNames(text, [track?.title, track?.artist, facts?.album]))) return 'immediate-reference';
  if (claimsListener(text, { listenerAsked, memories, liked })) return 'unbacked-listener-claim';
  if (MATERIAL_TALK_PATTERN.test(text)) return 'talks-about-material';
  if (recitesLyrics(text, lyrics, track)) return 'recites-lyrics';
  if (retellsLyrics(text, lyrics, track)) return 'retells-lyrics';
  const exempt = songTextExemption(track, lyrics);
  if (quotesMemory(text, memories, exempt)) return 'quotes-memory';
  if (echoesListenerText(text, recentConversation, exempt)) return 'echoes-listener';
  if (repeatsChatIntroduction(text, facts, chatIntroduced, recentConversation)) return 'repeats-chat-introduction';
  if (!styleChecks) return null;
  if (STOCK_PHRASING_PATTERNS.some(pattern => pattern.test(withoutNames(text, [track?.title, track?.artist, facts?.album])))) return 'stock-phrasing';
  if (usedOverusedPhrase(text, overused, track)) return 'overused-phrase';
  if (repeatsReference(text, otherLines, track, facts)) return 'repeats-reference';
  if (repeatedShapes(text, otherLines).length) return 'repeats-shape';
  return null;
}

/**
 * 被拒绝时的可纠正提示：点名违反的规则（rule id 保持机器可读），并给出具体修改方向。
 * 规则与判据同源（narrationDefect），提示不允许新增正文之外的事实。
 */
const overusedList = phrases => (Array.isArray(phrases) ? phrases : []).slice(0, 6).join('、') || '见素材';

export function narrationRuleFeedback(rule, task = {}, text = '') {
  const actualChars = String(text || '').trim().length;
  const actualSentences = sentenceCount(text);
  const minChars = Number(task.minChars) || 12;
  const minSentences = Number(task.minSentences) || 1;
  const maxChars = Number(task.maxChars) || 650;
  const title = cleanText(task.track?.title) || '本次歌曲';
  const recommender = cleanText(task.recommendation?.recommender) || '推荐人';
  const feedback = {
    'too-short': `正文太短：至少需要 ${minChars} 个字符，当前 ${actualChars} 个字符。`,
    'too-long': `正文太长：上限 ${maxChars} 个字符，当前 ${actualChars} 个字符。`,
    'sentence-count': `句子数量不合格：要求 ${minSentences}-${NARRATION_MAX_SENTENCES} 句，当前 ${actualSentences} 句。`,
    'missing-title': `必须准确出现本次歌名「${title}」的核心形式。`,
    'technical-or-claiming-search': '正文出现了链接、缓存/预热/命中等技术词，或声称刚搜索过；不要向听众解释技术机制。',
    'internal-directive': '正文念出了内部字段名，那些只是给你看的说明，不是台词；用自然的话重写。',
    'unsupported-fact': `正文说的发行年份或专辑和曲库记的对不上（曲库：${[task.facts?.album ? `专辑《${task.facts.album}》` : '', task.facts?.year ? `${task.facts.year} 年` : ''].filter(Boolean).join('，') || '见上面列的'}）；照曲库的说，或者略过。`,
    'immediate-reference': '这句话要到这首歌开始时才说，那时前一首是什么还不确定：不要说上一首、刚才、刚刚，也不要接着前面的话头。',
    'unbacked-listener-claim': '正文说听众说过或想要什么，但这不是听众这回合的请求，关于这首歌的记忆里也没有；去掉这个说法。',
    'stock-phrasing': '正文套了固定句式（「没把这个唱成那个，反而……」「最……的地方是……」）；不用这种先否定再翻转、或给歌找“最”的说法，直接说你想说的。',
    'talks-about-material': '正文在跟听众谈你拿到的素材（歌词有没有、资料里写了什么）；听众不知道有这份素材，素材没给的就不说，别解释。',
    'repeats-reference': '别的串词（这一批里、还没念的、或者最近说过的）已经拿同一首歌来对比过了；换个说法，不要再提那首。',
    'repeats-shape': `最近几条串词已经反复用了${(repeatedShapes(text, task.otherLines).map(shape => SHAPE_LABELS[shape]).join('、')) || '同一种句式'}，这条又是同一个骨架；换个开口，比如直接跟听众说为什么这会儿想放它。`,
    'overused-phrase': `正文用了最近几条串词反复出现的片段（${overusedList(task.overusedPhrases)}）；换一种说法。`,
    'echoes-listener': '正文复述了听众说过的话；要回应就用你自己的话，歌名和歌手名照说没关系。',
    'recites-lyrics': '正文大段照念了歌词；最多引用一句短的，说这首歌在唱什么要用你自己的话。',
    'retells-lyrics': '正文把多段歌词拼在一起讲歌里发生了什么。歌词只用来理解这首歌，不是内容；用你自己的话说，引用最多留一句短的。',
    'quotes-memory': '正文照抄了关于听众的记忆原文；像朋友记得那样用你自己的话自然提起，不要念出摘要。',
    'missing-recommender': `这首是「${recommender}」推荐、由你来放的：正文要用你自己的话交代这个来源，并出现「${recommender}」。`,
    'self-claims-recommendation': `这首不是你挑的，是「${recommender}」推荐的：不要把它说成自己挑选或推荐的。`,
    'wrong-recommender': `推荐人是「${recommender}」：正文把推荐归给了别的成员，改正归属。`,
    'repeats-chat-introduction': '聊天里已经介绍过这张专辑，正文又重复报了同一张；换一个角度或简短带过基础信息。',
  }[rule] || '请修正后重新提交。';
  return `违反校验规则「${rule}」：${feedback}`;
}

export const NARRATION_MAX_CHARS = 650;
export const NARRATION_MAX_SENTENCES = 12;

/** 已持久化串词的 TTS 资产解析：不调模型，只做有界合成。 */
export class ProgramNarrationComposer {
  constructor({ synthesize = null, timeoutMs = NARRATION_EXECUTION_LIMITS.synthesisBudgetMs } = {}) {
    Object.assign(this, { synthesize, timeoutMs });
  }

  /**
   * Revalidate or recreate a persisted TTS asset without invoking the model.
   * 有 spokenText + performance 时按原表演重合成；spokenText 剥离标记后必须与 text 一致，
   * 否则一律回落纯 text、不带表演。
   */
  async resolveTrackNarrationAsset(effect, { signal, deadlineMs = Infinity } = {}) {
    const { track } = effect;
    const narration = track.narration || {};
    const text = String(narration.text || '').trim();
    const storedSpoken = String(narration.spokenText || '').trim();
    const spokenMatches = Boolean(storedSpoken) && toPlainText(storedSpoken) === text;
    const spokenText = spokenMatches ? storedSpoken : text;
    const performance = spokenMatches ? normalizePerformance(narration.performance) : null;
    signal?.throwIfAborted();
    const voiceProfileId = narration.voiceProfileId || track.voiceProfileId || null;
    const result = await synthesizeWithin(text ? this.synthesize : null, spokenText,
      { voiceProfileId, signal, performance }, { budgetMs: this.timeoutMs, deadlineMs: deadlineMs ?? Infinity });
    return { ttsUrl: result.audio?.url || null,
      contentHash: result.audio?.hash || result.audio?.contentHash || narration.contentHash || null,
      narrationSynthesisReason: result.reason, narrationSynthesisElapsedMs: result.elapsedMs,
      voiceProfileId };
  }

}

export default ProgramNarrationComposer;
