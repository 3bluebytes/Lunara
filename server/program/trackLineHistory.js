// trackLineHistory.js — line pass 继承的消息历史，交给模型前先拿掉只为选歌准备的东西。
//
// 选歌那一轮的 select_music 结果里，每首候选带着 features（打标模型推断的 tags、打分、口味命中）、
// 时长，还有一份只给选歌看的简报。选歌照常用它们；写串词时四十首候选的打分和简报只是噪声，
// 所以这里只在 line pass 的副本上去掉，歌名、歌手、专辑、序号和 host 自己写下的选歌理由都留着。
// 选中那几首的曲库标签和时长由素材（trackLineMaterial）单独列给它。
//
// Python 伪代码：
//   for message in history:
//       if message.role == "tool" and is_json(message.content):
//           message.content = drop_keys(parsed, SELECTION_ONLY_KEYS)

const SELECTION_ONLY_KEYS = new Set(['features', 'tags', 'duration', 'durationMs', 'score', 'scoreParts', 'tasteMatches',
  'freshness', 'familiarity', 'brief', 'priorTrackPerspectives']);
const OFFER_NOTE = '选歌时的候选清单（只列歌名）；选中的是之后提交的那几首。';

function withoutSelectionOnly(value) {
  if (Array.isArray(value)) return value.map(withoutSelectionOnly);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SELECTION_ONLY_KEYS.has(key))
    .map(([key, entry]) => [key, withoutSelectionOnly(entry)]));
}

/** 不改原数组；解析不了的工具结果原样保留。 */
export function historyForTrackLines(messages = []) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    if (message?.role !== 'tool' || typeof message.content !== 'string') return message;
    let parsed;
    try { parsed = JSON.parse(message.content); } catch { return message; }
    if (!parsed || typeof parsed !== 'object') return message;
    const stripped = withoutSelectionOnly(parsed);
    // 候选说明里在教怎么读 features 和简报，去掉它们后说明也换成一句。
    if (parsed.code === 'MUSIC_CANDIDATES_OFFERED') stripped.context = OFFER_NOTE;
    return { ...message, content: JSON.stringify(stripped) };
  });
}
