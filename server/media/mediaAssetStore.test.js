import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMediaAssetStore, mediaAssetHash, mediaAssetUrl, mediaHashFromUrl,
} from './mediaAssetStore.js';

const BYTES = Buffer.from('ID3\u0003\u0000fake-audio-bytes', 'latin1');

const md5 = value => createHash('md5').update(String(value)).digest('hex');

function okVerifier(calls = []) {
  return async (file) => {
    calls.push(file);
    return { ok: true, reason: null, format: 'mpeg', durationSeconds: 200, verifiedBy: 'decode' };
  };
}

function failVerifier(reason = 'decode-failed') {
  return async () => ({ ok: false, reason, format: 'flac', durationSeconds: null, verifiedBy: 'decode' });
}

function responseOf(bytes = BYTES, { contentLength = bytes.length } = {}) {
  return {
    ok: true,
    headers: { get: name => (name.toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null) },
    body: bytes,
  };
}

async function fixture({ verifier = okVerifier(), fetchImpl = async () => responseOf(), trace = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-assets-'));
  const store = createMediaAssetStore({ getDir: () => dir, verifier, fetchImpl, trace: event => trace.push(event), now: () => 1_000 });
  return { dir, store, trace };
}

test('media hash and url keep the historical naming so existing cache stays reachable', () => {
  assert.equal(mediaAssetHash('qq', '003mksrh3dmBtW'), mediaAssetHash('qq', '003mksrh3dmBtW'));
  assert.notEqual(mediaAssetHash('qq', 'abc'), mediaAssetHash('ncm', 'abc'));
  const url = mediaAssetUrl(mediaAssetHash('qq', 'abc'));
  assert.match(url, /^\/audio\/[a-f0-9]{32}\.mp3$/);
  assert.equal(mediaHashFromUrl(url), mediaAssetHash('qq', 'abc'));
  assert.equal(mediaHashFromUrl('https://cdn.example.test/a.mp3'), null);
  assert.equal(mediaHashFromUrl('/audio/not-a-hash.mp3'), null);
});

test('concurrent requests for one identity share a single download', async () => {
  let fetches = 0;
  const { dir, store } = await fixture({
    fetchImpl: async () => { fetches += 1; await new Promise(resolve => setTimeout(resolve, 10)); return responseOf(); },
  });
  try {
    const [a, b] = await Promise.all([
      store.acquire({ provider: 'qq', songId: 'song-1', url: 'https://provider.test/1', expectedDurationSeconds: 200 }),
      store.acquire({ provider: 'qq', songId: 'song-1', url: 'https://provider.test/1', expectedDurationSeconds: 200 }),
    ]);
    assert.equal(fetches, 1);
    assert.equal(a.url, b.url);
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
    const files = await readdir(dir);
    assert.equal(files.filter(name => name.includes('.part')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a published asset is reused without downloading or verifying again', async () => {
  const verifyCalls = [];
  let fetches = 0;
  const { dir, store } = await fixture({
    verifier: okVerifier(verifyCalls),
    fetchImpl: async () => { fetches += 1; return responseOf(); },
  });
  try {
    const first = await store.acquire({ provider: 'qq', songId: 'song-2', url: 'https://provider.test/2' });
    assert.equal(first.cached, false);
    const second = await store.acquire({ provider: 'qq', songId: 'song-2', url: 'https://provider.test/2' });
    assert.equal(second.cached, true);
    assert.equal(fetches, 1);
    assert.equal(verifyCalls.length, 1);
    const meta = JSON.parse(await readFile(join(dir, `${mediaAssetHash('qq', 'song-2')}.json`), 'utf8'));
    assert.equal(meta.status, 'ready');
    assert.equal(meta.bytes, BYTES.length);
    assert.equal(meta.provider, 'qq');
    assert.equal(meta.songId, 'song-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed verification never publishes the file and records a broken sidecar', async () => {
  const { dir, store, trace } = await fixture({ verifier: failVerifier('decode-failed') });
  try {
    const result = await store.acquire({ provider: 'qq', songId: 'song-3', url: 'https://provider.test/3' });
    assert.equal(result, null);
    const files = await readdir(dir);
    assert.ok(!files.some(name => name.endsWith('.mp3')), 'no published media file');
    assert.ok(!files.some(name => name.includes('.part')), 'no leftover part file');
    const meta = JSON.parse(await readFile(join(dir, `${mediaAssetHash('qq', 'song-3')}.json`), 'utf8'));
    assert.equal(meta.status, 'broken');
    assert.equal(meta.reason, 'decode-failed');
    assert.equal(trace.at(-1).event, 'media-asset-verify-failed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('byte count mismatch is treated as an incomplete download', async () => {
  const { dir, store } = await fixture({ fetchImpl: async () => responseOf(BYTES, { contentLength: BYTES.length + 5 }) });
  try {
    assert.equal(await store.acquire({ provider: 'qq', songId: 'song-4', url: 'https://provider.test/4' }), null);
    const meta = JSON.parse(await readFile(join(dir, `${mediaAssetHash('qq', 'song-4')}.json`), 'utf8'));
    assert.equal(meta.status, 'broken');
    assert.equal(meta.reason, 'byte-count-mismatch');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy files are verified once before being trusted', async () => {
  const verifyCalls = [];
  const { dir, store } = await fixture({ verifier: okVerifier(verifyCalls) });
  try {
    const hash = mediaAssetHash('qq', 'song-5');
    await writeFile(join(dir, `${hash}.mp3`), BYTES);
    const acquired = await store.acquire({ provider: 'qq', songId: 'song-5', url: 'https://provider.test/5' });
    assert.equal(acquired.cached, true);
    assert.equal(verifyCalls.length, 1);
    const meta = JSON.parse(await readFile(join(dir, `${hash}.json`), 'utf8'));
    assert.equal(meta.status, 'ready');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy corrupt files are isolated and replaced by a verified download', async () => {
  let fetches = 0;
  const dir = await mkdtemp(join(tmpdir(), 'lunara-assets-'));
  try {
    const hash = mediaAssetHash('qq', 'song-6');
    await writeFile(join(dir, `${hash}.mp3`), Buffer.from('corrupt-legacy-bytes'));
    // 第一次接触：校验失败 → 隔离 → 本次下载仍未通过校验（模拟供应商仍给坏字节）
    const failing = createMediaAssetStore({
      getDir: () => dir,
      verifier: async () => ({ ok: false, reason: 'decode-failed' }),
      fetchImpl: async () => { fetches += 1; return responseOf(); },
      now: () => 1_000,
    });
    assert.equal(await failing.acquire({ provider: 'qq', songId: 'song-6', url: 'https://provider.test/6' }), null);
    let meta = JSON.parse(await readFile(join(dir, `${hash}.json`), 'utf8'));
    assert.equal(meta.status, 'broken');
    assert.equal(meta.reason, 'decode-failed');
    assert.equal(fetches, 1);
    // 冷却期过后重新下载：这次校验通过，坏字节被替换
    const recovering = createMediaAssetStore({
      getDir: () => dir,
      verifier: okVerifier(),
      fetchImpl: async () => { fetches += 1; return responseOf(); },
      now: () => 1_000 + 60 * 60_000,
    });
    const second = await recovering.acquire({ provider: 'qq', songId: 'song-6', url: 'https://provider.test/6' });
    assert.equal(second.cached, false);
    assert.equal(fetches, 2);
    meta = JSON.parse(await readFile(join(dir, `${hash}.json`), 'utf8'));
    assert.equal(meta.status, 'ready');
    assert.equal((await readFile(join(dir, `${hash}.mp3`))).toString(), BYTES.toString());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a broken identity within the cooldown fails closed without downloading again', async () => {
  let fetches = 0;
  const { dir } = await fixture();
  const store = createMediaAssetStore({
    getDir: () => dir,
    verifier: failVerifier('decode-failed'),
    fetchImpl: async () => { fetches += 1; return responseOf(); },
    now: () => 1_000,
  });
  try {
    assert.equal(await store.acquire({ provider: 'qq', songId: 'song-7', url: 'https://provider.test/7' }), null);
    assert.equal(await store.acquire({ provider: 'qq', songId: 'song-7', url: 'https://provider.test/7' }), null);
    assert.equal(fetches, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('playback failure quarantines only local assets and never touches external urls', async () => {
  const { dir, store } = await fixture();
  try {
    const acquired = await store.acquire({ provider: 'qq', songId: 'song-8', url: 'https://provider.test/8' });
    const quarantined = await store.quarantineByUrl(acquired.url, { reason: 'playback-failed' });
    assert.equal(quarantined.provider, 'qq');
    assert.equal(quarantined.songId, 'song-8');
    const meta = JSON.parse(await readFile(join(dir, `${mediaAssetHash('qq', 'song-8')}.json`), 'utf8'));
    assert.equal(meta.status, 'broken');
    assert.equal(meta.reason, 'playback-failed');
    assert.equal(await store.quarantineByUrl('https://cdn.example.test/x.mp3'), null);
    assert.equal(await store.quarantineByUrl(null), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a quarantined asset is re-downloaded on the next resolution', async () => {
  let fetches = 0;
  const { dir } = await fixture({ fetchImpl: async () => { fetches += 1; return responseOf(); } });
  const store = createMediaAssetStore({
    getDir: () => dir,
    verifier: okVerifier(),
    fetchImpl: async () => { fetches += 1; return responseOf(); },
    now: () => 5_000,
    brokenCooldownMs: 60_000,
  });
  try {
    const first = await store.acquire({ provider: 'qq', songId: 'song-9', url: 'https://provider.test/9' });
    assert.equal(fetches, 1);
    await store.quarantineByUrl(first.url);
    const second = await store.acquire({ provider: 'qq', songId: 'song-9', url: 'https://provider.test/9' });
    assert.equal(second.cached, false);
    assert.equal(fetches, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('historical naming is frozen for the two onboarded providers', () => {
  // 冻结：既有 URL、播放账本与队列项里的 /audio/<hash>.mp3 必须继续有效。
  assert.equal(mediaAssetHash('qq', 'abc'), md5('qq:abc'));
  assert.equal(mediaAssetHash('ncm', 'abc'), md5('abc'));
});

test('a provider other than ncm can never share the historical namespace', () => {
  const sharedId = '1234567'; // 中文流媒体的 songId 普遍是纯数字，跨源同号很常见
  assert.notEqual(mediaAssetHash('ncm', sharedId), mediaAssetHash('kugou', sharedId));
  assert.notEqual(mediaAssetHash('kugou', sharedId), mediaAssetHash('migu', sharedId));
  assert.equal(mediaAssetHash('kugou', sharedId), md5(`kugou:${sharedId}`));
});

test('an unidentifiable provider fails closed before touching the cache dir', async () => {
  for (const provider of [undefined, null, '', '   ']) {
    assert.throws(() => mediaAssetHash(provider, 'abc'), TypeError);
  }
  const { dir, store } = await fixture();
  try {
    await assert.rejects(
      store.acquire({ songId: 'abc', url: 'https://provider.test/x' }),
      TypeError,
    );
    assert.deepEqual(await readdir(dir), [], 'no asset is created without a provider identity');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a cached asset must prove the identity it claims', async () => {
  let fetches = 0;
  const { dir, store } = await fixture();
  const ncmHash = mediaAssetHash('ncm', '123');
  const kugouHash = mediaAssetHash('kugou', '123');
  try {
    await store.acquire({ provider: 'ncm', songId: '123', url: 'https://provider.test/n', expectedDurationSeconds: 200 });
    // 模拟「共享命名空间」遗留：把另一个身份的字节错放到本源的哈希位置。
    await writeFile(join(dir, `${kugouHash}.mp3`), await readFile(join(dir, `${ncmHash}.mp3`)));
    const foreignMeta = JSON.parse(await readFile(join(dir, `${ncmHash}.json`), 'utf8'));
    await writeFile(join(dir, `${kugouHash}.json`), JSON.stringify({ ...foreignMeta, hash: kugouHash }));

    const fresh = createMediaAssetStore({
      getDir: () => dir,
      verifier: okVerifier(),
      fetchImpl: async () => { fetches += 1; return responseOf(); },
      now: () => 2_000,
    });
    const result = await fresh.acquire({ provider: 'kugou', songId: '123', url: 'https://provider.test/k', expectedDurationSeconds: 200 });

    assert.equal(fetches, 1, 'foreign bytes are not reused, a real download happens');
    assert.equal(result.cached, false);
    const adopted = JSON.parse(await readFile(join(dir, `${kugouHash}.json`), 'utf8'));
    assert.equal(adopted.provider, 'kugou', 'the sidecar now describes this identity');
    assert.equal(String(adopted.songId), '123');
    const sourceMeta = JSON.parse(await readFile(join(dir, `${ncmHash}.json`), 'utf8'));
    assert.equal(sourceMeta.provider, 'ncm', 'the other identity keeps its own asset untouched');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a legacy file at our own hash position is still verified once and adopted', async () => {
  const verifyCalls = [];
  const { dir, store } = await fixture({ verifier: okVerifier(verifyCalls) });
  const hash = mediaAssetHash('kugou', 'legacy-1');
  try {
    await writeFile(join(dir, `${hash}.mp3`), BYTES);
    const acquired = await store.acquire({ provider: 'kugou', songId: 'legacy-1', url: 'https://provider.test/l' });
    assert.equal(acquired.cached, true);
    assert.equal(verifyCalls.length, 1);
    const meta = JSON.parse(await readFile(join(dir, `${hash}.json`), 'utf8'));
    assert.equal(meta.provider, 'kugou');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted download is retried once and still lands the asset', async () => {
  let fetches = 0;
  const trace = [];
  const { dir, store } = await fixture({
    trace,
    fetchImpl: async () => {
      fetches += 1;
      if (fetches === 1) {
        // 上游把流掐断时的真实形状：只有 code，没有可读原因。
        throw Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
      }
      return responseOf();
    },
  });
  try {
    const acquired = await store.acquire({ provider: 'qq', songId: 'song-retry', url: 'https://provider.test/r' });
    assert.ok(acquired?.url, 'retry must publish the asset');
    assert.equal(fetches, 2);
    assert.ok(trace.some(event => event.event === 'media-asset-retry'), 'the retry is traceable');
    const meta = JSON.parse(await readFile(join(dir, `${mediaAssetHash('qq', 'song-retry')}.json`), 'utf8'));
    assert.equal(meta.status, 'ready');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a transient download failure never puts the asset into a cooldown', async () => {
  let fetches = 0;
  let broken = true;
  const { dir, store } = await fixture({
    fetchImpl: async () => {
      fetches += 1;
      if (broken) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return responseOf();
    },
  });
  try {
    assert.equal(await store.acquire({ provider: 'qq', songId: 'song-cooldown', url: 'https://provider.test/c' }), null);
    assert.equal(fetches, 2, 'one immediate retry inside the same acquisition');
    const brokenMeta = JSON.parse(await readFile(join(dir, `${mediaAssetHash('qq', 'song-cooldown')}.json`), 'utf8'));
    assert.equal(brokenMeta.status, 'broken');
    assert.equal(brokenMeta.reason, 'download-failed', 'transient failures are classified, not collapsed into verify-failed');
    assert.equal(brokenMeta.retryable, true, 'transient failures are marked retryable instead of cooled down');

    broken = false;
    const acquired = await store.acquire({ provider: 'qq', songId: 'song-cooldown', url: 'https://provider.test/c' });
    assert.ok(acquired?.url, 'the next resolution retries immediately instead of waiting out a cooldown');
    assert.equal(fetches, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
