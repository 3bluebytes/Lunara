// selectionBrief.js — 选歌简报（ground-music-selection-in-taste D1）。
//
// 调用顺序：
//   MusicSelectionService.select()（非 exact、非 preparation）
//     → context()（已做 memoryApplies + 撤回过滤）+ 角色审美 + 收听账本
//     → buildSelectionBrief() → select_music facts.brief（只给本轮选歌模型看）
//
// Python 伪代码：
//   sections = [request, feedback, schema, persona, signals, recent, plan]   # 按优先级
//   while length(render(sections)) > max_chars:
//       drop_last_line(first_truncatable(["recent", "signals", "persona", "plan"]))
//   return {"text": render(sections), "stats": counts_only(sections)}
//
// 简报正文只进入本轮模型上下文：不写 trace、日志、offer 存储或决策账本。
// 对外的 stats 只有各部分条数与总长度。
// 第 1–3 部分（本轮要求、显式反馈、口味画像）永不截断。

export const BRIEF_PRIORITY_NOTE = '选歌简报。优先级：本轮明确要求 > 显式反馈 > 口味画像 > 推断与近期观察。'
  + '冲突时以高优先级为准；简报只帮你挑序号，不放宽任何硬条件。';
const DEFAULT_MAX_CHARS = 6000;
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_PLAY_LIMIT = 10;
const TOP_ARTIST_LIMIT = 5;
const MEMORY_TEXT_MAX = 400;
const SCHEMA_TEXT_MAX = 2000;
const PERSONA_TEXT_MAX = 400;
// 截断顺序：优先级从低往高。第 1–3 部分不在这里，因此不会被截。
const TRUNCATION_ORDER = ['recent', 'signals', 'persona', 'plan'];

export const BRIEF_SECTION_KEYS = Object.freeze(['request', 'feedback', 'schema', 'persona', 'signals', 'recent', 'plan']);
const TITLES = {
  request: '本轮请求的条件',
  feedback: '用户的显式音乐反馈（保留原话）',
  schema: '口味画像',
  persona: '伙伴自己的审美（这是伙伴自己的审美，不是用户口味）',
  signals: '口味信号（这是推断，不是用户原话；置信度越低越可能不准）',
  recent: '近期收听事实（不含技术失败）',
  plan: '当前一起听计划与时间',
};

export function selectionBriefDisabled() {
  return process.env.MUSIC_BRIEF_DISABLED === '1';
}

export function briefMaxChars() {
  const raw = Number(process.env.MUSIC_BRIEF_MAX_CHARS);
  return Number.isFinite(raw) && raw >= 200 ? Math.floor(raw) : DEFAULT_MAX_CHARS;
}

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const parseJson = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
};

