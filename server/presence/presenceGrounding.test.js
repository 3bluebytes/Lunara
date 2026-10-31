// 接地素材：她为什么放这首、刚才聊了什么、这首歌在这个聊天里的来历；以及「有没有钩子」。
// 真实 ConversationStore（临时库）。Run: node --test server/presence/presenceGrounding.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { gatherPresenceGrounding, hasPresenceHook } from './presenceGrounding.js';
import { resolvePresencePolicy } from './presenceTemperament.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 19, 7, 0);

function harness(memberIds = ['lunara']) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-grounding-'));
  let clock = T0;
  const store = new ConversationStore({ dbPath: join(dir, 'state.db'), now: () => clock }).initialize();
  store.createRoom({ sessionId: 'room', memberIds, hostId: 'lunara' });
  const exchange = (requestId, userText, reply, { tracks, personId = 'lunara' } = {}) => {
    store.beginRequest({ sessionId: 'room', requestId, virtualPersonId: personId, userText });
    clock += 1_000;
    store.completeRequest({ requestId, virtualPersonId: personId,
      message: { role: 'assistant', content: reply, ...(tracks ? { tracks } : {}) } });
    clock += 1_000;
  };
  return { store, exchange, advance: ms => { clock += ms; }, now: () => clock,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const boundary = (track, extra = {}) => ({ kind: 'boundary_without_intro', sessionId: 'room', personId: 'lunara',
  triggerKey: 'room/lunara/boundary_without_intro/q2:c1', evidence: { track, planDirection: null, ...extra } });
const song = (extra = {}) => ({ provider: 'qq', songId: 's2', title: '黑色幽默', artist: '周杰伦', queueItemId: 'q2', ...extra });
const gather = (h, moment) => gatherPresenceGrounding({ store: h.store, sessionId: 'room', personId: 'lunara', moment,
  nowMs: h.now(), nameOf: id => ({ xiaoman: '小满' })[id] || id });
const balanced = resolvePresencePolicy({ modeId: 'conversational', temperament: 'balanced' });
const quiet = resolvePresencePolicy({ modeId: 'conversational', temperament: 'quiet' });

test('pick reason: the listener words and her reply from the request that queued this track', () => {
  const h = harness();
  try {
    h.exchange('req-7', '下午有点困，来点能提神但别太吵的', '好，先接一首节奏松一点的《黑色幽默》。');
    const grounding = gather(h, boundary(song({ requestId: 'req-7', origin: 'her_pick_for_request' })));
    assert.equal(grounding.pickReason.listener, '下午有点困，来点能提神但别太吵的');
    assert.match(grounding.pickReason.reply, /节奏松一点/);
    assert.equal(grounding.pickReason.source, 'pick:req-7');
    assert.equal(grounding.recentChat.length, 0, '已经作为选歌理由的回合不再重复进 recent_chat');
    assert.equal(hasPresenceHook(boundary(song()), grounding, quiet), true, '选歌理由是强钩子');
  } finally { h.close(); }
});

test('continuation picks fall back to the direction she wrote; unknown origin gives nothing', () => {
  const h = harness();
  try {
    const own = gather(h, boundary(song({ requestId: 'runtime-continuation:abc', origin: 'her_pick' }), { planDirection: '晚上安静一点' }));
    assert.deepEqual([own.pickReason.direction, own.pickReason.listener], ['晚上安静一点', null]);
    assert.match(own.pickReason.source, /^plan:[0-9a-f]{16}$/);
    const none = gather(h, boundary(song({ requestId: 'missing' })));
    assert.equal(none.pickReason, null);
  } finally { h.close(); }
});

test('a pick reason she already talked about is material but no longer a hook', () => {
  const h = harness();
  try {
    h.exchange('req-7', '来点提神的', '好。');
    h.store.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'room/lunara/boundary_without_intro/q1:c0',
      kind: 'boundary_without_intro', text: '这几首都是照你说的提神挑的。', sourceRefs: ['pick:req-7'] });
    const grounding = gather(h, boundary(song({ requestId: 'req-7' })));
    assert.ok(grounding.pickReason);
    assert.equal(grounding.pickFresh, false);
    assert.equal(hasPresenceHook(boundary(song()), grounding, quiet), false);
  } finally { h.close(); }
});

