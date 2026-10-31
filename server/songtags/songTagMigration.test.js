import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SongTagStore } from './songTagStore.js';

const dir = mkdtempSync(resolve(tmpdir(), 'lunara-songtag-migration-'));
let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.log(`  ✗ ${label}`); }
}

function createLegacy(path) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE song_tags (
      song_id TEXT PRIMARY KEY, title TEXT, artist TEXT, artist_key TEXT, source TEXT,
      year INTEGER, language TEXT, genre TEXT, instruments TEXT, mood TEXT,
      energy REAL, valence REAL, tempo TEXT, has_vocal INTEGER,
      vocal_softness REAL, scenes TEXT, themes TEXT, confidence REAL,
      source_text TEXT, created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE artist_tags (
      artist_key TEXT PRIMARY KEY, artist_name TEXT, gender TEXT, genre TEXT,
      region TEXT, confidence REAL, source TEXT, created_at INTEGER, updated_at INTEGER
    );
  `);
  const insert = db.prepare(`
    INSERT INTO song_tags (song_id,title,source,confidence,created_at,updated_at)
    VALUES (?,?,?,?,?,?)
  `);
  insert.run('1', 'NCM song', 'ncm:playlist:x', 0.8, 1, 1);
  insert.run('2', 'QQ song', 'qq', 0.7, 1, 1);
  insert.run('3', 'Unknown song', 'old-importer', 0.5, 1, 1);
  db.close();
}

console.log('\n--- provider-aware shadow migration ---');
const migratedPath = resolve(dir, 'migrated.db');
createLegacy(migratedPath);
let hookReport = null;
const store = new SongTagStore({
  dbPath: migratedPath,
  migrationHook: report => { hookReport = report; },
}).initialize();
assert(hookReport?.before === 3 && hookReport?.after === 3, 'migration verifies identical row counts');
assert(hookReport?.legacyRows === 1, 'migration reports unknown source as one legacy row');
assert(store.getTags('1', 'ncm')?.title === 'NCM song', 'ncm source inferred');
assert(store.getTags('2', 'qq')?.title === 'QQ song', 'qq source inferred');
assert(store.getTags('3', 'legacy')?.title === 'Unknown song', 'unknown source preserved in legacy namespace');
store.close();

const rerun = new SongTagStore({ dbPath: migratedPath }).initialize();
const pk = rerun.db.prepare(`PRAGMA table_info(song_tags)`).all()
  .filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
assert(pk.join(',') === 'provider,song_id', 'migration is idempotent on repeated initialize');
assert(rerun.stats().total === 3, 'idempotent rerun preserves row count');

rerun.upsert({ provider: 'ncm', song_id: 'same', title: 'N', confidence: 1 });
rerun.upsert({ provider: 'qq', song_id: 'same', title: 'Q', confidence: 1 });
assert(rerun.getTags('same', 'ncm').title === 'N' && rerun.getTags('same', 'qq').title === 'Q', 'same native id remains isolated across providers');
rerun.close();

console.log('\n--- migration failure rollback ---');
const rollbackPath = resolve(dir, 'rollback.db');
createLegacy(rollbackPath);
let threw = false;
try {
  new SongTagStore({
    dbPath: rollbackPath,
    migrationHook: () => { throw new Error('injected migration failure'); },
  }).initialize();
} catch (error) {
  threw = /injected migration failure/.test(error.message);
}
assert(threw, 'injected failure propagates from initialization');
const raw = new Database(rollbackPath);
const oldColumns = raw.prepare(`PRAGMA table_info(song_tags)`).all();
assert(!oldColumns.some(column => column.name === 'provider'), 'failed migration rolls back original schema');
assert(raw.prepare(`SELECT COUNT(*) AS n FROM song_tags`).get().n === 3, 'failed migration rolls back all rows');
assert(!raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='song_tags_provider_shadow'`).get(), 'failed shadow table is rolled back');
raw.close();

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
