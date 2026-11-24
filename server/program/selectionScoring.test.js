import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SCORE_WEIGHTS, scoreWeights, freshnessTerm, playIndex, sameTitleArtistIndex, songHistoryIndex, artistSkipIndex,
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

test('同名同歌手换了供应商也算放过：冷却期内垫底、冷却期外扣新鲜度，身份不变也不删候选', () => {
  const recent = [
    { song_id: '26353080', source: 'ncm', title: '蜚蜚', artist: '陈僖仪', ts: now - 23 * 60_000 },
    { song_id: 'n2', source: 'ncm', title: 'Ｓｏｍｅｏｎｅ  Like You', artist: 'Adele ', ts: now - 3 * DAY },
  ];
  const plays = playIndex(recent);
  const sameTitleArtist = sameTitleArtistIndex(recent);
  const pool = [
    track('004V3NZz1FpvtU', { title: '蜚蜚', artist: '陈僖仪' }),
    track('q2', { title: 'someone like you', artist: 'adele' }),
    track('fresh'),
  ];
  const entries = scoreCandidates(pool, { plays, sameTitleArtist, now, cooldownMs: 24 * HOUR });
  assert.equal(entries[0].cooldown, true, '23 分钟前另一个供应商放过的同一首在冷却期');
  assert.deepEqual(entries[0].parts, { cooldown: 1, sameTitleArtist: 1 });
  assert.equal(entries[1].cooldown, false);
  assert.equal(entries[1].parts.sameTitleArtist, 1, '全角、大小写、多余空白归一后同名同歌手');
  assert.equal(entries[1].parts.freshness,
    Math.round(freshnessTerm({ count: 1, lastTs: now - 3 * DAY }, now, DEFAULT_SCORE_WEIGHTS) * 1000) / 1000, '冷却期外按放过一次扣新鲜度');
  assert.deepEqual(order(entries), ['fresh', 'q2', '004V3NZz1FpvtU'], '只重排，三首都还在');
  assert.equal(entries[0].track.source, 'qq', '候选自己的 (provider, songId) 不变');
});

