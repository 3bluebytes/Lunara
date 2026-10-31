import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asarUnpackedPath, resolveAudioToolPaths, resolveRunnableAudioTool } from './audioToolPaths.js';

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
  const resolved = resolveAudioToolPaths({ env, bundledFfmpegPath: '/pkg/ffmpeg', bundledFfprobePath: '/pkg/ffprobe' });
  assert.equal(resolved.ffmpegPath, '/usr/local/bin/ffmpeg', 'env 覆盖随包值');
  assert.equal(resolved.ffprobePath, '/pkg/ffprobe', '未设置的 env 回退随包值');
});

test('existence check can reject a bundled path and leave resolution null', () => {
  const resolved = resolveAudioToolPaths({ env: {}, bundledFfmpegPath: '/missing/ffmpeg',
    bundledFfprobePath: '/missing/ffprobe', exists: () => false });
  assert.equal(resolved.ffmpegPath, null);
  assert.equal(resolved.ffprobePath, null);
});

test('resolution never throws when existence probe throws', () => {
  const resolved = resolveAudioToolPaths({ env: { LUNARA_FFMPEG_PATH: '/x/ffmpeg' },
    bundledFfprobePath: '/y/ffprobe', exists: () => { throw new Error('fs exploded'); } });
  assert.equal(resolved.ffmpegPath, null);
  assert.equal(resolved.ffprobePath, null);
});

test('empty-string env values are treated as unset, not as candidates', () => {
  const resolved = resolveAudioToolPaths({ env: { LUNARA_FFMPEG_PATH: '', LUNARA_FFPROBE_PATH: '   ' },
    bundledFfmpegPath: '/pkg/ffmpeg' });
  assert.equal(resolved.ffmpegPath, '/pkg/ffmpeg');
  assert.equal(resolved.ffprobePath, null);
});

test('runnable tool resolution skips a present but unexecutable binary and tries PATH fallback', async () => {
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
  const selected = await resolveRunnableAudioTool(['lunara-nonexistent-ffprobe', 'true'], { timeoutMs: 1000 });
  assert.equal(selected, 'true');
});

test('runnable tool resolution returns null when every candidate fails', async () => {
  const selected = await resolveRunnableAudioTool(['/missing/ffprobe', 'lunara-nonexistent-ffprobe'], { timeoutMs: 1000 });
  assert.equal(selected, null);
});

test('the packaged arm64 ffprobe is skipped on arm64 hosts if it cannot execute', { skip: process.arch !== 'arm64' }, async () => {
  const packaged = new URL('../../node_modules/ffprobe-static/bin/darwin/arm64/ffprobe', import.meta.url).pathname;
  let packagedResult = null;
  try { packagedResult = execFileSync(packaged, ['-version'], { encoding: 'utf8', stdio: 'ignore' }); } catch { /* expected for mismatched binary */ }
  if (packagedResult !== null) return;
  // 系统 ffprobe 是可选的（CI runner 没有 Homebrew ffprobe）：有就必须选中它，没有就必须返回 null。
  const fallbacks = ['/opt/homebrew/bin/ffprobe', 'ffprobe'];
  const systemFfprobe = fallbacks.find(candidate => {
    try { execFileSync(candidate, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
  }) ?? null;
  const selected = await resolveRunnableAudioTool([packaged, ...fallbacks],
    // 全量测试并发时进程 spawn 可能明显变慢：真实探测放宽超时，只影响本测试。
    { timeoutMs: 15_000 });
  assert.notEqual(selected, packaged, 'an unlaunchable packaged path must never be selected');
  assert.equal(selected, systemFfprobe, 'the first working system ffprobe (or none) should be selected');
});
