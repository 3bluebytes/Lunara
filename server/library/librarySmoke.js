import { LibraryStore } from './libraryStore.js';
import { LibrarySyncCoordinator } from './librarySync.js';
import { LibrarySyncService } from '../services/LibrarySyncService.js';
import { registerAdminRoutes } from '../http/routes/adminRoutes.js';
import { providerRegistry } from '../music/providerRegistry.js';
import { TasteBootstrapService } from './tasteBootstrap.js';
import { SongTagStore } from '../songtags/songTagStore.js';
import { enqueueRelevantCandidateTags } from '../songtags/candidateTagging.js';

function assert(condition, message) {
  if (!condition) throw new Error(`library smoke assertion failed: ${message}`);
}

function inProcessAdminClient(service) {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
  registerAdminRoutes(app, { librarySyncService: service });
  return async function request(method, path, body = {}) {
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`missing in-process route ${method} ${path}`);
    const response = {
      statusCode: 200,
      payload: null,
      headersSent: false,
      status(code) { this.statusCode = code; return this; },
      json(value) { this.payload = value; this.headersSent = true; return this; },
    };
    await handler({ body, query: {} }, response);
    return response;
  };
}

async function waitForRun(coordinator, provider, accountUid, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (coordinator.isRunning(provider, accountUid)) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('library smoke import timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function waitForTaste(service, provider, accountUid, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (service.isRunning(provider, accountUid)) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('library smoke taste bootstrap timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function clone(value) {
  return structuredClone(value);
}

export async function runLibrarySmoke({
  provider,
  accountUid,
  playlist,
  tracks,
  dbPath,
  secrets = [],
} = {}) {
  if (!providerRegistry.isPlayable(provider)) throw new Error(`library smoke provider must be a playable source: ${providerRegistry.defaultSourceCandidates().join(' | ')}`);
  if (!accountUid) throw new Error('library smoke requires a verified account UID');
  if (!playlist?.id) throw new Error('library smoke requires one real playlist');
  if (!Array.isArray(tracks) || tracks.length === 0) throw new Error('library smoke requires a non-empty complete track snapshot');
  if (!dbPath) throw new Error('library smoke requires an isolated dbPath');

  const logs = [];
  const original = {
    playlist: clone(playlist),
    tracks: clone(tracks),
  };
  const remote = {
    playlists: [{ ...clone(playlist), trackCount: tracks.length }],
    tracks: clone(tracks),
    playlistComplete: true,
    trackComplete: true,
    playlistError: null,
    trackError: null,
    reportedTrackCount: tracks.length,
  };
  const adapters = {
    async resolveAccountIdentity(name) {
      return name === provider
        ? { provider, accountUid: String(accountUid), error: null }
        : { provider: name, accountUid: null, error: 'not configured for smoke' };
    },
    async fetchPlaylistsSnapshot(name) {
      if (name !== provider) return { items: [], complete: false, reportedCount: null, fetchedCount: 0, error: 'not configured' };
      return {
        items: clone(remote.playlists),
        complete: remote.playlistComplete,
        reportedCount: remote.playlists.length,
        fetchedCount: remote.playlists.length,
        error: remote.playlistError,
      };
    },
    async fetchPlaylistTracksSnapshot(name, observedPlaylist) {
      if (name !== provider || String(observedPlaylist.id) !== String(playlist.id)) {
        return { items: [], complete: false, reportedCount: null, fetchedCount: 0, error: 'unknown smoke playlist' };
      }
      return {
        items: clone(remote.tracks),
        complete: remote.trackComplete,
        reportedCount: remote.reportedTrackCount,
        fetchedCount: remote.tracks.length,
        error: remote.trackError,
      };
    },
  };

  let tagClock = Date.now();
  const store = new LibraryStore({ dbPath }).initialize();
  const songTagStore = new SongTagStore({ dbPath, now: () => tagClock }).initialize();
  const tagJobs = [];
  const tasteBootstrap = new TasteBootstrapService({
    store,
    songTagStore,
    enqueueTagging: song => { tagJobs.push({ ...song, trigger: 'taste' }); return true; },
    env: { SONG_TAG_AUTO: '1', TASTE_BOOTSTRAP_TAG_LIMIT: '40' },
    trace: line => logs.push(String(line)),
  });
  const coordinator = new LibrarySyncCoordinator({ store, adapters, tasteBootstrap, trace: line => logs.push(String(line)) });
  const service = new LibrarySyncService({
    coordinator,
    store,
    providers: {},
    logger: { warn: line => logs.push(String(line)) },
  });
  const request = inProcessAdminClient(service);
  const report = { provider, checks: {} };

  try {
    const importResponse = await request('POST', '/api/library/import', { provider });
    assert(importResponse.statusCode === 202, `manual import returned ${importResponse.statusCode}`);
    const accepted = importResponse.payload;
    assert(accepted.accepted === true && accepted.running === true, 'manual import was not accepted asynchronously');
    await waitForRun(coordinator, provider, String(accountUid));
    await waitForTaste(tasteBootstrap, provider, String(accountUid));

    const getStatus = async () => {
      const response = await request('GET', '/api/library/status');
      assert(response.statusCode === 200, `status returned ${response.statusCode}`);
      const body = response.payload;
      return body.sources.find(source => source.provider === provider && source.account_uid === String(accountUid));
    };
    let status = await getStatus();
    assert(status?.import_status === 'complete', 'initial import did not complete');
    assert(status.active_playlists === 1 && status.active_memberships === original.tracks.length, 'initial account counts are wrong');
    report.checks.manualImport = true;
    assert(status.taste?.bootstrap_status === 'complete', 'metadata taste prior did not complete after import');
    assert(status.taste.sample_size <= 40, 'taste representative sample exceeded budget');
    assert(tagJobs.length <= 40, 'taste bootstrap created an unbounded tag backlog');
    report.checks.tasteBootstrap = true;
    report.initialMemberships = status.active_memberships;

    const added = {
      song_id: '__lunara_smoke_added__', title: 'Lunara Smoke Added', artist: 'Smoke Fixture',
      album: '', duration: 1,
    };
    remote.tracks.push(added);
    remote.reportedTrackCount = remote.tracks.length;
    remote.playlists[0].trackCount = remote.tracks.length;
    await service.periodic();
    status = await getStatus();
    assert(status.active_memberships === original.tracks.length + 1, 'added song was not reconciled');
    report.checks.add = true;

    remote.tracks = remote.tracks.filter(track => String(track.song_id) !== String(original.tracks[0].song_id));
    remote.reportedTrackCount = remote.tracks.length;
    remote.playlists[0].trackCount = remote.tracks.length;
    await service.periodic();
    status = await getStatus();
    assert(status.active_memberships === original.tracks.length, 'removed song was not tombstoned');
    report.checks.remove = true;

    const beforeSwap = remote.tracks[0];
    remote.tracks[0] = {
      song_id: '__lunara_smoke_swap__', title: 'Lunara Smoke Swap', artist: 'Smoke Fixture',
      album: '', duration: 1,
    };
    remote.reportedTrackCount = remote.tracks.length;
    remote.playlists[0].trackCount = remote.tracks.length;
    await service.periodic();
    const stillPresentAfterCountGate = store.db.prepare(`
      SELECT removed_at FROM library_tracks
      WHERE provider=? AND account_uid=? AND playlist_id=? AND song_id=?
    `).get(provider, String(accountUid), String(playlist.id), String(beforeSwap.song_id));
    assert(stillPresentAfterCountGate?.removed_at == null, 'periodic pass unexpectedly bypassed matching count gate');
    await service.weekly();
    const removedAfterWeekly = store.db.prepare(`
      SELECT removed_at FROM library_tracks
      WHERE provider=? AND account_uid=? AND playlist_id=? AND song_id=?
    `).get(provider, String(accountUid), String(playlist.id), String(beforeSwap.song_id));
    assert(removedAfterWeekly?.removed_at != null, 'weekly pass did not catch same-count swap');
    report.checks.sameCountSwap = true;

    remote.playlists = [];
    await service.weekly();
    status = await getStatus();
    assert(status.active_playlists === 0 && status.active_memberships === 0, 'deleted playlist was not tombstoned');
    report.checks.deletePlaylist = true;

    remote.playlists = [{ ...clone(original.playlist), name: `${original.playlist.name || 'Playlist'} (smoke restored)`, trackCount: remote.tracks.length }];
    await service.weekly();
    status = await getStatus();
    assert(status.active_playlists === 1 && status.active_memberships === remote.tracks.length, 'playlist restore failed');
    report.checks.restorePlaylist = true;

    const beforePartial = status.active_memberships;
    remote.trackComplete = false;
    remote.trackError = 'smoke injected partial snapshot';
    remote.reportedTrackCount = remote.tracks.length;
    remote.tracks = remote.tracks.slice(0, Math.max(0, remote.tracks.length - 1));
    await service.weekly();
    status = await getStatus();
    assert(status.last_sync_status === 'partial', 'partial snapshot did not surface partial sync health');
    assert(status.active_memberships === beforePartial, 'partial snapshot reduced active membership count');
    report.checks.partialNonDestructive = true;

    remote.trackComplete = true;
    remote.trackError = null;
    remote.tracks = clone(original.tracks);
    remote.reportedTrackCount = remote.tracks.length;
    remote.playlists[0].trackCount = remote.tracks.length;
    await service.weekly();
    status = await getStatus();
    assert(status.last_sync_status === 'complete', 'complete retry did not recover partial sync');
    report.checks.partialRecovery = true;

    const firstTrack = original.tracks[0];
    songTagStore.upsert({ provider, song_id: firstTrack.song_id, title: firstTrack.title, artist: firstTrack.artist,
      confidence: 0, source_text: 'smoke-placeholder' });
    assert(songTagStore.needsTagging(firstTrack.song_id, provider) === false, 'fresh placeholder did not suppress retry storm');
    tagClock += 7 * 60 * 60 * 1000;
    assert(songTagStore.needsTagging(firstTrack.song_id, provider) === true, 'expired placeholder did not become retryable');
    const successfulTrack = original.tracks[1] || original.tracks[0];
    songTagStore.upsert({ provider, song_id: successfulTrack.song_id, title: successfulTrack.title, artist: successfulTrack.artist,
      energy: 0.6, valence: 0.6, confidence: 0.8, source_text: 'smoke-success' });
    assert(songTagStore.needsTagging(successfulTrack.song_id, provider) === false, 'fresh successful tag was not reused');
    const candidateJobs = [];
    const candidateResult = enqueueRelevantCandidateTags(original.tracks.map(track => ({ ...track, source: `${provider}:smoke-candidate` })), {
      store: songTagStore, enqueue: song => { candidateJobs.push(song); return true; }, enabled: true, limit: 100,
    });
    assert(candidateResult.scanned <= 100 && candidateJobs.length <= 100, 'candidate lazy tagging exceeded hard bound');
    report.checks.lazyTagging = true;
    report.tagging = {
      tasteJobs: tagJobs.length,
      candidatePool: original.tracks.length,
      candidateJobs: candidateJobs.length,
      placeholderRetryObserved: true,
      freshTagReuseObserved: true,
      wholeLibraryBackfill: false,
    };

    const logText = logs.join('\n');
    const forbidden = [String(accountUid), ...secrets.map(String)].filter(Boolean);
    assert(forbidden.every(secret => !logText.includes(secret)), 'logs contain account UID or provider credential');
    report.checks.logsSanitized = true;
    report.final = {
      importStatus: status.import_status,
      syncStatus: status.last_sync_status,
      activePlaylists: status.active_playlists,
      activeMemberships: status.active_memberships,
      tombstonedMemberships: status.tombstoned_memberships,
      tasteBootstrapStatus: status.taste?.bootstrap_status || null,
      tasteEnrichmentStatus: status.taste?.enrichment_status || null,
    };
    return report;
  } finally {
    songTagStore.close();
    store.close();
  }
}
