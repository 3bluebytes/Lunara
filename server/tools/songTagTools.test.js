// songTagTools.test.js — coverage for the radiohost-callable tag CRUD tools
// (get_song_tags / correct_song_tags / delete_song_tags).
//
// 用真实 SongTagStore（临时 DB）跑，resolveTrack 用注入的 fake，
// 不碰 NCM/QQ 网络、不依赖单例 DB。
//
// Run: node server/tools/songTagTools.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SongTagStore } from '../songtags/songTagStore.js';
import { getSongTags, correctSongTags, deleteSongTags } from './songTagTools.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-songtagtools-test-')));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

let _n = 0;
function freshStore() {
  _n += 1;
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `data/state-${_n}.db`);
  const s = new SongTagStore();
  s.initialize();
  return s;
}
// resolveTrack fake：把 query 映射到一个固定 song_id（默认命中）。
function makeResolver(map = {}) {
  return async (q) => {
    const hit = map[q];
    if (hit === undefined) return { ok: false };
    return { ok: true, song_id: hit.song_id, title: hit.title, artist: hit.artist, source: hit.source || 'ncm' };
  };
}

async function testGetBySongId() {
  console.log('\n--- get_song_tags by song_id ---');
  const store = freshStore();
  store.upsert({
    song_id: 'g1', title: '浮夸', artist: '陈奕迅', language: 'cantonese',
    mood: '激昂', genre: '流行', tempo: 'fast', energy: 0.8, scenes: ['独处'], confidence: 0.7,
  });
  const r = await getSongTags({ song_id: 'g1' }, { store, resolveTrack: makeResolver() });
  assert(/song_id=g1/.test(r), 'echoes song_id');
  assert(/语言=cantonese/.test(r), 'shows language');
  assert(/情绪=激昂/.test(r), 'shows mood');
  assert(/场景=\[独处\]/.test(r), 'shows scenes array');
  store.close();
}

async function testGetMissingAndPlaceholder() {
  console.log('\n--- get_song_tags: missing + placeholder ---');
  const store = freshStore();
  const miss = await getSongTags({ song_id: 'nope' }, { store, resolveTrack: makeResolver() });
  assert(/还没打标/.test(miss), 'missing row reported');

  store.upsert({ song_id: 'ph', title: 'A', artist: 'X', confidence: 0 });
  const ph = await getSongTags({ song_id: 'ph' }, { store, resolveTrack: makeResolver() });
  assert(/占位/.test(ph), 'placeholder (confidence=0) flagged');
  store.close();
}

async function testCorrectBySongId() {
  console.log('\n--- correct_song_tags: 国/粤 纠正 + 高置信 + 来源标记 ---');
  const store = freshStore();
  store.upsert({
    song_id: 'c1', title: '浮夸', artist: '陈奕迅', language: 'cantonese',
    mood: '激昂', genre: '流行', confidence: 0.6,
  });
  const r = await correctSongTags({ song_id: 'c1', language: 'mandarin' }, { store, resolveTrack: makeResolver() });
  assert(/已纠正/.test(r) && /language/.test(r), 'reports applied field');
  assert(/改前/.test(r) && /改后/.test(r), 'shows before/after');

  const after = store.getTags('c1');
  assert(after.language === 'mandarin', 'language corrected in store');
  assert(after.mood === '激昂', 'untouched field preserved');
  assert(Math.abs(after.confidence - 0.9) < 1e-9, 'confidence bumped to ≥0.9');
  assert(after.source_text === 'user-correction', 'source_text marks the correction');
  store.close();
}

async function testCorrectNormalizationAndRejects() {
  console.log('\n--- correct_song_tags: normalize + reject illegal ---');
  const store = freshStore();
  store.upsert({ song_id: 'c2', title: 'A', artist: 'X', confidence: 0.5 });

  const r = await correctSongTags({
    song_id: 'c2',
    language: '国语',          // → mandarin
    tempo: 'FAST',             // → fast
    energy: 5,                 // → clamp 1
    scenes: ['学习', '蹦迪'],   // → ['学习']（蹦迪不在白名单）
    genre: 'klingon-metal',    // 合法字符串，照收
  }, { store, resolveTrack: makeResolver() });
  assert(/已纠正/.test(r), 'correction applied');

  const t = store.getTags('c2');
  assert(t.language === 'mandarin', '国语 → mandarin');
  assert(t.tempo === 'fast', 'FAST → fast');
  assert(t.energy === 1, 'energy 5 clamped to 1');
  assert(t.scenes.length === 1 && t.scenes[0] === '学习', 'invalid scene filtered out');

  // 全非法字段 → 不写，给指引
  const bad = await correctSongTags({ song_id: 'c2', language: 'klingon', tempo: 'turbo' }, { store, resolveTrack: makeResolver() });
  assert(/没法接受|没有可纠正/.test(bad), 'all-illegal correction rejected with guidance');
  store.close();
}

