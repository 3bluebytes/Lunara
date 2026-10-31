// musicResolver.js — 统一音轨解析；锁定 canonical 身份时只直取该身份。
import * as ncm from './ncm.js';
import * as qq from './qq.js';
import * as state from './state.js';
import { findRememberedTrack, findRememberedIdentity, rememberTracks, getRememberedCollectionTracks, clearRememberedTracks } from './libraryTrackCache.js';
import { collectionOrigin, findCollectionMatch } from './library/collectionSourceAffinity.js';
import { getLibraryStore } from './library/libraryStore.js';
import { getRecordingStore } from './music/recordingStore.js';
import { trace } from './trace.js';
import { getSongTagStore } from './songtags/songTagStore.js';
import { enqueueTagging } from './songtags/taggingQueue.js';
import { isSongTagAutoEnabled } from './songtags/songTagConfig.js';
import { readSourcePolicy, sourceAllowed } from './music/sourcePolicy.js';
import { providerRegistry } from './music/providerRegistry.js';
import { SOURCE_FAILURE, classifySourceFailure, dominantSourceFailure, publicFailures } from './music/sourceFailure.js';
import { reportSourceHealth } from './music/sourceHealthSignal.js';
import { getTrackArtworkStore } from './media/sharedTrackArtwork.js';
import { remoteAudioUrl } from './media/remoteAudioProxy.js';

// In-memory collection provenance must not survive an account switch.
qq.onCookieChange(clearRememberedTracks);
ncm.onCookieChange(clearRememberedTracks);

// 解析成功后异步打结构化标签：auto 开关（song-tag.json，env SONG_TAG_AUTO 覆盖）
// 门控、needsTagging 把关、入队即返。尽力而为——任何异常都吞掉，绝不影响音轨解析的延迟与成败。
function maybeAutoTag(track) {
  try {
    if (!isSongTagAutoEnabled()) return;
    const songId = track?.song_id != null ? String(track.song_id) : '';
    if (!songId) return;
    const store = getSongTagStore();
    if (!store.needsTagging(songId, track.source)) return;
    enqueueTagging({
      songId,
      title: track.title || '',
      artist: track.artist || '',
      source: track.source || '',
      year: track.year ?? null,
    });
  } catch { /* noop：打标失败不冒泡 */ }
}

function getPrimarySource() {
  try {
    const saved = state.getPref('settings');
    if (saved) {
      const s = JSON.parse(saved);
      if (s.primarySource) return s.primarySource;
    }
  } catch {}
  return process.env.PRIMARY_SOURCE || 'qq';
}

