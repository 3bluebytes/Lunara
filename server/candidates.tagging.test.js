import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __notifyCandidateObserverForTest,
  setCandidateObserver,
  shouldFetchCandidatePlaylist,
} from './candidates.js';

test('candidate loading probes playlists whose upstream track count is unknown', () => {
  assert.equal(shouldFetchCandidatePlaylist({ trackCount: null }), true);
  assert.equal(shouldFetchCandidatePlaylist({ trackCount: undefined }), true);
  assert.equal(shouldFetchCandidatePlaylist({ trackCount: 0 }), false);
  assert.equal(shouldFetchCandidatePlaylist({ trackCount: 42 }), true);
  assert.equal(shouldFetchCandidatePlaylist({ trackCount: 2000 }), false);
});

test('candidate refresh observer is fire-and-forget and receives only the bounded pool', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const seen = [];
  setCandidateObserver(async list => { seen.push(...list); await blocked; });
  const pool = Array.from({ length: 30 }, (_, index) => ({ song_id: String(index) }));
  __notifyCandidateObserverForTest(pool);
  assert.equal(seen.length, 0, 'observer does not run inside candidate refresh call stack');
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(seen.length, 30, 'observer receives the current small candidate pool');
  release();
  setCandidateObserver(null);
});
