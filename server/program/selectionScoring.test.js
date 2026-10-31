import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCORE_WEIGHTS, scoreWeights, freshnessTerm, playIndex, songHistoryIndex, artistSkipIndex,
  scoreCandidates, orderScored } from './selectionScoring.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = 1_800_000_000_000;
const track = (songId, extra = {}) => ({ songId, title: `歌${songId}`, artist: `歌手${songId}`, source: 'qq', ...extra });
const order = entries => orderScored(entries).map(entry => entry.track.songId);
const genreTags = map => ({ getTags: songId => (map[songId] ? { genres: [map[songId]] } : null) });
const signal = (key, polarity = 'positive', confidence = 0.7) => ({ key, attribute: key.split('.')[1],
  value: key.split('.').slice(2).join('.'), polarity, confidence, weight: confidence * 3 });

test('MUSIC_SCORE_WEIGHTS overrides known numeric weights; malformed JSON falls back to defaults（6.1）', () => {
  assert.deepEqual(scoreWeights({}), { ...DEFAULT_SCORE_WEIGHTS });
  const merged = scoreWeights({ MUSIC_SCORE_WEIGHTS: '{"preferredArtist":2.5,"unknown":9,"originLiked":"x"}' });
  assert.equal(merged.preferredArtist, 2.5);
  assert.equal(merged.originLiked, DEFAULT_SCORE_WEIGHTS.originLiked, '非数字值忽略');
  assert.equal('unknown' in merged, false, '未知键忽略');
  assert.deepEqual(scoreWeights({ MUSIC_SCORE_WEIGHTS: '{not json' }), { ...DEFAULT_SCORE_WEIGHTS });
});

test('freshness: unplayed beats any played track; repeats and recency are bounded（6.1）', () => {
  const w = DEFAULT_SCORE_WEIGHTS;
  const best = freshnessTerm({ count: 1, lastTs: now - 30 * DAY }, now, w);
  assert.ok(freshnessTerm(null, now, w) > best, '没放过 > 放过一次且很久以前');
  assert.ok(best <= w.playedBase + w.recencyMax);
  assert.ok(freshnessTerm({ count: 4, lastTs: now - 2 * DAY }, now, w) < freshnessTerm({ count: 1, lastTs: now - 2 * DAY }, now, w));
  assert.equal(freshnessTerm({ count: 9, lastTs: now - 30 * DAY }, now, w), w.recencyMax, '重复项不为负');
});

test('cooldown is 24h in the caller: 23h ago is cooled, 25h ago is scored（6.1a）', () => {
  const plays = playIndex([{ song_id: 'a', source: 'qq', ts: now - 23 * HOUR }, { song_id: 'b', source: 'qq:library', ts: now - 25 * HOUR }]);
  const entries = scoreCandidates([track('a'), track('b'), track('c')], { plays, now, cooldownMs: 24 * HOUR });
  assert.equal(entries[0].cooldown, true);
  assert.equal(entries[0].score, null);
  assert.equal(entries[1].cooldown, false, 'provider 前缀按 qq 归一');
  assert.deepEqual(order(entries), ['c', 'b', 'a']);
});

test('cooldown beats taste; strong taste can beat a track played once 8 days ago（6.2）', () => {
  const tagStore = genreTags({ a: 'rnb', b: 'rnb' });
  const signals = [signal('music.genre.rnb', 'positive', 0.9)];
  const plays = playIndex([{ song_id: 'a', source: 'qq', ts: now - 2 * HOUR }, { song_id: 'b', source: 'qq', ts: now - 8 * DAY }]);
  const entries = scoreCandidates([track('a'), track('c'), track('b')], { plays, now, cooldownMs: 24 * HOUR, signals, tagStore });
  const [a, c, b] = entries;
  assert.equal(a.cooldown, true, '冷却组不被口味捞回');
  assert.ok(b.parts.taste > 0);
  assert.ok(b.score > c.score, '强口味 + 8 天前放过一次可以超过没放过但无口味的歌');
  assert.deepEqual(order(entries), ['b', 'c', 'a']);
});

test('a negative signal demotes but never removes a candidate（6.2）', () => {
  const entries = scoreCandidates([track('a'), track('b')], { now, cooldownMs: 24 * HOUR,
    signals: [signal('music.genre.metal', 'negative')], tagStore: genreTags({ a: 'metal' }) });
  assert.ok(entries[0].parts.taste < 0);
  assert.deepEqual(order(entries), ['b', 'a']);
});

test('taste contribution is clamped to ±3（6.1）', () => {
  const tagStore = { getTags: () => ({ genres: ['rnb', 'soul', 'jazz', 'pop'], mood: 'calm', language: 'en' }) };
  const signals = ['music.genre.rnb', 'music.genre.soul', 'music.genre.jazz', 'music.genre.pop', 'music.mood.calm',
    'music.language.en'].map(key => signal(key, 'positive', 1));
  const [entry] = scoreCandidates([track('a')], { now, cooldownMs: HOUR, signals, tagStore });
  assert.ok(entry.parts.taste <= DEFAULT_SCORE_WEIGHTS.tasteClamp);
});

test('preferred artist, origin and completion add; recent artist skips subtract（6.2）', () => {
  const songHistory = songHistoryIndex([
    { provider: 'qq', songId: 'a', outcome: 'completed', count: 3 },
    { provider: 'qq', songId: 'a', outcome: 'skipped', count: 1 },
    { provider: 'qq', songId: 'a', outcome: 'technical_failure', count: 9 },
  ]);
  const observations = [
    ...[1, 2, 3].map(i => ({ songQuery: `歌${i} — 歌手b`, outcome: 'skipped', at: now - i * HOUR })),
    { songQuery: '歌9 — 歌手b', outcome: 'completed', at: now - HOUR },
    ...[1, 2, 3, 4].map(i => ({ songQuery: `歌${i} — 歌手c`, outcome: 'technical_failure', at: now - i * HOUR })),
    ...[1, 2, 3].map(i => ({ artist: '歌手d', outcome: 'skipped', at: now - 8 * DAY - i })),
  ];
  const artistSkips = artistSkipIndex(observations, { now });
  const entries = scoreCandidates([
    track('a', { source: 'qq:liked' }), track('b'), track('c'), track('d'),
  ], { now, cooldownMs: HOUR, songHistory, artistSkips, preferredArtist: t => t.artist === '歌手a' });
  const [a, b, c, d] = entries;
  assert.equal(a.parts.preferredArtist, 1);
  assert.equal(a.parts.origin, 0.6);
  assert.equal(a.parts.completion, 0.5, '听完 3 次、听完率 0.75');
  assert.equal(b.parts.artistSkip, -0.8, '近 7 天跳过 3 次、跳过率 0.75');
  assert.equal(c.parts.artistSkip, 0, '技术失败不算跳过');
  assert.equal(d.parts.artistSkip, 0, '7 天以前的跳过不算');
});

test('untagged tracks neither match nor get penalized（6.4）', () => {
  const entries = scoreCandidates([track('a'), track('b')], { now, cooldownMs: HOUR,
    signals: [signal('music.genre.rnb'), signal('music.genre.metal', 'negative')], tagStore: genreTags({}) });
  assert.deepEqual(entries.map(entry => entry.parts.taste), [0, 0]);
  assert.deepEqual(order(entries), ['a', 'b']);
});
