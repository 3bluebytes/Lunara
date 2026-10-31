// writeMemoryWithEncoding.js — v2 统一写入入口（memory-system-v2 change）
//
// 任何写记忆的地方都该走这里，而不是直接 svc.addMemory()，目的：
//   1. 写入时自动填充 6 个 encoding 特异性字段（mood / time_bucket / day_of_week /
//      weather / session_id / last_activated_at）
//   2. caller-supplied 字段优先，hints 兜底，都没有则从 env.js 推断或留 NULL
//   3. 类型校验（v2 只接受 working / episodic / semantic / life_state）
//
// 设计原则：缺数据时**不要瞎填**，留 NULL 让 retrieval 层降级，比假数据更可靠。

import { getTimeBucket, getDayOfWeek } from '../env.js';

/**
 * @typedef {object} EncodingHints
 * @property {string} [mood]         - 当前伙伴 mood，比时钟推断更可靠时优先用
 * @property {string} [time_bucket]  - 调用方已知的 time_bucket
 * @property {number} [day_of_week]  - 调用方已知的 day_of_week
 * @property {string} [weather]      - 当前天气，env.js getWeather() 异步拿，所以由调用方传入
 * @property {string} [session_id]   - 当前伙伴 session id
 */

/**
 * 写记忆，自动填充 encoding-specificity 字段。
 *
 * @param {object} memoryService - MemoryService 实例（必须已 initialize）
 * @param {object} record        - 记忆记录（同 MemoryService.addMemory 的输入）
 * @param {EncodingHints} [hints]
 * @returns {{ ok: boolean, id?: number, error?: string }}
 */
export function writeMemoryWithEncoding(memoryService, record, hints = {}) {
  if (!memoryService) {
    return { ok: false, error: 'memoryService required' };
  }
  if (!record || !record.content) {
    return { ok: false, error: 'record.content required' };
  }

  // 时间字段——从 hints / 当前时钟二选一
  const now = new Date();
  const inferredTimeBucket = getTimeBucket(now);
  const inferredDayOfWeek = getDayOfWeek(now);

  // 复合 record：caller 显式提供的字段优先，hints 兜底
  const enriched = {
    ...record,
    mood_at_creation: record.mood_at_creation ?? record.moodAtCreation ?? hints.mood ?? null,
    time_bucket: record.time_bucket ?? record.timeBucket ?? hints.time_bucket ?? inferredTimeBucket,
    day_of_week: record.day_of_week ?? record.dayOfWeek ?? hints.day_of_week ?? inferredDayOfWeek,
    weather_at_creation: record.weather_at_creation ?? record.weatherAtCreation ?? hints.weather ?? null,
    session_id: record.session_id ?? record.sessionId ?? hints.session_id ?? null,
  };

  return memoryService.addMemory(enriched);
}
