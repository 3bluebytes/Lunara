import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppState, reduceServerMessage } from './appState.js';

test('a late HTTP snapshot cannot replace a newer listening session received over WebSocket', () => {
  const store = createAppState();
  const newer = { version: 12, activeListeningSessionId: 'b', currentIndex: 0,
    queue: [{ songId: 'b', title: 'B', url: '/b.mp3' }] };
  reduceServerMessage(store, { type: 'runtime-state', state: newer });
  reduceServerMessage(store, { type: 'runtime-state', state: { version: 11,
    activeListeningSessionId: 'a', currentIndex: -1, queue: [] } });
  assert.equal(store.getState().runtimeState.activeListeningSessionId, 'b');
  assert.equal(store.getState().queue[0].song_id, 'b');
});

test('scoped and invalid-version snapshots cannot overwrite the global runtime', () => {
  for (const version of [undefined, null, -1, 1.5, NaN, Infinity, '12']) {
    const store = createAppState();
    reduceServerMessage(store, { type: 'runtime-state', state: { version: 11,
      activeListeningSessionId: 'a', outputGeneration: 3, currentIndex: 0,
      queue: [{ queueItemId: 'q:a', songId: 'a' }], suspendedSessions: { b: { queue: [] } } } });
    const before = store.getState();
    reduceServerMessage(store, { type: 'runtime-state', state: {
      version, runtimeVersion: 12, listeningSessionId: 'a', active: true,
      currentIndex: 0, queue: [{ queueItemId: 'q:a', songId: 'a' }],
      companionModeId: 'conversational',
    } });
    assert.strictEqual(store.getState(), before, `invalid global version: ${version}`);
  }
});

test('compatibility queues cannot overwrite a received runtime queue at any version', () => {
  for (const runtimeVersion of [undefined, 8, 9, 10]) {
    const store = createAppState();
    reduceServerMessage(store, { type: 'runtime-state', state: { version: 9,
      currentIndex: 0, currentSongId: 'jp', queue: [{ queueItemId: 'q:jp', songId: 'jp',
        source: 'ncm', title: '日本語の曲', lyric: { lrc: '[00:00]日本語の歌詞' } }] } });
    const before = store.getState();
    reduceServerMessage(store, { type: 'queue-update', runtimeVersion, cursor: 1,
      queue: [{ kind: 'track', song_id: 'jp' }, { kind: 'track', song_id: 'cn',
        lyric: { lrc: '[00:00]下一首中文歌词' } }], messages: [{ say: '正常聊天消息' }] });
    assert.strictEqual(store.getState(), before, `compat version ${runtimeVersion}`);
  }
});

test('app state exposes detached snapshots and notifies only after a real update', () => {
  const store = createAppState({ queue: [], cursor: -1, activeRadiohost: null });
  const changes = [];
  const unsubscribe = store.subscribe((next, previous, action) => changes.push({ next, previous, action }));

  const before = store.getState();
  const same = store.update(current => current, { type: 'noop' });
  assert.strictEqual(same, before);
  assert.equal(changes.length, 0);

  const next = store.update({ mode: 'chat' }, { type: 'mode.changed' });
  assert.notStrictEqual(next, before);
  assert.equal(Object.isFrozen(next), true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].action.type, 'mode.changed');
  unsubscribe();
});

test('queue update replaces the single queue slice and preserves unrelated state', () => {
  const store = createAppState({ queue: [], cursor: -1, activeRadiohost: { id: 'radiohost-a' }, mode: 'chat' });
  reduceServerMessage(store, {
    type: 'queue-update',
    queue: [{ kind: 'track', song_id: 's1', title: 'One' }],
    cursor: 0,
  });
  const state = store.getState();
  assert.deepEqual(state.queue, [{ kind: 'track', song_id: 's1', title: 'One' }]);
  assert.equal(state.cursor, 0);
  assert.deepEqual(state.activeRadiohost, { id: 'radiohost-a' });
  assert.equal(state.mode, 'chat');
});

test('RADIOHOST_CREATED without activation does not overwrite active radiohost', () => {
  const store = createAppState({ activeRadiohost: { id: 'radiohost-a', name: 'A' } });
  reduceServerMessage(store, { type: 'RADIOHOST_CREATED', payload: { radiohost: { id: 'radiohost-b', name: 'B' } } });
  assert.deepEqual(store.getState().activeRadiohost, { id: 'radiohost-a', name: 'A' });
});

