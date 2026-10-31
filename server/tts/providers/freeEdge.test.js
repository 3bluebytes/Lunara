// 免费声音（Edge 朗读）协议：用假 WebSocket 与 fetch 锁住鉴权、消息格式、取音频与失败报告，不连真实网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const {
  secMsGecV2, synthesisUrl, buildSsml, audioOfFrame, splitSegments,
  createFreeEdgeProvider, FREE_EDGE_PROVIDER_ID, freeEdgeVoiceName,
} = await import('./freeEdge.js');

/** 假 WebSocket：记录 URL、头和发出的消息；script(ws) 决定服务端怎么回。 */
function fakeSocketClass(script) {
  const sockets = [];
  class FakeSocket extends EventEmitter {
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      setImmediate(() => script(this));
    }
    send(message) { this.sent.push(message); this.emit('sent', message); }
    close() { this.closed = true; }
    terminate() { this.closed = true; }
  }
  return { FakeSocket, sockets };
}

function frame(audio, header = 'Path:audio\r\n') {
  const head = Buffer.from(header);
  const out = Buffer.alloc(2 + head.length + audio.length);
  out.writeUInt16BE(head.length, 0);
  head.copy(out, 2);
  Buffer.from(audio).copy(out, 2 + head.length);
  return out;
}

/** 正常服务端：收到 SSML 后回两帧音频再 turn.end。 */
const happyServer = ws => {
  ws.on('sent', message => {
    if (!String(message).includes('Path:ssml')) return;
    ws.emit('message', frame(Buffer.from([0xff, 0xf3, 1])), true);
    ws.emit('message', frame(Buffer.from([0xff, 0xf3, 2])), true);
    ws.emit('message', Buffer.from('X-RequestId:1\r\nPath:turn.end\r\n\r\n{}'), false);
  });
  ws.emit('open');
};

test('Sec-MS-GEC v2：同一 5 分钟窗口结果稳定，跨窗口变化，格式是 CS64-SHA256', () => {
  const t = 1761523200;
  assert.equal(secMsGecV2(t), 'B1A431712251EE31-037D81057342013AD2B52871BC99A86B232A9D24B95B41113B2ECCDF3F0323B1');
  assert.equal(secMsGecV2(t + 299), secMsGecV2(t));
  assert.notEqual(secMsGecV2(t + 300), secMsGecV2(t));
  assert.match(secMsGecV2(t), /^[0-9A-F]{16}-[0-9A-F]{64}$/);
  const url = synthesisUrl({ now: t * 1000, connectionId: 'abc' });
  assert.match(url, /^wss:\/\/speech\.platform\.bing\.com\/.+\?TrustedClientToken=[0-9A-F]{32}&Sec-MS-GEC=B1A4[0-9A-F-]+&Sec-MS-GEC-Version=2-[\d.]+&ConnectionId=abc$/);
});

test('SSML 转义文本、按声音推出语言', () => {
  const ssml = buildSsml('a<b & "c" \'d\'', { voice: 'zh-CN-YunxiNeural', rate: '-15%' });
  assert.match(ssml, /xml:lang='zh-CN'/);
  assert.match(ssml, /<voice name='zh-CN-YunxiNeural'>/);
  assert.match(ssml, /rate='-15%'/);
  assert.match(ssml, /a&lt;b &amp; &quot;c&quot; &apos;d&apos;/);
});

test('二进制帧去掉头部取音频；头长度越界返回 null', () => {
  assert.deepEqual([...audioOfFrame(frame(Buffer.from([1, 2, 3])))], [1, 2, 3]);
  const broken = Buffer.from([0x00, 0x50, 1, 2]);
  assert.equal(audioOfFrame(broken), null);
});

test('长文本按句切段，每段不超过上限', () => {
  const text = '第一句话。'.repeat(300);
  const segments = splitSegments(text, 100);
  assert.ok(segments.length > 1);
  assert.ok(segments.every(segment => segment.length <= 100));
  assert.equal(segments.join(''), text);
  assert.deepEqual(splitSegments('没有标点的一整段'.repeat(30), 50).map(s => s.length <= 50), Array(Math.ceil(240 / 50)).fill(true));
});

