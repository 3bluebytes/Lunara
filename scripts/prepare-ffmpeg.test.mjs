import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  MACOS_ARM64_FFMPEG,
  assertFfmpegRedistributable,
  ensureRedistributableFfmpeg,
  isRedistributableLicenseOutput,
} from './prepare-ffmpeg.mjs';

test('isRedistributableLicenseOutput accepts GPL/LGPL and rejects nonfree banners', () => {
  assert.equal(isRedistributableLicenseOutput('ffmpeg is free software ... GNU General Public License'), true);
  assert.equal(isRedistributableLicenseOutput('GNU Lesser General Public License'), true);
  assert.equal(
    isRedistributableLicenseOutput('configuration: --enable-gpl --enable-nonfree\nGNU General Public License\nThis version of ffmpeg has nonfree parts compiled in.\nTherefore it is not legally redistributable.'),
    false,
  );
  assert.equal(isRedistributableLicenseOutput(''), false);
});

test('assertFfmpegRedistributable rejects binaries with nonfree output', () => {
  assert.throws(
    () => assertFfmpegRedistributable('/fake/ffmpeg', {
      spawnImpl: () => ({
        status: 0,
        stdout: 'This version of ffmpeg has nonfree parts compiled in. Therefore it is not legally redistributable.',
        stderr: '',
      }),
    }),
    /nonfree|禁止公开发布/,
  );
});

test('ensureRedistributableFfmpeg keeps already-compliant binary without downloading', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunara-prep-ok-'));
  try {
    const targetPath = join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    mkdirSync(join(root, 'node_modules', 'ffmpeg-static'), { recursive: true });
    writeFileSync(targetPath, 'already-gpl-binary');

    let downloaded = false;
    const res = await ensureRedistributableFfmpeg({
      platform: 'darwin',
      arch: 'arm64',
      root,
      targetPath,
      spawnImpl: () => ({ status: 0, stdout: 'GNU General Public License', stderr: '' }),
      downloadImpl: async () => { downloaded = true; },
    });

    assert.equal(downloaded, false);
    assert.deepEqual(res, { ok: true, replaced: false, targetPath });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureRedistributableFfmpeg replaces nonfree macOS arm64 binary and clears stale license files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunara-prep-replace-'));
  try {
    const dir = join(root, 'node_modules', 'ffmpeg-static');
    const targetPath = join(dir, 'ffmpeg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(targetPath, 'nonfree-old');
    writeFileSync(`${targetPath}.LICENSE`, 'stale license');
    writeFileSync(`${targetPath}.README`, 'stale readme');

    const fakeZipBytes = Buffer.from('fake-zip-archive');
    const fakeZipSha = createHash('sha256').update(fakeZipBytes).digest('hex');

    const res = await ensureRedistributableFfmpeg({
      platform: 'darwin',
      arch: 'arm64',
      root,
      targetPath,
      env: { LUNARA_MACOS_FFMPEG_SHA256: fakeZipSha },
      spawnImpl: () => {
        const content = readFileSync(targetPath, 'utf8');
        if (content === 'nonfree-old') {
          return { status: 0, stdout: 'This version of ffmpeg has nonfree parts compiled in.', stderr: '' };
        }
        return { status: 0, stdout: 'GNU General Public License', stderr: '' };
      },
      downloadImpl: async (_url, dest) => {
        writeFileSync(dest, fakeZipBytes);
      },
      extractZipImpl: (_zip, outDir) => {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'ffmpeg'), 'clean-gpl-binary');
      },
      log: { log() {}, warn() {} },
    });

    assert.equal(res.ok, true);
    assert.equal(res.replaced, true);
    assert.equal(readFileSync(targetPath, 'utf8'), 'clean-gpl-binary');
    assert.equal(existsSync(`${targetPath}.LICENSE`), false);
    assert.equal(existsSync(`${targetPath}.README`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureRedistributableFfmpeg aborts on SHA-256 mismatch without touching target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunara-prep-sha-'));
  try {
    const dir = join(root, 'node_modules', 'ffmpeg-static');
    const targetPath = join(dir, 'ffmpeg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(targetPath, 'nonfree-old');

    await assert.rejects(
      () => ensureRedistributableFfmpeg({
        platform: 'darwin',
        arch: 'arm64',
        root,
        targetPath,
        env: { LUNARA_MACOS_FFMPEG_SHA256: MACOS_ARM64_FFMPEG.sha256 },
        spawnImpl: () => ({ status: 0, stdout: 'nonfree', stderr: '' }),
        downloadImpl: async (_url, dest) => {
          writeFileSync(dest, 'tampered-bytes');
        },
        log: { log() {}, warn() {} },
      }),
      /SHA-256 校验失败/,
    );
    assert.equal(readFileSync(targetPath, 'utf8'), 'nonfree-old');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureRedistributableFfmpeg validates Windows binary strictly without downloading macOS archive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lunara-prep-win-'));
  try {
    const dir = join(root, 'node_modules', 'ffmpeg-static');
    const targetPath = join(dir, 'ffmpeg.exe');
    mkdirSync(dir, { recursive: true });
    writeFileSync(targetPath, 'win-nonfree');

    let downloaded = false;
    await assert.rejects(
      () => ensureRedistributableFfmpeg({
        platform: 'win32',
        arch: 'x64',
        root,
        targetPath,
        spawnImpl: () => ({ status: 0, stdout: 'nonfree', stderr: '' }),
        downloadImpl: async () => { downloaded = true; },
      }),
      /nonfree|禁止公开发布/,
    );
    assert.equal(downloaded, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
