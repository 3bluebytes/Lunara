import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// 数据根必须在 import 音乐源模块之前指向临时目录：cacheAudio 会惰性建缓存目录。
const dataDir = await mkdtemp(join(tmpdir(), 'lunara-wiring-'));
process.env.LUNARA_DATA_DIR = dataDir;

const { __setMediaAssetStoreForTest } = await import('./sharedMediaAssets.js');
const qq = await import('../qq.js');
const ncm = await import('../ncm.js');

test('qq and ncm cache audio through the shared media asset store', async () => {
  const calls = [];
  __setMediaAssetStoreForTest({
    acquire: async input => { calls.push(input); return { url: `/audio/${input.provider}.mp3`, cached: false }; },
  });
  try {
    const qqResult = await qq.cacheAudio('song-1', 'https://provider.test/1', { expectedDurationSeconds: 200 });
    const ncmResult = await ncm.cacheAudio('song-2', 'https://provider.test/2');
    assert.deepEqual(calls, [
      { provider: 'qq', songId: 'song-1', url: 'https://provider.test/1', expectedDurationSeconds: 200 },
      { provider: 'ncm', songId: 'song-2', url: 'https://provider.test/2', expectedDurationSeconds: 0 },
    ]);
    assert.equal(qqResult.url, '/audio/qq.mp3');
    assert.equal(ncmResult.url, '/audio/ncm.mp3');
    assert.equal(await qq.cacheAudio('song-3', ''), null, 'no url means no asset request');
    assert.equal(calls.length, 2);
  } finally {
    __setMediaAssetStoreForTest(null);
    await rm(dataDir, { recursive: true, force: true });
  }
});
