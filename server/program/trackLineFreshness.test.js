// 交付前核对：没说出口的串词到开口前还算不算数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACK_LINE_MAX_AGE_MS, createTrackLineFreshness } from './trackLineFreshness.js';

const NOW = 10 * TRACK_LINE_MAX_AGE_MS;
const track = (narration = {}) => ({ title: '晴天', virtualPersonId: 'p1', requestId: 'r1',
  narration: { writtenAt: NOW - 1000, membershipRevision: 2, ...narration } });

function freshness({ turns = [], membershipRevision = 2 } = {}) {
  return createTrackLineFreshness({ now: () => NOW,
    conversationStore: { getSession: () => ({ membershipRevision }), listTurns: () => turns } });
}
const hostTurn = (content, overrides = {}) => ({ role: 'assistant', speakerVirtualPersonId: 'p1', requestId: 'r2',
  createdAt: NOW - 500, message: { content, presentation: null }, ...overrides });

test('刚写好、没有变化：还算数', () => {
  assert.equal(freshness()(track(), 's1'), null);
});

test('早先存着、没有写作时间的串词照常交付', () => {
  assert.equal(freshness({ membershipRevision: 9 })(track({ writtenAt: null }), 's1'), null);
});

test('写了超过 6 小时：作废', () => {
  assert.equal(freshness()(track({ writtenAt: NOW - TRACK_LINE_MAX_AGE_MS - 1 }), 's1'), 'too-old');
  assert.equal(freshness()(track({ writtenAt: NOW - TRACK_LINE_MAX_AGE_MS }), 's1'), null);
});

test('房间成员变了：作废', () => {
  assert.equal(freshness({ membershipRevision: 3 })(track(), 's1'), 'membership-changed');
});

test('host 写完之后在聊天里提过这首：作废', () => {
  assert.equal(freshness({ turns: [hostTurn('刚才说的晴天，副歌确实好。')] })(track(), 's1'), 'host-already-named');
});

test('这些都不算提过：写之前说的、提交那一轮的确认、别人说的、已经说出口的串词、别的歌', () => {
  for (const turn of [
    hostTurn('晴天', { createdAt: NOW - 2000 }),
    hostTurn('《晴天》已经排上了。', { requestId: 'r1' }),
    hostTurn('晴天', { speakerVirtualPersonId: 'p2' }),
    hostTurn('晴天', { message: { content: '晴天', presentation: 'track_intro' } }),
    hostTurn('七里香挺好的。'),
    { role: 'user', createdAt: NOW - 500, message: { content: '晴天真好' } },
  ]) assert.equal(freshness({ turns: [turn] })(track(), 's1'), null);
});
