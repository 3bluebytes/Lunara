// receptionSignals.js — 你对她主动开口的反应，换算成心跳节奏（add-companion-expression-and-reception D5）。
//
// 只收已经被接受的事实，不猜：
//   replied             她的 ambient 话入账后 5 分钟内你开口（每句只算一次）   −0.15（间隔变短）
//   skipped_after_line  她**出声**后 30 秒内你跳过当前歌（每句只算一次）       +0.15（间隔变长）
//   asked_more          普通回合里 set_presence_preference(more)，引用你的原话    −0.3
//   asked_quiet         同上 (quiet)：本次一起听撤弦，换来源或下次一起听恢复，可一键恢复
// 没接话、关语音、切换聊天、技术失败都不是信号（这里根本没有入口）。
//
// cadenceFactor = clamp(1 + Σ wᵢ·0.5^(Δtᵢ/2h), 0.75, 2.0)，只乘心跳间隔；事件提前、followup、
// 硬门控与上限由 CompanionHeartbeat 照旧负责。状态只在内存里：2 小时半衰期，重启丢了影响很小；
// 「安静点」本来就只管这一次一起听。
//
// Python 伪代码：
//   rs = ReceptionSignals(now)
//   rs.note_line(session, voiced=True)    # AmbientPresence 交付了一句
//   rs.note_user_turn(session)            # 5 分钟内 → replied
//   rs.note_skip(session)                 # 出声后 30 秒内 → skipped_after_line
//   rs.cadence_factor(session)            # 心跳间隔 × 它（按聊天算）
//   rs.ask_quiet(listening_session); rs.is_quiet(listening_session); rs.restore(listening_session)
const HOUR_MS = 60 * 60_000;

export const RECEPTION_WEIGHTS = Object.freeze({ replied: -0.15, skipped_after_line: 0.15, asked_more: -0.3 });

export const RECEPTION_LIMITS = Object.freeze({
  replyWindowMs: 5 * 60_000, skipWindowMs: 30_000, halfLifeMs: 2 * HOUR_MS,
  minFactor: 0.75, maxFactor: 2.0, maxSignals: 64, maxSessions: 32,
});

export const LISTENER_QUIET_REASON = 'listener-asked-quiet';

/** 纯函数：给定信号与时刻算节奏系数。 */
export function cadenceFactor(signals = [], nowMs, limits = RECEPTION_LIMITS) {
  let sum = 0;
  for (const signal of signals) {
    const ageMs = Math.max(0, nowMs - signal.atMs);
    sum += signal.weight * 0.5 ** (ageMs / limits.halfLifeMs);
  }
  const factor = 1 + sum;
  return Math.min(limits.maxFactor, Math.max(limits.minFactor, Number.isFinite(factor) ? factor : 1));
}

export function createReceptionSignals({ now = () => Date.now(), trace = null, onChange = () => {}, limits = {} } = {}) {
  const config = { ...RECEPTION_LIMITS, ...limits };
  const signals = [];
  const lastLine = new Map();
  let quiet = null;

  const emit = change => { try { onChange(change); } catch { /* 观察者失败不影响信号 */ } };
  const record = (kind, sessionId) => {
    const atMs = now();
    signals.push(Object.freeze({ kind, weight: RECEPTION_WEIGHTS[kind], atMs, sessionId }));
    // 足够老的信号已衰减到可以忽略；只保留最近若干条。
    while (signals.length > config.maxSignals) signals.shift();
    // trace 只放信号类别与系数，不放用户原话。
    const factor = cadenceFactor(signals.filter(signal => signal.sessionId === sessionId), atMs, config);
    try { trace?.(sessionId, { type: 'reception_signal', kind, cadenceFactor: Math.round(factor * 100) / 100 }); } catch { /* trace 只是诊断 */ }
    emit({ type: 'signal', kind, sessionId });
    return kind;
  };

  const api = Object.freeze({
    /** AmbientPresence 真的交付了她的一句（voiced=出声）。 */
    noteLine(sessionId, { voiced = false } = {}) {
      if (!sessionId) return;
      lastLine.delete(sessionId);
      lastLine.set(sessionId, { atMs: now(), voiced: Boolean(voiced), replied: false, skipped: false });
      if (lastLine.size > config.maxSessions) lastLine.delete(lastLine.keys().next().value);
    },

    /** 已接受的用户回合。她上一句入账后 5 分钟内 → replied（每句一次）。 */
    noteUserTurn(sessionId) {
      const line = lastLine.get(sessionId);
      if (!line || line.replied || now() - line.atMs > config.replyWindowMs) return null;
      line.replied = true;
      return record('replied', sessionId);
    },

    /** 用户跳过当前歌（observer 的 track_skipped，技术失败不在其中）。她出声后 30 秒内 → 弱负信号。 */
    noteSkip(sessionId) {
      const line = lastLine.get(sessionId);
      if (!line || !line.voiced || line.skipped || now() - line.atMs > config.skipWindowMs) return null;
      line.skipped = true;
      return record('skipped_after_line', sessionId);
    },

    askMore(sessionId) {
      return record('asked_more', sessionId);
    },

    /** 本次一起听不再主动开口。返回读回的状态。 */
    askQuiet(listeningSessionId) {
      if (!listeningSessionId) return null;
      const changed = quiet?.sessionId !== listeningSessionId;
      quiet = Object.freeze({ sessionId: listeningSessionId, sinceMs: now() });
      if (changed) {
        try { trace?.(listeningSessionId, { type: 'reception_quiet', quiet: true }); } catch { /* 诊断 */ }
        emit({ type: 'quiet', sessionId: listeningSessionId, quiet: true });
      }
      return quiet;
    },

    /** 恢复（一键恢复、换来源、下次一起听）。只清对应来源的安静。 */
    restore(listeningSessionId, { cause = 'listener' } = {}) {
      if (!quiet || (listeningSessionId && quiet.sessionId !== listeningSessionId)) return false;
      const { sessionId } = quiet;
      quiet = null;
      try { trace?.(sessionId, { type: 'reception_quiet', quiet: false, cause }); } catch { /* 诊断 */ }
      emit({ type: 'quiet', sessionId, quiet: false });
      return true;
    },

    isQuiet: listeningSessionId => Boolean(listeningSessionId) && quiet?.sessionId === listeningSessionId,
    quietSessionId: () => quiet?.sessionId ?? null,

    /** 听歌来源变成了别的（非空）来源：上一个来源的「安静点」到此为止。 */
    noteSource(listeningSessionId) {
      if (quiet && listeningSessionId && listeningSessionId !== quiet.sessionId) api.restore(null, { cause: 'source-changed' });
    },

    /** 同一来源开始了新的一次一起听（session_open）。 */
    noteSessionOpen(listeningSessionId) {
      if (quiet && quiet.sessionId === listeningSessionId && now() > quiet.sinceMs) api.restore(listeningSessionId, { cause: 'new-listening' });
    },

    /** 这个听歌来源（聊天）的节奏系数；信号按聊天记，不跨聊天。 */
    cadenceFactor: sessionId => cadenceFactor(signals.filter(signal => signal.sessionId === sessionId), now(), config),
    signals: () => signals.slice(),
  });
  return api;
}

export default createReceptionSignals;
