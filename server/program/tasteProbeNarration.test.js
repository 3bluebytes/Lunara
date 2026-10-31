// tasteProbeNarration.test.js — 探查的串词披露（add-taste-probe-signals）
//
// 覆盖：probeTopic 人类可读主题；withTasteProbeHint 命中合并 / 未命中原样透传。

import assert from 'node:assert/strict';
import test from 'node:test';
import { withTasteProbeHint, probeTopic } from './tasteProbeNarration.js';

test('probeTopic 提取人类可读主题', () => {
  assert.equal(probeTopic('music.genre.rnb'), 'rnb');
  assert.equal(probeTopic('music.mood.chill.night'), 'chill night');
  assert.equal(probeTopic('bogus'), '');
  assert.equal(probeTopic(null), '');
});

test('wrapper 命中 probe 时附加提示，未命中透传', async () => {
  const base = { person: { displayName: 'Lunara' }, recentConversation: [] };
  const provider = async () => ({ ...base });
  const lookup = effect => (effect.track?.songId === '3'
    ? { claim_key: 'music.genre.rnb', created_at: 1 } : null);
  const wrapped = withTasteProbeHint(provider, lookup);
  const hit = await wrapped({ track: { songId: '3', source: 'qq' } });
  assert.deepEqual(hit.tasteProbe, { claimKey: 'music.genre.rnb', topic: 'rnb' });
  assert.equal(hit.person.displayName, 'Lunara', '原上下文字段保留');
  const miss = await wrapped({ track: { songId: '1', source: 'qq' } });
  assert.equal(miss.tasteProbe, undefined, '未命中不添加字段');
});
