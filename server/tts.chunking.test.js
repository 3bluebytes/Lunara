import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTtsGateway } from './tts.js';
import { TtsProviderRegistry } from './tts/TtsProviderRegistry.js';
import { createTtsAudio, TtsSynthesisError } from './tts/TtsProvider.js';
import { concatMp3Buffers, createMp3SilenceFrames, parseFirstMpegFrame } from './tts/mp3.js';
import { concatWavBuffers, readWavInfo } from './tts/wav.js';
import { createCustomProvider } from './tts/providers/custom.js';

function makePcmWav(sampleCount, { sampleRate = 16000, channels = 1, amplitude = 1200 } = {}) {
  const dataSize = sampleCount * channels * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount * channels; i += 1) {
    const sample = Math.round(amplitude * Math.sin((i % 32) / 32 * Math.PI * 2));
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

function makeFakeMp3(payloadText, { id3v2 = true, id3v1 = true } = {}) {
  const parts = [];
  if (id3v2) {
    const body = Buffer.from('TITLE', 'latin1');
    const hdr = Buffer.alloc(10 + body.length);
    hdr.write('ID3', 0, 'latin1');
    hdr[3] = 3;
    hdr[9] = body.length;
    body.copy(hdr, 10);
    parts.push(hdr);
  }
  parts.push(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  parts.push(Buffer.from(payloadText, 'utf8'));
  if (id3v1) {
    const tag = Buffer.alloc(128);
    tag.write('TAG', 0, 'latin1');
    parts.push(tag);
  }
  return Buffer.concat(parts);
}

test('concatWavBuffers stitches multiple PCM chunks with single canonical header', () => {
  const a = makePcmWav(1600, { sampleRate: 16000 });
  const b = makePcmWav(3200, { sampleRate: 16000 });
  const merged = concatWavBuffers([a, b]);
  const info = readWavInfo(merged.bytes);
  assert.equal(info.sampleRate, 16000);
  assert.equal(info.dataSize, (1600 + 3200) * 2);
  assert.equal(merged.durationMs, 300);

  const mismatched = makePcmWav(800, { sampleRate: 24000 });
  assert.throws(() => concatWavBuffers([a, mismatched]), err => err.code === 'TTS_INCOMPATIBLE_WAV_CHUNKS');
});

test('LONG_SPEECH_THRESHOLD=240 and LONG_SPEECH_CHUNK_LIMIT=220 keep <=240 text in a single synth call', async () => {
  const { LONG_SPEECH_THRESHOLD, LONG_SPEECH_CHUNK_LIMIT } = await import('./tts.js');
  assert.equal(LONG_SPEECH_THRESHOLD, 240);
  assert.equal(LONG_SPEECH_CHUNK_LIMIT, 220);

  const cacheDir = mkdtempSync(join(tmpdir(), 'lunara-tts-single-'));
  try {
    const calls = [];
    const registry = new TtsProviderRegistry({
      providers: [{
        id: 'mock-wav',
        label: 'Mock WAV',
        isConfigured: () => true,
        listVoices: async () => [{ id: 'v1', name: 'V1' }],
        synth: async text => {
          calls.push(text);
          return createTtsAudio({ bytes: makePcmWav(1600), extension: 'wav', source: 'mock-wav', durationMs: 100 });
        },
      }],
    });
    const tts = createTtsGateway({ registry, cacheDir, initialVoice: 'v1' });
    const mediumText = '夜深了，我们继续放一首柔和的爵士乐慢慢聊。'.repeat(7);
    assert.ok([...mediumText].length > 140 && [...mediumText].length <= 240);

    const res = await tts.synth(mediumText);
    assert.equal(calls.length, 1);
    assert.equal(res.extension, 'wav');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('synth splits text > 240 chars sequentially, stitches WAV once, and refreshes mtime on cache hit', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'lunara-tts-chunk-'));
  try {
    const calls = [];
    const registry = new TtsProviderRegistry({
      providers: [{
        id: 'mock-wav',
        label: 'Mock WAV',
        isConfigured: () => true,
        listVoices: async () => [{ id: 'v1', name: 'V1' }],
        synth: async text => {
          calls.push(text);
          return createTtsAudio({ bytes: makePcmWav(1600), extension: 'wav', source: 'mock-wav', durationMs: 100 });
        },
      }],
    });
    const tts = createTtsGateway({ registry, cacheDir, initialVoice: 'v1' });
    const longText = `${'夜深了我们继续放一首很长的爵士乐慢慢聊。'.repeat(9)}。${'窗外的风吹过树梢，茶杯还有一点余温。'.repeat(8)}`;
    assert.ok([...longText].length > 240);

    const first = await tts.synth(longText);
    assert.equal(calls.length > 1, true);
    assert.ok(calls.every(chunk => [...chunk].length <= 220));
    assert.equal(first.extension, 'wav');
    const info = readWavInfo(await import('node:fs').then(fs => fs.readFileSync(first.path)));
    assert.equal(info.dataSize, calls.length * 1600 * 2);

    // 将缓存文件 mtime 调回过去，再重复请求以验证命中缓存后会刷新 mtime。
    const oldTime = new Date(Date.now() - 3600_000);
    utimesSync(first.path, oldTime, oldTime);
    const beforeMtime = statSync(first.path).mtimeMs;

    const second = await tts.synth(longText);
    assert.equal(second.source, 'cache');
    assert.equal(second.hash, first.hash);
    assert.equal(calls.length, first.durationMs / 100);
    const afterMtime = statSync(first.path).mtimeMs;
    assert.ok(afterMtime > beforeMtime);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('synth stitches MP3 chunks without internal ID3 tags and fails closed without caching on chunk error', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'lunara-tts-mp3-'));
  try {
    let failChunk2 = true;
    let okCalls = 0;
    const registry = new TtsProviderRegistry({
      providers: [{
        id: 'mock-mp3',
        label: 'Mock MP3',
        isConfigured: () => true,
        listVoices: async () => [{ id: 'v1', name: 'V1' }],
        synth: async text => {
          if (failChunk2 && text.includes('第二段')) {
            throw new TtsSynthesisError('rate limited', { providerId: 'mock-mp3', code: 'TTS_RATE_LIMIT' });
          }
          if (!failChunk2) okCalls += 1;
          const body = text.includes('第二段') ? 'BODY2' : 'BODY1';
          return createTtsAudio({ bytes: makeFakeMp3(body), extension: 'mp3', source: 'mock-mp3', durationMs: 500 });
        },
      }],
    });
    const tts = createTtsGateway({ registry, cacheDir, initialVoice: 'v1' });
    const longText = `${'第一段在雨夜里点亮台灯慢慢听歌。'.repeat(16)}${'第二段窗外的街灯映在水面上。'.repeat(10)}`;
    assert.ok([...longText].length > 240);

    await assert.rejects(() => tts.synth(longText), err => err.code === 'TTS_RATE_LIMIT');
    assert.deepEqual(readdirSync(cacheDir), []);

    failChunk2 = false;
    const ok = await tts.synth(longText);
    assert.equal(ok.extension, 'mp3');
    assert.ok(okCalls > 1);
    assert.equal(ok.durationMs, okCalls * 500);
    const fs = await import('node:fs');
    const saved = fs.readFileSync(ok.path);
    // 保留首段头部 ID3 与末段尾部 TAG，同时剥除中间分片边界多余标签。
    assert.equal(saved.subarray(0, 3).toString('latin1'), 'ID3');
    assert.equal(saved.includes(Buffer.from('BODY1')), true);
    assert.equal(saved.includes(Buffer.from('BODY2')), true);
    assert.equal(saved.indexOf('ID3', 3), -1);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

function makeValidMpeg1Frame(fillByte = 0x55, { withXing = false } = {}) {
  // MPEG1 Layer III, 128kbps (idx=9), 44100Hz (idx=0), Mono (mode=3) -> 417 bytes, sideInfo=17
  const frame = Buffer.alloc(417, fillByte);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  frame[3] = 0xc0;
  if (withXing) Buffer.from('Xing').copy(frame, 4 + 17);
  return frame;
}

test('mp3 stitching strips VBR Xing frames, inserts valid silence frames, and Breeze receives per-beat instructions', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'lunara-tts-breeze-plan-'));
  try {
    // 校验真实 MPEG III 帧头的 Xing 剥离与静音帧生成
    const xingFrame = makeValidMpeg1Frame(0x11, { withXing: true });
    const audioFrame1 = makeValidMpeg1Frame(0x22);
    const audioFrame2 = makeValidMpeg1Frame(0x33);
    const seg1 = Buffer.concat([xingFrame, audioFrame1]);
    const seg2 = Buffer.concat([xingFrame, audioFrame2]);
    const parsedFrame = parseFirstMpegFrame(seg1);
    assert.ok(parsedFrame);
    assert.equal(parsedFrame.sampleRate, 44100);
    const silence = createMp3SilenceFrames(260, parsedFrame);
    assert.ok(silence.length >= 417 * 9);
    const mergedMp3 = concatMp3Buffers(
      [{ bytes: seg1, durationMs: 30 }, { bytes: seg2, durationMs: 30 }],
      { pausesMs: [0, 260] },
    );
    assert.equal(mergedMp3.durationMs, 320);
    assert.equal(mergedMp3.bytes.includes(Buffer.from('Xing')), false);

    // 校验 Breeze speechPlan 网关调用：每段独立发送中文 instructions 与 voice_settings，且结果落盘缓存复用
    const requests = [];
    const provider = createCustomProvider({
      id: 'custom-breeze',
      getConfig: () => ({
        protocol: 'breeze',
        baseUrl: 'https://api.breeze.blue',
        apiKey: 'brz_test_key',
        model: 'breeze-tts-2',
        voices: [{ sourceVoiceId: 'v_zh_1', displayName: '测试声线' }],
      }),
      fetchImpl: async (_url, options = {}) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        return new Response(Buffer.concat([audioFrame1, audioFrame2]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        });
      },
    });
    const registry = new TtsProviderRegistry({ providers: [provider] });
    const tts = createTtsGateway({ registry, cacheDir });

    const speechPlan = [
      {
        text: '慢，慢一点。',
        performance: { emotion: null, pace: 'slow', intensity: null, direction: '贴耳极近收音，呼吸急促紊乱' },
        pauseBeforeMs: 0,
      },
      {
        text: '{叹气}还在。',
        performance: { emotion: null, pace: 'slow', intensity: 'soft', direction: '呼吸平复后慵懒困倦，极轻极慢地低喃' },
        pauseBeforeMs: 520,
      },
    ];

    const first = await tts.synth('慢，慢一点。 还在。', {
      providerId: 'custom-breeze',
      voiceId: 'v_zh_1',
      params: { model: 'breeze-tts-2' },
      speechPlan,
    });
    assert.equal(requests.length, 2);
    const firstReq = requests.find(r => r.text === '慢，慢一点。');
    const secondReq = requests.find(r => r.text === '[叹气]还在。');
    assert.ok(firstReq && secondReq);
    assert.match(firstReq.instructions, /语速放慢/);
    assert.match(firstReq.instructions, /贴耳极近收音，呼吸急促紊乱/);
    assert.equal(firstReq.voice_settings.guidance_scale, 4);
    assert.equal(firstReq.voice_settings.speed, 0.9);
    assert.match(secondReq.instructions, /声音轻柔.*呼吸平复后慵懒困倦/);
    assert.equal(first.extension, 'mp3');

    const second = await tts.synth('慢，慢一点。 还在。', {
      providerId: 'custom-breeze',
      voiceId: 'v_zh_1',
      params: { model: 'breeze-tts-2' },
      speechPlan,
    });
    assert.equal(second.source, 'cache');
    assert.equal(requests.length, 2);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
