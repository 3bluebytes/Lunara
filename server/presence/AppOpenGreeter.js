// AppOpenGreeter.js — 「你回来了」的唤醒来源 app_open（add-app-open-greeting）。
//
// 调用顺序：WebSocketHub 汇总各连接的 client-presence → updateClients({ visible, typing })
//   → 从「无人可见」变为「有人可见」且离开 ≥ 5 分钟 → 过闸门 → runTurn(wake)
//   → 仅 turn-busy 时每 250ms 串行补试，沿用同一 wake 与回来后 20 秒截止；补试前重验闸门与原聊天/主持人。
//   （生产里是 AmbientPresence → VirtualPersonRuntime.handleAmbientTurn，只出文字）。
// 选聊天：最近活跃的未归档聊天（lastTurnAt 最大，群聊单聊一样），主持伙伴说话；不改查看中的聊天或听歌来源。
// 每次回来都叫醒，不限每天次数，也不要求有心里话：说不说、说什么是她自己的分寸，她可以安静。
// 挡住的只有：静默时段、日预算、「安静点」、开关。正在一起听、在放歌也问候；跑过一轮由装配告诉心跳算一拍。
// 作废：任一聊天里你开口、开始打字、全部客户端不可见，或回来 20 秒后仍没入账。
// 「上次可见」存在 prefs KV（app_open_greeting_v1），不新增表；旧版本留下的 greeted 字段读到也忽略。
// trace 只记原因码与粗粒度离开时长，不记正文。
//
// Python 伪代码：
//   def update_clients(visible, typing):
//       if typing or not visible: abort_active()
//       if visible and not was_visible: on_return(now - state.last_visible_at)
//       if not visible and was_visible: state.last_visible_at = now
//   def on_return(away):
//       if away < 5min: return   # 更短的是断线重连
//       room = max(rooms, key=last_turn_at); reason = first_failing_gate(room, away)
//       if reason: trace(skipped, reason); return
//       await run_turn(Wake(reason='app_open', room, host, away, signal, deadline=20s))

import { awayBucket } from './ambientTurn.js';

export const APP_OPEN_STATE_KEY = 'app_open_greeting_v1';
export const APP_OPEN_LIMITS = Object.freeze({
  // 窗口关掉再打开就算回来；更短的是断线重连。
  awayMs: 5 * 60_000,
  // 桌面窗口常开时，房间静置聚焦触发的现实冷却阈值（25 分钟）。
  idleReturnAwayMs: 25 * 60_000,
  deadlineMs: 20_000,
  retryMs: 250,
  refreshMs: 5 * 60_000,
});

const defaultSetTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};

