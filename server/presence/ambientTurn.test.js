// ambientTurn.test.js — ambient turn 的纯函数部分：运行时提示、记忆检索 query、结果解释
// （add-companion-heartbeat D2.2 / 3.6 / 3.7）。
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AMBIENT_MARKER_PREFIX, ambientMemoryQuery, ambientResultOf, awayBucket, awayText, buildAmbientMarker,
} from './ambientTurn.js';

const SHANGHAI = 'Asia/Shanghai';
// 2026-10-19 22:30 北京时间。
const firedAtMs = Date.parse('2026-10-19T14:30:00.000Z');
const wake = (overrides = {}) => ({ id: `ambient:room:lunara:${firedAtMs}`, sessionId: 'room', personId: 'lunara',
  reason: 'heartbeat', firedAtMs, previousWakeAtMs: null, sinceLastWake: { completed: 0, skipped: 0 },
  modeRevision: 3, policy: { id: 'balanced', perHour: 4 }, ...overrides });
const task = { contextText: '正在放《夜航星》（不才）。', recentLines: [] };

test('运行时提示：固定前缀、当地时段、只写已知的间隔，不含 wake id、原因码或预算', () => {
  const marker = buildAmbientMarker({ wake: wake(), timeZone: SHANGHAI,
    lastUserTurnAtMs: firedAtMs - 12 * 60_000, lastSpokeAtMs: firedAtMs - 3 * 60_000,
    currentTrack: { title: '夜航星', artist: '不才' } });
  assert.ok(marker.startsWith(AMBIENT_MARKER_PREFIX));
  assert.match(marker, /晚上/);
  assert.match(marker, /对方此刻没有在跟你说话/);
  assert.match(marker, /距对方上次说话大约 12 分钟/);
  assert.match(marker, /距你上次开口大约 3 分钟/);
  assert.match(marker, /这段时间：没什么变化/);
  assert.match(marker, /现在在放《夜航星》（不才）/);
  assert.match(marker, /这次醒来是因为：过了一阵/);
  assert.doesNotMatch(marker, /ambient:|heartbeat|balanced|perHour|modeRevision|预算|\d{10,}/);

  const unknown = buildAmbientMarker({ wake: wake(), timeZone: SHANGHAI });
  assert.doesNotMatch(unknown, /距对方|距你/, '不知道的间隔不写');
  assert.doesNotMatch(unknown, /现在在放/);
});

test('运行时提示：这段时间的事实来自唤醒时累计的权威计数；事件唤醒写「有事发生」', () => {
  const counted = buildAmbientMarker({ timeZone: SHANGHAI,
    wake: wake({ reason: 'track_skipped', sinceLastWake: { completed: 2, skipped: 3 } }) });
  assert.match(counted, /这段时间：完整听完了 2 首，跳过了 3 首/);
  assert.match(counted, /这次醒来是因为：有事发生/);
  assert.match(buildAmbientMarker({ timeZone: SHANGHAI, wake: wake({ reason: 'session_open' }) }), /一起听刚开始/);
  assert.match(buildAmbientMarker({ timeZone: SHANGHAI, wake: wake({ reason: 'queue_exhausted' }) }), /这一批歌放完了/);
  const early = buildAmbientMarker({ timeZone: SHANGHAI, wake: wake({ firedAtMs: Date.parse('2026-10-19T22:00:00.000Z') }) });
  assert.match(early, /清晨/, '北京时间 06:00');
  assert.match(buildAmbientMarker({ timeZone: SHANGHAI, wake: wake(), lastUserTurnAtMs: firedAtMs - 20_000 }),
    /距对方上次说话不到 1 分钟/);
  assert.match(buildAmbientMarker({ timeZone: SHANGHAI, wake: wake(), lastUserTurnAtMs: firedAtMs - 150 * 60_000 }),
    /距对方上次说话大约 3 小时/);
});

test('运行时提示：她自己约过的事只告诉约的那个人，说成「你之前想着」', () => {
  const followups = [{ noteId: 'note:f1', personId: 'lunara', about: '问问方案交了没' },
    { noteId: 'note:f2', personId: 'xiaoman', about: '那首歌的翻唱' }];
  const mine = buildAmbientMarker({ timeZone: SHANGHAI, wake: wake({ reason: 'followup', followups }) });
  assert.match(mine, /这次醒来是因为：你之前想着「问问方案交了没」，想回头再想想/);
  assert.doesNotMatch(mine, /翻唱|note:|提醒/);
  const other = buildAmbientMarker({ timeZone: SHANGHAI, wake: wake({ reason: 'followup', personId: 'yehang', followups }) });
  assert.match(other, /这次醒来是因为：有事发生/);
  assert.doesNotMatch(other, /方案|翻唱/);
});

test('记忆检索 query：最近一条用户原话加当前曲目，有界', () => {
  assert.equal(ambientMemoryQuery({ lastUserText: '今天加班到很晚', currentTrack: { title: '夜航星', artist: '不才' } }),
    '今天加班到很晚 夜航星 不才');
  assert.equal(ambientMemoryQuery({}), '');
  assert.ok(ambientMemoryQuery({ lastUserText: '长'.repeat(500) }).length <= 200);
});

