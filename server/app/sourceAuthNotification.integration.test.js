import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { WebSocketHub } from '../realtime/WebSocketHub.js';
import { createSourceHealthWiring } from './createSourceHealthWiring.js';
import { beginSourceHealthAttempt, resetSourceHealthReporter } from '../music/sourceHealthSignal.js';
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

test('an attempt started before a rate-limited failure cannot clear the warning, but a later attempt can', async t => {
  const health = createSourceHealthWiring();
  const events = [];
  const server = createServer((_req, res) => res.end('fixture'));
  const hub = new WebSocketHub({ hello: () => ({ type: 'hello', sourceIssues: health.sourceIssues() }) });
  const unsubscribeBroadcast = health.subscribe(message => hub.broadcast(message));
  const unsubscribeEvents = health.subscribe(message => events.push(message));
  hub.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    unsubscribeBroadcast(); unsubscribeEvents(); resetSourceHealthReporter();
    await hub.close(); await new Promise(resolve => server.close(resolve));
  });
  const url = `ws://127.0.0.1:${server.address().port}/stream`;
  const ws = new WebSocket(url);
  await nextMessage(ws, message => message.type === 'hello');

  // 解析尝试先开始，随后同一源才出现可行动故障：这次成功回调已跨代次，不能恢复。
  const staleSuccess = beginSourceHealthAttempt('ncm');
  const warned = nextMessage(ws, message => message.type === 'music-source-status');
  health.recordFailure('ncm', 'rate-limited');
  assert.deepEqual(await warned, { type: 'music-source-status', source: 'ncm', displayName: '网易云音乐', code: 'rate-limited' });
  assert.equal(events.filter(event => event.source === 'ncm').length, 1, 'one actionable failure produces one warning');
  staleSuccess();
  assert.equal(events.some(event => event.source === 'ncm' && event.code === null), false,
    'an attempt from before the failure generation cannot emit recovery');

  // 重连 hello 直接读取当前派生状态：旧回调没有把 rate-limited 清掉。
  ws.close();
  const reconnected = new WebSocket(url);
  const hello = await nextMessage(reconnected, message => message.type === 'hello');
  assert.deepEqual(hello.sourceIssues, [{ source: 'ncm', displayName: '网易云音乐', code: 'rate-limited' }]);

  // 最新故障之后才开始并完成的尝试，才是真正的恢复信号。
  const recovery = nextMessage(reconnected, message => message.type === 'music-source-status');
  const freshSuccess = beginSourceHealthAttempt('ncm');
  freshSuccess();
  assert.deepEqual(await recovery, { type: 'music-source-status', source: 'ncm', displayName: '网易云音乐', code: null });
  assert.deepEqual(health.sourceIssues(), []);
  assert.equal(events.filter(event => event.source === 'ncm' && event.code === null).length, 1,
    'only the post-failure attempt emits a single recovery');
  reconnected.close();
});
