import assert from 'node:assert/strict';
import test from 'node:test';

import { createNarrationCoordinator } from './narrationCoordinator.js';

class FakeAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.error = null;
    this.playCalls = [];
    this.listeners = new Map();
    this.deferredPlay = null;
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  pause() { this.paused = true; }

  play() {
    this.paused = false;
    this.playCalls.push(this.src);
    return this.deferredPlay || Promise.resolve();
  }

  emit(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type, currentTarget: this });
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('foreground reply finishes before an already queued runtime track introduction', async () => {
  const audio = new FakeAudio();
  const events = [];
  const coordinator = createNarrationCoordinator({ audio, locationHref: 'http://localhost/' }).init();
  coordinator.beginForegroundTurn('chat-1');

  coordinator.enqueue({
    id: 'runtime-intro', lane: 'runtime', url: '/track-intro.mp3',
    onStart: () => events.push('intro:start'),
    onFinish: () => events.push('intro:finish'),
  });
  await settle();
  assert.deepEqual(audio.playCalls, [], 'runtime intro waits while the foreground turn is unresolved');

  coordinator.enqueue({
    id: 'chat-reply', lane: 'foreground', url: '/chat-reply.mp3',
    onStart: () => events.push('chat:start'),
    onFinish: () => {
      events.push('chat:finish');
      coordinator.endForegroundTurn('chat-1');
    },
  });
  await settle();
  assert.deepEqual(audio.playCalls, ['/chat-reply.mp3']);

  audio.emit('ended');
  await settle();
  assert.deepEqual(audio.playCalls, ['/chat-reply.mp3', '/track-intro.mp3']);
  assert.deepEqual(events.slice(0, 3), ['chat:start', 'chat:finish', 'intro:start']);

  audio.emit('ended');
  await settle();
  assert.deepEqual(events, ['chat:start', 'chat:finish', 'intro:start', 'intro:finish']);
  coordinator.destroy();
});

test('only one narration task owns the audio element and a stale ended event cannot finish a starting replacement', async () => {
  const audio = new FakeAudio();
  const events = [];
  const coordinator = createNarrationCoordinator({ audio, locationHref: 'http://localhost/' }).init();

  coordinator.enqueue({
    id: 'old-overlay', lane: 'foreground', url: '/old.mp3',
    onCancel: () => events.push('old:cancel'),
  });
  await settle();

  let releasePlay;
  audio.deferredPlay = new Promise(resolve => { releasePlay = resolve; });
  coordinator.cancel(task => task.id === 'old-overlay', 'superseded');
  coordinator.enqueue({
    id: 'new-intro', lane: 'runtime', url: '/new.mp3',
    onFinish: () => events.push('new:finish'),
  });

  audio.emit('ended');
  assert.deepEqual(events, ['old:cancel'], 'late old-source event is ignored while replacement play is starting');
  releasePlay();
  await settle();
  audio.emit('ended');
  await settle();
  assert.deepEqual(events, ['old:cancel', 'new:finish']);
  coordinator.destroy();
});

test('delayBeforeMs waits after beforeStart before playing, and cancel clears timer without calling audio.play', async () => {
  const audio = new FakeAudio();
  const events = [];
  const scheduled = [];
  let nextHandle = 1;
  const coordinator = createNarrationCoordinator({
    audio,
    locationHref: 'http://localhost/',
    setTimer: (fn, ms) => {
      const entry = { id: nextHandle++, fn, ms, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimer: entry => {
      if (entry) entry.cleared = true;
    },
  }).init();

  coordinator.enqueue({
    id: 'beat-0',
    lane: 'foreground',
    url: '/b0.mp3',
    onStart: () => events.push('b0:start'),
    onFinish: () => events.push('b0:finish'),
  });
  await settle();
  assert.deepEqual(audio.playCalls, ['/b0.mp3']);
  audio.emit('ended');
  await settle();

  coordinator.enqueue({
    id: 'beat-1',
    lane: 'foreground',
    url: '/b1.mp3',
    delayBeforeMs: 650,
    beforeStart: () => { events.push('b1:beforeStart'); return true; },
    onStart: () => events.push('b1:start'),
    onCancel: reason => events.push(`b1:cancel:${reason}`),
  });
  coordinator.enqueue({
    id: 'beat-2',
    lane: 'foreground',
    url: '/b2.mp3',
    onStart: () => events.push('b2:start'),
    onFinish: () => events.push('b2:finish'),
  });
  await settle();

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 650);
  assert.deepEqual(audio.playCalls, ['/b0.mp3'], 'audio.play waits until delayBeforeMs completes');
  assert.deepEqual(events, ['b0:start', 'b0:finish', 'b1:beforeStart']);

  // 取消正在延迟中的 beat-1：立即清理定时器并直接推进到 beat-2
  coordinator.cancel(task => task.id === 'beat-1', 'skip-beat');
  assert.equal(scheduled[0].cleared, true);
  await settle();
  assert.deepEqual(audio.playCalls, ['/b0.mp3', '/b2.mp3']);
  assert.deepEqual(events, ['b0:start', 'b0:finish', 'b1:beforeStart', 'b1:cancel:skip-beat', 'b2:start']);

  // 正常完成 delayBeforeMs 后播放
  coordinator.enqueue({
    id: 'beat-3',
    lane: 'foreground',
    url: '/b3.mp3',
    delayBeforeMs: 420,
    onStart: () => events.push('b3:start'),
  });
  audio.emit('ended');
  await settle();
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[1].ms, 420);
  assert.deepEqual(audio.playCalls, ['/b0.mp3', '/b2.mp3']);
  scheduled[1].fn();
  await settle();
  assert.deepEqual(audio.playCalls, ['/b0.mp3', '/b2.mp3', '/b3.mp3']);
  assert.equal(events.at(-1), 'b3:start');

  // destroy 期间也必须清掉任何 pending delay timer
  coordinator.enqueue({
    id: 'beat-4',
    lane: 'foreground',
    url: '/b4.mp3',
    delayBeforeMs: 900,
    onCancel: reason => events.push(`b4:cancel:${reason}`),
  });
  audio.emit('ended');
  await settle();
  assert.equal(scheduled.length, 3);
  coordinator.destroy();
  assert.equal(scheduled[2].cleared, true);
  assert.equal(events.at(-1), 'b4:cancel:destroyed');
});
