// ProgramNarrationComposer.js — 串词任务的确定性技能 + 已持久化串词的 TTS 资产解析。
//
// 「一切皆 tool」：串词正文只能由主 AgentLoop 的受限任务生成（见 NarrationAgent.js /
// narrationTools.js），本模块不再持有 chat，任何内部路径都不调用模型。这里保留的是
// 可复用、可单测的确定性部分，由工具与 agent 兜底共同引用：
//   - assembleNarrationMaterial：上下文装配（场合、分级知识、表达偏好、最近串词、长度边界）
//   - deriveNarrationSituation：确定性场合模型（为什么现在是这首、这回合谁开口）
//   - lyricExcerpt / partOfDay / narrationLengthBounds：歌词节选、当地时段、按场合的长度
//   - narrationDefect / narrationRuleFeedback：提交校验与可纠正的规则提示
//   - buildFallbackTrackNarration：一句可核实事实的确定性兜底
//   - resolveTrackNarrationAsset：已持久化串词的 TTS 资产重解析（不调模型）

import { normalizePerformance, toPlainText } from '../tts/performance/markers.js';
import { synthesizeWithin } from '../tts/boundedSynthesis.js';
import { NARRATION_EXECUTION_LIMITS } from '../llmTasks.js';

const cleanText = value => String(value ?? '').trim();
const cleanList = value => (Array.isArray(value) ? value : []).map(cleanText).filter(Boolean).slice(0, 4);
// 撤歌后的空位（songId 为 null）不是“上一首歌”：标题不得进入串词素材或兜底 TTS。
export const songPredecessor = value => value?.songId === null ? null : value;

function narrationFacts(track, context = {}) {
  const song = context.trackFacts?.song || {};
  const artist = context.trackFacts?.artist || {};
  const year = Number(song.year);
  return {
    album: cleanText(track.album),
    year: Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null,
    genre: cleanText(song.genre),
    mood: cleanText(song.mood),
    tempo: cleanText(song.tempo),
    language: cleanText(song.language),
    instruments: cleanList(song.instruments),
    themes: cleanList(song.themes),
    scenes: cleanList(song.scenes),
    artistGenre: cleanText(artist.genre),
    artistRegion: cleanText(artist.region),
  };
}

export function sentenceCount(text) {
  return (cleanText(text).match(/[。！？!?](?:[”’』】》"]*)/gu) || []).length;
}

// ── 场合模型 ────────────────────────────────────────────────────────────────
// 串词先弄清“为什么现在是这首、刚才发生了什么、是不是这回合唯一开口的人”。全部由
// 结构化字段确定，不靠关键词，也不随机：相同输入一定得到相同场合。

export const NARRATION_OCCASIONS = Object.freeze(['probe', 'recommendation', 'named_request',
  'chosen_for_request', 'resumed', 'continuation']);
const REQUEST_OCCASIONS = new Set(['named_request', 'chosen_for_request']);
const LISTENER_LATEST_LIMIT = 200;

const PARTS_OF_DAY = [[5, '深夜'], [8, '清晨'], [11, '上午'], [13, '中午'], [17, '下午'], [19, '傍晚'], [23, '夜里'], [24, '深夜']];
const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 当地时段（只给时段，不给精确时间）；时区不可用时退回本机时区。 */
export function partOfDay(now = new Date(), timeZone = localTimeZone()) {
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now));
  } catch {
    hour = new Date(now).getHours();
  }
  return PARTS_OF_DAY.find(([until]) => hour < until)?.[1] || '深夜';
}

function occasionOf({ selection, tasteProbe, recommendation }) {
  const reason = cleanText(selection?.reason);
  if (tasteProbe) return 'probe';
  if (recommendation) return 'recommendation';
  if (reason === 'user_request') return cleanText(selection?.mode) === 'exact' ? 'named_request' : 'chosen_for_request';
  if (reason === 'listening_session_resumed') return 'resumed';
  return 'continuation';
}

/**
 * 这回合聊天有没有出声：点歌提交被接受后，聊天只落一条带同一 requestId 的模板确认、不出声，
 * 串词就是对听众最后一条消息的回答。只看结构——听众最后一条之后只有本次请求的回合、没有别的
 * 主持人发言；之后已有串词说明这次请求已经回应过（followsInRequest）。拿不准就是 false。
 */
function requestTurnShape(recentConversation, requestId) {
  const turns = Array.isArray(recentConversation) ? recentConversation : [];
  let lastUser = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === 'user') { lastUser = index; break; }
  }
  if (lastUser < 0 || !requestId) return { confirmed: false, introduced: false, listener: null };
  const after = turns.slice(lastUser + 1);
  const introduced = after.some(turn => turn?.presentation === 'track_intro');
  const chat = after.filter(turn => turn?.presentation !== 'track_intro');
  const confirmed = chat.length > 0 && chat.every(turn => turn?.role !== 'user' && turn?.requestId === requestId);
  return { confirmed, introduced, listener: cleanText(turns[lastUser].text).slice(0, LISTENER_LATEST_LIMIT) || null };
}

