import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMusicSelection, continuationPlan, continuationSelection, artistMatchesRequest,
  SELECT_MUSIC_PARAMETERS } from './musicSelectionRequest.js';
import { CONTINUATION_BATCH_SIZE } from './continuationBudget.js';
import { validateJsonSchema } from '../virtual-person/jsonSchemaValidator.js';

test('a soft artist preference is normalized, deduplicated and capped at five instead of failing the turn', () => {
  const request = normalizeMusicSelection({ mode: 'discovery', delivery: 'replace_now', count: 2,
    preferredArtists: ['  孙燕姿 ', '孙燕姿', '蔡健雅', '', '   ', '王菲', '那英', '莫文蔚', '郑秀文', '陈绮贞'] });
  assert.deepEqual(request.preferredArtists, ['孙燕姿', '蔡健雅', '王菲', '那英', '莫文蔚']);
});

test('a soft artist preference is not a hard constraint and stays out of constraints', () => {
  const request = normalizeMusicSelection({ mode: 'discovery', delivery: 'replace_now', count: 2, preferredArtists: ['孙燕姿'] });
  assert.equal(request.artist, '');
  assert.deepEqual(request.constraints.excludedArtists, []);
  assert.deepEqual(normalizeMusicSelection({ mode: 'discovery', delivery: 'replace_now' }).preferredArtists, []);
});

test('a runaway soft artist list is still rejected as malformed input', () => {
  assert.throws(() => normalizeMusicSelection({ mode: 'discovery', delivery: 'replace_now', count: 2,
    preferredArtists: Array.from({ length: 11 }, (_value, index) => `歌手${index}`) }), /preferredArtists|too many|maxItems/i);
});

test('the artist matching rule shared by hard filters and soft preferences is a case-insensitive containment', () => {
  assert.equal(artistMatchesRequest('孙燕姿', '孙燕姿'), true);
  assert.equal(artistMatchesRequest('群星 / 孙燕姿', '孙燕姿'), true);
  assert.equal(artistMatchesRequest('孙燕姿', 'SUN'), false);
  assert.equal(artistMatchesRequest('Stefanie Sun', 'stefanie'), true);
  assert.equal(artistMatchesRequest('孙燕姿', '  '), false);
});

test('continuation asks for one batch and appends, never replacing the current queue', () => {
  const next = continuationSelection({ mode: 'discovery', delivery: 'replace_now', count: 5 });
  assert.equal(next.delivery, 'append');
  assert.equal(next.count, CONTINUATION_BATCH_SIZE);
});

test('continuation keeps a playlist plan on its own playlist instead of switching to discovery', () => {
  const next = continuationSelection({ mode: 'playlist', delivery: 'replace_now', count: 2,
    playlist: { source: 'qq', playlistId: 'list-1' }, preferredArtists: ['孙燕姿'] });
  assert.equal(next.mode, 'playlist');
  assert.deepEqual(next.playlist, { source: 'qq', playlistId: 'list-1' });
  assert.deepEqual(next.preferredArtists, ['孙燕姿'], '歌单续播不额外累积歌手偏好');
});

test('continuation of a plan that already carries a preference is idempotent', () => {
  const once = continuationSelection({ mode: 'exact', delivery: 'replace_now', count: 1,
    targets: [{ title: '歌', artist: '孙燕姿' }] });
  const twice = continuationSelection(once, { previousTrack: { artist: '孙燕姿' } });
  assert.equal(twice.mode, 'discovery');
  assert.equal(twice.artist, '');
  assert.deepEqual(twice.preferredArtists, ['孙燕姿']);
  assert.equal(twice.count, CONTINUATION_BATCH_SIZE);
});

test('存回的续播计划不带刚播完那首的锚点，反复续播也不累积', () => {
  const plan = continuationPlan({ mode: 'artist', artist: '孙燕姿', delivery: 'replace_now', count: 1 });
  assert.deepEqual(plan.preferredArtists, ['孙燕姿'], '用户点的歌手留作软偏好');
  assert.deepEqual(continuationPlan(plan), plan, '对自身幂等');
  const round = continuationSelection(plan, { previousTrack: { artist: '陈奕迅' } });
  assert.deepEqual(round.preferredArtists, ['陈奕迅', '孙燕姿'], '这一轮的排序仍然跟着正在放的这首');
  assert.deepEqual(continuationPlan(plan).preferredArtists, ['孙燕姿']);
});

// ---- 整张专辑（add-album-sequencing）----

test('a whole-album request carries one stable reference instead of title targets', () => {
  const request = normalizeMusicSelection({ mode: 'album', delivery: 'append', count: 2,
    album: { source: 'ncm', albumId: ' 123456 ' } });
  assert.equal(request.mode, 'album');
  assert.deepEqual(request.album, { source: 'ncm', albumId: '123456' });
  assert.deepEqual(request.targets, []);
});

