// candidateFeatures.js — offer 候选的可解释特征（ground-music-selection-in-taste D3）。
//
// 输入：select() 已经排好的候选窗口、本次选歌的标签视图、口味信号、近 14 天实播账本。
// 输出：与窗口一一对应的特征数组，随 offer 落库（供决策账本快照）并放进 select_music facts。
//
// Python 伪代码：
//   for track in window:
//       yield {"tags": tags_of(track) or None,      # None = 未标注，不等于不符合
//              "origin": origin_of(track),           # liked/playlist/daily/discovery/library
//              "freshness": {"lastPlayedDaysAgo": ..., "plays14d": ...},
//              "tasteMatches": ["+music.genre.rnb", "-music.artist.x"], ...}
//
// 特征只用于解释和挑选：不改变候选成员、不放宽硬约束，也不参与 commit 的 canonical 复核。
import { trackMatchesSignal } from './tasteSignals.js';

const FEATURE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_THEMES = 3;
const providerOf = track => String(track?.source || track?.provider || '').split(/[:-]/)[0];

/** 来源分类：收藏 > 自建歌单 > 每日推荐 > 发现 > 其它曲库。 */
export function candidateOrigin(track) {
  const origin = String(track?.candidateOrigin || track?.collectionOrigin || track?.source || '');
  if (track?.collectionKind === 'liked' || /:liked(?::|$)/.test(origin)) return 'liked';
  if (track?.collectionKind === 'playlist' || /:playlist(?::|$)/.test(origin)) return 'playlist';
  if (/:daily(?::|$)/.test(origin)) return 'daily';
  if (/:discovery(?::|$)/.test(origin)) return 'discovery';
  return 'library';
}

const text = value => (value == null || value === '' ? null : String(value));
const number = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** 标签行 → 模型可读的精简标签；没有标签记录时为 null（不是空对象）。 */
export function candidateTags(tagStore, track) {
  let row = null;
  try { row = tagStore?.getTags?.(track.songId, providerOf(track)) || null; } catch { row = null; }
  if (!row) return null;
  const genres = [...new Set([...(Array.isArray(row.genres) ? row.genres : []), row.genre].filter(Boolean).map(String))];
  return { language: text(row.language), genres, mood: text(row.mood), tempo: text(row.tempo),
    energy: number(row.energy), year: number(row.year),
    hasVocal: row.has_vocal == null ? (row.hasVocal == null ? null : Boolean(row.hasVocal)) : Boolean(row.has_vocal),
    themes: (Array.isArray(row.themes) ? row.themes : []).filter(Boolean).map(String).slice(0, MAX_THEMES) };
}

function playIndex(recentPlays, now) {
  const index = new Map();
  for (const row of Array.isArray(recentPlays) ? recentPlays : []) {
    const songId = String(row?.songId || row?.song_id || '');
    const ts = Number(row?.ts) || 0;
    if (!songId || ts < now - FEATURE_WINDOW_MS) continue;
    const key = `${providerOf(row)}:${songId}`;
    const entry = index.get(key) || { count: 0, lastTs: 0 };
    entry.count += 1;
    entry.lastTs = Math.max(entry.lastTs, ts);
    index.set(key, entry);
  }
  return index;
}

/**
 * @param window 已排序的候选窗口（cleanTrack 形态 + candidateOrigin/collectionKind）
 * @returns 与 window 等长的特征数组
 */
export function buildCandidateFeatures(window, { tagStore = null, signals = [], recentPlays = [], now = Date.now(),
  cadencePlan = null, probeTrack = null } = {}) {
  const plays = playIndex(recentPlays, now);
  return (Array.isArray(window) ? window : []).map(track => {
    const played = plays.get(`${providerOf(track)}:${track.songId}`);
    const tasteMatches = (Array.isArray(signals) ? signals : [])
      .filter(signal => trackMatchesSignal(signal, track, tagStore))
      .map(signal => `${signal.polarity === 'negative' ? '-' : '+'}${signal.key}`);
    return {
      tags: candidateTags(tagStore, track),
      origin: candidateOrigin(track),
      freshness: { lastPlayedDaysAgo: played ? Number(((now - played.lastTs) / 86_400_000).toFixed(1)) : null,
        plays14d: played?.count || 0 },
      ...(cadencePlan?.familiar ? { familiarity: cadencePlan.familiar(track.artist) ? 'familiar' : 'unfamiliar' } : {}),
      tasteMatches,
      ...(probeTrack && track === probeTrack ? { probe: true } : {}),
    };
  });
}
