// llmUsageLedger.js — 模型用量账本与上限（change agent-budget-and-response-contract design §4）。
//
// 目标：用量可见、超限显式拒绝、绝不半夜静默跑飞；账本**只记数值与分类**，
// 不存任何提示或回复正文。
//
//   - 表 `llm_usage`：每次**实际发出的请求**一行（task、session、provider、model、
//     token 用量、分类、耗时、是否升级）；有界保留（默认 30 天，写入时惰性清理）。
//     审查修复（2026-10-16）：探测、HTTP/网络失败与取消同样落账；`attempt_id` 唯一，
//     重复观测幂等（llm.js 每次 fetch 分配一次，guard 预留与尝试事件共用）。
//   - 口径归一：`output_tokens` 是“思考计入输出”的总量（Google 的 completion 与
//     thoughts 分开返回，必须相加；OpenAI/Anthropic 的 completion 已含思考，不重复加）。
//     供应方没有返回用量时按预留额度保守结算并标记 `estimated=1`，绝不当作零费用。
//   - 日内上限：按任务类别的 token 上限（默认只拦后台机械任务与能力探测；聊天/选歌/
//     串词的边界由各自的任务规格与回合上限负责），达到后该任务当日拒绝新调用。
//     预留语义：检查时按"今日已用 + 在飞预留 + 本次生效额度"判断，绝不先发请求再判断；
//     在飞预留按预留日结算，跨天不会互相释放。
//   - 拒绝语义：抛 LLM_BUDGET_EXHAUSTED（带 cap/used，不含端点与凭据），写一条
//     `budget_rejected` 记录；后台任务被拒绝不影响聊天与播放、也没有无限重试。
//
// 单任务突发与回合上限沿用既有边界值（收编，不重复实现）：AgentLoop maxRounds × 任务规格生效额度、
// 打标队列并发 1 + 占位 TTL —— 账本负责的是它们之外的"日内总量"。

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDatabasePath } from './runtimePaths.js';

// 保留期默认一年：设置页的用量热力图按「周为列」展示 53 周，30 天会让它只剩 5 列。
// 账本只存数值与分类（无正文），一年仍是**有界**保留；需要时可再用
// LLM_USAGE_RETENTION_DAYS 缩短或调大（7–3650）。
export const DEFAULT_RETENTION_DAYS = 365;

/** 保留期上限：再长也没有产品意义，且避免误配把库撑大。 */
const MAX_RETENTION_DAYS = 3650;

/**
 * 保留期可用环境变量覆盖（LLM_USAGE_RETENTION_DAYS）：默认仍是 30 天（有界保留是既有策略），
 * 想看到更长的用量热力图（例如一年）需要显式打开；坏值忽略、越界夹紧，绝不因配置报错。
 */
export function parseRetentionDays(env = process.env) {
  const parsed = Number.parseInt(env?.LLM_USAGE_RETENTION_DAYS, 10);
  // 非数字/非正数视为坏值（回落默认），正数再夹到 [7, 3650]。
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(7, parsed));
}

// 报告默认窗口（change add-usage-dashboard）：设置页「使用统计」近 30 天。
export const DEFAULT_REPORT_DAYS = 30;
// 按模型拆分最多返回的条数（超出由 byModelTruncated 标记，前端给出说明）。
export const MAX_REPORT_MODELS = 12;

// 后台机械任务的默认日内 token 上限（请求额度口径，含思考余量；保守但不误伤日常使用）。
export const DEFAULT_DAILY_TOKEN_CAPS = Object.freeze({
  song_tag: 300_000,
  reflection: 120_000,
  taste_schema: 120_000,
  taste_consolidation: 120_000,
  persona_generation: 60_000,
  // 能力探测也是真实调用：给一个有界的日内额度，探测失控时不拖累聊天与播放。
  capability_probe: 60_000,
  // 一起听歌时的主动唤醒（ambient_turn）不设默认 token 上限：次数已由 CompanionHeartbeat 的
  // 每小时/每日上限约束；需要时用 LLM_DAILY_TOKEN_CAPS="ambient_turn=…" 设。
});

