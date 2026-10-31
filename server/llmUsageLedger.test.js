// llmUsageLedger.test.js — 用量账本：记录/聚合/保留期/日内上限与拒绝语义。
//
// 对应 change `agent-budget-and-response-contract` 任务 4.1/4.2/4.4。
// Run: node --test server/llmUsageLedger.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RETENTION_DAYS, LlmUsageLedger, createLlmUsageLedger, localDay, localDayStart, parseDailyCaps, parseRetentionDays } from './llmUsageLedger.js';

function tempLedger(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-usage-'));
  const ledger = new LlmUsageLedger({ dbPath: join(dir, 'state.db'), logger: { warn() {} }, ...options });
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  return ledger;
}

test('记录与聚合：只存数值与分类，按任务分组、失败分类可查', async t => {
  const ledger = tempLedger(t);
  ledger.record({ taskId: 'song_tag', sessionId: null, provider: 'p1', model: 'm', outcome: 'ok',
    usage: { prompt_tokens: 900, completion_tokens: 120 }, reasoningTokens: 60, durationMs: 800 });
  ledger.record({ taskId: 'song_tag', outcome: 'truncated', escalated: true,
    usage: { prompt_tokens: 900, completion_tokens: 1500 }, reasoningTokens: 1400, durationMs: 2100 });
  ledger.record({ taskId: 'chat_dialogue', sessionId: 'sess-1', outcome: 'ok',
    usage: { prompt_tokens: 500, completion_tokens: 300 } });

  const summary = ledger.summary({ days: 1 });
  assert.equal(summary.calls, 3);
  assert.equal(summary.promptTokens, 2300);
  assert.equal(summary.completionTokens, 1920);
  assert.equal(summary.reasoningTokens, 1460);
  assert.equal(summary.escalated, 1);
  assert.deepEqual(summary.failures, [{ outcome: 'truncated', count: 1 }]);
  const songTag = summary.byTask.find(row => row.taskId === 'song_tag');
  assert.deepEqual([songTag.calls, songTag.completionTokens, songTag.escalated], [2, 1620, 1]);

  // 表结构不含正文/提示字段：只记数值与分类（design §4）。
  const columns = ledger.db.prepare('PRAGMA table_info(llm_usage)').all().map(row => row.name);
  assert.deepEqual(columns.filter(name => /text|content|prompt_text|body|message/i.test(name)), []);
});

test('保留期默认一年、可由 LLM_USAGE_RETENTION_DAYS 覆盖，坏值回落、越界夹紧', () => {
  assert.equal(DEFAULT_RETENTION_DAYS, 365, '默认保留一年：设置页要画 53 周热力图');
  assert.equal(parseRetentionDays({}), DEFAULT_RETENTION_DAYS);
  assert.equal(parseRetentionDays({ LLM_USAGE_RETENTION_DAYS: '90' }), 90);
  assert.equal(parseRetentionDays({ LLM_USAGE_RETENTION_DAYS: '1' }), 7, '下限 7 天');
  assert.equal(parseRetentionDays({ LLM_USAGE_RETENTION_DAYS: '99999' }), 3650, '上限 3650 天');
  assert.equal(parseRetentionDays({ LLM_USAGE_RETENTION_DAYS: 'abc' }), DEFAULT_RETENTION_DAYS);
  assert.equal(parseRetentionDays({ LLM_USAGE_RETENTION_DAYS: '-5' }), DEFAULT_RETENTION_DAYS);
});

test('有界保留：超期行在下次写入时被清理', async t => {
  const now = Date.now();
  const ledger = tempLedger(t, { retentionDays: 30, now: () => now });
  ledger.record({ taskId: 'song_tag', outcome: 'ok', ts: now - 40 * 24 * 3600 * 1000 });
  ledger.record({ taskId: 'song_tag', outcome: 'ok', ts: now - 3 * 24 * 3600 * 1000 });
  assert.equal(ledger.summary({ days: 60 }).calls, 1, '超 30 天的行被清理，保留期内的仍在');
  assert.equal(ledger.prune(1), 1, '手动清理按参数生效');
  assert.equal(ledger.summary({ days: 60 }).calls, 0);
});

