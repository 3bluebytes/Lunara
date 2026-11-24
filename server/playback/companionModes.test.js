// 陪伴模式的引导语：资格是许可不是义务，不带句数字数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCompanionMode, occurrencePositionAutoEligible, resolveCompanionModePolicy } from './companionModes.js';

test('偶尔介绍和多聊一点的引导语采用正面授权、不含句数字数，并说明可以让歌安静地放', () => {
  for (const modeId of ['occasional', 'conversational']) {
    const { guidance } = describeCompanionMode(modeId);
    assert.doesNotMatch(guidance, /\d/u, `${modeId} 不带数字配额`);
    assert.match(guidance, /安静地放/u, modeId);
    assert.match(guidance, /按你的人设正常交流/u, modeId);
    assert.doesNotMatch(guidance, /不是每首都得说|不要编造/u, modeId);
  }
  assert.match(describeCompanionMode('music_only').guidance, /不要主动口播/u);
});

test('资格频率不变：偶尔介绍每三首一次，多聊一点每首都有，只听歌没有', () => {
  const eligible = modeId => [1, 2, 3, 4].map(position => occurrencePositionAutoEligible(resolveCompanionModePolicy(modeId), position));
  assert.deepEqual(eligible('occasional'), [true, false, false, true]);
  assert.deepEqual(eligible('conversational'), [true, true, true, true]);
  assert.deepEqual(eligible('music_only'), [false, false, false, false]);
});
