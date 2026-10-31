// tagLookup.js — 一次选歌（select()）内的标签读取视图。
//
// 选歌时同一首歌的标签会被硬约束、口味偏置、探查各读一遍，每条口味信号还要再读一遍；
// 曲库全量进入候选后逐条读会按「候选数 × 信号数」放大。这里先按 provider 批量预取，
// 之后同一次选歌内的 getTags 只查内存；没预取到的（如歌手目录补充）首次读时回落原 store 并缓存。
//
// Python 伪代码：
//   view = TagLookup(store); view.prefetch(tracks)   # 每个 provider 一次 IN 查询
//   view.get_tags(song_id, provider)                  # 命中缓存，不再查库
//
// 视图只活在一次 select() 里，不跨请求缓存，因此不会读到过期标签。
import { providerOf } from './songTagStore.js';

const providerKey = provider => (provider == null || provider === '' ? '' : providerOf(provider));
const songIdOf = track => String(track?.songId ?? track?.song_id ?? '');

export function createTagLookup(store) {
  if (!store) return null;
  const songs = new Map();
  const artists = new Map();
  const getTags = (songId, provider = undefined) => {
    const key = `${providerKey(provider)}:${songId}`;
    if (!songs.has(key)) songs.set(key, store.getTags?.(songId, provider) ?? null);
    return songs.get(key);
  };
  const getArtistTags = artistKey => {
    if (!artists.has(artistKey)) artists.set(artistKey, store.getArtistTags?.(artistKey) ?? null);
    return artists.get(artistKey);
  };
  const prefetch = (tracks = []) => {
    if (typeof store.getTagsMany !== 'function') return 0;
    const byProvider = new Map();
    for (const track of Array.isArray(tracks) ? tracks : []) {
      const provider = providerKey(track?.source || track?.provider);
      const songId = songIdOf(track);
      if (!provider || !songId || songs.has(`${provider}:${songId}`)) continue;
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push(songId);
    }
    let fetched = 0;
    for (const [provider, ids] of byProvider) {
      for (const [songId, tags] of store.getTagsMany(provider, ids)) {
        songs.set(`${provider}:${songId}`, tags ?? null);
        fetched += 1;
      }
    }
    return fetched;
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === 'getTags') return getTags;
      if (property === 'getArtistTags') return getArtistTags;
      if (property === 'prefetch') return prefetch;
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
