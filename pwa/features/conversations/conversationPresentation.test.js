import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveConversationGroups, deriveConversationPresentation, deriveCurrentTrackIntroduction } from './conversationPresentation.js';

test('focused room and runtime listening room remain distinct presentation facts', () => {
  const rooms = [
    { sessionId: 'a', title: '夜行电台', activeVirtualPersonId: 'lunara' },
    { sessionId: 'b', title: '午后爵士', activeVirtualPersonId: 'radiohost-b' },
  ];
  const track = { song_id: 'song-2', virtualPersonId: 'lunara', title: 'Night Drive' };
  const runtime = { activeListeningSessionId: 'a', currentSongId: 'song-2', currentIndex: 1,
    queue: [{ song_id: 'song-1' }, track, { song_id: 'song-3' }] };
  const projection = deriveConversationPresentation({
    rooms, focusedRoom: rooms[1], persons: [{ id: 'lunara' }, { id: 'radiohost-b' }], runtime,
  });

  assert.equal(projection.focusedRoom.sessionId, 'b');
  assert.equal(projection.listeningRoom.sessionId, 'a');
  assert.equal(projection.focusedPerson.id, 'radiohost-b');
  assert.equal(projection.listeningPerson.id, 'lunara');
  assert.equal(projection.track, track);
  assert.equal(projection.sourceMismatch, true);
  assert.deepEqual(projection.queueItems.map(item => item.state), ['played', 'current', 'upcoming']);
  assert.equal(projection.focusedListeningTrack, null);
  assert.deepEqual(projection.focusedQueueItems, []);
  assert.equal(projection.focusedHasCheckpoint, false);
});

test('focused canvas projects only its suspended checkpoint while global playback stays active elsewhere', () => {
  const rooms = [
    { sessionId: 'a', title: '夜行电台', activeVirtualPersonId: 'lunara' },
    { sessionId: 'b', title: '午后爵士', activeVirtualPersonId: 'radiohost-b' },
  ];
  const activeTrack = { queueItemId: 'a:1', songId: 'active', title: 'Active song', virtualPersonId: 'lunara' };
  const savedTrack = { queueItemId: 'b:1', songId: 'saved', title: 'Saved song', virtualPersonId: 'radiohost-b' };
  const runtime = {
    activeListeningSessionId: 'a', currentSongId: 'active', currentIndex: 0, queue: [activeTrack],
    suspendedSessions: { b: { currentSongId: 'saved', currentIndex: 0, queue: [savedTrack], positionSeconds: 18 } },
  };
  const projection = deriveConversationPresentation({
    rooms, focusedRoom: rooms[1], persons: [{ id: 'lunara' }, { id: 'radiohost-b' }], runtime,
  });

  assert.equal(projection.track, activeTrack);
  assert.equal(projection.listeningRoom.sessionId, 'a');
  assert.equal(projection.focusedListeningTrack, savedTrack);
  assert.equal(projection.focusedListeningPerson.id, 'radiohost-b');
  assert.equal(projection.focusedListeningRuntime.positionSeconds, 18);
  assert.deepEqual(projection.focusedQueueItems.map(item => item.item.title), ['Saved song']);
  assert.equal(projection.focusedHasCheckpoint, true);
});

test('missing runtime state does not invent a track or source mismatch', () => {
  const room = { sessionId: 'a' };
  const projection = deriveConversationPresentation({ rooms: [room], focusedRoom: room });
  assert.equal(projection.track, null);
  assert.equal(projection.listeningRoom, null);
  assert.equal(projection.sourceMismatch, false);
  assert.deepEqual(projection.queueItems, []);
});

test('runtime cursor projects the current occurrence when a song repeats in the queue', () => {
  const first = { song_id: 'same-song', title: 'First occurrence' };
  const current = { song_id: 'same-song', title: 'Current occurrence' };
  const projection = deriveConversationPresentation({ runtime: {
    currentSongId: 'same-song', currentIndex: 1, queue: [first, current],
  } });

  assert.equal(projection.track, current);
  assert.deepEqual(projection.queueItems.map(item => item.state), ['played', 'current']);
});

