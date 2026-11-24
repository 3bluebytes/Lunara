// line pass 的历史副本：选歌用的标签、时长、打分和简报不带进写串词。
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyForTrackLines } from './trackLineHistory.js';

const offer = {
  ok: true, kind: 'success', code: 'MUSIC_CANDIDATES_OFFERED',
  facts: { offerId: 'o1', candidateCount: 1, brief: { text: '口味画像：喜欢慢歌' },
    candidates: [{ index: 1, songId: '9', title: 'Old Memory', artist: '市川淳', album: 'Piano', source: 'qq', duration: 75,
      features: { tags: { tempo: 'slow', energy: 'low', hasVocal: false, mood: ['calm'] }, score: 0.8, scoreParts: { taste: 0.5 },
        tasteMatches: ['+music.mood.calm'] } }] },
  context: '每首候选的 features 是可解释特征……',
};

test('select_music 结果：候选只留歌名、歌手、专辑和序号，说明换成一句', () => {
  const messages = [
    { role: 'user', content: '（续播）' },
    { role: 'assistant', content: '想放点安静的。', tool_calls: [{ id: 'c1', function: { name: 'select_music', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: JSON.stringify(offer) },
  ];
  const out = historyForTrackLines(messages);
  assert.equal(out[1], messages[1], 'host 自己写的理由原样保留');
  const parsed = JSON.parse(out[2].content);
  assert.deepEqual(parsed.facts.candidates, [{ index: 1, songId: '9', title: 'Old Memory', artist: '市川淳', album: 'Piano', source: 'qq' }]);
  assert.equal(parsed.facts.brief, undefined);
  assert.doesNotMatch(out[2].content, /features|tempo|energy|hasVocal|calm|duration|score|口味画像/u);
  assert.doesNotMatch(parsed.context, /features/u);
  assert.equal(out[2].tool_call_id, 'c1');
  assert.match(messages[2].content, /features/u, '原历史不被改动');
});

test('别的工具结果也去掉这些键；解析不了的原样保留', () => {
  const commit = { ok: true, code: 'MUSIC_COMMITTED', facts: { tracks: [{ title: 'Old Memory', duration: 75 }] }, context: '已安排' };
  const out = historyForTrackLines([{ role: 'tool', content: JSON.stringify(commit) }, { role: 'tool', content: '不是 JSON' }]);
  assert.deepEqual(JSON.parse(out[0].content).facts.tracks, [{ title: 'Old Memory' }]);
  assert.equal(JSON.parse(out[0].content).context, '已安排');
  assert.equal(out[1].content, '不是 JSON');
});
