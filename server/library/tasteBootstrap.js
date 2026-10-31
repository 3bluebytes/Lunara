const PROFILE_VERSION = 'taste-profile-v1';
const DEFAULT_TAG_LIMIT = 40;
const MAX_TAG_LIMIT = 100;
const STALE_AFTER_MS = 15 * 60 * 1000;

function keyOf(provider, accountUid) {
  return `${provider}:${accountUid}`;
}

function tagLimit(env = process.env) {
  const parsed = Number.parseInt(env.TASTE_BOOTSTRAP_TAG_LIMIT || String(DEFAULT_TAG_LIMIT), 10);
  return Math.min(MAX_TAG_LIMIT, Math.max(0, Number.isFinite(parsed) ? parsed : DEFAULT_TAG_LIMIT));
}

export function playlistLooksLiked(name) {
  return /(^|\s)(liked|favorites?)(\s|$)|喜欢|收藏/i.test(String(name || ''));
}

function normalizedMemberships(rows) {
  const playlists = new Map();
  const songs = new Map();
  for (const row of rows || []) {
    const playlistId = String(row.playlist_id);
    if (!playlists.has(playlistId)) playlists.set(playlistId, []);
    playlists.get(playlistId).push(row);
    const songKey = String(row.song_id);
    const song = songs.get(songKey) || {
      provider: row.provider,
      song_id: songKey,
      title: row.title || '', artist: row.artist || '', album: row.album || '',
      playlists: [], weight: 0, liked: false,
    };
    song.playlists.push({ id: playlistId, name: row.playlist_name || '' });
    song.liked ||= playlistLooksLiked(row.playlist_name);
    songs.set(songKey, song);
  }
  for (const [playlistId, members] of playlists) {
    const share = members.length ? 1 / members.length : 0;
    for (const member of members) songs.get(String(member.song_id)).weight += share;
  }
  for (const song of songs.values()) {
    song.weight = Math.min(1, song.weight);
    song.playlists.sort((a, b) => a.id.localeCompare(b.id));
  }
  return { playlists, songs: [...songs.values()].sort((a, b) => a.song_id.localeCompare(b.song_id)) };
}

function topEntries(map, limit = 12) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([name, weight]) => ({ name, weight: Number(weight.toFixed(4)) }));
}

export function buildMetadataBaseline(rows) {
  const { playlists, songs } = normalizedMemberships(rows);
  const artists = new Map();
  let likedSongs = 0;
  let crossPlaylistSongs = 0;
  for (const song of songs) {
    if (song.liked) likedSongs += 1;
    if (song.playlists.length > 1) crossPlaylistSongs += 1;
    const artist = String(song.artist || '').trim();
    if (artist) artists.set(artist, (artists.get(artist) || 0) + song.weight);
  }
  const playlistDistribution = [...playlists.entries()].map(([id, members]) => ({
    id,
    name: members[0]?.playlist_name || '',
    songs: members.length,
    normalizedWeight: playlists.size ? Number((1 / playlists.size).toFixed(4)) : 0,
  })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: PROFILE_VERSION,
    coverage: {
      activeMemberships: (rows || []).length,
      distinctSongs: songs.length,
      playlists: playlists.size,
      songsWithArtist: songs.filter(song => song.artist).length,
      taggedSongs: 0,
    },
    evidence: {
      likedSongs,
      crossPlaylistSongs,
      playlistDistribution: playlistDistribution.slice(0, 30),
    },
    artists: topEntries(artists),
    languages: [],
    genres: [],
    affectBands: [],
  };
}

export function selectRepresentativeSample(rows, limit = DEFAULT_TAG_LIMIT) {
  const bounded = Math.min(MAX_TAG_LIMIT, Math.max(0, Number(limit) || 0));
  const { playlists, songs } = normalizedMemberships(rows);
  if (!bounded || !songs.length) return [];
  const byId = new Map(songs.map(song => [song.song_id, song]));
  const queues = [...playlists.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([playlistId, members]) => ({
    playlistId,
    items: [...new Set(members.map(row => String(row.song_id)))].sort(),
    cursor: 0,
  }));
  const selected = [];
  const selectedIds = new Set();
  const artistCounts = new Map();
  while (selected.length < bounded) {
    let progressed = false;
    for (const queue of queues) {
      const remaining = queue.items.slice(queue.cursor).filter(id => !selectedIds.has(id));
      remaining.sort((a, b) => {
        const aa = byId.get(a)?.artist || '';
        const ba = byId.get(b)?.artist || '';
        return (artistCounts.get(aa) || 0) - (artistCounts.get(ba) || 0) || a.localeCompare(b);
      });
      const id = remaining[0];
      queue.cursor = queue.items.length;
      if (!id) continue;
      const song = byId.get(id);
      selected.push(song);
      selectedIds.add(id);
      artistCounts.set(song.artist || '', (artistCounts.get(song.artist || '') || 0) + 1);
      progressed = true;
      if (selected.length >= bounded) break;
    }
    if (!progressed) break;
  }
  if (selected.length < bounded) {
    for (const song of songs) {
      if (selectedIds.has(song.song_id)) continue;
      selected.push(song);
      if (selected.length >= bounded) break;
    }
  }
  return selected.map(song => ({
    provider: song.provider,
    song_id: song.song_id,
    title: song.title,
    artist: song.artist,
    playlists: song.playlists.map(item => item.id),
  }));
}

