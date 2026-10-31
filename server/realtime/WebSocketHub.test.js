import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { WebSocketHub } from './WebSocketHub.js';
import { EventEmitter } from 'node:events';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function collectMessages(ws, count) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} websocket messages`)), 2_000);
    ws.on('message', data => {
      messages.push(JSON.parse(String(data)));
      if (messages.length === count) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
    ws.on('error', reject);
  });
}

test('connection receives hello then authoritative queue snapshot', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const hub = new WebSocketHub({
    hello: () => ({ type: 'hello', name: 'Lunara', orchestrator: false }),
    queueSnapshot: () => ({ queue: [{ song_id: 'a' }], cursor: 0 }),
  });
  hub.attach(server);
  const address = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/stream`);

  try {
    const messages = await collectMessages(ws, 2);
    assert.deepEqual(messages, [
      { type: 'hello', name: 'Lunara', orchestrator: false },
      { type: 'queue-update', queue: [{ song_id: 'a' }], cursor: 0 },
    ]);
    assert.equal(hub.clientCount, 1);
  } finally {
    ws.close();
    await hub.close();
    await closeServer(server);
  }
});

// ---- 本地边界（fix-release-blocking-defects）：upgrade 必须满足与 HTTP 相同的 Host/Origin 规则 ----

/** 开一个带 localBoundary 的 hub，并在用例结束后清理。 */
async function withBoundaryHub(t, { bindHost = '127.0.0.1' } = {}) {
  const server = createServer((_req, res) => res.end('ok'));
  const hub = new WebSocketHub({
    hello: () => ({ type: 'hello', name: 'Lunara' }),
    queueSnapshot: () => ({ queue: [], cursor: -1 }),
    localBoundary: { bindHost: () => bindHost },
  });
  hub.attach(server);
  const address = await listen(server);
  t.after(async () => { await hub.close(); await closeServer(server); });
  return { server, hub, port: address.port };
}

/** 用指定 headers 尝试握手；messages 非空即证明对方拿到了广播。 */
function tryHandshake(port, headers) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`, { headers });
    const messages = [];
    const finish = opened => {
      try { ws.terminate(); } catch { /* already closed */ }
      resolve({ opened, messages });
    };
    const timer = setTimeout(() => finish(false), 2_000);
    ws.on('message', data => {
      messages.push(JSON.parse(String(data)));
      if (messages.length === 2) { clearTimeout(timer); finish(true); }
    });
    ws.on('error', () => { clearTimeout(timer); finish(false); });
    ws.on('close', () => { clearTimeout(timer); finish(false); });
  });
}

test('cross-site origin cannot open the stream and receives no message', async t => {
  const { port } = await withBoundaryHub(t);
  const attempt = await tryHandshake(port, { Origin: 'https://outside.invalid' });
  assert.equal(attempt.opened, false, '外部 Origin 不得建立连接');
  assert.equal(attempt.messages.length, 0, '拒绝必须发生在任何消息之前');
});

test('another loopback page with a different port is rejected', async t => {
  const { port } = await withBoundaryHub(t);
  const attempt = await tryHandshake(port, { Origin: `http://127.0.0.1:${port + 1}` });
  assert.equal(attempt.opened, false);
  assert.equal(attempt.messages.length, 0);
});

test('opaque null origin is rejected', async t => {
  const { port } = await withBoundaryHub(t);
  const attempt = await tryHandshake(port, { Origin: 'null' });
  assert.equal(attempt.opened, false);
  assert.equal(attempt.messages.length, 0);
});

test('foreign Host is rejected regardless of origin', async t => {
  const { port } = await withBoundaryHub(t);
  const attempt = await tryHandshake(port, { Host: 'rebound.example', Origin: 'https://outside.invalid' });
  assert.equal(attempt.opened, false);
  assert.equal(attempt.messages.length, 0);
});

test('the application client with a matching origin still connects', async t => {
  const { port, hub } = await withBoundaryHub(t);
  const attempt = await tryHandshake(port, { Origin: `http://127.0.0.1:${port}` });
  assert.equal(attempt.opened, true, '同源握手必须照旧可用');
  assert.equal(attempt.messages.length, 2);
  assert.equal(hub.lastRejection, null);
});

test('a non-browser local client without Origin connects using a loopback Host', async t => {
  const { port } = await withBoundaryHub(t);
  const attempt = await tryHandshake(port, { Host: `127.0.0.1:${port}` });
  assert.equal(attempt.opened, true, '本机进程本来就能直接读库，不增加暴露面');
});

test('a rejection is diagnosable and the server keeps serving', async t => {
  const { port, hub } = await withBoundaryHub(t);
  await tryHandshake(port, { Origin: 'https://outside.invalid' });
  assert.ok(hub.lastRejection && /origin|host/i.test(hub.lastRejection), '拒绝原因可诊断');
  const accepted = await tryHandshake(port, { Origin: `http://127.0.0.1:${port}` });
  assert.equal(accepted.opened, true, '拒绝不影响其他客户端');
});

test('no boundary configured keeps the previous behaviour', async t => {
  const server = createServer((_req, res) => res.end('ok'));
  const hub = new WebSocketHub({ hello: () => ({ type: 'hello', name: 'Lunara' }) });
  hub.attach(server);
  const address = await listen(server);
  t.after(async () => { await hub.close(); await closeServer(server); });
  const attempt = await tryHandshake(address.port, { Origin: 'https://outside.invalid' });
  assert.equal(attempt.opened, true, '未配置 localBoundary 时保持既有行为');
});

