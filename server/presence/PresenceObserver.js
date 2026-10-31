// PresenceObserver.js — presence 的只读观察者与节奏账本。
//
// 调用顺序：PlaybackRuntimeHost 接受一次状态迁移 → subscribe 回调 (next, event, previous)
// → reducePresence 更新该听歌会话的有界状态并给出候选时刻 → decidePresence 确定性判定
// → 写 session trace（presence_decision）。判定为 speak 时：
//   - 没有 speaker（P0 / 测试）：只做影子记账（shadow=true）；
//   - 有 speaker（P1）：异步交给 PresenceRuntime 生成并交付，真的说出口才记账。
// 它从不 submit 事件、不写队列；任何异常都被吞在这里，播放迁移不受影响。
// 节奏来自说话角色的在场性格（temperamentFor → resolvePresencePolicy，模式给上限），随 speak 一起交给运行器。
// 降档：她连续 2 句没被回应降一档，再 2 句当天停；用户开口恢复一档（只是运行时节奏，不写记忆）。
// 心跳模式（add-companion-heartbeat，useHeartbeat）：时刻不再逐个判定，只转给 CompanionHeartbeat
// 当作「上次唤醒以来」的事实与提前唤醒的理由；每次迁移都刷新心跳的上弦条件。人声账本仍记在这里，
// 通过 heartbeatHooks 交给心跳。心跳模式不降档（一起听歌时没接话很正常），上面的降档只属于 P1。
// P1 的 speaker 与心跳不会同时存在。
//
// Python 伪代码：
//   def on_transition(next, event, previous):
//       entry, moments = reduce_presence(entries[sid], previous, event, next, now())
//       for m in moments:
//           if m.trigger_key in decided: continue          # 幂等：每个触发只决策一次
//           result = decide_presence(m, entry, ctx)
//           trace(sid, {type: 'presence_decision', ...result})
//           if result.decision == 'speak':
//               if speaker: spawn(speak_then_account(m))      # 真的开口才记账
//               else: entry = record_spoken(entry, m, now())  # 影子记账
import { createPresenceEntry, recordPresenceSpoken, reducePresence } from './presenceState.js';
import { decidePresence, PRESENCE_LEVELS, PRESENCE_LIMITS } from './presenceEligibility.js';
import { resolvePresencePolicy } from './presenceTemperament.js';

const USER_ACTIVE_MS = 8_000;
const MAX_SESSIONS = 32;
const MAX_DECIDED = 256;
const PERSISTED_FIELDS = ['sessionStartedAtMs', 'lastActivityAtMs', 'lastActivationCorrelationId', 'lastVoiceAtMs',
  'presenceLog', 'momentCounters'];
