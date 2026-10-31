// songTagStore.test.js — PR1 coverage for song_tags + artist_tags store.
//
// 覆盖（对应 openspec tasks 2.9）：
//   - 两表 schema（song_tags 21 列 / artist_tags 9 列 + 主键）
//   - 5 个具名索引
//   - TTL 三态（缺 / 新 / 旧）
//   - confidence=0 占位行在 TTL 内抑制重试
//   - 缺行 null 降级（getTags / getArtistTags）
//   - upsert 幂等（同 song_id 覆盖、bump updated_at、保留 created_at、不产生重复行）
//   - artist 跨歌去重复用
//   - artistKeyOf 归一化（多艺人 / feat / 大小写 / 空）
//   - JSON 数组列往返 + has_vocal 布尔
//
// Run: node server/songtags/songTagStore.test.js

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SongTagStore, artistKeyOf } from './songTagStore.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-songtags-test-')));

const DAY_MS = 24 * 60 * 60 * 1000;
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

function setSongUpdatedAt(store, songId, ts) {
  store.db.prepare(`UPDATE song_tags SET updated_at=? WHERE song_id=?`).run(ts, songId);
}

// ===== schema =====
function testSchema() {
  console.log('\n--- schema: two tables, columns, primary keys ---');
  const store = fresh();

  const songCols = store.db.prepare(`PRAGMA table_info(song_tags)`).all();
  assert(songCols.length === 22, `song_tags has 22 columns (got ${songCols.length})`);
  const songPk = songCols.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  assert(songPk.join(',') === 'provider,song_id', 'song_tags primary key is (provider,song_id)');
  for (const need of ['year', 'language', 'instruments', 'valence', 'artist_key']) {
    assert(songCols.some(c => c.name === need), `song_tags has column ${need}`);
  }
  assert(!songCols.some(c => c.name === 'bpm'), 'song_tags has NO bpm column (Phase A)');

  const artistCols = store.db.prepare(`PRAGMA table_info(artist_tags)`).all();
  assert(artistCols.length === 9, `artist_tags has 9 columns (got ${artistCols.length})`);
  const artistPk = artistCols.find(c => c.pk === 1);
  assert(artistPk && artistPk.name === 'artist_key', 'artist_tags primary key is artist_key');

  store.close();
}

// ===== indexes =====
function testIndexes() {
  console.log('\n--- indexes for retrieval ---');
  const store = fresh();
  const names = store.db.prepare(`PRAGMA index_list(song_tags)`).all().map(i => i.name);
  for (const idx of [
    'idx_song_tags_mood', 'idx_song_tags_genre', 'idx_song_tags_has_vocal',
    'idx_song_tags_language', 'idx_song_tags_artist_key',
  ]) {
    assert(names.includes(idx), `index ${idx} exists`);
  }
  store.close();
}

// ===== TTL three states =====
function testTtlStates() {
  console.log('\n--- needsTagging: missing / fresh / stale ---');
  const store = fresh();

  assert(store.needsTagging('never-seen') === true, 'missing row needs tagging');

  store.upsert({ song_id: 's-fresh', title: 'A', artist: 'X', confidence: 0.8 });
  assert(store.needsTagging('s-fresh', 30) === false, 'fresh row (just now) does not need tagging');

  setSongUpdatedAt(store, 's-fresh', Date.now() - 40 * DAY_MS);
  assert(store.needsTagging('s-fresh', 30) === true, 'stale row (40d, ttl=30) needs re-tagging');

  store.close();
}

// ===== placeholder suppression =====
function testPlaceholderSuppression() {
  console.log('\n--- confidence=0 placeholder suppresses retry within TTL ---');
  const store = fresh();
  store.upsert({ song_id: 's-fail', title: 'A', artist: 'X', confidence: 0 });
  setSongUpdatedAt(store, 's-fail', Date.now() - 60 * 60 * 1000);
  assert(store.needsTagging('s-fail', 30) === false, 'fresh placeholder is suppressed inside short retry TTL');
  setSongUpdatedAt(store, 's-fail', Date.now() - 7 * 60 * 60 * 1000);
  assert(store.needsTagging('s-fail', 30) === true, 'placeholder becomes retryable after short TTL');
  assert(store.getTags('s-fail') !== null, 'placeholder still counts as "has a row"');
  store.close();
}

