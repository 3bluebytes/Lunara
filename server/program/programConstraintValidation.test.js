import assert from 'node:assert/strict';
import test from 'node:test';
import { requestedTrackCount, validateResolvedTrackAgainstRequest, validateSelectionConstraints } from './programConstraintValidation.js';

test('requested track count respects explicit Chinese and Arabic counts', () => {
  assert.equal(requestedTrackCount('来一首粤语歌', 3), 1);
  assert.equal(requestedTrackCount('来 2 首', 1), 2);
  assert.equal(requestedTrackCount('随便放点', 2), 2);
});

test('language and vocalist constraints require canonical tag evidence', () => {
  const store = {
    getTags: () => ({ language: 'cantonese', artist_key: 'janice' }),
    getArtistTags: () => ({ gender: 'female' }),
  };
  assert.equal(validateResolvedTrackAgainstRequest(
    { songId: '1', source: 'qq' },
    { requestText: '来一首安静的粤语女声', songTagStore: store },
  ).ok, true);
  assert.equal(validateResolvedTrackAgainstRequest(
    { songId: '2', source: 'qq' },
    { requestText: '来一首粤语女声', songTagStore: { getTags: () => null } },
  ).ok, false);
});

test('excluded artist matches a credited collaborator but not an unrelated longer name', () => {
  const request = { constraints: { excludedArtists: ['周深'] } };
  assert.equal(validateSelectionConstraints({ artist: '另一位歌手、周深' }, request).ok, false);
  assert.equal(validateSelectionConstraints({ artist: '周深度' }, request).ok, true);
});