/** 解析 LLM_DAILY_TOKEN_CAPS="song_tag=300000,reflection=120000"（坏值忽略）。 */
export function parseDailyCaps(env = process.env) {
  const caps = { ...DEFAULT_DAILY_TOKEN_CAPS };
  const raw = String(env?.LLM_DAILY_TOKEN_CAPS || '').trim();
  if (!raw) return caps;
  for (const pair of raw.split(',')) {
    const [taskId, value] = pair.split('=').map(part => String(part || '').trim());
    const tokens = Number.parseInt(value, 10);
    if (taskId && Number.isInteger(tokens) && tokens >= 0) caps[taskId] = tokens;
  }
  return caps;
}

export function localDay(now = Date.now()) {
  const date = new Date(now);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 本地当日起点（摘要窗口与日内上限用同一口径）。 */
export function localDayStart(now = Date.now(), dayOffset = 0) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (Number(dayOffset) || 0));
  return date.getTime();
}

function openDatabase(dbPath) {
  const path = dbPath || resolveDatabasePath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
CREATE TABLE IF NOT EXISTS llm_usage (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  day               TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  session_id        TEXT,
  provider          TEXT,
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  reasoning_tokens  INTEGER,
  calls             INTEGER NOT NULL DEFAULT 1,
  escalated         INTEGER NOT NULL DEFAULT 0,
  outcome           TEXT,
  duration_ms       INTEGER,
  cost_estimate     REAL
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_day_task ON llm_usage(day, task_id);
`);
  // 增量列（审查修复）：老库保留原行，只补列——不用迁移脚本，也不清空历史。
  const columns = new Set(db.prepare('PRAGMA table_info(llm_usage)').all().map(row => row.name));
  for (const [name, definition] of [
    ['output_tokens', 'INTEGER'],
    ['estimated', 'INTEGER NOT NULL DEFAULT 0'],
    ['attempt_id', 'TEXT'],
    ['api', 'TEXT'],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE llm_usage ADD COLUMN ${name} ${definition}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_usage_attempt ON llm_usage(attempt_id) WHERE attempt_id IS NOT NULL');
  return db;
}

function numberOrNull(value) {
  // Number(null) === 0：缺失必须保持 null，否则“没有用量”会被记成零费用。
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 归一化“思考计入输出”的总量：优先用调用方算好的 outputTokens（llm.js 按协议归一），
 * 否则退回 completion（OpenAI/Anthropic 已含思考；Google 由调用方补 reasoning）。
 */
export function effectiveOutputTokens({ usage = null, reasoningTokens = null, api = null, outputTokens = null } = {}) {
  const explicit = numberOrNull(outputTokens);
  if (explicit != null) return explicit;
  const completion = numberOrNull(usage?.completion_tokens);
  if (completion == null) return null;
  const reasoning = numberOrNull(reasoningTokens);
  return completion + (api === 'google-generative-ai' && reasoning != null ? reasoning : 0);
}

export class LlmUsageLedger {
  constructor({ db = null, dbPath = null, retentionDays = parseRetentionDays(),
    caps = null, now = () => Date.now(), logger = console } = {}) {
    this.db = db || openDatabase(dbPath);
    this.retentionDays = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
    this.caps = { ...(caps || {}) };
    this.now = now;
    this.logger = logger;
    // 在飞预留：attemptId → { taskId, tokens, day }。按预留日结算，跨天不互相释放。
    this.inflight = new Map();
    this.lastRejection = null;
    this._prunedDay = null;
  }

  /** 每次实际请求一行（由 llm.js 的观测事件驱动）；同 attemptId 重复观测幂等。 */
  record({ taskId = 'unspecified', sessionId = null, provider = null, model = null, api = null,
    usage = null, reasoningTokens = null, outputTokens = null, estimated = false,
    attemptId = null, calls = 1, escalated = false, outcome = null,
    durationMs = null, costEstimate = null, ts = null } = {}) {
    // 注意：Number(null) === 0，必须显式判 null，否则缺省 ts 会写成 0 并被保留期立即清理。
    const at = ts != null && Number.isFinite(Number(ts)) ? Number(ts) : this.now();
    const statement = attemptId
      ? `INSERT OR IGNORE INTO llm_usage
        (ts, day, task_id, session_id, provider, model, api, prompt_tokens, completion_tokens,
         reasoning_tokens, output_tokens, estimated, attempt_id, calls, escalated, outcome, duration_ms, cost_estimate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO llm_usage
        (ts, day, task_id, session_id, provider, model, api, prompt_tokens, completion_tokens,
         reasoning_tokens, output_tokens, estimated, attempt_id, calls, escalated, outcome, duration_ms, cost_estimate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.db.prepare(statement).run(
      at, localDay(at), String(taskId || 'unspecified'), sessionId || null, provider || null, model || null,
      api ? String(api) : null,
      numberOrNull(usage?.prompt_tokens), numberOrNull(usage?.completion_tokens),
      numberOrNull(reasoningTokens),
      effectiveOutputTokens({ usage, reasoningTokens, api, outputTokens }),
      estimated ? 1 : 0, attemptId ? String(attemptId) : null,
      Math.max(1, Number(calls) || 1), escalated ? 1 : 0,
      outcome ? String(outcome) : null, numberOrNull(durationMs), numberOrNull(costEstimate));
    this.#pruneIfNeeded(at);
  }

  /** 账本自身的拒绝事件（也可查询；文案不含端点与凭据）。 */
  noteRejection({ taskId = 'unspecified', reason = 'daily_tokens', cap = null, used = null } = {}) {
    const rejection = { ts: this.now(), taskId, reason,
      ...(cap != null ? { cap } : {}), ...(used != null ? { used } : {}) };
    this.lastRejection = rejection;
    try {
      this.record({ taskId, outcome: 'budget_rejected', calls: 1, ts: rejection.ts });
    } catch { /* 记录失败不影响拒绝本身 */ }
    return rejection;
  }

  #inflightToday(taskId, day = localDay(this.now())) {
    let total = 0;
    for (const entry of this.inflight.values()) {
      if (entry.taskId === taskId && entry.day === day) total += entry.tokens;
    }
    return total;
  }

  /**
   * 日内上限检查（真正发请求之前）。返回 { ok: true } 或
   * { ok: false, code: 'LLM_BUDGET_EXHAUSTED', taskId, cap, used }。
   * 预留语义：今日已用 + 今日在飞预留 + 本次额度 > 上限即拒绝。
   * attemptId 可选：给出时预留按 id 记录，release 幂等且跨天互不干扰。
   */
  checkDaily({ taskId = 'unspecified', tokens = 0, attemptId = null } = {}) {
    const task = String(taskId || 'unspecified');
    const cap = this.caps[task];
    const requested = Math.max(0, Number(tokens) || 0);
    const key = attemptId ? String(attemptId) : `anon:${task}:${this.inflight.size}:${this.now()}`;
    if (!Number.isFinite(cap)) {
      this.inflight.set(key, { taskId: task, tokens: requested, day: localDay(this.now()) });
      return { ok: true, reserved: requested };
    }
    const used = this.tokensToday(task) + this.#inflightToday(task);
    if (used + requested > cap) return { ok: false, code: 'LLM_BUDGET_EXHAUSTED', taskId: task, cap, used };
    this.inflight.set(key, { taskId: task, tokens: requested, day: localDay(this.now()) });
    return { ok: true, reserved: requested };
  }

  /** 请求结束后释放预留（成功或失败都要释放，绝不泄漏；同 attemptId 重复释放幂等）。 */
  release({ taskId = 'unspecified', tokens = 0, attemptId = null } = {}) {
    const task = String(taskId || 'unspecified');
    if (attemptId && this.inflight.has(String(attemptId))) {
      this.inflight.delete(String(attemptId));
      return;
    }
    // 无 id（测试或旧调用）：按任务做一次减扣。
    const requested = Math.max(0, Number(tokens) || 0);
    for (const [key, entry] of this.inflight) {
      if (entry.taskId !== task) continue;
      const next = entry.tokens - requested;
      if (next > 0) this.inflight.set(key, { ...entry, tokens: next });
      else this.inflight.delete(key);
      return;
    }
  }

  tokensToday(taskId = null, day = localDay(this.now())) {
    // 归一口径：output_tokens 是首选，老行退回 completion_tokens。
    const expression = 'COALESCE(SUM(COALESCE(output_tokens, completion_tokens, 0)), 0) AS tokens';
    const row = taskId
      ? this.db.prepare(`SELECT ${expression} FROM llm_usage
          WHERE day = ? AND task_id = ? AND outcome IS NOT 'budget_rejected'`).get(day, String(taskId))
      : this.db.prepare(`SELECT ${expression} FROM llm_usage
          WHERE day = ? AND outcome IS NOT 'budget_rejected'`).get(day);
    return Number(row?.tokens) || 0;
  }

  /** 聚合查询（设置页摘要与 GET /api/llm/usage）：按任务分组，只回数值与分类。 */
  summary({ days = 1 } = {}) {
    const window = Math.max(1, Number(days) || 1);
    // 与日内上限同一口径：本地日对齐的窗口（不是滚动 24h）。
    const since = localDayStart(this.now(), window - 1);
    const rows = this.db.prepare(`SELECT task_id, COUNT(*) AS calls,
        COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(COALESCE(output_tokens, completion_tokens, 0)), 0) AS output_tokens,
        COALESCE(SUM(CASE WHEN estimated = 1 THEN COALESCE(output_tokens, completion_tokens, 0) ELSE 0 END), 0) AS estimated_tokens,
        COALESCE(SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END), 0) AS unknown_usage,
        COALESCE(SUM(escalated), 0) AS escalated
      FROM llm_usage WHERE ts >= ? GROUP BY task_id ORDER BY calls DESC`).all(since);
    const failures = this.db.prepare(`SELECT outcome, COUNT(*) AS count FROM llm_usage
      WHERE ts >= ? AND outcome IS NOT NULL AND outcome NOT IN ('ok', 'budget_rejected')
      GROUP BY outcome ORDER BY count DESC`).all(since);
    const rejected = this.db.prepare(`SELECT COUNT(*) AS count FROM llm_usage
      WHERE ts >= ? AND outcome = 'budget_rejected'`).get(since);
    const sum = key => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    return {
      days: window,
      calls: sum('calls'),
      promptTokens: sum('prompt_tokens'),
      completionTokens: sum('completion_tokens'),
      // 归一口径（思考计入输出）——预算与展示都应读这个值。
      outputTokens: sum('output_tokens'),
      reasoningTokens: sum('reasoning_tokens'),
      // 供应方没给用量的尝试按预留额度保守结算，单独标出“估计”部分。
      estimatedTokens: sum('estimated_tokens'),
      unknownUsage: sum('unknown_usage'),
      escalated: sum('escalated'),
      budgetRejected: Number(rejected?.count || 0),
      byTask: rows.map(row => ({ taskId: row.task_id, calls: Number(row.calls),
        promptTokens: Number(row.prompt_tokens), completionTokens: Number(row.completion_tokens),
        outputTokens: Number(row.output_tokens), reasoningTokens: Number(row.reasoning_tokens),
        estimatedTokens: Number(row.estimated_tokens), unknownUsage: Number(row.unknown_usage),
        escalated: Number(row.escalated) })),
      failures: failures.map(row => ({ outcome: row.outcome, count: Number(row.count) })),
      attemptFailures: failures.map(row => ({ outcome: row.outcome, count: Number(row.count) })),
      lastRejection: this.lastRejection,
    };
  }

  /**
   * 用量报告（GET /api/llm/usage/report，change add-usage-dashboard）：
   * 逐日连续序列 + totals + 按模型拆分 + 失败分类。只读，不写库，
   * 只含数值与分类（不含提示、回复正文、端点或凭据）。
   *
   * 口径与 summary 一致：output_tokens 是「思考计入输出」的归一总量
   * （老行退回 completion_tokens）；估计用量计入 token 总量，但调用次数
   * 单独由 estimatedCalls 标记，绝不把估计混进真实次数。
   */
  report({ days = DEFAULT_REPORT_DAYS } = {}) {
    const now = this.now();
    // 窗口：整数按 [1, retentionDays] 夹紧；非法值回落默认 30，再按保留期夹紧。
    // （报告默认窗口仍是 30 天，页面会显式请求 365 天来做全年热力图。）
    const requested = Number.parseInt(days, 10);
    const fallback = Math.min(this.retentionDays, DEFAULT_REPORT_DAYS);
    const window = Number.isInteger(requested)
      ? Math.min(this.retentionDays, Math.max(1, requested))
      : fallback;
    // 与 summary / 日内上限同一口径：本地日对齐的窗口（不是滚动 24h）。
    const since = localDayStart(now, window - 1);

    const dayRows = this.db.prepare(`SELECT day, COUNT(*) AS calls,
        COALESCE(SUM(COALESCE(output_tokens, completion_tokens, 0)), 0) AS output_tokens,
        COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS prompt_tokens,
        COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning_tokens,
        COALESCE(SUM(CASE WHEN estimated = 1 THEN 1 ELSE 0 END), 0) AS estimated_calls,
        COALESCE(SUM(escalated), 0) AS escalated,
        COALESCE(SUM(CASE WHEN outcome IS NOT NULL AND outcome NOT IN ('ok', 'budget_rejected')
          THEN 1 ELSE 0 END), 0) AS failures
      FROM llm_usage WHERE ts >= ? GROUP BY day`).all(since);
    const byDay = new Map(dayRows.map(row => [row.day, row]));
    // 连续序列：从 since 当天到今天，缺失日补零（前端热力图/趋势直接消费）。
    const daily = [];
    for (let offset = window - 1; offset >= 0; offset -= 1) {
      const day = localDay(localDayStart(now, offset));
      const row = byDay.get(day);
      daily.push({
        day,
        calls: Number(row?.calls) || 0,
        outputTokens: Number(row?.output_tokens) || 0,
        promptTokens: Number(row?.prompt_tokens) || 0,
        reasoningTokens: Number(row?.reasoning_tokens) || 0,
        estimatedCalls: Number(row?.estimated_calls) || 0,
        escalated: Number(row?.escalated) || 0,
        failures: Number(row?.failures) || 0,
      });
    }

    const total = key => daily.reduce((sum, item) => sum + item[key], 0);
    const activeDays = daily.filter(item => item.calls > 0).length;
    const outputTokens = total('outputTokens');
    // 峰值：outputTokens 最大的一天；全 0 时没有峰值。
    let peak = null;
    for (const item of daily) {
      if (item.outputTokens <= 0) continue;
      if (!peak || item.outputTokens > peak.outputTokens) {
        peak = { day: item.day, outputTokens: item.outputTokens };
      }
    }
    // 连续天数：从今天向前数 calls>0 的天；今天没有调用时从昨天开始；全 0 为 0。
    let streakDays = 0;
    for (let index = daily.length - 1; index >= 0; index -= 1) {
      if (daily[index].calls > 0) {
        streakDays += 1;
        continue;
      }
      if (index === daily.length - 1) continue;
      break;
    }

    const modelRows = this.db.prepare(`SELECT provider, model, COUNT(*) AS calls,
        COALESCE(SUM(COALESCE(output_tokens, completion_tokens, 0)), 0) AS output_tokens,
        COALESCE(SUM(COALESCE(prompt_tokens, 0)), 0) AS prompt_tokens,
        COALESCE(SUM(COALESCE(reasoning_tokens, 0)), 0) AS reasoning_tokens
      FROM llm_usage WHERE ts >= ? GROUP BY provider, model
      ORDER BY output_tokens DESC, calls DESC, provider ASC, model ASC`).all(since);
    // 缺失 provider/model（老行或未指定）如实给 null，不编造替代名。
    const label = value => (value == null || String(value) === '' ? null : String(value));
    const byModel = modelRows.slice(0, MAX_REPORT_MODELS).map(row => ({
      provider: label(row.provider),
      model: label(row.model),
      calls: Number(row.calls) || 0,
      outputTokens: Number(row.output_tokens) || 0,
      promptTokens: Number(row.prompt_tokens) || 0,
      reasoningTokens: Number(row.reasoning_tokens) || 0,
    }));

    // 失败分类与 summary 同口径：非空 outcome 且不是 ok / budget_rejected。
    const failingOutcomes = this.db.prepare(`SELECT outcome, COUNT(*) AS count FROM llm_usage
      WHERE ts >= ? AND outcome IS NOT NULL AND outcome NOT IN ('ok', 'budget_rejected')
      GROUP BY outcome ORDER BY count DESC, outcome ASC`).all(since)
      .map(row => ({ outcome: row.outcome, count: Number(row.count) || 0 }));

    return {
      days: window,
      retentionDays: this.retentionDays,
      coverage: { from: daily[0].day, to: daily[daily.length - 1].day },
      daily,
      totals: {
        calls: total('calls'),
        outputTokens,
        promptTokens: total('promptTokens'),
        reasoningTokens: total('reasoningTokens'),
        estimatedCalls: total('estimatedCalls'),
        failures: total('failures'),
        todayOutputTokens: daily[daily.length - 1].outputTokens,
        activeDays,
        avgPerActiveDay: activeDays > 0 ? Math.round(outputTokens / activeDays) : null,
        peak,
        streakDays,
      },
      byModel,
      byModelTruncated: modelRows.length > MAX_REPORT_MODELS,
      failingOutcomes,
    };
  }

  prune(retentionDays = this.retentionDays) {
    const cutoff = this.now() - Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    try {
      const info = this.db.prepare('DELETE FROM llm_usage WHERE ts < ?').run(cutoff);
      return Number(info?.changes) || 0;
    } catch (error) {
      this.logger?.warn?.(`[llm-usage] prune failed: ${error?.message || error}`);
      return 0;
    }
  }

  /** 每天第一次写入时惰性清理一次：有界保留，不需要启动定时器。 */
  #pruneIfNeeded(at) {
    const day = localDay(at);
    if (this._prunedDay === day) return;
    this._prunedDay = day;
    this.prune();
  }

  close() {
    try { this.db.close(); } catch { /* 关闭失败不影响退出 */ }
  }
}

