import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMediaVerifier, decodeCoverageIsComplete, decodedDurationSeconds, detectContainer,
  durationLooksShort, durationLooksTruncated, flacDurationSeconds,
} from './mediaProbe.js';

function flacHead({ sampleRate = 44100, totalSamples = 44100 * 100 } = {}) {
  const buffer = Buffer.alloc(42);
  buffer.write('fLaC', 0, 'latin1');
  buffer[4] = 0x80; // last metadata block, type 0 (STREAMINFO)
  buffer.writeUIntBE(34, 5, 3);
  buffer.writeUInt16BE(4096, 8);
  buffer.writeUInt16BE(4096, 10);
  const packed = (BigInt(sampleRate) << 44n) | (1n << 41n) | (15n << 36n) | BigInt(totalSamples);
  buffer.writeBigUInt64BE(packed, 18);
  return buffer;
}

test('container detection reads magic bytes only', () => {
  assert.equal(detectContainer(flacHead()), 'flac');
  assert.equal(detectContainer(Buffer.from('ID3\u0003\u0000', 'latin1')), 'mpeg');
  assert.equal(detectContainer(Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mpeg');
  assert.equal(detectContainer(Buffer.from('OggS\u0000', 'latin1')), 'ogg');
  assert.equal(detectContainer(Buffer.from('not audio')), 'unknown');
});

test('flac duration comes from STREAMINFO total samples', () => {
  assert.equal(flacDurationSeconds(flacHead({ sampleRate: 48000, totalSamples: 48000 * 230 })), 230);
  assert.equal(flacDurationSeconds(Buffer.from('fLaC')), null);
});

test('only grossly shortened media counts as truncation', () => {
  assert.equal(durationLooksTruncated(129.3, 237.7), true);
  assert.equal(durationLooksTruncated(223.8, 237.7), false);
  assert.equal(durationLooksTruncated(200, 237.7), false);
  assert.equal(durationLooksTruncated(160, 237.7), true);
  assert.equal(durationLooksTruncated(30, 237.7), true);
  assert.equal(durationLooksTruncated(0, 237.7), false);
});

test('shortening detection tolerates 5s or 5%, whichever is larger', () => {
  assert.equal(durationLooksShort(229, 238), false);
  assert.equal(durationLooksShort(129.3, 237.7), true);
  assert.equal(durationLooksShort(60, 62), false);
  assert.equal(durationLooksShort(59.9, 63.3), false);
  assert.equal(durationLooksShort(0, 200), false);
  assert.equal(durationLooksShort(200, 0), false);
});

test('verifier reports decode failure with a stable reason and keeps structure facts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, flacHead());
    const verify = createMediaVerifier({
      ffmpegPath: '/fake/ffmpeg',
      execFileImpl: async () => { const error = new Error('invalid residual'); error.stderr = 'invalid residual'; throw error; },
    });
    const verdict = await verify(file, { expectedDurationSeconds: 100 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'decode-failed');
    assert.equal(verdict.verifiedBy, 'decode');
    assert.equal(verdict.format, 'flac');
    assert.equal(verdict.durationSeconds, 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a decode error after the full audio is trailing damage, not missing music', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    // 结构时长 100s，解码到 100s 后才报错（真实缓存里的尾部损坏就是这样）
    await writeFile(file, flacHead({ sampleRate: 44100, totalSamples: 44100 * 100 }));
    const verify = createMediaVerifier({
      ffmpegPath: '/fake/ffmpeg',
      execFileImpl: async () => {
        const error = new Error('invalid sync code');
        error.stdout = 'out_time_us=100000000\n';
        throw error;
      },
    });
    const verdict = await verify(file, { expectedDurationSeconds: 100 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.note, 'trailing-damage');
    assert.equal(verdict.verifiedBy, 'decode');
    assert.equal(decodeCoverageIsComplete(129.3, 237.7), false);
    assert.equal(decodeCoverageIsComplete(229.69, 229.69), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a decode error that lost most of the audio is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, flacHead({ sampleRate: 44100, totalSamples: 44100 * 237 }));
    const verify = createMediaVerifier({
      ffmpegPath: '/fake/ffmpeg',
      execFileImpl: async () => {
        const error = new Error('invalid residual');
        error.stdout = 'out_time_us=129288707\n';
        throw error;
      },
    });
    const verdict = await verify(file, { expectedDurationSeconds: 237 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'decode-failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a decoder timeout is unverified, not broken', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, flacHead({ sampleRate: 44100, totalSamples: 44100 * 230 }));
    const verify = createMediaVerifier({
      ffmpegPath: '/fake/ffmpeg',
      execFileImpl: async () => {
        const error = new Error('killed');
        error.killed = true;
        error.signal = 'SIGTERM';
        error.stdout = 'out_time_us=120000000\n';
        throw error;
      },
    });
    const verdict = await verify(file, { expectedDurationSeconds: 229 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.note, 'decode-timeout');
    assert.equal(verdict.verifiedBy, 'structure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifier accepts decodable media and reports probed duration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, flacHead({ totalSamples: 44100 * 100 }));
    const calls = [];
    const verify = createMediaVerifier({
      ffmpegPath: '/fake/ffmpeg',
      ffprobePath: '/fake/ffprobe',
      execFileImpl: async (bin) => {
        calls.push(bin);
        if (bin === '/fake/ffprobe') {
          return { stdout: JSON.stringify({ format: { format_name: 'flac', duration: '237.75' } }) };
        }
        return { stdout: '' };
      },
    });
    const verdict = await verify(file, { expectedDurationSeconds: 237 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifiedBy, 'decode');
    assert.equal(verdict.durationSeconds, 237.75);
    assert.deepEqual(calls, ['/fake/ffmpeg', '/fake/ffprobe']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('decode progress yields the real decoded duration', async () => {
  assert.equal(decodedDurationSeconds('out_time_us=1000\nout_time_us=237750000\nprogress=end\n'), 237.75);
  assert.equal(decodedDurationSeconds(''), null);
  assert.equal(decodedDurationSeconds('out_time_ms=0'), null);
});

test('metadata duration drift alone does not reject a decodable file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, flacHead({ sampleRate: 44100, totalSamples: 44100 * 224 }));
    const verify = createMediaVerifier({ execFileImpl: async () => ({ stdout: '' }) });
    const verdict = await verify(file, { expectedDurationSeconds: 237 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.note, 'duration-drift');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('truncated media is rejected even when it decodes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, flacHead({ sampleRate: 44100, totalSamples: 44100 * 120 }));
    const verify = createMediaVerifier({ execFileImpl: async () => ({ stdout: '' }) });
    const verdict = await verify(file, { expectedDurationSeconds: 237 });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'duration-short');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('without a decoder the verdict is honest about structure-only verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.mp3');
    await writeFile(file, flacHead());
    const verify = createMediaVerifier({ execFileImpl: async () => ({ stdout: '' }) });
    const verdict = await verify(file, { expectedDurationSeconds: 100 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifiedBy, 'structure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
