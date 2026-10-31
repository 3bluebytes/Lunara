import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runLibrarySmoke } from './librarySmoke.js';

test('library smoke exercises manual HTTP import and full reconciliation matrix without leaking identity', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'lunara-library-smoke-test-'));
  const report = await runLibrarySmoke({
    provider: 'ncm',
    accountUid: 'private-account-123',
    playlist: { id: 'playlist-1', name: 'Fixture', trackCount: 3 },
    tracks: [
      { song_id: 'a', title: 'A', artist: 'X', album: '', duration: 1 },
      { song_id: 'b', title: 'B', artist: 'Y', album: '', duration: 1 },
      { song_id: 'c', title: 'C', artist: 'Z', album: '', duration: 1 },
    ],
    dbPath: resolve(dir, 'state.db'),
    secrets: ['secret-cookie-value'],
  });
  assert.deepEqual(report.checks, {
    manualImport: true,
    tasteBootstrap: true,
    add: true,
    remove: true,
    sameCountSwap: true,
    deletePlaylist: true,
    restorePlaylist: true,
    partialNonDestructive: true,
    partialRecovery: true,
    lazyTagging: true,
    logsSanitized: true,
  });
  assert.equal(report.final.importStatus, 'complete');
  assert.equal(report.final.syncStatus, 'complete');
  assert.equal(report.final.tasteBootstrapStatus, 'complete');
  assert.equal(report.tagging.wholeLibraryBackfill, false);
});
