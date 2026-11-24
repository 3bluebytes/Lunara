// selectionScoring.js — 开放式选歌的综合打分（ground-music-selection-in-taste D5）。
//
// 调用顺序：
//   MusicSelectionService.select()（discovery / constrained / artist / 续播）
//     → 约束过滤后的候选池 → scoreCandidates() → orderScored()
//     → 单歌手封顶、熟悉度交错、试探置顶、专辑分散（都只重排）→ offer 窗口
//
// Python 伪代码：
//   def score(t):
//       played = plays[(provider, song_id)] or plays_by[(title, artist)]  # 换了供应商的同名同歌手也算放过
//       if in_cooldown(t): return None                     # 冷却期单独垫底
//       s  = freshness(t)                                  # 14 天内没放过 3.0，放过的最多 2.2
//       s += clamp(taste(t), -3, 3)
//       s += 1.0 if preferred_artist(t) else 0
//       s += ORIGIN[origin(t)]                             # liked .6 / playlist .3 / daily .3 / discovery .3
//       s += .5 if song_completed_often(t) else 0          # 该角色听完 ≥2 次且听完率 ≥ 0.7
//       s -= .8 if artist_skipped_recently(t) else 0       # 近 7 天跳过 ≥3 次且跳过率 ≥ 0.6
//       return s
//   ranked = sorted(fresh, key=(-score, pool_index)) + sorted(cooldown, key=(last_play, pool_index))
//
// 打分只改顺序：不删候选、不放宽硬约束，也不用于 exact、用户给定目标、歌单顺序与整专顺序。
// 「跳过」只认 runtime 接受的用户主动跳过；technical_failure、superseded、partial 都不计入。
import { tasteScoreForTrack, TASTE_SCORE_CLAMP } from './tasteSignals.js';
import { candidateOrigin } from './candidateFeatures.js';
import { artistKeyOf } from '../songtags/songTagStore.js';

export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  // 新鲜度是权重最大的一项：没放过的歌恒高于任何放过的歌（放过的最多 playedBase + recencyMax）。
  unplayed: 3.0,
  playedBase: 2.0,
  perPlay: 0.4,
  recencyMax: 0.6,
  recencyDays: 7,
  tasteClamp: TASTE_SCORE_CLAMP,
  preferredArtist: 1.0,
  originLiked: 0.6,
  originPlaylist: 0.3,
  originDaily: 0.3,
  originDiscovery: 0.3,
  completedOften: 0.5,
  artistSkipped: 0.8,
  softPreference: 0.8,
  softPreferenceMax: 1.6,
  sessionSkipArtist: 1.2,
  sessionSkipMood: 0.8,
  sessionSkipMax: 1.6,
});

// 听完率与歌手跳过的门限：固定口径，不随权重覆盖变化。
const COMPLETED_MIN = 2;
const COMPLETED_RATE = 0.7;
const SKIP_MIN = 3;
const SKIP_RATE = 0.6;
export const ARTIST_SKIP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export function scoringDisabled() {
  return process.env.MUSIC_SCORING_DISABLED === '1';
}

/** `MUSIC_SCORE_WEIGHTS`（JSON）只覆盖已知的数字权重；格式错误时整体退回默认值。 */
export function scoreWeights(env = process.env) {
  const raw = env?.MUSIC_SCORE_WEIGHTS;
  if (!raw) return { ...DEFAULT_SCORE_WEIGHTS };
  try {
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SCORE_WEIGHTS };
    for (const [key, value] of Object.entries(parsed || {})) {
      if (Object.hasOwn(DEFAULT_SCORE_WEIGHTS, key) && Number.isFinite(Number(value))) merged[key] = Number(value);
    }
    return merged;
  } catch {
    return { ...DEFAULT_SCORE_WEIGHTS };
  }
}

