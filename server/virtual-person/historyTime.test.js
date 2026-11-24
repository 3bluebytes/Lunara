import assert from 'node:assert/strict';
import test from 'node:test';

import { REAL_CLOCK_RESET_MS, historyTimeLabels, sessionElapsedMs, sessionGapLine } from './historyTime.js';

const HOUR = 60 * 60 * 1000;
const base = new Date('2026-10-01T23:30:00').getTime();
const turn = (turnId, role, createdAt) => ({ turnId, role, createdAt });

test('隔了一小时以上的用户消息带时间，连续聊天和刚发的消息不带', () => {
  const turns = [
    turn('u1', 'user', base), turn('a1', 'assistant', base + 60_000),
    turn('u2', 'user', base + 5 * 60_000), turn('a2', 'assistant', base + 6 * 60_000),
    turn('u3', 'user', base + 9 * HOUR),
  ];
  const labels = historyTimeLabels(turns, base + 9 * HOUR + 60_000);
  assert.deepEqual([...labels.keys()], ['u1']);
  assert.match(labels.get('u1'), /10月1日 23:30/);
});

test('隔夜回来的消息本身也算较早消息时带时间', () => {
  const turns = [turn('u1', 'user', base), turn('a1', 'assistant', base + 60_000), turn('u2', 'user', base + 3 * HOUR)];
  assert.deepEqual([...historyTimeLabels(turns, base + 5 * HOUR).keys()], ['u1', 'u2']);
});

test('本轮之前隔了多久写进系统提示；连续聊天不写', () => {
  const turns = [turn('u1', 'user', base), turn('a1', 'assistant', base + 60_000), turn('u2', 'user', base + 7 * 24 * HOUR)];
  assert.match(sessionGapLine(turns, base + 7 * 24 * HOUR + 1000), /已过 6 天.*10月1日 23:31/);
  const recent = [turn('u1', 'user', base), turn('a1', 'assistant', base + 60_000), turn('u2', 'user', base + 10 * 60_000)];
  assert.equal(sessionGapLine(recent, base + 10 * 60_000), '');
  assert.equal(sessionGapLine([turn('u1', 'user', base)], base + 1000), '');
});

test('ambient 回合没有新用户消息时从最后一条算起', () => {
  const turns = [turn('u1', 'user', base), turn('a1', 'assistant', base + 60_000)];
  assert.match(sessionGapLine(turns, base + 60_000 + 2 * HOUR + 30 * 60_000), /已过 2 小时 30 分钟/);
});

test('REAL_CLOCK_RESET_MS 25 分钟阈值：<25m 留空，>=25m 触发生理/场景归零提示', () => {
  assert.equal(REAL_CLOCK_RESET_MS, 25 * 60 * 1000);
  const turns = [turn('u1', 'user', base), turn('a1', 'assistant', base + 60_000)];
  assert.equal(
    sessionElapsedMs([...turns, turn('u2', 'user', base + 24 * 60_000)], base + 24 * 60_000),
    23 * 60_000,
  );
  assert.equal(sessionGapLine([...turns, turn('u2', 'user', base + 25 * 60_000)], base + 25 * 60_000), '');
  assert.match(sessionGapLine(turns, base + 26 * 60_000), /已过 25 分钟[\s\S]*平复归零/);
  assert.match(sessionGapLine(turns, base + 41 * 60_000), /已过 40 分钟[\s\S]*平复归零/);
});

test('长离开后用户连续发多条消息时跳过同簇连发，仍锚定上一条真实历史算 gap', () => {
  const after2h = base + 2 * HOUR;
  const turnsBurst = [
    turn('u1', 'user', base - 60_000),
    turn('a1', 'assistant', base),
    turn('u2', 'user', after2h),
    turn('u3', 'user', after2h + 3_000),
    turn('u4', 'user', after2h + 40_000),
  ];
  assert.equal(sessionElapsedMs(turnsBurst, after2h + 41_000), 2 * HOUR + 41_000);
  assert.match(sessionGapLine(turnsBurst, after2h + 41_000), /已过 2 小时[\s\S]*平复归零/);

  // 中间夹着 assistant 回复时不能跨过 assistant 去找更早的消息。
  const withAssistant = [
    turn('a1', 'assistant', base),
    turn('u2', 'user', after2h),
    turn('a2', 'assistant', after2h + 2_000),
    turn('u3', 'user', after2h + 5_000),
  ];
  assert.equal(sessionElapsedMs(withAssistant, after2h + 6_000), 4_000);
  assert.equal(sessionGapLine(withAssistant, after2h + 6_000), '');

  // 用户两条消息间隔 >= 2 分钟，不视为同一簇连发。
  const spacedUsers = [
    turn('a1', 'assistant', base),
    turn('u2', 'user', after2h),
    turn('u3', 'user', after2h + 2 * 60_000),
  ];
  assert.equal(sessionElapsedMs(spacedUsers, after2h + 2 * 60_000 + 1000), 2 * 60_000 + 1000);
  assert.equal(sessionGapLine(spacedUsers, after2h + 2 * 60_000 + 1000), '');

  // 刚开场只有用户连发、前面没有任何历史消息时返回 null / 空串。
  assert.equal(sessionElapsedMs([turn('u1', 'user', base), turn('u2', 'user', base + 2_000)], base + 3_000), null);
  assert.equal(sessionGapLine([turn('u1', 'user', base), turn('u2', 'user', base + 2_000)], base + 3_000), '');
});
