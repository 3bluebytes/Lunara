import test from 'node:test';
import assert from 'node:assert/strict';
import { planResponses } from './responsePlan.js';

const persons = [
  { id: 'lunara', displayName: 'Lunara', status: 'active' },
  { id: 'xiaoman', displayName: '小满', status: 'active' },
  { id: 'night', displayName: '夜航', status: 'active' },
];
const room = (memberIds, activeVirtualPersonId = 'lunara') => ({ memberIds, activeVirtualPersonId });

test('主持人和别人一起被点名：别人先说，主持人最后收歌', () => {
  assert.deepEqual(planResponses({ room: room(['lunara', 'xiaoman']), persons,
    userText: '@Lunara @小满 你们俩一人推一首方大同的歌' }), ['xiaoman', 'lunara']);
});

test('「每人」路径：主持人排最后，其余保持入群顺序', () => {
  assert.deepEqual(planResponses({ room: room(['lunara', 'xiaoman', 'night']), persons,
    userText: '大家每人推一首' }), ['xiaoman', 'night', 'lunara']);
});

test('「你们」路径：跟话成员先说，主持人最后', () => {
  assert.deepEqual(planResponses({ room: room(['lunara', 'xiaoman']), persons, userText: '你们聊聊这首' }),
    ['xiaoman', 'lunara']);
});

test('主持人不是第一个成员时也排最后', () => {
  assert.deepEqual(planResponses({ room: room(['lunara', 'xiaoman'], 'xiaoman'), persons,
    userText: '@Lunara @小满 各推一首' }), ['lunara', 'xiaoman']);
});

test('只点名非主持人：计划里没有主持人，不追加', () => {
  assert.deepEqual(planResponses({ room: room(['lunara', 'xiaoman', 'night']), persons,
    userText: '@小满 @夜航 各推一首' }), ['xiaoman', 'night']);
  assert.deepEqual(planResponses({ room: room(['lunara', 'xiaoman']), persons, userText: '@小满 推一首' }), ['xiaoman']);
});

test('单人计划不变', () => {
  assert.deepEqual(planResponses({ room: room(['lunara', 'xiaoman']), persons, userText: '来点歌' }), ['lunara']);
  assert.deepEqual(planResponses({ room: room(['lunara']), persons, userText: '你们推一首' }), ['lunara']);
});
