import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSynthesisFailureLog } from './synthesisFailureLog.js';

function fixture({ limit } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-tts-failures-'));
  const db = new Database(join(dir, 'state.db'));
  let clock = 1_000;
  const log = createSynthesisFailureLog({ db, now: () => (clock += 1), ...(limit ? { limit } : {}), logger: null });
  return { db, log, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const TIMING = { phase: 'queue', queueMs: 24_100, retryWaitMs: 0, requestMs: 1_200, readMs: 4_700, attempts: 1, statuses: [200], elapsedMs: 30_000 };

test('记录封闭字段，最新在前，可按接口过滤', () => {
  const { log, cleanup } = fixture();
  log.record({ endpoint: 'custom', code: 'timeout', timing: TIMING });
  log.record({ endpoint: 'custom-minimax', code: 'credit-exhausted', elapsedMs: 800 });
  log.record({ endpoint: 'custom', code: 'rate-limited', fallback: 'free-edge', timing: { ...TIMING, phase: 'request', statuses: [429, 429, 429], attempts: 3 } });
  const all = log.list();
  assert.deepEqual(all.map(entry => entry.reason), ['rate-limited', 'credit-exhausted', 'timeout']);
  assert.deepEqual(log.list({ endpointId: 'custom' }).map(entry => entry.reason), ['rate-limited', 'timeout']);
  assert.deepEqual(all[2], {
    at: 1_001, endpointId: 'custom', reason: 'timeout', fallbackEndpointId: null, elapsedMs: 30_000, phase: 'queue',
    queueMs: 24_100, retryWaitMs: 0, requestMs: 1_200, readMs: 4_700, attempts: 1, statuses: [200],
  });
  assert.deepEqual(all[1], {
    at: 1_002, endpointId: 'custom-minimax', reason: 'credit-exhausted', fallbackEndpointId: null, elapsedMs: 800, phase: null,
    queueMs: null, retryWaitMs: null, requestMs: null, readMs: null, attempts: null, statuses: [],
  });
  assert.equal(all[0].fallbackEndpointId, 'free-edge');
  cleanup();
});

test('只保留最新 limit 条', () => {
  const { log, cleanup } = fixture({ limit: 3 });
  for (let index = 0; index < 5; index += 1) log.record({ endpoint: 'custom', code: index % 2 ? 'busy' : 'timeout', elapsedMs: index });
  assert.deepEqual(log.list().map(entry => entry.elapsedMs), [4, 3, 2]);
  cleanup();
});

test('表里没有放文字、上游原文或 key 的列；缺接口或原因不记', () => {
  const { db, log, cleanup } = fixture();
  const columns = db.prepare('PRAGMA table_info(tts_synthesis_failures)').all().map(column => column.name);
  assert.deepEqual(columns, ['id', 'at', 'endpoint_id', 'reason', 'fallback_endpoint_id', 'elapsed_ms', 'phase', 'queue_ms', 'retry_wait_ms', 'request_ms', 'attempts', 'statuses', 'read_ms']);
  log.record({ endpoint: '', code: 'timeout' });
  log.record({ endpoint: 'custom', code: '' });
  assert.equal(log.list().length, 0);
  cleanup();
});

test('旧表（没有 read_ms 列）启动时补列，旧行 readMs 为 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-tts-failures-'));
  const db = new Database(join(dir, 'state.db'));
  db.exec(`CREATE TABLE tts_synthesis_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, endpoint_id TEXT NOT NULL,
    reason TEXT NOT NULL, fallback_endpoint_id TEXT, elapsed_ms INTEGER, phase TEXT, queue_ms INTEGER, retry_wait_ms INTEGER,
    request_ms INTEGER, attempts INTEGER, statuses TEXT);
    INSERT INTO tts_synthesis_failures (at, endpoint_id, reason, elapsed_ms, phase, request_ms) VALUES (1, 'custom', 'timeout', 30000, 'read', 30000);`);
  const log = createSynthesisFailureLog({ db, now: () => 2, logger: null });
  log.record({ endpoint: 'custom', code: 'timeout', timing: { ...TIMING, phase: 'read' } });
  const [fresh, legacy] = log.list();
  assert.equal(legacy.readMs, null);
  assert.equal(legacy.requestMs, 30_000);
  assert.equal(fresh.readMs, 4_700);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('写入失败只吞掉，不抛给发声路径', () => {
  const { db, log, cleanup } = fixture();
  db.close();
  assert.doesNotThrow(() => log.record({ endpoint: 'custom', code: 'timeout' }));
  cleanup();
});
