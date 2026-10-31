import test from 'node:test';
import assert from 'node:assert/strict';
import { colorFor, identityDots, wallTime, acquaintanceDays, queueEstimates, lyricGap, deliveredTime, trackTitleSize } from './cikePresentation.js';

test('title typography accounts for CJK width without changing the title', () => {
  assert.equal(trackTitleSize('枫叶城'), 'normal');
  assert.equal(trackTitleSize('Variations On The Canon By Pachelbel'), 'long');
  assert.equal(trackTitleSize('这是一首标题比较长的中文歌曲用于检查排版'), 'long');
  assert.equal(trackTitleSize('A'.repeat(120)), 'extra-long');
  assert.equal(trackTitleSize(null), 'normal');
});

test('identity is stable by id, root is moon white and markup escapes ids', () => {
  assert.equal(colorFor('lunara'), 'var(--partner-lunara, #cfd6e6)');
  assert.equal(colorFor('mio'), colorFor('mio'));
  // 槽位固定，颜色交给主题的 --partner-N，原色板作回退。
  assert.match(colorFor('sora'), /^var\(--partner-[1-6], #[a-f0-9]{6}\)$/);
  assert.doesNotMatch(identityDots(['"><script>']), /<script>/);
  assert.equal((identityDots(['mio','sora'], 'mio').match(/is-live/g)||[]).length, 1);
});
test('times and days never invent missing history', () => {
  const now = new Date(2026, 9, 18, 18, 16).getTime();
  assert.equal(wallTime(now), '18:16');
  assert.equal(acquaintanceDays(null, now), null);
  assert.equal(acquaintanceDays(now - 86400000, now), 2);
  assert.equal(acquaintanceDays(now + 86400000, now), null);
});
test('queue ETA is occurrence ordered, excludes played and stops at unknown duration', () => {
  const queue = [{queueItemId:'a',duration:180},{queueItemId:'b',duration:120},{queueItemId:'c'}];
  const estimates = queueEstimates(queue, 0, 60, 0);
  assert.equal(estimates.get('b'), 120000);
  assert.equal(estimates.get('c'), 240000);
  assert.equal(queueEstimates([{queueItemId:'a'},{queueItemId:'b'}],0,0,0).has('b'), false);
});
test('recommendation time belongs to the delivered queue occurrence, never a catalog id', () => {
  const at = new Date(2026,9,18,18,14).getTime();
  const turns = [{role:'assistant',turnId:'intro:old',text:'old',createdAt:at},
    {role:'assistant',turnId:'intro:current',text:'current',createdAt:at+60000}];
  assert.equal(deliveredTime({queueItemId:'current',songId:'same'},turns),'18:15');
  assert.equal(deliveredTime({queueItemId:'missing',songId:'same'},turns),'');
});

test('lyric gap only reports a timestamp based long gap, never instrument guesses', () => {
  assert.equal(lyricGap([{time:0,text:'one'},{time:40,text:'two'}], 15), 25);
  assert.equal(lyricGap([{time:0,text:'one'},{time:40,text:'two'}], 1), null);
  assert.equal(lyricGap([], 15), null);
  assert.equal(lyricGap([{ time: 0, text: 'last line' }], 15), null);
  for (const time of [null, undefined, NaN, Infinity, -1]) {
    assert.equal(lyricGap([{ time, text: 'untimed' }], 15), null);
    assert.equal(lyricGap([{ time: 0, text: 'credits' }, { time, text: 'unknown' }], 15), null);
  }
});
