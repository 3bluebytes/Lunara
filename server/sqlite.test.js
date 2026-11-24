import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SQLITE_BUSY_TIMEOUT_MS, openSqliteDatabase } from './sqlite.js';
import { TrackArtworkStore } from './media/trackArtworkStore.js';
import { ConversationStore } from './virtual-person/ConversationStore.js';
import { TrackLikeStore } from './music/trackLikeStore.js';

test('openSqliteDatabase configures WAL and 5000ms busy_timeout before queries', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-sqlite-open-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'state.db');

  const db = openSqliteDatabase(dbPath);
  const artworkStore = new TrackArtworkStore({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  const likeStore = new TrackLikeStore({ dbPath }).initialize();
  t.after(() => {
    likeStore.close();
    conversationStore.close();
    artworkStore.close();
    db.close();
  });

  for (const handle of [db, artworkStore.db, conversationStore.db, likeStore.db]) {
    assert.equal(handle.pragma('busy_timeout', { simple: true }), DEFAULT_SQLITE_BUSY_TIMEOUT_MS);
    assert.equal(handle.pragma('journal_mode', { simple: true }), 'wal');
  }
});
