// CompanionHeartbeat.js — 一起听歌时叫醒「她」的调度器（add-companion-heartbeat D1）。
//
// 只决定「什么时候叫醒她」：不调模型、不写账本、不碰播放。唤醒之后由 onWake
// （VirtualPersonRuntime.handleAmbientTurn）跑一轮带完整上下文的 ambient turn，她自己决定说不说。
//
// 输入：权威播放快照、在线客户端数、开关、用户回合活动、人声账本（observer 的 entry）、
//      LLM 预算；observer 转来的已接受时刻（noteMoment）。
// 不做降档：一起听歌时你没接话很正常，克制靠 15 分钟开口窗口、每小时/每日上限、120 秒人声间隔、
// 她自己选择安静与开关；也没有「一整场最多几句」的上限（2026-10-19 实机 trace 修订）。
// 输出：至多一个待触发唤醒（只给当前听歌来源）；到点过硬门控后调用 onWake；
//      封闭原因码只进 trace，状态面只给产品事实。
//
// 三个来源合成一个唤醒时间：
//   1. 心跳：性格间隔 × 接收信号节奏系数（0.75–2.0，receptionSignals.js）× 抖动（0.8–1.2），从「上弦、上次唤醒、用户最近回合」中最晚的那个算起；
//      串词不算锚点（否则逐首串词的会话永远等不到心跳），只参与 120 秒人声间隔；
//   2. 事件提前：开场、听完、连跳 ≥2、放完，只往前拉，不早于事件后 30 秒、不早于上次唤醒 + minSpacing；
//   3. 她自己约的 followup（阶段 B，followupsFor 只读注入）：inMinutes 到点；afterCurrentTrack 在绑定的
//      那个 occurrence 放完/被跳过/放到底时；nextListening 在这个聊天下一次 session_open 时。
//      followup 是她自己的意图：不受模式的时刻白名单和「连跳 ≥2」限制，但同样受 minSpacing 与全部硬门控约束。
//      上弦之前就已经到点的（重启、被别人占了一拍）不单独补触发，下次唤醒时作为到期心里话出现。
//      唤醒载荷带 followups=[{noteId, personId, about}]；群聊里约了事的人优先被问到。
//
// 短暂断线（最后一个客户端断开后 60 秒内同一来源重连）不算重新上弦：沿用原锚点与抖动，
// 断线期间已经到点的，最早在重连后 30 秒触发。断开更久、暂停或换来源仍从头算。
//
// 群聊（D9）：注入的 voiceOf(snapshot) 决定这一拍谁出声、谁文字跟（groupVoice.js），一拍开始时解析；
// 节奏取出声者的性格。一拍只算一次唤醒；状态面里拍数与句数分开计。
//
// Python 伪代码：
//   def refresh():
//       if reason := blocker(): disarm(reason); return          # 撤弦不补
//       pending = pending or resume_after_reconnect() or Wake(armed_at=now(), jitter=uniform(0.8, 1.2))
//       due = min(anchor() + interval * jitter, pending.nudge_at)
//       if pending.retry_at: due = pending.retry_at
//       set_timer(due, on_due)
//   def on_due():
//       if gate := hard_gate(): retry(gate) if gate in RETRY else skip(gate); return
//       result = await on_wake(wake)                              # 模型调用只在这里
//       account(result); refresh()
import { AUTOMATIC_NARRATION_MIN_INTERVAL_MS } from '../playback/companionModes.js';
import { inQuietHours, PRESENCE_LIMITS } from './presenceEligibility.js';
import { speakerOf } from './presenceState.js';
import { resolvePresencePolicy } from './presenceTemperament.js';

export const HEARTBEAT_REASONS = Object.freeze(['disabled', 'not-listening', 'no-client', 'mode-silent',
  'quiet-hours', 'user-active', 'turn-busy', 'transition-busy', 'too-soon', 'hourly-cap',
  'daily-cap', 'budget-exhausted', 'llm-budget', 'quiet', 'stale', 'interrupted', 'listener-asked-quiet',
  'timeout', 'rejected', 'error']);

export const HEARTBEAT_LIMITS = Object.freeze({
  dailyCap: 48, nudgeFloorMs: 30_000, retryMs: 60_000, maxRetries: 3, userActiveMs: 8_000, reconnectGraceMs: 60_000,
});

