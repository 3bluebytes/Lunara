// 串词的机械校验：歌词、记忆和听众原话都不能被当成正文照念；歌曲记忆先过滤再截取。
//
// Run: node --test server/program/narrationDefect.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { likeStatusOf, retrieveSongMemories } from './narrationContext.js';
import { lyricExcerpt, narrationDefect } from './ProgramNarrationComposer.js';

const track = { title: '每天每天', artist: '方大同', songId: '5001', source: 'ncm', requestId: 'chat:r1' };
const lrc = [
  '[ti:每天每天]', '[00:00.00] 作词 : 某某', '[00:01.00] 作曲 : 某某', '[00:02.00] 编曲：某某',
  '[00:10.00]清晨的光落在窗边', '[00:14.00]我把想你写进日历', '[00:18.00]每天每天都一样甜',
  '[00:22.00]每天每天都一样甜', '[00:26.00]你笑起来像一首歌',
].join('\n');

// 合成对话：听众问候并点名点歌，聊天只回了模板确认（同 requestId）。
const greetingTurns = [
  { role: 'assistant', requestId: 'chat:r0', presentation: 'track_intro', text: '前一天的一段串词。' },
  { role: 'user', requestId: null, presentation: null, text: '早上好，我要听每天每天，方大同的' },
  { role: 'assistant', requestId: 'chat:r1', presentation: null, text: '好，《每天每天》已经安排上了。' },
];
const checks = (song, lyric, memories = []) => ({ track: song, facts: { album: '', year: null }, recentConversation: [],
  minSentences: 1, chatIntroduced: false, minChars: 12, lyricExcerpt: lyricExcerpt(lyric), memories });

function memoryFixture(rows) {
  const tagged = (row, tag) => `,${row.tags || ''},`.includes(`,${tag},`);
  return { store: { search: ({ namespace, sources = null, excludeTags = [] }) => rows.filter(row => row.namespace === namespace
      && (!sources || sources.includes(row.source)) && !excludeTags.some(tag => tagged(row, tag))) },
    searchMemory: (_query, { namespace }) => rows.filter(row => row.namespace === namespace) };
}

test('song memories: explicit, applicable, unrevoked and about this song or artist', () => {
  const rows = [
    { id: 1, namespace: 'person:lunara', source: 'user_explicit_feedback', content: '听众说最近单曲循环方大同《每天每天》，觉得很甜。', updatedAt: 5 },
    { id: 2, namespace: 'person:lunara', source: 'agent_reflection', content: '推断：听众喜欢《每天每天》这类小甜歌。', updatedAt: 9 },
    { id: 3, namespace: 'person:lunara', source: 'user_explicit_feedback', content: '听众不喜欢下雨天。', updatedAt: 8 },
    { id: 4, namespace: 'person:lunara', source: 'user_explicit_feedback', tags: 'person-relationship,revoked',
      content: '已经撤回的：听众讨厌方大同。', updatedAt: 7 },
    { id: 5, namespace: 'station', source: 'manual_seed', content: '方大同是听众的入坑歌手。', updatedAt: 6 },
    { id: 6, namespace: 'person:lunara', source: 'user_explicit_feedback', content: '只在私聊里说过：《每天每天》让听众想起某个人。',
      policy: { onlyConversationId: 'private-room', disclosure: 'private' }, updatedAt: 4 },
    { id: 7, namespace: 'person:lunara', source: 'user_explicit_feedback', tags: 'expression-preference',
      content: '介绍方大同的歌时不要每次都提点我。', updatedAt: 10 },
    { id: 8, namespace: 'person:lunara', source: 'user_explicit_feedback', content: `关于《每天每天》：${'很长'.repeat(200)}`, updatedAt: 3 },
  ];
  const service = memoryFixture(rows);
  const memories = retrieveSongMemories(service, { namespace: 'person:lunara', sessionId: 'room', isGroup: false, track });
  // 提到这首歌的排在只提到歌手的前面，同类按更新时间。
  assert.deepEqual(memories.map(memory => memory.slice(0, 8)), ['听众说最近单曲循', '关于《每天每天》', '方大同是听众的入']);
  assert.ok(memories.every(memory => memory.length <= 160), '每条最多 160 字');
  assert.ok(memories.length <= 3);

  assert.ok(!memories.some(memory => memory.includes('私聊')), '限定在别的聊天的记忆不取');
  const sameRoom = retrieveSongMemories(service, { namespace: 'person:lunara', sessionId: 'private-room', track });
  // 私下说的带标签：旁边有人时说不说是伙伴的分寸。
  assert.ok(sameRoom.some(memory => memory.includes('私聊') && memory.endsWith('（对方私下跟你说的）')), '同一聊天可以用，带私下标签');
  assert.deepEqual(retrieveSongMemories(null, { namespace: 'person:lunara', track }), []);
});

test('收藏状态：读不到就是未知，不是不喜欢', () => {
  const service = () => ({ getLike: (provider, songId) => (provider === 'ncm' && songId === '5001' ? { desired: true } : null) });
  assert.equal(likeStatusOf(service, track), true);
  assert.equal(likeStatusOf(service, { ...track, songId: 'other' }), null);
  assert.equal(likeStatusOf(() => { throw new ReferenceError('not ready'); }, track), null);
});

