import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppState } from './appState.js';
import { createWsClient } from './wsClient.js';

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

test('ws client reduces authoritative state once and forwards the same message to feature listeners', () => {
  FakeSocket.instances = [];
  const store = createAppState({ queue: [], cursor: -1 });
  const messages = [];
  const client = createWsClient({
    store,
    WebSocketImpl: FakeSocket,
    location: { protocol: 'http:', host: 'localhost:8080' },
    onMessage: message => messages.push(message),
  });
  client.connect();
  FakeSocket.instances[0].message({
    type: 'queue-update',
    queue: [{ kind: 'track', song_id: 's1' }],
    cursor: 0,
  });
  assert.equal(store.getState().queue[0].song_id, 's1');
  assert.equal(messages.length, 1);
  assert.equal(client.getSocket(), FakeSocket.instances[0]);
  client.destroy();
});

test('compatibility chat metadata is forwarded without replacing runtime playback', () => {
  FakeSocket.instances = [];
  const store = createAppState();
  const messages = [];
  const client = createWsClient({ store, WebSocketImpl: FakeSocket,
    location: { protocol: 'http:', host: 'localhost:8080' }, onMessage: message => messages.push(message) });
  try {
    const socket = client.connect();
    socket.message({ type: 'runtime-state', state: { version: 2,
      currentIndex: 0, queue: [{ queueItemId: 'jp', songId: 'jp' }] } });
    const presentation = { type: 'queue-update', runtimeVersion: 3,
      queue: [{ kind: 'track', song_id: 'cn' }], cursor: 0,
      messages: [{ say: '照常呈现', sourceTurnId: 'intro:jp' }] };
    socket.message(presentation);
    assert.equal(store.getState().queue[0].song_id, 'jp');
    assert.deepEqual(messages.at(-1), presentation);
  } finally { client.destroy(); }
});

test('connect is idempotent and destroy prevents reconnect leakage', () => {
  FakeSocket.instances = [];
  const scheduled = [];
  const cancelled = [];
  const client = createWsClient({
    store: createAppState(),
    WebSocketImpl: FakeSocket,
    location: { protocol: 'https:', host: 'radio.local' },
    schedule: fn => { scheduled.push(fn); return scheduled.length; },
    cancelSchedule: id => cancelled.push(id),
  });
  const first = client.connect();
  assert.strictEqual(client.connect(), first);
  assert.equal(first.url, 'wss://radio.local/stream');
  first.onclose();
  assert.equal(scheduled.length, 1);
  client.destroy();
  assert.deepEqual(cancelled, [1]);
  scheduled[0]();
  assert.equal(FakeSocket.instances.length, 1);
});
