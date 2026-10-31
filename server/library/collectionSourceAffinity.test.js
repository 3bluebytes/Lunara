import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionOrigin, findCollectionMatch } from './collectionSourceAffinity.js';
const qq = { source: 'qq:library', song_id: 'mid', title: '飞花', artist: '歌手' };
const ncm = { source: 'ncm:daily', song_id: '123', title: '飞花', artist: '歌手' };
test('only actual collection provenance counts, not search or daily', () => {
  assert.equal(collectionOrigin(qq), 'qq:library');
  assert.equal(collectionOrigin(ncm), '');
  assert.equal(findCollectionMatch('歌手 — 飞花', [ncm, qq]).track.song_id, 'mid');
});
test('versions and punctuation are not erased, and homonyms are ambiguous', () => {
  assert.equal(findCollectionMatch('飞花', [{...qq, title: '飞花 (Live)'}]).status, 'none');
  assert.equal(findCollectionMatch('飞花', [qq, {...qq, song_id:'other', artist:'另一歌手'}]).status, 'ambiguous');
  assert.equal(findCollectionMatch('歌手 — 飞花', [qq, {...qq, song_id:'other', artist:'另一歌手'}]).status, 'matched');
});
test('a default favorites membership beats an ordinary playlist, but never a different artist homonym', () => {
 const favorite = {...qq, collectionKind:'liked'};
 assert.equal(findCollectionMatch('飞花', [ncm, {...ncm,source:'ncm:library'},favorite]).track.provider,'qq');
 assert.equal(findCollectionMatch('飞花',[favorite,{...qq,song_id:'other',artist:'另一个歌手'}]).status,'ambiguous');
});
test('source scope is enforced, and equal collected references do not depend on array order', () => {
  const nc = {...ncm, source:'ncm:library'};
  assert.equal(findCollectionMatch('飞花', [qq,nc], {sources:['ncm']}).track.provider, 'ncm');
  for (const rows of [[qq,nc], [nc,qq]]) assert.equal(findCollectionMatch('飞花', rows).status, 'ambiguous');
  assert.equal(findCollectionMatch('飞花', [qq, {...qq}]).status, 'matched');
});