// 一起听歌中：曲间加载、串词等待与串词播放都还算在听，不重置心跳。
const LISTENING_PHASES = new Set(['playing', 'loading', 'awaiting_intro', 'speaking']);
const TRANSITION_PHASES = new Set(['loading', 'awaiting_intro', 'speaking']);
const NUDGE_KINDS = new Set(['session_open', 'track_completed', 'track_skipped', 'queue_exhausted']);
const ABORTING_BLOCKERS = new Set(['disabled', 'mode-silent', 'listener-asked-quiet']);
// 接收信号的节奏系数只能在这个范围里乘心跳间隔（receptionSignals.js 已经夹过，这里再守一次）。
const CADENCE_RANGE = Object.freeze({ min: 0.75, max: 2.0 });
const MAX_SESSIONS = 32;
const HOUR_MS = 60 * 60_000;

const localDay = (nowMs, timeZone) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs)); }
  catch { return new Date(nowMs).toISOString().slice(0, 10); }
};
const latest = (...values) => Math.max(...values.filter(value => Number.isFinite(value)));

export class CompanionHeartbeat {
  constructor({ now = () => Date.now(), random = Math.random, setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    trace = null, isEnabled = () => true, getSnapshot, clientCount = () => 0,
    getActivity = () => ({ busy: false, lastUserTurnAtMs: null }), getVoiceEntry = () => null,
    pacing = {}, temperamentFor = () => 'balanced', llmBudgetExhausted = () => false, onWake,
    voiceOf = null, followupsFor = () => [], cadenceFactor = () => 1, listenerQuiet = () => false,
    limits = {}, logger = console } = {}) {
    if (typeof getSnapshot !== 'function') throw new TypeError('CompanionHeartbeat requires getSnapshot');
    if (typeof onWake !== 'function') throw new TypeError('CompanionHeartbeat requires onWake');
    Object.assign(this, { now, random, setTimer, clearTimer, timeZone, trace, isEnabled, getSnapshot, clientCount,
      getActivity, getVoiceEntry, pacing, temperamentFor, llmBudgetExhausted, onWake, voiceOf, followupsFor,
      cadenceFactor, listenerQuiet, logger });
    this.limits = { ...HEARTBEAT_LIMITS, ...limits };
    this.wake = null;
    this.inFlight = null;
    this.lastWakeAt = new Map();
    this.userTurnAt = new Map();
    this.sinceLastWake = new Map();
    this.exhaustedAllowed = null;
    this.wakeLog = [];
    this.budgetOffDay = null;
    // 因为没有客户端而撤下的唤醒：短时间内重连就沿用它的锚点。
    this.dropped = null;
    this.day = { id: localDay(now(), timeZone), wakes: 0, spoken: 0, quiet: 0, lines: 0 };
    this.lastResult = null;
  }

  /** 当前不能上弦的原因（封闭原因码），可以上弦时为 null。 */
  blocker(snapshot = this._snapshot()) {
    if (!this._safe(() => this.isEnabled(), false)) return 'disabled';
    const sessionId = snapshot?.activeListeningSessionId;
    if (!sessionId) return 'not-listening';
    // 你说过「安静点」：只管这一次一起听（换来源/下次一起听由接收信号自己清掉）。
    if (this._safe(() => this.listenerQuiet(sessionId), false)) return 'listener-asked-quiet';
    if (!(Number(this._safe(() => this.clientCount(), 0)) > 0)) return 'no-client';
    if (!this._policy(snapshot)) return 'mode-silent';
    if (this.budgetOffDay === this._today().id) return 'llm-budget';
    if (LISTENING_PHASES.has(snapshot.phase)) return null;
    if (snapshot.phase === 'exhausted' && this.exhaustedAllowed === sessionId) return null;
    return 'not-listening';
  }