export function createAppOpenGreeter({ state, now = () => Date.now(),
  isEnabled = () => true, inQuietHours = () => false, budgetExhausted = () => false, listenerQuiet = () => false,
  listRooms = () => [], runTurn, markReturnGreeted = null, trace = null, reserveHost = null,
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
    return { lastVisibleAt: Number.isFinite(data?.lastVisibleAt) ? data.lastVisibleAt : null };
  };
  let saved = load();
  const persist = patch => {
    saved = { ...saved, ...patch };
    try { state?.setPref?.(APP_OPEN_STATE_KEY, { version: 1, ...saved }); }
    catch { logger?.warn?.('[presence] app-open state write failed'); }
  };

  let visible = false;
  let clientTyping = false;
  let refreshTimer = null;
  let active = null; // { controller, deadline }
  let pending = Promise.resolve(null);
  let startupRelease = null;
  let startupTimer = null;
  const releaseStartup = () => {
    if (startupTimer) clearTimer(startupTimer);
    startupTimer = null;
    startupRelease?.();
    startupRelease = null;
  };

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

  const pickRoom = (preferredSessionId = null) => {
    let rooms = [];
    try { rooms = listRooms() || []; } catch { rooms = []; }
    const eligible = rooms.filter(room => room && !room.archivedAt && room.activeVirtualPersonId
      && Array.isArray(room.memberIds) && room.memberIds.includes(room.activeVirtualPersonId));
    const target = typeof preferredSessionId === 'string' && preferredSessionId.trim()
      ? preferredSessionId.trim()
      : null;
    if (target) {
      const matched = eligible.find(room => room.sessionId === target);
      if (matched) return matched;
      if (rooms.some(room => room?.sessionId === target)) return null;
    }
    return eligible.sort((a, b) => (Number(b.lastTurnAt) || 0) - (Number(a.lastTurnAt) || 0))[0] || null;
  };

  const gate = (room, { awayMs, firedAtMs, isIdleReturn = false } = {}) => {
    if (isEnabled() !== true) return 'disabled';
    if (inQuietHours() === true) return 'quiet-hours';
    if (budgetExhausted() === true) return 'llm-budget';
    if (!room) return 'no-room';
    if (listenerQuiet(room.sessionId) === true) return 'listener-quiet';
    if (isIdleReturn && Number.isFinite(room.lastTurnAt)
      && (firedAtMs - room.lastTurnAt) < APP_OPEN_LIMITS.idleReturnAwayMs) {
      return 'recent-turn';
    }
    if (room.lastUserTurnId === null && (room.interactionMode === 'roleplay' || isIdleReturn)) {
      return 'no-user-turn';
    }
    const lastUserTurnId = typeof room.lastUserTurnId === 'string' ? room.lastUserTurnId.trim() : '';
    if (lastUserTurnId) {
      const greetedTurnId = typeof room.returnGreetedTurnId === 'string' ? room.returnGreetedTurnId.trim() : '';
      if (greetedTurnId && greetedTurnId === lastUserTurnId) return 'already-greeted';
    }
    return null;
  };

  // 只等一个有界间隔；取消立即结束，并清掉定时器/监听器，不留下迟到补试。
  const waitForRetry = signal => new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimer(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimer(done, APP_OPEN_LIMITS.retryMs);
    signal.addEventListener('abort', done, { once: true });
  });

  async function attempt(awayMs, firedAtMs, preferredSessionId = null, { isIdleReturn = false } = {}) {
    const bucket = awayBucket(awayMs);
    const room = pickRoom(preferredSessionId);
    const reason = gate(room, { awayMs, firedAtMs, isIdleReturn });
    if (reason) {
      record(room?.sessionId, { type: 'app_open_skipped', reason, awayBucket: bucket });
      return { outcome: 'skipped', reason };
    }
    const sessionId = room.sessionId;
    const targetUserTurnId = typeof room.lastUserTurnId === 'string' && room.lastUserTurnId.trim()
      ? room.lastUserTurnId.trim()
      : null;
    const controller = new AbortController();
    const expiresAtMs = firedAtMs + APP_OPEN_LIMITS.deadlineMs;
    const deadline = setTimer(() => controller.abort('deadline'), Math.max(0, expiresAtMs - now()));
    active = { controller, deadline };
    const wake = Object.freeze({
      id: `app_open:${sessionId}:${firedAtMs}`, sessionId, personId: room.activeVirtualPersonId, reason: 'app_open',
      firedAtMs, awayMs, signal: controller.signal, followerIds: [], followups: [], followupNoteIds: [],
      sinceLastWake: {}, policy: null,
    });
    record(sessionId, { type: 'app_open_wake', wakeId: wake.id, personId: wake.personId, awayBucket: bucket });
    let result;
    let releaseHost = null;
    try {
      releaseHost = reserveHost?.(sessionId, { signal: controller.signal });
      for (;;) {
        // 定时器可能被事件循环推迟；不能因此多拿生成时间或在截止后补试。
        if (now() >= expiresAtMs) controller.abort('deadline');
        if (controller.signal.aborted) { result = { outcome: 'silent' }; break; }
        let currentRoom = null;
        try { currentRoom = (listRooms() || []).find(item => item?.sessionId === sessionId); } catch { /* fail closed */ }
        if (!currentRoom || currentRoom.archivedAt || currentRoom.activeVirtualPersonId !== wake.personId
          || !currentRoom.memberIds?.includes(wake.personId)) {
          result = { outcome: 'silent', reason: 'stale' };
          break;
        }
        const currentUserTurnId = typeof currentRoom.lastUserTurnId === 'string' ? currentRoom.lastUserTurnId.trim() : '';
        if (targetUserTurnId && currentUserTurnId && currentUserTurnId !== targetUserTurnId) {
          result = { outcome: 'silent', reason: 'stale' };
          break;
        }
        const blocked = gate(currentRoom, { awayMs, firedAtMs, isIdleReturn });
        if (blocked) { result = { outcome: 'silent', reason: blocked }; break; }
        result = await runTurn(wake);
        // runtime 在调模型前返回 busy。其他结果（包括主动安静）都不重跑模型。
        if (result?.outcome !== 'silent' || result?.reason !== 'turn-busy' || controller.signal.aborted) break;
        await waitForRetry(controller.signal);
      }
    } catch {
      logger?.warn?.('[presence] app-open turn failed');
      result = { outcome: 'silent', reason: 'error' };
    } finally {
      releaseHost?.();
      clearTimer(deadline);
      if (active?.controller === controller) active = null;
    }
    const outcome = result?.outcome || 'silent';
    const resultReason = controller.signal.aborted && outcome === 'silent' ? String(controller.signal.reason || 'interrupted')
      : (result?.reason || outcome);
    const shouldMarkGreeted = outcome === 'spoken'
      || outcome === 'text-only'
      || (outcome === 'quiet' && awayMs >= APP_OPEN_LIMITS.idleReturnAwayMs);
    if (targetUserTurnId && shouldMarkGreeted) {
      try { markReturnGreeted?.(sessionId, targetUserTurnId); }
      catch { logger?.warn?.('[presence] markReturnGreeted failed'); }
    }
    record(sessionId, { type: 'app_open_result', wakeId: wake.id, outcome, reason: resultReason, lines: Number(result?.lines) || 0 });
    return { outcome, reason: resultReason };
  }

  function onReturn() {
    const firedAtMs = now();
    const last = saved.lastVisibleAt;
    persist({ lastVisibleAt: firedAtMs });
    // 第一次运行没有「上次可见」：只记录，不打招呼。
    if (!Number.isFinite(last) || firedAtMs - last < APP_OPEN_LIMITS.awayMs || active || clientTyping) return;
    pending = attempt(firedAtMs - last, firedAtMs);
  }

  // 装配早于播放恢复：先等首次可见性判定，避免恢复续播在窗口连上前抢占 host。
  // 无客户端时有界放行；第一次安装/关闭/静默/预算耗尽时不加启动等待。
  if (typeof reserveHost === 'function' && Number.isFinite(saved.lastVisibleAt)
    && now() - saved.lastVisibleAt >= APP_OPEN_LIMITS.awayMs && isEnabled() === true
    && !inQuietHours() && !budgetExhausted()) {
    startupRelease = reserveHost(null);
    startupTimer = setTimer(releaseStartup, APP_OPEN_LIMITS.deadlineMs);
  }

  return Object.freeze({
    /** 客户端汇总：visible = 可见连接数，typing = 有没有人正在输入，idleReturn = 常开窗口静置后重新聚焦房间的一次性边沿。 */
    updateClients({ visible: visibleCount = 0, typing = false, idleReturn = null } = {}) {
      const nextVisible = Number(visibleCount) > 0;
      clientTyping = typing === true;
      if (clientTyping || !nextVisible) abortActive('interrupted');
      if (nextVisible && !visible) {
        visible = true;
        onReturn();
        // onReturn 同步取得该聊天的保留，再放开启动的全局保留，不能出现插队空档。
        releaseStartup();
        scheduleRefresh();
      } else if (!nextVisible && visible) {
        visible = false;
        stopRefresh();
        persist({ lastVisibleAt: now() });
      } else if (nextVisible && visible && !clientTyping && !active && idleReturn && typeof idleReturn === 'object') {
        const awayMs = Number(idleReturn.awayMs);
        if (Number.isFinite(awayMs) && awayMs >= APP_OPEN_LIMITS.idleReturnAwayMs) {
          const rawFiredAt = Number(idleReturn.firedAtMs);
          const firedAtMs = Number.isFinite(rawFiredAt) && rawFiredAt > 0 ? rawFiredAt : now();
          persist({ lastVisibleAt: firedAtMs });
          pending = attempt(awayMs, firedAtMs, idleReturn.sessionId || null, { isIdleReturn: true });
        }
      }
    },
    /** 任何聊天里你开口了：让你先说。 */
    noteUserTurn() { releaseStartup(); abortActive('interrupted'); },
    /** 开关关掉：中止进行中的问候（照常记录可见时刻）。 */
    abort() { releaseStartup(); abortActive('interrupted'); },
    /** 最近一次尝试的结果（测试与关停用）。 */
    settled: () => pending,
    stop() {
      releaseStartup();
      stopRefresh();
      abortActive('interrupted');
    },
  });
}

export default createAppOpenGreeter;
