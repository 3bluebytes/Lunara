import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asarUnpackedPath, resolveAudioToolPaths, resolveRunnableAudioTool, resolveRunnableAudioTools,
} from './audioToolPaths.js';

test('asar paths are remapped to app.asar.unpacked before execution', () => {
  const inside = '/opt/Lunara.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg';
  const already = '/opt/Lunara.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg';
  const plain = '/opt/homebrew/bin/ffmpeg';
  assert.equal(asarUnpackedPath(inside), already);
  assert.equal(asarUnpackedPath(already), already, '重复修正必须幂等');
  assert.equal(asarUnpackedPath(plain), plain);
  assert.equal(asarUnpackedPath(null), null);
  assert.equal(asarUnpackedPath(''), null);
});

test('explicit env wins over bundled binary; bundled wins over nothing', () => {
  const env = { LUNARA_FFMPEG_PATH: '/usr/local/bin/ffmpeg' };
  assert.deepEqual(resolveAudioToolPaths({ env, bundledFfmpegPath: '/pkg/ffmpeg' }),
    { ffmpegPath: '/usr/local/bin/ffmpeg' }, 'env 覆盖随包值');
  assert.deepEqual(resolveAudioToolPaths({ env: {}, bundledFfmpegPath: '/pkg/ffmpeg' }),
    { ffmpegPath: '/pkg/ffmpeg' }, '未设置的 env 回退随包值');
});

test('existence check can reject a bundled path and leave resolution null', () => {
  const resolved = resolveAudioToolPaths({ env: {}, bundledFfmpegPath: '/missing/ffmpeg', exists: () => false });
  assert.equal(resolved.ffmpegPath, null);
});

test('resolution never throws when existence probe throws', () => {
  const resolved = resolveAudioToolPaths({ env: { LUNARA_FFMPEG_PATH: '/x/ffmpeg' },
    exists: () => { throw new Error('fs exploded'); } });
  assert.equal(resolved.ffmpegPath, null);
});

test('empty-string env values are treated as unset, not as candidates', () => {
  const resolved = resolveAudioToolPaths({ env: { LUNARA_FFMPEG_PATH: '   ' }, bundledFfmpegPath: '/pkg/ffmpeg' });
  assert.equal(resolved.ffmpegPath, '/pkg/ffmpeg');
});

test('runtime resolution probes only ffmpeg: env, then the bundled binary, then PATH', async () => {
  const probed = [];
  const tools = await resolveRunnableAudioTools({
    env: { LUNARA_FFMPEG_PATH: '/env/ffmpeg', LUNARA_FFPROBE_PATH: '/env/ffprobe' },
    bundledFfmpegPath: '/opt/Lunara.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg',
    execFileImpl: async candidate => {
      probed.push(candidate);
      if (candidate !== 'ffmpeg') throw new Error('bad CPU type in executable');
      return { stdout: 'ffmpeg version 6.1.1' };
    },
  });
  // 媒体校验的格式与时长都由 ffmpeg 读出；ffprobe 不再是候选，也不应被执行。
  assert.deepEqual(tools, { ffmpegPath: 'ffmpeg' });
  assert.deepEqual(probed, [
    '/env/ffmpeg',
    '/opt/Lunara.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg',
    'ffmpeg',
  ]);
});

test('runnable tool resolution skips a present but unexecutable binary and tries PATH fallback', { skip: process.platform === 'win32' ? '依赖 shebang 脚本与 exec 位语义，Windows 不适用' : false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-audio-tools-'));
  const broken = join(dir, 'wrong-arch');
  const working = join(dir, 'working-tool');
  writeFileSync(broken, '#!/bin/sh\nexit 126\n', { mode: 0o755 });
  writeFileSync(working, '#!/bin/sh\necho working\n', { mode: 0o755 });
  try {
    // 全量并发下脚本 spawn 可能超过 1s：放宽超时，避免把慢当成不可执行。
    const selected = await resolveRunnableAudioTool([broken, working], { timeoutMs: 10_000 });
    assert.equal(selected, working);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runnable tool resolution accepts command names resolved by PATH', async () => {
  const selected = await resolveRunnableAudioTool(['lunara-nonexistent-ffmpeg', 'true'], { timeoutMs: 1000 });
  assert.equal(selected, 'true');
});

test('runnable tool resolution returns null when every candidate fails', async () => {
  const selected = await resolveRunnableAudioTool(['/missing/ffmpeg', 'lunara-nonexistent-ffmpeg'], { timeoutMs: 1000 });
  assert.equal(selected, null);
});
