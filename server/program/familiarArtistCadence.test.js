import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseFamiliarArtistClasses, orderFamiliarArtistPool } from './familiarArtistCadence.js';

test('familiar cadence permits novelty after three familiar plays and never excludes a scarce class', () => {
  const pool = [
    { source: 'qq', songId: 'u1', artist: '新人' },
    { source: 'qq', songId: 'f1', artist: '熟悉歌手' },
    { source: 'qq', songId: 'f2', artist: '熟悉歌手' },
  ];
  const base = { pool, likedArtists: ['熟悉歌手'], count: 1 };
  const first = chooseFamiliarArtistClasses({ ...base, recentPlays: [] });
  assert.deepEqual(first.classes, ['familiar']);
  assert.equal(orderFamiliarArtistPool(pool, first)[0].songId, 'f1');
  const fourth = chooseFamiliarArtistClasses({ ...base,
    recentPlays: Array.from({ length: 3 }, () => ({ artist: '熟悉歌手' })) });
  assert.deepEqual(fourth.classes, ['unfamiliar']);
  assert.equal(orderFamiliarArtistPool(pool, fourth)[0].songId, 'u1');
  assert.equal(chooseFamiliarArtistClasses({ pool: pool.slice(0, 1), likedArtists: ['熟悉歌手'], count: 1 }), null);
});
