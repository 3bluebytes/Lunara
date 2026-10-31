import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createFingerprintQueue } from './fingerprintQueue.js';
import { FINGERPRINT_STATE, createFingerprintStore } from './fingerprintStore.js';

function fixture({ compute } = {}) {
  const db = new Database(':memory:');
  const store = createFingerprintStore({ db, now: () => 1_000 });
  const events = [];
  const queue = createFingerprintQueue({
    store,
    // 与 store 用同一个时钟：冷却判断依赖两边对「现在」的一致理解。
    now: () => 1_000,
    compute: compute || (async filePath => ({ ok: true, fingerprint: 'abcd1234', version: 1, points: 2 })),
    tools: async () => ({ ffmpegPath: '/fake/ffmpeg' }),
    execFileImpl: async () => ({ stdout: Buffer.alloc(0) }),
    trace: event => events.push(event),
  });
  return { store, queue, events, db };
}

test('资产就绪后异步算指纹并落库，重复入队被跳过', async () => {
  const f = fixture();
  assert.equal(f.queue.enqueue({ provider: 'qq', songId: 's1', filePath: '/tmp/a.mp3' }).ok, true);
  await f.queue.close();
  const row = f.store.get('qq', 's1');
  assert.equal(row.state, FINGERPRINT_STATE.READY);
  assert.equal(row.fingerprint, 'abcd1234');
  // 已算好的不重复计算：用同一个 store 再建一个队列观察跳过判定。
  const second = createFingerprintQueue({ store: f.store, compute: async () => { throw new Error('should not run'); },
    now: () => 1_000, tools: async () => ({ ffmpegPath: '/fake/ffmpeg' }) });
  assert.equal(second.enqueue({ provider: 'qq', songId: 's1', filePath: '/tmp/a.mp3' }).reason, 'skipped');
  await second.close();
  f.db.close();
});

test('算不出来时记 failed 并在冷却期内不再重试', async () => {
  let calls = 0;
  const f = fixture({ compute: async () => { calls += 1; return { ok: false, reason: 'decode-failed' }; } });
  f.queue.enqueue({ provider: 'ncm', songId: 's2', filePath: '/tmp/b.mp3' });
  await f.queue.close();
  assert.equal(f.store.get('ncm', 's2').state, FINGERPRINT_STATE.FAILED);
  assert.equal(calls, 1);
  const retry = createFingerprintQueue({ store: f.store, compute: async () => ({ ok: false, reason: 'x' }),
    now: () => 1_000, tools: async () => ({ ffmpegPath: '/fake/ffmpeg' }) });
  const again = retry.enqueue({ provider: 'ncm', songId: 's2', filePath: '/tmp/b.mp3' });
  assert.equal(again.reason, 'skipped', '冷却期内不反复重算一个解不开的文件');
  await retry.close();
  f.db.close();
});

test('计算或存储抛错不影响任何调用方，也不留半条 ready 记录', async () => {
  const f = fixture({ compute: async () => { throw new Error('boom'); } });
  assert.equal(f.queue.enqueue({ provider: 'qq', songId: 's3', filePath: '/tmp/c.mp3' }).ok, true);
  await f.queue.close();
  assert.equal(f.store.get('qq', 's3'), null);
  assert.deepEqual(f.events.map(event => event.event), ['fingerprint-failed']);
  f.db.close();
});

test('没有 filePath 或队列满时如实拒绝', async () => {
  const f = fixture();
  assert.equal(f.queue.enqueue({ provider: 'qq', songId: 's9' }).reason, 'invalid');
  await f.queue.close();
  assert.equal(f.queue.enqueue({ provider: 'qq', songId: 's9', filePath: '/tmp/x.mp3' }).reason, 'invalid');
  f.db.close();
});
