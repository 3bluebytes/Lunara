import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegStaticPath from 'ffmpeg-static';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMediaVerifier, decodeCoverageIsComplete, decodedDurationSeconds, detectContainer,
  durationLooksShort, durationLooksTruncated, flacDurationSeconds, parseFfmpegInputInfo,
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

// ffmpeg 不带输出参数时以退出码 1 结束，容器信息只在 stderr 的 Input 段里。
function ffmpegInputError(stderr) {
  const error = new Error('Command failed');
  error.code = 1;
  error.stdout = '';
  error.stderr = stderr;
  return error;
}

const M4A_INPUT_STDERR = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/cache/a, from 'x'.m4a':",
  '  Metadata:',
  '    major_brand     : M4A ',
  '  Duration: 00:03:57.75, start: 0.000000, bitrate: 73 kb/s',
  '  Stream #0:0[0x1](und): Audio: aac (LC), 44100 Hz, stereo, fltp',
  'At least one output file must be specified',
].join('\n');

test('ffmpeg input banner yields the container format and duration', () => {
  assert.deepEqual(parseFfmpegInputInfo(M4A_INPUT_STDERR), { format: 'mov', durationSeconds: 237.75 });
  assert.deepEqual(parseFfmpegInputInfo("Input #0, flac, from 'a.flac':\n  Duration: 01:00:01.50, start: 0"),
    { format: 'flac', durationSeconds: 3601.5 });
  assert.deepEqual(parseFfmpegInputInfo("Input #0, mp3, from 'a.mp3':\n  Duration: N/A, bitrate: N/A"),
    { format: 'mp3', durationSeconds: null }, '未知时长不能猜');
  assert.deepEqual(parseFfmpegInputInfo('a.mp3: Invalid data found when processing input'),
    { format: null, durationSeconds: null });
  assert.deepEqual(parseFfmpegInputInfo(undefined), { format: null, durationSeconds: null });
});

test('verifier reads container format and duration from ffmpeg alone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    // 魔数识别不了的容器（m4a）也要拿到格式名，且不需要 ffprobe。
    const file = join(dir, 'a.m4a');
    await writeFile(file, Buffer.from('\u0000\u0000\u0000 ftypM4A ', 'latin1'));
    const calls = [];
    const verify = createMediaVerifier({
      ffmpegPath: '/fake/ffmpeg',
      execFileImpl: async (bin, args) => {
        calls.push([bin, args.includes('null') ? 'decode' : 'probe']);
        if (args.includes('null')) return { stdout: 'out_time_us=237700000\nprogress=end\n' };
        throw ffmpegInputError(M4A_INPUT_STDERR);
      },
    });
    const verdict = await verify(file, { expectedDurationSeconds: 237 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifiedBy, 'decode');
    assert.equal(verdict.format, 'mov');
    assert.equal(verdict.durationSeconds, 237.75);
    assert.deepEqual(calls, [['/fake/ffmpeg', 'decode'], ['/fake/ffmpeg', 'probe']]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable ffmpeg input banner keeps decode facts instead of failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-'));
  try {
    const file = join(dir, 'a.flac');
    await writeFile(file, flacHead({ totalSamples: 44100 * 230 }));
    const verify = createMediaVerifier({
      ffmpegPath: '/fake/ffmpeg',
      execFileImpl: async (_bin, args) => {
        if (args.includes('null')) return { stdout: 'out_time_us=229500000\n' };
        const error = new Error('killed');
        error.killed = true;
        throw error;
      },
    });
    const verdict = await verify(file, { expectedDurationSeconds: 230 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifiedBy, 'decode');
    assert.equal(verdict.format, 'flac', '探测失败时保留魔数识别的格式');
    assert.equal(verdict.durationSeconds, 229.5, '探测失败时保留真实解码时长');
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

const bundledFfmpeg = typeof ffmpegStaticPath === 'string' && (() => {
  try { execFileSync(ffmpegStaticPath, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})() ? ffmpegStaticPath : null;

test('the bundled ffmpeg alone verifies a real m4a file', { skip: !bundledFfmpeg && '本机随包 ffmpeg 不可执行' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-probe-real-'));
  try {
    const file = join(dir, 'tone.m4a');
    execFileSync(bundledFfmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'aac', file]);
    const verify = createMediaVerifier({ ffmpegPath: bundledFfmpeg, execFileImpl: promisify(execFile) });
    const verdict = await verify(file, { expectedDurationSeconds: 3 });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.verifiedBy, 'decode');
    assert.equal(verdict.format, 'mov', '魔数识别不了 m4a，格式名必须来自 ffmpeg 输入信息');
    assert.ok(Math.abs(verdict.durationSeconds - 3) < 0.1, `时长应约 3 秒，实际 ${verdict.durationSeconds}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
