import test from 'node:test';
import assert from 'node:assert/strict';

const { normalizeLoudness, measurePcm, TARGET_RMS_DB, MAX_GAIN_DB } = await import('./loudness.js');
const { readWavInfo } = await import('./wav.js');

/** 造一段已知电平的 16-bit PCM WAV（正弦波，便于断言）。 */
function wavOf({ seconds = 0.5, amplitude = 0.1, sampleRate = 24000 } = {}) {
  const count = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const value = Math.sin((index / sampleRate) * 440 * Math.PI * 2) * amplitude;
    data.writeInt16LE(Math.round(value * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const rmsOf = bytes => {
  const info = readWavInfo(bytes);
  let sum = 0;
  const count = info.dataSize / 2;
  for (let index = 0; index < count; index += 1) {
    const sample = bytes.readInt16LE(info.dataOffset + index * 2) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / count);
};

test('过轻的音频被提升到接近目标电平', () => {
  // 偏轻的本地引擎实测约 0.061 RMS，需要提升。
  const source = wavOf({ amplitude: 0.061 });
  const before = rmsOf(source);
  const result = normalizeLoudness(source);
  assert.equal(result.changed, true);
  const after = rmsOf(result.bytes);
  assert.ok(after > before * 1.5, `应明显提升（${before.toFixed(3)} → ${after.toFixed(3)}）`);
  // 落在目标附近（允许 1.5dB 内，因为整数量化与峰值限制）
  assert.ok(Math.abs(result.loudnessDb - TARGET_RMS_DB) < 1.5,
    `提升后电平 ${result.loudnessDb.toFixed(1)}dB 应接近目标 ${TARGET_RMS_DB}dB`);
});

test('两个不同电平的 provider 输出归一后互相一致', () => {
  // 0.061 RMS vs 0.102 RMS：归一后差距应显著缩小。
  const quiet = normalizeLoudness(wavOf({ amplitude: 0.061 }));
  const edge = normalizeLoudness(wavOf({ amplitude: 0.102 }));
  const delta = Math.abs(quiet.loudnessDb - edge.loudnessDb);
  assert.ok(delta < 1.5, `归一后两者电平差应小于 1.5dB，实测 ${delta.toFixed(2)}dB`);
});

test('已是目标电平的音频不做改动', () => {
  // 正弦波的 RMS = 幅度/√2，因此目标电平对应幅度 = 目标 × √2。
  const amplitude = 10 ** (TARGET_RMS_DB / 20) * Math.SQRT2;
  const source = wavOf({ amplitude });
  const result = normalizeLoudness(source);
  assert.equal(result.changed, false);
  assert.equal(result.gainDb, 0);
  assert.equal(result.bytes, source, '不应重写未改动的缓冲区');
});

test('不会为了达标而削波', () => {
  // 峰值已接近 1.0：提升空间极小，必须只提升到不超峰。
  const source = wavOf({ amplitude: 0.9 });
  const result = normalizeLoudness(source);
  const info = readWavInfo(result.bytes);
  let peak = 0;
  for (let index = 0; index < info.dataSize / 2; index += 1) {
    peak = Math.max(peak, Math.abs(result.bytes.readInt16LE(info.dataOffset + index * 2)) / 32768);
  }
  assert.ok(peak <= 0.9001, `峰值不得越过天花板，实测 ${peak.toFixed(4)}`);
});

test('提升量有上限，不会把底噪放大成噪声', () => {
  // 极轻的信号（近乎静音）不应被提升 40dB。
  const source = wavOf({ amplitude: 0.001 });
  const result = normalizeLoudness(source);
  assert.ok(result.gainDb <= MAX_GAIN_DB + 0.01, `提升量应受上限约束，实测 ${result.gainDb.toFixed(1)}dB`);
});

test('全静音不被处理', () => {
  const silent = wavOf({ amplitude: 0 });
  const result = normalizeLoudness(silent);
  assert.equal(result.changed, false, '提升静音只会得到更响的静音');
  assert.equal(result.gainDb, 0);
});

test('非 WAV 输入原样透传（例如 MiniMax 的 mp3）', () => {
  const mp3ish = Buffer.from('ID3 and some mpeg frames that are not wav');
  const result = normalizeLoudness(mp3ish);
  assert.equal(result.changed, false);
  assert.equal(result.bytes, mp3ish);
  assert.equal(result.loudnessDb, null);
});

test('样本内容不被破坏：长度与格式不变', () => {
  const source = wavOf({ amplitude: 0.05, seconds: 0.2 });
  const before = readWavInfo(source);
  const result = normalizeLoudness(source);
  const after = readWavInfo(result.bytes);
  assert.equal(after.bitsPerSample, before.bitsPerSample);
  assert.equal(after.sampleRate, before.sampleRate);
  assert.equal(after.channels, before.channels);
  assert.equal(after.dataSize, before.dataSize, '样本数量必须不变');
  assert.equal(result.bytes.length, source.length);
});

test('归一化是幂等的：再次处理不再提升', () => {
  const first = normalizeLoudness(wavOf({ amplitude: 0.05 }));
  const second = normalizeLoudness(first.bytes);
  assert.equal(second.changed, false, '第二次不应继续提升');
  assert.equal(second.bytes, first.bytes);
});

test('measurePcm 报告 RMS 与峰值', () => {
  const measured = measurePcm(wavOf({ amplitude: 0.5 }));
  assert.ok(measured.rms > 0.3 && measured.rms < 0.4, `正弦波 RMS 约 0.354，实测 ${measured.rms.toFixed(3)}`);
  assert.ok(Math.abs(measured.peak - 0.5) < 0.01);
  assert.equal(measured.count, 12000);
});

test('measurePcm 对非 PCM16 输入返回 null', () => {
  assert.equal(measurePcm(Buffer.from('nope')), null);
});

test('夹紧而不是回绕：极轻信号的样本不会变成反相噪声', () => {
  const source = wavOf({ amplitude: 0.95 });
  const result = normalizeLoudness(source);
  // 若发生回绕，会出现符号相反的尖峰；检查相邻样本差不超过合理范围。
  const info = readWavInfo(result.bytes);
  let maxJump = 0;
  let previous = result.bytes.readInt16LE(info.dataOffset);
  for (let index = 1; index < info.dataSize / 2; index += 1) {
    const current = result.bytes.readInt16LE(info.dataOffset + index * 2);
    maxJump = Math.max(maxJump, Math.abs(current - previous));
    previous = current;
  }
  assert.ok(maxJump < 32768, `不应出现整量程跳变，实测 ${maxJump}`);
});