test('日内上限：按"已用 + 在飞 + 本次额度"预拒，release 释放预留', async t => {
  const ledger = tempLedger(t, { caps: { song_tag: 1000 }, now: () => Date.now() });
  assert.deepEqual(ledger.checkDaily({ taskId: 'song_tag', tokens: 600 }), { ok: true, reserved: 600 });
  const second = ledger.checkDaily({ taskId: 'song_tag', tokens: 600 });
  assert.equal(second.ok, false, '在飞预留计入上限，防止并发击穿');
  assert.equal(second.code, 'LLM_BUDGET_EXHAUSTED');
  assert.equal(second.cap, 1000);
  assert.equal(second.used, 600);

  ledger.release({ taskId: 'song_tag', tokens: 600 });
  assert.equal(ledger.checkDaily({ taskId: 'song_tag', tokens: 600 }).ok, true, '释放后可再预留');

  ledger.record({ taskId: 'song_tag', outcome: 'ok', usage: { completion_tokens: 500 } });
  assert.equal(ledger.tokensToday('song_tag'), 500);
  assert.equal(ledger.checkDaily({ taskId: 'song_tag', tokens: 600 }).ok, false, '已用 500 + 本次 600 > 1000');
  assert.equal(ledger.checkDaily({ taskId: 'chat_dialogue', tokens: 999999 }).ok, true, '未配置上限的任务不受影响');
});

test('拒绝写账并可查询：budget_rejected 不计入 token 用量', async t => {
  const ledger = tempLedger(t, { caps: { song_tag: 100 } });
  const rejection = ledger.noteRejection({ taskId: 'song_tag', reason: 'daily_tokens', cap: 100, used: 120 });
  assert.deepEqual([rejection.reason, rejection.cap, rejection.used], ['daily_tokens', 100, 120]);
  assert.equal(ledger.lastRejection.cap, 100);
  const summary = ledger.summary({ days: 1 });
  assert.equal(summary.budgetRejected, 1);
  assert.equal(summary.byTask.find(row => row.taskId === 'song_tag').completionTokens, 0);
});

test('env 覆盖：LLM_DAILY_TOKEN_CAPS 解析，坏值忽略', () => {
  const caps = parseDailyCaps({ LLM_DAILY_TOKEN_CAPS: 'song_tag=12345, chat_dialogue=5000,bogus=abc' });
  assert.equal(caps.song_tag, 12345);
  assert.equal(caps.chat_dialogue, 5000);
  assert.equal(caps.reflection, 120_000, '未覆盖的任务保持默认');
  assert.equal('bogus' in caps, false);
});

test('createLlmUsageLedger：observe 只消费 attempt 事件；guard 预留与释放成对', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-usage-'));
  const wiring = createLlmUsageLedger({ dbPath: join(dir, 'state.db'), caps: { song_tag: 100 }, logger: { warn() {} } });
  t.after(() => { wiring.close(); rmSync(dir, { recursive: true, force: true }); });

  wiring.observe({ phase: 'start', taskId: 'song_tag' });
  wiring.observe({ phase: 'attempt', taskId: 'song_tag', outcome: 'ok', model: 'm', providerId: 'p1',
    usage: { prompt_tokens: 10, completion_tokens: 20 }, escalatedFrom: 700, durationMs: 300 });
  const summary = wiring.summary({ days: 1 });
  assert.equal(summary.calls, 1, 'start 事件不落账');
  assert.equal(summary.escalated, 1, '升级过的尝试如实标记');

  const allowed = wiring.guard({ taskId: 'song_tag', tokens: 60 });
  assert.equal(allowed.reserved, 60);
  allowed.release();
  const verdict = wiring.guard({ taskId: 'song_tag', tokens: 90 });
  assert.equal(verdict.ok, false, '已用 20 + 本次 90 > 上限 100');
  assert.equal(verdict.code, 'LLM_BUDGET_EXHAUSTED');
  assert.equal(wiring.lastRejection().cap, 100);
  assert.equal(wiring.lastRejection().used, 20);
  assert.equal(wiring.summary({ days: 1 }).budgetRejected, 1, '拒绝写进账本并可查');
});

