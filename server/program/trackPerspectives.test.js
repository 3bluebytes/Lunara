import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { registerMusicTools } from '../virtual-person/musicTools.js';
import { createTrackLineMaterialProvider } from './trackLineMaterial.js';
import { historyForTrackLines } from './trackLineHistory.js';

const song = (songId, source = 'qq') => ({ songId, source, title: '同名歌曲', artist: '歌手' });

function fixture(t) {
  const store = new ConversationStore({ dbPath: ':memory:' }).initialize();
  t.after(() => store.close());
  for (const sessionId of ['room', 'other']) store.createRoom({ sessionId, memberIds: ['host', 'peer'], hostId: 'host' });
  let occurrence = 0;
  const intro = (track, about, { sessionId = 'room', personId = 'host' } = {}) => store.recordTrackIntro({
    sessionId, personId, queueItemId: `note-${++occurrence}`, text: '旧口播原文不应该出现在按歌备忘里。', track, about,
  });
  return { store, intro };
}

test('按歌取同一伙伴、同一聊天最新的有效备忘，撤回后不再读取', t => {
  const { store, intro } = fixture(t);
  intro(song('1'), '旧角度');
  const newest = intro(song('1'), '新角度');
  const superseded = intro(song('1'), '已取代');
  store.db.prepare('UPDATE conversation_turns SET superseded_at = 1 WHERE turn_id = ?').run(superseded.turnId);
  intro(song('1'), '  ');
  intro(song('1'), '另一位伙伴的笔记', { personId: 'peer' });
  intro(song('1'), '另一个聊天的笔记', { sessionId: 'other' });
  intro(song('1', 'ncm'), '另一来源的笔记');
  for (let i = 0; i < 70; i++) intro(song(`unrelated-${i}`), '别的歌');
  const read = () => store.recallTrackPerspectives({ sessionId: 'room', personId: 'host', tracks: [song('1'), song('2'), song('1', 'ncm')] });
  assert.deepEqual(read(), ['新角度', null, '另一来源的笔记']);
  store.revokeObservation('host', newest.turnId);
  assert.deepEqual(read(), ['旧角度', null, '另一来源的笔记']);
  const split = store.beginRound({ sessionId: 'room', roundId: 'split', userText: '从这里分叉', responsePlan: ['host'] });
  const fork = store.forkFromTurn('room', split.userTurnId).room.sessionId;
  assert.deepEqual(store.recallTrackPerspectives({ sessionId: fork, personId: 'host', tracks: [song('1')] }), [null]);
  store.addMember('room', 'newcomer');
  assert.deepEqual(read(), [null, null, null], '不会把旧群聊的备忘带到新成员面前');
});

test('写串词时给出同歌旧角度，不给旧台词，也不从未播草稿学习', t => {
  const { store, intro } = fixture(t);
  intro(song('1'), '歌词视角从旁观者变成当事人');
  for (let i = 0; i < 65; i++) intro(song(`unrelated-${i}`), null);
  const getMaterial = createTrackLineMaterialProvider({ registry: { get: () => null }, conversationStore: store,
    getListening: () => ({ queue: [{ ...song('2'), narration: { status: 'ready', text: '未播文字', about: '未播角度' } }] }) });
  const material = getMaterial([{ ref: 't1', track: song('1') }, { ref: 't2', track: song('2') }],
    { sessionId: 'room', personId: 'host' });
  assert.equal(material.tracks[0].material.priorPerspective, '歌词视角从旁观者变成当事人');
  assert.equal(material.tracks[1].material.priorPerspective, null);
  assert.match(material.trigger.content, /旧角度[^\n]*歌词视角从旁观者变成当事人/u);
  assert.doesNotMatch(material.trigger.content, /旧口播原文|旧角度[^\n]*未播角度/u, '待念备忘仍可出现在防重小节，但不是按歌召回');
});

test('只有后台选歌的临时工具结果带备忘，最多八条，不改变候选或泄漏到继承历史', async t => {
  const { store, intro } = fixture(t);
  const candidates = Array.from({ length: 9 }, (_, i) => ({ ...song(String(i)), index: i + 1 }));
  for (const track of candidates) intro(track, `试过的角度 ${track.index}`);
  const offer = { candidates };
  const registry = new VirtualPersonToolRegistry();
  registerMusicTools(registry, () => ({ conversationStore: store, execute: async () => ({
    ok: true, code: 'MUSIC_CANDIDATES_OFFERED', offerId: 'o1', request: { mode: 'discovery', delivery: 'append', count: 2 }, offer,
  }) }));
  const args = { mode: 'discovery', delivery: 'append', count: 2 };
  const context = { sessionId: 'room', virtualPersonId: 'host' };
  const normal = await registry.execute('select_music', args, { ...context, userText: '再放两首' });
  const background = await registry.execute('select_music', args, { ...context, musicTaskRequest: { mode: 'playback' } });
  const preparation = await registry.execute('select_music', args, { ...context, musicTaskRequest: { mode: 'preparation' } });
  assert.deepEqual(preparation.facts, background.facts, '预热与实时后台选歌的参考视图一致');
  assert.equal(normal.facts.priorTrackPerspectives, undefined);
  assert.deepEqual(background.facts.candidates, normal.facts.candidates);
  assert.deepEqual(background.facts.priorTrackPerspectives, candidates.slice(0, 8).map(({ index }) => ({ index, note: `试过的角度 ${index}` })));
  assert.equal(offer.priorTrackPerspectives, undefined);
  assert.doesNotMatch(background.modelContext, /试过的角度/u, '不要把备忘重复嵌入上下文字符串');
  const [inherited] = historyForTrackLines([{ role: 'tool', content: JSON.stringify({ code: background.code,
    facts: background.facts, context: background.modelContext }) }]);
  assert.doesNotMatch(inherited.content, /priorTrackPerspectives|试过的角度/u);
});