test('an album reference without source or id is rejected before any selection work', () => {
  assert.throws(() => normalizeMusicSelection({ mode: 'album', delivery: 'append', album: { source: 'ncm' } }),
    /albumId|整张专辑需要音乐源和专辑 ID/);
  assert.throws(() => normalizeMusicSelection({ mode: 'album', delivery: 'append', album: { source: 'spotify', albumId: '1' } }),
    /album.source|整张专辑需要音乐源和专辑 ID/);
  assert.throws(() => normalizeMusicSelection({ mode: 'album', delivery: 'append', album: { source: 'ncm', albumId: '  ' } }),
    /整张专辑需要音乐源和专辑 ID/);
  assert.throws(() => normalizeMusicSelection({ mode: 'album', delivery: 'append' }),
    /整张专辑需要音乐源和专辑 ID/);
});

test('an album request never mixes with per-song targets', () => {
  assert.throws(() => normalizeMusicSelection({ mode: 'album', delivery: 'append',
    album: { source: 'qq', albumId: 'mid-1' }, targets: [{ title: '某首', artist: '某人' }] }),
  /整张专辑不需要逐个点歌/);
});

test('continuation keeps the album reference and does not fall back to the previous artist', () => {
  const next = continuationSelection({ mode: 'album', delivery: 'replace_now', count: 3,
    album: { source: 'qq', albumId: 'mid-1' } }, { previousTrack: { artist: '某位歌手' } });
  assert.equal(next.mode, 'album');
  assert.deepEqual(next.album, { source: 'qq', albumId: 'mid-1' });
  assert.deepEqual(next.preferredArtists, []);
  assert.equal(next.delivery, 'append');
  assert.equal(next.count, CONTINUATION_BATCH_SIZE);
});

test('SELECT_MUSIC_PARAMETERS reserves constraints.tags for objective boundaries while keeping normalizeMusicSelection backward-compatible', () => {
  const rejected = ['genre', 'mood', 'tempo', 'minEnergy', 'maxEnergy', 'minValence', 'maxValence', 'artistGenre', 'themes', 'instruments'];
  for (const key of rejected) {
    const sample = key === 'themes' || key === 'instruments' ? ['夜晚'] : key.startsWith('min') || key.startsWith('max') ? 0.5 : 'slow';
    const check = validateJsonSchema({
      mode: 'constrained',
      delivery: 'replace_now',
      constraints: { tags: { [key]: sample } },
    }, SELECT_MUSIC_PARAMETERS);
    assert.equal(check.valid, false, `select_music schema should reject subjective tag ${key}`);
  }

  const objectiveOk = validateJsonSchema({
    mode: 'constrained',
    delivery: 'replace_now',
    constraints: { tags: { language: 'cantonese', gender: 'female', has_vocal: true, vocal_state: 'instrumental', minYear: 2000, maxYear: 2020, region: '港台' } },
  }, SELECT_MUSIC_PARAMETERS);
  assert.equal(objectiveOk.valid, true, objectiveOk.errors.join('; '));

  const legacyNormalized = normalizeMusicSelection({
    mode: 'constrained',
    delivery: 'replace_now',
    constraints: { tags: { genre: '爵士', tempo: 'slow' } },
  });
  assert.deepEqual(legacyNormalized.constraints.tags, { genre: '爵士', tempo: 'slow' });
});

test('continuationSelection and continuationPlan idempotently soften subjective tags while preserving objective constraints', () => {
  const subjectiveOnly = {
    mode: 'constrained',
    delivery: 'replace_now',
    count: 6,
    constraints: {
      tags: { genre: '爵士', tempo: 'slow', mood: '慵懒', maxEnergy: 0.4, minValence: 0.6, instruments: ['钢琴'] },
    },
    softPreferences: '浪漫、微醺',
  };
  const next = continuationSelection(subjectiveOnly);
  assert.equal(next.mode, 'discovery');
  assert.deepEqual(next.constraints.tags, {});
  for (const cue of ['浪漫、微醺', '爵士', '慢歌', '慵懒', '轻柔', '温暖', '钢琴']) {
    assert.ok(next.softPreferences.includes(cue), `expected softPreferences to include ${cue}, got ${next.softPreferences}`);
  }

  const plan = continuationPlan(subjectiveOnly);
  assert.deepEqual(continuationPlan(plan), plan, 'continuationPlan must remain idempotent');

  const mixed = {
    mode: 'constrained',
    delivery: 'replace_now',
    count: 3,
    constraints: {
      tags: { language: 'cantonese', genre: '爵士', tempo: 'slow' },
      excludeVersions: ['live'],
      excludedSongIds: ['s1'],
    },
    softPreferences: '爵士气氛',
  };
  const mixedNext = continuationSelection(mixed);
  assert.equal(mixedNext.mode, 'constrained', 'objective hard constraints keep constrained mode');
  assert.deepEqual(mixedNext.constraints.tags, { language: 'cantonese' });
  assert.deepEqual(mixedNext.constraints.excludeVersions, ['live']);
  assert.deepEqual(mixedNext.constraints.excludedSongIds, ['s1']);
  assert.equal(mixedNext.softPreferences.match(/爵士/g)?.length, 1, 'already-mentioned vibe term is not duplicated');
  assert.ok(mixedNext.softPreferences.includes('慢歌'));
});