test('本地日期分桶：跨天重置', async t => {
  let now = new Date('2026-10-15T23:59:00').getTime();
  const ledger = tempLedger(t, { caps: { song_tag: 100 }, now: () => now });
  ledger.record({ taskId: 'song_tag', outcome: 'ok', usage: { completion_tokens: 90 }, ts: now });
  assert.equal(ledger.checkDaily({ taskId: 'song_tag', tokens: 20 }).ok, false);
  now = new Date('2026-10-16T00:01:00').getTime();
  assert.equal(localDay(now), '2026-10-16');
  assert.equal(ledger.checkDaily({ taskId: 'song_tag', tokens: 90 }).ok, true, '新的一天重新计算');
});

// ============================================================
// 审查缺口修复（2026-10-16）：失败/探测入账、缺用量保守结算、口径归一、幂等与增量列
// ============================================================

test('缺用量不按零结算：失败尝试按预留额度保守记账并标记估计', async t => {
  const ledger = tempLedger(t, { caps: { song_tag: 100 }, now: () => Date.now() });
  const wiring = createLlmUsageLedger({ db: ledger.db, caps: { song_tag: 100 }, logger: { warn() {} } });
  // 一次 HTTP 失败：没有 usage，但有预留额度 90。
  wiring.observe({ phase: 'attempt', taskId: 'song_tag', outcome: 'provider_error', status: 500,
    budget: { requested: 60, effective: 90, allowance: 30, reservedTokens: 90 }, attemptId: 'a-1' });
  const summary = wiring.summary({ days: 1 });
  assert.equal(summary.calls, 1, '失败请求同样入账');
  assert.deepEqual(summary.failures, [{ outcome: 'provider_error', count: 1 }]);
  assert.equal(summary.outputTokens, 90, '缺用量按预留额度估计');
  assert.equal(summary.estimatedTokens, 90);
  assert.equal(summary.unknownUsage, 1, '估计与真实分开标记');
  assert.equal(ledger.tokensToday('song_tag'), 90, '保守结算进入日内已用');
  assert.equal(wiring.guard({ taskId: 'song_tag', tokens: 20 }).ok, false, '已用 90 + 20 > 100 被拒绝');
});

test('Google 分开返回的思考 token 计入预算，不重复加已含思考的协议', async t => {
  const ledger = tempLedger(t, { caps: { song_tag: 100 } });
  const wiring = createLlmUsageLedger({ db: ledger.db, caps: { song_tag: 100 }, logger: { warn() {} } });
  wiring.observe({ phase: 'attempt', taskId: 'song_tag', api: 'google-generative-ai', outcome: 'ok',
    usage: { completion_tokens: 10 }, reasoningTokens: 90, attemptId: 'g-1' });
  wiring.observe({ phase: 'attempt', taskId: 'reflection', api: 'openai-completions', outcome: 'ok',
    usage: { completion_tokens: 10 }, reasoningTokens: 90, attemptId: 'o-1' });
  assert.equal(ledger.tokensToday('song_tag'), 100, 'Google：completion + thoughts');
  assert.equal(ledger.tokensToday('reflection'), 10, 'OpenAI：completion 已含思考，不重复相加');
});

test('同一 attemptId 重复观测幂等：不重复记账', async t => {
  const ledger = tempLedger(t, { caps: { song_tag: 1000 } });
  const wiring = createLlmUsageLedger({ db: ledger.db, caps: { song_tag: 1000 }, logger: { warn() {} } });
  const event = { phase: 'attempt', taskId: 'song_tag', outcome: 'ok', attemptId: 'dup-1',
    usage: { completion_tokens: 30 }, outputTokens: 30 };
  wiring.observe(event);
  wiring.observe(event);
  wiring.observe({ ...event, phase: 'error' });
  assert.equal(wiring.summary({ days: 1 }).calls, 1, '重复/迟到事件不再叠加');
});

