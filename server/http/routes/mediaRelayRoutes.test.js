import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import { REMOTE_AUDIO_PREFIX, remoteAudioUrl } from '../../media/remoteAudioProxy.js';
import { registerMediaRelayRoutes } from './mediaRelayRoutes.js';

const AUDIO = Buffer.from('fLaC-relay-route-bytes', 'latin1');

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

test('the relay route serves same-origin playback paths through the injected resolver', async () => {
  const upstream = await listen((_req, res) => {
    res.setHeader('content-type', 'audio/flac');
    res.setHeader('content-length', String(AUDIO.length));
    res.end(AUDIO);
  });
  const app = express();
  const proxy = registerMediaRelayRoutes(app, {
    // 服务端直链带凭据；它只出现在服务端，不进交给播放器的地址。
    resolveAudioDirectUrl: async () => `${upstream.base}/track.flac?vkey=SECRET`,
  });
  assert.ok(proxy);
  const origin = await listen(app);
  try {
    const response = await fetch(`${origin.base}${remoteAudioUrl('qq', 'song-1')}`);
    assert.equal(response.status, 200);
    assert.equal(Buffer.from(await response.arrayBuffer()).toString('latin1'), AUDIO.toString('latin1'));
    const unknown = await fetch(`${origin.base}${REMOTE_AUDIO_PREFIX}junk.mp3`);
    assert.equal(unknown.status, 404);
  } finally {
    await origin.close();
    await upstream.close();
  }
});

test('without an injected resolver the relay route stays unmounted', () => {
  const app = express();
  assert.equal(registerMediaRelayRoutes(app, {}), null);
});