  /** 任何可能改变上弦条件的事之后调用：播放迁移、客户端连上/断开、开关、模式。 */
  refresh({ armedAtMs = null } = {}) {
    const snapshot = this._snapshot();
    const blocker = this.blocker(snapshot);
    if (blocker) {
      if (ABORTING_BLOCKERS.has(blocker)) this.inFlight?.controller.abort();
      this._disarm(blocker);
      // 断线期间又暂停、关开关或换了模式：重连时从头算。
      if (blocker !== 'no-client') this.dropped = null;
      return;
    }
    if (this.inFlight) return;
    const sessionId = snapshot.activeListeningSessionId;
    if (this.wake && this.wake.sessionId !== sessionId) this._disarm('not-listening');
    if (!this.wake) {
      const resumed = armedAtMs == null ? this._resumable(sessionId) : null;
      this.wake = { sessionId, armedAtMs: resumed?.armedAtMs ?? armedAtMs ?? this.now(),
        jitter: resumed?.jitter ?? 0.8 + 0.4 * this._random(), notBeforeMs: resumed ? this.now() + this.limits.nudgeFloorMs : null,
        nudge: null, retry: null, retries: 0, dueAtMs: null, reason: null, personId: null, followupNoteIds: [], timer: null };
    }
    this.dropped = null;
    this._schedule(snapshot);
  }

  /** observer 接受的时刻：累计「上次唤醒以来」的事实；合格的只把唤醒往前拉。 */
  noteMoment(moment) {
    const sessionId = moment?.sessionId;
    if (!sessionId) return;
    const counts = this.sinceLastWake.get(sessionId) || { completed: 0, skipped: 0 };
    if (moment.kind === 'track_completed') counts.completed += 1;
    if (moment.kind === 'track_skipped') counts.skipped += 1;
    this._remember(this.sinceLastWake, sessionId, counts);
    if (moment.kind === 'queue_exhausted') this.exhaustedAllowed = sessionId;
    const followupNoteIds = this._followupsForMoment(moment);
    // 开场等时刻本身的原因保留（她仍需要知道「一起听刚开始」），只附上到期的 followup。
    if (followupNoteIds.length) {
      return this._nudge(sessionId, { reason: NUDGE_KINDS.has(moment.kind) ? moment.kind : 'followup', followupNoteIds });
    }
    if (!NUDGE_KINDS.has(moment.kind)) return;
    if (moment.kind === 'track_skipped' && !(Number(moment.evidence?.consecutiveSkips) >= 2)) return;
    this._nudge(sessionId, { reason: moment.kind, momentKind: moment.kind });
  }

  /** 把唤醒往前拉到「事件后 30 秒且不早于上次唤醒 + minSpacing」；只往前，不往后。 */
  _nudge(sessionId, { reason, momentKind = null, followupNoteIds = [] }) {
    this.refresh();
    const wake = this.wake;
    if (!wake || wake.sessionId !== sessionId) return;
    const snapshot = this._snapshot();
    const policy = this._policy(snapshot);
    if (momentKind && policy.moments && !policy.moments.has(momentKind)) return;
    const atMs = latest(this.now() + this.limits.nudgeFloorMs,
      (this.lastWakeAt.get(sessionId) ?? Number.NaN) + policy.minSpacingMs);
    if (atMs >= wake.dueAtMs || (wake.nudge && wake.nudge.atMs <= atMs)) return;
    wake.nudge = { atMs, reason, followupNoteIds };
    this._schedule(snapshot);
  }

  /** 这个时刻结束了哪些 followup 等的条件（绑定的 occurrence 放完/被跳过/放到底；或下次一起听开场）。 */
  _followupsForMoment(moment) {
    const queueItemId = moment.evidence?.track?.queueItemId;
    const ended = ['track_completed', 'track_skipped', 'queue_exhausted'].includes(moment.kind) && queueItemId;
    return this._followups(moment.sessionId).filter(item => (ended && item.condition === `afterCurrentTrack:${queueItemId}`)
      || (moment.kind === 'session_open' && item.condition === 'nextListening')).map(item => item.noteId);
  }

  _followups(sessionId) {
    const list = this._safe(() => this.followupsFor(sessionId), []);
    return (Array.isArray(list) ? list : []).filter(item => item?.noteId);
  }

  /** 用户开口：心跳从这一刻重新算，之前的事件提前与改期作废。 */
  noteUserTurn(sessionId) {
    if (!sessionId) return;
    this._remember(this.userTurnAt, sessionId, this.now());
    if (this.wake?.sessionId === sessionId) Object.assign(this.wake, { nudge: null, retry: null, retries: 0, followupNoteIds: [] });
    this.refresh();
  }

  pending() {
    const wake = this.wake;
    return wake ? { sessionId: wake.sessionId, personId: wake.personId, dueAtMs: wake.dueAtMs, reason: wake.reason } : null;
  }