test('能力探测有独立日内上限并能被拒绝（探测不再绕过预算）', async t => {
  const ledger = tempLedger(t, { caps: parseDailyCaps({ LLM_DAILY_TOKEN_CAPS: '' }) });
  assert.equal(ledger.caps.capability_probe > 0, true, '默认给出有界的探测额度');
  const wiring = createLlmUsageLedger({ db: ledger.db, caps: { capability_probe: 100 }, logger: { warn() {} } });
  const ok = wiring.guard({ taskId: 'capability_probe', tokens: 90, attemptId: 'p-1' });
  assert.equal(ok.ok, true);
  ok.release();
  const blocked = wiring.guard({ taskId: 'capability_probe', tokens: 200, attemptId: 'p-2' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'LLM_BUDGET_EXHAUSTED');
  assert.equal(wiring.summary({ days: 1 }).budgetRejected, 1, '拒绝写进账本');
});

test('预留按 attemptId 幂等释放，跨任务互不影响', async t => {
  const ledger = tempLedger(t, { caps: { song_tag: 100 } });
  const wiring = createLlmUsageLedger({ db: ledger.db, caps: { song_tag: 100 }, logger: { warn() {} } });
  const first = wiring.guard({ taskId: 'song_tag', tokens: 60, attemptId: 'r-1' });
  assert.equal(first.ok, true);
  first.release();
  first.release(); // 幂等：重复释放不能把别人的预留一起释放
  assert.equal(wiring.guard({ taskId: 'song_tag', tokens: 60, attemptId: 'r-2' }).ok, true, '释放后可再预留');
});

test('老库增量补列：不重建表，历史行仍可读', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-usage-old-'));
  const dbPath = join(dir, 'state.db');
  const legacy = new (await import('better-sqlite3')).default(dbPath);
  legacy.exec(`CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, task_id TEXT NOT NULL,
    session_id TEXT, provider TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,
    reasoning_tokens INTEGER, calls INTEGER NOT NULL DEFAULT 1, escalated INTEGER NOT NULL DEFAULT 0,
    outcome TEXT, duration_ms INTEGER, cost_estimate REAL);
    INSERT INTO llm_usage (ts, day, task_id, completion_tokens, calls, outcome)
      VALUES (${Date.now()}, '${localDay()}', 'song_tag', 40, 1, 'ok');`);
  legacy.close();
  const ledger = new LlmUsageLedger({ dbPath, caps: { song_tag: 100 }, logger: { warn() {} } });
  t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
  const columns = ledger.db.prepare('PRAGMA table_info(llm_usage)').all().map(row => row.name);
  for (const name of ['output_tokens', 'estimated', 'attempt_id', 'api']) assert.ok(columns.includes(name), name);
  assert.equal(ledger.tokensToday('song_tag'), 40, '老行仍按 completion_tokens 统计');
  const summary = ledger.summary({ days: 1 });
  assert.equal(summary.calls, 1);
  assert.equal(summary.outputTokens, 40);
});

test('ambient_turn 按任务落账；默认不设 token 日上限，可以用环境变量设（add-companion-heartbeat 3.1）', async t => {
  assert.equal(parseDailyCaps({}).ambient_turn, undefined, '次数上限由心跳管，token 默认不拦');
  assert.equal(parseDailyCaps({ LLM_DAILY_TOKEN_CAPS: 'ambient_turn=5000000' }).ambient_turn, 5_000_000);
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-usage-'));
  const wiring = createLlmUsageLedger({ dbPath: join(dir, 'state.db'), caps: { ambient_turn: 1000 }, logger: { warn() {} } });
  t.after(() => { wiring.close(); rmSync(dir, { recursive: true, force: true }); });
  wiring.observe({ phase: 'attempt', taskId: 'ambient_turn', outcome: 'ok', model: 'm', attemptId: 'a-1',
    usage: { prompt_tokens: 900, completion_tokens: 120 } });
  assert.equal(wiring.ledger.tokensToday('ambient_turn'), 120);
  assert.equal(wiring.ledger.tokensToday('chat_dialogue'), 0, '不混进普通对话的用量');
  const blocked = wiring.guard({ taskId: 'ambient_turn', tokens: 2048, attemptId: 'a-2' });
  assert.equal(blocked.code, 'LLM_BUDGET_EXHAUSTED');
});

