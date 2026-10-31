import { sourceAllowed } from '../music/sourcePolicy.js';
import { isMemoryRevoked } from '../memory/memoryProvenance.js';
import { createHash } from 'node:crypto';
import { createCandidateProgram } from './programTypes.js';
import { MUSIC_SELECTION_PARAMETERS, normalizeMusicSelection, selectionSignature, artistMatchesRequest } from './musicSelectionRequest.js';
import { matchesTags, hasAnyTagFilter } from '../songtags/songTagRetrieval.js';
import { validateSelectionConstraints } from './programConstraintValidation.js';
import { memoryApplies, parseEvidence } from '../memory/memoryPolicy.js';
import { tasteSignalFromInsight, tasteBiasForTrack, trackMatchesSignal, tasteSignalsDisabled } from './tasteSignals.js';
import { scoreCandidates, orderScored, scoreWeights, scoringDisabled, playIndex, songHistoryIndex, artistSkipIndex,
  ARTIST_SKIP_WINDOW_MS } from './selectionScoring.js';
import { chooseFamiliarArtistClasses, getFamiliarArtistCadence,
  orderFamiliarArtistPool } from './familiarArtistCadence.js';
import { MusicSelectionOfferStore, MusicSelectionPreparedStore, normalizeOfferIndexes, prewarmBatchKey,
  offerWindowSize } from './musicSelectionOffers.js';
import { createSelectionIdentity } from './selectionIdentity.js';
import { createTagLookup } from '../songtags/tagLookup.js';
import { UnplayableTrackMemory, isConfirmedUnplayable } from './unplayableTrackMemory.js';
import { RecommendationDecisionStore, RecommendationOutcomeBridge, buildDecisionRows, decisionPath } from './recommendationDecisions.js';
import { buildSelectionBrief, personaMusicTaste, selectionBriefDisabled } from './selectionBrief.js';
import { buildCandidateFeatures } from './candidateFeatures.js';

const cleanTrack = track => ({ songId: String(track.songId || track.song_id || ''), title: String(track.title || ''),
  artist: String(track.artist || ''), source: String(track.source || track.provider || '').split(/[:-]/)[0], album: track.album || '', artwork: track.artwork || track.pic_url || '', duration: track.duration || 0 });
