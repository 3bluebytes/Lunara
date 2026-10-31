import { createHash } from 'node:crypto';
import * as candidates from '../candidates.js';
import * as ncm from '../ncm.js';
import * as qq from '../qq.js';
import { getLibraryStore } from '../library/libraryStore.js';
import { getTrackArtworkStore } from '../media/sharedTrackArtwork.js';
import { rememberTracks } from '../libraryTrackCache.js';
import { searchArtistTracks } from './artistCatalog.js';
import { providerRegistry } from '../music/providerRegistry.js';
import { sourceAllowed } from '../music/sourcePolicy.js';
import { collectionOrigin, collectionPriority } from '../library/collectionSourceAffinity.js';
import { effectiveWeights, mergeWeights, playableSourceIds } from '../music/recommendationWeights.js';

const providerOf = track => String(track?.source || track?.provider || '').split(':')[0];
const identityOf = track => {
  const provider = providerOf(track);
  const songId = String(track?.song_id || track?.songId || '');
  return provider && songId ? `${provider}:${songId}` : '';
};

/** Keep live discoveries visible without treating a matching title as the same recording. */
export function mergeCandidateSources(local = [], live = []) {
  const discovery = live.filter(track => /:(?:daily|discovery)$/.test(String(track?.source || '')));
  const otherLive = live.filter(track => !/:(?:daily|discovery)$/.test(String(track?.source || '')));
  const online = [...discovery, ...otherLive];
  const merged = [];
  const seen = new Map();
  const add = track => {
    const key = identityOf(track);
    if (!key || !track.title || !track.artist) return;
    if (seen.has(key)) {
      const index = seen.get(key);
      const origin = collectionOrigin(track);
      if (origin && collectionPriority(track) > collectionPriority(merged[index])) {
        merged[index] = { ...merged[index], collectionOrigin: origin, collectionKind: track.collectionKind };
      }
      return;
    }
    seen.set(key, merged.length);
    merged.push(track);
  };
  // Alternate while either side remains. The selection service still owns hard
  // constraints, freshness and taste ordering after this supply-level mix.
  for (let index = 0; index < Math.max(online.length, local.length); index++) {
    if (index < online.length) add(online[index]);
    if (index < local.length) add(local[index]);
  }
  return merged;
}

/**
 * 按推荐配额重排候选池的**头部**，不丢任何候选。
 *
 * 为什么是重排而不是截断：候选池同时服务选曲、发现与自动续选，砍掉尾部会让
 * 「刚好只有那一首合适」的情况凭空消失。这里只保证「前 budget 条里各源占比接近
 * 用户设定的配额」，剩下的照样留在池子里。曲目不足时不硬凑：某个源提前用尽，
 * 其余源按相对权重接住空出的位置（effectiveWeights 负责归一）。
 */
