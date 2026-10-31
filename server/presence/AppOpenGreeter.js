// AppOpenGreeter.js — 「你回来了」的唤醒来源 app_open（add-app-open-greeting）。
//
// 调用顺序：WebSocketHub 汇总各连接的 client-presence → updateClients({ visible, typing })
//   → 从「无人可见」变为「有人可见」且离开 ≥ 1 小时 → 过闸门 → runTurn(wake)
//   （生产里是 AmbientPresence → VirtualPersonRuntime.handleAmbientTurn，只出文字）。
// 选聊天：最近活跃的未归档聊天（lastTurnAt 最大，群聊单聊一样），主持伙伴说话；不改查看中的聊天或听歌来源。
// 门槛：有可提的心里话（ambient 过滤器），或离开 ≥ 7 小时（隔夜可以简单打个招呼）。
// 上限：每个聊天每个本地日一次（叫醒即计数）；静默时段、日预算、「安静点」、开关；该聊天正在一起听时让给心跳。
// 作废：任一聊天里你开口、开始打字、全部客户端不可见，或回来 20 秒后仍没入账。
// 「上次可见」与当天已问候的聊天存在 prefs KV（app_open_greeting_v1），不新增表。
// trace 只记原因码与粗粒度离开时长，不记正文。
//
// Python 伪代码：
//   def update_clients(visible, typing):
//       if typing or not visible: abort_active()
//       if visible and not was_visible: on_return(now - state.last_visible_at)
//       if not visible and was_visible: state.last_visible_at = now
//   def on_return(away):
//       if away < 1h: return
//       room = max(rooms, key=last_turn_at); reason = first_failing_gate(room, away)
//       if reason: trace(skipped, reason); return
//       mark_greeted(room); await run_turn(Wake(reason='app_open', room, host, away, signal, deadline=20s))

import { awayBucket } from './ambientTurn.js';

export const APP_OPEN_STATE_KEY = 'app_open_greeting_v1';
export const APP_OPEN_LIMITS = Object.freeze({
  awayMs: 60 * 60_000,
  longAwayMs: 7 * 60 * 60_000,
  deadlineMs: 20_000,
  refreshMs: 5 * 60_000,
});

function localDate(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

const defaultSetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};

