// songTagRetrieval.js — 让结构化标签流入选歌
//
// 三件事：
//   1. filterCandidatesByTags：把内存候选池按 tags 精筛（scalar/boolean/range/array
//      + 艺人级 gender/genre/region）。无 tags 时原样返回（向后兼容）；无 tag 行的歌
//      在有 tag 过滤时被排除（不报错）。
//   2. annotateCandidate：给单首候选生成 `[mood:.. energy:.. ...]` 注解，喂给 LLM 的
//      候选池行用。占位/无行 → 返回空串（普通行）。
//   3. affect helpers：vibe → energy×valence 目标带；一组歌的平均 affect。供 WarmPool
//      用 affect band 区分 K 个 vibe 集子（diversity）。
//
// 实现选择：不拼动态 SQL，而是对候选（song_id 已知、规模 ~百级）逐首走 store 的
// 主键查（getTags / getArtistTags）+ JS 谓词。等价于 JOIN，但更安全（无注入面）、
// 跟内存候选池天然契合。

import { getSongTagStore, artistKeyOf, providerOf } from './songTagStore.js';

function candidateProvider(candidate) {
  return providerOf(candidate?.provider ?? candidate?.source);
}

// tags 对象里所有被识别的键（用来判断"是否真的有过滤条件"）
// language 单拎出来做 family 匹配（见 matchesLanguage），不进通用 scalar 精确循环。
const SCALAR_KEYS = ['mood', 'genre', 'tempo'];
const LANGUAGE_KEY = 'language';
const ARRAY_KEYS = ['themes', 'instruments'];
const RANGE_KEYS = ['minEnergy', 'maxEnergy', 'minValence', 'maxValence', 'minYear', 'maxYear'];
const ARTIST_KEYS = ['gender', 'artistGenre', 'region'];
const BOOL_KEYS = ['has_vocal'];
// 严格纯音乐：与 has_vocal 布尔过滤不同，未知人声状态不算纯音乐。
const STRICT_KEYS = ['vocal_state'];
const ALL_TAG_KEYS = [...SCALAR_KEYS, LANGUAGE_KEY, ...ARRAY_KEYS, ...RANGE_KEYS, ...ARTIST_KEYS, ...BOOL_KEYS, ...STRICT_KEYS];

// language family 匹配：
//   - 查 'chinese' → 命中 {chinese, mandarin, cantonese}（"想要中文歌"，国/粤/未细分都算）
//   - 查 'mandarin' → 只命中 mandarin（明确要国语：粤语 *和* 未细分的 chinese 都排除，
//     宁可漏掉没细分的，也不把粤语混进来——这正是"我要国语不要粤语"的诉求）
//   - 查 'cantonese' → 只命中 cantonese
//   - 其余（english/japanese/...）精确匹配
const CHINESE_FAMILY = new Set(['chinese', 'mandarin', 'cantonese']);
function matchesLanguage(want, have) {
  const w = String(want ?? '').trim().toLowerCase();
  if (!w) return true;
  const h = String(have ?? '').trim().toLowerCase();
  if (w === 'chinese') return CHINESE_FAMILY.has(h);
  return w === h;
}