test('replacing a queue that no longer contains the playing track resets its cursor', () => {
  const store = createAppState({
    queue: [
      { kind: 'track', song_id: 'old-1', url: '/old-1.mp3' },
      { kind: 'track', song_id: 'old-2', url: '/old-2.mp3' },
    ],
    cursor: 1,
  });
  reduceServerMessage(store, {
    type: 'queue-update',
    queue: [
      { kind: 'track', song_id: 'new-1', url: '/new-1.mp3' },
      { kind: 'track', song_id: 'new-2', url: '/new-2.mp3' },
    ],
    cursor: -1,
  });
  assert.equal(store.getState().cursor, -1);
});

test('an out-of-range local cursor yields to the authoritative server cursor', () => {
  const store = createAppState({
    queue: [{ kind: 'track', song_id: 'old-1', url: '/old-1.mp3' }],
    cursor: 3,
  });

  reduceServerMessage(store, {
    type: 'queue-update',
    queue: [
      { kind: 'track', song_id: 'new-1', url: '/new-1.mp3' },
      { kind: 'track', song_id: 'new-2', url: '/new-2.mp3' },
    ],
    cursor: -1,
  });

  assert.equal(store.getState().cursor, -1);
});

test('reconnect accepts the server cursor even when local media has finished', () => {
  const queue = [
    { kind: 'track', song_id: 'same-1', url: '/same-1.mp3', status: 'playing' },
  ];
  const store = createAppState({ queue, cursor: queue.length });

  reduceServerMessage(store, {
    type: 'queue-update',
    queue: [
      { kind: 'track', song_id: 'same-1', url: '/same-1.mp3', status: 'upcoming' },
    ],
    cursor: -1,
  });

  assert.equal(store.getState().cursor, -1);
});

test('replace-now snapshot keeps its authoritative cursor even when loaded history remains', () => {
  const old = { kind: 'track', song_id: 'old', url: '/old.mp3' };
  const history = { kind: 'track', song_id: 'history', url: '/history.mp3' };
  const next = { kind: 'track', song_id: 'new', url: '/new.mp3' };
  const store = createAppState({ queue: [history, old], cursor: 1 });

  reduceServerMessage(store, {
    type: 'queue-update',
    queue: [history, old, next],
    cursor: 2,
    delivery: 'replace_now',
  });

  assert.equal(store.getState().cursor, 2);
  assert.equal(store.getState().queue[2].song_id, 'new');
});

test('runtime state projects the authoritative track queue and cursor', () => {
  const store = createAppState();
  reduceServerMessage(store, {
    type: 'runtime-state',
    state: {
      version: 7,
      currentIndex: 1,
      txn: { correlationId: 'runtime-2-b', songId: 'b' },
      queue: [
        { queueItemId: 'queue:a', songId: 'a', programId: 'p1', requestId: 'r1', title: 'A', artist: 'AA', url: '/a.mp3', intro: {} },
        { queueItemId: 'queue:b', songId: 'b', programId: 'p1', requestId: 'r1', title: 'B', artist: 'BB', url: '/b.mp3', intro: { text: 'B intro', ttsUrl: '/b-tts.mp3' } },
      ],
    },
  });

  const state = store.getState();
  assert.equal(state.runtimeState.version, 7);
  assert.equal(state.cursor, 1);
  assert.equal(state.queue[1].song_id, 'b');
  assert.equal(state.queue[1].queueItemId, 'queue:b');
  assert.equal(state.queue[1].queue_item_id, 'queue:b');
  assert.equal(state.queue[1].intro.correlationId, 'runtime-2-b');
  assert.equal(state.queue[0].status, 'played');
});

test('runtime queue projection always accepts the server cursor', () => {
  const store = createAppState({
    queue: [{ kind: 'track', song_id: 'old', url: '/old.mp3' }],
    cursor: 0,
  });
  reduceServerMessage(store, {
    type: 'queue-update',
    runtimeVersion: 3,
    queue: [{ kind: 'track', song_id: 'new', url: '/new.mp3' }],
    cursor: -1,
  });
  assert.equal(store.getState().cursor, -1);
  assert.equal(store.getState().queue[0].song_id, 'new');
});

test('another room activation and unscoped radiohost creation cannot replace the visible chat host', () => {
  const store = createAppState({ sessionId: 'a', activeRadiohost: { id: 'a' } });
  reduceServerMessage(store, { type: 'RADIOHOST_ACTIVATED', conversationId: 'b', payload: { active: { id: 'b' } } });
  reduceServerMessage(store, { type: 'RADIOHOST_CREATED', payload: { active: { id: 'b' } } });
  assert.equal(store.getState().activeRadiohost.id, 'a');
});