test('current track introduction uses the same delivered chat text for the exact queue item', () => {
  const turns = [
    { turnId: 'intro:queue:first', role: 'assistant', presentation: 'track_intro',
      queueItemId: 'queue:first', text: '第一遍的介绍。', speakerVirtualPersonId: 'lunara' },
    { turnId: 'intro:queue:second', role: 'assistant', presentation: 'track_intro',
      queueItemId: 'queue:second', text: '第二遍更贴合现在的介绍。', speakerVirtualPersonId: 'radiohost-b' },
  ];

  assert.deepEqual(deriveCurrentTrackIntroduction({ queueItemId: 'queue:second', songId: 'same-song' }, turns), {
    queueItemId: 'queue:second', text: '第二遍更贴合现在的介绍。',
    turnId: 'intro:queue:second', speakerVirtualPersonId: 'radiohost-b',
  });
});

test('track changes never keep the previous song introduction while the next one is pending', () => {
  const turns = [{ turnId: 'intro:queue:first', role: 'assistant', presentation: 'track_intro',
    queueItemId: 'queue:first', text: '上一首的介绍。' }];

  assert.equal(deriveCurrentTrackIntroduction({ queueItemId: 'queue:second', songId: 'different-song' }, turns), null);
});

test('historical track introductions can be restored from the stable legacy turn identity', () => {
  const turns = [{ turnId: 'intro:queue:historical', role: 'assistant', presentation: 'track_intro',
    text: '之前已经听过的介绍。', speakerVirtualPersonId: 'lunara' }];

  assert.equal(
    deriveCurrentTrackIntroduction({ queueItemId: 'queue:historical' }, turns)?.text,
    '之前已经听过的介绍。',
  );
});


test('sidebar groups sort pinned first, host groups next, then group chats, all by recency', () => {
  const persons = [
    { id: 'lunara', displayName: 'Lunara' },
    { id: 'a', displayName: '夜航' },
    { id: 'b', displayName: '小满' },
    { id: 'c', displayName: 'HOSHI' },
  ];
  const groups = deriveConversationGroups({
    persons,
    rooms: [
      { sessionId: 'duo-a', memberIds: ['lunara', 'a'], lastTurnAt: 90 },
      { sessionId: 'solo', memberIds: ['lunara'], lastTurnAt: 40 },
      { sessionId: 'pinned-old', memberIds: ['lunara', 'b'], lastTurnAt: 10, pinnedAt: 7 },
      { sessionId: 'duo-b', memberIds: ['lunara', 'b'], lastTurnAt: 60 },
      { sessionId: 'trio', memberIds: ['lunara', 'b', 'c'], lastTurnAt: 70 },
    ],
  });

  // 人数按成员直接计：Lunara+一位伙伴也算两人 → 群聊；只有 Lunara 自己 → Lunara 组。
  assert.deepEqual(groups.map(group => [group.kind, group.label]), [
    ['pinned', '置顶'], ['host', 'Lunara'], ['group', '群聊'],
  ]);
  assert.deepEqual(groups[0].rooms.map(room => room.sessionId), ['pinned-old']);
  assert.deepEqual(groups[1].rooms.map(room => room.sessionId), ['solo']);
  // 群聊组内按最近活动倒序（duo-a 的 lastTurnAt 90 最新）。
  assert.deepEqual(groups[2].rooms.map(room => room.sessionId), ['duo-a', 'trio', 'duo-b']);
});

test('solo conversations group by their only member and never reach the group section', () => {
  const groups = deriveConversationGroups({
    persons: [{ id: 'lunara', displayName: 'Lunara' }, { id: 'b', displayName: '小满' }],
    rooms: [
      { sessionId: 'solo-lunara', memberIds: ['lunara'], createdAt: 5 },
      { sessionId: 'solo-b', memberIds: ['b'], lastTurnAt: 3 },
      { sessionId: 'empty', memberIds: [], lastTurnAt: 2 },
    ],
  });
  // 单人房间按唯一成员的显示名归组；空成员回退 Lunara，与 Lunara 的单人房间合入同组。
  assert.deepEqual(groups.map(group => [group.label, group.rooms.map(room => room.sessionId)]), [
    ['Lunara', ['solo-lunara', 'empty']], ['小满', ['solo-b']],
  ]);
  assert.equal(groups.filter(group => group.kind === 'group').length, 0);
});