function affectBand(tag) {
  if (!Number.isFinite(Number(tag?.energy)) || !Number.isFinite(Number(tag?.valence))) return null;
  const energy = Number(tag.energy) >= 0.5 ? 'high-energy' : 'low-energy';
  const valence = Number(tag.valence) >= 0.5 ? 'bright' : 'dark';
  return `${energy}-${valence}`;
}

function enrichProfile(baseline, sample, songTagStore) {
  const languages = new Map();
  const genres = new Map();
  const bands = new Map();
  let taggedSongs = 0;
  for (const song of sample || []) {
    const tag = songTagStore?.getTags?.(song.song_id, song.provider);
    if (!tag || Number(tag.confidence) <= 0) continue;
    taggedSongs += 1;
    if (tag.language) languages.set(tag.language, (languages.get(tag.language) || 0) + 1);
    if (tag.genre) genres.set(tag.genre, (genres.get(tag.genre) || 0) + 1);
    const band = affectBand(tag);
    if (band) bands.set(band, (bands.get(band) || 0) + 1);
  }
  return {
    ...baseline,
    coverage: { ...baseline.coverage, taggedSongs, representativeSongs: sample?.length || 0 },
    languages: topEntries(languages, 8),
    genres: topEntries(genres, 8),
    affectBands: topEntries(bands, 4),
  };
}