const providerOf = value => String(value || '').split(/[:-]/)[0];
const songKey = (provider, songId) => `${providerOf(provider)}:${String(songId || '')}`;
const trackSongKey = track => songKey(track?.source || track?.provider, track?.songId || track?.song_id);
export const normalizeArtist = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const artistOfQuery = query => String(query || '').split(' — ').slice(1).join(' — ').trim();

/** 播放账本 → `provider:songId` 的 {count, lastTs}。 */
export function playIndex(recentPlays) {
  const plays = new Map();
  for (const row of Array.isArray(recentPlays) ? recentPlays : []) {
    const songId = String(row?.songId || row?.song_id || '');
    if (!songId) continue;
    const key = songKey(row.source || row.provider, songId);
    const entry = plays.get(key) || { count: 0, lastTs: 0 };
    entry.count += 1;
    entry.lastTs = Math.max(entry.lastTs, Number(row.ts) || 0);
    plays.set(key, entry);
  }
  return plays;
}

// 同名同歌手只用于排序（软降权），不是身份：不去括号后缀，现场版、重制版、别人的翻唱都对不上。
const normalizeText = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const titleArtistKey = (title, artist) => {
  const t = normalizeText(title), a = normalizeText(artist);
  return t && a ? `${t}\u0000${a}` : '';
};

/** 播放账本 → 归一后的「歌名 + 歌手」的 {count, lastTs, songKeys}；没有歌名或歌手的行不进索引。 */
export function sameTitleArtistIndex(recentPlays) {
  const index = new Map();
  for (const row of Array.isArray(recentPlays) ? recentPlays : []) {
    const key = titleArtistKey(row?.title, row?.artist);
    const songId = String(row?.songId || row?.song_id || '');
    if (!key || !songId) continue;
    const entry = index.get(key) || { count: 0, lastTs: 0, songKeys: new Set() };
    entry.count += 1;
    entry.lastTs = Math.max(entry.lastTs, Number(row.ts) || 0);
    entry.songKeys.add(songKey(row.source || row.provider, songId));
    index.set(key, entry);
  }
  return index;
}

/** 这首自己的播放记录，加上别的 (provider, songId) 放过的同名同歌手；后者存在时 crossSource 为真。 */
function effectivePlay(track, plays, sameTitleArtist) {
  const own = plays.get(trackSongKey(track)) || null;
  const same = sameTitleArtist.get(titleArtistKey(track?.title, track?.artist));
  if (!same || ![...same.songKeys].some(key => key !== trackSongKey(track))) return { played: own, crossSource: false };
  return { played: { count: Math.max(same.count, own?.count || 0), lastTs: Math.max(same.lastTs, own?.lastTs || 0) },
    crossSource: true };
}

/** 角色的累计听歌统计（reflection_song_stats）→ 每首歌的听完/跳过次数。只认这两种听者行为。 */
export function songHistoryIndex(songStats) {
  const index = new Map();
  for (const row of Array.isArray(songStats) ? songStats : []) {
    if (row?.outcome !== 'completed' && row?.outcome !== 'skipped') continue;
    const key = songKey(row.provider, row.songId);
    const entry = index.get(key) || { completed: 0, skipped: 0 };
    entry[row.outcome] += Number(row.count) || 0;
    index.set(key, entry);
  }
  return index;
}

/** 近 7 天的播放观察 → 每位歌手的听完/跳过次数。技术失败、partial、superseded 都不计入。 */
export function artistSkipIndex(observations, { now = Date.now(), windowMs = ARTIST_SKIP_WINDOW_MS } = {}) {
  const index = new Map();
  for (const row of Array.isArray(observations) ? observations : []) {
    if (row?.outcome !== 'completed' && row?.outcome !== 'skipped') continue;
    if (Number(row.at) < now - windowMs) continue;
    const artist = normalizeArtist(row.artist || artistOfQuery(row.songQuery));
    if (!artist) continue;
    const entry = index.get(artist) || { completed: 0, skipped: 0 };
    entry[row.outcome] += 1;
    index.set(artist, entry);
  }
  return index;
}

