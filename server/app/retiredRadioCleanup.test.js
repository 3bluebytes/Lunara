import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import {
  RETIRED_RADIO_MARKER, ensureRetiredRadioCleaned, runRetiredRadioCleanup, stripRetiredRadioFromRuntimeSnapshot,
} from './retiredRadioCleanup.js';

const HASH = 'a'.repeat(64);
const silent = { info() {}, warn() {} };
const fixedNow = () => new Date('2026-10-28T08:00:00.000Z');

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'lunara-retire-radio-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function count(db, sql, ...params) {
  return db.prepare(sql).get(...params).n;
}

function chat(store, sessionId, text) {
  const { request } = store.beginRequest({ sessionId, virtualPersonId: 'lunara', userText: text });
  store.completeRequest({ requestId: request.requestId, virtualPersonId: 'lunara',
    message: { role: 'assistant', content: `回 ${text}` } });
  return request.requestId;
}

/** 一个真实形态的数据根：普通房间、整集房间、台本、播放快照、用量、生活授权、旧库、音频与 task 记录。 */
function seedLegacyRoot(root) {
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  const statePath = join(dataDir, 'state.db');
  const store = new ConversationStore({ dbPath: statePath });
  store.initialize();
  store.createRoom({ sessionId: 'conversation:room-a', title: '日常', memberIds: ['lunara'] });
  chat(store, 'conversation:room-a', '早');
  store.createRoom({ sessionId: 'conversation:episode-0123456789abcdef', title: '雨里的城市', memberIds: ['lunara'] });
  chat(store, 'conversation:episode-0123456789abcdef', '开始这一集');
  store.close();

  const db = new Database(statePath);
  const sequence = count(db, `SELECT next_sequence AS n FROM conversation_sessions WHERE session_id = 'conversation:room-a'`);
  db.prepare(`INSERT INTO conversation_turns (turn_id, session_id, sequence, role, speaker_virtual_person_id, visibility,
    message_json, visible_text, created_at) VALUES ('episode-script:start-1', 'conversation:room-a', ?, 'assistant', 'lunara',
    'visible', ?, '台本正文', 1)`).run(sequence, JSON.stringify({ content: '台本正文', presentation: 'radio_episode_script',
    episodeDependency: { episodeId: 'ep-1', revision: 1 }, voice: `/tts/${HASH}.mp3` }));
  db.prepare(`UPDATE conversation_sessions SET next_sequence = next_sequence + 1 WHERE session_id = 'conversation:room-a'`).run();
  db.prepare(`INSERT INTO conversation_observations (person_id, turn_id) VALUES ('lunara', 'episode-script:start-1')`).run();
  db.prepare(`INSERT INTO conversation_summaries (session_id, revision, from_sequence, to_sequence, content, method, created_at)
    VALUES ('conversation:room-a', 1, 1, ?, '摘要里提到了台本', 'test', 1)`).run(sequence);
  db.exec(`CREATE TABLE prefs (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE llm_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL,
      task_id TEXT NOT NULL, session_id TEXT);
    CREATE TABLE playback_start_results (start_id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, result TEXT);`);
  const insertUsage = db.prepare('INSERT INTO llm_usage (ts, day, task_id, session_id) VALUES (1, ?, ?, ?)');
  insertUsage.run('2026-10-01', 'chat', 'conversation:room-a');
  insertUsage.run('2026-10-01', 'daily_program_draft', null);
  insertUsage.run('2026-10-01', 'radio_episode_draft', null);
  insertUsage.run('2026-10-01', 'chat', 'conversation:episode-0123456789abcdef');
  db.prepare('INSERT INTO playback_start_results VALUES (?, ?, ?)')
    .run('start-1', 'ep-1', JSON.stringify({ firstVoiceAsset: { assetHash: HASH } }));
  const track = { queueItemId: 'q-track', songId: 's1', title: '歌', artist: '人', url: '/s1.mp3' };
  db.prepare(`INSERT INTO prefs (k, v) VALUES ('playback_runtime_state', ?)`).run(JSON.stringify({
    schemaVersion: 3, version: 7, outputGeneration: 2, activeListeningSessionId: 'conversation:room-a',
    queue: [{ mediaKind: 'radio_episode', queueItemId: 'q-ep', episodeId: 'ep-1' }, track],
    currentIndex: 1, currentSongId: 's1', phase: 'playing', radioMode: true,
    dailyProgramBinding: { status: 'active', savedRadioMode: false },
    modeCountedOccurrences: [{ queueItemId: 'q-track', position: 0, eligible: true, scopeKey: 'episode:ep-1' }],
    processedEventIds: ['episode-voice-ready:q-ep:blk-1:x', 'evt-1'],
    suspendedSessions: { 'conversation:episode-0123456789abcdef': { queue: [], currentIndex: -1 } },
  }));
  db.close();

  const life = new Database(join(dataDir, 'life.db'));
  life.exec(`CREATE TABLE life_entries (id TEXT PRIMARY KEY); INSERT INTO life_entries VALUES ('e1');
    CREATE TABLE life_radio_episode_grants (grant_id TEXT PRIMARY KEY); INSERT INTO life_radio_episode_grants VALUES ('g1');`);
  life.close();
  for (const name of ['daily-programs.db', 'radio-episodes.db']) {
    const legacy = new Database(join(dataDir, name));
    legacy.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);');
    legacy.close();
  }
  mkdirSync(join(root, 'cache', 'tts'), { recursive: true });
  writeFileSync(join(root, 'cache', 'tts', `${HASH}.mp3`), 'episode');
  writeFileSync(join(root, 'cache', 'tts', 'chat-line.mp3'), 'chat');
  mkdirSync(join(root, 'tasks', 'daily_program'), { recursive: true });
  writeFileSync(join(root, 'tasks', 'daily_program', 'run.jsonl'), '{}\n');
  mkdirSync(join(root, 'tasks', 'capability_probe'), { recursive: true });
  writeFileSync(join(root, 'tasks', 'capability_probe', 'run.jsonl'), '{}\n');
  return { statePath };
}