test('recent chat: last 30 minutes, at most 6 turns and 1200 characters; a hook only when something new was said', () => {
  const h = harness();
  try {
    h.exchange('old', '很久以前的话', '嗯。');
    h.advance(40 * MIN);
    for (let index = 0; index < 5; index += 1) h.exchange(`r${index}`, `第${index}句 ${'很长'.repeat(150)}`, `回应${index}`);
    const grounding = gather(h, boundary(song()));
    assert.ok(grounding.recentChat.length <= 6);
    assert.ok(grounding.recentChat.reduce((sum, item) => sum + item.said.length, 0) <= 1200);
    assert.equal(grounding.recentChat.some(item => item.said.includes('很久以前')), false);
    assert.deepEqual([...new Set(grounding.recentChat.map(item => item.speaker))].sort(), ['你', '听众']);
    assert.ok(grounding.recentChat.every(item => item.said.length <= 200));
    assert.equal(grounding.chatFresh, true);
    h.store.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'k2', kind: 'boundary_without_intro',
      text: '嗯，接着听。', sourceRefs: ['moment'] });
    assert.equal(gather(h, boundary(song())).chatFresh, false, '她开口之后没有新的话，就不是钩子');
  } finally { h.close(); }
});

test('a group brief never contains a turn that is private to one member', () => {
  const h = harness(['lunara', 'xiaoman']);
  try {
    h.exchange('p1', '只告诉你，我最近睡不好', '嗯，我记着。');
    h.exchange('p2', '大家晚上好', '晚上好呀。', { personId: 'xiaoman' });
    const grounding = gather(h, boundary(song()));
    assert.equal(JSON.stringify(grounding).includes('睡不好'), false);
    assert.ok(grounding.recentChat.some(item => item.said === '大家晚上好'));
    assert.ok(grounding.recentChat.some(item => item.speaker === '小满'));
  } finally { h.close(); }
});

test('song history: earlier appearances of this exact song in this chat, plus what she said about it', () => {
  const h = harness();
  try {
    h.exchange('a', '放首周杰伦', '来，《黑色幽默》。', { tracks: [{ songId: 's2', source: 'qq', title: '黑色幽默' }] });
    h.exchange('b', '换一首', '那就《晴天》。', { tracks: [{ songId: 's9', source: 'qq', title: '晴天' }] });
    h.store.recordTrackIntro({ sessionId: 'room', personId: 'lunara', correlationId: 'c0', queueItemId: 'q-old',
      text: '这首我很喜欢它的前奏。', track: { songId: 's2', source: 'qq', title: '黑色幽默', artist: '周杰伦' } });
    const grounding = gather(h, boundary(song()));
    assert.equal(grounding.songHistory.timesBefore, 2);
    assert.equal(grounding.songHistory.lastIntro, '这首我很喜欢它的前奏。');
    assert.equal(gather(h, boundary(song({ songId: 's404' }))).songHistory, null);
    assert.equal(hasPresenceHook(boundary(song()), { ...grounding, recentChat: [], chatFresh: false }, balanced), true);
    assert.equal(hasPresenceHook(boundary(song()), { ...grounding, recentChat: [], chatFresh: false }, quiet), false, '这只是弱钩子');
  } finally { h.close(); }
});

test('no hook at all: only a track change and the time of day', () => {
  const empty = { pickReason: null, pickFresh: false, recentChat: [], chatFresh: false, songHistory: null };
  assert.equal(hasPresenceHook(boundary(song()), empty, balanced), false);
  assert.equal(hasPresenceHook(boundary(song(), { sameArtistAsPrevious: true }), empty, balanced), true);
  assert.equal(hasPresenceHook({ ...boundary(song()), kind: 'track_completed', evidence: { consecutiveCompletions: 1 } }, empty, balanced), false);
  assert.equal(hasPresenceHook({ ...boundary(song()), kind: 'session_open' }, empty, quiet), true, '开场本身就是钩子');
});