test('broadcast reaches connected clients and close releases the hub', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const hub = new WebSocketHub({
    hello: () => ({ type: 'hello', name: 'Lunara' }),
    queueSnapshot: () => ({ queue: [], cursor: -1 }),
  });
  hub.attach(server);
  const address = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/stream`);
  await collectMessages(ws, 2);

  const nextMessage = collectMessages(ws, 1);
  assert.equal(hub.broadcast({ type: 'thinking', active: true }), 1);
  assert.deepEqual(await nextMessage, [{ type: 'thinking', active: true }]);

  await hub.close();
  assert.equal(hub.clientCount, 0);
  assert.equal(hub.attached, false);
  await closeServer(server);
});

test('websocket server errors are owned by the hub instead of crashing the process', async () => {
  class FakeWebSocketServer extends EventEmitter {
    close(callback) { callback(); }
  }
  const errors = [];
  const server = new EventEmitter();
  const hub = new WebSocketHub({
    WebSocketServerClass: FakeWebSocketServer,
    onError: error => errors.push(error),
  });

  hub.attach(server);
  const failure = new Error('listen EPERM');
  assert.doesNotThrow(() => hub.wss.emit('error', failure));
  assert.equal(hub.lastError, failure);
  assert.deepEqual(errors, [failure]);
  await hub.close();
});

test('reconnect receives runtime snapshot followed by only the resumable phase command', async () => {
  class FakeWebSocketServer extends EventEmitter {
    close(callback) { callback(); }
  }
  const server = new EventEmitter();
  const snapshot = { version: 9, phase: 'speaking', txn: { correlationId: 'runtime-1-one' } };
  const resume = { type: 'PLAY_TTS', runtimeVersion: 9, correlationId: 'runtime-1-one', songId: 'one' };
  const hub = new WebSocketHub({
    WebSocketServerClass: FakeWebSocketServer,
    runtimeSnapshot: () => snapshot,
    runtimeCommands: received => received === snapshot ? [resume] : [],
  });
  hub.attach(server);
  const messages = [];
  const ws = {
    readyState: WebSocket.OPEN,
    once() {},
    send: raw => messages.push(JSON.parse(raw)),
  };

  hub.wss.emit('connection', ws);
  assert.deepEqual(messages.slice(-2), [
    { type: 'runtime-state', state: snapshot },
    { type: 'runtime-command', command: resume },
  ]);
  await hub.close();
});

test('client count listeners hear connects and disconnects; a throwing listener does not break the hub', async () => {
  const server = createServer((_req, res) => res.end('ok'));
  const hub = new WebSocketHub({ hello: () => ({ type: 'hello', name: 'Lunara' }), queueSnapshot: () => ({ queue: [], cursor: -1 }) });
  const counts = [];
  hub.onClientsChanged(() => { throw new Error('listener boom'); });
  const off = hub.onClientsChanged(count => counts.push(count));
  hub.attach(server);
  const address = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/stream`);
  try {
    await collectMessages(ws, 2);
    assert.deepEqual(counts, [1]);
    const closed = new Promise(resolve => {
      const poll = setInterval(() => { if (hub.clientCount === 0) { clearInterval(poll); resolve(); } }, 5);
    });
    ws.close();
    await closed;
    assert.deepEqual(counts, [1, 0]);
    off();
  } finally {
    await hub.close();
    await closeServer(server);
  }
});

test('client presence: per-connection visibility and typing are summarised; silent clients count as visible; junk is ignored', async () => {
  class FakeWebSocketServer extends EventEmitter {
    close(callback) { callback(); }
  }
  const hub = new WebSocketHub({ WebSocketServerClass: FakeWebSocketServer });
  hub.attach(new EventEmitter());
  const summaries = [];
  hub.onPresenceChanged(() => { throw new Error('listener boom'); });
  hub.onPresenceChanged(summary => summaries.push(summary));
  const socket = () => Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send() {} });
  const a = socket();
  const b = socket();
  hub.wss.emit('connection', a);
  assert.deepEqual(hub.presenceSummary(), { connected: 1, visible: 1, typing: false }, '没上报过的旧客户端按可见处理');
  a.emit('message', Buffer.from(JSON.stringify({ type: 'client-presence', visible: false, typing: false })));
  hub.wss.emit('connection', b);
  b.emit('message', JSON.stringify({ type: 'client-presence', visible: true, typing: true }));
  a.emit('message', 'not json');
  a.emit('message', JSON.stringify({ type: 'client-presence', visible: 'yes' }));
  a.emit('message', JSON.stringify({ type: 'something-else', visible: true }));
  assert.deepEqual(hub.presenceSummary(), { connected: 2, visible: 1, typing: true });
  b.emit('close');
  assert.deepEqual(summaries, [
    { connected: 1, visible: 1, typing: false },
    { connected: 1, visible: 0, typing: false },
    { connected: 2, visible: 1, typing: false },
    { connected: 2, visible: 1, typing: true },
    { connected: 1, visible: 0, typing: false },
  ]);
  await hub.close();
});