// 时段只在“时间有意义”时给：每条都给，模型就会每条都说“夜里”。三种时机——本次收听的第一条、
// 听众这回合打了招呼、久别之后。问候是唯一按固定开头词表看听众原话的地方，只决定给不给时段。
const LONG_PAUSE_MS = 2 * 60 * 60_000;
const GREETING_OPENER = /^(?:早(?:上好|安|啊|呀|[，,。!！\s]|$)|上午好|中午好|下午好|晚上好|晚安|你好|您好|嗨|哈喽|hi\b|hello\b|hey\b|good\s+(?:morning|afternoon|evening|night)\b)/iu;

function needsTimeCue({ occasion, voiceOfTurn, listener, previousTrack, recentConversation, now }) {
  const turns = Array.isArray(recentConversation) ? recentConversation : [];
  if (!previousTrack && !turns.some(turn => turn?.presentation === 'track_intro')) return true;
  if (voiceOfTurn && GREETING_OPENER.test(cleanText(listener))) return true;
  if (occasion === 'resumed') return true;
  const newest = Math.max(...turns.map(turn => Number(turn?.createdAt)).filter(Number.isFinite));
  return Number.isFinite(newest) && new Date(now).getTime() - newest >= LONG_PAUSE_MS;
}

/** 串词场合：occasion + 附带信号。纯函数，不读状态、不随机。 */
export function deriveNarrationSituation({ selection = null, track = {}, previousTrack = null, recentConversation = [],
  tasteProbe = null, recommendation = null, companionModeLabel = null, now = new Date(), timeZone } = {}) {
  const occasion = occasionOf({ selection, tasteProbe, recommendation });
  const shape = REQUEST_OCCASIONS.has(occasion)
    ? requestTurnShape(recentConversation, cleanText(track?.requestId))
    : { confirmed: false, introduced: false, listener: null };
  const voiceOfTurn = shape.confirmed && !shape.introduced;
  return {
    occasion,
    voiceOfTurn,
    followsInRequest: shape.confirmed && shape.introduced,
    listenerLatest: voiceOfTurn ? shape.listener : null,
    ...needsTimeCue({ occasion, voiceOfTurn, listener: shape.listener, previousTrack, recentConversation, now })
      ? { partOfDay: partOfDay(now, timeZone || localTimeZone()) } : {},
    companionMode: cleanText(companionModeLabel) || null,
    softPreference: cleanText(selection?.softPreferences) || null,
    recommendedBy: recommendation ? { name: recommendation.recommender, publicNote: recommendation.publicNote || null } : null,
    probe: tasteProbe ? (cleanText(tasteProbe.topic || tasteProbe.label) || true) : null,
  };
}

// ── 长度：按场合给目标范围；机械校验只检查下限和异常上限（650 字 / 6 句） ──────────
const SHORT_BOUNDS = { minChars: 12, minSentences: 1, maxChars: 120, maxSentences: 3 };
const FULL_BOUNDS = { minChars: 20, minSentences: 1, maxChars: 200, maxSentences: 4 };

export function narrationLengthBounds(situation, { modeId = null, chatIntroduced = false } = {}) {
  const short = ['named_request', 'continuation', 'resumed'].includes(situation?.occasion)
    || situation?.followsInRequest === true || chatIntroduced === true;
  const bounds = { ...(short ? SHORT_BOUNDS : FULL_BOUNDS) };
  if (modeId === 'occasional') {
    bounds.maxChars = Math.min(bounds.maxChars, 100);
    bounds.maxSentences = Math.min(bounds.maxSentences, 2);
  } else if (modeId === 'conversational') {
    bounds.maxChars = 180;
    bounds.maxSentences = 4;
  }
  return bounds;
}

