// songTagRetrieval.test.js — PR4 标签流入选歌
//
// 覆盖（对应 openspec task 5.7）：
//   - mood + has_vocal 组合过滤
//   - energy / valence / year range
//   - language 精确
//   - 艺人 gender 经 artist_tags JOIN
//   - 无 tag 行（含 confidence=0 占位）在过滤时被排除
//   - 纯 query（无 tags）向后兼容：原样返回
//   - 候选池注解：有 tag 显示 [..]，占位/无行显示普通行
//   - affectProfile / affectBandForVibe（WarmPool diversity）
//
// Run: node server/songtags/songTagRetrieval.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SongTagStore } from './songTagStore.js';
import {
  matchesTags, filterCandidatesByTags, hasAnyTagFilter,
  annotateCandidate, appendAnnotation, affectProfile, affectBandForVibe,
} from './songTagRetrieval.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-tagretr-test-')));

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}

function seed() {
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `data/state-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const s = new SongTagStore();
  s.initialize();

  // A：周杰伦 晴天 — calm/有声/低能/2003/国语/学习+睡前
  s.upsert({ provider: 'ncm', song_id: 'a', title: '晴天', artist: '周杰伦', mood: 'calm', has_vocal: true,
    energy: 0.3, valence: 0.6, year: 2003, language: 'mandarin', genre: '流行',
    vocal_softness: 0.8, scenes: ['学习', '睡前'], confidence: 0.8 });
  // B：泰勒 — energetic/有声/高能/2020/英文/运动（女艺人）
  s.upsert({ provider: 'qq', song_id: 'b', title: 'Shake It Off', artist: '泰勒斯威夫特', mood: 'energetic', has_vocal: true,
    energy: 0.8, valence: 0.7, year: 2020, language: 'english', genre: '流行',
    scenes: ['运动'], confidence: 0.7 });
  // C：纯器乐 — instrumental/无声/低能/1999
  s.upsert({ provider: 'ncm', song_id: 'c', title: 'Nuvole Bianche', artist: 'Ludovico Einaudi', mood: 'calm', has_vocal: false,
    energy: 0.2, valence: 0.5, year: 1999, language: 'instrumental', genre: '古典', confidence: 0.6 });
  // D：占位行（打标失败，confidence=0，无可用属性）
  s.upsert({ provider: 'qq', song_id: 'd', title: '某歌', artist: '某人', confidence: 0 });

  // 艺人级
  s.upsertArtist({ artist_name: '周杰伦', gender: 'male', genre: '流行', region: '华语', confidence: 0.95, source: 'llm-knowledge' });
  s.upsertArtist({ artist_name: '泰勒斯威夫特', gender: 'female', genre: '流行', region: '欧美', confidence: 0.95, source: 'llm-knowledge' });

  return s;
}

// 候选池（注意 E 完全没有 song_tags 行）
const CANDS = [
  { song_id: 'a', title: '晴天', artist: '周杰伦', source: 'ncm:liked' },
  { song_id: 'b', title: 'Shake It Off', artist: '泰勒斯威夫特', source: 'qq:liked' },
  { song_id: 'c', title: 'Nuvole Bianche', artist: 'Ludovico Einaudi', source: 'ncm:daily' },
  { song_id: 'd', title: '某歌', artist: '某人', source: 'qq:daily' },
  { song_id: 'e', title: '未打标歌', artist: '陌生人', source: 'ncm:liked' },
];
const ids = (list) => list.map(c => c.song_id).sort().join(',');

function testScalarAndBool() {
  console.log('\n--- mood + has_vocal filter ---');
  const s = seed();
  const r = filterCandidatesByTags(CANDS, { mood: 'calm', has_vocal: true }, s);
  assert(ids(r) === 'a', 'mood=calm & has_vocal=true → only A (C is calm but instrumental)');
  assert(!r.some(c => c.song_id === 'e'), 'untagged E excluded');
  assert(!r.some(c => c.song_id === 'd'), 'placeholder D excluded');
  s.close();
}

function testRanges() {
  console.log('\n--- energy / valence / year ranges ---');
  const s = seed();
  assert(ids(filterCandidatesByTags(CANDS, { maxEnergy: 0.4 }, s)) === 'a,c', 'maxEnergy 0.4 → A,C');
  assert(ids(filterCandidatesByTags(CANDS, { minEnergy: 0.6 }, s)) === 'b', 'minEnergy 0.6 → B');
  assert(ids(filterCandidatesByTags(CANDS, { minValence: 0.65 }, s)) === 'b', 'minValence 0.65 → B');
  assert(ids(filterCandidatesByTags(CANDS, { minYear: 2000, maxYear: 2010 }, s)) === 'a', 'year [2000,2010] → A');
  assert(ids(filterCandidatesByTags(CANDS, { minYear: 2015 }, s)) === 'b', 'minYear 2015 → B');
  s.close();
}

function testLanguageAndLegacyScenesAreNotHardFilters() {
  console.log('\n--- language exact + legacy scenes ignored as hard filters ---');
  const s = seed();
  assert(ids(filterCandidatesByTags(CANDS, { language: 'instrumental' }, s)) === 'c', 'language=instrumental → C');
  assert(ids(filterCandidatesByTags(CANDS, { language: 'mandarin' }, s)) === 'a', 'language=mandarin → A');
  assert(hasAnyTagFilter({ scenes: '学习' }) === false, 'legacy scenes is not an active hard-filter key');
  assert(filterCandidatesByTags(CANDS, { scenes: '学习' }, s).length === CANDS.length, 'scene-like context never excludes candidates');
  s.close();
}

function testLanguageFamily() {
  console.log('\n--- language family: chinese broad vs mandarin/cantonese exact ---');
  process.env.LUNARA_DB_PATH = resolve(process.cwd(), `data/state-langfam-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const s = new SongTagStore();
  s.initialize();
  s.upsert({ song_id: 'm', title: '十年', artist: '陈奕迅', language: 'mandarin', confidence: 0.7 });
  s.upsert({ song_id: 'y', title: '浮夸', artist: '陈奕迅', language: 'cantonese', confidence: 0.7 });
  s.upsert({ song_id: 'z', title: '某中文歌', artist: '某人', language: 'chinese', confidence: 0.7 });
  const C = [{ song_id: 'm' }, { song_id: 'y' }, { song_id: 'z' }];
  const idsOf = (list) => list.map(c => c.song_id).sort().join(',');

  assert(idsOf(filterCandidatesByTags(C, { language: 'mandarin' }, s)) === 'm', 'mandarin → only mandarin (excludes cantonese & undifferentiated chinese)');
  assert(idsOf(filterCandidatesByTags(C, { language: 'cantonese' }, s)) === 'y', 'cantonese → only cantonese');
  assert(idsOf(filterCandidatesByTags(C, { language: 'chinese' }, s)) === 'm,y,z', 'chinese → all Chinese (mandarin+cantonese+undifferentiated)');
  assert(idsOf(filterCandidatesByTags(C, { language: 'english' }, s)) === '', 'english → none here');
  s.close();
}

