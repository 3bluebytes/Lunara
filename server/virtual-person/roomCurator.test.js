import test from 'node:test';
import assert from 'node:assert/strict';
import { roomCurator } from './roomCurator.js';

test('房间当前主持人可用就是策展人', () => {
  assert.equal(roomCurator({ memberIds: ['a', 'b'], activeVirtualPersonId: 'b' }), 'b');
});

test('主持人不可用时取第一个可用成员；都不可用时为 null', () => {
  const room = { memberIds: ['a', 'b', 'c'], activeVirtualPersonId: 'a' };
  assert.equal(roomCurator(room, id => id !== 'a'), 'b');
  assert.equal(roomCurator(room, () => false), null);
});

test('主持人已不在成员里时取第一个可用成员；没有成员列表的旧房间沿用主持人字段', () => {
  assert.equal(roomCurator({ memberIds: ['b', 'c'], activeVirtualPersonId: 'a' }), 'b');
  assert.equal(roomCurator({ activeVirtualPersonId: 'a' }), 'a');
  assert.equal(roomCurator(null), null);
});