export function freshnessTerm(entry, now, weights, { completedOften = false } = {}) {
  if (!entry) return weights.unplayed;
  const days = Math.max(0, (now - entry.lastTs) / DAY_MS);
  const baseDays = Math.max(1e-6, weights.recencyDays);
  if (!completedOften) {
    const repeat = Math.max(0, weights.playedBase - weights.perPlay * entry.count);
    return repeat + weights.recencyMax * Math.min(1, days / baseDays);
  }
  // 高完播熟歌平滑衰落：减缓多次听完后的悬崖跌落并跨两段周期缓慢回升，仍严守低于未播基线。
  const baseRepeat = Math.max(0, weights.playedBase - weights.perPlay);
  const repeat = baseRepeat / (1 + 0.18 * Math.max(0, entry.count - 1));
  const recency = weights.recencyMax * Math.min(1, days / baseDays)
    + (weights.recencyMax * 0.5) * Math.min(1, Math.max(0, days - baseDays) / baseDays);
  return Math.min(weights.unplayed - 0.15, repeat + recency);
}

const SOFT_SYNONYM_GROUPS = Object.freeze({
  genres: [
    ['r&b', 'rnb', '节奏布鲁斯'], ['jazz', '爵士', 'bossa', 'bossa nova', '波萨诺瓦'], ['pop', '流行'], ['folk', '民谣'], ['rock', '摇滚'],
    ['electronic', '电子', 'synth'], ['classical', '古典'], ['indie', '独立'], ['soul', '灵魂乐'],
    ['blues', '蓝调'], ['rap', 'hip-hop', 'hiphop', '说唱', '嘻哈'], ['post-rock', '后摇'],
    ['guofeng', '古风'], ['acoustic', '原声', '不插电'], ['city pop', 'citypop'], ['lo-fi', 'lofi'],
  ],
  moods: [
    ['calm', '平静', '安静', '静谧', '舒缓'], ['healing', '治愈', '疗愈'], ['warm', '温暖', '温柔'],
    ['nostalgic', '怀旧', '复古'], ['sad', '悲伤', '伤感', '郁闷', '忧郁', 'emo', '低落'],
    ['relaxed', '放松', '松弛', '慵懒', '微醺'], ['happy', '快乐', '欢快', '轻快', '开心', '明快'],
    ['romantic', '浪漫', '甜蜜', '暧昧'], ['lonely', '孤独', '寂寞'], ['energetic', '燃', '热血', '劲爆', '兴奋'],
  ],
  instruments: [
    ['钢琴', 'piano'], ['木吉他', '原声吉他', '吉他', 'guitar', 'acoustic'], ['贝斯', 'bass'],
    ['弦乐', '提琴', '大提琴', '小提琴', 'strings'], ['萨克斯', 'sax'], ['合成器', 'synth'],
    ['鼓', '鼓点', 'drums', '打击乐'],
  ],
  themes: [
    ['夜晚', '深夜', '夜里', '晚安', '睡前'], ['雨', '雨天', '下雨'], ['城市', '通勤'],
    ['旅行', '开车', '自驾'], ['清晨', '早上'], ['学习', '专注', '看书'],
  ],
  languages: [
    ['cantonese', '粤语', '港乐'], ['mandarin', 'chinese', '国语', '中文', '华语'],
    ['japanese', '日语', '日文', '日系'], ['english', '英语', '英文', '欧美'], ['korean', '韩语', '韩文'],
  ],
});