async function testCorrectByQueryCreatesRow() {
  console.log('\n--- correct_song_tags by query, creates row w/ identity ---');
  const store = freshStore();
  const resolveTrack = makeResolver({ '陈奕迅 浮夸': { song_id: 'q1', title: '浮夸', artist: '陈奕迅', source: 'qq' } });
  const r = await correctSongTags({ query: '陈奕迅 浮夸', language: 'cantonese' }, { store, resolveTrack });
  assert(/已纠正/.test(r), 'correction via query applied');
  const t = store.getTags('q1');
  assert(t && t.language === 'cantonese', 'row created for resolved song_id');
  assert(t.title === '浮夸' && t.artist === '陈奕迅', 'identity backfilled from resolved track');
  store.close();
}

async function testCurrentTrackIsDefaultTarget() {
  console.log('\n--- tag tools default to the current track ---');
  const store = freshStore();
  store.upsert({ provider: 'qq', song_id: 'now-1', title: '浮夸', artist: '陈奕迅', language: 'mandarin', confidence: 0.5 });
  const currentTrack = () => ({ song_id: 'now-1', title: '浮夸', artist: '陈奕迅', source: 'qq' });

  const corrected = await correctSongTags(
    { language: 'cantonese' },
    { store, resolveTrack: makeResolver(), currentTrack },
  );
  assert(/已纠正/.test(corrected), 'correction without query targets current track');
  assert(store.getTags('now-1').language === 'cantonese', 'current track row was updated');

  const read = await getSongTags({}, { store, resolveTrack: makeResolver(), currentTrack });
  assert(/song_id=now-1/.test(read), 'read without query targets current track');
  store.close();
}

async function testResolveFailure() {
  console.log('\n--- resolve failure paths ---');
  const store = freshStore();
  const noArgs = await correctSongTags({ language: 'mandarin' }, { store, resolveTrack: makeResolver() });
  assert(/song_id 或 query/.test(noArgs), 'no song_id/query → asks for one');
  const noHit = await correctSongTags({ query: '查无此歌', language: 'mandarin' }, { store, resolveTrack: makeResolver() });
  assert(/没找到/.test(noHit), 'unresolved query reported');
  store.close();
}

async function testDelete() {
  console.log('\n--- delete_song_tags ---');
  const store = freshStore();
  store.upsert({ song_id: 'd1', title: 'A', artist: 'X', confidence: 0.5 });
  const r = await deleteSongTags({ song_id: 'd1' }, { store, resolveTrack: makeResolver() });
  assert(/已删除/.test(r), 'delete confirmed');
  assert(store.getTags('d1') === null, 'row gone');
  const again = await deleteSongTags({ song_id: 'd1' }, { store, resolveTrack: makeResolver() });
  assert(again.ok === false && /音乐源/.test(again), 'missing bare identity is not guessed after deletion');
  const qualified = await deleteSongTags({ provider: 'qq', song_id: 'd1' }, { store, resolveTrack: makeResolver() });
  assert(qualified.ok && /本来就没有/.test(qualified), 'source-qualified deletion stays idempotent');
  store.close();
}

async function runTests() {
  console.log('\n🧪 songTagTools tests\n');
  try {
    await testGetBySongId();
    await testGetMissingAndPlaceholder();
    await testCorrectBySongId();
    await testCorrectNormalizationAndRejects();
    await testCorrectByQueryCreatesRow();
    await testCurrentTrackIsDefaultTarget();
    await testResolveFailure();
    await testDelete();
  } catch (e) {
    console.error('Test runner error:', e);
    failed++;
  }
  console.log(`\n──────────────────────────────`);
  console.log(`${passed} passed · ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
