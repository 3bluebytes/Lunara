import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueService } from './QueueService.js';

function runtimeSnapshot(overrides = {}) {
  return {
    version: 4,
    phase: 'playing',
    currentIndex: 1,
    currentSongId: 'two',
    txn: { correlationId: 'corr-two', songId: 'two', queueItemId: 'queue:two' },
    queue: [
      { queueItemId: 'queue:one', songId: 'one', title: 'One', artist: 'A', source: 'ncm', url: '/one.mp3', programId: 'p', requestId: 'r',
        narration: { status: 'preparing', assetStatus: 'resolving', generationRevision: 1 } },
      { queueItemId: 'queue:two', songId: 'two', title: 'Two', artist: 'B', source: 'ncm', url: '/two.mp3', programId: 'p', requestId: 'r',
        narration: { status: 'ready', assetStatus: 'ready', text: 'Two intro', ttsUrl: '/two-tts.mp3', generationRevision: 1 } },
    ],
    ...overrides,
  };
}

test('queue service projects exact occurrence ids while hiding all narration internals', () => {
  const queue = new QueueService();
  const result = queue.projectRuntimeSnapshot(runtimeSnapshot(), { publish: false });
  assert.equal(result.ok, true);
  assert.deepEqual(queue.snapshot().queue.map(item => item.song_id), ['one', 'two']);
  assert.equal(queue.snapshot().queue[1].queueItemId, 'queue:two');
  assert.equal(queue.snapshot().queue[1].queue_item_id, 'queue:two');
  assert.equal(queue.snapshot().cursor, 1);
  assert.equal(queue.snapshot().runtimeVersion, 4);
  assert.equal(Object.hasOwn(queue.snapshot().queue[1], 'intro'), false);
  assert.equal(Object.hasOwn(queue.snapshot().queue[1], 'narration'), false);
  assert.doesNotMatch(JSON.stringify(queue.snapshot()), /preparing|resolving|generationRevision|Two intro|two-tts/);
  for (const method of ['append', 'commitProgram', 'insert', 'remove', 'replace', 'reorder', 'clearUpcoming', 'markPlaying', 'reconcilePlaybackIdentity']) {
    assert.equal(queue[method], undefined);
  }
});

test('runtime projection publishes one queue-update with presentation metadata', () => {
  const published = [];
  const queue = new QueueService({ publish: message => published.push(message) });
  queue.projectRuntimeSnapshot(runtimeSnapshot(), {
    message: { say: '节目说明' },
    songCards: [{ songId: 'two' }],
  });
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'queue-update');
  assert.equal(published[0].runtimeVersion, 4);
  assert.equal(published[0].cursor, 1);
  assert.deepEqual(published[0].message, { say: '节目说明' });
});

test('presentation-only publish reuses the latest read projection', () => {
  const published = [];
  const queue = new QueueService({ publish: message => published.push(message) });
  queue.projectRuntimeSnapshot(runtimeSnapshot(), { publish: false });
  queue.publishSnapshot({ overlayNarrations: [{ url: '/voice.mp3' }] });
  assert.equal(published.length, 1);
  assert.equal(published[0].queue[1].song_id, 'two');
  assert.deepEqual(published[0].overlayNarrations, [{ url: '/voice.mp3' }]);
});

test('a runtime queue item projects as a track with its media fields', () => {
  const service = new QueueService({ publish: () => {} });
  service.projectRuntimeSnapshot({ version: 1, currentIndex: 0, phase: 'playing',
    queue: [{ queueItemId: 'q1', songId: 's1', title: 'T', artist: 'A', url: '/a.mp3', programId: 'p', requestId: 'r' }] },
  { publish: false });
  const item = service.snapshot().queue[0];
  assert.equal(item.kind, 'track');
  assert.equal(item.song_id, 's1');
  assert.equal(item.url, '/a.mp3');
});