export function orderCandidatesByQuota(rows = [], { saved = null, budget = 0,
  playableIds = playableSourceIds(), availableIds = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const want = Math.max(0, Math.floor(Number(budget) || 0));
  if (!want || !list.length) return [...list];
  const targets = mergeWeights(saved, playableIds);
  const present = availableIds ?? [...new Set(list.map(providerOf).filter(id => providerRegistry.isPlayable(id)))];
  const effective = effectiveWeights(targets, present.filter(id => targets[id] !== undefined));
  const entries = Object.entries(effective);
  if (entries.length < 2) return [...list];
  const buckets = new Map(entries.map(([id]) => [id, []]));
  const rest = [];
  for (const row of list) {
    const bucket = buckets.get(providerOf(row));
    (bucket || rest).push(row);
  }
  const head = [];
  // 逐轮按「还差多少才达到目标占比」取一条：用累计配额判断，而不是每轮重新均分，
  // 这样 70/30 在很小的 budget 上也不会退化成 1:1。
  const taken = new Map(entries.map(([id]) => [id, 0]));
  const order = entries.map(([id, share]) => [id, share]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  while (head.length < want) {
    let progressed = false;
    for (const [id, share] of order) {
      if (head.length >= want) break;
      const bucket = buckets.get(id);
      if (!bucket.length) continue;
      const deficit = share * (head.length + 1) - taken.get(id);
      if (deficit <= 0 && order.some(([other]) => buckets.get(other)?.length)) continue;
      head.push(bucket.shift());
      taken.set(id, taken.get(id) + 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  // 头部没填满（各源都用尽了）就如实停在这里，尾部和剩余候选按原顺序跟上。
  const remaining = [...list].filter(row => !head.includes(row));
  return [...head, ...remaining];
}

export class MusicCandidateSupply {
  constructor({ readLocal, loadOnline, sourceVersion = () => '', waitMs = 1200,
    coldWaitMs = 3500, refreshAfterMs = 5 * 60_000, now = Date.now, onCandidates = () => {},
    recommendationWeights = null, quotaBudget = 40, getSourcePolicy = () => null } = {}) {
    this.readLocal = readLocal;
    this.loadOnline = loadOnline;
    this.sourceVersion = sourceVersion;
    this.waitMs = waitMs;
    this.coldWaitMs = coldWaitMs;
    this.refreshAfterMs = refreshAfterMs;
    this.now = now;
    this.onCandidates = onCandidates;
    this.recommendationWeights = typeof recommendationWeights === 'function' ? recommendationWeights : null;
    this.quotaBudget = quotaBudget;
    this.getSourcePolicy = getSourcePolicy;
    this.version = null;
    this.online = [];
    this.lastAttemptAt = -Infinity;
    this.inflight = null;
    this.generation = 0;
  }

  refresh() {
    if (this.inflight) return this.inflight;
    const retryAfterMs = this.online.length ? this.refreshAfterMs : 30_000;
    if (this.now() - this.lastAttemptAt < retryAfterMs) return Promise.resolve(this.online);
    this.lastAttemptAt = this.now();
    const generation = this.generation;
    const task = Promise.resolve().then(() => this.loadOnline()).then(rows => {
      if (this.generation === generation) this.online = Array.isArray(rows) ? rows : [];
      return this.online;
    }).catch(() => this.online).finally(() => { if (this.inflight === task) this.inflight = null; });
    this.inflight = task;
    return this.inflight;
  }

  async getCandidates() {
    const version = this.sourceVersion();
    if (this.version !== version) {
      this.version = version;
      this.online = [];
      this.lastAttemptAt = -Infinity;
      this.inflight = null;
      this.generation++;
    }
    const local = this.readLocal();
    const pending = this.refresh();
    if (!this.online.length) {
      const wait = local.length ? this.waitMs : this.coldWaitMs;
      let timer;
      try { await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, wait); })]); }
      finally { clearTimeout(timer); }
    }
    const policy = this.getSourcePolicy();
    const rows = mergeCandidateSources(local, this.online).filter(row => sourceAllowed(policy, providerOf(row)));
    // 推荐配額只作用于「从哪些源取候选」，不改排序与约束；未配置时 getRecommendationWeights
    // 返回 null，行为与改动前逐字一致。
    const ordered = this.recommendationWeights
      ? orderCandidatesByQuota(rows, { saved: this.recommendationWeights(), budget: this.quotaBudget })
      : rows;
    this.onCandidates(ordered);
    return ordered;
  }

  /**
   * 明确点名歌手时的目录补充。与在线候选同源、共用同一组供应商，因此不另设注入点；
   * 来源策略与候选池一致；作为回调传递时须保留实例上下文。
   */
  searchArtistCatalog(artist, options = {}) {
    return searchArtistTracks(artist, { ...options, allowedSources: this.getSourcePolicy()?.sources });
  }
}

