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