const IGNORED_PER_LEVEL = 2;
const localDay = (nowMs, timeZone) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs)); }
  catch { return new Date(nowMs).toISOString().slice(0, 10); }
};
const freshPacing = day => ({ day, level: 0, ignoredStreak: 0, awaitingReply: false, spoken: 0, ignored: 0 });
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export class PresenceObserver {
  constructor({ now = () => Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, trace = null,
    persistence = null, getActivity = () => ({ busy: false, lastUserTurnAtMs: null }), enabled = true,
    speaker = null, temperamentFor = () => 'balanced', logger = console } = {}) {
    Object.assign(this, { now, timeZone, trace, persistence, getActivity, enabled, speaker, temperamentFor, logger });
    this.entries = new Map();
    this.decided = new Set();
    this.inFlight = new Map();
    this.lastResult = null;
    this.pacingState = freshPacing(localDay(now(), timeZone));
    this.runtime = null;
    this.heartbeat = null;
    this.momentListeners = new Set();
    this._restore();
  }

  /** 切到心跳模式；返回心跳需要的人声账本与节奏钩子。 */
  useHeartbeat(heartbeat) {
    if (this.speaker) throw new TypeError('PresenceObserver: a P1 speaker and the heartbeat cannot run together');
    this.heartbeat = heartbeat;
    return this.heartbeatHooks();
  }

  /** 心跳模式下每个已接受时刻的旁听者（接收信号用）；返回取消订阅。监听失败不影响心跳。 */
  onMoment(listener) {
    this.momentListeners.add(listener);
    return () => this.momentListeners.delete(listener);
  }

  heartbeatHooks() {
    return {
      getVoiceEntry: sessionId => this.entry(sessionId),
      pacing: {
        // ambient turn 真的交付了一句：记进她的人声账本（120 秒间隔与 15 分钟窗口按它算）。不等回应、不记被晾。
        afterSpoken: wake => {
          if (!wake?.sessionId) return;
          this.entries.set(wake.sessionId, recordPresenceSpoken(this.entry(wake.sessionId), { kind: 'ambient' }, this.now()));
          this._persist();
        },
      },
    };
  }

  attach(runtime) {
    if (!this.enabled) return () => {};
    this.runtime = runtime;
    return runtime.subscribe((next, event, previous) => {
      try { this.observe(next, event, previous); }
      catch { this.logger?.warn?.('[presence] observation failed'); }
      // 开始/停止听歌、暂停、换来源都可能改变上弦条件（observe 在「之前没在听」时提前返回，所以放在这里）。
      try { this.heartbeat?.refresh(); }
      catch { this.logger?.warn?.('[presence] heartbeat refresh failed'); }
    });
  }

  entry(sessionId) {
    return this.entries.get(sessionId) || createPresenceEntry({ sessionId });
  }

  observe(next, event, previous) {
    const sessionId = previous?.activeListeningSessionId;
    if (!sessionId || !event) return;
    const nowMs = this.now();
    const result = reducePresence(this.entry(sessionId), { previous, event, next, nowMs });
    let entry = result.entry;
    for (const moment of result.moments) {
      if (this.decided.has(moment.triggerKey)) continue;
      this._markDecided(moment.triggerKey);
      if (this.heartbeat) {
        this.trace?.(sessionId, { type: 'presence_moment', momentKind: moment.kind, triggerKey: moment.triggerKey,
          personId: moment.personId });
        try { this.heartbeat.noteMoment(moment); }
        catch { this.logger?.warn?.('[presence] heartbeat moment failed'); }
        for (const listener of this.momentListeners) {
          try { listener(moment); } catch { this.logger?.warn?.('[presence] moment listener failed'); }
        }
        continue;
      }
      const activity = this.getActivity(sessionId) || {};
      let temperament = 'balanced';
      try { temperament = this.temperamentFor(moment.personId) || 'balanced'; } catch { temperament = 'balanced'; }
      const policy = resolvePresencePolicy({ modeId: next.companionModeId ?? null, temperament });
      const ctx = {
        nowMs, enabled: this.enabled, modeId: next.companionModeId ?? null, timeZone: this.timeZone, policy,
        inFlight: this.inFlight.has(sessionId),
        userActive: Boolean(activity.busy) || (activity.lastUserTurnAtMs != null
          && nowMs - activity.lastUserTurnAtMs < USER_ACTIVE_MS),
      };
      let outcome = decidePresence(moment, entry, { ...ctx, pacingLevel: this.pacing().level });
      // 上一句还没被回应，她又要开口：上一句算被忽略。累计够了就降档并按新档位重判。
      if (outcome.decision === 'speak' && this.speaker && this._registerIgnored()) {
        outcome = decidePresence(moment, entry, { ...ctx, pacingLevel: this.pacing().level });
      }
      const shadow = !this.speaker;
      // 只落结构化事实：时刻种类、触发键、判定与原因码、证据标志；不落歌名或聊天原文。
      this.trace?.(sessionId, { type: 'presence_decision', ...(shadow ? { shadow: true } : {}), momentKind: moment.kind,
        triggerKey: moment.triggerKey, personId: moment.personId, decision: outcome.decision, reason: outcome.reason,
        evidence: evidenceFlags(moment.evidence) });
      if (outcome.decision !== 'speak') continue;
      if (shadow) entry = recordPresenceSpoken(entry, moment, nowMs);
      else this._speak(moment, next, policy);
    }
    this.entries.set(sessionId, entry);
    if (this.entries.size > MAX_SESSIONS) this.entries.delete(this.entries.keys().next().value);
    if (result.moments.length || entry.sessionStartedAtMs !== result.entry.sessionStartedAtMs
      || event.type === 'TRACK_STARTED') this._persist();
  }

  /**
   * 只返回产品事实：不暴露原因码、预算内部结构或调度字段。
   * 心跳模式不报告降档与「被晾」计数：心跳不降档，今天早先残留的 P1 档位也不生效。
   */
  status() {
    const quietHours = { start: clock(PRESENCE_LIMITS.quietStartMinutes), end: clock(PRESENCE_LIMITS.quietEndMinutes) };
    if (this.heartbeat) {
      return { enabled: this.enabled, phase: 'heartbeat', quietHours, lastResult: this.lastResult, ambient: this.heartbeat.status() };
    }
    const pacing = this.pacing();
    return { enabled: this.enabled, phase: this.speaker ? 'active' : 'observing', level: PRESENCE_LEVELS[pacing.level] || 'sparse',
      quietHours, today: { spoken: pacing.spoken, ignored: pacing.ignored }, lastResult: this.lastResult };
  }

  /** 当天的节奏状态；跨过当地零点自动回到 sparse。 */
  pacing() {
    const day = localDay(this.now(), this.timeZone);
    if (this.pacingState.day !== day) this.pacingState = freshPacing(day);
    return this.pacingState;
  }

  /** 用户开口：作废正在准备的主动开口，上一句算被回应，降档恢复一档。 */
  noteUserTurn(sessionId) {
    this.speaker?.interrupt?.(sessionId);
    try { this.heartbeat?.noteUserTurn(sessionId); }
    catch { this.logger?.warn?.('[presence] heartbeat user turn failed'); }
    const pacing = this.pacing();
    const changed = pacing.awaitingReply || pacing.ignoredStreak || pacing.level;
    Object.assign(pacing, { awaitingReply: false, ignoredStreak: 0, level: Math.max(0, pacing.level - 1) });
    if (changed) this._persist();
  }

  /** @returns 是否因此降档 */
  _registerIgnored() {
    const pacing = this.pacing();
    if (!pacing.awaitingReply) return false;
    pacing.awaitingReply = false;
    pacing.ignored += 1;
    pacing.ignoredStreak += 1;
    if (pacing.ignoredStreak < IGNORED_PER_LEVEL) return false;
    pacing.ignoredStreak = 0;
    pacing.level = Math.min(PRESENCE_LEVELS.length - 1, pacing.level + 1);
    return true;
  }

  _speak(moment, decidedOn = null, policy = null) {
    const { sessionId } = moment;
    // 交付前重验：仍是这一场听歌、陪伴模式没被改过（改成 music_only 或换档都作废这句）。
    const modeRevision = decidedOn?.modeRevision ?? null;
    const isCurrent = () => {
      const snapshot = this.runtime?.snapshot?.();
      if (!snapshot) return true;
      return snapshot.activeListeningSessionId === sessionId && (snapshot.modeRevision ?? null) === modeRevision;
    };
    const task = Promise.resolve()
      .then(() => this.speaker.speak(moment, { isCurrent, policy }))
      .catch(() => ({ outcome: 'silent', reason: 'error' }))
      .then(result => {
        this.lastResult = result.outcome === 'silent' ? 'silent' : result.outcome;
        if (result.outcome === 'spoken' || result.outcome === 'text-only') {
          this.entries.set(sessionId, recordPresenceSpoken(this.entry(sessionId), moment, this.now()));
          const pacing = this.pacing();
          pacing.spoken += 1;
          pacing.awaitingReply = true;
        }
        this._persist();
        return result;
      })
      .finally(() => { if (this.inFlight.get(sessionId) === task) this.inFlight.delete(sessionId); });
    this.inFlight.set(sessionId, task);
    return task;
  }

  /** 测试与关停：等待所有进行中的主动开口结束。 */
  async settled() {
    await Promise.all([...this.inFlight.values()]);
  }

  _markDecided(key) {
    this.decided.add(key);
    if (this.decided.size > MAX_DECIDED) this.decided.delete(this.decided.values().next().value);
  }

  _restore() {
    let data = null;
    try { data = this.persistence?.load?.() || null; } catch { data = null; }
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
    if (!data || data.version !== 1) return;
    for (const [sessionId, saved] of Object.entries(data.sessions || {}).slice(-MAX_SESSIONS)) {
      const base = createPresenceEntry({ sessionId });
      const picked = Object.fromEntries(PERSISTED_FIELDS.filter(key => saved?.[key] !== undefined).map(key => [key, saved[key]]));
      this.entries.set(sessionId, Object.freeze({ ...base, ...picked,
        presenceLog: Array.isArray(picked.presenceLog) ? picked.presenceLog.slice(-16) : [],
        momentCounters: picked.momentCounters && typeof picked.momentCounters === 'object' ? picked.momentCounters : {} }));
    }
    for (const key of (data.decided || []).slice(-MAX_DECIDED)) this.decided.add(String(key));
    const saved = data.pacing;
    if (saved && saved.day === this.pacingState.day) {
      this.pacingState = { ...freshPacing(saved.day),
        level: Math.max(0, Math.min(PRESENCE_LEVELS.length - 1, Number(saved.level) || 0)),
        ignoredStreak: Math.max(0, Number(saved.ignoredStreak) || 0), awaitingReply: saved.awaitingReply === true,
        spoken: Math.max(0, Number(saved.spoken) || 0), ignored: Math.max(0, Number(saved.ignored) || 0) };
    }
  }

  _persist() {
    if (!this.persistence?.save) return;
    const sessions = Object.fromEntries([...this.entries].map(([id, entry]) =>
      [id, Object.fromEntries(PERSISTED_FIELDS.map(key => [key, entry[key] ?? null]))]));
    try { this.persistence.save({ version: 1, sessions, decided: [...this.decided], pacing: this.pacing() }); }
    catch { this.logger?.warn?.('[presence] persisting pacing state failed'); }
  }
}

function evidenceFlags(evidence = {}) {
  const flags = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) flags[key] = value;
  }
  if (evidence.track) flags.track = { provider: evidence.track.provider, songId: evidence.track.songId,
    queueItemId: evidence.track.queueItemId };
  return flags;
}