test('a data root without any programs or episodes only gets the marker', t => {
  const root = tempRoot(t);
  assert.equal(runRetiredRadioCleanup({ dataRoot: root, now: fixedNow, log: silent }).status, 'clean');
  assert.ok(existsSync(join(root, RETIRED_RADIO_MARKER)));
  assert.equal(existsSync(join(root, 'backup')), false, '没有残留就不做备份');
  assert.equal(runRetiredRadioCleanup({ dataRoot: root, now: fixedNow, log: silent }).status, 'already-done');
});

test('programs and episodes leave no trace, and a verified backup keeps the original', t => {
  const root = tempRoot(t);
  const { statePath } = seedLegacyRoot(root);
  const report = runRetiredRadioCleanup({ dataRoot: root, now: fixedNow, log: silent });
  assert.equal(report.status, 'cleaned');

  const db = new Database(statePath, { readonly: true });
  const episode = 'conversation:episode-0123456789abcdef';
  for (const table of ['conversation_sessions', 'conversation_turns', 'conversation_requests', 'conversation_members', 'llm_usage']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`, episode), 0, table);
  }
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM conversation_turns WHERE turn_id = 'episode-script:start-1'`), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM conversation_observations WHERE turn_id = 'episode-script:start-1'`), 0);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM conversation_summaries`), 0, '覆盖台本的摘要不留');
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'conversation:room-a'`), 2,
    '普通房间的真实对话原样保留');
  assert.deepEqual(db.prepare('SELECT task_id FROM llm_usage').all().map(row => row.task_id), ['chat']);
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'playback_start_results'`), 0);
  const runtime = JSON.parse(db.prepare(`SELECT v FROM prefs WHERE k = 'playback_runtime_state'`).get().v);
  db.close();
  assert.deepEqual(runtime.queue.map(item => item.queueItemId), ['q-track']);
  assert.equal(runtime.currentIndex, 0, '当前歌曲跟着队列重排，不被打断');
  assert.equal(runtime.radioMode, false, '节目接管前的续播设置被还原');
  assert.equal('dailyProgramBinding' in runtime, false);
  assert.deepEqual(runtime.suspendedSessions, {});
  assert.deepEqual(runtime.processedEventIds, ['evt-1']);
  assert.equal('scopeKey' in runtime.modeCountedOccurrences[0], false);

  const life = new Database(join(root, 'data', 'life.db'), { readonly: true });
  assert.equal(count(life, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'life_radio_episode_grants'`), 0);
  assert.equal(count(life, 'SELECT COUNT(*) AS n FROM life_entries'), 1);
  life.close();
  for (const name of ['daily-programs.db', 'radio-episodes.db']) assert.equal(existsSync(join(root, 'data', name)), false);
  assert.equal(existsSync(join(root, 'cache', 'tts', `${HASH}.mp3`)), false);
  assert.equal(existsSync(join(root, 'cache', 'tts', 'chat-line.mp3')), true, '聊天语音缓存不受影响');
  assert.equal(existsSync(join(root, 'tasks', 'daily_program')), false);
  assert.equal(existsSync(join(root, 'tasks', 'capability_probe', 'run.jsonl')), true);

  // 备份是清理前的一致副本；被移走的文件也在同一备份目录里。
  const backupDir = join(root, 'backup', 'pre-retire-radio-20261028T080000Z');
  assert.equal(report.backupDir, backupDir);
  const backup = new Database(join(backupDir, 'state.db'), { readonly: true });
  assert.equal(count(backup, `SELECT COUNT(*) AS n FROM conversation_turns WHERE turn_id = 'episode-script:start-1'`), 1);
  backup.close();
  assert.deepEqual(readdirSync(backupDir).filter(name => name.endsWith('.db')).sort(),
    ['daily-programs.db', 'life.db', 'radio-episodes.db', 'state.db']);
  assert.ok(existsSync(join(backupDir, 'tts', `${HASH}.mp3`)));
  assert.ok(existsSync(join(backupDir, 'tasks', 'daily_program', 'run.jsonl')));

  // 清理后的库照常被当前代码打开。
  const reopened = new ConversationStore({ dbPath: statePath });
  reopened.initialize();
  assert.deepEqual(reopened.listRooms().map(room => room.sessionId), ['conversation:room-a']);
  reopened.close();
  assert.equal(runRetiredRadioCleanup({ dataRoot: root, now: fixedNow, log: silent }).status, 'already-done');
});

test('a database with an open reader is left untouched until the next start', t => {
  const root = tempRoot(t);
  const { statePath } = seedLegacyRoot(root);
  const writer = new Database(statePath);
  writer.pragma('journal_mode = WAL');
  writer.prepare(`INSERT INTO llm_usage (ts, day, task_id) VALUES (2, '2026-10-02', 'chat')`).run();
  const reader = new Database(statePath);
  reader.exec('BEGIN');
  reader.prepare('SELECT COUNT(*) FROM llm_usage').get();
  writer.prepare(`INSERT INTO llm_usage (ts, day, task_id) VALUES (3, '2026-10-03', 'chat')`).run();
  try {
    const report = runRetiredRadioCleanup({ dataRoot: root, now: fixedNow, log: silent, busyTimeoutMs: 0 });
    assert.equal(report.status, 'source-busy');
  } finally {
    reader.exec('ROLLBACK');
    reader.close();
    writer.close();
  }
  assert.equal(existsSync(join(root, RETIRED_RADIO_MARKER)), false, '没清理就不写 marker，下次启动重试');
  assert.equal(existsSync(join(root, 'data', 'radio-episodes.db')), true);
  const db = new Database(statePath, { readonly: true });
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM conversation_turns WHERE turn_id = 'episode-script:start-1'`), 1);
  db.close();
});