function requestLines(request) {
  if (!request) return [];
  const lines = [];
  const constraints = request.constraints || {};
  if (request.artist) lines.push(`硬条件：只要歌手「${clip(request.artist, 80)}」的歌`);
  const tags = Object.entries(constraints.tags || {}).filter(([, value]) => value != null && value !== '');
  if (tags.length) lines.push(`硬条件（标签）：${tags.map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : value}`).join('，')}`);
  if (constraints.excludeVersions?.length) lines.push(`硬条件：排除版本 ${constraints.excludeVersions.join('、')}`);
  if (constraints.requiredVersion) lines.push(`硬条件：只要 ${constraints.requiredVersion} 版本`);
  if (constraints.excludedArtists?.length) lines.push(`硬条件：不要这些歌手 ${constraints.excludedArtists.map(name => clip(name, 80)).join('、')}`);
  if (constraints.excludedSongIds?.length) lines.push(`硬条件：已排除 ${constraints.excludedSongIds.length} 首指定歌曲`);
  if (request.softPreferences) lines.push(`软偏好：${clip(request.softPreferences, 1000)}`);
  if (request.preferredArtists?.length) lines.push(`偏好歌手（软，可加权不强制）：${request.preferredArtists.join('、')}`);
  return lines;
}

function scopeLabel(row, now) {
  const evidence = parseJson(row.evidence);
  const policy = row.policy || evidence.policy || {};
  const parts = [row.namespace === 'station' ? '所有伙伴共享' : '你和用户之间'];
  if (policy.onlyConversationId) parts.push('仅限本聊天');
  const until = Number(policy.until || row.expiresAt) || 0;
  if (until > now) parts.push(`有效至 ${new Date(until).toISOString().slice(0, 10)}`);
  return `来源：用户亲口说的；范围：${parts.join('，')}`;
}

function feedbackLines(context, now) {
  const rows = [...(context.memories || []), ...(context.shared || [])]
    .filter(row => row?.source === 'user_explicit_feedback')
    .filter((row, index, all) => all.findIndex(other => other.id === row.id) === index);
  return rows.map(row => `- ${clip(row.content, MEMORY_TEXT_MAX)}（${scopeLabel(row, now)}）`);
}

function schemaLines(context) {
  const row = (context.memories || []).find(item => /(?:^|,)taste-schema(?:,|$)/.test(String(item?.tags || '')));
  return row ? [clip(row.content, SCHEMA_TEXT_MAX)] : [];
}

const ATTRIBUTE_LABELS = { genre: '流派', artist: '歌手', mood: '情绪', language: '语言' };
function signalLines(context) {
  return [...(context.tasteSignals || [])]
    .sort((a, b) => b.confidence - a.confidence || String(a.key).localeCompare(String(b.key)))
    .map(signal => `- ${signal.polarity === 'negative' ? '可能不喜欢' : '可能喜欢'}${ATTRIBUTE_LABELS[signal.attribute] || signal.attribute}「${clip(signal.value, 60)}」`
      + `（置信度 ${Number(signal.confidence).toFixed(2)}，${signal.polarity === 'negative' ? '-' : '+'}${signal.key}）`);
}

const OUTCOME_LABELS = { completed: '听完', skipped: '跳过', partial: '听了一部分', banned: '说过不想再听' };
const artistOfQuery = query => String(query || '').split(' — ').slice(1).join(' — ').trim();

/**
 * 近期收听事实：最近 10 首实播（播放账本）+ 近 30 天常听完 / 常跳过的歌手（reflection_song_stats）。
 * 技术失败与供应商失效不是听者行为，两路都排除。
 */
export function recentListeningLines({ plays = [], songStats = [], now = Date.now() } = {}) {
  const lines = [];
  const since = now - RECENT_WINDOW_MS;
  const tally = outcome => {
    const counts = new Map();
    for (const row of Array.isArray(songStats) ? songStats : []) {
      if (row?.outcome !== outcome || Number(row.lastSeenAt) < since) continue;
      const artist = artistOfQuery(row.songQuery);
      if (!artist) continue;
      counts.set(artist, (counts.get(artist) || 0) + (Number(row.count) || 0));
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_ARTIST_LIMIT);
  };
  const completed = tally('completed');
  const skipped = tally('skipped');
  if (completed.length) lines.push(`近 30 天常听完的歌手：${completed.map(([name, count]) => `${clip(name, 60)}（${count} 次）`).join('、')}`);
  if (skipped.length) lines.push(`近 30 天常跳过的歌手：${skipped.map(([name, count]) => `${clip(name, 60)}（${count} 次）`).join('、')}`);
  const recent = (Array.isArray(plays) ? plays : [])
    .filter(row => row && row.outcome !== 'technical_failure' && Number(row.ts) >= since && (row.title || row.artist))
    .sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, RECENT_PLAY_LIMIT);
  for (const row of recent) {
    const hours = Math.max(0, (now - Number(row.ts)) / 3_600_000);
    const ago = hours < 1 ? '1 小时内' : hours < 48 ? `${Math.round(hours)} 小时前` : `${Math.round(hours / 24)} 天前`;
    lines.push(`- 最近播放：${clip(row.artist, 60)}《${clip(row.title, 80)}》，${OUTCOME_LABELS[row.outcome] || '结果未记录'}，${ago}`);
  }
  return lines;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dayPart(hour) {
  if (hour < 5) return '深夜';
  if (hour < 9) return '清晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 22) return '晚上';
  return '深夜';
}

function planLines(context, now) {
  const lines = [];
  const plan = context.listening?.listeningPlan?.request || null;
  if (plan?.softPreferences) lines.push(`一起听计划的软偏好：${clip(plan.softPreferences, 400)}`);
  if (plan?.preferredArtists?.length) lines.push(`一起听计划偏好的歌手（软）：${plan.preferredArtists.join('、')}`);
  const date = new Date(now);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  lines.push(`现在是${WEEKDAYS[date.getDay()]}${dayPart(date.getHours())}（${time}）`);
  return lines;
}

const render = sections => [BRIEF_PRIORITY_NOTE, ...sections.filter(section => section.lines.length)
  .map(section => `【${TITLES[section.key]}】\n${section.lines.join('\n')}`)].join('\n\n');

/**
 * 唯一的简报生成函数：聊天、续播、手动下一首、预热选序号与群聊登记推荐都走这里。
 *
 * @param {{ request, context, personaTaste?: string, listening?: { plays?, songStats? }, now?: number, maxChars?: number }} input
 * @returns {{ text: string, stats: { sections: Record<string, number>, length: number, truncated: boolean } } | null}
 */
export function buildSelectionBrief({ request, context, personaTaste = '', listening = {}, now = Date.now(),
  maxChars = briefMaxChars() } = {}) {
  if (selectionBriefDisabled() || !context) return null;
  const sections = [
    { key: 'request', lines: requestLines(request) },
    { key: 'feedback', lines: feedbackLines(context, now) },
    { key: 'schema', lines: schemaLines(context) },
    { key: 'persona', lines: personaTaste ? [clip(personaTaste, PERSONA_TEXT_MAX)] : [] },
    { key: 'signals', lines: signalLines(context) },
    { key: 'recent', lines: recentListeningLines({ ...listening, now }) },
    { key: 'plan', lines: planLines(context, now) },
  ];
  let text = render(sections);
  let truncated = false;
  while (text.length > maxChars) {
    const victim = TRUNCATION_ORDER.map(key => sections.find(section => section.key === key))
      .find(section => section?.lines.length);
    if (!victim) break;
    victim.lines.pop();
    truncated = true;
    text = render(sections);
  }
  return { text, stats: { sections: Object.fromEntries(sections.map(section => [section.key, section.lines.length])),
    length: text.length, truncated } };
}

/**
 * 角色自己的音乐审美：人格文档的「## 我喜欢的音乐」小节（群聊自述 floorTools 读的也是它），
 * 没有该小节时退到「音乐审美：」行。记忆 v2 已移除 persona 类型，这里不再查记忆。
 * 生成器兜底的占位（「（待补充）」等）不算审美；读不到就是空串，简报省略这一项。
 */
export function personaMusicTaste({ entity = null } = {}) {
  const document = String(entity?.personaDocument || '');
  const section = (document.match(/(?:^|\n)##\s*我喜欢的音乐\s*\n([\s\S]*?)(?=\n##\s|$)/u) || [])[1]?.trim()
    || (document.match(/音乐审美[：:]\s*([^\n]+)/u) || [])[1]?.trim() || '';
  return /^（(?:待补充|未填写)/u.test(section) ? '' : section;
}
