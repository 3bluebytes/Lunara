import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const root = await mkdtemp(join(tmpdir(), 'lunara-message-role-'));
const dbPath = join(root, 'state.db');
process.env.LUNARA_DB_PATH = dbPath;
const state = await import('./state.js');

test('新 assistant 消息按语义 role 写入', () => {
  state.logMessage('assistant', 'Lunara 在这里');
  const db = new Database(dbPath);
  const row = db.prepare('SELECT role, text FROM messages ORDER BY id DESC LIMIT 1').get();
  db.close();
  assert.deepEqual(row, { role: 'assistant', text: 'Lunara 在这里' });
});

test('读取 legacy claudio role 时归一化为 assistant', () => {
  const db = new Database(dbPath);
  db.prepare('INSERT INTO messages (ts, role, text, meta) VALUES (?, ?, ?, ?)')
    .run(Date.now(), 'claudio', '历史消息', null);
  db.close();

  assert.equal(state.recentMessages(5).at(-1).role, 'assistant');
  assert.equal(state.messagesSince(0).at(-1).role, 'assistant');
});