// ===== null degradation =====
function testNullDegradation() {
  console.log('\n--- getTags / getArtistTags return null for missing ---');
  const store = fresh();
  assert(store.getTags('nope') === null, 'getTags(missing) returns null (no throw)');
  assert(store.getArtistTags('nope') === null, 'getArtistTags(missing) returns null (no throw)');
  store.close();
}

// ===== upsert idempotency =====
function testUpsertIdempotent() {
  console.log('\n--- upsert is idempotent: in-place update, created_at preserved ---');
  const store = fresh();

  store.upsert({ song_id: 's1', title: '晴天', artist: '周杰伦', mood: 'nostalgic' });
  // 把 created_at / updated_at 压到一个旧 sentinel，验证再次 upsert 时 created_at 保留、updated_at 刷新
  const oldTs = Date.now() - 10 * DAY_MS;
  store.db.prepare(`UPDATE song_tags SET created_at=?, updated_at=? WHERE song_id=?`).run(oldTs, oldTs, 's1');

  store.upsert({ song_id: 's1', title: '晴天', artist: '周杰伦', mood: 'warm', energy: 0.4 });

  const raw = store.db.prepare(`SELECT * FROM song_tags WHERE song_id='s1'`).get();
  const count = store.db.prepare(`SELECT COUNT(*) AS n FROM song_tags`).get().n;
  assert(count === 1, 're-upsert does not create a duplicate row');
  assert(raw.created_at === oldTs, 'created_at preserved across upsert');
  assert(raw.updated_at > oldTs, 'updated_at bumped on upsert');
  assert(raw.mood === 'warm', 'fields overwritten in place');
  assert(Math.abs(raw.energy - 0.4) < 1e-9, 'newly-set field persisted');

  store.close();
}

// ===== artist dedup =====
function testArtistDedup() {
  console.log('\n--- artist tagged once, reused across songs ---');
  const store = fresh();

  const a = store.upsertArtist({ artist_name: '周杰伦', gender: 'male', genre: '流行', region: '华语', confidence: 0.95, source: 'llm-knowledge' });
  const key = artistKeyOf('周杰伦');
  assert(a.artist_key === key, 'upsertArtist derives artist_key from name');
  assert(store.getArtistTags(key)?.gender === 'male', 'artist tags round-trip');
  assert(store.needsArtistTagging(key) === false, 'cached artist does not need re-tagging');

  // 两首同艺人歌 → 同一个 artist_key
  store.upsert({ song_id: 'jay-1', title: '晴天', artist: '周杰伦' });
  store.upsert({ song_id: 'jay-2', title: '稻香', artist: '周杰伦' });
  const k1 = store.getTags('jay-1').artist_key;
  const k2 = store.getTags('jay-2').artist_key;
  assert(k1 === k2 && k1 === key, 'two songs by same artist share artist_key');

  const artistCount = store.db.prepare(`SELECT COUNT(*) AS n FROM artist_tags`).get().n;
  assert(artistCount === 1, 'only one artist_tags row for the shared artist');

  store.close();
}

// ===== artistKeyOf normalization =====
function testArtistKeyOf() {
  console.log('\n--- artistKeyOf normalization ---');
  assert(artistKeyOf('周杰伦 / 费玉清') === '周杰伦', 'multi-artist takes primary (slash)');
  assert(artistKeyOf('周杰伦、林俊杰') === '周杰伦', 'multi-artist takes primary (、)');
  assert(artistKeyOf('Jay Chou feat. Someone') === 'jay chou', 'strips feat. + lowercases');
  assert(artistKeyOf('A & B') === 'a', 'splits on & and lowercases');
  assert(artistKeyOf('  Adele  ') === 'adele', 'trims + lowercases single artist');
  assert(artistKeyOf('') === '', 'empty artist → empty key');
  assert(artistKeyOf(null) === '', 'null artist → empty key');
}

