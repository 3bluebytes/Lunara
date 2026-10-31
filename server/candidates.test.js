import assert from 'node:assert/strict';
import test from 'node:test';

import { candidateTrackList, fetchSource } from './candidates.js';

test('the candidate pool envelope is unwrapped for callers that need tracks', () => {
  const rows = [{ song_id: '1', title: '一', source: 'qq:liked' }];

  // Characterizes the documented `loadCandidates` contract: it returns an envelope,
  // and a caller that feeds it to Array methods crashes the whole selection path.
  assert.deepEqual(candidateTrackList({ list: rows, counts: { ncm: {}, qq: {} }, cachedAt: 1 }), rows);
  assert.deepEqual(candidateTrackList(rows), rows);
  assert.deepEqual(candidateTrackList({ list: null }), []);
  assert.deepEqual(candidateTrackList({ counts: {} }), []);
  assert.deepEqual(candidateTrackList(null), []);
  assert.deepEqual(candidateTrackList(undefined), []);
});

test('daily recommendations survive a failed playlist listing', async () => {
  const result = await fetchSource({ provider: 'qq', getUid: '42',
    likedFn: async () => [], userPlaylistsFn: async () => { throw new Error('playlist unavailable'); },
    playlistAllTracksFn: async () => [], recommendFn: async () => [{ song_id: 'fresh', title: '新歌', artist: '歌手' }],
  });
  assert.equal(result.daily[0].song_id, 'fresh');
  assert.equal(result.daily[0].source, 'qq:daily');
});

test('independent daily lookup begins while playlist lookup is still pending', async () => {
  let release;
  const playlist = new Promise(resolve => { release = resolve; });
  let dailyStarted = false;
  const loading = fetchSource({ provider: 'qq', getUid: '42', likedFn: async () => [],
    userPlaylistsFn: () => playlist, playlistAllTracksFn: async () => [],
    recommendFn: async () => { dailyStarted = true; return []; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dailyStarted, true);
  release([]);
  await loading;
});