function present(v) {
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** tags 里是否存在任何有效过滤条件。 */
export function hasAnyTagFilter(tags) {
  if (!tags || typeof tags !== 'object') return false;
  return ALL_TAG_KEYS.some(k => present(tags[k]));
}

function inRange(v, min, max) {
  const hasMin = present(min), hasMax = present(max);
  if (!hasMin && !hasMax) return true;
  if (v == null) return false; // 要求 range 但该歌无此值 → 排除
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  if (hasMin && n < Number(min)) return false;
  if (hasMax && n > Number(max)) return false;
  return true;
}

function eqCI(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/**
 * 一首候选歌是否满足 tags。需要 song_tags 行（无行 → false，即"无 tag 的歌被排除"）。
 * @param {object} candidate - 至少含 song_id（artist 可选，作 artist_key 兜底）
 * @param {object} tags
 * @param {SongTagStore} store
 * @returns {boolean}
 */
export function matchesTags(candidate, tags, store) {
  const songId = candidate?.song_id != null ? String(candidate.song_id) : '';
  if (!songId) return false;
  const t = store.getTags(songId, candidateProvider(candidate));
  if (!t) return false; // 无 tag 行 → 排除（不报错）

  // scalar 精确（大小写不敏感）
  for (const key of SCALAR_KEYS) {
    if (present(tags[key]) && !eqCI(t[key], tags[key])) return false;
  }

  // language：family 匹配（chinese 宽，mandarin/cantonese 精确）
  if (present(tags.language) && !matchesLanguage(tags.language, t.language)) return false;

  // boolean has_vocal
  if (present(tags.has_vocal)) {
    const want = tags.has_vocal === true || tags.has_vocal === 'true' || tags.has_vocal === 1;
    if (Boolean(t.has_vocal) !== want) return false;
  }

  // 严格纯音乐：只有“人声状态确证为否”才命中。未知/缺行/占位一律不匹配——
  // 把未知当纯音乐正是“背景里冒出人声”的根因；宁可靠级放宽后如实失败。
  if (present(tags.vocal_state)) {
    if (tags.vocal_state !== 'instrumental') return false;
    if (t.has_vocal !== false) return false;
  }

  // range
  if (!inRange(t.energy, tags.minEnergy, tags.maxEnergy)) return false;
  if (!inRange(t.valence, tags.minValence, tags.maxValence)) return false;
  if (!inRange(t.year, tags.minYear, tags.maxYear)) return false;

  // array LIKE 成员（要求所请求的每一项都被命中 = AND）
  for (const key of ARRAY_KEYS) {
    if (!present(tags[key])) continue;
    const need = (Array.isArray(tags[key]) ? tags[key] : [tags[key]]).map(x => String(x).toLowerCase());
    const have = Array.isArray(t[key]) ? t[key].map(x => String(x).toLowerCase()) : [];
    const ok = need.every(n => have.some(h => h.includes(n)));
    if (!ok) return false;
  }

  // 艺人级（LEFT JOIN artist_tags）
  if (present(tags.gender) || present(tags.artistGenre) || present(tags.region)) {
    const ak = t.artist_key || artistKeyOf(candidate.artist);
    const at = ak ? store.getArtistTags(ak) : null;
    if (!at) return false; // 艺人未打标 → 排除（不报错）
    if (present(tags.gender) && !eqCI(at.gender, tags.gender)) return false;
    if (present(tags.artistGenre) && !eqCI(at.genre, tags.artistGenre)) return false;
    if (present(tags.region) && !eqCI(at.region, tags.region)) return false;
  }

  return true;
}

/**
 * 按 tags 过滤候选池。无有效 tags → 原样返回（向后兼容）。
 * @param {Array} candidates
 * @param {object} [tags]
 * @param {SongTagStore} [store]
 * @returns {Array}
 */
export function filterCandidatesByTags(candidates, tags, store = getSongTagStore()) {
  if (!Array.isArray(candidates)) return [];
  if (!hasAnyTagFilter(tags)) return candidates;
  return candidates.filter(c => matchesTags(c, tags, store));
}

// ---- 注解 ----

function round1(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}
function softLabel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n >= 0.66 ? 'soft' : n <= 0.33 ? 'hard' : 'mid';
}

/**
 * 给候选歌生成 `[mood:.. energy:.. ...]` 注解。无 tag 行 / 占位(confidence<=0) → ''。
 * @param {object} candidate - 含 song_id
 * @param {SongTagStore} [store]
 * @returns {string}
 */
export function annotateCandidate(candidate, store = getSongTagStore()) {
  const songId = candidate?.song_id != null ? String(candidate.song_id) : '';
  if (!songId) return '';
  const t = store.getTags(songId, candidateProvider(candidate));
  if (!t || Number(t.confidence) <= 0) return ''; // 占位/无行 → 普通行

  const parts = [];
  if (t.mood) parts.push(`mood:${t.mood}`);
  if (t.energy != null) parts.push(`energy:${round1(t.energy)}`);
  if (t.valence != null) parts.push(`valence:${round1(t.valence)}`);
  if (t.has_vocal === false) parts.push('vocal:no');
  else if (t.vocal_softness != null) parts.push(`vocal:${softLabel(t.vocal_softness)}`);
  if (t.language) parts.push(`lang:${t.language}`);
  if (t.year) parts.push(`year:${t.year}`);
  if (t.genre) parts.push(`genre:${t.genre}`);
  return parts.length ? `[${parts.join(' ')}]` : '';
}

/**
 * 给一行候选文本追加注解（注解为空则原样返回）。
 * @param {string} line - 形如 "- 晴天 — 周杰伦 [ncm]"
 * @param {object} candidate
 * @param {SongTagStore} [store]
 */
export function appendAnnotation(line, candidate, store = getSongTagStore()) {
  const ann = annotateCandidate(candidate, store);
  return ann ? `${line} ${ann}` : line;
}

// ---- affect bands（WarmPool diversity）----

// vibe → 目标 energy×valence 带。让 K 个集子落在 affect grid 不同区域，
// 不至于 3 个集子都挤在"低能量"一坨。
export const VIBE_AFFECT_BANDS = {
  'safe-pick':     { minEnergy: 0.0, maxEnergy: 0.4, label: 'calm' },
  'mid-pick':      { minEnergy: 0.35, maxEnergy: 0.7, label: 'steady' },
  'surprise-pick': { minEnergy: 0.6, maxEnergy: 1.0, label: 'energetic' },
};

export function affectBandForVibe(vibe) {
  return VIBE_AFFECT_BANDS[vibe] || null;
}

/**
 * 一组歌的平均 affect（只统计有 energy/valence 标签的歌）。
 * @param {Array} songs - 每首含 song_id（或 q/title 无法对齐时跳过）
 * @param {SongTagStore} [store]
 * @returns {{ energy: number|null, valence: number|null, tagged: number, total: number }}
 */
export function affectProfile(songs, store = getSongTagStore()) {
  const list = Array.isArray(songs) ? songs : [];
  let eSum = 0, eN = 0, vSum = 0, vN = 0, tagged = 0;
  for (const s of list) {
    const songId = s?.song_id != null ? String(s.song_id) : '';
    if (!songId) continue;
    const t = store.getTags(songId, candidateProvider(s));
    if (!t || Number(t.confidence) <= 0) continue;
    tagged += 1;
    if (t.energy != null) { eSum += Number(t.energy); eN += 1; }
    if (t.valence != null) { vSum += Number(t.valence); vN += 1; }
  }
  return {
    energy: eN ? Math.round((eSum / eN) * 100) / 100 : null,
    valence: vN ? Math.round((vSum / vN) * 100) / 100 : null,
    tagged,
    total: list.length,
  };
}