/**
 * 生产装配：账本 + 传输层守卫 + 观测消费。
 *   - guard：在真正发请求之前检查日内上限，超限显式拒绝（fail closed）。
 *   - observe(phase='attempt')：每次实际请求落账（成功/失败/取消/探测都有这条事件）。
 *     供应方没给用量时按本次预留额度保守结算并标记估计——失败请求绝不按零费用记账。
 */
export function createLlmUsageLedger({ dbPath = null, db = null, caps = parseDailyCaps(),
  retentionDays = parseRetentionDays(), now = () => Date.now(), logger = console } = {}) {
  const ledger = new LlmUsageLedger({ db, dbPath, caps, retentionDays, now, logger });
  return {
    ledger,
    /** 供组合根注入 llm.js：setLlmBudgetGuard(usageWiring.guard)。 */
    guard({ taskId, tokens, attemptId = null } = {}) {
      const task = String(taskId || 'unspecified');
      const verdict = ledger.checkDaily({ taskId: task, tokens, attemptId });
      if (verdict.ok) {
        // 预留与释放成对：调用方（llm.js）在一次 fetch 结束后一定释放。
        return { ok: true, reserved: verdict.reserved, taskId: task,
          release: () => ledger.release({ taskId: task, tokens, attemptId }) };
      }
      const rejection = ledger.noteRejection({ taskId: task, reason: 'daily_tokens',
        cap: verdict.cap, used: verdict.used });
      return { ok: false, ...verdict, rejection };
    },
    /** 观测事件（llm.js）：不抛、不阻塞业务。 */
    observe(event) {
      if (event?.phase !== 'attempt') return;
      try {
        const outputTokens = effectiveOutputTokens({ usage: event.usage || null,
          reasoningTokens: event.reasoningTokens ?? null, api: event.api || null,
          outputTokens: event.outputTokens ?? null });
        // 缺用量（失败/取消/网关不回 usege）＝结果不确定：按预留额度保守结算并标记估计。
        const estimated = outputTokens == null;
        const reserved = numberOrNull(event.budget?.reservedTokens ?? event.budget?.effective);
        ledger.record({
          taskId: event.taskId, sessionId: event.sessionId ?? null, provider: event.providerId || null,
          model: event.model || null, api: event.api || null,
          usage: event.usage || null, reasoningTokens: event.reasoningTokens ?? null,
          outputTokens: estimated ? reserved : outputTokens, estimated,
          attemptId: event.attemptId ?? null,
          escalated: event.escalatedFrom != null, outcome: event.outcome || null,
          durationMs: event.durationMs ?? null,
        });
      } catch (error) {
        logger?.warn?.(`[llm-usage] record failed: ${error?.message || error}`);
      }
    },
    release: args => ledger.release(args),
    checkDaily: args => ledger.checkDaily(args),
    summary: args => ledger.summary(args),
    /** 用量报告（GET /api/llm/usage/report）：只读聚合，不写库。 */
    report: args => ledger.report(args),
    lastRejection: () => ledger.lastRejection,
    close: () => ledger.close(),
  };
}

export default createLlmUsageLedger;