// ── 歌词节选：有界、去时间轴与署名、去重叠句；是不可信数据，不是指令 ──────────────
const LYRIC_EXCERPT_LIMIT = 400;
const LYRIC_CREDIT = /^(?:作词|作曲|编曲|词|曲|制作人?|监制|混音|母带|录音|和声|配唱|出品|发行|企划|统筹|OP|SP|lyrics?|composer|arranger|producer)\s*[:：]/iu;
const LYRIC_PLACEHOLDER = /纯音乐|没有填词|instrumental|暂无歌词/iu;

// 歌词节选的用法：它是判断的证据，不是串词的内容。随素材一起给模型，免得它把节选当剧情。
const LYRICS_USAGE_NOTE = '只用来支撑你自己的判断：不要复述歌词里的情节、人物和比喻，也不要把歌词当成串起来的引用。';

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
// 串词里出现成串的歌词（多段、合计十几字以上）几乎是同一件事：模型在按歌词白描剧情，
// 而不是给出自己的判断。歌词节选按行切分后逐行找最长公共段，互不包含的段才算一条；
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

// 一条短的引用是证据；两段以上合计十几字、或整段照搬十几字，就是在复述歌词内容。
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

/**
 * Bounded truthful degradation: one verifiable sentence. It is never assembled
 * from editorial templates and never claims listener preferences or intent.
 */
export function buildFallbackTrackNarration(track, { previousTrack = null } = {}) {
  const title = cleanText(track?.title) || '这首歌';
  const artist = cleanText(track?.artist) || '这位歌手';
  const previous = cleanText(songPredecessor(previousTrack)?.title);
  return previous && previous !== title
    ? `接下来是${artist}的《${title}》，接着刚才的《${previous}》。`
    : `接下来是${artist}的《${title}》。`;
}