const trackKey = track => `${track.source}:${track.songId || `${track.artist}:${track.title}`}`;
// 专辑身份先用文本口径：provider 行里有 album_id，但本地导入曲库没有这一列，
// 为一次「只影响顺序」的分散加列迁移不划算。专辑名缺失视为未知，不并入任何专辑。
const normalizeAlbumText = value => String(value || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
const albumIdentity = track => {
  const album = normalizeAlbumText(track?.album);
  return album ? `${normalizeAlbumText(track?.artist)}|${album}` : null;
};
const albumCountsOf = tracks => {
  const counts = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const key = albumIdentity(track);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
};
/**
 * 逐轮分散：每一轮沿候选顺序取，同一专辑本轮最多 `limit` 首，取满 `size` 或池子取尽为止。
 * 轮数会一直继续，所以分散不会让窗口变短——供给只有一张专辑时窗口照常排满，顺序也仍是原顺序。
 * `deferred` 里的专辑只能从第二轮起进场：用来把「队列里已经占位的那张专辑」整张排到后面。
 */
function disperseByAlbum(pool, { limit, size, deferred = null }) {
  if (size <= 0) return [];
  if (!(limit > 0)) return pool.slice(0, size);
  const keys = pool.map(albumIdentity);
  const taken = pool.map(() => false);
  const windowed = [];
  let round = 0;
  while (windowed.length < size) {
    round += 1;
    const perAlbum = new Map();
    let addedThisRound = 0;
    for (let index = 0; index < pool.length && windowed.length < size; index += 1) {
      if (taken[index]) continue;
      const key = keys[index];
      if (key) {
        if (round === 1 && deferred?.has(key)) continue;
        const used = perAlbum.get(key) || 0;
        if (used >= limit) continue;
        perAlbum.set(key, used + 1);
      }
      taken[index] = true;
      windowed.push(pool[index]);
      addedThisRound += 1;
    }
    if (!addedThisRound) break;
  }
  return windowed;
}
// 诊断摘要一律有界：只保留供应商名与稳定分类，不含 URL、凭据或供应商原始报文。
const boundedText = (value, max = 160) => String(value || '').trim().slice(0, max);
// 当前一起听计划的硬条件（已归一化）；没有计划时为空。
const planConstraints = listening => listening?.listeningPlan?.request?.constraints || undefined;
// A process that dies mid-action leaves its receipt `running`; only a live attempt may
// block a retry. Selection plus commit is bounded well below this window.
const RUNNING_RECEIPT_TTL_MS = Math.max(30_000, Number(process.env.MUSIC_ACTION_RUNNING_TTL_MS) || 5 * 60_000);
// Recommendation freshness: only ordering changes, never membership. A correction like
// "stop always starting with the same songs" is about the recommendation habit, not a ban.
const FRESHNESS_WINDOW_MS = Math.max(60_000, Number(process.env.MUSIC_FRESHNESS_WINDOW_MS) || 14 * 24 * 60 * 60 * 1000);
// 冷却默认 24 小时（2026-10-23 用户决定，原为 48 小时）；同时用于主动推荐的「近期放过」排除。
// 每次读取环境变量，覆盖值无需重启进程即可在测试与运维中生效。
const FRESHNESS_COOLDOWN_DEFAULT_MS = 24 * 60 * 60 * 1000;
const freshnessCooldownMs = () => Math.max(60_000, Number(process.env.MUSIC_FRESHNESS_COOLDOWN_MS) || FRESHNESS_COOLDOWN_DEFAULT_MS);
const FRESHNESS_MAX_PER_ARTIST = Math.max(1, Number(process.env.MUSIC_FRESHNESS_MAX_PER_ARTIST) || 3);
/** 单歌手封顶：同一歌手超过上限的歌退到后面，不删除；排序之后执行，只重排。 */
function capPerArtist(tracks) {
  const perArtist = new Map();
  const windowed = [], overflow = [];
  for (const track of tracks) {
    const artist = String(track.artist || '').trim().toLowerCase();
    const count = (perArtist.get(artist) || 0) + 1;
    perArtist.set(artist, count);
    (count <= FRESHNESS_MAX_PER_ARTIST ? windowed : overflow).push(track);
  }
  return [...windowed, ...overflow];
}
// 专辑分散（disperse-candidate-window-by-album）：窗口按「每轮每专辑最多几首」逐轮填，
// 队列里已经出现的同专辑首数到阈值就把它的候选排到其他专辑之后。两者都只重排，不改成员。
// 每次调用现读环境变量：测试与运维切换不需要重启进程。
function windowMaxPerAlbum() {
  const raw = Number(process.env.MUSIC_WINDOW_MAX_PER_ALBUM);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}
function windowAlbumSaturation() {
  const raw = Number(process.env.MUSIC_WINDOW_ALBUM_SATURATION);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
}
// Taste-signal ordering and restrained hypothesis probes (add-taste-probe-signals).
const probeDisabled = () => process.env.MUSIC_PROBE_DISABLED === '1';
const probeMinIntervalMs = () => Math.max(30_000, Number(process.env.MUSIC_PROBE_MIN_INTERVAL_MS) || 6 * 60 * 60 * 1000);
const PROBE_CLAIM_MIN_CONFIDENCE = 0.3;
const PROBE_CLAIM_MAX_CONFIDENCE = 0.65;
const PROBE_MIN_POOL = 4;
// artist 模式去供应商目录补候选的窗口大小：足够让模型有得挑，又不会把一次搜索变成批量抓库。
const ARTIST_CATALOG_LIMIT = 20;
// 整专连播一次读取的曲目上限：整张专辑一次取够，批次大小仍由 request.count 决定。
const ALBUM_TRACK_LIMIT = 200;
const OFFER_UNAVAILABLE_COPY = '之前那组候选已经不能用了，需要重新选一次。';
const RESOLUTION_CACHE_TTL_MS = 30_000;
const RESOLUTION_CACHE_MAX_ITEMS = 200;
// 候选预解析：offer 交给模型挑选的同时在后台解析可播放版本，提交时复用（仍逐项校验）。
const PRE_RESOLVE_TIMEOUT_MS = 8_000;
const PRE_RESOLVE_MAX_OFFERS = 20;
// 预解析只覆盖窗口头部：窗口变大后供应商解析流量不随之翻倍，靠后的序号提交时走常规解析。
const PRE_RESOLVE_HEAD_DEFAULT = 20;
const preResolveHead = () => {
  const raw = Number(process.env.MUSIC_PRE_RESOLVE_HEAD);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : PRE_RESOLVE_HEAD_DEFAULT;
};
// 排序后保留的候选池：窗口从这里分散取出，池子要比窗口宽得多，分散才有余地。
const RANKED_POOL_DEFAULT = 120;
const rankedPoolSize = () => {
  const raw = Number(process.env.MUSIC_RANKED_POOL);
  return Number.isFinite(raw) && raw >= offerWindowSize() ? Math.floor(raw) : Math.max(RANKED_POOL_DEFAULT, offerWindowSize());
};
// 候选特征的新鲜度事实（近 14 天）与简报近期收听事实（近 30 天）各自的读取窗口。
const FEATURE_PLAYS_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const BRIEF_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// 与 MUSIC_SELECTION_PARAMETERS.count / targets 的上限保持一致。
const PRE_RESOLVE_CHUNK = MUSIC_SELECTION_PARAMETERS.properties.count.maximum;
// 冷却记录按 canonical 供应商（去掉 `qq:library` 这类来源后缀）+ songId 索引。
const unplayableRef = candidate => [String(candidate?.evidence?.source || '').split(/[:-]/)[0], candidate?.sourceSongId];
const preResolveKey = candidate => `${candidate.evidence?.source || ''}:${candidate.sourceSongId || ''}`;

/**
 * Shared selector.
 *
 * 开放式选歌不在这里替用户挑歌，也不调用任何隐藏模型：`select` 只供给/过滤/排序
 * 候选，非 exact 的选择返回一份持久化候选 offer，由本轮 Agent 选定序号后经
 * `commitSelection` 提交。exact 目标保持确定性。
 */
/**
 * 本轮同伴推荐登记：每位推荐人一条，按 (provider, songId) / 候选键去重，重复登记不叠加。
 * tracks 是 canonical 解析后的已核实曲目（给负责人的提示看）；candidates 供负责人提交时合并。
 */
function recordRecommendation(groupAction, personId, { candidates, selectionId, tracks }) {
  const candidateKey = item => `${item.evidence?.source || ''}:${item.sourceSongId || item.query}`;
  const trackKey = item => `${item.provider || ''}:${item.songId ?? item.title}`;
  const existing = groupAction.recommendations.find(item => item.personId === personId);
  if (!existing) {
    groupAction.recommendations.push({ personId, candidates, selectionId, tracks });
    return;
  }
  existing.candidates = [...new Map([...existing.candidates, ...candidates].map(item => [candidateKey(item), item])).values()];
  existing.tracks = [...new Map([...(existing.tracks || []), ...tracks].map(item => [trackKey(item), item])).values()];
  existing.selectionId = selectionId;
}

export class MusicSelectionService {
  constructor({ programCommitService, playbackRuntime, registry, conversationStore, getMemoryService = () => null,
    getCandidates, getPlaylistTracks, getAlbumTracks = null, getUserPlaylists, getSongTagStore, getLibraryRevision = () => 0,
    getFamiliarArtists = () => [], searchArtistCatalog = null, getSourcePolicy = () => null, getSourceFailures = () => [],
    getRecentPlays = null, getListeningHistory = null, isSharedMemoryActive = () => true, pool = null, now = Date.now, trace = () => {},
    offerTtlMs = null, preparedTtlMs = null, getRecordingStore = null, preResolveConcurrency = 0,
    unplayableMemory = null } = {}) {
    Object.assign(this, { programCommitService, playbackRuntime, registry, conversationStore, getMemoryService,
      getCandidates, getPlaylistTracks, getAlbumTracks, getUserPlaylists, getSongTagStore, getLibraryRevision, getRecentPlays,
      getFamiliarArtists, searchArtistCatalog, getSourcePolicy, getSourceFailures, getListeningHistory,
      isSharedMemoryActive, now, trace, offerTtlMs, preparedTtlMs });
    // 预热统计：prepared/consumed/expired/mismatch/fallback/failed/无效化，全部只在
    // 真实边界事件上累加，供 WarmPoolAdminService 的既有 status 接口读取。
    this.prewarmStats = { prepared: 0, consumed: 0, expired: 0, mismatch: 0, fallback: 0, failed: 0, invalidated: 0 };
    this._pool = null;
    this.pool = pool;
    this.initialized = false;
    // Media resources live only here, never in offers, receipts, tool facts or traces.
    this._resolutionCache = new Map();
    // offerId → { stop, expiresAt, entries: Map<(provider,songId), Promise<result|null>> }；0 表示不预解析。
    this.preResolveConcurrency = Math.max(0, Math.floor(Number(preResolveConcurrency) || 0));
    this._preResolutions = new Map();
    // 「拿不到音源」的短期冷却（skip-known-unplayable-candidates）：只影响开放式选歌，不是口味信号。
    this._unplayable = unplayableMemory || new UnplayableTrackMemory({ now: this.now });
    // 跨源「同一首歌」判定：未建立等价关系时退回供给身份，行为与之前一致。
    this._identity = createSelectionIdentity(getRecordingStore ? { getRecordingStore } : {});
  }

  /**
   * 后台池（WarmPoolService）挂到服务上时自动接上两件事：状态快照里的预热计数，
   * 以及 `pool.invalidate()`（记忆/标签/曲库变化）对未采用批次的作废。接线点
   * index.js 的 `musicSelectionService.pool = warmPool` 因此保持一行不变。
   */
  get pool() { return this._pool; }
  set pool(value) {
    this._pool = value || null;
    if (!this._pool || typeof this._pool.attachPreparedSource !== 'function') return;
    this._pool.attachPreparedSource({
      stats: () => this.preparedStats(),
      invalidate: options => this.invalidatePrepared(options || {}),
    });
  }

  /** 某源登录成功：该源「拿不到音源」的冷却证据随账号状态失效（recover-unplayable-after-source-login）。 */
  clearUnplayableForProvider(source) {
    const cleared = this._unplayable.clearProvider(source);
    if (cleared) this.trace({ event: 'music-selection-unplayable-cleared', provider: String(source || ''), cleared });
    return cleared;
  }

  initialize() {
    if (this.initialized) return;
    this.conversationStore.db.exec(`CREATE TABLE IF NOT EXISTS music_selections (
      selection_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, person_id TEXT NOT NULL,
      request_json TEXT NOT NULL, tracks_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.conversationStore.db.exec(`CREATE TABLE IF NOT EXISTS music_action_receipts (
      action_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_id TEXT NOT NULL,
      status TEXT NOT NULL, result_json TEXT, updated_at INTEGER NOT NULL
    )`);
    this.conversationStore.db.exec(`CREATE TABLE IF NOT EXISTS music_probes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id TEXT NOT NULL, session_id TEXT NOT NULL,
      provider TEXT NOT NULL, song_id TEXT NOT NULL,
      claim_key TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.offers = new MusicSelectionOfferStore({ db: this.conversationStore.db, now: this.now, ttlMs: this.offerTtlMs });
    this.offers.initialize();
    this.prepared = new MusicSelectionPreparedStore({ db: this.conversationStore.db, now: this.now, ttlMs: this.preparedTtlMs });
    this.prepared.initialize();
    // 推荐决策账本：建表并清理 180 天前的行（ground-music-selection-in-taste D9）。
    this.decisions = new RecommendationDecisionStore({ db: this.conversationStore.db, now: this.now });
    this.decisions.initialize();
    this.initialized = true;
  }

  context(input) {
    const room = this.conversationStore.getSession(input.sessionId);
    const entity = this.registry.get(input.virtualPersonId);
    if (!room || room.archivedAt || !room.memberIds.includes(entity?.id) || entity.status === 'archived') throw new Error('聊天或角色已经不可用');
    const service = this.getMemoryService();
    const applies = row => !isMemoryRevoked(service.store, row)
      && memoryApplies(row, { sessionId: room.sessionId, isGroup: room.memberIds.length > 1 });
    const schemaRow = service?.searchMemory(undefined, { namespace: entity.memoryNamespace, type: 'semantic', tags: 'taste-schema', limit: 1 })
      ?.find(row => !/(?:^|,)(?:revoked|superseded)(?:,|$)/.test(row.tags || '') && applies(row)) || null;
    const baseMemories = service?.searchMemory(undefined, { namespace: entity.memoryNamespace, type: 'semantic', limit: 30 })
      ?.filter(row => (row.namespace === 'station' ? ['user_explicit_feedback', 'manual_seed', 'station_seed'].includes(row.source) : row.source !== 'station_seed') && applies(row)) || [];
    const memories = [schemaRow, ...baseMemories]
      .filter(Boolean)
      .filter((row, index, all) => all.findIndex(other => other.id === row.id) === index)
      .slice(0, 8);
    const shared = service?.searchMemory(undefined, { namespace: 'station', type: 'semantic', limit: 20 })
      .filter(row => ['user_explicit_feedback', 'manual_seed', 'station_seed'].includes(row.source) && this.isSharedMemoryActive(row)
        && !isMemoryRevoked(service.store, row) && memoryApplies(row, { sessionId: room.sessionId, isGroup: room.memberIds.length > 1 })).slice(0, 6) || [];
    const tasteSignals = service?.searchMemory(undefined, { namespace: entity.memoryNamespace, type: 'semantic', tags: 'claim:music.', limit: 20 })
      ?.filter(row => (!row.expiresAt || row.expiresAt > this.now()) && applies(row))
      .map(row => tasteSignalFromInsight(row)).filter(Boolean) || [];
    const revision = rows => rows.reduce((sum, row) => sum + Number(row.id) * Number(row.version || 1) + Number(row.updatedAt || 0), 0);
    return { ...input, entity, memories, shared, tasteSignals,
      familiarArtistCadence: getFamiliarArtistCadence(this.conversationStore.db, entity.id),
      libraryRevision: this.getLibraryRevision(), membershipRevision: room.membershipRevision,
      memoryRevision: revision(memories), sharedRevision: revision(shared),
      listening: this.playbackRuntime.listeningSnapshot(input.sessionId) };
  }

  resolveReference(request, context) {
    if (!request.reference) return request;
    this.initialize();
    const row = this.conversationStore.db.prepare('SELECT * FROM music_selections WHERE selection_id = ? AND conversation_id = ?')
      .get(request.reference.selectionId, context.sessionId);
    if (!row) throw new Error('这组歌曲引用已经不可用，请重新选择');
    const tracks = JSON.parse(row.tracks_json);
    const indexes = request.reference.indexes;
    if (!indexes.length || indexes.some(index => !Number.isInteger(index) || index < 1 || index > tracks.length)) throw new Error('歌曲序号不在这组推荐中');
    const targets = indexes.map(index => { const { title, artist, songId, source } = tracks[index - 1]; return { title, artist, songId, source }; });
    return normalizeMusicSelection({ ...request, mode: 'exact', count: targets.length, targets, reference: null });
  }

  /**
   * artist 模式的目录补充：有界、可失败。搜索失败不得把选歌失败升级成“没有候选”以外的
   * 后果，因此这里只返回空数组，由调用方保持 fail-closed 并如实短报。
   */
  async _artistCatalogTracks(artist, context) {
    if (typeof this.searchArtistCatalog !== 'function' || !String(artist || '').trim()) return [];
    try {
      const rows = await this.searchArtistCatalog(artist, { limit: ARTIST_CATALOG_LIMIT, signal: context.signal });
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  /**
   * Curated freshness ordering from the actual play ledger: unheard tracks first,
   * repeated plays demoted, a recent cooldown demoted hardest, and a modest per-artist
   * cap inside the model-facing window so one voice cannot head every batch. Items
   * beyond the cap fall behind the window instead of being dropped.
   */
  rankByFreshness(pool) {
    return this._rank(pool);
  }

  /**
   * Taste claims reorder only within freshness tiers: the freshness tier and the
   * recent-play cooldown stay the primary keys, negative claims demote without
   * excluding, and pool membership never changes. A soft artist preference joins
   * the same bias sum: it lifts a named artist inside its tier, never filters a
   * candidate out, and never relaxes a hard constraint.
   */
  rankByTasteSignals(pool, signals, { preferredArtists = [], tagStore = this.getSongTagStore() } = {}) {
    const taste = Array.isArray(signals) && signals.length && !tasteSignalsDisabled()
      ? track => tasteBiasForTrack(signals, track, tagStore) : null;
    const affinity = Array.isArray(preferredArtists) && preferredArtists.length
      ? track => (preferredArtists.some(artist => artistMatchesRequest(track.artist, artist)) ? 0 : 1) : null;
    if (!taste && !affinity) return this.rankByFreshness(pool);
    return this._rank(pool, track => (taste ? taste(track) : 0) + (affinity ? affinity(track) : 0));
  }

  _rank(pool, biasFn = null) {
    if (pool.length <= 1 || typeof this.getRecentPlays !== 'function') return pool;
    let recent = null;
    try { recent = this.getRecentPlays(this.now() - FRESHNESS_WINDOW_MS); } catch { recent = null; }
    const plays = new Map();
    for (const row of Array.isArray(recent) ? recent : []) {
      const songId = String(row.songId || row.song_id || '');
      if (!songId) continue;
      const key = `${String(row.source || '').split(/[:-]/)[0]}:${songId}`;
      const entry = plays.get(key) || { count: 0, lastTs: 0 };
      entry.count += 1;
      entry.lastTs = Math.max(entry.lastTs, Number(row.ts) || 0);
      plays.set(key, entry);
    }
    if (!plays.size && !biasFn) return pool;
    const now = this.now();
    const tier = track => {
      const entry = plays.get(trackKey(track));
      if (!entry) return 0;
      if (now - entry.lastTs <= freshnessCooldownMs()) return 1000 + entry.count;
      const daysSince = (now - entry.lastTs) / 86_400_000;
      return Math.min(999, entry.count + Math.max(0, 3 - daysSince));
    };
    const scored = pool.map((track, index) => ({
      track, index, tier: tier(track), bias: biasFn ? biasFn(track) : 0,
    })).sort((a, b) => a.tier - b.tier || a.bias - b.bias || a.index - b.index);
    return capPerArtist(scored.map(({ track }) => track));
  }

  /**
   * 综合打分排序（D5）：冷却期整体垫底，其余按新鲜度 + 口味 + 软歌手 + 来源 + 听完率 − 歌手跳过的和排序，
   * 再做单歌手封顶。只重排、不删候选；返回每首的分数分项，供候选特征与决策账本快照。
   */
  rankByScore(pool, { signals = [], preferredArtists = [], tagStore = this.getSongTagStore(), personId = null } = {}) {
    const now = this.now();
    let recent = [];
    try { recent = this.getRecentPlays?.(now - FRESHNESS_WINDOW_MS) || []; } catch { recent = []; }
    let listening = {};
    try {
      listening = personId ? this.getListeningHistory?.({ personId, since: now - ARTIST_SKIP_WINDOW_MS }) || {} : {};
    } catch { listening = {}; }
    const preferred = Array.isArray(preferredArtists) && preferredArtists.length
      ? track => preferredArtists.some(artist => artistMatchesRequest(track.artist, artist)) : null;
    const entries = scoreCandidates(pool, { plays: playIndex(recent), now, cooldownMs: freshnessCooldownMs(),
      signals: tasteSignalsDisabled() ? [] : signals, tagStore, preferredArtist: preferred,
      songHistory: songHistoryIndex(listening.songStats), artistSkips: artistSkipIndex(listening.observations, { now }),
      weights: scoreWeights() });
    const ordered = orderScored(entries);
    const scores = new Map(ordered.map(entry => [trackKey(entry.track), entry]));
    return { pool: capPerArtist(ordered.map(entry => entry.track)), scores };
  }

  /** 开放式排序入口：歌单保持原有分层（歌单顺序不参与打分），关闭打分时全部回到分层。 */
  _rankPool(pool, request, context, tagStore) {
    const options = { preferredArtists: request.preferredArtists, tagStore };
    if (scoringDisabled() || request.mode === 'playlist') {
      return { pool: this.rankByTasteSignals(pool, context.tasteSignals, options), scores: null };
    }
    return this.rankByScore(pool, { ...options, signals: context.tasteSignals,
      personId: context.entity?.id || context.virtualPersonId || null });
  }

  /**
   * Restrained hypothesis probe: pin one deterministic claim-matching candidate to
   * the head of the model-facing window. Gates keep it rare; membership and hard
   * constraints are untouched; the probe row is rate-limit + diagnostics data.
   */
  _planProbe(context, request, pool, tagStore = this.getSongTagStore()) {
    if (probeDisabled() || !['discovery', 'constrained'].includes(request.mode)) return null;
    if (!Array.isArray(pool) || pool.length < PROBE_MIN_POOL) return null;
    const claims = (context.tasteSignals || []).filter(signal => signal.polarity === 'positive'
      && signal.confidence >= PROBE_CLAIM_MIN_CONFIDENCE && signal.confidence < PROBE_CLAIM_MAX_CONFIDENCE);
    if (!claims.length) return null;
    this.initialize();
    const personId = context.entity?.id;
    const last = this.conversationStore.db
      .prepare('SELECT created_at FROM music_probes WHERE person_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(personId);
    if (last && this.now() - last.created_at < probeMinIntervalMs()) return null;
    for (const track of pool) {
      const signal = claims.find(candidate => trackMatchesSignal(candidate, track, tagStore));
      if (!signal) continue;
      this.conversationStore.db
        .prepare('INSERT INTO music_probes (person_id, session_id, provider, song_id, claim_key, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(personId, context.sessionId, String(track.source || track.provider || ''), String(track.songId || ''),
          signal.key, this.now());
      return { track, signal };
    }
    return null;
  }

  /** 最近一次命中该歌曲身份的 probe（供串词披露），默认 1 小时内有效。 */
  recentProbeForTrack(track, { withinMs = 60 * 60 * 1000 } = {}) {
    try {
      return this.conversationStore.db
        .prepare('SELECT person_id, claim_key, created_at FROM music_probes WHERE provider = ? AND song_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1')
        .get(String(track?.source || track?.provider || ''), String(track?.songId || ''), this.now() - (Number(withinMs) || 0)) || null;
    } catch { return null; }
  }

  /**
   * 候选供给/过滤/排序的唯一入口。exact 直接给确定性目标；
   * 其余模式返回持久化候选 offer（默认 40 首，`MUSIC_OFFER_WINDOW` 20–60，1 起始序号），由调用方转交本轮 Agent 选择。
   */
  async select(rawRequest, input) {
    const context = this.context(input);
    context.signal?.throwIfAborted();
    const request = this.resolveReference(normalizeMusicSelection(rawRequest), context);
    const signature = selectionSignature(request, context);
    if (request.mode === 'exact' || request.targets.length) return this._targetSelection(request, context);
    let targets = request.targets;
    let fallbackTargets = [];
    let sourceTracks;
    if (request.mode === 'playlist') {
      const result = await this.getPlaylistTracks({ ...request.playlist, limit: 50, offset: 0 });
      if (result.ok === false) throw new Error('歌单暂时无法读取');
      sourceTracks = (result.data?.matches || []).flatMap(match => match.tracks);
    } else if (request.mode === 'album') {
      // 整张专辑（add-album-sequencing）：稳定引用取曲目，专辑自己的顺序就是权威顺序。
      // 读不到就 typed 失败；不跨源找同名专辑，也不退回按标题搜索。
      if (typeof this.getAlbumTracks !== 'function') return this._albumUnavailable(request, context, 'album-reader-missing');
      let result;
      try { result = await this.getAlbumTracks({ ...request.album, limit: ALBUM_TRACK_LIMIT, offset: 0 }); }
      catch { return this._albumUnavailable(request, context, 'album-read-failed'); }
      if (result?.ok === false) return this._albumUnavailable(request, context, result?.data?.reason || 'album-unavailable');
      sourceTracks = (result?.data?.matches || []).flatMap(match => match.tracks);
      if (!sourceTracks.length) return this._albumUnavailable(request, context, 'album-empty');
    } else sourceTracks = await this.getCandidates({
      reason: context.reason,
      sessionId: context.sessionId,
      virtualPersonId: context.virtualPersonId,
    });
    // 本次选歌内的标签视图：按 provider 批量预取，之后约束/口味/探查都读内存（2.2）。
    const tagStore = createTagLookup(this.getSongTagStore());
    tagStore?.prefetch(sourceTracks);
    const excluded = new Set(request.constraints.excludedSongIds);
    // 确证登录失效的来源暂不参与开放式补选；不改用户保存的来源策略，
    // exact 已在上面返回，不能把指定歌曲静默换成另一源。同源重新登录后自动恢复。
    const authUnavailable = new Set(this.getSourceFailures()
      .filter(item => item?.code === 'requires-auth').map(item => item.source));
    // 同一套硬约束过滤：本地候选、歌单曲目与 artist 目录补充都走这里，避免多入口漂移。
    const eligibleFrom = tracks => {
      const sourcePolicy = this.getSourcePolicy();
      let rows = tracks.map(track => ({ ...cleanTrack(track), collectionKind: track.collectionKind,
        candidateOrigin: String(track.collectionOrigin || track.source || track.provider || '') }))
        .filter(track => sourceAllowed(sourcePolicy, track.source) && !authUnavailable.has(track.source)
          && track.songId && track.title && track.artist
          && !excluded.has(track.songId)
          && (!request.artist || artistMatchesRequest(track.artist, request.artist)));
      // 标签库不可用（null）≠ 无标签约束：前者让该级约束无匹配（交由调用方的放宽链降级），
      // 不能在 matchesTags 里炸出 TypeError 把整个 select 打崩。
      if (hasAnyTagFilter(request.constraints.tags)) {
        rows = tagStore
          ? rows.filter(track => matchesTags({ ...track, song_id: track.songId }, request.constraints.tags, tagStore))
          : [];
      }
      rows = rows.filter(track => validateSelectionConstraints(track, request, tagStore).ok);
      // 先排除不可播，再决定“新歌是否用尽”。否则一批放不了的 QQ 新歌会
      // 挡住健康来源已播曲目的有界回流，也可能抢走同录音健康来源的代表位置。
      const playable = rows.filter(track => !this._unplayable.has(track.source, track.songId));
      if (playable.length !== rows.length) {
        this.trace({ event: 'music-selection-unplayable-filtered', sessionId: context.sessionId,
          requestId: context.requestId || null, filtered: rows.length - playable.length });
      }
      // 去重按录音身份：同一首歌在多源只留一条（优先代表源），不再是「按供应商各留一条」。
      return this._identity.dedupeByRecording(playable);
    };
    const availableFrom = rows => {
      const existing = new Set(context.listening.queue.map(track => this._identity.keyOfTrack(cleanTrack(track))));
      const available = rows.filter(track => !existing.has(this._identity.keyOfTrack(track)));
      if (available.length || context.reason !== 'auto_continue') return available;
      // A small imported library eventually appears entirely in the played queue. At that
      // boundary allow older songs back into circulation, but never re-add an occurrence that
      // is still current or upcoming: that would queue the same song for a second play instead
      // of continuing the radio. If nothing is left, report it honestly below.
      const queue = context.listening.queue;
      const index = Number.isInteger(context.listening.currentIndex) ? context.listening.currentIndex : 0;
      const pending = new Set(queue.slice(Math.max(0, index)).map(track => this._identity.keyOfTrack(cleanTrack(track))));
      return rows.filter(track => !pending.has(this._identity.keyOfTrack(track)));
    };
    let eligible = eligibleFrom(sourceTracks);
    let pool = availableFrom(eligible);
    if (request.mode === 'artist' && pool.length < request.count) {
      // “来点某位歌手”不能因为本地池只有一首就复读或直接失败：再去供应商目录查一次这位
      // 歌手。查不到就保持 fail-closed（下方如实短报），不掺别的歌手、不用别的歌顶替。
      const found = await this._artistCatalogTracks(request.artist, context);
      if (found.length) {
        eligible = [...new Map([...eligible, ...eligibleFrom(found)].map(track => [trackKey(track), track])).values()];
        pool = availableFrom(eligible);
      }
    }
    // 专辑里的曲目按专辑原始顺序排：新鲜度、口味信号与分散都不重排它。
    let scores = null;
    if (request.mode !== 'album') ({ pool, scores } = this._rankPool(pool, request, context, tagStore));
    let cadencePlan = null;
    if (context.familiarArtistCadence?.mode === 'familiar_first'
      && ['discovery', 'constrained'].includes(request.mode) && !request.artist) {
      try {
        cadencePlan = chooseFamiliarArtistClasses({ pool,
          recentPlays: this.getRecentPlays?.(this.now() - FRESHNESS_WINDOW_MS) || [],
          likedArtists: this.getFamiliarArtists(), count: request.count });
        pool = orderFamiliarArtistPool(pool, cadencePlan);
      } catch { cadencePlan = null; }
    }
    // 熟悉度节奏不再压制试探（D7）：试探歌按它自己的熟悉度计入节奏，其余窗口照节奏重排。
    const probe = request.mode === 'album'
      ? null : this._planProbe(context, request, pool, tagStore);
    if (probe && cadencePlan) {
      const startingStreak = cadencePlan.familiar(probe.track.artist) ? Math.min(3, cadencePlan.startingStreak + 1) : 0;
      pool = orderFamiliarArtistPool(pool.filter(track => track !== probe.track), { ...cadencePlan, startingStreak });
    }
    pool = pool.slice(0, rankedPoolSize());
    if (probe) pool = [probe.track, ...pool.filter(track => track !== probe.track)];
    if (!pool.length) return { ok: false, code: 'NO_MATCHING_CANDIDATES', request, context, candidates: [] };
    const window = this._offerWindow(pool, { request, context, pinned: probe ? probe.track : null });
    // 开放式选歌不自选：把同一排序窗口作为 offer 持久化，交给本轮 Agent 选序号后提交。
    // 特征随 offer 落库（结构化、无正文）；简报只随结果返回，不进 offer。
    const features = this._candidateFeatures(window, { context, tagStore, cadencePlan, probeTrack: probe?.track || null, scores });
    const offer = this._saveOffer(request, context, window, features);
    const brief = this._selectionBrief(request, context, offer.offerId);
    targets = window.slice(0, request.count);
    if (!context.groupAction) {
      const chosen = new Set(targets.map(trackKey));
      fallbackTargets = window.filter(track => !chosen.has(trackKey(track))).slice(0, 2);
    }
    this.trace({ event: 'music-selection-offer', sessionId: context.sessionId, personId: context.virtualPersonId,
      requestId: context.requestId || null, offerId: offer.offerId, mode: request.mode, delivery: request.delivery,
      candidates: offer.candidates.length });
    const candidate = this._candidateBuilder(context, request);
    return { ok: true, code: 'MUSIC_CANDIDATES_OFFERED', request, context, signature,
      offerId: offer.offerId, offer, candidateCount: offer.candidates.length, brief,
      candidates: targets.map(candidate),
      fallbackCandidates: fallbackTargets.map((track, index) => candidate(track, request.count + index)) };
  }

  /**
   * 模型可见窗口的组装：先按队列饱和把「已经在听的那张专辑」排到其他专辑之后，再逐轮按专辑分散。
   * 两步都只重排：窗口照常取满，候选池成员与硬约束不变。probe 打头的位置不受影响。
   */
  _offerWindow(pool, { request, context, pinned = null, size = offerWindowSize() } = {}) {
    const head = pinned ? [pinned] : [];
    const rest = pinned ? pool.filter(track => track !== pinned) : pool;
    const room = Math.max(0, size - head.length);
    if (!rest.length || room <= 0) return head;
    // 池子本来就装得进窗口时不分散：模型看得见全部候选，改顺序只会拿掉已有的确定性。
    if (rest.length <= room) return [...head, ...rest];
    const limit = windowMaxPerAlbum();
    const saturation = windowAlbumSaturation();
    // 点名的歌手/歌单有自己的顺序（歌单按歌单原始顺序、歌手按点名顺序），不参与开放式分散。
    const explicitOrder = !limit || request?.mode === 'playlist' || request?.mode === 'album' || Boolean(request?.artist);
    const albums = new Set(rest.map(albumIdentity).filter(Boolean));
    if (explicitOrder || albums.size < 2) return [...head, ...rest.slice(0, room)];
    const queued = saturation ? albumCountsOf(context?.listening?.queue || []) : new Map();
    const saturatedKeys = new Set([...queued].filter(([, count]) => count >= saturation).map(([key]) => key));
    const windowed = disperseByAlbum(rest, { limit, size: room, deferred: saturatedKeys });
    this.trace({ event: 'music-selection-album-dispersion', sessionId: context?.sessionId || null,
      requestId: context?.requestId || null, albumCount: albums.size, limit, saturation,
      saturatedAlbums: saturatedKeys.size, outsideWindow: rest.length - windowed.length });
    return [...head, ...windowed];
  }

  /** 整张专辑读不到时的 typed 失败：可纠正、不碰队列，也不跨源或换版本顶替。 */
  _albumUnavailable(request, context, reason) {
    this.trace({ event: 'music-selection-album-unavailable', sessionId: context?.sessionId || null,
      requestId: context?.requestId || null, source: request?.album?.source || null, reason: boundedText(reason, 40) });
    return { ok: false, code: 'ALBUM_UNAVAILABLE', request, context, candidates: [],
      message: '这张专辑现在读不到曲目。', userMessage: '这张专辑现在读不到，队列没有变化。' };
  }

  /** exact/引用目标：没有候选供给，目标即结果；旧合同（fallbackCandidates 为空）保持不变。 */
  _targetSelection(request, context) {
    const candidate = this._candidateBuilder(context, request);
    return { ok: true, request, context, signature: selectionSignature(request, context),
      candidates: request.targets.slice(0, request.count).map(candidate), fallbackCandidates: [] };
  }

  _candidateBuilder(context, request, offset = 0) {
    return (track, index) => ({
      candidateId: `${context.requestId || 'prepared'}:${context.virtualPersonId}:${offset + index + 1}`,
      query: [track.artist, track.title].filter(Boolean).join(' — '), sourceSongId: track.songId || null,
      orderedTarget: { ...track, exact: true }, evidence: { source: track.source || null,
        candidateOrigin: track.candidateOrigin || null,
        virtualPersonId: context.virtualPersonId, requestConstraints: request.constraints },
    });
  }

  /** 窗口内每首候选的可解释特征（D3）；读不到实播账本时新鲜度按「没放过」给。 */
  _candidateFeatures(window, { context, tagStore, cadencePlan = null, probeTrack = null, scores = null }) {
    let recentPlays = [];
    try { recentPlays = this.getRecentPlays?.(this.now() - FEATURE_PLAYS_WINDOW_MS) || []; } catch { recentPlays = []; }
    const features = buildCandidateFeatures(window, { tagStore, signals: tasteSignalsDisabled() ? [] : context.tasteSignals,
      recentPlays, now: this.now(), cadencePlan, probeTrack });
    if (!scores) return features;
    // 打分分项进 offer 与决策账本快照（只有数字）；冷却期歌曲没有分数，只标 cooldown。
    return features.map((feature, index) => {
      const entry = scores.get(trackKey(window[index]));
      return entry ? { ...feature, score: entry.score, scoreParts: entry.parts } : feature;
    });
  }

  /**
   * 选歌简报（D1）：唯一生成入口，聊天、续播、手动下一首、预热选序号与群聊登记推荐都经过这里。
   * 正文只随结果返回给本轮模型；trace 只记各部分条数与总长度。
   */
  _selectionBrief(request, context, offerId) {
    if (selectionBriefDisabled()) return null;
    let listening = {};
    try {
      listening = this.getListeningHistory?.({ personId: context.entity?.id || context.virtualPersonId,
        since: this.now() - BRIEF_HISTORY_WINDOW_MS }) || {};
    } catch { listening = {}; }
    const brief = buildSelectionBrief({ request, context, listening, now: this.now(),
      personaTaste: personaMusicTaste({ entity: context.entity }) });
    if (!brief) return null;
    this.trace({ event: 'music-selection-brief', sessionId: context.sessionId, personId: context.virtualPersonId,
      requestId: context.requestId || null, offerId, sections: brief.stats.sections, length: brief.stats.length,
      truncated: brief.stats.truncated });
    return brief.text;
  }

  /** offer 落库：会话/角色/请求身份 + 成员令牌与修订 + 归一化请求 + 候选窗口（+ 对齐的特征）。 */
  _saveOffer(request, context, window, features = null) {
    this.initialize();
    return this.offers.create({
      sessionId: context.sessionId,
      personId: context.virtualPersonId,
      requestId: context.requestId || null,
      roundId: context.roundId || null,
      membershipToken: typeof this.conversationStore.membershipToken === 'function'
        ? this.conversationStore.membershipToken(context.sessionId, context.virtualPersonId) : null,
      membershipRevision: context.membershipRevision || 0,
      request,
      candidates: window.map(cleanTrack),
      features,
      ttlMs: this.offerTtlMs,
    });
  }

  candidateProgram(selection, context, candidates = selection.candidates) {
    return createCandidateProgram({ requestId: context.requestId, mode: selection.request.mode === 'exact' ? 'explicit' : 'curated',
      requestedCount: candidates.length === selection.candidates.length ? selection.request.count : candidates.length,
      candidates, constraints: selection.request.constraints,
      metadata: { musicSelection: selection.request, conversationId: context.sessionId, virtualPersonId: context.virtualPersonId,
        fallbackCandidates: selection.fallbackCandidates || [] } });
  }

  saveSelection(request, context, tracks) {
    this.initialize();
    const selectionId = `selection:${createHash('sha256').update(`${context.requestId}:${context.virtualPersonId}:${selectionSignature(request, context)}:${JSON.stringify(tracks.map(cleanTrack))}`).digest('hex').slice(0, 32)}`;
    this.conversationStore.db.prepare(`INSERT OR IGNORE INTO music_selections VALUES (?, ?, ?, ?, ?, ?)`)
      .run(selectionId, context.sessionId, context.virtualPersonId, JSON.stringify(request), JSON.stringify(tracks.map(cleanTrack)), this.now());
    return selectionId;
  }

  /** 自动任务（如续播运行器）的工具上下文：锁定请求与触发原因以任务为准。 */
  _executionContext(input = {}, task = null) {
    const merged = { ...input };
    if (task) {
      if (task.sessionId != null) merged.sessionId = task.sessionId;
      if (task.reason != null) merged.reason = task.reason;
      if (task.outputGeneration != null) merged.outputGeneration = task.outputGeneration;
      if (task.preparedFor != null) merged.preparedFor = task.preparedFor;
      if (typeof task.isCurrent === 'function') merged.isCurrent = task.isCurrent;
    }
    return this.context(merged);
  }

  /**
   * select_music 入口。
   * - exact（点播/引用）：确定性解析 + 提交，与既有合同一致。
   * - 其它模式：只返回候选 offer，绝不自选、不触播放器。
   * - 自动任务：`input.musicTaskRequest` 锁定的请求唯一有效，模型参数不得改写模式/交付/约束。
   */
  async execute(rawRequest, input = {}) {
    const task = input?.musicTaskRequest && typeof input.musicTaskRequest === 'object' ? input.musicTaskRequest : null;
    const context = this._executionContext(input, task);
    context.signal?.throwIfAborted();
    let request;
    // 聊天里接受 ambient 推荐（引用映射到那条推荐的 selection）：不改写续播计划，推荐人另记。
    let accepting = null;
    try {
      const normalized = task?.request ? null : normalizeMusicSelection(rawRequest || {});
      const pending = input.acceptingRecommendation;
      if (pending?.selectionId && normalized?.reference?.selectionId === pending.selectionId) accepting = pending;
      request = task?.request
        ? normalizeMusicSelection(task.request)
        : this.resolveReference(normalized, context);
    } catch (error) {
      // 参数不合法是可纠正的：给回 typed 失败与原因，不把选歌失败升级成内部错误。
      if (!(error instanceof TypeError)) throw error;
      return { ok: false, code: 'INVALID_MUSIC_REQUEST', message: String(error.message || '').slice(0, 200),
        userMessage: '这次没听清要放什么，队列没有变化。' };
    }
    if (request.mode !== 'exact') {
      const selected = await this.select(request, context);
      // 只给会真正提交的 offer 预解析；预热任务（resolveOnly）只挑序号，采用时才解析。
      if (selected?.offerId && task?.resolveOnly !== true) {
        // 预解析只是提速：任何异常都留在这里，提交时自然回落到常规解析。
        try { this._preResolveOffer(selected.offer, context); } catch (error) {
          this.trace({ event: 'music-selection-pre-resolve-skipped', sessionId: context.sessionId,
            offerId: selected.offerId, reason: error?.name || 'Error' });
        }
      }
      return selected;
    }
    const proposalOnly = Boolean(input.groupAction && input.groupAction.ownerId !== input.virtualPersonId);
    const mutation = !proposalOnly && request.delivery !== 'recommend_only';
    // 精确点歌提交即本轮终止：用审核过的固定句收尾，不再为一句确认多跑一轮模型。
    const commit = markCommitAttempt => this._commit(request, { ...input, context, selection: this._targetSelection(request, context) },
      { commitAttempt: markCommitAttempt, terminalLine: mutation,
        ...(accepting ? { keepListeningPlan: true, recommendedBy: accepting.recommendedBy || null } : {}) });
    return mutation ? this.mutate(input, commit) : commit(null);
  }

  /**
   * ambient 推荐（add-ambient-music-recommendation）：一首明确目标走 exact + recommend_only，
   * 套用当前一起听计划的硬条件，做 canonical 与可播放解析，再排除已在队列、近期放过、
   * 你说过不喜欢的歌。只登记 music_selections 引用：不提交播放器、不写音乐动作收据、不替歌。
   *
   * @returns {{ok:true, selectionId, track} | {ok:false, code, reason?}}
   *   code ∈ RECOMMENDATION_INVALID / RECOMMENDATION_UNRESOLVED / RECOMMENDATION_EXCLUDED
   */
  async recommendTrack({ title = '', artist = '' } = {}, input = {}) {
    const context = this.context(input);
    context.signal?.throwIfAborted();
    let request;
    try {
      request = normalizeMusicSelection({ mode: 'exact', delivery: 'recommend_only', count: 1,
        targets: [{ title, artist }], constraints: planConstraints(context.listening) });
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return { ok: false, code: 'RECOMMENDATION_INVALID' };
    }
    const result = await this._commit(request, { ...input, context, selection: this._targetSelection(request, context) });
    const track = result.ok ? result.tracks?.[0] : null;
    if (!track?.songId) return { ok: false, code: 'RECOMMENDATION_UNRESOLVED' };
    const reason = this._recommendationExclusion(track, context);
    if (reason) return { ok: false, code: 'RECOMMENDATION_EXCLUDED', reason };
    return { ok: true, code: 'RECOMMENDATION_RESOLVED', selectionId: result.selectionId, track };
  }

  /** 推荐的排除项：已在当前或待播队列、冷却期内放过（provider + songId）、这位伙伴记着你不喜欢。 */
  _recommendationExclusion(track, context) {
    const key = `${track.source}:${track.songId}`;
    const listening = context.listening || {};
    const from = Math.max(0, Number.isInteger(listening.currentIndex) ? listening.currentIndex : 0);
    if ((listening.queue || []).slice(from).some(item => trackKey(cleanTrack(item)) === key)) return 'queued';
    let recent = [];
    try { recent = this.getRecentPlays?.(this.now() - freshnessCooldownMs()) || []; } catch { recent = []; }
    if (recent.some(row => `${String(row.source || '').split(/[:-]/)[0]}:${row.songId || row.song_id}` === key)) return 'recent';
    const memory = this.getMemoryService();
    const rows = memory?.searchMemory?.(undefined, { namespace: context.entity.memoryNamespace, tags: `song:${track.songId}`, limit: 20 }) || [];
    const disliked = rows.some(row => {
      if (isMemoryRevoked(memory.store, row) || (row.expiresAt && row.expiresAt <= this.now())) return false;
      const evidence = parseEvidence(row);
      return evidence.sentiment === 'dislike' && String(evidence.songId) === track.songId
        && (!evidence.source || String(evidence.source).split(/[:-]/)[0] === track.source);
    });
    return disliked ? 'disliked' : null;
  }

  /**
   * 确认一条 ambient 推荐：按存储的 selection 引用重建 exact 目标，after_current 重新解析并提交，
   * 不打断当前歌、不改写续播计划。提交人是当前音乐负责人，推荐人另记 recommendedBy。
   * 同一推荐的重复确认共用一个收据（requestId = recommend-accept:<turnId>），不会重复入队。
   */
  async acceptRecommendation({ sessionId, turnId, selectionId, recommenderId = null, committerId } = {}) {
    const input = { sessionId, virtualPersonId: committerId, requestId: `recommend-accept:${turnId}`, reason: 'user_request' };
    const context = this.context(input);
    let request;
    try {
      request = this.resolveReference(normalizeMusicSelection({ mode: 'exact', delivery: 'after_current', count: 1,
        reference: { selectionId, indexes: [1] }, constraints: planConstraints(context.listening) }), context);
    } catch {
      return { ok: false, code: 'RECOMMENDATION_UNRESOLVED' };
    }
    return this.mutate(input, markCommitAttempt => this._commit(request,
      { ...input, context, selection: this._targetSelection(request, context) },
      { commitAttempt: markCommitAttempt, keepListeningPlan: true, recommendedBy: recommenderId }));
  }

  /**
   * commit_music_selection 入口：只接受 select_music 给出的 offer。
   *
   * 校验 offer 存在/未过期/同一会话与角色（群聊由音乐负责人提交）/同一轮请求/
   * 成员令牌与修订未变；随后只按 *存储的* 归一化请求重建 exact 目标，重新做
   * canonical 解析与硬约束校验。能放的按原顺序提交、放不了的点名，绝不替歌；
   * 一首都放不了才整批失败、队列不变。
   *
   * 唯一的窄放宽：offer 处于 `prepared`（预热任务挂起）且调用方带着同源
   * `input.preparedAccept` 时，允许跳过“同一 requestId”规则，改由 preparedFor
   * （会话/输出代次/边界）核对；普通对话提交仍然必须同轮。
   */
  async commitSelection(args = {}, input = {}) {
    const task = input?.musicTaskRequest && typeof input.musicTaskRequest === 'object' ? input.musicTaskRequest : null;
    const context = this._executionContext(input, task);
    context.signal?.throwIfAborted();
    // 群聊里非负责人提交自己的候选 = 登记推荐（add-peer-message-protocol D5）：照常做 canonical
    // 解析与硬约束校验，交付强制 recommend_only，不碰播放器、不占本轮音乐收据；负责人提交时合并。
    const registersRecommendation = Boolean(input.groupAction && input.groupAction.ownerId !== input.virtualPersonId);
    // 预热批次采用是续播的播放路径，不是聊天里的推荐：非负责人仍然拒绝。
    if (registersRecommendation && context.preparedAccept) {
      return { ok: false, code: 'MUSIC_OWNER_REQUIRED',
        message: '本轮音乐由负责提交的角色决定，这里不重复提交。',
        userMessage: '这一轮的音乐由负责提交的角色决定，我没有重复操作。' };
    }
    const offerId = String(args?.offerId || '').trim();
    if (!offerId) {
      return { ok: false, code: 'SELECTION_OFFER_UNAVAILABLE',
        message: '没有可提交的候选，请先调用 select_music 取得候选。', userMessage: OFFER_UNAVAILABLE_COPY };
    }
    if (args?.delivery != null) {
      this.trace({ event: 'music-selection-delivery-arg', sessionId: context.sessionId, offerId,
        requested: String(args.delivery), note: '交付方式以存储的请求为准' });
    }
    const resolveOnly = task?.resolveOnly === true;
    const preparedFor = context.preparedFor && typeof context.preparedFor === 'object' ? context.preparedFor : null;
    const commit = async markCommitAttempt => {
      this.initialize();
      const offer = this.offers.get(offerId);
      const rejection = this._offerRejection(offer, context);
      if (rejection) return rejection;
      const indexes = normalizeOfferIndexes(args?.indexes, offer.candidates.length);
      if (!indexes) {
        return { ok: false, code: 'INVALID_SELECTION_INDEXES',
          message: `候选序号必须是 1-${offer.candidates.length} 之间、互不重复的整数。`,
          userMessage: '这次没有对上是哪几首，队列没有变化。' };
      }
      // prepared 状态的 offer 只能由核对过 preparedFor 的边界认领（单次、原子）。
      const preparedConsumption = offer.status === 'prepared';
      // 已确认拿不到音源的序号在认领前退回：offer 保持可用，模型换序号或少交几首。
      // 不按提交次数封顶；预热采用没有模型可纠正，沿用原有的失败即作废。
      const unplayableIndexes = preparedConsumption ? [] : indexes.filter(index => {
        const track = offer.candidates[index - 1];
        return this._unplayable.has(track?.source, track?.songId);
      });
      if (unplayableIndexes.length) {
        // 整组一起列出：启动初期冷却记录还空，offer 里可能混着多首刚被预解析标出的歌，
        // 只点名本次选中的会让模型一个个换、一个个撞，直到用完轮数。
        const knownUnplayableIndexes = offer.candidates.map((track, index) => index + 1)
          .filter(index => this._unplayable.has(offer.candidates[index - 1]?.source, offer.candidates[index - 1]?.songId));
        this.trace({ event: 'music-selection-unplayable-rejected', sessionId: context.sessionId, offerId,
          unplayableIndexes, knownUnplayableIndexes });
        return { ok: false, code: 'SELECTION_INDEXES_UNPLAYABLE', offerId, unplayableIndexes, knownUnplayableIndexes,
          message: `序号 ${unplayableIndexes.join('、')} 已经确认拿不到音源，这次放不了。这组候选里目前已知放不了的序号是 ${knownUnplayableIndexes.join('、')}，请从其余序号里选，或少交几首；不要再提交这些序号。`,
          userMessage: '有几首现在放不了，队列没有变化。' };
      }
      if (!this.offers.claim(offerId, { prepared: preparedConsumption })) {
        return { ok: false, code: 'SELECTION_OFFER_UNAVAILABLE',
          message: '这组候选已经被使用，请重新调用 select_music。', userMessage: OFFER_UNAVAILABLE_COPY };
      }
      try {
        if (resolveOnly) {
          const chosen = indexes.map(index => offer.candidates[index - 1]);
          if (preparedFor) {
            // 预热：登记序号与采用凭据（preparedFor），不做 canonical 解析，也不触碰播放器。
            if (!this.offers.holdForPreparation(offerId, { indexes, preparedFor })) {
              return { ok: false, code: 'SELECTION_OFFER_UNAVAILABLE',
                message: '这组候选已经不能挂起为预热批次。', userMessage: OFFER_UNAVAILABLE_COPY };
            }
          } else {
            this.offers.consume(offerId, { ok: true, code: 'MUSIC_CANDIDATES_SELECTED', indexes });
          }
          return { ok: true, code: 'MUSIC_CANDIDATES_SELECTED', terminal: true, offerId, indexes,
            offeredIndexes: indexes, prepared: Boolean(preparedFor),
            candidateCount: offer.candidates.length, tracks: chosen };
        }
        const request = this._exactRequestFromOffer(offer, indexes);
        const selection = this._targetSelection(request, context);
        // 提交开始后不再发起新的预解析；进行中的会被提交等待复用。
        this._preResolutions.get(offerId)?.stop();
        const isCurrent = () => {
          if (context.signal?.aborted || (context.isCurrent && !context.isCurrent())) return false;
          // 负责人提交途中失去负责人身份就作废；登记推荐与负责人是谁无关。
          if (!registersRecommendation && input.groupAction && input.groupAction.ownerId !== context.virtualPersonId) return false;
          if (this.registry.get(context.virtualPersonId)?.status === 'archived') return false;
          const live = this.offers.get(offerId);
          if (live?.status !== 'claimed') return false;
          return !this._offerRejection({ ...live, status: offer.status }, context);
        };
        const result = await this._commit(request, { ...input, context: { ...context, isCurrent }, selection },
          { commitAttempt: markCommitAttempt, terminalLine: !registersRecommendation && request.delivery !== 'recommend_only',
            resolutionCache: preparedConsumption ? null : this._offerResolutionCache(offer, context, input),
            offer, indexes,
            decisionPath: decisionPath({ proposal: registersRecommendation, delivery: request.delivery,
              prepared: preparedConsumption, reason: task?.reason ?? input.reason ?? null, task: Boolean(task) }),
            // 预热采用保留边界当时推导出的请求（软锚点跟得上当前边界），其余仍以存储请求为准。
            planRequest: normalizeMusicSelection(context.preparedAccept?.planRequest || offer.request) });
        if (result.ok) {
          this._dropOfferResolutionCache(offerId);
          this.offers.consume(offerId, { ok: true, code: result.code, delivery: result.delivery, selectionId: result.selectionId });
          this.trace({ event: 'music-selection-commit', sessionId: context.sessionId, offerId, indexes,
            code: result.code, delivery: result.delivery, prepared: preparedConsumption });
        } else if (preparedConsumption) {
          // 预热采用的 canonical 失败：批次作废（单次使用），不换序号、不替歌；重试回落实时选歌。
          this.offers.consume(offerId, { ok: false, code: result.code });
          this.trace({ event: 'music-preparation-adopt-failed', sessionId: context.sessionId, offerId, indexes, code: result.code });
        } else {
          // 解析失败没有任何播放副作用：offer 放回 open，同一轮可以用修正后的序号重试。
          this.offers.release(offerId);
        }
        return result;
      } catch (error) {
        // 提交中途异常：无法确认是否已产生播放副作用，offer 按已使用处理，要求重新选择。
        this._dropOfferResolutionCache(offerId);
        this.offers.consume(offerId, { ok: false, code: 'MUSIC_NOT_COMMITTED' });
        throw error;
      }
    };
    // 交付方式要读完存储的请求才知道（只读探查不影响校验），据此决定是否走幂等收据：
    // 播放类提交必须幂等；只推荐不播放的提交不占用本轮音乐动作收据。
    this.initialize();
    const peek = this.offers.get(offerId);
    const mutation = !registersRecommendation && peek?.request?.delivery !== 'recommend_only';
    return mutation ? this.mutate(input, commit) : commit(null);
  }

  /** Offer-scoped, fixed TTL, bounded process memory. Reuse never includes a validation verdict. */
  _offerResolutionCache(offer, context, input) {
    const cache = this._resolutionCache;
    const prune = () => {
      for (const [key, entry] of cache) if (entry.expiresAt <= this.now()) cache.delete(key);
    };
    prune();
    const scope = JSON.stringify([offer.offerId, context.sessionId, context.virtualPersonId,
      context.requestId ?? null, context.roundId ?? null, offer.membershipRevision, offer.membershipToken,
      context.outputGeneration ?? null, context.listening?.outputGeneration ?? null,
      input.groupAction?.ownerId ?? null, offer.request]);
    const keyFor = candidate => JSON.stringify([scope, candidate.evidence?.source,
      candidate.evidence?.virtualPersonId, candidate.sourceSongId, candidate.query, candidate.orderedTarget]);
    return {
      get: candidate => {
        prune();
        const entry = cache.get(keyFor(candidate));
        return entry ? structuredClone(entry.result) : null;
      },
      // 同一 offer 的后台预解析（完成或进行中）；没有则返回 null。
      pending: candidate => this._preResolved(offer.offerId, candidate),
      knownUnplayable: candidate => this._unplayable.has(...unplayableRef(candidate)),
      markUnplayable: candidate => this._unplayable.mark(...unplayableRef(candidate)),
      set: (candidate, result) => {
        prune();
        const key = keyFor(candidate);
        // A hit cannot extend a resource's lifetime.
        if (cache.has(key)) return;
        cache.set(key, { offerId: offer.offerId, result: structuredClone(result),
          expiresAt: Math.min(offer.expiresAt, this.now() + RESOLUTION_CACHE_TTL_MS) });
        while (cache.size > RESOLUTION_CACHE_MAX_ITEMS) cache.delete(cache.keys().next().value);
      },
    };
  }

  _dropOfferResolutionCache(offerId) {
    for (const [key, entry] of this._resolutionCache) if (entry.offerId === offerId) this._resolutionCache.delete(key);
    this._preResolutions.get(offerId)?.stop();
    this._preResolutions.delete(offerId);
  }

  /**
   * 后台预解析 offer 候选的可播放版本：有界并发、单首超时、不阻塞 select_music 返回。
   * 结果只留在进程内存，按 offer 与 `(provider, songId)` 索引；提交时仍重新做约束校验，
   * 失败或未命中就走原解析路径。媒体资源不进 offer、回执、工具结果或 trace。
   */
  _preResolveOffer(offer, context) {
    const resolveTrack = this.programCommitService?.resolveTrack;
    if (!this.preResolveConcurrency || typeof resolveTrack !== 'function' || !offer?.candidates?.length) return;
    for (const [offerId, entry] of this._preResolutions) {
      if (entry.expiresAt <= this.now()) this._dropOfferResolutionCache(offerId);
    }
    while (this._preResolutions.size >= PRE_RESOLVE_MAX_OFFERS) {
      this._dropOfferResolutionCache(this._preResolutions.keys().next().value);
    }
    // exact 请求有数量上限，按块重建，保证大 offer 的每个候选都与提交时同形。
    // 只取窗口前 MUSIC_PRE_RESOLVE_HEAD 首；其余序号被选中时由提交路径常规解析。
    const head = Math.min(offer.candidates.length, preResolveHead());
    if (!head) return;
    const candidates = [];
    for (let start = 0; start < head; start += PRE_RESOLVE_CHUNK) {
      const indexes = offer.candidates.slice(start, Math.min(head, start + PRE_RESOLVE_CHUNK)).map((_, index) => start + index + 1);
      candidates.push(...this._targetSelection(this._exactRequestFromOffer(offer, indexes), context).candidates);
    }
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
    let stopped = false;
    const entries = new Map();
    this._preResolutions.set(offer.offerId, { entries,
      expiresAt: Math.min(Number(offer.expiresAt) || Infinity, this.now() + RESOLUTION_CACHE_TTL_MS),
      stop: () => { stopped = true; } });
    let next = 0;
    const worker = async () => {
      while (!stopped && !signal.aborted && next < candidates.length) {
        const candidate = candidates[next++];
        let timer;
        const pending = Promise.race([
          Promise.resolve().then(() => resolveTrack.call(this.programCommitService, candidate.query, {
            requestId: context.requestId || null, candidate, attempt: 1, signal, preResolve: true })),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), PRE_RESOLVE_TIMEOUT_MS); }),
        ]).then(result => {
          // 失败结果不交给提交复用，但「拿不到音源」要留下：下一次选歌与提交前检查都用得上。
          if (isConfirmedUnplayable(result)) this._unplayable.mark(...unplayableRef(candidate));
          return result?.ok ? result : null;
        }, () => null).finally(() => clearTimeout(timer));
        entries.set(preResolveKey(candidate), pending);
        await pending;
      }
    };
    for (let index = 0; index < Math.min(this.preResolveConcurrency, candidates.length); index++) worker();
    this.trace({ event: 'music-selection-pre-resolve', sessionId: context.sessionId, offerId: offer.offerId,
      candidates: candidates.length, windowSize: offer.candidates.length, concurrency: this.preResolveConcurrency });
  }

  _preResolved(offerId, candidate) {
    const entry = this._preResolutions.get(offerId);
    if (!entry || entry.expiresAt <= this.now()) return null;
    const pending = entry.entries.get(preResolveKey(candidate));
    return pending ? pending.then(result => (result ? structuredClone(result) : null)) : null;
  }

  /** offer 与当前提交上下文必须完全同源；任何一项不符都 fail closed。 */
  _offerRejection(offer, context) {
    const unavailable = message => ({ ok: false, code: 'SELECTION_OFFER_UNAVAILABLE', message, userMessage: OFFER_UNAVAILABLE_COPY });
    if (!offer) return unavailable('找不到这组候选，请重新调用 select_music。');
    if (offer.status === 'consumed') return unavailable('这组候选已经提交过，不能重复使用。');
    if (offer.status === 'claimed') return unavailable('这组候选正在提交中，请等这一步完成。');
    if (offer.status === 'prepared' && !this._preparedAcceptMatches(offer, context)) {
      return unavailable('这组候选是为预热准备的，只能由对应的续播边界采用。');
    }
    if (Number(offer.expiresAt) <= this.now()) return unavailable('这组候选已经过期，请重新调用 select_music。');
    if (offer.sessionId !== String(context.sessionId || '')) return unavailable('这组候选属于另一个聊天，不能在这里提交。');
    if (offer.virtualPersonId !== String(context.virtualPersonId || '')) return unavailable('这组候选属于另一位伙伴，不能替你提交。');
    // 预热采用时 requestId 必然来自另一个回合：这条规则被 preparedFor 核对取代。
    if (offer.status !== 'prepared' && offer.requestId && context.requestId && offer.requestId !== String(context.requestId)) {
      return unavailable('这组候选来自另一轮请求，请在本轮重新调用 select_music。');
    }
    const room = this.conversationStore.getSession(context.sessionId);
    if (!room || room.archivedAt || !room.memberIds.includes(context.virtualPersonId)) {
      return unavailable('这个聊天或角色已经不可用，候选不能提交。');
    }
    if (Number(offer.membershipRevision) !== Number(room.membershipRevision)) {
      return unavailable('这个聊天的成员已经变化，候选作废，请重新选一次。');
    }
    const token = typeof this.conversationStore.membershipToken === 'function'
      ? this.conversationStore.membershipToken(context.sessionId, context.virtualPersonId) : null;
    if (offer.membershipToken != null && token != null && Number(offer.membershipToken) !== Number(token)) {
      return unavailable('你的角色成员身份已经变化，候选作废，请重新选一次。');
    }
    return null;
  }

  /**
   * 预热采用的窄放宽核对：preparedFor 必须与调用方声明、以及当前上下文完全同源
   * （同一会话、同一输出代次、同一或尚未绑定的边界）。缺一不可。
   */
  _preparedAcceptMatches(offer, context) {
    const accept = context?.preparedAccept;
    const preparedFor = offer?.preparedFor;
    if (!accept || !preparedFor) return false;
    if (String(preparedFor.listeningSessionId || '') !== String(context.sessionId || '')) return false;
    if (String(accept.listeningSessionId || '') !== String(context.sessionId || '')) return false;
    if (String(preparedFor.outputGeneration ?? '') !== String(context.outputGeneration ?? '')) return false;
    const liveBoundary = accept.boundaryKey == null ? null : String(accept.boundaryKey);
    // 挂起时已经有边界 → 必须还是那个边界；挂起时尚无边界（提前量准备）→ 接受第一个到来的边界。
    if (preparedFor.boundaryKey != null && String(preparedFor.boundaryKey) !== liveBoundary) return false;
    return true;
  }

  /** 只按存储的请求重建 exact 目标：模型参数不能改写模式、交付、数量或硬约束。 */
  _exactRequestFromOffer(offer, indexes) {
    const tracks = indexes.map(index => offer.candidates[index - 1]);
    return normalizeMusicSelection({
      ...offer.request,
      mode: 'exact',
      count: tracks.length,
      targets: tracks.map(track => ({ title: track.title, artist: track.artist, songId: track.songId, source: track.source })),
      reference: null,
    });
  }

  /**
   * 把受限 preparation 任务挂起的 offer 落成一个待采用批次（prepared entry）。
   *
   * 批次身份来自 offer 自身（会话/角色/成员令牌与修订），边界身份来自
   * preparedFor；全程不解析、不播放器。批次与它引用的 offer 单次使用，
   * 采用时才做 canonical 解析 + 硬约束校验。
   */
  savePreparedBatch({ offerId, indexes = null, sessionId = null, personId = null, position = null } = {}) {
    this.initialize();
    const offer = this.offers.get(offerId);
    if (!offer) return { ok: false, code: 'SELECTION_OFFER_UNAVAILABLE', message: '预热候选已经不可用。' };
    if (offer.status !== 'prepared' || !offer.preparedFor) {
      return { ok: false, code: 'PREPARATION_NOT_HELD', message: '这组候选没有挂起为预热批次。' };
    }
    if (sessionId && String(sessionId) !== offer.sessionId) return { ok: false, code: 'PREPARATION_CONTEXT_MISMATCH' };
    if (personId && String(personId) !== offer.virtualPersonId) return { ok: false, code: 'PREPARATION_CONTEXT_MISMATCH' };
    const normalized = normalizeOfferIndexes(indexes, offer.candidates.length);
    if (!normalized) return { ok: false, code: 'INVALID_SELECTION_INDEXES' };
    const request = normalizeMusicSelection(offer.request || {});
    const preparedFor = offer.preparedFor;
    const prepared = this.prepared.create({
      sessionId: offer.sessionId, personId: offer.virtualPersonId,
      outputGeneration: preparedFor.outputGeneration ?? null, boundaryKey: preparedFor.boundaryKey ?? null,
      offerId: offer.offerId, indexes: normalized, request, position,
      prewarmKey: prewarmBatchKey({ request, sessionId: offer.sessionId, personId: offer.virtualPersonId }),
      membershipToken: offer.membershipToken, membershipRevision: offer.membershipRevision,
    });
    // 批次要活过“当前这首还在播”的等待窗口，引用的 offer 至少同步到批次 TTL。
    this.offers.extend(offer.offerId, { expiresAt: prepared.expiresAt });
    this.prewarmStats.prepared++;
    this.trace({ event: 'music-preparation-held', sessionId: offer.sessionId, personId: offer.virtualPersonId,
      offerId: offer.offerId, preparedId: prepared.preparedId, indexes: normalized,
      outputGeneration: preparedFor.outputGeneration ?? null, boundaryKey: preparedFor.boundaryKey ?? null });
    return { ok: true, preparedId: prepared.preparedId, offerId: offer.offerId, indexes: normalized,
      tracks: normalized.map(index => offer.candidates[index - 1]) };
  }

  /**
   * 续播边界采用预热批次：先按会话/角色/输出代次/边界/成员/请求签名/队列逐项核对，
   * 命中再走与普通提交完全相同的 canonical 解析 + 硬约束校验，全程不发起模型调用。
   *
   * 返回 `{ matched, ok, result }`：matched=false 表示没有可用批次（正确的动作是回落
   * 实时选歌）；matched=true 且 ok=false 表示批次已被采用但解析失败 —— fail closed，
   * 不换序号、不替歌，也不在本轮悄悄回落。与当前边界不同源的批次在核对失败时立即
   * 作废（单次使用、不复活），下一次边界重新预热，不会再被捡起重复排歌。
   */
  async consumePrepared(input = {}) {
    this.initialize();
    const accept = input.preparedAccept && typeof input.preparedAccept === 'object' ? input.preparedAccept : null;
    if (!accept || !input.request) return { matched: false, ok: false, reason: 'no-accept' };
    let context;
    try {
      context = this._executionContext(input, null);
    } catch (error) {
      return { matched: false, ok: false, reason: 'context-unavailable', message: String(error?.message || '').slice(0, 200) };
    }
    const liveRequest = normalizeMusicSelection(input.request);
    // 只推荐不播放：不存在可“采用来播放”的批次，直接回落（正常提交也不会播放）。
    if (liveRequest.delivery === 'recommend_only') return { matched: false, ok: false, reason: 'recommend-only' };
    this.prewarmStats.expired += this.prepared.markExpired();
    const candidates = this.prepared.listReady({ sessionId: context.sessionId, personId: context.virtualPersonId });
    let rejectionReason = null;
    for (const entry of candidates) {
      const rejection = this._preparedRejection(entry, { context, liveRequest, accept });
      if (rejection) {
        if (['expired', 'invalidated'].includes(rejection)) this.prewarmStats.expired++;
        else this.prewarmStats.mismatch++;
        rejectionReason = rejection;
        // 单次使用：与当前边界不同源的批次立刻作废，不留在“待采用”里继续挡住
        // 后续预热，也不会在再下一个边界被重新捡起（那会重复排歌）。
        this.prepared.markFailed(entry.preparedId, { ok: false, code: 'PREPARED_MISMATCH', reason: rejection });
        this.trace({ event: 'music-preparation-discarded', sessionId: entry.sessionId, personId: entry.virtualPersonId,
          preparedId: entry.preparedId, boundaryKey: entry.boundaryKey, reason: rejection });
        continue;
      }
      return this._adoptPrepared(entry, { input, context, accept, liveRequest });
    }
    return { matched: false, ok: false, reason: rejectionReason || 'none' };
  }

  /**
   * 只读查询：该 (会话, 角色, 输出代次) 是否已有仍然有效的待采用批次。
   * 预热触发点据此去重——已有批次时不再发起第二个模型任务。
   */
  readyPrepared({ sessionId = null, personId = null, outputGeneration = null } = {}) {
    this.initialize();
    if (!sessionId) return null;
    return this.prepared.listReady({ sessionId, personId })
      .find(entry => String(entry.outputGeneration ?? '') === String(outputGeneration ?? '')) || null;
  }

  /** 批次与当前边界必须逐项同源；任何一项不符都算 mismatch（回落实时选歌）。 */
  _preparedRejection(entry, { context, liveRequest, accept } = {}) {
    if (String(entry.sessionId || '') !== String(context.sessionId || '')) return 'session';
    if (String(entry.virtualPersonId || '') !== String(context.virtualPersonId || '')) return 'person';
    if (String(entry.outputGeneration ?? '') !== String(context.outputGeneration ?? '')) return 'generation';
    const liveBoundary = accept?.boundaryKey == null ? null : String(accept.boundaryKey);
    // 挂起时有明确边界 → 必须仍是同一个边界；提前量挂起（无边界）→ 接受第一个到来的边界。
    if (entry.boundaryKey != null && String(entry.boundaryKey) !== liveBoundary) return 'boundary';
    const room = this.conversationStore.getSession(context.sessionId);
    if (!room || room.archivedAt || !room.memberIds.includes(context.virtualPersonId)) return 'membership';
    if (Number(entry.membershipRevision) !== Number(room.membershipRevision)) return 'membership';
    const token = typeof this.conversationStore.membershipToken === 'function'
      ? this.conversationStore.membershipToken(context.sessionId, context.virtualPersonId) : null;
    if (entry.membershipToken != null && token != null && Number(entry.membershipToken) !== Number(token)) return 'membership';
    const liveKey = prewarmBatchKey({ request: liveRequest, sessionId: context.sessionId, personId: context.virtualPersonId });
    if (entry.prewarmKey !== liveKey) return 'request';
    const offer = this.offers.get(entry.offerId);
    if (!offer) return 'offer-missing';
    if (offer.status !== 'prepared') return 'offer-consumed';
    if (Number(offer.expiresAt) <= this.now()) return 'expired';
    // 队列变化让批次变陈旧：待采用的歌已经被排进本会话队列时作废，避免重复排歌。
    const queued = new Set((context.listening?.queue || []).map(trackKey));
    if (entry.indexes.some(index => queued.has(trackKey(cleanTrack(offer.candidates[index - 1] || {}))))) return 'queue';
    return null;
  }

  async _adoptPrepared(entry, { input = {}, context, accept, liveRequest } = {}) {
    try {
      const result = await this.commitSelection({ offerId: entry.offerId, indexes: entry.indexes }, {
        ...input,
        sessionId: context.sessionId,
        virtualPersonId: context.virtualPersonId,
        outputGeneration: context.outputGeneration,
        preparedAccept: accept,
      });
      if (result?.ok === true) {
        this.prepared.markConsumed(entry.preparedId, { ok: true, code: result.code, delivery: result.delivery,
          tracks: Array.isArray(result.tracks) ? result.tracks.length : 0 });
        this.prewarmStats.consumed++;
        this.trace({ event: 'music-preparation-adopted', sessionId: entry.sessionId, personId: entry.virtualPersonId,
          preparedId: entry.preparedId, offerId: entry.offerId, code: result.code, delivery: result.delivery });
        return { matched: true, ok: true, entry, result };
      }
      this.prepared.markFailed(entry.preparedId, { ok: false, code: result?.code || 'MUSIC_NOT_COMMITTED' });
      this.prewarmStats.failed++;
      this.trace({ event: 'music-preparation-adopt-failed', sessionId: entry.sessionId, personId: entry.virtualPersonId,
        preparedId: entry.preparedId, offerId: entry.offerId, code: result?.code || 'MUSIC_NOT_COMMITTED' });
      return { matched: true, ok: false, failClosed: true, entry, result };
    } catch (error) {
      this.prepared.markFailed(entry.preparedId, { ok: false, code: String(error?.code || 'PREPARED_ADOPT_FAILED').slice(0, 80) });
      this.prewarmStats.failed++;
      if (input.signal?.aborted || (typeof input.isCurrent === 'function' && !input.isCurrent())) {
        return { matched: true, ok: false, failClosed: true, entry,
          result: { ok: false, code: 'STALE_CONTINUATION', message: '采用预热批次时这个边界已经失效。' } };
      }
      return { matched: true, ok: false, failClosed: true, entry,
        result: { ok: false, code: String(error?.code || 'PREPARED_NOT_RESOLVED').slice(0, 80),
          message: String(error?.message || '预热批次没有完成提交。').slice(0, 200) } };
    }
  }

  /** 记忆/标签/曲库/会话变化：未采用的预热批次全部作废（单次使用，不可复活）。 */
  invalidatePrepared({ sessionId = null } = {}) {
    this.initialize();
    const changes = this.prepared.invalidate({ sessionId });
    this.prewarmStats.invalidated += changes;
    return changes;
  }

  preparedStats() {
    return { ...this.prewarmStats };
  }

  /** 边界没有可用批次、回落到实时选歌时记一笔（诊断，不产生任何用户可见文案）。 */
  notePrewarmFallback({ reason = 'none' } = {}) {
    this.prewarmStats.fallback++;
    this.trace({ event: 'music-preparation-fallback', reason: String(reason || 'none') });
    return this.prewarmStats.fallback;
  }

  /** A live in-flight attempt blocks duplicates; a receipt left behind by a terminated process does not. */
  receiptIsLiveRunning(prior) {
    if (prior?.status !== 'running') return false;
    return this.now() - Number(prior.updated_at || 0) <= RUNNING_RECEIPT_TTL_MS;
  }

  musicActionStatus({ requestId, roundId } = {}) {
    this.initialize();
    const actionId = `${roundId || requestId}:music`;
    return this.conversationStore.db.prepare('SELECT status FROM music_action_receipts WHERE action_id = ?')
      .get(actionId)?.status || null;
  }

  async mutate(input, execute) {
    this.initialize();
    if (input.groupAction && input.groupAction.ownerId !== input.virtualPersonId) return { ok: false, code: 'MUSIC_OWNER_REQUIRED' };
    const actionId = `${input.roundId || input.requestId}:music`;
    {
      const prior = this.conversationStore.db.prepare('SELECT * FROM music_action_receipts WHERE action_id = ?').get(actionId);
      if (prior?.status === 'committed') return { ...JSON.parse(prior.result_json), replayed: true,
        message: '本轮已有音乐操作完成；这里返回之前的结果，不再重复修改播放器。' };
      if (this.receiptIsLiveRunning(prior)) return { ok: false, code: 'MUSIC_ACTION_IN_PROGRESS', message: '本轮音乐操作已开始，未重复执行。请查看本聊天的播放队列。' };
      if (prior?.status === 'uncertain') return { ok: false, code: 'MUSIC_ACTION_UNCONFIRMED', message: '刚才的播放操作未能确认完成，请检查播放器状态后再试。' };
      this.conversationStore.db.prepare(`INSERT INTO music_action_receipts VALUES (?, ?, ?, 'running', NULL, ?)
        ON CONFLICT(action_id) DO UPDATE SET status = 'running', updated_at = excluded.updated_at`)
        .run(actionId, input.sessionId, input.requestId, this.now());
    }
    let commitAttempted = false;
    try {
      const result = await execute(() => { commitAttempted = true; });
      this.conversationStore.db.prepare('UPDATE music_action_receipts SET status = ?, result_json = ?, updated_at = ? WHERE action_id = ?')
        .run(result.ok ? 'committed' : 'failed', JSON.stringify(result.ok ? result : { ok: false, code: result.code }), this.now(), actionId);
      return result;
    } catch (error) {
      // Selection failures have no effects and may be corrected within this turn.
      // Once submission begins, preserve uncertainty rather than replaying possible effects.
      this.conversationStore.db.prepare('UPDATE music_action_receipts SET status = ?, updated_at = ? WHERE action_id = ?')
        .run(commitAttempted ? 'uncertain' : 'failed', this.now(), actionId);
      throw error;
    }
  }

  /**
   * 提交核心：exact 目标与 offer 选中项共用同一套 canonical 解析、硬约束校验与提交边界。
   * 解析失败一律 fail closed（MUSIC_NOT_COMMITTED），不用替补歌曲顶替。
   */
  async _commit(request, input, { commitAttempt = null, terminalLine = false, planRequest = null,
    resolutionCache = null, offer = null, indexes = null, keepListeningPlan = false, recommendedBy = null,
    decisionPath: path = null } = {}) {
    const context = input.context || this.context(input);
    context.signal?.throwIfAborted();
    if (context.isCurrent && !context.isCurrent()) throw new Error('本轮已经取消');
    // 监听计划记住的是用户/任务提出的请求（如 discovery + 软偏好），不是内部重建的 exact 目标：
    // 下一次续播仍从同一份请求派生，不会被这一次的内部形状悄悄收紧。
    const plan = planRequest || request;
    const proposalOnly = Boolean(input.groupAction && input.groupAction.ownerId !== input.virtualPersonId);
    const selection = input.selection || this._targetSelection(request, context);
    // 确认一条 ambient 推荐：推荐人由存储的推荐担保（不是本轮回合收集的同伴推荐）。
    const vouched = recommendedBy && recommendedBy !== context.virtualPersonId ? recommendedBy : null;
    let candidates = vouched ? selection.candidates.map(candidate => ({ ...candidate,
      evidence: { ...candidate.evidence, virtualPersonId: vouched } })) : selection.candidates;
    if (!proposalOnly && input.groupAction?.recommendations.length) {
      // 同一首歌只留先出现的那份：负责人把同伴已登记的歌也写进自己的目标时，保留登记版本（带推荐人）。
      const merged = new Map();
      for (const item of [...input.groupAction.recommendations.flatMap(entry => entry.candidates), ...candidates]) {
        const key = `${item.evidence.source || ''}:${item.sourceSongId || item.query}`;
        if (!merged.has(key)) merged.set(key, item);
      }
      candidates = [...merged.values()].slice(0, 10);
    }
    const effective = { ...request, delivery: proposalOnly ? 'recommend_only' : request.delivery };
    // 本轮其他成员留下的推荐由 runtime 收集（成员身份已在回合内校验），提交时据此担保推荐人归属。
    const recommenderIds = proposalOnly ? [] : [...new Set((input.groupAction?.recommendations || [])
      .map(item => item.personId).concat(vouched || []).filter(id => id && id !== context.virtualPersonId))];
    const program = this.candidateProgram(selection, context, candidates);
    (commitAttempt || context.markCommitAttempt)?.();
    const result = await this.programCommitService.commit(program, {
      musicAction: { delivery: effective.delivery },
      // 插一首推荐不是新的听歌请求：续播仍从原计划派生（runtime 只在给了计划时替换）。
      listeningPlan: keepListeningPlan ? null : { request: plan, curatorId: context.virtualPersonId },
      listeningSessionId: context.sessionId, expectedQueueVersion: context.listening.queueVersion,
      outputGeneration: context.outputGeneration, signal: context.signal, isCurrent: context.isCurrent,
      virtualPersonId: context.virtualPersonId, voiceProfileId: context.entity.voiceProfileId, resolutionCache,
      recommenderIds,
      narrationContext: { origin: 'live', reason: input.reason || 'user_request',
        mode: plan.mode, softPreferences: plan.softPreferences },
    });
    if (!result.ok) {
      // 失败原因必须穿过工具/运行器/runtime 三层：给出可核对的非敏感摘要（按来源），
      // 用户可见文案仍然是工具层的 reviewed copy，不进模型自由文本、不含端点或凭据。
      const feedback = offer ? this._resolutionFeedback(result, program, offer, indexes) : {};
      if (offer) this.trace({ event: 'music-selection-resolution-failed', offerId: offer.offerId,
        requestId: context.requestId, ...feedback });
      return { ok: false, code: 'MUSIC_NOT_COMMITTED', reason: this._commitFailureReason(result, program),
        message: result.message, ...feedback };
    }
    const tracks = result.committedProgram.tracks;
    const selectionId = this.saveSelection(effective, context, tracks);
    if (proposalOnly) recordRecommendation(input.groupAction, context.virtualPersonId, { candidates, selectionId,
      tracks: tracks.map(track => ({ provider: track.source || track.provider || null, songId: track.songId ?? track.song_id ?? null,
        title: track.title || '', artist: track.artist || '' })) });
    if (offer && indexes && path) this._recordDecisions({ offer, indexes, tracks, result, path, context, selectionId });
    const committed = tracks.map(cleanTrack);
    // 本轮由其他成员推荐、这次一起收进来的歌名：给回复校验用，不许把它们说成自己挑的。
    const recommendedTitles = tracks.filter(track => {
      const personId = track.recommendedBy || track.evidence?.virtualPersonId || null;
      return personId && personId !== context.virtualPersonId && recommenderIds.includes(personId);
    }).map(track => String(track.title || '').replace(/[《》]/gu, '').trim()).filter(Boolean);
    const requestedCount = Math.min(10, Math.max(1, Number.parseInt(request.count, 10) || committed.length || 1));
    const shortfall = Math.max(0, requestedCount - committed.length);
    // 部分成功：能放的已经提交，放不了的如实点名（只给歌名/歌手与稳定原因类别，不含供应商原始报文）。
    const unavailable = this._unavailableTracks(result, program);
    const unavailableNames = unavailable.map(item => `《${item.title}》`).filter(name => name !== '《》');
    const committedCopy = proposalOnly
      // 群聊里先发言的伙伴只是推荐：这一轮稍后会一起排进播放器。它只需要说推了哪首、为什么。
      ? '已记下你的推荐，会和这一轮其他人的推荐一起排进播放器。直接告诉对方你推荐了哪首、为什么；不要说已经播放，也不要解释由谁来排歌或提交。'
      : effective.delivery === 'recommend_only' ? '已确认这些歌曲；尚未播放。' : '歌曲已经提交到本聊天的播放器。';
    return { ok: true, code: effective.delivery === 'recommend_only' ? 'MUSIC_RECOMMENDED' : 'MUSIC_COMMITTED',
      selectionId, delivery: effective.delivery, tracks: committed, requestedCount, selectedCount: committed.length,
      ...(recommendedTitles.length ? { recommendedTitles } : {}),
      ...(unavailable.length ? { unavailable } : {}),
      message: shortfall
        ? `${committedCopy}请求 ${requestedCount} 首，实际只有 ${committed.length} 首可用${unavailableNames.length
          ? `，${unavailableNames.join('、')}当前放不了，没有提交` : ''}；如实告诉用户哪几首放不了，不要用别的歌手或别的歌顶替，也不要说得比这更多。`
        : committedCopy,
      ...(terminalLine && effective.delivery !== 'recommend_only'
        ? { terminal: true, userMessage: shortfall
          ? (unavailableNames.length
            ? `${unavailableNames.join('、')}现在放不了；能放的 ${committed.length} 首已经排好，没有用别的歌顶替。`
            : `好，这次只有 ${committed.length} 首可用，已经排好，不会用别的歌顶替。`)
          // 歌名取自 canonical 解析后的曲目；只说已安排，不说已经响起。
          : this._committedCopy(tracks, context, recommenderIds) }
        : {}) };
  }

  /** 推荐决策账本的结果回填：只听 runtime 已接受的转换，按 queue occurrence 对上提交时写下的行。返回退订函数。 */
  attachOutcomeLedger(runtime = this.playbackRuntime) {
    return new RecommendationOutcomeBridge({ getStore: () => { this.initialize(); return this.decisions; } }).attach(runtime);
  }

  /** 账本写入是诊断旁路：失败只留计数 trace，绝不影响已经被 runtime 接受的提交。 */
  _recordDecisions({ offer, indexes, tracks, result, path, context, selectionId }) {
    try {
      const snapshot = result.queueResult?.snapshot || null;
      const rows = buildDecisionRows({ offer, indexes, committedTracks: tracks, snapshot,
        programId: result.committedProgram?.programId || null, path, sessionId: context.sessionId,
        personId: context.virtualPersonId, outputGeneration: snapshot?.outputGeneration ?? null, selectionId,
        features: offer.features || null,
        baseFeatures: { mode: offer.request?.mode || null, delivery: result.queueResult?.delivery || offer.request?.delivery || null } });
      this.decisions.record(rows);
    } catch {
      this.trace({ event: 'music-decision-record-failed', offerId: offer.offerId, indexCount: indexes.length });
    }
  }

  /**
   * 播放提交后的固定文案（模型同一条消息里没写出可用的话时才用）：说出排了哪几首，
   * 群聊里注明是谁推荐的。只说已安排，不说已经响起；歌名取自 canonical 解析后的曲目。
   */
  _committedCopy(tracks, context, recommenderIds = []) {
    const title = track => String(track?.title || '').replace(/[《》]/gu, '').trim();
    if (!tracks.length || tracks.some(track => !title(track))) return '好，已经为这个聊天排好了。';
    const joined = parts => parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join('、')}和${parts.at(-1)}`;
    // 与 ProgramCommitService 同一口径：只有本轮担保过的其他成员才算推荐人。
    const recommender = track => {
      const personId = track.recommendedBy || track.evidence?.virtualPersonId || null;
      return personId && personId !== context.virtualPersonId && recommenderIds.includes(personId) ? personId : null;
    };
    const fromOthers = tracks.some(track => recommender(track) && recommender(track) !== context.virtualPersonId);
    if (fromOthers && tracks.length <= 4) {
      const parts = tracks.map(track => {
        if (!recommender(track) || recommender(track) === context.virtualPersonId) return `我挑的《${title(track)}》`;
        const name = this.registry.get(recommender(track))?.displayName || '大家';
        return `${name}${/[A-Za-z0-9]$/u.test(name) ? ' ' : ''}推荐的《${title(track)}》`;
      });
      return `好，${joined(parts)}${parts.length === 1 ? '已经' : '都'}安排上了。`;
    }
    if (tracks.length === 1) return `好，《${title(tracks[0])}》已经安排上了。`;
    if (tracks.length <= 3) return `好，${joined(tracks.map(track => `《${title(track)}》`))}都安排上了。`;
    return `好，《${title(tracks[0])}》《${title(tracks[1])}》等 ${tracks.length} 首都安排上了。`;
  }

  /** 部分成功里没提交的那几首：按候选的点名目标给歌名/歌手，原因只用稳定类别。 */
  _unavailableTracks(result, program) {
    const failures = Array.isArray(result?.resolvedProgram?.failures) ? result.resolvedProgram.failures : [];
    return failures.map(failure => {
      const candidate = program.candidates.find(item => item.candidateId === failure.candidateId);
      const target = candidate?.orderedTarget || {};
      return { title: String(target.title || candidate?.query || failure.query || '').slice(0, 120),
        artist: String(target.artist || '').slice(0, 120), reason: String(failure.reason || 'resolution-failed') };
    }).filter(item => item.title);
  }

  _resolutionFeedback(result, program, offer, indexes) {
    const tracks = new Set((result.resolvedProgram?.tracks || []).map(track => track.candidateId));
    const failures = new Map((result.resolvedProgram?.failures || []).map(item => [item.candidateId, item.reason]));
    const resolvedIndexes = [], failedItems = [];
    for (const index of indexes) {
      const selected = offer.candidates[index - 1];
      const candidate = program.candidates.find(item => item.sourceSongId === selected.songId
        && item.evidence?.source === selected.source);
      if (!candidate) continue;
      if (tracks.has(candidate.candidateId)) resolvedIndexes.push(index);
      if (failures.has(candidate.candidateId)) failedItems.push({ index, provider: selected.source,
        songId: selected.songId, title: selected.title, artist: selected.artist, reason: failures.get(candidate.candidateId) });
    }
    return { offerId: offer.offerId, resolvedIndexes, failedItems };
  }

  /**
   * 提交失败的诊断摘要（非敏感、可核对）：
   * - canonical 解析失败：按候选来源给出“哪一路没有解析出可播放版本”，如 `resolution failed (qq)`；
   * - runtime 拒绝提交：给出拒绝原因分类，如 `commit rejected: stale listening queue version`。
   * 只包含供应商名与稳定分类；不含 URL、凭据、账号信息或供应商原始报文。
   */
  _commitFailureReason(result, program) {
    const failures = Array.isArray(result?.resolvedProgram?.failures) ? result.resolvedProgram.failures : [];
    if (failures.length) {
      const candidates = new Map((program?.candidates || []).map(candidate => [String(candidate?.candidateId || ''), candidate]));
      const sources = [];
      for (const failure of failures) {
        const candidate = candidates.get(String(failure?.candidateId || ''));
        const source = String(candidate?.evidence?.source || '').split(/[:-]/)[0];
        if (source && !sources.includes(source)) sources.push(source);
      }
      return boundedText(`resolution failed${sources.length ? ` (${sources.join(', ')})` : ''}`);
    }
    if (result?.status === 'commit-failed') {
      return boundedText(`commit rejected: ${result?.queueResult?.error || 'runtime rejected committed program'}`);
    }
    return null;
  }
}

export { cleanTrack };
