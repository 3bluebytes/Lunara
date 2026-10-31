// backfill.test.js — runBackfill 单测（HTTP backfill + cron 共用的回填逻辑）
//
// 覆盖：
//   - force=false 尊重 needsTagging：只入队"该打标"的，新鲜的跳过，传空 deps
//   - force=true 全量入队且透传 { force:true }
//   - 缺 song_id → noId 计数，不入队
//   - enqueue 返回 false（in-flight 去重）→ 计 skipped
//   - source 'ncm:liked' → provider 'ncm'；year 透传
//   - list 为 null / 缺失 → 安全返回 0，不抛
//
// 全部依赖注入（store/enqueue/loadCandidates），不碰真实 DB / 真实队列 / LLM。
//
// Run: node server/songtags/backfill.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runBackfill } from './backfill.js';

// 防御：万一某条路径意外初始化真实 store，让它落到临时目录而非项目 data/。
process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-backfill-test-')));
process.env.LUNARA_DB_PATH = resolve(process.cwd(), 'data/state.db');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

// needsTagging 为真 ⇔ songId 在集合里
function fakeStore(needIds) {
  const set = new Set(needIds.map(String));
  return { needsTagging: (id) => set.has(String(id)) };
}

// 记录每次 enqueue 的 (song, deps)；returnFor 决定返回 true/false（模拟 in-flight 去重）
function recorder(returnFor = () => true) {
  const calls = [];
  const fn = (song, deps) => { calls.push({ song, deps }); return returnFor(song, deps); };
  fn.calls = calls;
  return fn;
}

const loaderOf = (list) => async () => ({ list });

// ===== 1. force=false 尊重 needsTagging =====
async function testRespectsTtl() {
  console.log('\n--- force=false: only needsTagging songs enqueued ---');
  const cands = [
    { song_id: 'a', title: '晴天', artist: '周杰伦', source: 'ncm:liked', year: 2003 },
    { song_id: 'b', title: 'B', artist: 'X', source: 'qq:playlist:foo' }, // fresh → skip
    { song_id: 'c', title: 'C', artist: 'Y', source: 'ncm:daily' },
  ];
  const enq = recorder();
  const r = await runBackfill({
    force: false, loadCandidates: loaderOf(cands),
    store: fakeStore(['a', 'c']), enqueue: enq,
  });
  assert(r.candidatePool === 3, 'candidatePool counts all loaded');
  assert(r.enqueued === 2, 'only a,c enqueued (b is fresh)');
  assert(r.skipped === 1, 'b skipped via needsTagging=false');
  assert(r.noId === 0, 'no missing-id rows');
  assert(enq.calls.length === 2, 'enqueue called exactly twice');
  assert(enq.calls.every(c => c.deps && Object.keys(c.deps).length === 0), 'force=false passes empty deps');
  assert(enq.calls[0].song.source === 'ncm', "provider derived: 'ncm:liked' → 'ncm'");
  assert(enq.calls[0].song.songId === 'a' && enq.calls[0].song.year === 2003, 'songId + year passed through');
}

// ===== 2. force=true 全量入队，透传 force =====
async function testForce() {
  console.log('\n--- force=true: enqueue all, deps.force=true ---');
  const cands = [
    { song_id: 'a', title: 'A', artist: 'X', source: 'ncm:liked' },
    { song_id: 'b', title: 'B', artist: 'Y', source: 'qq:liked' },
  ];
  const enq = recorder();
  const r = await runBackfill({
    force: true, loadCandidates: loaderOf(cands),
    store: fakeStore([]), // 即使没有一个 needsTagging
    enqueue: enq,
  });
  assert(r.enqueued === 2, 'force ignores needsTagging → all enqueued');
  assert(enq.calls.every(c => c.deps && c.deps.force === true), 'force=true threaded into deps');
}

// ===== 3. 缺 song_id → noId；enqueue=false → skipped =====
async function testNoIdAndDedup() {
  console.log('\n--- missing song_id → noId; enqueue=false → skipped ---');
  const cands = [
    { song_id: 'a', title: 'A', artist: 'X', source: 'ncm:liked' },
    { title: 'NoId', artist: 'Y', source: 'ncm:liked' },        // 无 song_id
    { song_id: 'dup', title: 'Dup', artist: 'Z', source: 'qq:liked' },
  ];
  const enq = recorder((song) => song.songId !== 'dup'); // 'dup' 模拟已在 in-flight
  const r = await runBackfill({
    force: false, loadCandidates: loaderOf(cands),
    store: fakeStore(['a', 'dup']), enqueue: enq,
  });
  assert(r.noId === 1, 'missing song_id counted as noId');
  assert(r.enqueued === 1, 'only a actually enqueued');
  assert(r.skipped === 1, 'dup enqueue=false counted as skipped');
}

// ===== 4. list 为 null / 缺失 → 安全 =====
async function testEmptySafe() {
  console.log('\n--- null/absent list handled safely ---');
  const r1 = await runBackfill({ loadCandidates: async () => ({ list: null }), store: fakeStore([]), enqueue: recorder() });
  assert(r1.candidatePool === 0 && r1.enqueued === 0, 'null list → 0, no throw');
  const r2 = await runBackfill({ loadCandidates: async () => ({}), store: fakeStore([]), enqueue: recorder() });
  assert(r2.candidatePool === 0 && r2.enqueued === 0, 'absent list → 0, no throw');
}

async function testOnlyCurrentCandidatePoolIsScanned() {
  console.log('\n--- only the current bounded candidate pool is scanned ---');
  const songs = Array.from({ length: 80 }, (_, index) => ({
    source: index % 2 ? 'qq:daily' : 'ncm:liked',
    song_id: String(index + 1),
    title: `Song ${index + 1}`,
    artist: 'Artist',
  }));
  let candidateLoads = 0;
  const loadCandidates = async () => { candidateLoads += 1; return { list: songs }; };
  const firstQueue = recorder();
  const first = await runBackfill({
    limit: 25, loadCandidates,
    store: fakeStore(songs.map(song => song.song_id)), enqueue: firstQueue,
  });
  assert(first.source === 'candidates' && candidateLoads === 1, 'manual backfill always loads current candidates');
  assert(first.eligible === 80 && first.enqueued === 25, 'limit bounds enqueue count without creating a library backlog');
  assert(firstQueue.calls.every(call => call.song.provider === 'ncm' || call.song.provider === 'qq'), 'candidate source retains provider-aware identity');
}

async function main() {
  await testRespectsTtl();
  await testForce();
  await testNoIdAndDedup();
  await testEmptySafe();
  await testOnlyCurrentCandidatePoolIsScanned();

  console.log(`\n──────────────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
