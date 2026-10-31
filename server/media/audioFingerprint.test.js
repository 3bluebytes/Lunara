import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINGERPRINT_MATCH_THRESHOLD, computeFingerprint, fingerprintPcm, fingerprintSimilarity, isFingerprintMatch,
} from './audioFingerprint.js';

const SAMPLE_RATE = 11_025;

/** 生成一段单频正弦的 PCM（s16le / mono），用来验证「频带形状」确有区分度。 */
function tonePcm({ frequency = 440, seconds = 2, amplitude = 0.5, sampleRate = SAMPLE_RATE } = {}) {
  const samples = Math.round(seconds * sampleRate);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * 32767);
    buffer.writeInt16LE(value, i * 2);
  }
  return buffer;
}

test('同一段音频得到同一指纹，不同频段得到不同指纹', () => {
  const low = tonePcm({ frequency: 160 });
  const high = tonePcm({ frequency: 1600 });
  const a = fingerprintPcm(low);
  const b = fingerprintPcm(low);
  const c = fingerprintPcm(high);
  assert.ok(a && a.length > 0, '指纹非空');
  assert.equal(a, b, '同一段音频稳定');
  assert.notEqual(a, c, '不同频段指纹不同');
  assert.equal(fingerprintSimilarity(a, b), 1);
  assert.ok(fingerprintSimilarity(a, c) < FINGERPRINT_MATCH_THRESHOLD, '不同频段不该判为同一首');
  assert.equal(isFingerprintMatch(a, a), true);
  assert.equal(isFingerprintMatch(a, c), false);
});

test('太短或空的输入不算指纹，而不是返回一个空串', () => {
  assert.equal(fingerprintPcm(null), null);
  assert.equal(fingerprintPcm(Buffer.alloc(10)), null);
  const onePoint = Buffer.alloc(2_048 * 2);
  assert.equal(fingerprintPcm(onePoint), null, '只有一两个窗口不足以判断');
});

test('指纹长度有上限：长音频只取前 180 个窗口，不会无限增长', () => {
  const long = tonePcm({ seconds: 60 });
  const fingerprint = fingerprintPcm(long);
  assert.equal(fingerprint.length / 4, 180);
});

test('没有 ffmpeg 或解码失败时如实失败，不编一个指纹出来', async () => {
  assert.deepEqual(await computeFingerprint('/tmp/a.mp3', {}), { ok: false, reason: 'no-ffmpeg' });
  const failed = await computeFingerprint('/tmp/a.mp3', {
    ffmpegPath: '/fake/ffmpeg',
    execFileImpl: async () => { throw new Error('decode failed'); },
  });
  assert.deepEqual(failed, { ok: false, reason: 'decode-failed' });
  const broken = await computeFingerprint('/tmp/a.mp3', {
    ffmpegPath: '/fake/ffmpeg',
    execFileImpl: async () => ({ stdout: Buffer.alloc(8) }),
  });
  assert.deepEqual(broken, { ok: false, reason: 'insufficient-audio' });
});

test('尾部坏字节但音频已解出来时仍能出指纹', async () => {
  const pcm = tonePcm({ seconds: 2 });
  const result = await computeFingerprint('/tmp/a.mp3', {
    ffmpegPath: '/fake/ffmpeg',
    execFileImpl: async () => { const error = new Error('trailing garbage'); error.stdout = pcm; throw error; },
  });
  assert.equal(result.ok, true);
  assert.ok(result.fingerprint.length > 0);
  assert.equal(result.points, result.fingerprint.length / 4);
});