function structuralFingerprint(text) {
  return cleanText(text).replace(/《[^》]*》/gu, '《歌名》').replace(/(?:19|20)\d{2}/gu, '年份')
  .replace(/[\s，。！？!?;；:：“”"'、]/gu, '');
}

function ngrams(text, size = 4) {
  const result = new Set();
  for (let index = 0; index <= text.length - size; index += 1) result.add(text.slice(index, index + size));
  return result;
}

function structurallyRepeats(text, recentIntroductions) {
  if (/听的时候可以留意旋律、人声和节奏|看看哪一处最贴近你现在的状态|把它放在这里，是想顺着/u.test(text)) return true;
  const candidate = ngrams(structuralFingerprint(text));
  if (!candidate.size) return false;
  return recentIntroductions.some(previous => {
    const existing = ngrams(structuralFingerprint(previous));
    const overlap = [...candidate].filter(value => existing.has(value)).length;
    const union = new Set([...candidate, ...existing]).size;
    return union > 0 && overlap / union >= .48;
  });
}

// Album attribution in any common wording. Metaphors like "把情绪收在皮肤底下" stay
// outside the claim check because 专辑/《 must directly follow the verb.
const ALBUM_CLAIM_PATTERN = /(?:收录[于在]|收[在进](?:专辑|《))/u;

function hasUnsupportedFactClaims(text, facts) {
  const years = [...cleanText(text).matchAll(/(?:19|20)\d{2}/gu)].map(match => Number(match[0]));
  if (years.some(year => year !== facts.year)) return true;
  if (!facts.year && /发行|发布|推出|问世|首发|年代/u.test(text)) return true;
  if (/获奖|榜单|排行榜|销量|创作于|写给|纪念|改编自|采样自|出道|首张|第.{0,2}张专辑/u.test(text)) return true;
  if (ALBUM_CLAIM_PATTERN.test(text) && (!facts.album || !cleanText(text).includes(facts.album))) return true;
  return false;
}

// 只有把一首歌说成“紧邻上一首”时才要求与实际前曲匹配（这是可证伪的播放事实）；
// 跨曲自由联想——开场那首、同歌手前后呼应、同一专辑、让人想起另一首歌——是正当的
// 编辑手法，不因身份不匹配而拒绝。过期 prepared 串词由运行时 previousSongId 守卫负责。
const IMMEDIATE_PREDECESSOR_PATTERN = /(?:上一首|上一曲|刚才(?:那首|的)|刚刚(?:那首|的)|接着刚才|接着上一首|延续(?:刚才|上一首))/u;

function predecessorReferenceDefect(text, track, facts, previousTrack) {
  const previousTitle = cleanText(previousTrack?.title);
  for (const sentence of cleanText(text).split(/[。！？!?]+/u)) {
    if (!IMMEDIATE_PREDECESSOR_PATTERN.test(sentence)) continue;
    for (const match of sentence.matchAll(/《([^》]{1,80})》/gu)) {
      const name = cleanText(match[1]);
      if (!name) continue;
      if (mentionsIdentity(name, track?.title) || (facts.album && mentionsIdentity(name, facts.album))) continue;
      if (!previousTitle || !mentionsIdentity(name, previousTitle)) return true;
    }
  }
  return false;
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
 * The only reasons a generated narration is replaced by the bounded fallback.
 * Rejection is reserved for real defects, never for using a core identity form.
 * Bounds follow the companion mode's length target when one is active.
 */
export function narrationDefect(candidate, { track, facts, recentIntroductions, recentConversation, minSentences, previousTrack, chatIntroduced, minChars = 20, recommendation = null, lyricExcerpt: lyrics = null, memories = [] }) {
  const text = String(candidate || '').trim();
  if (text.length < minChars) return 'too-short';
  if (text.length > NARRATION_MAX_CHARS) return 'too-long';
  const sentences = sentenceCount(text);
  if (sentences < minSentences || sentences > NARRATION_MAX_SENTENCES) return 'sentence-count';
  if (!mentionsIdentity(text, track.title)) return 'missing-title';
  if (!mentionsIdentity(text, track.artist)) return 'missing-artist';
  const attribution = recommendationDefect(text, recommendation);
  if (attribution) return attribution;
  if (/https?:\/\/|缓存|预热|命中|我(?:刚|已经).{0,8}(?:搜|找遍)/u.test(text)) return 'technical-or-claiming-search';
  // 歌名/歌手本身含这些英文词时不算外泄（例如一首叫 Knowledge 的歌）。
  const spoken = [track?.title, track?.artist].map(cleanText).filter(Boolean)
    .reduce((rest, name) => rest.split(name).join(' '), text);
  if (INTERNAL_DIRECTIVE_PATTERN.test(spoken)) return 'internal-directive';
  if (hasUnsupportedFactClaims(text, facts)) return 'unsupported-fact';
  if (predecessorReferenceDefect(text, track, facts, previousTrack)) return 'wrong-predecessor-reference';
  if (structurallyRepeats(text, recentIntroductions)) return 'repeated-boilerplate';
  if (recitesLyrics(text, lyrics, track)) return 'recites-lyrics';
  if (retellsLyrics(text, lyrics, track)) return 'retells-lyrics';
  const exempt = songTextExemption(track, lyrics);
  if (quotesMemory(text, memories, exempt)) return 'quotes-memory';
  if (echoesListenerText(text, recentConversation, exempt)) return 'echoes-listener';
  if (repeatsChatIntroduction(text, facts, chatIntroduced, recentConversation)) return 'repeats-chat-introduction';
  return null;
}

/**
 * 被拒绝时的可纠正提示：点名违反的规则（rule id 保持机器可读），并给出具体修改方向。
 * 规则与判据同源（narrationDefect），提示不允许新增正文之外的事实。
 */
export function narrationRuleFeedback(rule, task = {}, text = '') {
  const actualChars = String(text || '').trim().length;
  const actualSentences = sentenceCount(text);
  const minChars = Number(task.minChars) || 20;
  const minSentences = Number(task.minSentences) || 1;
  const maxChars = Number(task.maxChars) || 650;
  const title = cleanText(task.track?.title) || '本次歌曲';
  const artist = cleanText(task.track?.artist) || '本次歌手';
  const previousTitle = cleanText(task.previousTrack?.title);
  const recommender = cleanText(task.recommendation?.recommender) || '推荐人';
  const feedback = {
    'too-short': `正文太短：至少需要 ${minChars} 个字符，当前 ${actualChars} 个字符。`,
    'too-long': `正文太长：上限 ${maxChars} 个字符，当前 ${actualChars} 个字符。`,
    'sentence-count': `句子数量不合格：要求 ${minSentences}-${NARRATION_MAX_SENTENCES} 句，当前 ${actualSentences} 句。`,
    'missing-title': `必须准确出现本次歌名「${title}」的核心形式。`,
    'missing-artist': `必须准确出现本次艺人「${artist}」的核心形式。`,
    'technical-or-claiming-search': '正文出现了链接、缓存/预热/命中等技术词，或声称刚搜索过；不要向听众解释技术机制。',
    'internal-directive': '正文念出了内部的字段名或场合名；occasion、voiceOfTurn、knowledge 这些只是给你看的说明，不是台词，用自然的话重写。',
    'unsupported-fact': '正文声称了素材里没有核实的年份、获奖、榜单、创作背景或专辑归属；只能使用素材给出的曲库事实。',
    'wrong-predecessor-reference': previousTitle
      ? `承接“上一首/刚才那首”时只能指「${previousTitle}」，不能指向别的歌。`
      : '本次没有实际前曲：不得承接“上一首/刚才那首”。',
    'repeated-boilerplate': '正文与最近已说过的串词句式重复，或使用了被禁用的套话；换一个结构和角度。',
    'echoes-listener': '正文复述了听众说过的话；要回应就用你自己的话，歌名和歌手名照说没关系。',
    'recites-lyrics': '正文大段照念了歌词；最多引用一句短的，说这首歌在唱什么要用你自己的话。',
    'retells-lyrics': '正文把歌词当成了内容：多段歌词拼在一起讲情节，比照念更像复述。歌词只用来支撑你自己的判断——用你自己的话说你对这首歌的看法（它把情绪放在哪里、它不肯做什么、你为什么此刻放它），不要讲歌里发生了什么；引用最多留一句短的。',
    'quotes-memory': '正文照抄了关于听众的记忆原文；像朋友记得那样用你自己的话自然提起，不要念出摘要。',
    'missing-recommender': `这首是「${recommender}」推荐、由你来放的：正文要用你自己的话交代这个来源，并出现「${recommender}」。`,
    'self-claims-recommendation': `这首不是你挑的，是「${recommender}」推荐的：不要把它说成自己挑选或推荐的。`,
    'wrong-recommender': `推荐人是「${recommender}」：正文把推荐归给了别的成员，改正归属。`,
    'repeats-chat-introduction': '聊天里已经介绍过这张专辑，正文又重复报了同一张；换一个角度或简短带过基础信息。',
  }[rule] || '请按素材里的写作要求修正后重新提交。';
  return `违反校验规则「${rule}」：${feedback}`;
}

// 陪伴模式对自动串词的长度/表达目标。music_only 不产生自动串词；显式请求
// 落在默认目标上。目标只约束自动串词，不影响普通对话。
export const NARRATION_MODE_GUIDES = {
  occasional: '当前陪伴模式是「偶尔介绍」：串词保持克制，一两句就好，不超过约 100 个汉字。',
  conversational: '当前陪伴模式是「多聊一点」：可以多说一点与这首歌自然相关的联想，但不超过 4 句、约 180 个汉字。',
};

export const NARRATION_MAX_CHARS = 650;
export const NARRATION_MAX_SENTENCES = 6;

/**
 * 串词任务的确定性素材装配：场合、按优先级排列的知识（关于本曲的记忆与收藏、歌词节选、
 * 曲库事实、听感标签）、表达偏好、最近串词与长度边界。工具（brief/submit）与 NarrationAgent
 * 的兜底共用同一份装配，保证“模型看到的素材”和“机械校验的输入”永远同源。
 * 纯函数，不调模型、不读状态、不随机。
 */
export function assembleNarrationMaterial(effect = {}, context = {}, { now = new Date(), timeZone } = {}) {
  const track = effect.track || {};
  const narration = track.narration || {};
  const selection = narration.context || track.intro?.context || null;
  const facts = narrationFacts(track, context);
  const recentConversation = Array.isArray(context.recentConversation) ? context.recentConversation : [];
  const recentIntroductions = recentConversation.filter(turn => turn.presentation === 'track_intro')
  .map(turn => cleanText(turn.text)).filter(Boolean).slice(-3);
  const expressionPreferences = (Array.isArray(context.expressionPreferences) ? context.expressionPreferences : [])
    .map(row => cleanText(typeof row === 'string' ? row : row?.content)).filter(Boolean).slice(0, 5);
  // 推荐事实：推荐人与其公开说过的话；没有推荐人就不检查归属，降级句也不补归属。
  const recommender = cleanText(context.recommendation?.displayName);
  const recommendation = recommender ? {
    recommender,
    publicNote: cleanText(context.recommendation.publicNote) || null,
    otherNames: (Array.isArray(context.memberNames) ? context.memberNames : []).map(cleanText)
      .filter(name => name && name !== recommender).slice(0, 8),
  } : null;
  const modeId = cleanText(context.companionMode?.modeId) || null;
  const situation = deriveNarrationSituation({ selection, track, previousTrack: effect.previousTrack || null,
    recentConversation, tasteProbe: context.tasteProbe || null,
    recommendation, companionModeLabel: context.companionMode?.label, now, timeZone });
  // A host message that already introduced this very song suppresses a repeated
  // basic introduction (chat said it at 12:06; the auto narration must not redo it at 12:07).
  // 本次点歌那条不出声的模板确认（“《X》已经安排上了”）不是介绍，不算在内。
  const confirmedRequest = situation.voiceOfTurn || situation.followsInRequest ? cleanText(track.requestId) : null;
  const chatIntroduced = recentConversation.some(turn => turn?.role && turn.role !== 'user'
    && turn.presentation !== 'track_intro' && !(confirmedRequest && turn.requestId === confirmedRequest)
    && mentionsIdentity(turn.text || '', track.title));
  const songMemories = (Array.isArray(context.songKnowledge?.memories) ? context.songKnowledge.memories : [])
    .map(cleanText).filter(Boolean).slice(0, 3);
  const liked = typeof context.songKnowledge?.liked === 'boolean' ? context.songKnowledge.liked : null;
  const lyrics = lyricExcerpt(track.lyric);
  const bounds = narrationLengthBounds(situation, { modeId, chatIntroduced });
  const previousTrack = effect.previousTrack
    ? { title: cleanText(effect.previousTrack.title), artist: cleanText(effect.previousTrack.artist),
      songId: cleanText(effect.previousTrack.songId) || null }
    : null;
  return {
    track: { title: cleanText(track.title), artist: cleanText(track.artist),
      songId: cleanText(track.songId) || null, source: cleanText(track.source) || null },
    previousTrack,
    previousSongId: previousTrack?.songId || null,
    selection, facts, recentConversation, recentIntroductions, expressionPreferences,
    chatIntroduced, situation, modeId,
    knowledge: {
      aboutThisSong: { memories: songMemories, liked },
      lyrics: lyrics ? { untrusted: true, excerpt: lyrics, usage: LYRICS_USAGE_NOTE } : null,
      catalog: { album: facts.album || null, year: facts.year },
    },
    lyricExcerpt: lyrics,
    songMemories,
    modeGuide: NARRATION_MODE_GUIDES[modeId] || '',
    minChars: bounds.minChars,
    minSentences: bounds.minSentences,
    targetMaxChars: bounds.maxChars,
    targetMaxSentences: bounds.maxSentences,
    maxChars: NARRATION_MAX_CHARS,
    maxSentences: NARRATION_MAX_SENTENCES,
    fallbackText: buildFallbackTrackNarration(track, { previousTrack: effect.previousTrack }),
    voiceProfileId: context.person?.voiceProfileId || narration.voiceProfileId || track.voiceProfileId || null,
    tasteProbe: context.tasteProbe || null,
    lifeScene: context.lifeScene || null,
    recommendation,
  };
}

/**
 * 已持久化串词的 TTS 资产重解析：不调模型，只做有界合成。
 * 串词准备（正文生成 + 上下文 + 兜底）已迁到 NarrationAgent.prepareTrack；
 * 构造参数里的 chat / getContext / random 不再使用，外部装配若仍传入一律忽略。
 */
export class ProgramNarrationComposer {
  constructor({ synthesize = null, timeoutMs = NARRATION_EXECUTION_LIMITS.synthesisBudgetMs } = {}) {
    Object.assign(this, { synthesize, timeoutMs });
  }

  /**
   * Revalidate or recreate a persisted TTS asset without invoking the model.
   * 有 spokenText + performance 时按原表演重合成；spokenText 剥离标记后必须与 text 一致，
   * 否则（旧数据、被改过）一律回落纯 text、不带表演。
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