// ============================================================
// 用量报告（change add-usage-dashboard）：连续日序列 + totals + 按模型拆分
// ============================================================

/** 指定本地日（offset 天前）正午的 ts：避免跨午夜或夏令时边界把记录落到相邻日。 */
function tsOnLocalDay(dayOffset, base, hour = 12) {
  const date = new Date(localDayStart(base, dayOffset));
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
}

test('报告：daily 连续补零，totals/todayOutputTokens/activeDays/peak/streak 正确', async t => {
  const now = new Date('2026-10-20T12:00:00').getTime();
  const ledger = tempLedger(t, { now: () => now, retentionDays: 30 });
  ledger.record({ taskId: 'chat_dialogue', outcome: 'ok', provider: 'p1', model: 'm-a',
    usage: { prompt_tokens: 10, completion_tokens: 100 }, ts: tsOnLocalDay(0, now) });
  ledger.record({ taskId: 'chat_dialogue', outcome: 'ok',
    usage: { prompt_tokens: 5, completion_tokens: 50 }, ts: tsOnLocalDay(1, now) });
  ledger.record({ taskId: 'song_tag', outcome: 'ok',
    usage: { completion_tokens: 30 }, ts: tsOnLocalDay(2, now) });
  // 第 3、4 天没有调用（洞），第 5 天有：daily 仍必须连续。
  ledger.record({ taskId: 'song_tag', outcome: 'ok',
    usage: { completion_tokens: 20 }, ts: tsOnLocalDay(5, now) });

  const report = ledger.report({ days: 7 });
  const expectedDays = Array.from({ length: 7 }, (_, index) => localDay(localDayStart(now, 6 - index)));
  assert.equal(report.days, 7);
  assert.equal(report.retentionDays, 30);
  assert.equal(report.daily.length, 7, '窗口内每天一项，缺失日补零而不是省略');
  assert.deepEqual(report.daily.map(item => item.day), expectedDays, '从最旧到最新的连续本地日');
  assert.deepEqual(report.daily.map(item => item.calls), [0, 1, 0, 0, 1, 1, 1]);
  assert.deepEqual(report.daily[0], { day: expectedDays[0], calls: 0, outputTokens: 0,
    promptTokens: 0, reasoningTokens: 0, estimatedCalls: 0, escalated: 0, failures: 0 });
  assert.deepEqual(report.coverage, { from: expectedDays[0], to: localDay(now) });

  assert.equal(report.totals.calls, 4);
  assert.equal(report.totals.outputTokens, 200);
  assert.equal(report.totals.promptTokens, 15);
  assert.equal(report.totals.reasoningTokens, 0);
  assert.equal(report.totals.todayOutputTokens, 100);
  assert.equal(report.totals.activeDays, 4);
  assert.equal(report.totals.avgPerActiveDay, 50, '200 / 4 天');
  assert.deepEqual(report.totals.peak, { day: localDay(now), outputTokens: 100 });
  assert.equal(report.totals.streakDays, 3, '今天、昨天、前天连续，再往前断开');
  assert.equal(typeof report.daily[1].promptTokens, 'number', '返回数字而不是字符串');
  assert.equal(typeof report.totals.outputTokens, 'number');

  // 只读：报告不写账本。
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM llm_usage').get().count, 4);
});

