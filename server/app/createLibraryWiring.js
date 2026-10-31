import { LibraryAdminService } from '../services/LibraryAdminService.js';
import { LibrarySyncService } from '../services/LibrarySyncService.js';
import { SongTagAdminService } from '../services/SongTagAdminService.js';
import { getLibraryStore } from '../library/libraryStore.js';
import { createProviderAdapters } from '../library/providerAdapters.js';
import { LibrarySyncCoordinator } from '../library/librarySync.js';
import { TasteBootstrapService } from '../library/tasteBootstrap.js';
import { getSongTagStore, SongTagStore } from '../songtags/songTagStore.js';
import { enqueueTagging, onTaggingSettled, queueStats } from '../songtags/taggingQueue.js';
import { runBackfill } from '../songtags/backfill.js';
import { enqueueRelevantCandidateTags } from '../songtags/candidateTagging.js';
import { getRecordingStore } from '../music/recordingStore.js';
import { getFingerprintStore } from '../media/fingerprintStore.js';
import { RecordingReviewService } from '../music/recordingReview.js';

/** 曲库、同步、打标与本地整理的装配；不新增 Agent 或播放状态。 */
export function createLibraryWiring({ providers, candidates, state, trace, projectProfile, onIdentityChanged, publish = () => {} } = {}) {
  const libraryAdminService = new LibraryAdminService({ providers, candidates, state });
  const libraryStore = getLibraryStore();
  const songTagStore = getSongTagStore();
  const tasteBootstrapService = new TasteBootstrapService({ store: libraryStore, songTagStore,
    enqueueTagging, projectProfile, trace });
  onTaggingSettled(({ song }) => tasteBootstrapService.handleTagSettled(song));
  const libraryProviderAdapters = createProviderAdapters({ providers });
  const librarySyncCoordinator = new LibrarySyncCoordinator({ store: libraryStore,
    adapters: libraryProviderAdapters, tasteBootstrap: tasteBootstrapService, trace,
    onSettled: () => publish({ type: 'library-updated' }) });
  candidates.setCandidateObserver(list => enqueueRelevantCandidateTags(list, { store: songTagStore, enqueue: enqueueTagging }));
  const librarySyncService = new LibrarySyncService({ coordinator: librarySyncCoordinator, store: libraryStore, providers });
  const songTagAdminService = new SongTagAdminService({ getStore: getSongTagStore,
    // 列表折行需要录音身份，但写入仍走原来的 store（已按录音解析）。
    getRecordings: () => getRecordingStore(),
    getCandidates: () => candidates.getCachedCandidatesSnapshot(), getQueueStats: queueStats, providers, runBackfill });

  const recordings = getRecordingStore();
  // 只在整理事务中共用连接；现有打标管线仍沿用它原来的 store。
  const sharedTags = new SongTagStore({ db: recordings.db, dbPath: recordings.db.name,
    getRecordingStore: () => recordings }).initialize();
  const recordingReviewService = new RecordingReviewService({ recordings, tagStore: sharedTags,
    // 指纹只用来排序与预选提议，读不到就不影响任何结论。
    getFingerprints: () => getFingerprintStore(),
    readCatalog: options => libraryStore.listActiveSongs(options), onChanged: () => {
      onIdentityChanged?.();
      publish({ type: 'library-updated' });
    } });
  return { libraryAdminService, librarySyncCoordinator, librarySyncService, songTagAdminService, recordingReviewService };
}
