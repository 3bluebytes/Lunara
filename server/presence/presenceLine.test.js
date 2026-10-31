// presence_line 机械校验与素材组装。Run: node --test server/presence/presenceLine.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { bigramSimilarity, buildPresenceBrief, buildPresenceTask, dayPartOf, presenceEvidence, presenceLineDefect } from './presenceLine.js';

const moment = (kind, evidence = {}) => ({ kind, sessionId: 'room', personId: 'lunara', triggerKey: `room/lunara/${kind}/1`,
  evidence: { track: { provider: 'qq', songId: 's1', title: '晴天', artist: '周杰伦', queueItemId: 'q1' }, ...evidence } });

test('证据清单只含可复核事实且 ref 稳定；时段只给粗粒度词', () => {
  const evidence = presenceEvidence(moment('boundary_without_intro', { sameArtistAsPrevious: true, consecutiveSkips: 0,
    longGapSinceVoice: true }), { dayPart: '深夜' });
  assert.deepEqual(evidence.map(item => item.ref), ['moment', 'track', 'same_artist', 'quiet_while', 'day_part']);
  assert.equal(evidence[1].title, '晴天');
  assert.equal(dayPartOf(Date.parse('2026-10-19T15:30:00Z'), 'Asia/Shanghai'), '深夜');
  assert.equal(dayPartOf(Date.parse('2026-10-19T12:00:00Z'), 'Asia/Shanghai'), '晚上');
  const brief = buildPresenceBrief(buildPresenceTask(moment('track_completed'), { recentLines: ['a', 'b', 'c', 'd'] }));
  assert.deepEqual(brief.recentLines, ['b', 'c', 'd'], '只带最近 3 句');
  assert.ok(brief.acceptanceRules.length >= 5);
  assert.doesNotMatch(JSON.stringify(brief), /budget|reason|triggerKey|cooldown/i, 'brief 不含调度内部结构');
});

test('校验器：一句、≤40 汉字、证据非空且来自 brief、实体来自证据、无内部术语与播放声称、不复读', () => {
  const task = buildPresenceTask(moment('track_completed'), { recentLines: ['这首听完，心里有点空空的。'] });
  const ok = '这首听完，房间好像安静了一点。';
  assert.equal(presenceLineDefect(ok, ['moment'], task), null);
  assert.equal(presenceLineDefect('《晴天》的尾奏还在耳朵里。', ['track'], task), null);
  assert.equal(presenceLineDefect('', ['moment'], task), 'empty_text');
  assert.equal(presenceLineDefect('听完了。真好。', ['moment'], task), 'multiple_sentences');
  assert.equal(presenceLineDefect('第一行\n第二行', ['moment'], task), 'multiple_sentences');
  assert.equal(presenceLineDefect('一'.repeat(41), ['moment'], task), 'too_long');
  assert.equal(presenceLineDefect(ok, [], task), 'missing_evidence');
  assert.equal(presenceLineDefect(ok, ['mood'], task), 'unknown_evidence');
  assert.equal(presenceLineDefect('《七里香》也很好听', ['track'], task), 'entity_outside_evidence');
  assert.equal(presenceLineDefect('队列里还有好多歌', ['moment'], task), 'internal_terms');
  assert.equal(presenceLineDefect('看这里 https://x.cn', ['moment'], task), 'url');
  assert.equal(presenceLineDefect('我已经给你切到下一首了', ['moment'], task), 'playback_claim');
  assert.equal(presenceLineDefect('这首听完，心里有点空空的', ['moment'], task), 'repeats_recent');
  assert.ok(bigramSimilarity('今晚的风很轻', '今晚的风很轻啊') > 0.8);
});

test('选歌来源进证据；情绪不靠禁词表管——有依据的一句话不会因为某个情绪词被拒', () => {
  const own = buildPresenceTask(moment('boundary_without_intro', { track: { provider: 'qq', songId: 's2', title: '黑色幽默',
    artist: '周杰伦', album: 'Jay', queueItemId: 'q2', origin: 'her_pick' } }), { dayPart: '下午' });
  assert.match(own.evidence.find(item => item.ref === 'picked_by').fact, /你自己挑/);
  assert.equal(own.evidence.find(item => item.ref === 'track').album, 'Jay');
  assert.equal(presenceLineDefect('没想到这首放在下午也挺合适', ['track', 'day_part'], own), null);
  const requested = presenceEvidence(moment('boundary_without_intro', { track: { title: '晴天', artist: '周杰伦', origin: 'listener_request' } }));
  assert.match(requested.find(item => item.ref === 'picked_by').fact, /听众点/);
  assert.equal(presenceEvidence(moment('boundary_without_intro')).some(item => item.ref === 'picked_by'), false, '来源未知不给 picked_by');
  assert.doesNotMatch(JSON.stringify(buildPresenceBrief(own)), /此刻的感受/, '写作要求不再引导她编感受');
});

test('接地素材进证据：选歌理由、最近聊天（短 ref，turnId 只进 sources）、这首歌的来历', () => {
  const grounding = {
    pickReason: { listener: '来点提神但别太吵的', reply: '先接一首节奏松一点的。', direction: null, source: 'pick:req-7' },
    recentChat: [{ speaker: '听众', said: '今天开会开到头疼', turnId: 'turn-a' }, { speaker: '你', said: '辛苦了，《稻香》要不要也排上', turnId: 'turn-b' }],
    songHistory: { timesBefore: 2, lastIntro: '这首我很喜欢它的前奏。' },
  };
  const task = buildPresenceTask(moment('boundary_without_intro'), { dayPart: '下午', grounding,
    temperament: { id: 'quiet', hint: '你话不多。', style: '偶尔冷幽默' } });
  const refs = task.evidence.map(item => item.ref);
  for (const ref of ['pick_reason', 'chat_1', 'chat_2', 'song_history']) assert.ok(refs.includes(ref), ref);
  assert.equal(task.evidence.find(item => item.ref === 'pick_reason').listenerSaid, '来点提神但别太吵的');
  assert.equal(task.evidence.find(item => item.ref === 'chat_1').said, '今天开会开到头疼');
  assert.deepEqual(task.sources, { pick_reason: 'pick:req-7', chat_1: 'chat:turn-a', chat_2: 'chat:turn-b' });
  const brief = buildPresenceBrief(task);
  assert.doesNotMatch(JSON.stringify(brief), /turn-a|req-7/, 'brief 不含内部 id');
  assert.deepEqual(brief.yourWay, { hint: '你话不多。', style: '偶尔冷幽默' });
  assert.equal(presenceLineDefect('刚才说的《稻香》，等这首完了也行', ['chat_2'], task), null, '歌名可以来自聊天素材');
  assert.equal(presenceLineDefect('《七里香》也不错', ['chat_2'], task), 'entity_outside_evidence');
});