test('报告：今天无调用时 streak 从昨天数起；全 0 时 peak/avg 为 null', async t => {
  const now = new Date('2026-10-20T09:00:00').getTime();
  const ledger = tempLedger(t, { now: () => now, retentionDays: 30 });
  ledger.record({ taskId: 'chat_dialogue', outcome: 'ok',
    usage: { completion_tokens: 40 }, ts: tsOnLocalDay(1, now) });
  ledger.record({ taskId: 'chat_dialogue', outcome: 'ok',
    usage: { completion_tokens: 10 }, ts: tsOnLocalDay(2, now) });
  const report = ledger.report({ days: 7 });
  assert.equal(report.totals.streakDays, 2, '今天没有调用，从昨天向前数');
  assert.equal(report.totals.todayOutputTokens, 0);
  assert.equal(report.totals.activeDays, 2);
  assert.equal(report.totals.avgPerActiveDay, 25);
  assert.deepEqual(report.totals.peak, { day: localDay(localDayStart(now, 1)), outputTokens: 40 },
    '峰值取 outputTokens 最大的一天');

  const empty = tempLedger(t, { now: () => now, retentionDays: 30 });
  const emptyReport = empty.report({ days: 7 });
  assert.equal(emptyReport.totals.streakDays, 0);
  assert.equal(emptyReport.totals.peak, null);
  assert.equal(emptyReport.totals.avgPerActiveDay, null);
  assert.equal(emptyReport.totals.activeDays, 0);
  assert.equal(emptyReport.totals.calls, 0);
  assert.equal(emptyReport.totals.outputTokens, 0);
  assert.equal(emptyReport.daily.length, 7);
  assert.deepEqual(emptyReport.byModel, []);
  assert.equal(emptyReport.byModelTruncated, false);
  assert.deepEqual(emptyReport.failingOutcomes, []);
});

test('报告：估计用量单列、失败与拒绝分类、按模型排序并截断到 12', async t => {
  const now = new Date('2026-10-20T12:00:00').getTime();
  const ledger = tempLedger(t, { now: () => now, retentionDays: 30 });
  // 13 个模型同一天：输出 token 10..130，验证降序与 top 12 截断。
  for (let index = 1; index <= 13; index += 1) {
    ledger.record({ taskId: 'song_tag', outcome: 'ok', provider: 'p1',
      model: `m-${String(index).padStart(2, '0')}`,
      usage: { prompt_tokens: index, completion_tokens: index * 10 }, ts: tsOnLocalDay(0, now) });
  }
  // 估计用量：供应方没回 usage，按预留额度保守记账；估计次数单独计。
  ledger.record({ taskId: 'reflection', outcome: 'provider_error', provider: 'p1', model: 'm-99',
    estimated: true, outputTokens: 75, ts: tsOnLocalDay(1, now) });
  ledger.record({ taskId: 'reflection', outcome: 'provider_error', ts: tsOnLocalDay(1, now) });
  ledger.record({ taskId: 'reflection', outcome: 'truncated', ts: tsOnLocalDay(1, now) });
  ledger.record({ taskId: 'song_tag', outcome: 'budget_rejected', ts: tsOnLocalDay(1, now) });

  const report = ledger.report({ days: 3 });
  assert.equal(report.byModel.length, 12, '最多 12 项');
  assert.equal(report.byModelTruncated, true);
  assert.equal(report.byModel[0].model, 'm-13');
  assert.deepEqual(report.byModel[0], { provider: 'p1', model: 'm-13', calls: 1,
    outputTokens: 130, promptTokens: 13, reasoningTokens: 0 });
  assert.deepEqual(report.byModel.map(item => item.outputTokens),
    [130, 120, 110, 100, 90, 80, 75, 70, 60, 50, 40, 30], '按输出 token 降序');
  assert.equal(report.byModel.at(-1).model, 'm-03');
  assert.equal(report.byModel.some(item => item.model === 'm-02'), false, '最小的模型被截断');
  assert.equal(typeof report.byModel[0].outputTokens, 'number');

  // 13 个模型 × 10..130 = 910，加估计的 75；拒绝记录不产生 token。
  assert.equal(report.totals.calls, 17);
  assert.equal(report.totals.outputTokens, 985);
  assert.equal(report.totals.estimatedCalls, 1, '估计用量单独计数，不当作真实调用次数');
  assert.equal(report.totals.failures, 3, 'provider_error x2 + truncated；budget_rejected 不算失败');
  assert.equal(report.totals.todayOutputTokens, 910);
  assert.equal(report.totals.activeDays, 2);
  assert.equal(report.totals.avgPerActiveDay, 493, '985 / 2 四舍五入');
  assert.equal(report.totals.streakDays, 2);
  assert.deepEqual(report.failingOutcomes,
    [{ outcome: 'provider_error', count: 2 }, { outcome: 'truncated', count: 1 }]);
});