  /**
   * 只给产品事实：开关、今天叫醒的拍数、开口/安静的拍数、可见的句数、最近一次结果类别。不含原因码。
   * 群聊一拍里出声者与跟话的人最多说 2 句：拍数按次、句数按句。
   */
  status() {
    const day = this._today();
    return { enabled: this._safe(() => this.isEnabled(), false),
      today: { wakes: day.wakes, spoken: day.spoken, quiet: day.quiet, lines: day.lines }, lastResult: this.lastResult };
  }

  async settled() {
    await this.inFlight?.promise;
  }

  stop() {
    if (this.wake?.timer != null) this.clearTimer(this.wake.timer);
    this.wake = null;
    this.inFlight?.controller.abort();
  }

  _schedule(snapshot) {
    const wake = this.wake;
    const policy = this._policy(snapshot);
    // 只有心跳间隔乘接收信号的节奏系数；事件提前、followup 与全部门控都不看它。
    const interval = policy.heartbeatMs * this._cadence(wake.sessionId);
    const activity = this._activity(wake.sessionId);
    const anchor = latest(wake.armedAtMs, this.lastWakeAt.get(wake.sessionId), this.userTurnAt.get(wake.sessionId),
      activity.lastUserTurnAtMs);
    // 重连沿用的锚点可能已经过了：最早在重连后 30 秒，不补发断线期间的。
    let dueAtMs = Math.max(Math.round(anchor + interval * wake.jitter), wake.notBeforeMs ?? -Infinity);
    let reason = 'heartbeat';
    let followupNoteIds = [];
    const timed = this._timedFollowups(wake, policy);
    if (timed && timed.atMs < dueAtMs) ({ atMs: dueAtMs, reason, followupNoteIds } = timed);
    if (wake.nudge && wake.nudge.atMs < dueAtMs) {
      ({ atMs: dueAtMs, reason } = wake.nudge);
      followupNoteIds = wake.nudge.followupNoteIds || [];
    }
    if (wake.retry) ({ atMs: dueAtMs, reason, followupNoteIds } = wake.retry);
    wake.followupNoteIds = followupNoteIds;
    wake.personId = this._voice(snapshot).holderId;
    if (wake.dueAtMs === dueAtMs && wake.reason === reason && wake.timer != null) return;
    if (wake.timer != null) this.clearTimer(wake.timer);
    Object.assign(wake, { dueAtMs, reason });
    wake.timer = this.setTimer(() => this._due(), Math.max(0, dueAtMs - this.now()));
    this._trace(wake.sessionId, { type: 'ambient_wake_scheduled', source: reason, inMs: Math.max(0, dueAtMs - this.now()) });
  }

  /** 约了时间、在这次上弦之后才到点的 followup：最早的那个时刻（同一时刻的一起叫醒）。 */
  _timedFollowups(wake, policy) {
    const floor = latest(wake.armedAtMs, (this.lastWakeAt.get(wake.sessionId) ?? Number.NaN) + policy.minSpacingMs,
      wake.notBeforeMs ?? Number.NaN);
    const timed = this._followups(wake.sessionId)
      .filter(item => Number.isFinite(item.dueAtMs) && item.dueAtMs >= wake.armedAtMs);
    if (!timed.length) return null;
    const first = Math.min(...timed.map(item => item.dueAtMs));
    return { atMs: Math.max(first, floor), reason: 'followup',
      followupNoteIds: timed.filter(item => item.dueAtMs === first).map(item => item.noteId) };
  }