// ===== JSON arrays + has_vocal boolean =====
function testJsonRoundTrip() {
  console.log('\n--- JSON array columns + has_vocal boolean ---');
  const store = fresh();

  const out = store.upsert({
    song_id: 's-json', title: 'Nuvole Bianche', artist: 'Ludovico Einaudi',
    instruments: ['钢琴'], scenes: ['学习', '睡前'], themes: ['治愈'],
    has_vocal: 0, language: 'instrumental', year: 2004,
  });
  assert(Array.isArray(out.instruments) && out.instruments[0] === '钢琴', 'instruments round-trips as array');
  assert(out.scenes.length === 2 && out.scenes.includes('睡前'), 'scenes round-trips as array');
  assert(out.themes[0] === '治愈', 'themes round-trips as array');
  assert(out.has_vocal === false, 'has_vocal=0 reads back as false');
  assert(out.year === 2004, 'year stored as integer');

  const vocal = store.upsert({ song_id: 's-vocal', title: 'A', artist: 'X', has_vocal: true });
  assert(vocal.has_vocal === true, 'has_vocal=true reads back as true');

  // 缺省 JSON 列 → 空数组（不抛）
  const bare = store.upsert({ song_id: 's-bare', title: 'B', artist: 'Y' });
  assert(Array.isArray(bare.scenes) && bare.scenes.length === 0, 'missing JSON column reads as empty array');

  store.close();
}

// ===== stats =====
function testStats() {
  console.log('\n--- stats: total / tagged / placeholders ---');
  const store = fresh();
  store.upsert({ song_id: 'g1', title: 'A', artist: 'X', confidence: 0.8 });
  store.upsert({ song_id: 'g2', title: 'B', artist: 'Y', confidence: 0.6 });
  store.upsert({ song_id: 'bad', title: 'C', artist: 'Z', confidence: 0 });
  const s = store.stats();
  assert(s.total === 3, 'stats.total counts all rows incl. placeholder');
  assert(s.tagged === 2, 'stats.tagged counts confidence>0');
  assert(s.placeholders === 1, 'stats.placeholders = total - tagged');
  store.close();
}

// ===== patchTags: 局部更新（read → merge → upsert），不抹掉未传字段 =====
function testPatchTags() {
  console.log('\n--- patchTags merges, preserves untouched fields ---');
  const store = fresh();

  store.upsert({
    song_id: 'p1', title: '浮夸', artist: '陈奕迅', language: 'cantonese',
    mood: '激昂', genre: '流行', energy: 0.7, scenes: ['独处'], confidence: 0.6,
  });
  const before = store.getTags('p1');

  // 只改 language（国/粤纠正），其余字段必须原样保留
  const after = store.patchTags('p1', { language: 'mandarin' });
  assert(after.language === 'mandarin', 'patched field updated (language→mandarin)');
  assert(after.mood === '激昂', 'untouched scalar preserved (mood)');
  assert(after.genre === '流行', 'untouched scalar preserved (genre)');
  assert(Math.abs(after.energy - 0.7) < 1e-9, 'untouched number preserved (energy)');
  assert(Array.isArray(after.scenes) && after.scenes[0] === '独处', 'untouched array preserved (scenes)');
  assert(after.title === '浮夸' && after.artist === '陈奕迅', 'identity preserved');

  const count = store.db.prepare(`SELECT COUNT(*) AS n FROM song_tags WHERE song_id='p1'`).get().n;
  assert(count === 1, 'patch does not create a duplicate row');

  // 缺行时以 patch 起新行（song_id 必填）
  const created = store.patchTags('p-new', { mood: '治愈', confidence: 0.9 });
  assert(created && created.song_id === 'p-new', 'patch on missing row creates it');
  assert(created.mood === '治愈', 'new row carries patched field');

  assert(store.patchTags('', { mood: 'x' }) === null, 'empty songId → null');

  store.close();
}