// Provider injection lets offline tests exercise the actual resolver without accounts or network.
export function createMusicResolver(dependencies = {}) {
  const providers = dependencies.providers || { qq, ncm };
  const rememberedIdentity = dependencies.findRememberedIdentity || findRememberedIdentity;
  const rememberedTrack = dependencies.findRememberedTrack || findRememberedTrack;
  const remember = dependencies.rememberTracks || rememberTracks;
  const autoTag = dependencies.maybeAutoTag || maybeAutoTag;
  const emit = dependencies.trace || trace;
  const getSourcePolicy = dependencies.getSourcePolicy || (() => readSourcePolicy(state));
  const collectionTracks = dependencies.getCollectionTracks || (() => getLibraryStore().listCollectionTracks());
  const liveCollections = dependencies.getRememberedCollectionTracks || getRememberedCollectionTracks;
  const recordings = dependencies.getRecordingStore || getRecordingStore;
  // 封面补全只影响返回值里的 artwork，不参与 ok 判定：查询失败仍然可播。
  const resolveArtwork = dependencies.resolveArtwork
    || ((provider, songId, options) => getTrackArtworkStore().resolve(provider, songId, options));

  async function artworkFor(track, provider, signal) {
    const known = String(track.artwork || track.pic_url || '').trim();
    if (known) return known;
    try {
      return (await resolveArtwork(provider, String(track.song_id), { signal })) || '';
    } catch { return ''; }
  }

  async function direct(query, track, signal) {
    const provider = track.provider;
    const source = providers[provider];
    const failure = (code = SOURCE_FAILURE.NOT_PLAYABLE) => ({ ok: false, source: provider,
      song_id: track.song_id, code, error: 'canonical-resource-unavailable' });
    // 能力门：锁定身份要直取音源，这个源必须声明过 url 能力。
    if (!source || !providerRegistry.supports(provider, 'url')) return failure();
    try {
      signal?.throwIfAborted();
      const [url, lyric] = await Promise.all([source.songUrl(track.song_id), source.lyric(track.song_id)]);
      signal?.throwIfAborted();
      if (!url) { reportSourceHealth(provider, SOURCE_FAILURE.NOT_PLAYABLE); return failure(); }
      const cached = await source.cacheAudio(track.song_id, url, { expectedDurationSeconds: Number(track.duration) || 0 });
      signal?.throwIfAborted();
      const artwork = await artworkFor(track, provider, signal);
      signal?.throwIfAborted();
      // 直取成功是该源「刚才能给出可播资源」的真实证据。
      reportSourceHealth(provider, null);
      // 缓存没成也不回落供应商直链：跨源媒体元素在 Web Audio 图里会被静音播放，
      // 而播放器仍会把它记成正常播完。同源中继见 server/media/remoteAudioProxy.js。
      return { ...track, ok: true, query, source: provider,
        url: cached?.url || remoteAudioUrl(provider, track.song_id),
        artwork, original_url: url, lyric, cached: cached?.cached || false };
    } catch (error) {
      signal?.throwIfAborted();
      // 能力门与未接线由上面的分支处理；这里只记录真实尝试过的失败。
      // 抛错是临时故障（超时/源不可用/登录态），带分类后的 code 返回，不进「放不了」冷却。
      const code = classifySourceFailure(error);
      reportSourceHealth(provider, code);
      return failure(code);
    }
  }

  return async function resolveTrack(query, opts = {}) {
    opts.signal?.throwIfAborted();
    const policy = getSourcePolicy();
    const selectedId = opts.candidate?.sourceSongId;
    const selectedSource = opts.candidate?.evidence?.source;
    if (selectedId != null && String(selectedId).trim()) {
      // canonical 目标必须是可播源：目录源（仅可跳转）没有音源，不能成为锁定身份。
      if (!providerRegistry.isPlayable(selectedSource)) return { ok: false, error: 'canonical-provider-invalid' };
      if (!sourceAllowed(policy, selectedSource)) return { ok: false, error: 'source-mode-restricted' };
      const remembered = rememberedIdentity(selectedSource, selectedId);
      const target = opts.candidate.orderedTarget || {};
      // The candidate itself supplies metadata when the remembered library has no hit.
      // Never use a query search to change an already selected recording.
      const track = { ...target, ...(remembered || {}), provider: selectedSource, song_id: String(selectedId),
        title: remembered?.title || target.title || '', artist: remembered?.artist || target.artist || '' };
      const result = await direct(query, track, opts.signal);
      emit(`resolveTrack: canonical provider=${selectedSource} songId=${String(selectedId)} reason=${result.ok ? 'resolved' : 'canonical-resource-unavailable'}`);
      if (result.ok) autoTag(result);
      return result;
    }

    // 回退顺序由注册表决定：主源优先，其余按优先级；目录源永不进入该链。
    const names = policy.mode === 'single' ? policy.sources : providerRegistry.orderFor(opts.primarySource || getPrimarySource());
    // Collection references are selected before the ordinary search cache. A text
    // match retrieves an existing native reference; it never creates equivalence.
    let library = [];
    let live = [];
    try { library = collectionTracks(); } catch { /* local snapshot unavailable */ }
    try { live = liveCollections().filter(row => !/:library(?::|$)/.test(collectionOrigin(row))); } catch {}
    const specifiedSource = opts.candidate?.evidence?.source;
    const sources = specifiedSource ? names.filter(name => name === specifiedSource) : names;
    const collection = findCollectionMatch(query, [...library, ...live], { sources });
    if (collection.status === 'ambiguous') {
      return { ok: false, code: SOURCE_FAILURE.NOT_FOUND, error: 'collection-reference-ambiguous' };
    }
    if (collection.track) {
      const preferred = collection.track;
      const result = await direct(query, preferred, opts.signal);
      if (result.ok) { autoTag(result); return result; }
      // Failure permits a fallback, not a title search: only already-confirmed
      // Recording members may replace this resource. Locked candidates above
      // still never take this branch.
      let alternatives = [];
      try {
        const store = recordings();
        const recording = store.recordingOf(preferred.provider, preferred.song_id);
        if (!recording.isSelf) alternatives = store.membersOf(recording.recordingId);
      } catch { /* no verified alternative */ }
      for (const member of alternatives.slice(0, 10)) {
        opts.signal?.throwIfAborted();
        if (!sources.includes(member.provider)
          || (member.provider === preferred.provider && String(member.songId) === preferred.song_id)) continue;
        const known = rememberedIdentity(member.provider, member.songId)
          || library.find(row => row.provider === member.provider && String(row.song_id) === String(member.songId));
        if (!known?.title || !known?.artist) continue;
        const alternate = await direct(query, { ...known, provider: member.provider, song_id: String(member.songId) }, opts.signal);
        if (alternate.ok) {
          autoTag(alternate);
          return { ...alternate, sourcePreference: { preferredProvider: preferred.provider,
            preferredSongId: preferred.song_id, reason: 'preferred-resource-unavailable' } };
        }
      }
      return result;
    }
    const remembered = rememberedTrack(query);
    // Persistent tombstones take precedence over old in-process library entries.
    if (remembered && !/:library(?::|$)/.test(collectionOrigin(remembered)) && sourceAllowed(policy, remembered.provider)) {
      const result = await direct(query, remembered, opts.signal);
      if (result.ok) { autoTag(result); return result; }
    }
    // 每个源的失败都要留住原因码：把四种完全不同的情况压成一句「没找到歌」，
    // 上层就只能给用户一句无用的道歉。
    const failures = [];
    for (const name of names) {
      opts.signal?.throwIfAborted();
      // 声明了可播但组合根没注入实现 = 接线 bug；记一行并继续下一个源，
      // 不让单源缺实现拖垮整次解析。
      if (!providers[name]) {
        failures.push({ source: name, code: SOURCE_FAILURE.INTERNAL });
        emit(`resolveTrack: provider=${name} reason=${SOURCE_FAILURE.INTERNAL} detail=unwired`);
        continue;
      }
      try {
        const result = await providers[name].resolveQuery(query);
        opts.signal?.throwIfAborted();
        if (result.ok && result.url) {
          const track = { ...result, source: name };
          // 搜索命中即该源此刻可用：设置页的「最近观察」应当立刻恢复 ready。
          reportSourceHealth(name, null);
          remember([track], name);
          autoTag(track);
          return track;
        }
        const code = classifySourceFailure(result.code ?? result.error);
        reportSourceHealth(name, code);
        failures.push({ source: name, code });
        emit(`resolveTrack: provider=${name} reason=${code}`);
      } catch (error) {
        opts.signal?.throwIfAborted();
        const code = classifySourceFailure(error);
        reportSourceHealth(name, code);
        failures.push({ source: name, code });
        emit(`resolveTrack: provider=${name} reason=${code}`);
      }
    }
    // 顶层 code 取解析顺序里第一个非 not-found 的（通常是用户主源给出的原因）；
    // failures 保留每源明细，供展示层说清「哪个源怎么了」，且已脱敏。
    return {
      ok: false,
      query,
      error: 'all-sources-failed',
      code: dominantSourceFailure(failures),
      failures: publicFailures(failures),
      tried: names,
    };
  };
}

export const resolveTrack = createMusicResolver();
