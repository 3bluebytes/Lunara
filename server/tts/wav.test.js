import test from 'node:test';
import assert from 'node:assert/strict';

const { readWavInfo, toCanonicalWav } = await import('./wav.js');
const { TtsSynthesisError } = await import('./TtsProvider.js');

function canonicalWav({ samples = 8, bits = 16, format = 1, channels = 1, sampleRate = 22050 } = {}) {
  const blockAlign = channels * (bits / 8);
  const data = Buffer.alloc(samples * blockAlign);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 复刻 macOS `say` 的布局：fmt 前有 JUNK 块，data 前有 FLLR 块。 */
function wavWithExtraChunks() {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8);
  fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(22050, 12);
  fmt.writeUInt32LE(44100, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const junk = Buffer.alloc(8 + 28);
  junk.write('JUNK', 0, 'latin1');
  junk.writeUInt32LE(28, 4);
  const fllr = Buffer.alloc(8 + 16);
  fllr.write('FLLR', 0, 'latin1');
  fllr.writeUInt32LE(16, 4);
  const samples = Buffer.alloc(40);
  const dataHeader = Buffer.alloc(8);
  dataHeader.write('data', 0, 'latin1');
  dataHeader.writeUInt32LE(samples.length, 4);
  const body = Buffer.concat([fmt, junk, fllr, dataHeader, samples]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  header.write('WAVE', 8, 'latin1');
  return Buffer.concat([header, body]);
}

test('canonicalWav 被正确解析', () => {
  const info = readWavInfo(canonicalWav());
  assert.equal(info.audioFormat, 1);
  assert.equal(info.channels, 1);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataSize, 16);
  assert.equal(info.durationMs, Math.round((16 / 44100) * 1000));
});

test('fmt 不在固定偏移上的 WAV 仍被正确解析', () => {
  const info = readWavInfo(wavWithExtraChunks());
  assert.ok(info);
  assert.equal(info.bitsPerSample, 16);
  assert.equal(info.sampleRate, 22050);
  assert.equal(info.dataSize, 40);
});

test('规范化剥离附加块，只保留 fmt 与 data', () => {
  const source = wavWithExtraChunks();
  const { bytes, info } = toCanonicalWav(source);
  assert.equal(bytes.length, 44 + info.dataSize);
  assert.equal(bytes.length < source.length, true, '规范化后必须更小');
  assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  assert.equal(bytes.subarray(12, 16).toString(), 'fmt ');
  assert.equal(bytes.subarray(36, 40).toString(), 'data');
  const reparsed = readWavInfo(bytes);
  assert.equal(reparsed.bitsPerSample, 16);
  assert.equal(reparsed.dataSize, info.dataSize);
});

test('规范化保留样本内容', () => {
  const source = canonicalWav({ samples: 4 });
  source.writeUInt16LE(0x1234, 44);
  const { bytes } = toCanonicalWav(source);
  assert.equal(bytes.readUInt16LE(44), 0x1234);
});

test('规范化后再次规范化是幂等的', () => {
  const once = toCanonicalWav(wavWithExtraChunks()).bytes;
  const twice = toCanonicalWav(once).bytes;
  assert.deepEqual(twice, once);
});

test('非 RIFF 载荷被拒绝', () => {
  assert.equal(readWavInfo(Buffer.from('not a wav at all........')), null);
  assert.throws(() => toCanonicalWav(Buffer.from('nope')), error => {
    assert.ok(error instanceof TtsSynthesisError);
    assert.equal(error.code, 'TTS_INVALID_WAV');
    return true;
  });
});

test('非 PCM 编码被拒绝而不是冒充为 PCM', () => {
  assert.throws(() => toCanonicalWav(canonicalWav({ format: 3 })), error => {
    assert.equal(error.code, 'TTS_UNSUPPORTED_WAV_ENCODING');
    return true;
  });
});

test('非 16 位深度被拒绝', () => {
  assert.throws(() => toCanonicalWav(canonicalWav({ bits: 32 })), error => {
    assert.equal(error.code, 'TTS_UNSUPPORTED_WAV_DEPTH');
    return true;
  });
});

test('data size 超出实际长度时按可用字节截断，不越界', () => {
  const buffer = canonicalWav({ samples: 4 });
  buffer.writeUInt32LE(0xffffffff, 40); // 恶意/损坏的声明
  const info = readWavInfo(buffer);
  assert.ok(info);
  assert.equal(info.dataSize, 8);
  const { info: normalized } = toCanonicalWav(buffer);
  assert.equal(normalized.dataSize, 8);
});