export function rankCandidatesByTaste(candidates, { profiles = new Map(), songTagStore = null } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const scored = list.map((candidate, index) => {
    const provider = String(candidate?.provider || candidate?.source || '').split(':')[0];
    const profile = profiles instanceof Map ? profiles.get(provider) : profiles?.[provider];
    if (!profile) return { candidate, index, score: 0 };
    let score = 0;
    const artist = String(candidate?.artist || '').trim().toLowerCase();
    const artistPrior = (profile.artists || []).find(item => String(item.name || '').trim().toLowerCase() === artist);
    if (artistPrior) score += Math.min(0.45, 0.1 + Number(artistPrior.weight || 0) * 0.15);
    const songId = candidate?.song_id != null ? String(candidate.song_id) : '';
    const tag = songId ? songTagStore?.getTags?.(songId, provider) : null;
    if (tag && Number(tag.confidence) > 0) {
      const genre = (profile.genres || []).find(item => String(item.name).toLowerCase() === String(tag.genre || '').toLowerCase());
      const language = (profile.languages || []).find(item => String(item.name).toLowerCase() === String(tag.language || '').toLowerCase());
      const band = affectBand(tag);
      const bandPrior = (profile.affectBands || []).find(item => item.name === band);
      if (genre) score += 0.15;
      if (language) score += 0.1;
      if (bandPrior) score += 0.1;
    }
    return { candidate, index, score };
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map(item => item.candidate);
}

export class TasteBootstrapService {
  constructor({ store, songTagStore = null, enqueueTagging = null, projectProfile = null,
    env = process.env, now = () => Date.now(), trace = () => {} } = {}) {
    if (!store) throw new TypeError('TasteBootstrapService requires store');
    this.store = store;
    this.songTagStore = songTagStore;
    this.enqueueTagging = enqueueTagging;
    this.projectProfile = projectProfile;
    this.env = env;
    this.now = now;
    this.trace = trace;
    this.liveRuns = new Map();
  }

  recoverStaleRuns() {
    return this.store.recoverStaleTasteProfiles({ staleBefore: this.now() - STALE_AFTER_MS });
  }

  isRunning(provider, accountUid) {
    return this.liveRuns.has(keyOf(provider, accountUid));
  }

  async handleTagSettled(song) {
    const provider = String(song?.provider || song?.source || '').split(':')[0];
    const songId = String(song?.songId || song?.song_id || '');
    if (!provider || !songId) return 0;
    let refreshed = 0;
    for (const current of this.store.listTasteProfiles()) {
      if (current.provider !== provider || current.bootstrap_status !== 'complete') continue;
      const sample = current.representative_sample?.items;
      if (!Array.isArray(sample) || !sample.some(item => String(item.song_id) === songId)) continue;
      const profile = enrichProfile(current.profile || {}, sample, this.songTagStore);
      const tagged = profile.coverage?.taggedSongs || 0;
      const enrichmentStatus = tagged >= sample.length ? 'complete' : tagged > 0 ? 'partial' : 'pending';
      this.store.upsertTasteProfile(current.provider, current.account_uid, {
        profile_version: current.profile_version,
        profile,
        enrichment_status: enrichmentStatus,
        last_error: null,
      });
      await this.projectProfile?.({ provider: current.provider, accountUid: current.account_uid,
        profile, profileVersion: current.profile_version, librarySignature: current.library_signature });
      refreshed += 1;
    }
    return refreshed;
  }

  request(provider, accountUid, { reason = 'import-complete' } = {}) {
    const key = keyOf(provider, accountUid);
    const existing = this.liveRuns.get(key);
    if (existing) return { accepted: false, running: true, joined: true, promise: existing };
    const signature = this.store.librarySignature(provider, accountUid);
    const current = this.store.getTasteProfile(provider, accountUid);
    if (current?.bootstrap_status === 'complete' && current.profile_version === PROFILE_VERSION &&
        current.library_signature === signature) {
      if (current.profile && this.projectProfile) {
        Promise.resolve(this.projectProfile({ provider, accountUid, profile: current.profile,
          profileVersion: PROFILE_VERSION, librarySignature: signature })).catch(() => {});
      }
      return { accepted: false, running: false, skipped: 'fresh', profile: current };
    }
    const promise = Promise.resolve().then(() => this.run(provider, accountUid, { signature, reason }));
    this.liveRuns.set(key, promise);
    promise.finally(() => this.liveRuns.delete(key)).catch(() => {});
    return { accepted: true, running: true, joined: false, promise };
  }

  async run(provider, accountUid, { signature = null, reason = 'manual' } = {}) {
    const startedAt = this.now();
    const librarySignature = signature || this.store.librarySignature(provider, accountUid);
    const current = this.store.getTasteProfile(provider, accountUid);
    const persistedSample = current?.profile_version === PROFILE_VERSION && current?.library_signature === librarySignature
      ? current.representative_sample?.items : null;
    this.store.upsertTasteProfile(provider, accountUid, {
      profile_version: PROFILE_VERSION,
      library_signature: librarySignature,
      bootstrap_status: 'running',
      enrichment_status: this.env.SONG_TAG_AUTO === '1' ? 'running' : 'disabled',
      started_at: startedAt,
      completed_at: null,
      last_error: null,
    });
    try {
      const rows = this.store.listActiveMemberships(provider, accountUid).map(row => ({ ...row, provider }));
      const limit = tagLimit(this.env);
      const sample = Array.isArray(persistedSample) ? persistedSample : selectRepresentativeSample(rows, limit);
      const baseline = buildMetadataBaseline(rows);
      const profile = enrichProfile(baseline, sample, this.songTagStore);
      let enqueued = 0;
      if (this.env.SONG_TAG_AUTO === '1' && this.songTagStore && this.enqueueTagging) {
        for (const song of sample) {
          if (!this.songTagStore.needsTagging(song.song_id, provider)) continue;
          if (this.enqueueTagging({ ...song, source: provider })) enqueued += 1;
        }
      }
      const tagged = profile.coverage.taggedSongs;
      const enrichmentStatus = this.env.SONG_TAG_AUTO !== '1'
        ? 'disabled'
        : (tagged >= sample.length ? 'complete' : tagged > 0 ? 'partial' : 'pending');
      const saved = this.store.upsertTasteProfile(provider, accountUid, {
        profile_version: PROFILE_VERSION,
        library_signature: librarySignature,
        bootstrap_status: 'complete',
        enrichment_status: enrichmentStatus,
        representative_sample: { version: PROFILE_VERSION, librarySignature, items: sample },
        profile,
        completed_at: this.now(),
        started_at: null,
        last_error: null,
      });
      await this.projectProfile?.({ provider, accountUid, profile, profileVersion: PROFILE_VERSION, librarySignature });
      this.trace(`[taste-bootstrap] complete provider=${provider} reason=${reason} songs=${profile.coverage.distinctSongs} sample=${sample.length} enqueued=${enqueued}`);
      return { complete: true, profile: saved, sampleSize: sample.length, enqueued };
    } catch (error) {
      this.store.upsertTasteProfile(provider, accountUid, {
        profile_version: PROFILE_VERSION,
        library_signature: librarySignature,
        bootstrap_status: 'failed',
        enrichment_status: 'failed',
        started_at: null,
        last_error: String(error?.message || error),
      });
      throw error;
    }
  }
}
