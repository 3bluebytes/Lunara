// libraryTrackCache.test.js — remember playlist tracks for later URL resolution.
//
// Run: node server/libraryTrackCache.test.js

import assert from 'node:assert/strict';
import { clearRememberedTracks, findRememberedTrack, rememberTracks } from './libraryTrackCache.js';

clearRememberedTracks();
rememberTracks([
  { title: '少年锦时', artist: '赵雷', song_id: 'qq-mid-1' },
], 'qq');

assert.equal(findRememberedTrack('赵雷 — 少年锦时')?.song_id, 'qq-mid-1');
assert.equal(findRememberedTrack('少年锦时 — 赵雷')?.song_id, 'qq-mid-1');
assert.equal(findRememberedTrack('少年锦时')?.song_id, 'qq-mid-1');

clearRememberedTracks();
rememberTracks([{ title: '飞花', artist: '歌手', song_id: 'qq-mid', source: 'qq:liked' }], 'qq');
rememberTracks([{ title: '飞花', artist: '歌手', song_id: 'ncm-id', source: 'ncm:daily' }], 'ncm');
assert.equal(findRememberedTrack('歌手 — 飞花')?.provider, 'qq', 'online refresh must not replace a collection reference');
rememberTracks([{ title: '飞花', artist: '歌手', song_id: 'qq-mid' }], 'qq');
assert.equal(findRememberedTrack('飞花')?.provider, 'qq', 'same identity refresh preserves its collection provenance');
rememberTracks([{ title: '飞花', artist: '另一歌手', song_id: 'qq-other', source: 'qq:playlist:自选' }], 'qq');
assert.equal(findRememberedTrack('飞花'), null, 'ambiguous collection titles fail closed');
assert.equal(findRememberedTrack('歌手 — 飞花')?.song_id, 'qq-mid');
clearRememberedTracks();
console.log('library track cache regressions passed');
