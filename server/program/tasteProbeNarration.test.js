// tasteProbeNarration.test.js — 探查的串词披露（add-taste-probe-signals）
//
// 覆盖：probeTopic 人类可读主题。

import assert from 'node:assert/strict';
import test from 'node:test';
import { probeTopic } from './tasteProbeNarration.js';

test('probeTopic 提取人类可读主题', () => {
  assert.equal(probeTopic('music.genre.rnb'), 'rnb');
  assert.equal(probeTopic('music.mood.chill.night'), 'chill night');
  assert.equal(probeTopic('bogus'), '');
  assert.equal(probeTopic(null), '');
});