  _due() {
    const wake = this.wake;
    if (!wake) return;
    wake.timer = null;
    const snapshot = this._snapshot();
    const blocker = this.blocker(snapshot) || (snapshot.activeListeningSessionId !== wake.sessionId ? 'not-listening' : null);
    if (blocker) return this._disarm(blocker);
    const nowMs = this.now();
    const policy = this._policy(snapshot);
    if (inQuietHours(nowMs, this.timeZone)) return this._skip('quiet-hours');
    const voice = this._safe(() => this.getVoiceEntry(wake.sessionId), null) || {};
    if (voice.lastVoiceAtMs != null && nowMs - voice.lastVoiceAtMs < AUTOMATIC_NARRATION_MIN_INTERVAL_MS) {
      return this._retry('too-soon', voice.lastVoiceAtMs + AUTOMATIC_NARRATION_MIN_INTERVAL_MS, false);
    }
    const activity = this._activity(wake.sessionId);
    if (activity.busy) return this._retry('turn-busy', nowMs + this.limits.retryMs, true);
    if (activity.lastUserTurnAtMs != null && nowMs - activity.lastUserTurnAtMs < this.limits.userActiveMs) {
      return this._retry('user-active', nowMs + this.limits.retryMs, true);
    }
    if (TRANSITION_PHASES.has(snapshot.phase)) return this._retry('transition-busy', nowMs + this.limits.retryMs, true);
    this.wakeLog = this.wakeLog.filter(at => nowMs - at < HOUR_MS);
    if (this.wakeLog.length >= policy.perHour) return this._skip('hourly-cap');
    if (this._today().wakes >= this.limits.dailyCap) return this._skip('daily-cap');
    // 只看 15 分钟开口窗口；不设「一整场最多几句」（连续听久了不会整场沉默）。
    const log = Array.isArray(voice.presenceLog) ? voice.presenceLog : [];
    if (log.filter(at => nowMs - at < PRESENCE_LIMITS.windowMs).length >= policy.perWindow) return this._skip('budget-exhausted');
    if (this._safe(() => this.llmBudgetExhausted(), false)) {
      this.budgetOffDay = this._today().id;
      return this._skip('llm-budget');
    }
    return this._fire(wake, snapshot, policy);
  }