test('现场版、重制版和别的歌手翻唱不被原曲压下去；同一首自己放过时不重复计数', () => {
  const recent = [
    { song_id: 'a', source: 'ncm', title: '蜚蜚', artist: '陈僖仪', ts: now - HOUR },
    { song_id: 'b', source: 'qq', title: '红豆', artist: '王菲', ts: now - 2 * HOUR },
  ];
  const plays = playIndex(recent);
  const sameTitleArtist = sameTitleArtistIndex(recent);
  const entries = scoreCandidates([
    track('live', { title: '蜚蜚 (Live)', artist: '陈僖仪' }),
    track('cover', { title: '蜚蜚', artist: '别的歌手' }),
    track('remaster', { title: '红豆 - Remastered', artist: '王菲' }),
    track('b', { title: '红豆', artist: '王菲' }),
    track('untitled', { title: '', artist: '' }),
  ], { plays, sameTitleArtist, now, cooldownMs: 24 * HOUR });
  for (const index of [0, 1, 2, 4]) {
    assert.equal(entries[index].cooldown, false, entries[index].track.songId);
    assert.equal(entries[index].parts.freshness, DEFAULT_SCORE_WEIGHTS.unplayed, entries[index].track.songId);
    assert.equal('sameTitleArtist' in entries[index].parts, false);
  }
  assert.deepEqual(entries[3].parts, { cooldown: 1 }, '自己 (provider, songId) 放过的照旧，不额外记分项');
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

test('completedOften smooths 14d freshness decay monotonically while staying below unplayed ceiling', () => {
  const w = DEFAULT_SCORE_WEIGHTS;
  const rough = freshnessTerm({ count: 5, lastTs: now - 5 * DAY }, now, w);
  const smooth = freshnessTerm({ count: 5, lastTs: now - 5 * DAY }, now, w, { completedOften: true });
  assert.ok(smooth > rough, '高完播熟歌 14 天内不再被一刀切压成近 0');
  assert.ok(smooth < freshnessTerm(null, now, w), '仍严守低于未播基线');
  assert.ok(freshnessTerm({ count: 2, lastTs: now - 5 * DAY }, now, w, { completedOften: true }) > smooth);
  assert.ok(freshnessTerm({ count: 5, lastTs: now - 11 * DAY }, now, w, { completedOften: true }) > smooth);
});

test('softPreferences deterministically lifts matching textured tracks and leaves untagged tracks neutral', () => {
  const richStore = {
    getTags: songId => ({
      soft: { genres: ['民谣'], mood: '温柔', tempo: 'slow', energy: 0.25, valence: 0.7, vocal_softness: 0.85,
        instruments: ['钢琴', '木吉他'], has_vocal: true },
      loud: { genres: ['摇滚'], mood: '燃', tempo: 'fast', energy: 0.9, valence: 0.5, vocal_softness: 0.2,
        instruments: ['电吉他', '鼓点'], has_vocal: true },
    }[songId] || null),
  };
  const entries = scoreCandidates([track('loud'), track('untagged'), track('soft')], {
    now, cooldownMs: HOUR, tagStore: richStore, softPreferences: '想要温柔安静的钢琴民谣，少一点鼓点',
  });
  assert.equal(order(entries)[0], 'soft');
  assert.equal(entries[1].parts.softPreference || 0, 0, '未打标歌曲不得零分以外加减');
  assert.ok(entries[2].parts.softPreference > 0);
  assert.ok((entries[0].parts.softPreference || 0) < 0);
});

test('sessionSkip applies immediate penalty at consecutiveSkips >= 2 and ignores a single skip', () => {
  const moodStore = {
    getTags: songId => ({
      s1: { mood: 'sad', energy: 0.2 },
      s2: { mood: 'sad', energy: 0.25 },
      match: { mood: 'sad', energy: 0.22 },
      fresh: { mood: 'happy', energy: 0.78 },
    }[songId] || null),
  };
  const singleSkip = scoreCandidates([track('match', { artist: '连跳艺人' }), track('fresh')], {
    now, cooldownMs: HOUR, tagStore: moodStore,
    sessionSkips: { consecutiveSkips: 1, tracks: [{ source: 'qq', songId: 's1', artist: '连跳艺人' }] },
  });
  assert.equal(singleSkip[0].parts.sessionSkip || 0, 0, '单次跳过不触发会话惩罚');

  const doubleSkip = scoreCandidates([track('match', { artist: '连跳艺人' }), track('fresh')], {
    now, cooldownMs: HOUR, tagStore: moodStore,
    sessionSkips: { consecutiveSkips: 2, tracks: [
      { source: 'qq', songId: 's1', artist: '连跳艺人' },
      { source: 'qq', songId: 's2', artist: '另一艺人' },
    ] },
  });
  assert.ok(doubleSkip[0].parts.sessionSkip < 0);
  assert.equal(order(doubleSkip)[0], 'fresh');
});

test('softPreferences boosts jazz/bossa/lazy/tipsy tracks while keeping untagged tracks neutral', () => {
  const store = {
    getTags: songId => ({
      jazz: { genres: ['爵士'], mood: '慵懒', tempo: 'slow', energy: 0.35, valence: 0.6 },
      bossa: { genres: ['Bossa Nova'], mood: '浪漫', tempo: 'slow', energy: 0.38, valence: 0.65 },
      loud: { genres: ['摇滚'], mood: '燃', tempo: 'fast', energy: 0.9, valence: 0.5 },
    }[songId] || null),
  };
  const entries = scoreCandidates([track('loud'), track('untagged'), track('bossa'), track('jazz')], {
    now, cooldownMs: HOUR, tagStore: store, softPreferences: '浪漫的、jazz且慵懒，有点微醺暧昧',
  });
  const ranked = order(entries);
  assert.ok(['jazz', 'bossa'].includes(ranked[0]));
  assert.ok(['jazz', 'bossa'].includes(ranked[1]));
  assert.equal(ranked[2], 'untagged');
  assert.equal(ranked[3], 'loud');
  assert.equal(entries[1].parts.softPreference || 0, 0);
  assert.ok(entries[2].parts.softPreference > 0);
  assert.ok(entries[3].parts.softPreference > 0);
});
