// tasteSignals.js — claim 信号 → 候选排序偏置（add-taste-probe-signals）
//
// 纯函数模块：把反思洞察里的 `claim:music.<attribute>.<value>` 解析成结构化信号，
// 再对单首候选计算口味项。综合打分（selectionScoring.js）用 tasteScoreForTrack 的有界和；
// 关闭打分时旧的分层排序仍用 tasteBiasForTrack 在层内打破平局。负向 claim 只降权，
// 永不排除——"只改排序不改候选集"的契约在这里继续成立。

// 归一化：& 读作 and → n（R&B → rnb），其余非字母数字汉字剔除（hip-hop → hiphop）。
const normalizePart = value => String(value || '').toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');

const TASTE_SIGNAL_PREFIX = 'music.';
// album 按「歌手 + 专辑名」文本身份；style 同 genre；instrumental 看人声标签；tempo 看 slow/mid/fast。
const TASTE_SIGNAL_ATTRIBUTES = ['genre', 'artist', 'mood', 'language', 'album', 'style', 'instrumental', 'tempo'];
const TASTE_SIGNAL_MIN_CONFIDENCE = 0.25;
const TASTE_BIAS_CAP = 1.5;
const TASTE_OCCURRENCE_CAP = 5;
export const TASTE_SCORE_CLAMP = 3;
const INSTRUMENTAL_FALSE = new Set(['false', 'no', 'vocal', '0']);

export function tasteSignalsDisabled() {
  return process.env.MUSIC_TASTE_SIGNALS_DISABLED === '1';
}

/** 一条 reflection-insight 行 → 结构化音乐信号；非音乐/过弱/无极性返回 null。 */
export function tasteSignalFromInsight(row) {
  if (!row) return null;
  const key = (String(row.tags || '').match(/(?:^|,)claim:([^,]+)/) || [])[1];
  if (!key || !key.startsWith(TASTE_SIGNAL_PREFIX)) return null;
  const parts = key.split('.');
  if (parts.length < 3) return null;
  const attribute = parts[1];
  const value = parts.slice(2).join('.');
  if (!TASTE_SIGNAL_ATTRIBUTES.includes(attribute)) return null;
  // instrumental 的值是 true/false 这类布尔字样，不按两字门限过滤。
  if (attribute !== 'instrumental' && normalizePart(value).length < 2) return null;
  let polarity = 'positive';
  let occurrences = 1;
  try {
    const evidence = JSON.parse(row.evidence || '{}');
    polarity = evidence.claim?.polarity === 'negative' ? 'negative' : 'positive';
    occurrences = Number(evidence.occurrences) || 1;
  } catch { /* plain insight, keep defaults */ }
  const confidence = Math.max(0, Number(row.confidence) || 0);
  if (confidence < TASTE_SIGNAL_MIN_CONFIDENCE) return null;
  return {
    key, attribute, value, polarity, confidence,
    weight: Math.min(TASTE_BIAS_CAP, confidence * Math.min(occurrences, TASTE_OCCURRENCE_CAP)),
  };
}

/** 候选是否命中信号。genre/style 允许 R&B↔rnb 这类归一化等价；无标签行不算命中，也不受惩罚。 */
export function trackMatchesSignal(signal, track, tagStore) {
  if (!signal?.value || !track) return false;
  const want = normalizePart(signal.value);
  if (signal.attribute === 'instrumental') {
    let song = null;
    try { song = tagStore?.getTags?.(track.songId, track.source || track.provider) || null; } catch { return false; }
    const vocal = song?.has_vocal ?? song?.hasVocal;
    const instrumental = song?.vocal_state === 'instrumental' || vocal === false || vocal === 0;
    const known = instrumental || vocal === true || vocal === 1 || song?.vocal_state === 'vocal';
    if (!known) return false;
    return INSTRUMENTAL_FALSE.has(want) ? !instrumental : instrumental;
  }
  if (want.length < 2) return false;
  if (signal.attribute === 'artist') {
    const have = normalizePart(track.artist);
    return have.length >= 2 && (have.includes(want) || want.includes(have));
  }
  if (signal.attribute === 'album') {
    // 文本身份：歌手 + 专辑名（与专辑分散同口径）；只写专辑名的 claim 也按专辑名完全相等匹配。
    const album = normalizePart(track.album);
    if (album.length < 2) return false;
    return want === `${normalizePart(track.artist)}${album}` || want === album;
  }
  let song = null;
  try { song = tagStore?.getTags?.(track.songId, track.source || track.provider) || null; } catch { return false; }
  if (!song) return false;
  const related = value => {
    const have = normalizePart(value);
    return have.length >= 2 && (have === want || have.includes(want) || want.includes(have));
  };
  if (signal.attribute === 'genre' || signal.attribute === 'style') {
    const genres = [...(Array.isArray(song.genres) ? song.genres : []), song.genre];
    return genres.some(related);
  }
  if (signal.attribute === 'mood') return related(song.mood);
  if (signal.attribute === 'language') return related(song.language);
  if (signal.attribute === 'tempo') return Boolean(song.tempo) && normalizePart(song.tempo) === want;
  return false;
}

/** 综合打分的口味项：正 claim 加分、负 claim 减分，总和夹在 ±TASTE_SCORE_CLAMP。 */
export function tasteScoreForTrack(signals, track, tagStore, clamp = TASTE_SCORE_CLAMP) {
  const score = -tasteBiasForTrack(signals, track, tagStore);
  return Math.max(-clamp, Math.min(clamp, score));
}

/** 单首候选的偏置：正 claim 为负值（升序排序时提前），负 claim 为正值（靠后）。 */
export function tasteBiasForTrack(signals, track, tagStore) {
  let bias = 0;
  for (const signal of signals || []) {
    if (trackMatchesSignal(signal, track, tagStore)) {
      bias += signal.polarity === 'positive' ? -signal.weight : signal.weight;
    }
  }
  return bias;
}
