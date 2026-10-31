import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { WebSocketHub } from '../realtime/WebSocketHub.js';
import { createSourceHealthWiring } from './createSourceHealthWiring.js';
import { resetSourceHealthReporter } from '../music/sourceHealthSignal.js';
import { createQqMusicProvider } from '../qq.js';
import { createMusicResolver } from '../musicResolver.js';
import { isConfirmedUnplayable } from '../program/unplayableTrackMemory.js';

function nextMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('fixture websocket timeout')); }, 2000);
    const receive = data => {
      const value = JSON.parse(String(data));
      if (!predicate(value)) return;
      cleanup(); resolve(value);
    };
    const fail = error => { cleanup(); reject(error); };
    function cleanup() { clearTimeout(timer); ws.off('message', receive); ws.off('error', fail); }
    ws.on('message', receive); ws.on('error', fail);
  });
}

test('canonical QQ auth rejection reaches WS, survives reconnect, and clears only after verified login', async t => {
  const health = createSourceHealthWiring();
  const server = createServer((_req, res) => res.end('fixture'));
  const hub = new WebSocketHub({ hello: () => ({ type: 'hello', sourceIssues: health.sourceIssues() }) });
  const unsubscribe = health.subscribe(message => hub.broadcast(message));
  hub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { unsubscribe(); resetSourceHealthReporter(); await hub.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `ws://127.0.0.1:${server.address().port}/stream`;
  const ws = new WebSocket(url);
  await nextMessage(ws, message => message.type === 'hello');
  const notification = nextMessage(ws, message => message.type === 'music-source-status');
  const qq = createQqMusicProvider({ getCookieValue: () => 'uin=42; qqmusic_key=fixture-secret',
    playApi: async () => ({ status: 401, body: { message: 'fixture raw error must not cross the boundary' } }),
    lyricApi: async () => ({ status: 200, body: { response: { lyric: '' } } }),
  });
  const resolve = createMusicResolver({ providers: { qq }, findRememberedIdentity: () => null,
    maybeAutoTag() {}, trace() {}, getSourcePolicy: () => ({ mode: 'multi', sources: ['qq', 'ncm'] }) });
  const result = await resolve('fixture', { candidate: { sourceSongId: 'fixture-mid', evidence: { source: 'qq' },
    orderedTarget: { title: 'fixture', artist: 'fixture' } } });
  assert.equal(result.code, 'requires-auth');
  assert.equal(isConfirmedUnplayable(result), false);
  const event = await notification;
  assert.deepEqual(event, { type: 'music-source-status', source: 'qq', displayName: 'QQ 音乐', code: 'requires-auth' });
  assert.doesNotMatch(JSON.stringify(event), /fixture-secret|raw error|uin/);
  ws.close();
  const reconnected = new WebSocket(url);
  const hello = await nextMessage(reconnected, message => message.type === 'hello');
  assert.deepEqual(hello.sourceIssues, [{ source: 'qq', displayName: 'QQ 音乐', code: 'requires-auth' }]);
  health.recordSuccess('qq');
  assert.equal(health.authFailures().length, 1, 'a public resource success cannot verify an account');
  const recovery = nextMessage(reconnected, message => message.type === 'music-source-status');
  health.recordAuthenticated('qq');
  assert.deepEqual(await recovery, { type: 'music-source-status', source: 'qq', displayName: 'QQ 音乐', code: null });
  assert.deepEqual(health.authFailures(), []);
});