function testArtistJoin() {
  console.log('\n--- artist gender via JOIN ---');
  const s = seed();
  assert(ids(filterCandidatesByTags(CANDS, { gender: 'female' }, s)) === 'b', 'gender=female → B (Taylor)');
  assert(ids(filterCandidatesByTags(CANDS, { gender: 'male' }, s)) === 'a', 'gender=male → A (Jay)');
  assert(ids(filterCandidatesByTags(CANDS, { region: '欧美' }, s)) === 'b', 'region=欧美 → B');
  // C 的艺人没打 artist_tags → gender 过滤把它排除
  assert(!filterCandidatesByTags(CANDS, { gender: 'male' }, s).some(c => c.song_id === 'c'), 'untagged-artist C excluded from gender filter');
  s.close();
}

function testBackwardCompat() {
  console.log('\n--- pure query (no tags) backward compatible ---');
  const s = seed();
  assert(hasAnyTagFilter(undefined) === false, 'hasAnyTagFilter(undefined) false');
  assert(hasAnyTagFilter({}) === false, 'hasAnyTagFilter({}) false');
  assert(hasAnyTagFilter({ mood: '' }) === false, 'empty string not a filter');
  assert(hasAnyTagFilter({ mood: 'calm' }) === true, 'mood=calm is a filter');
  const r1 = filterCandidatesByTags(CANDS, undefined, s);
  assert(r1.length === CANDS.length && r1[0] === CANDS[0], 'no tags → returns full pool, same order');
  const r2 = filterCandidatesByTags(CANDS, {}, s);
  assert(r2.length === CANDS.length, 'empty tags → returns full pool (incl. untagged)');
  s.close();
}