const NEGATED_DRUMS = /(?:少|不要|别|没|少一点|别太多).{0,6}(?:鼓|鼓点|drums|打击)/iu;
const NEGATED_LOUD = /(?:不要|别|不想要|别太).{0,4}(?:吵|激烈|闹|燃|快)/iu;
const LOW_ENERGY_CUES = ['安静', '轻柔', '慢', '慢板', '慢歌', '舒缓', '睡前', '发呆', '温和', '柔和', '静一点', '轻一点', '慵懒', '微醺'];
const HIGH_ENERGY_CUES = ['振奋', '燃', '提神', '运动', '跑步', '醒神', '劲爆', '动感', '欢快', '快歌'];
const MID_GROOVE_CUES = ['律动', '节奏感', '摇摆', 'groove', '散步', '中速'];
const WARM_VALENCE_CUES = ['温暖', '明亮', '治愈', '开心', '欢快', '明媚', '甜'];
const SAD_VALENCE_CUES = ['悲伤', '伤感', '低落', '难过', 'emo', '苦涩', '克制', '忧郁'];
const SOFT_VOCAL_CUES = ['轻柔', '温柔', '气声', '耳语', '细腻', '轻声'];
const INSTRUMENTAL_CUES = ['纯音乐', '无歌词', '无人声', '伴奏', '器乐'];
const FEMALE_CUES = ['女声', '女生', '女歌手'];
const MALE_CUES = ['男声', '男生', '男歌手'];
const GROUP_CUES = ['乐队', '组合'];

const containsAny = (text, terms) => terms.some(term => text.includes(term));
const groupMatched = (pref, candidates, values) => {
  const lowerValues = values.map(v => String(v || '').toLowerCase()).filter(Boolean);
  if (!lowerValues.length) return 0;
  let hits = 0;
  for (const group of candidates) {
    if (!group.some(term => pref.includes(term))) continue;
    if (lowerValues.some(val => group.some(term => val.includes(term) || term.includes(val)))) hits += 1;
  }
  return hits;
};

/** 确定性软偏好匹配分：仅读取已有 song_tags/artist_tags，未标曲目得 0 分，绝不修改候选池成员。 */
export function softPreferenceScoreForTrack(softPreferences, track, tagStore, weights = DEFAULT_SCORE_WEIGHTS) {
  const pref = String(softPreferences || '').trim().toLowerCase();
  if (!pref || !tagStore?.getTags) return 0;
  let tags = null;
  try { tags = tagStore.getTags(String(track?.songId ?? track?.song_id ?? ''), providerOf(track?.source || track?.provider)); } catch { tags = null; }
  if (!tags) return 0;
  let hits = 0;
  let misses = 0;
  const genres = [...(Array.isArray(tags.genres) ? tags.genres : []), tags.genre].filter(Boolean);
  hits += groupMatched(pref, SOFT_SYNONYM_GROUPS.genres, genres);
  if (tags.mood) hits += groupMatched(pref, SOFT_SYNONYM_GROUPS.moods, [tags.mood]);
  if (Array.isArray(tags.themes)) hits += groupMatched(pref, SOFT_SYNONYM_GROUPS.themes, tags.themes);
  if (tags.language) hits += groupMatched(pref, SOFT_SYNONYM_GROUPS.languages, [tags.language]);
  const instruments = Array.isArray(tags.instruments) ? tags.instruments.map(v => String(v).toLowerCase()) : [];
  if (instruments.length) {
    const drumNegated = NEGATED_DRUMS.test(pref);
    const activeInstruments = drumNegated
      ? SOFT_SYNONYM_GROUPS.instruments.filter(g => !g.includes('鼓'))
      : SOFT_SYNONYM_GROUPS.instruments;
    hits += groupMatched(pref, activeInstruments, instruments);
    if (drumNegated && instruments.some(item => /鼓|drums|打击/iu.test(item))) misses += 1;
  }
  const energy = Number.isFinite(Number(tags.energy)) ? Number(tags.energy) : null;
  if (NEGATED_LOUD.test(pref) || containsAny(pref, LOW_ENERGY_CUES)) {
    if ((energy != null && energy <= 0.45) || tags.tempo === 'slow') hits += 1;
    else if (energy != null && energy >= 0.75) misses += 1;
  } else if (containsAny(pref, HIGH_ENERGY_CUES)) {
    if ((energy != null && energy >= 0.65) || tags.tempo === 'fast') hits += 1;
    else if (energy != null && energy <= 0.3) misses += 1;
  }
  if (containsAny(pref, MID_GROOVE_CUES) && (tags.tempo === 'mid' || (energy != null && energy >= 0.4 && energy <= 0.72))) hits += 1;
  const valence = Number.isFinite(Number(tags.valence)) ? Number(tags.valence) : null;
  if (valence != null) {
    if (containsAny(pref, WARM_VALENCE_CUES) && valence >= 0.55) hits += 1;
    if (containsAny(pref, SAD_VALENCE_CUES) && valence <= 0.42) hits += 1;
  }
  const softness = Number.isFinite(Number(tags.vocal_softness ?? tags.vocalSoftness)) ? Number(tags.vocal_softness ?? tags.vocalSoftness) : null;
  if (softness != null && softness >= 0.6 && containsAny(pref, SOFT_VOCAL_CUES)) hits += 1;
  if (containsAny(pref, INSTRUMENTAL_CUES)) {
    if (tags.has_vocal === false || tags.hasVocal === false) hits += 1;
    else if (tags.has_vocal === true || tags.hasVocal === true) misses += 0.5;
  }
  try {
    const artistKey = tags.artist_key || (track?.artist ? artistKeyOf(track.artist) : '');
    const artistTags = artistKey ? tagStore.getArtistTags?.(artistKey) : null;
    if (artistTags?.gender === 'female' && containsAny(pref, FEMALE_CUES)) hits += 1;
    if (artistTags?.gender === 'male' && containsAny(pref, MALE_CUES)) hits += 1;
    if (artistTags?.gender === 'group' && containsAny(pref, GROUP_CUES)) hits += 1;
  } catch { /* ignore */ }
  const raw = hits * (weights.softPreference * 0.5) - misses * (weights.softPreference * 0.4);
  return Math.max(-weights.softPreferenceMax, Math.min(weights.softPreferenceMax, raw));
}

