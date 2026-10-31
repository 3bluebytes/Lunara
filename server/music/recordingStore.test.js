// recordingStore.test.js — 跨源录音身份层的不变量。
//
// 这一层要守住的东西：
// 1. 没有任何等价关系时，一首歌的 recording 就是它自己，**不写任何行**（零迁移）。
// 2. 只有用户确认与 ISRC 能建立等价关系；指纹与元数据相似度只能提议，不能落库。
// 3. 建立/撤销都幂等，且保留可追溯的决定与撤回凭据。
// 4. 合并两组时成员不丢、代表源粘住不放。
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RecordingStore } from './recordingStore.js';

async function fixture({ now = () => 1_000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-recording-'));
  const store = new RecordingStore({ dbPath: join(dir, 'state.db'), now });
  store.initialize();
  return { dir, store, cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

const A = { provider: 'qq', songId: 'qq-1' };
const B = { provider: 'ncm', songId: '12345' };

test('without any equivalence a track is its own recording, and nothing is written', async () => {
  const { store, cleanup } = await fixture();
  try {
    const identity = store.recordingOf('qq', 'qq-1');
    assert.equal(identity.isSelf, true);
    assert.deepEqual(identity.members, A);
    assert.equal(store.stats().recordings, 0, 'unmerged tracks must not create rows');
    assert.equal(store.stats().members, 0);
    // 同一个身份两次查询得到同一个自我 id。
    assert.equal(store.recordingOf('qq', 'qq-1').recordingId, store.recordingOf('QQ ', ' qq-1 ').recordingId);
  } finally {
    await cleanup();
  }
});

test('a user confirmation links two sources into one recording', async () => {
  const { store, cleanup } = await fixture();
  try {
    const result = store.link({ a: A, b: B, kind: 'user-confirmed', decidedBy: 'listener' });
    assert.equal(result.ok, true);
    assert.equal(result.created, true);
    assert.equal(store.recordingOf('qq', 'qq-1').recordingId, result.recordingId);
    assert.equal(store.recordingOf('ncm', '12345').recordingId, result.recordingId);
    assert.equal(store.recordingOf('ncm', '12345').isSelf, false);
    // 成员顺序不是契约；只要两个身份都在同一组里。
    assert.deepEqual(store.membersOf(result.recordingId).map(m => `${m.provider}:${m.songId}`).sort(),
      ['ncm:12345', 'qq:qq-1']);
    assert.equal(store.stats().recordings, 1);
    assert.equal(store.stats().members, 2);
  } finally {
    await cleanup();
  }
});

test('linking is idempotent and never duplicates members', async () => {
  const { store, cleanup } = await fixture();
  try {
    const first = store.link({ a: A, b: B, kind: 'user-confirmed' });
    const again = store.link({ a: A, b: B, kind: 'user-confirmed' });
    assert.equal(again.recordingId, first.recordingId);
    assert.equal(again.created, false);
    assert.equal(store.stats().members, 2);
    // 顺序无关。
    const reversed = store.link({ a: B, b: A, kind: 'user-confirmed' });
    assert.equal(reversed.recordingId, first.recordingId);
    assert.equal(store.stats().members, 2);
    // 自己连自己不是错误，也不是新关系。
    assert.equal(store.link({ a: A, b: A, kind: 'user-confirmed' }).recordingId, first.recordingId);
    assert.equal(store.stats().recordings, 1);
  } finally {
    await cleanup();
  }
});

test('heuristics and fingerprints can never be written as equivalence', async () => {
  const { store, cleanup } = await fixture();
  try {
    for (const kind of ['heuristic', 'fingerprint', 'metadata-similarity', 'duration-match', '']) {
      assert.throws(() => store.link({ a: A, b: B, kind }), /kind/, `kind=${kind} must be rejected`);
    }
    assert.equal(store.stats().recordings, 0);
    assert.equal(store.recordingOf('qq', 'qq-1').isSelf, true);
  } finally {
    await cleanup();
  }
});

test('isrc is accepted as authoritative evidence', async () => {
  const { store, cleanup } = await fixture();
  try {
    const result = store.link({ a: A, b: B, kind: 'isrc', evidence: { isrc: 'CN-A01-05-00001' } });
    assert.equal(result.ok, true);
    assert.deepEqual(store.decisions(result.recordingId).map(d => d.kind), ['isrc']);
    assert.deepEqual(store.decisions(result.recordingId)[0].evidence, { isrc: 'CN-A01-05-00001' });
  } finally {
    await cleanup();
  }
});

test('merging two groups keeps every member and the surviving representative', async () => {
  const { store, cleanup } = await fixture();
  try {
    const left = store.link({ a: A, b: { provider: 'kugou', songId: 'k-1' }, kind: 'user-confirmed' });
    store.setRepresentative({ recordingId: left.recordingId, ...A });
    const right = store.link({ a: B, b: { provider: 'migu', songId: 'm-1' }, kind: 'user-confirmed' });
    assert.notEqual(left.recordingId, right.recordingId);

    const merged = store.link({ a: A, b: B, kind: 'user-confirmed' });
    assert.equal(merged.merged, true);
    assert.equal(store.stats().recordings, 1, 'the absorbed recording no longer exists as its own group');
    assert.deepEqual(store.membersOf(merged.recordingId).map(m => `${m.provider}:${m.songId}`).sort(),
      ['kugou:k-1', 'migu:m-1', 'ncm:12345', 'qq:qq-1']);
    // 代表源粘住在先设定的那个，不被合并顺手改掉。
    assert.deepEqual(store.representativeOf(merged.recordingId), { provider: 'qq', songId: 'qq-1' });
    // 被吸收那一组的决定仍可追溯到最终录音上。
    const kinds = store.decisions(merged.recordingId).map(d => d.kind).sort();
    assert.equal(kinds.length >= 3, true, `expected the absorbed decisions to be re-pointed, got ${kinds}`);
  } finally {
    await cleanup();
  }
});

test('unlinking returns both sides to standalone identities and keeps the audit trail', async () => {
  const { store, cleanup } = await fixture();
  try {
    const created = store.link({ a: A, b: B, kind: 'user-confirmed', decidedBy: 'listener' });
    assert.equal(store.recordingOf('ncm', '12345').isSelf, false);

    const removed = store.unlink({ recordingId: created.recordingId, provider: 'ncm', songId: '12345', decidedBy: 'listener' });
    assert.equal(removed.ok, true);
    assert.equal(store.recordingOf('qq', 'qq-1').isSelf, true);
    assert.equal(store.recordingOf('ncm', '12345').isSelf, true);
    assert.equal(store.stats().recordings, 0, 'a one-member group dissolves');

    // 撤销留下了凭据：原决定被标记撤回，并有一条 unlink 记录。
    const trail = store.decisions(created.recordingId);
    assert.equal(trail.some(d => d.revokedAt != null), true);
    assert.equal(trail.some(d => d.kind === 'unlink'), true);
  } finally {
    await cleanup();
  }
});

test('unlinking a member from a group of three keeps the rest together', async () => {
  const { store, cleanup } = await fixture();
  try {
    const created = store.link({ a: A, b: B, kind: 'user-confirmed' });
    store.link({ a: A, b: { provider: 'kugou', songId: 'k-1' }, kind: 'user-confirmed' });
    const removed = store.unlink({ recordingId: created.recordingId, provider: 'ncm', songId: '12345' });
    assert.equal(removed.ok, true);
    assert.equal(store.recordingOf('ncm', '12345').isSelf, true);
    assert.equal(store.recordingOf('qq', 'qq-1').recordingId, created.recordingId);
    assert.deepEqual(store.membersOf(created.recordingId).map(m => m.provider).sort(), ['kugou', 'qq']);
  } finally {
    await cleanup();
  }
});

test('the representative is sticky and only changes when asked', async () => {
  const { store, cleanup } = await fixture();
  try {
    const created = store.link({ a: A, b: B, kind: 'user-confirmed' });
    // 默认代表源是建立关系时用户实际点的那一侧。
    assert.deepEqual(store.representativeOf(created.recordingId), { provider: 'qq', songId: 'qq-1' });
    store.setRepresentative({ recordingId: created.recordingId, provider: 'ncm', songId: '12345' });
    assert.deepEqual(store.representativeOf(created.recordingId), { provider: 'ncm', songId: '12345' });
    // 缺省身份没有代表源概念。
    assert.equal(store.representativeOf(store.recordingOf('kugou', 'solo').recordingId), null);
  } finally {
    await cleanup();
  }
});

test('invalid identities are rejected instead of silently becoming self identities', async () => {
  const { store, cleanup } = await fixture();
  try {
    assert.throws(() => store.recordingOf('', 'x'), /provider/);
    assert.throws(() => store.recordingOf('qq', ''), /songId/);
    assert.throws(() => store.link({ a: { provider: 'qq', songId: '' }, b: B, kind: 'user-confirmed' }), /songId/);
    assert.equal(store.unlink({ recordingId: 'missing', provider: 'qq', songId: 'x' }).ok, false);
  } finally {
    await cleanup();
  }
});

test('identities survive a reopen: the mapping is persisted, not held in memory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lunara-recording-'));
  try {
    const dbPath = join(dir, 'state.db');
    const first = new RecordingStore({ dbPath, now: () => 1_000 });
    first.initialize();
    const created = first.link({ a: A, b: B, kind: 'user-confirmed' });
    first.close();

    const reopened = new RecordingStore({ dbPath, now: () => 2_000 });
    reopened.initialize();
    assert.equal(reopened.recordingOf('ncm', '12345').recordingId, created.recordingId);
    assert.deepEqual(reopened.membersOf(created.recordingId).length, 2);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recordingOf exposes the sticky representative so callers do not re-query', async () => {
  const { store, cleanup } = await fixture();
  try {
    const created = store.link({ a: A, b: B, kind: 'user-confirmed' });
    assert.deepEqual(store.recordingOf('ncm', '12345').representative, { provider: 'qq', songId: 'qq-1' });
    store.setRepresentative({ recordingId: created.recordingId, provider: 'ncm', songId: '12345' });
    assert.deepEqual(store.recordingOf('qq', 'qq-1').representative, { provider: 'ncm', songId: '12345' });
    assert.equal(store.recordingOf('kugou', 'solo').representative, null);
  } finally {
    await cleanup();
  }
});

test('第一次播出决定代表源，重复展示与换源播放都不动它', () => {
  const db = new RecordingStore({ dbPath: ':memory:', now: () => 1000 }).initialize();
  const { recordingId } = db.link({ a: { provider: 'qq', songId: 'q1' }, b: { provider: 'ncm', songId: 'n1' },
    kind: 'user-confirmed' });
  // 合并时按注册表优先级先定一个代表源；粘性从这一刻开始。
  const initial = db.representativeOf(recordingId);
  assert.ok(initial && initial.provider, '合并后有代表源');
  assert.deepEqual(db.notePlayback({ provider: 'ncm', songId: 'n1' }),
    initial.provider === 'ncm'
      ? { ok: true, changed: false, reason: 'representative-played' }
      : { ok: true, changed: false, reason: 'played-other-member' });
  assert.deepEqual(db.representativeOf(recordingId), initial, '换一个源播出不改代表源');
  // 再从另一个成员播出来：只留观察，不换代表源（否则用户会觉得「我的歌被换了」）。
  assert.deepEqual(db.representativeOf(recordingId), initial);
  // 老关系可能没有代表源：第一次真正播出才指定，并留一条 first-playback。
  const legacy = new RecordingStore({ dbPath: ':memory:', now: () => 1500 }).initialize();
  const linked = legacy.link({ a: { provider: 'qq', songId: 'q1' }, b: { provider: 'ncm', songId: 'n1' },
    kind: 'user-confirmed' });
  legacy.db.prepare('UPDATE recording SET representative_provider=NULL, representative_song_id=NULL WHERE recording_id=?').run(linked.recordingId);
  assert.deepEqual(legacy.notePlayback({ provider: 'ncm', songId: 'n1' }),
    { ok: true, changed: true, reason: 'first-playback' });
  assert.deepEqual(legacy.representativeOf(linked.recordingId), { provider: 'ncm', songId: 'n1' });
  assert.deepEqual(legacy.representativeHistory(linked.recordingId).map(row => row.reason), ['first-playback']);
  legacy.close();
  const history = db.representativeHistory(recordingId);
  assert.equal(history.length, 1, '只留一次漂移观察，不含这次播放以外的写入');
  assert.equal(history[0].reason, 'played-other-member');
  assert.deepEqual(history[0].from, initial);
  db.close();
});

test('切换代表源必须带原因并留痕；非成员或未合并不写任何行', () => {
  const db = new RecordingStore({ dbPath: ':memory:', now: () => 2000 }).initialize();
  const { recordingId } = db.link({ a: { provider: 'qq', songId: 'q1' }, b: { provider: 'ncm', songId: 'n1' },
    kind: 'user-confirmed' });
  assert.equal(db.notePlayback({ provider: 'qq', songId: 'unmerged' }).ok, false);
  assert.deepEqual(db.setRepresentative({ recordingId, provider: 'qq', songId: 'other' }),
    { ok: false, reason: 'not-a-member' });
  db.setRepresentative({ recordingId, provider: 'qq', songId: 'q1', reason: 'first-playback' });
  const switched = db.setRepresentative({ recordingId, provider: 'ncm', songId: 'n1',
    reason: 'representative-unavailable' });
  assert.equal(switched.ok, true);
  assert.deepEqual(switched.previous, { provider: 'qq', songId: 'q1' });
  const history = db.representativeHistory(recordingId);
  assert.deepEqual(history.map(row => row.reason), ['first-playback', 'representative-unavailable']);
  assert.deepEqual(history[1].from, { provider: 'qq', songId: 'q1' });
  assert.equal(db.representativeHistory('self:qq:q1').length, 0, '自指身份不产生历史');
  db.close();
});
