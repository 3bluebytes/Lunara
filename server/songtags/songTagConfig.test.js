import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSongTagConfig, saveSongTagConfig, isSongTagAutoEnabled, resetSongTagConfigForTest } from './songTagConfig.js';

function makeConfigDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-song-tag-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  resetSongTagConfigForTest();
  t.after(() => {
    delete process.env.LUNARA_CONFIG_DIR;
    delete process.env.SONG_TAG_AUTO;
    resetSongTagConfigForTest();
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('auto 开关持久化到 song-tag.json（0600）；端点字段被忽略', { skip: process.platform === 'win32' ? 'POSIX 文件权限语义,Windows 不适用' : false }, async t => {
  const dir = makeConfigDir(t);
  const { writeFileSync } = await import('node:fs');
  // 旧版文件带端点字段：读取时必须忽略，只保留 auto 语义。
  writeFileSync(join(dir, 'song-tag.json'), JSON.stringify({ baseUrl: 'http://old/v1', model: 'old', auto: true }));
  resetSongTagConfigForTest();
  assert.deepEqual(readSongTagConfig(), { auto: true });
  saveSongTagConfig({ auto: false });
  assert.deepEqual(readSongTagConfig(), { auto: false });
  const mode = statSync(join(dir, 'song-tag.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('auto：env 显式双向覆盖；env 未设置时读持久化开关；损坏文件回落关闭', async t => {
  const dir = makeConfigDir(t);
  saveSongTagConfig({ auto: true });
  assert.equal(isSongTagAutoEnabled({ env: {} }), true);
  assert.equal(isSongTagAutoEnabled({ env: { SONG_TAG_AUTO: '0' } }), false);
  saveSongTagConfig({ auto: false });
  assert.equal(isSongTagAutoEnabled({ env: { SONG_TAG_AUTO: '1' } }), true);
  assert.equal(isSongTagAutoEnabled({ env: {} }), false);

  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'song-tag.json'), '{ broken');
  resetSongTagConfigForTest();
  assert.equal(isSongTagAutoEnabled({ env: {} }), false);
});