function testAnnotation() {
  console.log('\n--- candidate annotation ---');
  const s = seed();
  const aAnn = annotateCandidate(CANDS[0], s);
  assert(aAnn.startsWith('[') && aAnn.endsWith(']'), 'A annotation wrapped in [..]');
  assert(aAnn.includes('mood:calm'), 'A annotation has mood');
  assert(aAnn.includes('year:2003'), 'A annotation has year');
  assert(aAnn.includes('lang:mandarin'), 'A annotation has lang');
  assert(!aAnn.includes('scenes:'), 'legacy scenes are not exposed as recommendation annotations');

  const cAnn = annotateCandidate(CANDS[2], s);
  assert(cAnn.includes('vocal:no'), 'C (instrumental) annotation shows vocal:no');
  assert(cAnn.includes('lang:instrumental'), 'C annotation lang instrumental');

  assert(annotateCandidate(CANDS[3], s) === '', 'placeholder D → no annotation');
  assert(annotateCandidate(CANDS[4], s) === '', 'untagged E → no annotation');

  assert(appendAnnotation('- 晴天 — 周杰伦 [ncm]', CANDS[0], s).includes('mood:calm'), 'appendAnnotation adds tags to tagged line');
  assert(appendAnnotation('- 未打标歌 — 陌生人 [ncm]', CANDS[4], s) === '- 未打标歌 — 陌生人 [ncm]', 'appendAnnotation leaves untagged line plain');
  s.close();
}


function testStrictInstrumental() {
  console.log('\n--- strict instrumental (vocal_state) ---');
  const s = seed();
  // 确证纯音乐命中；有人声被排除；未知/缺行/占位都不算纯音乐。
  assert(ids(filterCandidatesByTags(CANDS, { vocal_state: 'instrumental' }, s)) === 'c',
    'vocal_state=instrumental → only C (A,B vocal; D placeholder; E untagged)');
  assert(matchesTags({ song_id: 'c', source: 'ncm' }, { vocal_state: 'instrumental', maxEnergy: 0.4 }, s) === true,
    'instrumental + energy cap composes');
  assert(matchesTags({ song_id: 'c', source: 'ncm' }, { vocal_state: 'instrumental', maxEnergy: 0.1 }, s) === false,
    'instrumental still respects the energy cap');
  assert(matchesTags({ song_id: 'd', source: 'qq' }, { vocal_state: 'instrumental' }, s) === false,
    'placeholder row never counts as instrumental');
  assert(matchesTags({ song_id: 'e', source: 'ncm' }, { vocal_state: 'instrumental' }, s) === false,
    'untagged candidate never counts as instrumental');
  // 既有 has_vocal 语义不变：null（未知）在布尔过滤里仍是旧行为，不因新键改变。
  assert(matchesTags({ song_id: 'd', source: 'qq' }, { has_vocal: false }, s) === true,
    'legacy has_vocal:false keeps its old loose semantics for existing callers');
  s.close();
}

function testAffect() {
  console.log('\n--- affect profile + vibe bands ---');
  const s = seed();
  const prof = affectProfile([CANDS[0], CANDS[1], CANDS[4]], s);
  assert(Math.abs(prof.energy - 0.55) < 1e-9, 'mean energy of A,B = 0.55 (E untagged ignored)');
  assert(Math.abs(prof.valence - 0.65) < 1e-9, 'mean valence of A,B = 0.65');
  assert(prof.tagged === 2 && prof.total === 3, 'tagged=2 of total=3');

  assert(affectBandForVibe('safe-pick').maxEnergy === 0.4, 'safe-pick → low energy band');
  assert(affectBandForVibe('surprise-pick').minEnergy === 0.6, 'surprise-pick → high energy band');
  assert(affectBandForVibe('nope') === null, 'unknown vibe → null');
  s.close();
}

testScalarAndBool();
testRanges();
testLanguageAndLegacyScenesAreNotHardFilters();
testLanguageFamily();
testArtistJoin();
testBackwardCompat();
testAnnotation();
testStrictInstrumental();
testAffect();

console.log(`\n──────────────────────────────`);
console.log(`${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
