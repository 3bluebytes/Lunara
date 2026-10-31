import assert from 'node:assert/strict';
import test from 'node:test';
import { createNarrationContextProvider } from './narrationContext.js';

for (const members of [['lunara'], ['lunara', 'mika'], ['mika']]) {
  test(`narration uses the real speaker and all members: ${members.join(',')}`, () => {
    let actual;
    const personId = members.at(-1);
    const getContext = createNarrationContextProvider({
      registry: { get: id => ({ id, memoryNamespace: id }) },
      conversationStore: { getSession: () => ({ memberIds: members }), listTurns: () => [] },
      getSongTagStore: () => ({ getTags: () => null, getArtistTags: () => null }),
      getLifeSnapshot: audience => {
        actual = audience;
        return { entries: members.every(id => id === 'lunara') ? [{ sceneTag: '私密场景' }] : [] };
      },
    });
    const context = getContext({ listeningSessionId: 'room', track: { songId: '1', source: 'qq', artist: 'A', virtualPersonId: personId } });
    assert.equal(actual.personId, personId);
    assert.deepEqual(actual.participants, members);
    assert.equal(context.lifeScene.notes.includes('私密场景'), members.length === 1 && personId === 'lunara');
  });
}

function recommendationFixture({ turns, members = ['host', 'b'], readable = () => true, requests = {}, people = ['host', 'b', 'c'] }) {
  return createNarrationContextProvider({
    registry: { get: id => (people.includes(id) ? { id, displayName: id.toUpperCase(), memoryNamespace: id } : null) },
    conversationStore: {
      getSession: () => ({ memberIds: members }),
      listTurns: () => turns,
      canReadTurn: (personId, turn) => readable(personId, turn),
      getRequest: id => requests[id] || null,
    },
    getSongTagStore: () => ({ getTags: () => null, getArtistTags: () => null }),
  });
}
const roundTurns = [
  { turnId: 't0', role: 'assistant', requestId: 'old', speakerVirtualPersonId: 'b', message: { content: '上一轮 B 说的' } },
  { turnId: 't1', role: 'user', requestId: 'r', speakerVirtualPersonId: null, message: { content: '你们一人推一首' } },
  { turnId: 't2', role: 'assistant', requestId: 'rb', speakerVirtualPersonId: 'b', message: { content: '我推《春风吹》，副歌很开阔。' } },
  { turnId: 't3', role: 'assistant', requestId: 'rh', speakerVirtualPersonId: 'host', message: { content: '那我来放。' } },
];
const recTrack = { songId: '1', source: 'qq', artist: 'A', virtualPersonId: 'host', recommendedBy: 'b', requestId: 'rh' };

test('有推荐人时串词语境给出推荐人身份与推荐那一轮的公开发言', () => {
  const context = recommendationFixture({ turns: roundTurns })({ listeningSessionId: 'room', track: recTrack });
  assert.deepEqual(context.recommendation, { personId: 'b', displayName: 'B', publicNote: '我推《春风吹》，副歌很开阔。' });
  assert.deepEqual(context.memberNames, ['HOST', 'B']);
});

test('主持人回应尚未落库但仍在运行时，取当前轮里推荐人的发言', () => {
  const context = recommendationFixture({ turns: roundTurns.slice(0, 3), requests: { rh: { state: 'running' } } })(
    { listeningSessionId: 'room', track: recTrack });
  assert.equal(context.recommendation.publicNote, '我推《春风吹》，副歌很开阔。');
});

test('找不到推荐那一轮时不拿别的轮的话充数', () => {
  const context = recommendationFixture({ turns: roundTurns.slice(0, 3), requests: { rh: { state: 'completed' } } })(
    { listeningSessionId: 'room', track: recTrack });
  assert.deepEqual(context.recommendation, { personId: 'b', displayName: 'B', publicNote: null });
});

test('推荐人发言对串词人不可读或推荐人已移出房间时 publicNote 为空', () => {
  const unreadable = recommendationFixture({ turns: roundTurns, readable: (_, turn) => turn.turnId !== 't2' })(
    { listeningSessionId: 'room', track: recTrack });
  assert.equal(unreadable.recommendation.publicNote, null);
  const removed = recommendationFixture({ turns: roundTurns, members: ['host'] })({ listeningSessionId: 'room', track: recTrack });
  assert.equal(removed.recommendation.publicNote, null);
});

test('publicNote 截断；没有推荐人或推荐人不存在时没有 recommendation', () => {
  const long = roundTurns.map(turn => (turn.turnId === 't2' ? { ...turn, message: { content: '长'.repeat(500) } } : turn));
  const context = recommendationFixture({ turns: long })({ listeningSessionId: 'room', track: recTrack });
  assert.ok(context.recommendation.publicNote.length <= 200);
  assert.equal(recommendationFixture({ turns: roundTurns })({ listeningSessionId: 'room',
    track: { ...recTrack, recommendedBy: null } }).recommendation, null);
  assert.equal(recommendationFixture({ turns: roundTurns, people: ['host'] })({ listeningSessionId: 'room',
    track: recTrack }).recommendation, null);
});