test('合成：先发 speech.config 再发 SSML，拼接音频帧，收到 turn.end 结束', async () => {
  const { FakeSocket, sockets } = fakeSocketClass(happyServer);
  const provider = createFreeEdgeProvider({ WebSocketImpl: FakeSocket });
  const audio = await provider.synth('晚上好。', { voiceRef: 'zh-CN-XiaoxiaoNeural' });
  assert.equal(audio.extension, 'mp3');
  assert.equal(audio.source, FREE_EDGE_PROVIDER_ID);
  assert.deepEqual([...audio.bytes], [0xff, 0xf3, 1, 0xff, 0xf3, 2]);
  const [ws] = sockets;
  assert.match(ws.sent[0], /Path:speech\.config/);
  assert.match(ws.sent[0], /audio-24khz-48kbitrate-mono-mp3/);
  assert.match(ws.sent[1], /Path:ssml/);
  assert.match(ws.sent[1], /晚上好。/);
  assert.equal(ws.options.headers.Origin, 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold');
  assert.equal(ws.closed, true);
});

test('长文本逐段合成后拼接', async () => {
  const { FakeSocket, sockets } = fakeSocketClass(happyServer);
  const provider = createFreeEdgeProvider({ WebSocketImpl: FakeSocket });
  const audio = await provider.synth('很长的一句话。'.repeat(200), { voiceRef: 'zh-CN-XiaoxiaoNeural' });
  assert.ok(sockets.length > 1);
  assert.equal(audio.bytes.length, sockets.length * 6);
});

test('握手被拒（403）如实报出，不重试', async () => {
  const { FakeSocket, sockets } = fakeSocketClass(ws => ws.emit('unexpected-response', {}, { statusCode: 403 }));
  const provider = createFreeEdgeProvider({ WebSocketImpl: FakeSocket });
  await assert.rejects(provider.synth('你好', { voiceRef: 'zh-CN-XiaoxiaoNeural' }), error => {
    assert.equal(error.providerId, FREE_EDGE_PROVIDER_ID);
    assert.match(error.message, /免费声音暂时不可用（HTTP 403）/);
    return true;
  });
  assert.equal(sockets.length, 1);
});

test('迟迟不回 turn.end 时按超时失败', async () => {
  const { FakeSocket } = fakeSocketClass(ws => ws.emit('open'));
  const provider = createFreeEdgeProvider({ WebSocketImpl: FakeSocket, timeoutMs: 20 });
  await assert.rejects(provider.synth('你好', { voiceRef: 'zh-CN-XiaoxiaoNeural' }), error => error.code === 'TTS_TIMEOUT');
});

test('调用方取消立即中止连接', async () => {
  const { FakeSocket, sockets } = fakeSocketClass(ws => ws.emit('open'));
  const provider = createFreeEdgeProvider({ WebSocketImpl: FakeSocket });
  const controller = new AbortController();
  const pending = provider.synth('你好', { voiceRef: 'zh-CN-XiaoxiaoNeural', signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(sockets[0].closed, true);
});

test('不合法的 voice id 不发起连接', async () => {
  const { FakeSocket, sockets } = fakeSocketClass(happyServer);
  const provider = createFreeEdgeProvider({ WebSocketImpl: FakeSocket });
  await assert.rejects(provider.synth('你好', { voiceRef: "x' onload='" }));
  assert.equal(sockets.length, 0);
});

test('表演：只把语速映射成 prosody rate，其他标记剥掉', () => {
  const provider = createFreeEdgeProvider();
  const rendered = provider.renderPerformance('{叹气}晚了。{停顿:0.6}听首歌吧。', { emotion: 'sad', pace: 'slow' });
  assert.equal(rendered.text.includes('{'), false);
  assert.deepEqual(rendered.native, { rate: '-15%' });
  assert.deepEqual(provider.renderPerformance('你好。', null).native, {});
  assert.equal(provider.performanceCapability().pace, true);
  assert.equal(provider.performanceCapability().pauses, false);
});

test('声音列表：中文在前、带中文名，缓存 24 小时', async () => {
  let calls = 0;
  const rows = [
    { ShortName: 'en-US-AriaNeural', Locale: 'en-US', Gender: 'Female' },
    { ShortName: 'zh-TW-HsiaoChenNeural', Locale: 'zh-TW', Gender: 'Female' },
    { ShortName: 'zh-CN-YunxiNeural', Locale: 'zh-CN', Gender: 'Male' },
    { ShortName: 'bad id', Locale: 'zh-CN' },
  ];
  let clock = 0;
  const provider = createFreeEdgeProvider({
    now: () => clock,
    fetchImpl: async () => { calls += 1; return { ok: true, status: 200, json: async () => rows }; },
  });
  const voices = await provider.fetchVoices();
  assert.deepEqual(voices.map(voice => voice.id), ['zh-CN-YunxiNeural', 'zh-TW-HsiaoChenNeural', 'en-US-AriaNeural']);
  assert.equal(voices[0].name, '云希');
  await provider.fetchVoices();
  assert.equal(calls, 1);
  clock = 25 * 60 * 60 * 1000;
  await provider.fetchVoices();
  assert.equal(calls, 2);
  assert.equal(freeEdgeVoiceName('zh-CN-XiaoxiaoNeural'), '晓晓');
});

test('只参与显式指定，listVoices 返回声音池里的免费声音', () => {
  const provider = createFreeEdgeProvider({ keptVoices: () => [{ sourceVoiceId: 'zh-CN-YunxiNeural', displayName: '云希' }] });
  assert.equal(provider.explicitOnly, true);
  assert.deepEqual(provider.listVoices(), [{ id: 'zh-CN-YunxiNeural', name: '云希' }]);
});