test('报告：days 越界夹紧到保留期、非法回落默认；coverage 与字段集合稳定', async t => {
  const now = new Date('2026-10-20T12:00:00').getTime();
  const ledger = tempLedger(t, { now: () => now, retentionDays: 30 });
  ledger.record({ taskId: 'chat_dialogue', outcome: 'ok',
    usage: { completion_tokens: 40 }, ts: tsOnLocalDay(0, now) });
  ledger.record({ taskId: 'chat_dialogue', outcome: 'ok', ts: tsOnLocalDay(1, now) });

  assert.equal(ledger.report({ days: 9999 }).days, 30, '超过保留期夹到 retentionDays');
  assert.equal(ledger.report({ days: 9999 }).daily.length, 30);
  assert.equal(ledger.report({ days: -1 }).days, 1, '负数夹到 1');
  assert.deepEqual(ledger.report({ days: -1 }).daily.map(item => item.day), [localDay(now)]);
  assert.equal(ledger.report({ days: 0 }).days, 1);
  assert.equal(ledger.report({ days: 'abc' }).days, 30, '非法值回落默认 30');
  assert.equal(ledger.report({}).days, 30);
  assert.equal(ledger.report().daily.length, 30);

  // 自定义保留期同样生效：报告窗口绝不超出账本保留期。
  const shortLedger = tempLedger(t, { now: () => now, retentionDays: 7 });
  assert.equal(shortLedger.report({ days: 9999 }).days, 7);
  assert.equal(shortLedger.report({ days: 9999 }).coverage.from, localDay(localDayStart(now, 6)));

  const report = ledger.report({ days: 3 });
  assert.deepEqual(Object.keys(report).sort(), ['byModel', 'byModelTruncated', 'coverage', 'daily',
    'days', 'failingOutcomes', 'retentionDays', 'totals'], '只有契约字段，不夹带未定义字段');
  assert.deepEqual(Object.keys(report.daily[0]).sort(), ['calls', 'day', 'escalated', 'estimatedCalls',
    'failures', 'outputTokens', 'promptTokens', 'reasoningTokens']);
  assert.deepEqual(Object.keys(report.totals).sort(), ['activeDays', 'avgPerActiveDay', 'calls',
    'estimatedCalls', 'failures', 'outputTokens', 'peak', 'promptTokens', 'reasoningTokens',
    'streakDays', 'todayOutputTokens']);
  assert.equal(JSON.stringify(report).includes('undefined'), false);
  assert.equal(/"(content|reply|text|apiKey|baseUrl|endpoint|sessionId)"/.test(JSON.stringify(report)), false,
    '报告不含正文、凭据、端点或会话内容');
  // provider/model 缺失时如实给 null，不编造。
  const nullModel = report.byModel.find(item => item.model === null);
  assert.ok(nullModel, '没有 provider/model 的行仍按 null 分组');
  assert.equal(nullModel.provider, null);
  assert.equal(nullModel.calls, 2);
});

test('createLlmUsageLedger 暴露只读 report（服务层与路由共用同一账本对象）', async t => {
  const ledger = tempLedger(t);
  const wiring = createLlmUsageLedger({ db: ledger.db, logger: { warn() {} } });
  ledger.record({ taskId: 'chat_dialogue', outcome: 'ok', usage: { completion_tokens: 12 } });
  const report = wiring.report({ days: 1 });
  assert.equal(report.days, 1);
  assert.equal(report.totals.outputTokens, 12);
  assert.equal(report.coverage.to, localDay());
  assert.equal(wiring.report({ days: 30 }).daily.length, 30, '缺省窗口 30 天（保留期 30）');
});