const energyBucketOf = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n <= 0.4) return 'low';
  if (n >= 0.7) return 'high';
  return 'mid';
};

/** 构造本次连续跳过轨迹的只读索引（仅 consecutiveSkips >= 2 生效，绝不含技术失败/切卡片）。 */
export function buildSessionSkipProfile(sessionSkips, tagStore = null) {
  if (!sessionSkips || Number(sessionSkips.consecutiveSkips) < 2) return null;
  const skippedTracks = Array.isArray(sessionSkips.tracks) ? sessionSkips.tracks : [];
  const artists = new Set();
  const moods = new Set();
  const energyCounts = new Map();
  for (const item of skippedTracks) {
    const artist = normalizeArtist(item?.artist);
    if (artist) artists.add(artist);
    if (!tagStore?.getTags || !item?.songId) continue;
    let tags = null;
    try { tags = tagStore.getTags(String(item.songId), providerOf(item.provider || item.source)); } catch { tags = null; }
    if (!tags) continue;
    const mood = String(tags.mood || '').trim().toLowerCase();
    if (mood) moods.add(mood);
    const bucket = energyBucketOf(tags.energy);
    if (bucket) energyCounts.set(bucket, (energyCounts.get(bucket) || 0) + 1);
  }
  const repeatedEnergyBucket = [...energyCounts.entries()].find(([, count]) => count >= 2)?.[0] || null;
  if (!artists.size && !moods.size && !repeatedEnergyBucket) return null;
  return { artists, moods, repeatedEnergyBucket };
}

function sessionSkipPenaltyForTrack(profile, track, tagStore, weights) {
  if (!profile) return 0;
  let penalty = 0;
  if (profile.artists.has(normalizeArtist(track?.artist))) penalty += weights.sessionSkipArtist;
  if (tagStore?.getTags && (profile.moods.size || profile.repeatedEnergyBucket)) {
    let tags = null;
    try { tags = tagStore.getTags(String(track?.songId ?? track?.song_id ?? ''), providerOf(track?.source || track?.provider)); } catch { tags = null; }
    if (tags) {
      const mood = String(tags.mood || '').trim().toLowerCase();
      if (mood && profile.moods.has(mood)) penalty += weights.sessionSkipMood;
      else if (profile.repeatedEnergyBucket && energyBucketOf(tags.energy) === profile.repeatedEnergyBucket) {
        penalty += weights.sessionSkipMood * 0.75;
      }
    }
  }
  return penalty > 0 ? -Math.min(weights.sessionSkipMax, penalty) : 0;
}

