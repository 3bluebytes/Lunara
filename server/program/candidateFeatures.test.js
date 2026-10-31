import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateFeatures, candidateOrigin, candidateTags } from './candidateFeatures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const tags = {
  '1': { language: 'zh', genre: 'R&B', mood: 'calm', tempo: 'slow', energy: 0.3, year: 2019, has_vocal: true,
    themes: ['夜晚', '城市', '思念', '雨'] },
};
const tagStore = { getTags: (songId, provider) => (provider === 'qq' ? tags[songId] || null : null) };
const window = [
  { songId: '1', title: '晚风', artist: 'Xx', source: 'qq', candidateOrigin: 'qq:library', collectionKind: 'liked' },
  { songId: '2', title: '无标签', artist: 'y', source: 'qq', candidateOrigin: 'qq:discovery' },
];

test('origin classes cover liked / playlist / daily / discovery / library', () => {
  assert.deepEqual([
    { collectionKind: 'liked', candidateOrigin: 'qq:library' },
    { collectionKind: 'playlist', candidateOrigin: 'qq:library' },
    { candidateOrigin: 'ncm:daily' },
    { candidateOrigin: 'qq:discovery' },
    { candidateOrigin: 'qq:library' },
    { source: 'local' },
  ].map(candidateOrigin), ['liked', 'playlist', 'daily', 'discovery', 'library', 'library']);
});

test('features expose tags, freshness and signed taste matches; untagged is explicit null（3.4）', () => {
  const signals = [
    { key: 'music.genre.rnb', attribute: 'genre', value: 'rnb', polarity: 'positive', confidence: 0.6 },
    { key: 'music.artist.xx', attribute: 'artist', value: 'xx', polarity: 'negative', confidence: 0.4 },
  ];
  const features = buildCandidateFeatures(window, { tagStore, signals, now: NOW,
    recentPlays: [{ ts: NOW - 2 * DAY, song_id: '1', source: 'qq' }, { ts: NOW - 5 * DAY, song_id: '1', source: 'qq:library' },
      { ts: NOW - 20 * DAY, song_id: '1', source: 'qq' }, { ts: NOW - DAY, song_id: '1', source: 'ncm' }] });
  assert.deepEqual(features[0], {
    tags: { language: 'zh', genres: ['R&B'], mood: 'calm', tempo: 'slow', energy: 0.3, year: 2019, hasVocal: true,
      themes: ['夜晚', '城市', '思念'] },
    origin: 'liked',
    freshness: { lastPlayedDaysAgo: 2, plays14d: 2 },
    tasteMatches: ['+music.genre.rnb', '-music.artist.xx'],
  });
  assert.equal(features[1].tags, null, '没有标签记录就是 null');
  assert.ok(Object.hasOwn(features[1], 'tags'));
  assert.deepEqual(features[1].freshness, { lastPlayedDaysAgo: null, plays14d: 0 });
  assert.deepEqual(features[1].tasteMatches, []);
  assert.equal(Object.hasOwn(features[0], 'familiarity'), false, '没开熟悉度节奏时不给');
  assert.equal(Object.hasOwn(features[0], 'probe'), false, '不是试探歌曲时不出现');
});

test('familiarity only with cadence; probe only on the probe track', () => {
  const cadencePlan = { familiar: artist => artist === 'Xx' };
  const features = buildCandidateFeatures(window, { tagStore, cadencePlan, probeTrack: window[1], now: NOW });
  assert.deepEqual(features.map(item => item.familiarity), ['familiar', 'unfamiliar']);
  assert.deepEqual(features.map(item => item.probe), [undefined, true]);
});

test('a broken tag store degrades to null tags instead of failing the offer', () => {
  assert.equal(candidateTags({ getTags: () => { throw new Error('db closed'); } }, window[0]), null);
  assert.equal(candidateTags(null, window[0]), null);
});
