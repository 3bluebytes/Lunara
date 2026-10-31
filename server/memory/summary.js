// summary.js — v2: 分层叙事 summary 生成（memory-system-v2 change）
//
// 规则版（不烧 LLM）。从 EPISODIC 记录里聚合统计 → 写入 SEMANTIC + tag `summary:daily:YYYY-MM-DD`。
// 跟 reflection 的关系：
//   - reflection = LLM 写的主观判断（"用户偏好 X"）
//   - summary    = 规则统计的客观事实（"今天放了 N 首，top mood=calm"）
// 两条信道职责分离，角色上下文按需读取。

import { MemoryType, MemorySource, createMemoryRecord, parseTags } from './types.js';
import { writeMemoryWithEncoding } from './writeMemoryWithEncoding.js';
import { trace } from '../trace.js';

const SUMMARY_CONFIDENCE_CAP = 0.6;
const SUMMARY_IMPORTANCE = 5;

/**
 * 把日期字符串转成当日 epoch ms 范围。
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {{ from: number, to: number }}
 */
function dayRange(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const to = from + 24 * 60 * 60 * 1000;
  return { from, to };
}

/**
 * 生成伙伴一天的 daily summary（规则版，不调 LLM）。
 *
 * 内容包含：
 *   - 总互动数
 *   - top mood（按 mood_at_creation 计数）
 *   - top time-bucket
 *   - top 标签
 *
 * @param {object} opts
 * @param {object} opts.memoryService - RadioHost memory service
 * @param {string} opts.date - YYYY-MM-DD
 * @returns {Promise<{ok:true, id:number}|null>}
 */
export async function generateDailySummary({ memoryService, date }) {
  if (!memoryService || !date) return null;
  const namespace = memoryService.namespace;
  const { from, to } = dayRange(date);

  // 拉当日 EPISODIC（含 interaction / episode tag 等）
  const rows = memoryService.searchMemory(undefined, {
    namespace,
    type: MemoryType.EPISODIC,
    limit: 500,
  });
  const todays = rows.filter(r => r.createdAt >= from && r.createdAt < to);

  if (todays.length < 1) {
    trace(`[summary] ${namespace} ${date}: only ${todays.length} events, skipping`);
    return null;
  }

  // 统计：mood 计数
  const moodCount = new Map();
  const bucketCount = new Map();
  const tagCount = new Map();
  for (const r of todays) {
    if (r.mood_at_creation) moodCount.set(r.mood_at_creation, (moodCount.get(r.mood_at_creation) || 0) + 1);
    if (r.time_bucket) bucketCount.set(r.time_bucket, (bucketCount.get(r.time_bucket) || 0) + 1);
    for (const t of parseTags(r.tags)) {
      tagCount.set(t, (tagCount.get(t) || 0) + 1);
    }
  }

  const topMood = pickTop(moodCount);
  const topBucket = pickTop(bucketCount);
  const topTags = sortMap(tagCount).slice(0, 3).map(([t, c]) => `${t}(${c})`);

  // 构造 content（formulaic，跨运行决定性一致）
  const content = composeContent({ date, eventCount: todays.length, topMood, topBucket, topTags });

  // 写入 SEMANTIC + tag summary:daily:YYYY-MM-DD
  const allTags = [`summary:daily:${date}`, 'summary'].concat(topMood ? [`mood:${topMood}`] : []);
  const r = writeMemoryWithEncoding(memoryService, {
    namespace,
    type: MemoryType.SEMANTIC,
    content,
    summary: `${date} 日报: ${todays.length} 次互动`,
    tags: allTags.join(','),
    source: MemorySource.CONSOLIDATION,
    importance: SUMMARY_IMPORTANCE,
    confidence: SUMMARY_CONFIDENCE_CAP,
    evidence: JSON.stringify({
      date,
      eventCount: todays.length,
      moodCounts: Object.fromEntries(moodCount),
      bucketCounts: Object.fromEntries(bucketCount),
      topTags,
    }),
  });
  if (!r.ok) {
    console.warn(`[summary] persist failed: ${r.error}`);
    return null;
  }
  trace(`[summary] ${namespace} ${date}: written id=${r.id} events=${todays.length} mood=${topMood || 'none'}`);
  return r;
}

function pickTop(map) {
  let best = null, bestCount = -1;
  for (const [k, v] of map.entries()) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  return best;
}

