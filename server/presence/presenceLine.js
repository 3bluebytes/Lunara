// presenceLine.js — presence_line 的锁定素材与机械校验（纯函数，可单测）。
//
// 输入：一个已通过确定性资格判定的 moment、接地素材（presenceGrounding：选歌理由/最近聊天/这首歌的来历）、
//       她最近说过的几句话、当地时间段、说话角色的在场性格。
// 输出：buildPresenceTask → 冻结的任务（证据清单带稳定 ref，写作要求与校验规则同源；
//       task.sources 把短 ref 映射回账本来源，入账时写进 sourceRefs，不进 brief）；
//       presenceLineDefect(text, refs, task) → 违反的规则 id 或 null。
// 模型只能在这份任务上写一句话；校验不通过是可纠正失败，校验本身不调模型。
//
// Python 伪代码：
//   task = build_presence_task(moment, recent_lines=[...], day_part='深夜')
//   rule = presence_line_defect(text, ['moment', 'track'], task)   # None 表示通过

export const PRESENCE_LINE_MAX_HAN = 40;
export const PRESENCE_LINE_MAX_CHARS = 64;
export const PRESENCE_SIMILARITY_LIMIT = 0.9;
const RECENT_LINES = 3;

const clean = value => String(value ?? '').trim();

const MOMENT_FACTS = Object.freeze({
  session_open: '一场新的一起听刚开始，第一首歌已经响起。',
  boundary_without_intro: '刚换到下一首，这首没有安排串词。',
  track_completed: '上一首完整听完了。',
  track_skipped: '听众刚又跳过了一首。',
  queue_exhausted: '这一批歌放完了，播放停在这里。',
});

const MOMENT_GUIDES = Object.freeze({
  session_open: '刚坐到对方身边：可以接着你们最近聊的，或者说说你为什么从这首开始；不要报节目、不要问「想听什么」。',
  boundary_without_intro: '歌刚换：可以说说你挑这首的心思、接一句刚才的话题，或者提一下这首歌在你们之间的来历；不要介绍歌曲资料。',
  track_completed: '一首刚听完：可以接刚才的话题，或者说说这首对你们意味着什么；不要总结、不要推荐下一首。',
  track_skipped: '对方连着跳歌：可以轻轻问一句是不是不对味，不要道歉、不要承诺马上换。',
  queue_exhausted: '歌停了：一句自然的收尾或轻问要不要继续，不要替对方决定、不要说已经安排好了。',
});

// 选歌来源只来自提交时的 narration.context。事实用第二人称写给伙伴自己看（不假定性别）。
const PICKED_BY = Object.freeze({
  her_pick: '这首是你自己挑的，接着往下放。',
  her_pick_for_request: '这首是按听众之前说的方向挑的。',
  listener_request: '这首是听众点的。',
});

const TRACK_ROLES = Object.freeze({
  session_open: '正在放的这首',
  boundary_without_intro: '正在放的这首',
  track_completed: '刚听完的那首',
  track_skipped: '刚被跳过的那首',
  queue_exhausted: '最后放的那首',
});

