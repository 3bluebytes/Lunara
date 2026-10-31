import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppState, reduceServerMessage } from '../../core/appState.js';
import { TOP_BAR_MAX_TABS, deriveTimelineStops, deriveTopBarTabs } from './timelineModel.js';

const room = (sessionId, lastTurnAt, extra = {}) => ({ sessionId, memberIds: ['lunara'], lastTurnAt, ...extra });
const rooms = [
  room('a', '2026-10-20T10:00:00Z'),
  room('b', '2026-10-20T12:00:00Z'),
  room('c', '2026-10-20T11:00:00Z'),
  room('d', '2026-10-20T09:00:00Z'),
  room('e', '2026-10-20T08:00:00Z'),
  room('f', '2026-10-20T13:00:00Z', { archivedAt: '2026-10-20T13:30:00Z' }),
];

test('top bar shows at most three tabs, listening chat first, the rest by recent activity', () => {
  const tabs = deriveTopBarTabs({ rooms, focusedId: 'b', listeningId: 'e' });
  assert.equal(TOP_BAR_MAX_TABS, 3);
  assert.deepEqual(tabs.map(tab => tab.sessionId), ['e', 'b', 'c']);
  assert.deepEqual(tabs.map(tab => [tab.viewing, tab.listening]), [[false, true], [true, false], [false, false]]);
});

test('the viewed chat is always present even when it is not recent', () => {
  const tabs = deriveTopBarTabs({ rooms, focusedId: 'd', listeningId: 'e' });
  assert.deepEqual(tabs.map(tab => tab.sessionId), ['e', 'b', 'd']);
});

test('viewing and listening the same chat marks one tab with both', () => {
  const tabs = deriveTopBarTabs({ rooms, focusedId: 'c', listeningId: 'c' });
  assert.equal(tabs[0].sessionId, 'c');
  assert.equal(tabs[0].viewing && tabs[0].listening, true);
  assert.equal(tabs.filter(tab => tab.listening).length, 1);
});

test('browsing does not reorder tabs, archived chats are skipped', () => {
  const before = deriveTopBarTabs({ rooms, focusedId: 'b', listeningId: 'e' }).map(tab => tab.sessionId);
  const after = deriveTopBarTabs({ rooms, focusedId: 'c', listeningId: 'e' }).map(tab => tab.sessionId);
  assert.deepEqual(after, before);
  assert.ok(!deriveTopBarTabs({ rooms, focusedId: 'f', listeningId: null }).some(tab => tab.sessionId === 'f'));
});

test('no listening session: no dot and no empty slot', () => {
  const tabs = deriveTopBarTabs({ rooms, focusedId: 'a', listeningId: null });
  assert.equal(tabs.length, 3);
  assert.ok(tabs.every(tab => !tab.listening));
});

const song = (id, durationSeconds) => ({ queueItemId: id, title: id, durationSeconds });

test('timeline splits the runtime queue into played, current and upcoming', () => {
  const queue = [song('q1', 200), song('q2', 180), song('q3', 300), song('q4', 240), song('q5', 200)];
  const now = Date.UTC(2026, 9, 20, 6, 31);
  const stops = deriveTimelineStops({ queue, currentIndex: 2, positionSeconds: 100, now });
  assert.deepEqual(stops.played.map(stop => [stop.item.queueItemId, stop.order, stop.at]), [['q1', 1, null], ['q2', 2, null]]);
  assert.equal(stops.current.item.queueItemId, 'q3');
  assert.deepEqual(stops.upcoming.map(stop => [stop.item.queueItemId, stop.at]), [
    ['q4', now + 200_000],
    ['q5', now + 200_000 + 240_000],
  ]);
});

test('an unknown duration stops estimates for everything after it', () => {
  const queue = [song('q1', 200), song('q2', null), song('q3', 180), song('q4', 180)];
  const now = 1_000_000;
  const stops = deriveTimelineStops({ queue, currentIndex: 0, positionSeconds: 50, now });
  assert.deepEqual(stops.upcoming.map(stop => stop.at), [now + 150_000, null, null]);
});

test('nothing playing yet: no current stop and no invented times', () => {
  const stops = deriveTimelineStops({ queue: [song('q1', 200), song('q2', 200)], currentIndex: -1, positionSeconds: 0, now: 0 });
  assert.equal(stops.current, null);
  assert.deepEqual(stops.played, []);
  assert.deepEqual(stops.upcoming.map(stop => stop.at), [null, null]);
});

test('a late runtime state with an older version does not roll the timeline back', () => {
  const store = createAppState();
  const state = (version, currentIndex) => ({ type: 'runtime-state', state: { version, currentIndex, queue: [song('q1', 200), song('q2', 200)] } });
  reduceServerMessage(store, state(5, 1));
  reduceServerMessage(store, state(4, 0));
  const { runtimeState } = store.getState();
  assert.equal(deriveTimelineStops({ queue: runtimeState.queue, currentIndex: runtimeState.currentIndex, now: 0 }).current.item.queueItemId, 'q2');
});