function sortMap(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function composeContent({ date, eventCount, topMood, topBucket, topTags }) {
  const parts = [`${date} 总览: ${eventCount} 次记忆事件`];
  if (topMood) parts.push(`主调心情=${topMood}`);
  if (topBucket) parts.push(`主要时段=${topBucket}`);
  if (topTags && topTags.length > 0) parts.push(`高频标签 [${topTags.join(', ')}]`);
  return parts.join('；') + '。';
}

/**
 * 生成 weekly summary：聚合最近 7 天的 daily summary（或没有 daily 时直接看 episodic）。
 *
 * @param {object} opts
 * @param {object} opts.memoryService
 * @param {string} [opts.isoWeek] - 'YYYY-Www' 格式；缺省=本周
 * @returns {Promise<{ok:true,id:number}|null>}
 */
export async function generateWeeklySummary({ memoryService, isoWeek }) {
  if (!memoryService) return null;
  const namespace = memoryService.namespace;
  const wk = isoWeek || _currentIsoWeek();
  const weekStart = _weekStartTs(wk);
  const weekEnd = weekStart + 7 * 24 * 60 * 60 * 1000;

  // 拉本周的 daily summaries
  const dailySummaries = memoryService.searchMemory(undefined, {
    namespace,
    type: MemoryType.SEMANTIC,
    tags: 'summary',
    limit: 50,
  }).filter(r => r.createdAt >= weekStart && r.createdAt < weekEnd
              && String(r.tags).includes('summary:daily:'));

  if (dailySummaries.length < 3) {
    trace(`[summary] weekly ${namespace} ${wk}: only ${dailySummaries.length} daily summaries, skipping`);
    return null;
  }

  // 聚合：把所有 daily 的 mood 计数加和
  const moodTotal = new Map();
  let totalEvents = 0;
  for (const ds of dailySummaries) {
    try {
      const ev = JSON.parse(ds.evidence || '{}');
      totalEvents += ev.eventCount || 0;
      for (const [m, c] of Object.entries(ev.moodCounts || {})) {
        moodTotal.set(m, (moodTotal.get(m) || 0) + c);
      }
    } catch { /* ignore parse */ }
  }
  const topMood = _pickTopMap(moodTotal);
  const content = `${wk} 周报: ${dailySummaries.length} 天，共 ${totalEvents} 次互动${topMood ? `，主调心情=${topMood}` : ''}。`;

  const r = writeMemoryWithEncoding(memoryService, {
    namespace,
    type: MemoryType.SEMANTIC,
    content,
    summary: `${wk} 周报`,
    tags: `summary:weekly:${wk},summary${topMood ? `,mood:${topMood}` : ''}`,
    source: MemorySource.CONSOLIDATION,
    importance: SUMMARY_IMPORTANCE + 1,  // weekly 比 daily 重要一点
    confidence: SUMMARY_CONFIDENCE_CAP,
    evidence: JSON.stringify({
      isoWeek: wk,
      dailyIds: dailySummaries.map(d => d.id),
      totalEvents,
      moodTotal: Object.fromEntries(moodTotal),
    }),
  });
  if (!r.ok) {
    console.warn(`[summary] weekly persist failed: ${r.error}`);
    return null;
  }
  trace(`[summary] weekly ${namespace} ${wk} written id=${r.id} dailies=${dailySummaries.length}`);
  return r;
}

function _pickTopMap(map) {
  let best = null, bc = -1;
  for (const [k, v] of map.entries()) { if (v > bc) { best = k; bc = v; } }
  return best;
}

function _currentIsoWeek(date = new Date()) {
  // ISO week 计算（参考 stackoverflow ISO 8601 算法）
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function _weekStartTs(isoWeek) {
  // 把 'YYYY-Www' 转回该周一的 epoch ms
  const [yStr, wStr] = isoWeek.split('-W');
  const y = parseInt(yStr, 10);
  const w = parseInt(wStr, 10);
  // ISO 周 1 = 含该年第一个周四的那一周
  const jan4 = new Date(y, 0, 4);
  const jan4Day = jan4.getDay() || 7;  // Sunday=7 in ISO
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - jan4Day + 1);
  const target = new Date(week1Monday);
  target.setDate(week1Monday.getDate() + (w - 1) * 7);
  target.setHours(0, 0, 0, 0);
  return target.getTime();
}
