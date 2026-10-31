// selectionScoring.js — 开放式选歌的综合打分（ground-music-selection-in-taste D5）。
//
// 调用顺序：
//   MusicSelectionService.select()（discovery / constrained / artist / 续播）
//     → 约束过滤后的候选池 → scoreCandidates() → orderScored()
//     → 单歌手封顶、熟悉度交错、试探置顶、专辑分散（都只重排）→ offer 窗口
//
// Python 伪代码：
//   def score(t):
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

export function freshnessTerm(entry, now, weights) {
  if (!entry) return weights.unplayed;
  const days = Math.max(0, (now - entry.lastTs) / DAY_MS);
  const repeat = Math.max(0, weights.playedBase - weights.perPlay * entry.count);
  return repeat + weights.recencyMax * Math.min(1, days / Math.max(1e-6, weights.recencyDays));
}

const ORIGIN_KEYS = { liked: 'originLiked', playlist: 'originPlaylist', daily: 'originDaily', discovery: 'originDiscovery' };
const round = value => Math.round(value * 1000) / 1000 || 0; // 去掉 -0，账本快照更干净

/**
 * @returns 与 pool 等长的 `{ track, index, cooldown, lastTs, score, parts }`；
 *   冷却期内的歌 score 为 null，parts 只含 freshness 之外的数字分项供账本快照。
 */
export function scoreCandidates(pool, { plays = new Map(), now = Date.now(), cooldownMs, signals = [], tagStore = null,
  preferredArtist = null, songHistory = new Map(), artistSkips = new Map(), weights = scoreWeights() } = {}) {
  const taste = Array.isArray(signals) && signals.length;
  return (Array.isArray(pool) ? pool : []).map((track, index) => {
    const played = plays.get(trackSongKey(track)) || null;
    if (played && now - played.lastTs <= cooldownMs) {
      return { track, index, cooldown: true, lastTs: played.lastTs, score: null, parts: { cooldown: 1 } };
    }
    const history = songHistory.get(trackSongKey(track));
    const skips = artistSkips.get(normalizeArtist(track.artist));
    const parts = {
      freshness: freshnessTerm(played, now, weights),
      taste: taste ? tasteScoreForTrack(signals, track, tagStore, weights.tasteClamp) : 0,
      preferredArtist: preferredArtist?.(track) ? weights.preferredArtist : 0,
      origin: weights[ORIGIN_KEYS[candidateOrigin(track)]] || 0,
      completion: history && history.completed >= COMPLETED_MIN
        && history.completed / (history.completed + history.skipped) >= COMPLETED_RATE ? weights.completedOften : 0,
      artistSkip: skips && skips.skipped >= SKIP_MIN
        && skips.skipped / (skips.skipped + skips.completed) >= SKIP_RATE ? -weights.artistSkipped : 0,
    };
    for (const key of Object.keys(parts)) parts[key] = round(parts[key]);
    const score = round(Object.values(parts).reduce((sum, value) => sum + value, 0));
    return { track, index, cooldown: false, lastTs: played?.lastTs || 0, score, parts };
  });
}

/** 非冷却按分数降序、同分按原池顺序；冷却组整体垫底，最早放过的在前。 */
export function orderScored(entries) {
  const fresh = entries.filter(entry => !entry.cooldown).sort((a, b) => b.score - a.score || a.index - b.index);
  const cooled = entries.filter(entry => entry.cooldown).sort((a, b) => a.lastTs - b.lastTs || a.index - b.index);
  return [...fresh, ...cooled];
}
