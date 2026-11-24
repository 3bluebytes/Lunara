import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendationOf } from './narrationContext.js';

function recommendationFixture({ turns, members = ['host', 'b'], readable = () => true, requests = {}, people = ['host', 'b', 'c'] }) {
  const registry = { get: id => (people.includes(id) ? { id, displayName: id.toUpperCase(), memoryNamespace: id } : null) };
  const conversationStore = { listTurns: () => turns, canReadTurn: (personId, turn) => readable(personId, turn), getRequest: id => requests[id] || null };
  return track => recommendationOf({ track, registry, conversationStore, room: { memberIds: members }, sessionId: 'room', isGroup: members.length > 1 });
}
const roundTurns = [
  { turnId: 't0', role: 'assistant', requestId: 'old', speakerVirtualPersonId: 'b', message: { content: '上一轮 B 说的' } },
  { turnId: 't1', role: 'user', requestId: 'r', speakerVirtualPersonId: null, message: { content: '你们一人推一首' } },
  { turnId: 't2', role: 'assistant', requestId: 'rb', speakerVirtualPersonId: 'b', message: { content: '我推《春风吹》，副歌很开阔。' } },
  { turnId: 't3', role: 'assistant', requestId: 'rh', speakerVirtualPersonId: 'host', message: { content: '那我来放。' } },
];
const recTrack = { songId: '1', source: 'qq', artist: 'A', virtualPersonId: 'host', recommendedBy: 'b', requestId: 'rh' };

test('有推荐人时串词语境给出推荐人身份与推荐那一轮的公开发言', () => {
  const recommendation = recommendationFixture({ turns: roundTurns })(recTrack);
  assert.deepEqual(recommendation, { personId: 'b', displayName: 'B', publicNote: '我推《春风吹》，副歌很开阔。' });
});

test('主持人回应尚未落库但仍在运行时，取当前轮里推荐人的发言', () => {
  const context = recommendationFixture({ turns: roundTurns.slice(0, 3), requests: { rh: { state: 'running' } } })(recTrack);
  assert.equal(context.publicNote, '我推《春风吹》，副歌很开阔。');
});

test('找不到推荐那一轮时不拿别的轮的话充数', () => {
  const context = recommendationFixture({ turns: roundTurns.slice(0, 3), requests: { rh: { state: 'completed' } } })(recTrack);
  assert.deepEqual(context, { personId: 'b', displayName: 'B', publicNote: null });
});

test('推荐人发言对串词人不可读或推荐人已移出房间时 publicNote 为空', () => {
  const unreadable = recommendationFixture({ turns: roundTurns, readable: (_, turn) => turn.turnId !== 't2' })(recTrack);
  assert.equal(unreadable.publicNote, null);
  const removed = recommendationFixture({ turns: roundTurns, members: ['host'] })(recTrack);
  assert.equal(removed.publicNote, null);
});

test('publicNote 截断；没有推荐人或推荐人不存在时没有 recommendation', () => {
  const long = roundTurns.map(turn => (turn.turnId === 't2' ? { ...turn, message: { content: '长'.repeat(500) } } : turn));
  const context = recommendationFixture({ turns: long })(recTrack);
  assert.ok(context.publicNote.length <= 200);
  assert.equal(recommendationFixture({ turns: roundTurns })({ ...recTrack, recommendedBy: null }), null);
  assert.equal(recommendationFixture({ turns: roundTurns, people: ['host'] })(recTrack), null);
});
