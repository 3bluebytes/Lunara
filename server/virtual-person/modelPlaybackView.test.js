// 给模型看的播放状态：以当前这首为中心的队列窗口，长队列不会把当前歌挤出有界状态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelPlaybackView } from './modelPlaybackView.js';
import { sanitizeFacts } from './toolFacts.js';
import { currentTrackOf } from '../presence/ambientTurn.js';

const queueOf = count => Array.from({ length: count }, (_, index) => ({
  queueItemId: `q${index}`, songId: `s${index}`, title: `歌${index}`, artist: `歌手${index}` }));

test('长队列：当前这首在窗口里，经过有界清洗后仍取得到', () => {
  const snapshot = { queue: queueOf(108), currentIndex: 107, currentSongId: 's107', phase: 'playing' };
  const view = modelPlaybackView(snapshot);
  assert.equal(view.queue.length, 4, '前 3 首加当前这首');
  assert.equal(view.queue[view.currentIndex].title, '歌107');
  assert.deepEqual(view.queueWindow, { start: 104, total: 108 });
  const bounded = sanitizeFacts({ playback: view });
  assert.equal(currentTrackOf(bounded)?.title, '歌107');
  assert.equal(snapshot.queue.length, 108, '不改原快照');
});

test('窗口：前 3 首、当前、后 8 首；还没开始时从头给', () => {
  const middle = modelPlaybackView({ queue: queueOf(30), currentIndex: 10 });
  assert.deepEqual(middle.queue.map(item => item.queueItemId), ['q7', 'q8', 'q9', 'q10', 'q11', 'q12', 'q13', 'q14', 'q15', 'q16', 'q17', 'q18']);
  assert.equal(middle.currentIndex, 3);
  const fresh = modelPlaybackView({ queue: queueOf(30), currentIndex: -1 });
  assert.equal(fresh.currentIndex, -1);
  assert.equal(fresh.queue[0].queueItemId, 'q0');
  assert.equal(fresh.queue.length, 9);
});

test('刚离开的那首：标明是听众点了不喜欢撤下的', () => {
  const view = modelPlaybackView({ queue: queueOf(3), currentIndex: 1, currentSongId: 's1',
    lastOutputTrack: { title: '管他的公路尽头', artist: '王源', songId: 'w1' },
    txn: { queueItemId: 'q1', reason: 'disliked_track_removed' } });
  assert.equal(view.lastOutputTrack.title, '管他的公路尽头');
  assert.match(view.lastOutputTrack.endedBy, /不喜欢/u);
  const skipped = modelPlaybackView({ queue: queueOf(3), currentIndex: 1, currentSongId: 's1',
    lastOutputTrack: { title: 'A', artist: 'B', songId: 'x' }, txn: { reason: 'manual_next' } });
  assert.match(skipped.lastOutputTrack.endedBy, /跳过/u);
  const unknown = modelPlaybackView({ queue: queueOf(3), currentIndex: 1,
    lastOutputTrack: { title: 'A', artist: 'B', songId: 'x' }, txn: null });
  assert.equal(unknown.lastOutputTrack.endedBy, undefined, '不知道怎么离开的就不说');
});

test('没有队列的状态原样返回', () => {
  assert.equal(modelPlaybackView(null), null);
  assert.deepEqual(modelPlaybackView({ phase: 'idle' }), { phase: 'idle' });
});