/** 由 moment 证据组装带稳定 ref 的事实清单；只放可以由权威快照复核的东西。 */
export function presenceEvidence(moment, { dayPart = null, grounding = null } = {}) {
  const evidence = moment?.evidence || {};
  const items = [{ ref: 'moment', fact: MOMENT_FACTS[moment?.kind] || '' }];
  const track = evidence.track;
  if (track && (clean(track.title) || clean(track.artist))) {
    items.push({ ref: 'track', fact: TRACK_ROLES[moment.kind] || '相关的那首',
      title: clean(track.title) || null, artist: clean(track.artist) || null,
      ...(clean(track.album) ? { album: clean(track.album) } : {}) });
    if (PICKED_BY[track.origin]) items.push({ ref: 'picked_by', fact: PICKED_BY[track.origin] });
  }
  const pick = grounding?.pickReason;
  if (pick && (pick.listener || pick.reply || pick.direction)) {
    items.push({ ref: 'pick_reason', fact: pick.direction ? '你续播时给这一批定的方向。' : '这首是在这段对话之后放上的。',
      ...(pick.listener ? { listenerSaid: pick.listener } : {}), ...(pick.reply ? { youReplied: pick.reply } : {}),
      ...(pick.direction ? { yourDirection: pick.direction } : {}) });
  }
  (grounding?.recentChat || []).forEach((line, index) => {
    items.push({ ref: `chat_${index + 1}`, fact: '刚才的聊天（按时间先后）。', speaker: line.speaker, said: line.said });
  });
  const history = grounding?.songHistory;
  if (history?.timesBefore > 0) {
    items.push({ ref: 'song_history', fact: `这首之前在这个聊天里出现过 ${history.timesBefore} 次。`,
      ...(history.lastIntro ? { youSaidBefore: history.lastIntro } : {}) });
  }
  if (evidence.sameArtistAsPrevious === true) items.push({ ref: 'same_artist', fact: '和上一首是同一位歌手。' });
  else if (evidence.sameAlbumAsPrevious === true) items.push({ ref: 'same_album', fact: '和上一首来自同一张专辑。' });
  if (Number(evidence.consecutiveCompletions) >= 2) {
    items.push({ ref: 'completion_streak', fact: `已经连续完整听完 ${Number(evidence.consecutiveCompletions)} 首。` });
  }
  if (Number(evidence.consecutiveSkips) >= 2) {
    items.push({ ref: 'skip_streak', fact: `已经连续跳过 ${Number(evidence.consecutiveSkips)} 首。` });
  }
  const minutes = Math.floor(Number(evidence.listenedMs) / 60_000);
  if (minutes >= 5) items.push({ ref: 'listened', fact: `这一场一起听了大约 ${minutes} 分钟。` });
  if (evidence.longGapSinceVoice === true) items.push({ ref: 'quiet_while', fact: '你已经有一阵子没开口了。' });
  if (Number(evidence.gapMs) >= 6 * 60 * 60_000) items.push({ ref: 'long_gap', fact: '距离上一次一起听已经隔了很久。' });
  if (clean(dayPart)) items.push({ ref: 'day_part', fact: `现在是当地的${clean(dayPart)}。` });
  return items.filter(item => item.fact);
}

/** 当地时段：给「此刻」一点真实感，只用粗粒度词，不报钟点。 */
export function dayPartOf(nowMs, timeZone) {
  let hour = null;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs)));
  } catch { return null; }
  if (!Number.isFinite(hour)) return null;
  if (hour < 5) return '深夜';
  if (hour < 9) return '早上';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
}

export function presenceAcceptanceRules() {
  return [
    `只写一句话：不超过 ${PRESENCE_LINE_MAX_HAN} 个汉字，不换行，中间不出现第二个句号/问号/感叹号。`,
    'evidenceRefs 必须非空，并且只能取 evidence 里列出的 ref；这句话依据哪几条事实就填哪几条。',
    '提到的歌名（用《》）只能是 evidence 里出现过的歌，不得提别的歌。',
    '不得出现链接、内部术语（队列、模型、系统、工具、证据、缓存等）或技术机制。',
    '不得声称已经播放、已经切歌、已经换好或已经安排了什么。',
    '不得和 recentLines 里你最近说过的话几乎一样。',
  ];
}

export function presenceWritingGuide(momentKind) {
  return [
    MOMENT_GUIDES[momentKind] || '只为此刻真实发生的事开口。',
    '你知道的就是 evidence 里的这些：这首为什么在放、刚才聊了什么、这首歌在你们之间的来历。从这里出发，像你自己那样说。',
    '你不知道对方此刻在做什么、心情怎样，就别假装知道；也别为了有话说而给自己编一个反应。',
    '这是一起听歌时自然冒出的一句话，不是客服回复：不问候模板、不总结、不每次都关心对方状态，也不原样复述对方的话。',
    '没有想说的、或说出来会显得刻意，就选择 silence——安静陪着也是在场。',
  ];
}

/** 锁定任务：证据、写作要求与校验边界一次性冻结，随 toolContext 交给工具。 */
export function buildPresenceTask(moment, { recentLines = [], dayPart = null, personName = 'Lunara',
  grounding = null, temperament = null } = {}) {
  const evidence = presenceEvidence(moment, { dayPart, grounding });
  const sources = {};
  if (grounding?.pickReason?.source && evidence.some(item => item.ref === 'pick_reason')) sources.pick_reason = grounding.pickReason.source;
  (grounding?.recentChat || []).forEach((line, index) => { if (line.turnId) sources[`chat_${index + 1}`] = `chat:${line.turnId}`; });
  return Object.freeze({
    sessionId: moment.sessionId, personId: moment.personId, triggerKey: moment.triggerKey,
    momentKind: moment.kind, personName,
    evidence: Object.freeze(evidence.map(item => Object.freeze(item))),
    sources: Object.freeze(sources),
    yourWay: Object.freeze({ hint: clean(temperament?.hint), style: clean(temperament?.style) }),
    recentLines: Object.freeze(recentLines.map(clean).filter(Boolean).slice(-RECENT_LINES)),
  });
}

