// synthesisFailureLog.js — 伙伴发声失败的本地记录（有界，最新 200 条）。
//
// 提醒只在原因变化时广播一次、不落库；这里每次可归因的失败都记一条，回答「到底是超时、
// 排队还是厂商拒绝」。只存封闭字段：时间、接口 id、原因码、代读接口、总耗时、卡住的阶段与
// 分段毫秒、尝试次数、HTTP 状态。不存要念的文字、上游原文、key、URL。
// 写入失败只吞掉：记录不能拖慢或打断发声。只接受一个 db 句柄，单测用临时库。

const DEFAULT_LIMIT = 200;
const PHASES = new Set(['queue', 'request', 'retry-wait', 'read']);
const ms = value => (value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : null);

function projectRow(row) {
  return {
    at: Number(row.at),
    endpointId: row.endpoint_id,
    reason: row.reason,
    fallbackEndpointId: row.fallback_endpoint_id || null,
    elapsedMs: ms(row.elapsed_ms),
    phase: row.phase || null,
    queueMs: ms(row.queue_ms),
    retryWaitMs: ms(row.retry_wait_ms),
    requestMs: ms(row.request_ms),
    readMs: ms(row.read_ms),
    attempts: row.attempts == null ? null : Number(row.attempts),
    statuses: row.statuses ? JSON.parse(row.statuses) : [],
  };
}

export function createSynthesisFailureLog({ db, now = () => Date.now(), limit = DEFAULT_LIMIT, logger = console } = {}) {
  if (!db) throw new TypeError('createSynthesisFailureLog requires a database connection');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tts_synthesis_failures (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      at                   INTEGER NOT NULL,
      endpoint_id          TEXT NOT NULL,
      reason               TEXT NOT NULL,
      fallback_endpoint_id TEXT,
      elapsed_ms           INTEGER,
      phase                TEXT,
      queue_ms             INTEGER,
      retry_wait_ms        INTEGER,
      request_ms           INTEGER,
      attempts             INTEGER,
      statuses             TEXT,
      read_ms              INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tts_synthesis_failures_endpoint ON tts_synthesis_failures (endpoint_id, id);
  `);
  // 早期版本把接收音频算进 request_ms、没有 read_ms 列：补列即可，旧行 readMs 为 null。
  const columns = db.prepare('PRAGMA table_info(tts_synthesis_failures)').all().map(column => column.name);
  if (!columns.includes('read_ms')) db.exec('ALTER TABLE tts_synthesis_failures ADD COLUMN read_ms INTEGER');
  const statements = {
    insert: db.prepare(`INSERT INTO tts_synthesis_failures
      (at, endpoint_id, reason, fallback_endpoint_id, elapsed_ms, phase, queue_ms, retry_wait_ms, request_ms, read_ms, attempts, statuses)
      VALUES (@at, @endpointId, @reason, @fallbackEndpointId, @elapsedMs, @phase, @queueMs, @retryWaitMs, @requestMs, @readMs, @attempts, @statuses)`),
    prune: db.prepare('DELETE FROM tts_synthesis_failures WHERE id <= (SELECT MAX(id) FROM tts_synthesis_failures) - ?'),
    recent: db.prepare('SELECT * FROM tts_synthesis_failures ORDER BY id DESC LIMIT ?'),
    recentForEndpoint: db.prepare('SELECT * FROM tts_synthesis_failures WHERE endpoint_id = ? ORDER BY id DESC LIMIT ?'),
  };

  /** 记一次失败；timing 来自 provider（免费声音等没有闸门的接口为 null，只记总耗时）。 */
  function record({ endpoint, code, fallback = null, timing = null, elapsedMs = null } = {}) {
    if (!endpoint || !code) return;
    try {
      const statuses = (timing?.statuses || []).map(Number).filter(Number.isInteger).slice(0, 10);
      statements.insert.run({
        at: now(),
        endpointId: String(endpoint).slice(0, 120),
        reason: String(code).slice(0, 40),
        fallbackEndpointId: fallback ? String(fallback).slice(0, 120) : null,
        elapsedMs: ms(timing?.elapsedMs ?? elapsedMs),
        phase: PHASES.has(timing?.phase) ? timing.phase : null,
        queueMs: ms(timing?.queueMs),
        retryWaitMs: ms(timing?.retryWaitMs),
        requestMs: ms(timing?.requestMs),
        readMs: ms(timing?.readMs),
        attempts: timing?.attempts == null ? null : Number(timing.attempts),
        statuses: statuses.length ? JSON.stringify(statuses) : null,
      });
      statements.prune.run(limit);
    } catch (error) {
      logger?.warn?.(`[tts] failure log write skipped: ${error?.message || error}`);
    }
  }

  function list({ endpointId = null, limit: count = 20 } = {}) {
    const size = Math.max(1, Math.min(limit, Number(count) || 20));
    const rows = endpointId ? statements.recentForEndpoint.all(String(endpointId), size) : statements.recent.all(size);
    return rows.map(projectRow);
  }

  return Object.freeze({ record, list });
}

export default createSynthesisFailureLog;