  _fire(wake, snapshot, policy) {
    const nowMs = this.now();
    const { sessionId } = wake;
    // 出声者与跟话顺序在一拍开始时定：设置里改了主持人，下一拍就按新的。
    const { holderId: personId, followerIds } = this._voice(snapshot);
    this.wake = null;
    const previousWakeAtMs = this.lastWakeAt.get(sessionId) ?? null;
    this._remember(this.lastWakeAt, sessionId, nowMs);
    this.wakeLog.push(nowMs);
    this._today().wakes += 1;
    const sinceLastWake = this.sinceLastWake.get(sessionId) || { completed: 0, skipped: 0 };
    this.sinceLastWake.set(sessionId, { completed: 0, skipped: 0 });
    if (wake.reason === 'queue_exhausted') this.exhaustedAllowed = null;
    // 叫醒时仍在等的那几条（期间被了结的就不带了）；成员不在这个聊天里的不带。
    const wanted = new Set(wake.followupNoteIds || []);
    const members = new Set([personId, ...followerIds]);
    const followups = this._followups(sessionId).filter(item => wanted.has(item.noteId) && members.has(item.personId))
      .map(item => Object.freeze({ noteId: item.noteId, personId: item.personId, about: String(item.about || '') }));
    const reason = wake.reason === 'followup' && !followups.length ? 'heartbeat' : wake.reason;
    const controller = new AbortController();
    const payload = Object.freeze({ id: `ambient:${sessionId}:${personId}:${nowMs}`, sessionId, personId,
      followerIds: Object.freeze([...followerIds]), reason, firedAtMs: nowMs, previousWakeAtMs, sinceLastWake: { ...sinceLastWake },
      followups: Object.freeze(followups), followupNoteIds: Object.freeze(followups.map(item => item.noteId)),
      modeRevision: snapshot.modeRevision ?? null, policy, signal: controller.signal });
    this._trace(sessionId, { type: 'ambient_wake_fired', source: reason, personId,
      ...(followups.length ? { followups: followups.length } : {}) });
    const promise = Promise.resolve()
      .then(() => this.onWake(payload))
      .catch(() => ({ outcome: 'silent', reason: 'error' }))
      .then(result => this._account(payload, result))
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = null;
        // 接着这次唤醒继续上弦：心跳从唤醒时刻算，不把生成耗时算进间隔。
        this.refresh({ armedAtMs: nowMs });
      });
    this.inFlight = { sessionId, controller, promise };
  }

  _account(wake, result) {
    const day = this._today();
    const outcome = result?.outcome;
    if (outcome === 'spoken' || outcome === 'text-only') {
      day.spoken += 1;
      day.lines += Math.max(1, Math.trunc(Number(result?.lines) || 1));
      this.lastResult = 'spoke';
      this._safe(() => this.pacing.afterSpoken?.(wake), null);
      this._trace(wake.sessionId, { type: 'ambient_result', outcome });
      return;
    }
    day.quiet += 1;
    this.lastResult = 'quiet';
    const reason = outcome === 'quiet' ? 'quiet'
      : (HEARTBEAT_REASONS.includes(result?.reason) ? result.reason : 'error');
    if (reason === 'llm-budget') this.budgetOffDay = day.id;
    this._trace(wake.sessionId, { type: 'ambient_result', outcome: outcome === 'quiet' ? 'quiet' : 'silent', reason });
  }

  /** 门控要求稍后再试：不消耗预算。用户在场/转场最多改期 maxRetries 次，再遇到就退回心跳。 */
  _retry(reason, atMs, counted) {
    const wake = this.wake;
    if (counted && ++wake.retries > this.limits.maxRetries) {
      this._trace(wake.sessionId, { type: 'ambient_wake_skipped', reason, source: wake.reason });
      Object.assign(wake, { nudge: null, retry: null, retries: 0, followupNoteIds: [], armedAtMs: this.now(),
        jitter: 0.8 + 0.4 * this._random() });
      if (wake.reason === 'queue_exhausted') this.exhaustedAllowed = null;
      return this.refresh();
    }
    wake.retry = { atMs, reason: wake.reason, followupNoteIds: wake.followupNoteIds || [] };
    this._trace(wake.sessionId, { type: 'ambient_wake_rescheduled', reason, source: wake.reason });
    return this._schedule(this._snapshot());
  }

  /** 门控要求放弃这次：不补，从此刻重新上弦。 */
  _skip(reason) {
    const wake = this.wake;
    this._trace(wake.sessionId, { type: 'ambient_wake_skipped', reason, source: wake.reason });
    if (wake.reason === 'queue_exhausted') this.exhaustedAllowed = null;
    this.wake = null;
    return this.refresh();
  }

  _disarm(reason) {
    const wake = this.wake;
    if (!wake) return;
    if (wake.timer != null) this.clearTimer(wake.timer);
    this.wake = null;
    this.dropped = reason === 'no-client'
      ? { sessionId: wake.sessionId, armedAtMs: wake.armedAtMs, jitter: wake.jitter, atMs: this.now() } : null;
    this._trace(wake.sessionId, { type: 'ambient_wake_disarmed', reason });
  }

  /** 最后一个客户端断开后短时间内同一来源重连：返回原来的锚点与抖动，否则 null。 */
  _resumable(sessionId) {
    const dropped = this.dropped;
    return dropped && dropped.sessionId === sessionId && this.now() - dropped.atMs <= this.limits.reconnectGraceMs
      ? dropped : null;
  }

  _snapshot() {
    return this._safe(() => this.getSnapshot(), null) || {};
  }

  /** 这一拍谁出声、谁文字跟（群聊见 groupVoice.js）；没有注入或解析失败时按单聊口径。 */
  _voice(snapshot) {
    const fallback = { holderId: speakerOf(snapshot), followerIds: [] };
    if (typeof this.voiceOf !== 'function') return fallback;
    const voice = this._safe(() => this.voiceOf(snapshot), null);
    if (!voice?.holderId) return fallback;
    return { holderId: voice.holderId,
      followerIds: (Array.isArray(voice.followerIds) ? voice.followerIds : []).filter(id => id && id !== voice.holderId) };
  }

  _policy(snapshot) {
    const temperament = this._safe(() => this.temperamentFor(this._voice(snapshot).holderId), 'balanced') || 'balanced';
    return resolvePresencePolicy({ modeId: snapshot?.companionModeId ?? null, temperament });
  }

  _cadence(sessionId) {
    const factor = Number(this._safe(() => this.cadenceFactor(sessionId), 1));
    return Number.isFinite(factor) ? Math.min(CADENCE_RANGE.max, Math.max(CADENCE_RANGE.min, factor)) : 1;
  }

  _activity(sessionId) {
    return this._safe(() => this.getActivity(sessionId), null) || {};
  }

  _today() {
    const id = localDay(this.now(), this.timeZone);
    if (this.day.id !== id) this.day = { id, wakes: 0, spoken: 0, quiet: 0, lines: 0 };
    return this.day;
  }

  _random() {
    const value = Number(this._safe(() => this.random(), 0.5));
    return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0.5;
  }

  _remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
  }

  _trace(sessionId, entry) {
    try { this.trace?.(sessionId, entry); } catch { /* trace 失败不影响调度 */ }
  }

  _safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }
}