test('lyric excerpt drops timestamps, credits and repeats and stays bounded', () => {
  const excerpt = lyricExcerpt({ lrc, tlyric: '[00:10.00]translation line' });
  assert.equal(excerpt, '清晨的光落在窗边 / 我把想你写进日历 / 每天每天都一样甜 / 你笑起来像一首歌');
  assert.equal(lyricExcerpt({ lrc: '' }), null);
  assert.equal(lyricExcerpt(null), null);
  assert.equal(lyricExcerpt({ lrc: '[00:01.00]纯音乐，请欣赏' }), null);
  const long = lyricExcerpt(Array.from({ length: 80 }, (_, index) => `[00:${index}.00]第${index}句歌词在这里慢慢唱`).join('\n'));
  assert.ok(long.length <= 400, `最多 400 字，实际 ${long.length}`);
  assert.ok(!long.endsWith(' /'), '按整句截断');
});

test('acceptance: short reply passes, lyrics and memory text are not recited, titles are not echoes', () => {
  const inputs = { ...checks(track, lrc, ['听众说最近单曲循环方大同《每天每天》，觉得很甜。']), recentConversation: greetingTurns, listenerAsked: true };
  assert.equal(narrationDefect('早上好，方大同的《每天每天》来了。', inputs), null, '一句 12 字以上即可');
  assert.equal(narrationDefect('早上好，你最近挂在嘴边的那首小甜歌来了，方大同的《每天每天》。', inputs), null);
  assert.equal(narrationDefect('方大同的《每天每天》，“每天每天都一样甜”，一早听正好。', inputs), null, '15 字以内的歌词引用可以');
  assert.equal(narrationDefect('方大同的《每天每天》：清晨的光落在窗边，我把想你写进日历，每天每天都一样甜，你笑起来像一首歌。', inputs),
    'retells-lyrics', '整段按行念歌词：每行都短，拼起来就是成串复述');
  assert.equal(narrationDefect('方大同的《每天每天》，听众说最近单曲循环方大同的这首。', inputs), 'quotes-memory');
  // 听众说“我要听每天每天方大同的”，串词里出现同样的歌名歌手不算复述。
  const echoInputs = { ...inputs, recentConversation: [{ role: 'user', text: '每天每天方大同' }] };
  assert.equal(narrationDefect('来了，每天每天方大同，一早听正好。', echoInputs), null, '与歌名歌手重合的片段不算回声');
  assert.equal(narrationDefect('早上好，我要听每天每天，方大同的《每天每天》来了。', inputs), 'echoes-listener');
  for (const leak of ['voiceOfTurn', 'occasion', 'aboutThisSong', 'named_request', 'listenerLatest']) {
    assert.equal(narrationDefect(`${leak}。方大同的《每天每天》来了。`, inputs), 'internal-directive', leak);
  }
});

// 2026-10-23 实机验收：续播时串词把《同花顺》的歌词按顺序讲了一遍（“唱一个人在牌桌上反复
// 推演——假如钢铁能磨成针……底牌没有你，我也认”），只额外补了一句听感。这类“把歌词当
// 内容”的白描原本能过机械校验：每段都短于 30 字，合起来才是复述。用合成歌词锁定判据。
const storyLrc = [
  '[00:00.00] 作词 : 某某',
  '[00:10.00]要是你心里真有我',
  '[00:14.00]就不会把那封信烧了',
  '[00:18.00]假如说雨水能磨平石头',
  '[00:22.00]只要愿意等',
  '[00:26.00]我说不定就能等到你回头',
  '[00:30.00]可惜就算梦能成真',
].join('\n');
test('narration states its own judgement instead of retelling the lyric', () => {
  const inputs = checks({ title: '旧车票', artist: '林九' }, storyLrc);
  assert.equal(narrationDefect('这首《旧车票》是你收藏里的。林九唱一个人在站台上反复推演——假如雨水能磨平石头，'
    + '说不定就能等到你回头，可算到最后，梦能成真，人也回不来。', inputs), 'retells-lyrics',
  '多段歌词拼起来讲情节就是复述');
  assert.equal(narrationDefect('林九把话说得比上回轻，唱到最后更像已经松手；《旧车票》留白很多，'
    + '像一个人坐在候车厅里不想走。', inputs), null, '写自己的判断，不碰歌词内容');
  assert.equal(narrationDefect('林九甚至没把「要是你心里真有我」唱成保证，《旧车票》听着像一句自言自语。', inputs),
    null, '一句短引子加判断仍然可以');
});

// 2026-10-23 实机：英文长歌名 + 双歌手的曲目，合规开头（点名点歌手）撞上节选第一行的
// “歌名 - 歌手”元数据行，被 `recites-lyrics` 误判并整首退成兜底。元数据行不算歌词。
test('the metadata line of the excerpt is not lyric material', () => {
  const title = 'Special One (feat. Eason Chan)';
  const inputs = checks({ title, artist: 'AGA / 陈晓迅' }, ['Special One (feat. Eason Chan) - AGA/陈晓迅', '天生孤僻所以更爱你', '情人毫无常理 另有趣味', '享受怪物美'].join('\n'));
  assert.equal(narrationDefect('《Special One (feat. Eason Chan)》，AGA / 陈晓迅。这首你一直收着，两个人你来我往地唱，像在替对方把话说完。', inputs),
    null, '点名点歌手不算念歌词');
  assert.equal(narrationDefect('《Special One (feat. Eason Chan)》，AGA / 陈晓迅。天生孤僻所以更爱你，情人毫无常理另有趣味，这首把怪当成好来唱。', inputs),
    'retells-lyrics', '真的照念歌词仍然拦');
});
