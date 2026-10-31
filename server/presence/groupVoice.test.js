// groupVoice.test.js — 群聊一拍的出声权（add-companion-heartbeat D9 / 9.1）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVoice, rotateFollowers } from './groupVoice.js';

const track = (virtualPersonId, reason) => ({ songId: 's1', virtualPersonId,
  ...(reason ? { narration: { context: { reason, mode: 'discovery' } } } : {}) });
const snapshot = current => ({ activeListeningSessionId: 'room', currentIndex: 0, queue: current ? [current] : [] });
const room = (memberIds, activeVirtualPersonId) => Object.freeze({ sessionId: 'room', memberIds: Object.freeze(memberIds), activeVirtualPersonId });

test('默认由当前主持人出声，其他成员按入群顺序跟文字', () => {
  const voice = resolveVoice({ snapshot: snapshot(track('lunara', 'auto_continue')), room: room(['lunara', 'xiaoman', 'yehang'], 'xiaoman') });
  assert.deepEqual(voice, { holderId: 'xiaoman', hostId: 'xiaoman', delegated: false, followerIds: ['lunara', 'yehang'] });
});

test('听歌人那一轮由非主持人提交的歌在放时，出声权临时转给她；房间与设置不变', () => {
  const frozen = room(['lunara', 'xiaoman'], 'lunara');
  const voice = resolveVoice({ snapshot: snapshot(track('xiaoman', 'user_request')), room: frozen });
  assert.deepEqual(voice, { holderId: 'xiaoman', hostId: 'lunara', delegated: true, followerIds: ['lunara'] });
  assert.equal(frozen.activeVirtualPersonId, 'lunara');
});

test('自动续播的歌和没有来源的歌都归主持人', () => {
  for (const reason of ['auto_continue', null]) {
    const voice = resolveVoice({ snapshot: snapshot(track('xiaoman', reason)), room: room(['lunara', 'xiaoman'], 'lunara') });
    assert.equal(voice.holderId, 'lunara', String(reason));
    assert.equal(voice.delegated, false);
  }
  assert.equal(resolveVoice({ snapshot: snapshot(null), room: room(['lunara', 'xiaoman'], 'xiaoman') }).holderId, 'xiaoman');
});

test('临时出声者被移出 → 回到主持人；主持人被移出或归档 → 第一个可用成员', () => {
  const delegateGone = resolveVoice({ snapshot: snapshot(track('xiaoman', 'user_request')), room: room(['lunara', 'yehang'], 'lunara') });
  assert.equal(delegateGone.holderId, 'lunara');
  assert.equal(delegateGone.delegated, false);
  const hostGone = resolveVoice({ snapshot: snapshot(track('lunara', 'auto_continue')), room: room(['xiaoman', 'yehang'], 'lunara') });
  assert.deepEqual([hostGone.hostId, hostGone.holderId, hostGone.followerIds], ['xiaoman', 'xiaoman', ['yehang']]);
  const hostArchived = resolveVoice({ snapshot: snapshot(null), room: room(['lunara', 'xiaoman', 'yehang'], 'lunara'),
    isAvailable: id => id !== 'lunara' });
  assert.deepEqual([hostArchived.holderId, hostArchived.followerIds], ['xiaoman', ['yehang']]);
  const delegateArchived = resolveVoice({ snapshot: snapshot(track('xiaoman', 'user_request')), room: room(['lunara', 'xiaoman'], 'lunara'),
    isAvailable: id => id !== 'xiaoman' });
  assert.deepEqual([delegateArchived.holderId, delegateArchived.followerIds], ['lunara', []]);
});

test('单聊保持原口径：正在放的这首由谁负责就是谁，没有跟话的人', () => {
  const voice = resolveVoice({ snapshot: snapshot(track('lunara', 'user_request')), room: room(['lunara'], 'lunara') });
  assert.deepEqual(voice, { holderId: 'lunara', hostId: 'lunara', delegated: false, followerIds: [] });
  assert.equal(resolveVoice({ snapshot: snapshot(null), room: null }).holderId, 'lunara');
  // 只剩一个可用成员的群按单聊处理。
  assert.deepEqual(resolveVoice({ snapshot: snapshot(null), room: room(['lunara', 'xiaoman'], 'lunara'),
    isAvailable: id => id === 'xiaoman' }).followerIds, []);
});

test('跟话轮换：上一拍最后跟话的人排到最后', () => {
  assert.deepEqual(rotateFollowers(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  assert.deepEqual(rotateFollowers(['a', 'b', 'c'], 'c'), ['a', 'b', 'c']);
  assert.deepEqual(rotateFollowers(['a', 'b'], 'gone'), ['a', 'b']);
  assert.deepEqual(rotateFollowers(['a', 'b'], null), ['a', 'b']);
});

test('推荐轮：主持人提交、小满推荐的歌在放时由主持人出声；yield_floor 后小满自己提交的歌仍临时转给她', () => {
  const frozen = room(['lunara', 'xiaoman'], 'lunara');
  const recommended = { ...track('lunara', 'user_request'), recommendedBy: 'xiaoman' };
  assert.deepEqual(resolveVoice({ snapshot: snapshot(recommended), room: frozen }),
    { holderId: 'lunara', hostId: 'lunara', delegated: false, followerIds: ['xiaoman'] });
  assert.deepEqual(resolveVoice({ snapshot: snapshot(track('xiaoman', 'user_request')), room: frozen }),
    { holderId: 'xiaoman', hostId: 'lunara', delegated: true, followerIds: ['lunara'] });
});