export async function loadOnlineCandidates({ qqProvider = qq, ncmProvider = ncm,
  loadProviderCandidates = candidates.loadCandidates } = {}) {
  const qqUid = qqProvider.getUid();
  const qqTask = (async () => {
    if (qqUid) {
      try { return await loadProviderCandidates({ qqUid }); } catch { /* daily is independent */ }
    }
    const daily = await qqProvider.recommend(30);
    return { list: daily.map(track => ({ ...track, source: 'qq:daily' })) };
  })();
  const qqDiscoveryTask = typeof qqProvider.discover === 'function'
    ? Promise.resolve().then(() => qqProvider.discover(30)).then(rows => ({
      list: rows.map(track => ({ ...track, source: 'qq:discovery' })),
    })) : Promise.resolve({ list: [] });
  const ncmTask = (async () => {
    let status = null;
    try { if (ncmProvider.getCookie()) status = await ncmProvider.loginStatus(); } catch { /* daily is independent */ }
    if (status?.loggedIn) {
      try { return await loadProviderCandidates({ ncmUid: status.userId }); } catch { /* daily is independent */ }
    }
    const daily = await ncmProvider.recommend(30);
    return { list: daily.map(track => ({ ...track, source: 'ncm:daily' })) };
  })();
  const settled = await Promise.allSettled([qqTask, qqDiscoveryTask, ncmTask]);
  return settled.flatMap(result => result.status === 'fulfilled' ? candidates.candidateTrackList(result.value) : []);
}

export const DEFAULT_LOCAL_CANDIDATE_LIMIT = 10000;

/**
 * 本地曲库进入候选的上限（ground-music-selection-in-taste D2）。默认 10000，覆盖个人曲库全量；
 * 只是防御极端规模的安全阀，不是抽样：未超限时所有在架歌曲都进入候选。
 */
export function localCandidateLimit(env = process.env) {
  const value = Number.parseInt(env.MUSIC_LOCAL_CANDIDATE_LIMIT, 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LOCAL_CANDIDATE_LIMIT;
}

/**
 * 本地曲库候选投影。封面必须在候选阶段就带上：候选是唯一一次把「曲库里的元数据」
 * 变成「会进入播放的曲目」的时机，这里丢掉封面，后面只能靠解析时再查一次网络。
 * 该函数的读取全部是缓存/表查询，不发网络请求。
 */
export function readLocalLibraryCandidates({ store = getLibraryStore(), artworkStore = null, limit = localCandidateLimit(),
  trace = () => {} } = {}) {
  let rows;
  let total = null;
  if (typeof store.listCollectionTracks === 'function') {
    const all = store.listCollectionTracks();
    total = all.length;
    rows = all.slice(0, limit);
  } else {
    // 多取一行只用来判断是否超限；读不到总数时 trace 里 total 为 null。
    rows = store.listActiveSongs({ limit: limit + 1 });
  }
  const truncated = total != null ? total > limit : rows.length > limit;
  if (truncated) {
    rows = rows.slice(0, limit);
    trace({ event: 'music-local-candidates-truncated', total, limit });
  }
  const storeRef = artworkStore || getTrackArtworkStore();
  const artworks = new Map();
  for (const provider of new Set(rows.map(row => String(row.provider || '')))) {
    if (!provider) continue;
    const songIds = rows.filter(row => String(row.provider || '') === provider).map(row => row.song_id);
    for (const [songId, artwork] of storeRef.peekMany(provider, songIds)) {
      artworks.set(`${provider}:${songId}`, artwork || '');
    }
  }
  return rows.map(row => ({
    song_id: row.song_id, title: row.title, artist: row.artist, album: row.album,
    duration: row.duration, source: `${row.provider}:library`,
    ...(row.collectionKind ? { collectionKind: row.collectionKind } : {}),
    artwork: artworks.get(`${row.provider}:${row.song_id}`) || '',
  }));
}

export function createProductionMusicCandidateSupply({ recommendationWeights = null, quotaBudget = 40, getSourcePolicy = () => null,
  trace = () => {} } = {}) {
  return new MusicCandidateSupply({
    recommendationWeights,
    quotaBudget,
    getSourcePolicy,
    readLocal: () => readLocalLibraryCandidates({ trace }),
    loadOnline: loadOnlineCandidates,
    sourceVersion: () => createHash('sha256').update(`${qq.getCookie()}\0${ncm.getCookie()}`).digest('hex'),
    onCandidates: rows => {
      for (const provider of providerRegistry.defaultSourceCandidates()) {
        rememberTracks(rows.filter(row => providerOf(row) === provider), provider);
      }
    },
  });
}
