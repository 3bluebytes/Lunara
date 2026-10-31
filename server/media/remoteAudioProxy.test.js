// remoteAudioProxy.test.js — 同源中继的传输契约。
//
// 真实 http 服务器跑 handler，上游用 Response 替身：验证路径推导、Range 透传、
// 直链过期重取、未知身份不查供应商。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  createRemoteAudioProxy, parseRemoteAudioToken, remoteAudioUrl, REMOTE_AUDIO_PREFIX,
} from './remoteAudioProxy.js';

const AUDIO = Buffer.from('fLaC-fake-media-bytes-for-relay-tests', 'latin1');

function listen(handler) {
  const server = createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

/** 把中继 handler 挂到一个真实端口上，返回 base 地址。 */
async function serveProxy(proxy) {
  return listen((req, res) => {
    const token = String(req.url || '').split('/').pop();
    req.params = { token };
    return proxy.handler(req, res);
  });
}

function audioResponse({ status = 200, bytes = AUDIO, headers = {} } = {}) {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'audio/flac', 'content-length': String(bytes.length), 'accept-ranges': 'bytes', ...headers },
  });
}

test('relay path is derived from canonical identity and carries no credentials', () => {
  const url = remoteAudioUrl('QQ', ' 001kjzAW2maqhO ');
  assert.ok(url.startsWith(REMOTE_AUDIO_PREFIX));
  assert.ok(url.endsWith('.mp3'));
  assert.deepEqual(parseRemoteAudioToken(url.slice(REMOTE_AUDIO_PREFIX.length)), { provider: 'qq', songId: '001kjzAW2maqhO' });
  // 路径里不能出现供应商、主机名或凭据字段。
  assert.doesNotMatch(url, /aqqmusic|vkey|uin=|http|qq\.com/i);
  assert.equal(parseRemoteAudioToken('not-a-token'), null);
  assert.equal(parseRemoteAudioToken(''), null);
  assert.equal(parseRemoteAudioToken(Buffer.from('no-separator').toString('base64url')), null);
  assert.equal(parseRemoteAudioToken(Buffer.from(':missing-provider').toString('base64url')), null);
});

test('relay streams the media with the upstream status and headers', async () => {
  const proxy = createRemoteAudioProxy({ resolveUrl: async () => 'https://provider.test/x.flac' , fetchImpl: async () => audioResponse() });
  const origin = await serveProxy(proxy);
  try {
    const response = await fetch(`${origin.base}${remoteAudioUrl('qq', 'song-a')}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/flac');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('latin1'), AUDIO.toString('latin1'));
  } finally {
    await origin.close();
  }
});

test('relay forwards byte ranges so seeking behaves like the direct resource', async () => {
  const seen = [];
  const proxy = createRemoteAudioProxy({
    resolveUrl: async () => 'https://provider.test/x.flac',
    fetchImpl: async (_url, init) => {
      seen.push(init.headers);
      const slice = AUDIO.subarray(10, 20);
      return new Response(slice, {
        status: 206,
        headers: {
          'content-type': 'audio/flac',
          'accept-ranges': 'bytes',
          'content-range': `bytes 10-19/${AUDIO.length}`,
          'content-length': String(slice.length),
        },
      });
    },
  });
  const origin = await serveProxy(proxy);
  try {
    const response = await fetch(`${origin.base}${remoteAudioUrl('qq', 'song-b')}`, { headers: { range: 'bytes=10-19' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes 10-19/${AUDIO.length}`);
    assert.equal(seen[0].range, 'bytes=10-19');
    assert.equal(Buffer.from(await response.arrayBuffer()).length, 10);
  } finally {
    await origin.close();
  }
});

test('an unknown identity is refused without asking any provider', async () => {
  let resolved = 0;
  const proxy = createRemoteAudioProxy({
    resolveUrl: async () => { resolved += 1; return 'https://provider.test/x.flac'; },
    fetchImpl: async () => audioResponse(),
  });
  const origin = await serveProxy(proxy);
  try {
    const response = await fetch(`${origin.base}${REMOTE_AUDIO_PREFIX}not-a-token.mp3`);
    assert.equal(response.status, 404);
    assert.equal(resolved, 0);
  } finally {
    await origin.close();
  }
});

test('the direct url is remembered per identity and can be refreshed when it expires', async () => {
  let resolved = 0;
  const fetches = [];
  const proxy = createRemoteAudioProxy({
    resolveUrl: async () => { resolved += 1; return `https://provider.test/x.flac?token=${resolved}`; },
    fetchImpl: async (url) => {
      fetches.push(url);
      // 第一条直链过期（403），重取之后才可播。
      return fetches.length === 1 ? audioResponse({ status: 403, bytes: Buffer.from('gone') }) : audioResponse();
    },
  });
  const origin = await serveProxy(proxy);
  try {
    const first = await fetch(`${origin.base}${remoteAudioUrl('qq', 'song-c')}`);
    assert.equal(first.status, 200, '过期直链要重取一次后才失败');
    assert.equal(resolved, 2);
    const second = await fetch(`${origin.base}${remoteAudioUrl('qq', 'song-c')}`);
    assert.equal(second.status, 200);
    assert.equal(resolved, 2, '同一身份在 TTL 内命中记忆，不重复调用供应商');
  } finally {
    await origin.close();
  }
});

test('an unresolvable identity answers 404 instead of a broken stream', async () => {
  const proxy = createRemoteAudioProxy({ resolveUrl: async () => null, fetchImpl: async () => audioResponse() });
  const origin = await serveProxy(proxy);
  try {
    const response = await fetch(`${origin.base}${remoteAudioUrl('qq', 'song-d')}`);
    assert.equal(response.status, 404);
  } finally {
    await origin.close();
  }
});

test('a transport failure upstream answers 502 and records no direct url', async () => {
  const events = [];
  const proxy = createRemoteAudioProxy({
    resolveUrl: async () => 'https://provider.test/x.flac?vkey=SECRET',
    fetchImpl: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); },
    trace: event => events.push(event),
  });
  const origin = await serveProxy(proxy);
  try {
    const response = await fetch(`${origin.base}${remoteAudioUrl('qq', 'song-e')}`);
    assert.equal(response.status, 502);
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /SECRET|vkey/, '诊断事件不得回显直链');
    assert.equal(events.at(-1).event, 'media-relay-upstream-failed');
  } finally {
    await origin.close();
  }
});