export function createAppOpenGreeter({ state, now = () => Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  isEnabled = () => true, inQuietHours = () => false, budgetExhausted = () => false, listenerQuiet = () => false,
  isHeartbeatRoom = () => false, listRooms = () => [], notesFor = () => [], runTurn, trace = null,
  setTimer = defaultSetTimer, clearTimer = timer => clearTimeout(timer), logger = console } = {}) {
  if (typeof runTurn !== 'function') throw new TypeError('createAppOpenGreeter requires runTurn()');
  const record = (sessionId, event) => {
    if (!sessionId) return;
    try { trace?.(sessionId, event); } catch { /* trace 失败不影响问候 */ }
  };

  const load = () => {
    let data = null;
    try { data = state?.getPref?.(APP_OPEN_STATE_KEY) ?? null; } catch { data = null; }
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
    const greeted = data?.greeted && typeof data.greeted === 'object' ? { ...data.greeted } : {};
    return { lastVisibleAt: Number.isFinite(data?.lastVisibleAt) ? data.lastVisibleAt : null, greeted };
  };
  let saved = load();
  const persist = patch => {
    saved = { ...saved, ...patch };
    try { state?.setPref?.(APP_OPEN_STATE_KEY, { version: 1, ...saved }); }
    catch { logger?.warn?.('[presence] app-open state write failed'); }
  };

  let visible = false;
  let refreshTimer = null;
  let active = null; // { controller, deadline }
  let pending = Promise.resolve(null);

  const stopRefresh = () => {
    if (refreshTimer) clearTimer(refreshTimer);
    refreshTimer = null;
  };
  const scheduleRefresh = () => {
    stopRefresh();
    refreshTimer = setTimer(() => {
      refreshTimer = null;
      if (!visible) return;
      persist({ lastVisibleAt: now() });
      scheduleRefresh();
    }, APP_OPEN_LIMITS.refreshMs);
  };
  const abortActive = reason => {
    if (!active) return;
    active.controller.abort(reason);
  };

  const pickRoom = () => {
    let rooms = [];
    try { rooms = listRooms() || []; } catch { rooms = []; }
    return rooms.filter(room => room && !room.archivedAt && room.activeVirtualPersonId
      && Array.isArray(room.memberIds) && room.memberIds.includes(room.activeVirtualPersonId))
      .sort((a, b) => (Number(b.lastTurnAt) || 0) - (Number(a.lastTurnAt) || 0))[0] || null;
  };

  const hasNotes = room => {
    try {
      return (notesFor({ personId: room.activeVirtualPersonId, sessionId: room.sessionId, isGroup: room.memberIds.length > 1,
        mode: 'ambient', wake: { reason: 'app_open' } }) || []).length > 0;
    } catch { return false; }
  };

  const gate = (room, awayMs, today) => {
    if (isEnabled() !== true) return 'disabled';
    if (inQuietHours() === true) return 'quiet-hours';
    if (budgetExhausted() === true) return 'llm-budget';
    if (!room) return 'no-room';
    if (listenerQuiet(room.sessionId) === true) return 'listener-quiet';
    if (saved.greeted[room.sessionId] === today) return 'already-today';
    if (isHeartbeatRoom(room.sessionId) === true) return 'heartbeat-owns';
    if (awayMs < APP_OPEN_LIMITS.longAwayMs && !hasNotes(room)) return 'nothing-to-say';
    return null;
  };

  async function attempt(awayMs, firedAtMs) {
    const bucket = awayBucket(awayMs);
    const today = localDate(firedAtMs, timeZone);
    const room = pickRoom();
    const reason = gate(room, awayMs, today);
    if (reason) {
      record(room?.sessionId, { type: 'app_open_skipped', reason, awayBucket: bucket });
      return { outcome: 'skipped', reason };
    }
    const sessionId = room.sessionId;
    // 叫醒即计数：她安静、被打断都算今天这个聊天问候过了。只保留当天的记录。
    const greeted = Object.fromEntries(Object.entries(saved.greeted).filter(([, day]) => day === today));
    persist({ greeted: { ...greeted, [sessionId]: today } });
    const controller = new AbortController();
    const deadline = setTimer(() => controller.abort('deadline'), APP_OPEN_LIMITS.deadlineMs);
    active = { controller, deadline };
    const wake = Object.freeze({
      id: `app_open:${sessionId}:${firedAtMs}`, sessionId, personId: room.activeVirtualPersonId, reason: 'app_open',
      firedAtMs, awayMs, signal: controller.signal, followerIds: [], followups: [], followupNoteIds: [],
      sinceLastWake: {}, policy: null,
    });
    record(sessionId, { type: 'app_open_wake', wakeId: wake.id, personId: wake.personId, awayBucket: bucket });
    let result;
    try {
      result = await runTurn(wake);
    } catch {
      logger?.warn?.('[presence] app-open turn failed');
      result = { outcome: 'silent', reason: 'error' };
    } finally {
      clearTimer(deadline);
      if (active?.controller === controller) active = null;
    }
    const outcome = result?.outcome || 'silent';
    const resultReason = controller.signal.aborted && outcome === 'silent' ? String(controller.signal.reason || 'interrupted')
      : (result?.reason || outcome);
    record(sessionId, { type: 'app_open_result', wakeId: wake.id, outcome, reason: resultReason, lines: Number(result?.lines) || 0 });
    return { outcome, reason: resultReason };
  }

  function onReturn() {
    const firedAtMs = now();
    const last = saved.lastVisibleAt;
    persist({ lastVisibleAt: firedAtMs });
    // 第一次运行没有「上次可见」：只记录，不打招呼。
    if (!Number.isFinite(last) || firedAtMs - last < APP_OPEN_LIMITS.awayMs || active) return;
    pending = attempt(firedAtMs - last, firedAtMs);
  }

  return Object.freeze({
    /** 客户端汇总：visible = 可见连接数，typing = 有没有人正在输入。 */
    updateClients({ visible: visibleCount = 0, typing = false } = {}) {
      const nextVisible = Number(visibleCount) > 0;
      if (typing === true || !nextVisible) abortActive('interrupted');
      if (nextVisible && !visible) {
        visible = true;
        onReturn();
        scheduleRefresh();
      } else if (!nextVisible && visible) {
        visible = false;
        stopRefresh();
        persist({ lastVisibleAt: now() });
      }
    },
    /** 任何聊天里你开口了：让你先说。 */
    noteUserTurn() { abortActive('interrupted'); },
    /** 开关关掉：中止进行中的问候（照常记录可见时刻）。 */
    abort() { abortActive('interrupted'); },
    /** 最近一次尝试的结果（测试与关停用）。 */
    settled: () => pending,
    stop() {
      stopRefresh();
      abortActive('interrupted');
    },
  });
}

export default createAppOpenGreeter;