export function buildPresenceBrief(task) {
  return {
    moment: task.momentKind,
    ...(task.yourWay && (task.yourWay.hint || task.yourWay.style) ? { yourWay: task.yourWay } : {}),
    evidence: task.evidence,
    recentLines: task.recentLines,
    writingGuide: presenceWritingGuide(task.momentKind),
    acceptanceRules: presenceAcceptanceRules(),
    submitShape: '{ action: "speak", text, evidenceRefs } 或 { action: "silence" }',
  };
}

export const HAN = /\p{Script=Han}/gu;
export const INTERNAL_TERMS = /(队列|模型|系统|工具|证据|缓存|预热|命中|调度|触发|算法|token|queue|prompt|presence|moment|brief|txn|correlation)/i;
export const URL_LIKE = /(https?:\/\/|www\.|\.(com|cn|net|io)\b)/i;
export const PLAYBACK_CLAIMS = /(已经|已)(为你|给你|帮你)?(播放|播上|放上|切歌|切到|切好|换好|换成|换了|安排|排好|加进|加入|开始播)|正在为你(播放|切)|我(这就|马上)?(给你|帮你)?(切|换)(歌|到)/;
export const TITLE_MARK = /《([^》]{1,60})》/g;

function bigrams(text) {
  const chars = [...clean(text).replace(/[\s\p{P}]/gu, '')];
  const grams = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) grams.add(chars[index] + chars[index + 1]);
  if (!grams.size && chars.length) grams.add(chars.join(''));
  return grams;
}

/** 字符二元组 Dice 相似度（0..1）。 */
export function bigramSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

export const sentenceSegments = text => clean(text).split(/[。！？!?]+/u).map(part => part.trim()).filter(Boolean);

/** @returns 违反的规则 id；null 表示通过。规则 id 是封闭集合，便于 trace 统计。 */
export function presenceLineDefect(text, evidenceRefs, task) {
  const line = clean(text);
  if (!line) return 'empty_text';
  if (/[\r\n]/.test(line)) return 'multiple_sentences';
  if ((line.match(HAN) || []).length > PRESENCE_LINE_MAX_HAN || [...line].length > PRESENCE_LINE_MAX_CHARS) return 'too_long';
  if (sentenceSegments(line).length > 1) return 'multiple_sentences';
  const refs = Array.isArray(evidenceRefs) ? evidenceRefs.map(clean).filter(Boolean) : [];
  if (!refs.length) return 'missing_evidence';
  const known = new Set((task?.evidence || []).map(item => item.ref));
  if (refs.some(ref => !known.has(ref))) return 'unknown_evidence';
  if (URL_LIKE.test(line)) return 'url';
  if (INTERNAL_TERMS.test(line)) return 'internal_terms';
  if (PLAYBACK_CLAIMS.test(line)) return 'playback_claim';
  // 歌名只能是素材里出现过的：track 那首，或选歌理由/聊天/来历的原文里提到的。
  const knownText = (task?.evidence || []).flatMap(item => Object.values(item).filter(value => typeof value === 'string'));
  for (const [, title] of line.matchAll(TITLE_MARK)) {
    const name = clean(title);
    if (!name || !knownText.some(text => text.includes(name))) return 'entity_outside_evidence';
  }
  if ((task?.recentLines || []).some(previous => bigramSimilarity(line, previous) >= PRESENCE_SIMILARITY_LIMIT)) {
    return 'repeats_recent';
  }
  return null;
}

const RULE_FEEDBACK = Object.freeze({
  empty_text: '正文为空。想开口就写一句话；不想说就提交 action=silence。',
  multiple_sentences: '只能写一句话，不换行、不出现第二个句末标点。',
  too_long: `太长了：不超过 ${PRESENCE_LINE_MAX_HAN} 个汉字。`,
  missing_evidence: 'evidenceRefs 不能为空：填这句话依据的 evidence ref。',
  unknown_evidence: 'evidenceRefs 里有不存在的 ref：只能用 evidence 里列出的 ref。',
  url: '不要出现链接。',
  internal_terms: '不要出现内部术语或技术机制，用平常说话的方式。',
  playback_claim: '不要声称已经播放、切歌或安排好了什么。',
  entity_outside_evidence: '提到的歌名只能是 evidence 里出现过的歌。',
  repeats_recent: '和你最近说过的话几乎一样，换个说法，或者选择 silence。',
});

export function presenceRuleFeedback(rule) {
  return RULE_FEEDBACK[rule] || '没有通过校验。';
}
