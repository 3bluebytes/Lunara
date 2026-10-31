// presenceEligibility.js — 确定性资格判定：不调模型，任一门不过就沉默。
//
// 顺序即优先级：全局开关 → 模式上限 → 音频占用 → 用户在场 → 生成中/降档 → 静默时段 → 人声最小间隔
// → 在场性格开放的时刻 → 窗口/整场预算 → 时刻级证据与上限。原因码是封闭枚举，只进 trace，不给用户看。
import { AUTOMATIC_NARRATION_MIN_INTERVAL_MS } from '../playback/companionModes.js';
import { resolvePresencePolicy } from './presenceTemperament.js';

export const PRESENCE_REASONS = Object.freeze(['eligible', 'no-evidence', 'moment-cap', 'presence-disabled', 'mode-silent',
  'user-active', 'quiet-hours', 'too-soon', 'budget-exhausted', 'unknown-moment',
  'in-flight', 'degraded', 'paused-today', 'temperament-closed']);

// 降档：0 = sparse；1 = 只在开场/放完时开口；2 = 今天不再主动开口。
export const PRESENCE_LEVELS = Object.freeze(['sparse', 'reduced', 'paused-today']);
const REDUCED_MOMENTS = new Set(['session_open', 'queue_exhausted']);

// 窗口/整场预算的缺省值（balanced）；实际值来自说话角色的在场性格。
export const PRESENCE_LIMITS = Object.freeze({
  windowMs: 15 * 60_000, perWindow: 2, perSession: 8,
  quietStartMinutes: 23 * 60 + 30, quietEndMinutes: 8 * 60,
});

// 每种时刻：结构性证据 + 「两次开口之间至少隔多少次同类事实」（null = 每场一次）。
// 「有没有话可说」不在这里：PresenceRuntime 按接地素材做钩子判定，没有钩子不调模型。
const MOMENTS = Object.freeze({
  session_open: { evidence: () => true, every: null },
  queue_exhausted: { evidence: () => true, every: null },
  track_completed: { evidence: () => true, every: 5 },
  track_skipped: { evidence: e => Number(e.consecutiveSkips) >= 2, every: 2 },
  boundary_without_intro: { evidence: () => true, every: 3 },
});

function localMinutes(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs));
  const value = type => Number(parts.find(part => part.type === type)?.value || 0);
  return value('hour') * 60 + value('minute');
}

export function inQuietHours(nowMs, timeZone, { quietStartMinutes: start, quietEndMinutes: end } = PRESENCE_LIMITS) {
  const minutes = localMinutes(nowMs, timeZone);
  return start > end ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

const silence = reason => ({ decision: 'silence', reason });

/**
 * decidePresence(moment, entry, ctx) → { decision: 'speak'|'silence', reason }
 * ctx: { nowMs, enabled, modeId, timeZone, userActive, inFlight, pacingLevel, policy? }
 * policy 来自 resolvePresencePolicy（说话角色的在场性格 + 模式上限）；未给时按模式取 balanced；null = 不主动开口。
 */
export function decidePresence(moment, entry, ctx) {
  const rule = MOMENTS[moment?.kind];
  if (!rule) return silence('unknown-moment');
  if (ctx.enabled === false) return silence('presence-disabled');
  const policy = ctx.policy !== undefined ? ctx.policy : resolvePresencePolicy({ modeId: ctx.modeId ?? null });
  if (ctx.modeId === 'music_only' || !policy) return silence('mode-silent');
  if (ctx.userActive) return silence('user-active');
  if (ctx.inFlight) return silence('in-flight');
  if (Number(ctx.pacingLevel) >= 2) return silence('paused-today');
  if (Number(ctx.pacingLevel) === 1 && !REDUCED_MOMENTS.has(moment.kind)) return silence('degraded');
  if (inQuietHours(ctx.nowMs, ctx.timeZone)) return silence('quiet-hours');
  if (entry.lastVoiceAtMs != null && ctx.nowMs - entry.lastVoiceAtMs < AUTOMATIC_NARRATION_MIN_INTERVAL_MS) return silence('too-soon');
  if (policy.moments && !policy.moments.has(moment.kind)) return silence('temperament-closed');
  const log = entry.presenceLog || [];
  if (log.length >= policy.perSession
    || log.filter(at => ctx.nowMs - at < PRESENCE_LIMITS.windowMs).length >= policy.perWindow) return silence('budget-exhausted');
  if (!rule.evidence(moment.evidence || {})) return silence('no-evidence');
  const counter = entry.momentCounters?.[moment.kind];
  const every = policy.every?.[moment.kind] ?? rule.every;
  if (counter?.spoken > 0 && (every == null || (counter.sinceSpoken ?? 0) < every)) return silence('moment-cap');
  return { decision: 'speak', reason: 'eligible' };
}
