// taggingQueue.test.js — PR3 集成 smoke：串行打标队列
//
// 覆盖（对应 openspec task 4.2 / 4.6）：
//   - 队列驱动真实 generateSongTags（mock LLM/歌词）→ song_tags 落库 + stats.done
//   - in-flight 去重：同一 songId 重复入队第二次被忽略
//   - 失败统计：generator 抛错 → stats.failed + recentFailures
//   - 占位统计：generator 返回 confidence=0 → stats.placeholders（非 done）
//   - waitIdle 在排空后返回
//
// Run: node server/songtags/taggingQueue.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SongTagStore } from './songTagStore.js';
import {
  enqueueTagging, queueStats, idle, waitIdle,
  __setGeneratorForTest, __resetForTest,
} from './taggingQueue.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-tagqueue-test-')));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

let _n = 0;
function fresh() {
  _n += 1;
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `data/state-${_n}.db`);
  const s = new SongTagStore();
  s.initialize();
  return s;
}

// 真实 generateSongTags 的注入依赖（mock 掉 LLM + 歌词抓取）
function mockDeps(store, opts = {}) {
  return {
    store,
    ask: async (prompt) => {
      if (prompt.includes('音乐艺人信息助手')) {
        return JSON.stringify({ recognized: true, gender: 'male', genre: '流行', region: '华语', confidence: 0.9 });
      }
      return JSON.stringify(opts.song || {
        recognized: true, genre: '流行', mood: '怀旧', energy: 0.4, valence: 0.5, tempo: 'slow', confidence: 0.8,
      });
    },
    fetchLyrics: async () => ({ lrc: opts.lrc ?? '[00:01]故事的小黄花', tlyric: '' }),
    fetchComments: async () => [],
  };
}

// ===== 1. 队列驱动真实 generator → 落库 =====
async function testQueueDrivesGenerator() {
  console.log('\n--- queue drives real generateSongTags → song_tags written ---');
  __resetForTest(); // _generate = real generateSongTags
  const store = fresh();
  const ok = enqueueTagging(
    { songId: 'q1', title: '晴天', artist: '周杰伦', source: 'ncm', year: 2003 },
    mockDeps(store),
  );
  assert(ok === true, 'enqueue returns true');
  await waitIdle();

  const t = store.getTags('q1');
  assert(t !== null, 'song_tags row written by queued job');
  assert(t && t.confidence > 0, 'tagged with confidence > 0');
  assert(t && t.mood === '怀旧', 'mood persisted through queue path');
  const qs = queueStats();
  assert(qs.done === 1, 'stats.done incremented');
  assert(qs.failed === 0, 'no failures');
  assert(idle(), 'queue idle after drain');
  store.close();
}

// ===== 2. in-flight 去重 =====
async function testDedup() {
  console.log('\n--- in-flight dedup: duplicate songId ignored ---');
  __resetForTest();
  const store = fresh();
  const deps = mockDeps(store);
  const a = enqueueTagging({ songId: 'dup', title: 'A', artist: 'X', source: 'ncm' }, deps);
  const b = enqueueTagging({ songId: 'dup', title: 'A', artist: 'X', source: 'ncm' }, deps); // 同步重复
  assert(a === true, 'first enqueue accepted');
  assert(b === false, 'duplicate enqueue (same songId, still in-flight) rejected');
  await waitIdle();
  assert(queueStats().enqueued === 1, 'only one job counted');
  store.close();
}

async function testProviderAwareDedup() {
  console.log('\n--- in-flight identity includes provider ---');
  __resetForTest();
  const seen = [];
  __setGeneratorForTest(async song => {
    seen.push(`${song.provider}:${song.songId}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    return { confidence: 1 };
  });
  const ncmAccepted = enqueueTagging({ provider: 'ncm', songId: '123', title: 'N' });
  const qqAccepted = enqueueTagging({ provider: 'qq', songId: '123', title: 'Q' });
  assert(ncmAccepted && qqAccepted, 'same native id on two providers creates two queue jobs');
  await waitIdle();
  assert(seen.includes('ncm:123') && seen.includes('qq:123'), 'both provider-aware identities execute');
  __resetForTest();
}

// ===== 3. 失败统计 =====
async function testFailureStats() {
  console.log('\n--- generator throws → stats.failed + recentFailures ---');
  __resetForTest();
  __setGeneratorForTest(async () => { throw new Error('boom-llm'); });
  enqueueTagging({ songId: 'bad', title: 'A', artist: 'X' }, {});
  await waitIdle();
  const qs = queueStats();
  assert(qs.failed === 1, 'stats.failed incremented on throw');
  assert(qs.recentFailures.length === 1, 'recentFailures recorded');
  assert(qs.recentFailures[0].songId === 'bad', 'failure tagged with songId');
  assert(/boom-llm/.test(qs.recentFailures[0].reason), 'failure reason captured');
  __resetForTest();
}

// ===== 4. 占位统计（confidence=0 不算 done） =====
async function testPlaceholderStats() {
  console.log('\n--- generator returns confidence=0 → stats.placeholders + diagnosable reason ---');
  __resetForTest();
  __setGeneratorForTest(async (song) => ({
    song_id: song.songId, confidence: 0, source_text: 'placeholder:l3-truncated',
  }));
  enqueueTagging({ songId: 'ph', title: 'A', artist: 'X' }, {});
  await waitIdle();
  const qs = queueStats();
  assert(qs.placeholders === 1, 'stats.placeholders incremented');
  assert(qs.done === 0, 'placeholder NOT counted as done');
  assert(qs.failed === 0, 'placeholder is not a failure');
  assert(qs.recentPlaceholders.length === 1, 'placeholder reason is observable via queue stats');
  assert(qs.recentPlaceholders[0].songId === 'ph', 'placeholder tagged with songId');
  assert(qs.recentPlaceholders[0].reason === 'placeholder:l3-truncated', 'placeholder reason captured');
  __resetForTest();
}

async function main() {
  await testQueueDrivesGenerator();
  await testDedup();
  await testProviderAwareDedup();
  await testFailureStats();
  await testPlaceholderStats();

  console.log(`\n──────────────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