test('development path overrides and the test runner never trigger the automatic cleanup', () => {
  assert.deepEqual(ensureRetiredRadioCleaned({ env: { LUNARA_DB_PATH: '/elsewhere/state.db' }, log: silent }),
    { status: 'skipped', reason: 'env-override' });
  assert.deepEqual(ensureRetiredRadioCleaned({ env: { NODE_TEST_CONTEXT: 'child-v8' }, log: silent }),
    { status: 'skipped', reason: 'test-runner' });
});

test('an episode room left as the active listening source falls back to the primary chat', () => {
  const primary = { queue: [{ queueItemId: 'q1', songId: 's1' }], currentIndex: 0, currentSongId: 's1', phase: 'paused' };
  const { snapshot, changed } = stripRetiredRadioFromRuntimeSnapshot({
    version: 4, outputGeneration: 1, activeListeningSessionId: 'conversation:episode-0123456789abcdef',
    queue: [{ mediaKind: 'radio_episode', queueItemId: 'q-ep' }], currentIndex: 0, phase: 'playing',
    radioEpisode: { queueItemId: 'q-ep', status: 'playing' },
    suspendedSessions: { 'conversation:primary': primary },
  });
  assert.equal(changed, true);
  assert.equal(snapshot.activeListeningSessionId, 'conversation:primary');
  assert.deepEqual(snapshot.queue, primary.queue);
  assert.equal(snapshot.phase, 'paused');
  assert.equal('radioEpisode' in snapshot, false);
  assert.deepEqual(snapshot.suspendedSessions, {});
  assert.equal(snapshot.outputGeneration, 2, '迟到的旧输出命令按代次作废');
  assert.equal(stripRetiredRadioFromRuntimeSnapshot(snapshot).changed, false);
});