const ORIGIN_KEYS = { liked: 'originLiked', playlist: 'originPlaylist', daily: 'originDaily', discovery: 'originDiscovery' };
const round = value => Math.round(value * 1000) / 1000 || 0; // 去掉 -0，账本快照更干净

/**
 * @returns 与 pool 等长的 `{ track, index, cooldown, lastTs, score, parts }`；
 *   冷却期内的歌 score 为 null，parts 只含 freshness 之外的数字分项供账本快照。
 */
export function scoreCandidates(pool, { plays = new Map(), sameTitleArtist = new Map(), now = Date.now(), cooldownMs,
  signals = [], tagStore = null, preferredArtist = null, songHistory = new Map(), artistSkips = new Map(),
  likedTrackKeys = null, softPreferences = '', sessionSkips = null, weights = scoreWeights() } = {}) {
  const taste = Array.isArray(signals) && signals.length;
  const skipProfile = buildSessionSkipProfile(sessionSkips, tagStore);
  return (Array.isArray(pool) ? pool : []).map((track, index) => {
    const { played, crossSource } = effectivePlay(track, plays, sameTitleArtist);
    const marker = crossSource ? { sameTitleArtist: 1 } : {};
    if (played && now - played.lastTs <= cooldownMs) {
      return { track, index, cooldown: true, lastTs: played.lastTs, score: null, parts: { cooldown: 1, ...marker } };
    }
    const history = songHistory.get(trackSongKey(track));
    const completedOften = Boolean(history && history.completed >= COMPLETED_MIN
      && history.completed / (history.completed + history.skipped) >= COMPLETED_RATE);
    const skips = artistSkips.get(normalizeArtist(track.artist));
    const softPreference = softPreferences ? softPreferenceScoreForTrack(softPreferences, track, tagStore, weights) : 0;
    const sessionSkip = skipProfile ? sessionSkipPenaltyForTrack(skipProfile, track, tagStore, weights) : 0;
    const parts = {
      freshness: freshnessTerm(played, now, weights, { completedOften }),
      taste: taste ? tasteScoreForTrack(signals, track, tagStore, weights.tasteClamp) : 0,
      preferredArtist: preferredArtist?.(track) ? weights.preferredArtist : 0,
      origin: weights[ORIGIN_KEYS[candidateOrigin(track, likedTrackKeys)]] || 0,
      completion: completedOften ? weights.completedOften : 0,
      artistSkip: skips && skips.skipped >= SKIP_MIN
        && skips.skipped / (skips.skipped + skips.completed) >= SKIP_RATE ? -weights.artistSkipped : 0,
      ...(softPreference ? { softPreference } : {}),
      ...(sessionSkip ? { sessionSkip } : {}),
    };
    for (const key of Object.keys(parts)) parts[key] = round(parts[key]);
    const score = round(Object.values(parts).reduce((sum, value) => sum + value, 0));
    // 标记只进账本，不进分数：降权已经体现在 freshness 里。
    return { track, index, cooldown: false, lastTs: played?.lastTs || 0, score, parts: { ...parts, ...marker } };
  });
}

/** 非冷却按分数降序、同分按原池顺序；冷却组整体垫底，最早放过的在前。 */
export function orderScored(entries) {
  const fresh = entries.filter(entry => !entry.cooldown).sort((a, b) => b.score - a.score || a.index - b.index);
  const cooled = entries.filter(entry => entry.cooldown).sort((a, b) => a.lastTs - b.lastTs || a.index - b.index);
  return [...fresh, ...cooled];
}