// ===== deleteTags: 删行 + 返回 changes =====
function testDeleteTags() {
  console.log('\n--- deleteTags removes row, returns change count ---');
  const store = fresh();
  store.upsert({ song_id: 'd1', title: 'A', artist: 'X', confidence: 0.5 });
  assert(store.getTags('d1') !== null, 'row exists before delete');
  assert(store.deleteTags('d1') === 1, 'delete returns 1 for existing row');
  assert(store.getTags('d1') === null, 'row gone after delete');
  assert(store.deleteTags('d1') === 0, 'delete returns 0 for missing row');
  assert(store.deleteTags('') === 0, 'empty songId → 0');
  store.close();
}

// ===== listTags: 搜索 + 分页（设置 → 歌曲标签的后端） =====
function testListTags() {
  console.log('\n--- listTags: search, clamp, sort, total ---');
  const store = fresh();
  store.upsert({ song_id: 'l1', title: '浮夸', artist: '陈奕迅', mood: '激昂', confidence: 0.8 });
  store.upsert({ song_id: 'l2', title: 'Love Words', artist: 'Eason Chan', mood: '温柔', confidence: 0.7 });
  store.upsert({ song_id: 'l3', title: '拼图', artist: 'CAS', confidence: 0 });
  // 把 updated_at 掰开，验证倒序
  setSongUpdatedAt(store, 'l1', 100);
  setSongUpdatedAt(store, 'l2', 300);
  setSongUpdatedAt(store, 'l3', 200);

  const all = store.listTags();
  assert(all.total === 3 && all.items.length === 3, 'listTags returns all rows with total');
  assert(all.items[0].song_id === 'l2', 'rows ordered by updated_at desc');
  assert(Array.isArray(all.items[0].themes) && all.items[0].has_vocal === null,
    'items share the getTags shape (parsed arrays, boolean has_vocal)');

  const hit = store.listTags({ search: 'EASON' });
  assert(hit.total === 1 && hit.items[0].song_id === 'l2', 'search matches artist case-insensitively');
  const hitTitle = store.listTags({ search: '浮夸' });
  assert(hitTitle.total === 1 && hitTitle.items[0].song_id === 'l1', 'search matches title');
  const literal = store.listTags({ search: '%_' });
  assert(literal.total === 0, 'LIKE wildcards in search are matched literally');

  const page = store.listTags({ limit: 2, offset: 1 });
  assert(page.limit === 2 && page.offset === 1 && page.items.length === 2 && page.total === 3,
    'pagination window keeps the unpaginated total');
  assert(store.listTags({ limit: 99999 }).limit === 500, 'limit clamps to 500');
  assert(store.listTags({ limit: 0 }).limit === 200, 'limit falls back to default 200');
  assert(store.listTags({ offset: -5 }).offset === 0, 'negative offset clamps to 0');
  store.close();
}

// ===== needsTagging: 用户手工修正的行永远新鲜（不被 TTL 或占位重试覆盖） =====
function testUserRowsNeverStale() {
  console.log('\n--- needsTagging: source=user is authoritative ---');
  const store = fresh();
  store.upsert({ song_id: 'u1', title: 'A', artist: 'X', language: 'cantonese',
    has_vocal: 1, confidence: 1, source: 'user', source_text: '手动修改' });
  setSongUpdatedAt(store, 'u1', Date.now() - 90 * DAY_MS);
  assert(store.needsTagging('u1') === false, 'user row stays fresh past TTL');
  assert(store.needsTagging('u1', 1) === false, 'user row stays fresh even with tiny TTL');
  // 占位重试窗口也不触发（用户行优先于 confidence=0 逻辑，虽然这里是 confidence=1）
  const legacy = store.upsert({ song_id: 'u2', title: 'B', artist: 'Y', confidence: 0 });
  setSongUpdatedAt(store, 'u2', Date.now() - 10 * 60 * 60 * 1000);
  assert(legacy.source !== 'user' && store.needsTagging('u2') === true,
    'non-user placeholder past retry window still needs tagging');
  store.close();
}

testSchema();
testIndexes();
testTtlStates();
testPlaceholderSuppression();
testNullDegradation();
testUpsertIdempotent();
testArtistDedup();
testArtistKeyOf();
testJsonRoundTrip();
testStats();
testPatchTags();
testDeleteTags();
testListTags();
testUserRowsNeverStale();

console.log(`\n──────────────────────────────`);
console.log(`${passed} passed · ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