test('结果解释：被接受的 presence_respond 决定说或安静', () => {
  const accepted = { finalText: '', outcomes: [
    { ok: false, terminal: false, code: 'AMBIENT_LINE_REJECTED', facts: { rejectedRule: 'too_long' } },
    { ok: true, terminal: true, code: 'AMBIENT_LINE_ACCEPTED', facts: { action: 'speak', text: '夜深了，副歌真亮。' } },
  ] };
  assert.deepEqual(ambientResultOf({ result: accepted, task }), { action: 'speak', text: '夜深了，副歌真亮。' });
  assert.deepEqual(ambientResultOf({ result: { finalText: '', outcomes: [
    { ok: true, terminal: true, code: 'AMBIENT_QUIET', facts: { action: 'quiet' } }] }, task }), { action: 'quiet' });
});

test('结果解释：没调 presence_respond 的纯文本一律按安静，不出口，并标出 plain-text 与被丢的那句', () => {
  // 实机 trace：她想安静时直接回了「我不出声，就让曲子放着」，旧兜底把它当成要说的话。
  // 2026-10-21：被丢的那句随结果带出（截到 280 字），只给 trace 用来区分「说出来的安静」和真台词。
  assert.deepEqual(ambientResultOf({ result: { finalText: '  夜挺深了，我不出声，就让这些曲子接着放。 ', outcomes: [] }, task }),
    { action: 'quiet', dropped: 'plain-text', droppedText: '夜挺深了，我不出声，就让这些曲子接着放。' });
  assert.deepEqual(ambientResultOf({ result: { finalText: '要不要听听《晴天》？', outcomes: [] }, task }),
    { action: 'quiet', dropped: 'plain-text', droppedText: '要不要听听《晴天》？' });
  assert.equal(ambientResultOf({ result: { finalText: '长'.repeat(400), outcomes: [] }, task }).droppedText.length, 280);
  assert.deepEqual(ambientResultOf({ result: { finalText: '', outcomes: [] }, task }), { action: 'quiet' });
});

test('结果解释：失败都是沉默，原因只落在封闭集合里', () => {
  const failed = code => Object.assign(new Error('x'), { code });
  assert.deepEqual(ambientResultOf({ error: failed('EMPTY_ASSISTANT_RESPONSE'), task }), { action: 'quiet' });
  assert.deepEqual(ambientResultOf({ error: failed('AGENT_ROUND_LIMIT'), task }), { action: 'silent', reason: 'rejected' });
  assert.deepEqual(ambientResultOf({ error: failed('AGENT_TIMEOUT'), task }), { action: 'silent', reason: 'timeout' });
  assert.deepEqual(ambientResultOf({ error: failed('LLM_BUDGET_EXHAUSTED'), task }), { action: 'silent', reason: 'llm-budget' });
  assert.deepEqual(ambientResultOf({ error: failed('ECONNRESET'), task }), { action: 'silent', reason: 'error' });
  assert.deepEqual(ambientResultOf({ error: new Error('turn cancelled'), aborted: true, task }),
    { action: 'silent', reason: 'interrupted' });
  assert.deepEqual(ambientResultOf({ result: { finalText: '', outcomes: [
    { ok: true, terminal: true, code: 'AMBIENT_LINE_ACCEPTED', facts: { action: 'speak', text: '嗯。' } }] }, aborted: true, task }),
  { action: 'silent', reason: 'interrupted' }, '被中止的结果不能再说出口');
});

test('回来了（app_open）：只说对方刚打开 app 和粗粒度离开时长，不说在一起听、不写精确间隔或曲目', () => {
  const marker = buildAmbientMarker({ timeZone: SHANGHAI,
    wake: wake({ reason: 'app_open', awayMs: 9 * 3_600_000, firedAtMs: Date.parse('2026-10-20T00:30:00.000Z') }),
    lastUserTurnAtMs: firedAtMs - 9 * 3_600_000, currentTrack: { title: '夜航星', artist: '不才' } });
  assert.ok(marker.startsWith(AMBIENT_MARKER_PREFIX));
  assert.match(marker, /上午/);
  assert.match(marker, /对方刚打开 app，离你们上次见面过了大半天，此刻还没有跟你说话/);
  assert.match(marker, /这次醒来是因为：对方回来了/);
  assert.doesNotMatch(marker, /一起听|在放|距对方|这段时间|\d+ 小时|app_open/);
  assert.deepEqual([0.5, 1.5, 3, 8, 30, 80].map(h => awayBucket(h * 3_600_000)), [null, 'hour', 'hours', 'overnight', 'day', 'days']);
  assert.deepEqual(['hour', 'hours', 'overnight', 'day', 'days'].map(b => awayText(b)), ['一个多小时', '几个小时', '大半天', '一天多', '好几天']);
});
