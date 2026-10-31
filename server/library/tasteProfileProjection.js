import { MemoryType, MemorySource, createMemoryRecord } from '../memory/types.js';

export function tasteProfileText(profile) {
  const artists = (profile?.artists || []).slice(0, 6).map(item => item.name).filter(Boolean);
  const genres = (profile?.genres || []).slice(0, 4).map(item => item.name).filter(Boolean);
  const languages = (profile?.languages || []).slice(0, 3).map(item => item.name).filter(Boolean);
  const bands = (profile?.affectBands || []).slice(0, 3).map(item => item.name).filter(Boolean);
  const parts = [];
  if (artists.length) parts.push(`曲库中较常出现的艺人有 ${artists.join('、')}`);
  if (genres.length) parts.push(`可参考的风格倾向有 ${genres.join('、')}`);
  if (languages.length) parts.push(`语言分布偏向 ${languages.join('、')}`);
  if (bands.length) parts.push(`粗粒度情绪分布包含 ${bands.join('、')}`);
  parts.push(`覆盖 ${profile?.coverage?.distinctSongs || 0} 首歌、${profile?.coverage?.playlists || 0} 个歌单`);
  return `曲库冷启动的低置信软画像：${parts.join('；')}。它只用于候选排序参考，可被当前请求和明确反馈覆盖。`;
}

export async function projectTasteProfileToStationMemory({ station, provider, accountUid, profile }) {
  if (!station?.stationMemory || !profile) return { projected: false, skipped: 'station-unavailable' };
  station.setActiveTasteSource?.(provider, accountUid);
  const accountTag = `account_uid:${encodeURIComponent(String(accountUid))}`;
  const tags = `station_seed,taste_bootstrap,provider:${provider},${accountTag}`;
  const content = tasteProfileText(profile);
  const existing = station.stationMemory.searchMemory(undefined, {
    type: MemoryType.SEMANTIC, tags, limit: 10,
  });
  if (existing.length === 1 && existing[0].content === content) return { projected: false, skipped: 'unchanged', id: existing[0].id };
  for (const row of existing) station.stationMemory.deleteMemory(row.id);
  const result = station.stationMemory.addMemory(createMemoryRecord(MemoryType.SEMANTIC, {
    namespace: 'station', content,
    summary: `曲库冷启动软画像：${provider}`,
    tags,
    source: MemorySource.STATION_SEED,
    importance: 4,
    confidence: 0.55,
  }));
  return { projected: Boolean(result?.ok), id: result?.id || null };
}
