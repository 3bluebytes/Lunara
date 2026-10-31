// createPresenceWiring.js — presence 的生产装配（组合根行数守卫）。
//
// 只读挂到 PlaybackRuntimeHost；节奏状态存进现有 state.db 的 prefs KV（独立 key，
// 不进 settings JSON，不新增表）；决策与唤醒写进该听歌会话的 session trace。
// 给了 virtualPerson 组合时装上心跳（add-companion-heartbeat 阶段 A）：
//   PresenceObserver（时刻 + 人声账本）→ CompanionHeartbeat（什么时候叫醒她）
//   → AmbientPresence（主循环跑一轮 ambient turn，她自己决定说不说；说了就交付）。
// P1 的 PresenceRuntime 旁路不再装配（两条路径不同时运行；5.1 验收后删除旧代码）。
// PRESENCE_AUTO=0 时完全不订阅、不建心跳；「一起听歌时伙伴会主动说话」开关只关心跳。
//
// Python 伪代码：
//   observer = PresenceObserver(...)
//   heartbeat = CompanionHeartbeat(is_enabled=prefs.ambient_enabled, on_wake=ambient_presence, **observer.hooks())
//   observer.use_heartbeat(heartbeat); observer.attach(playback)
//   client_hub.on_clients_changed(heartbeat.refresh); runtime.on_user_turn(observer.note_user_turn)
//   reception = ReceptionSignals()     # 只收已接受事实：她交付的句子、你开口、跳过、set_presence_preference
//   heartbeat.cadence_factor = reception.cadence_factor; heartbeat.listener_quiet = reception.is_quiet
//   greeter = AppOpenGreeter(run_turn=AmbientPresence(can_speak_aloud=never))   # add-app-open-greeting：回来了只出文字
//   client_hub.on_presence_changed(greeter.update_clients); runtime.on_user_turn(greeter.note_user_turn)
import { PlaybackPhase } from '../playback/playbackRuntimeTypes.js';
import { createAmbientPresence } from './AmbientPresence.js';
import { createAppOpenGreeter } from './AppOpenGreeter.js';
import { inQuietHours } from './presenceEligibility.js';
import { resolveVoice } from './groupVoice.js';
import { CompanionHeartbeat } from './CompanionHeartbeat.js';
import { PresenceObserver } from './PresenceObserver.js';
import { registerPresencePreferenceTool } from './presencePreferenceTool.js';
import { createReceptionSignals } from './receptionSignals.js';
import { createPresencePreferences } from './presencePreferences.js';
import { presenceTemperamentOf } from './presenceTemperament.js';

export const PRESENCE_PREF_KEY = 'presence_state_v1';
const AUDIBLE_PHASES = new Set([PlaybackPhase.PLAYING, PlaybackPhase.EXHAUSTED]);

/** 语音门控：这一场正是当前音频会话、在放歌或刚放完、至少一个客户端在线。 */
export function canSpeakAloudFor({ playbackRuntime, clientCount }) {
  return sessionId => {
    const snapshot = playbackRuntime.snapshot();
    return snapshot?.activeListeningSessionId === sessionId && AUDIBLE_PHASES.has(snapshot.phase)
      && Number(clientCount()) > 0;
  };
}

/** 今天的 ambient_turn 用量是否已到日上限（传输层守卫仍是最终裁决；这里只是不白叫醒）。 */
export function ambientBudgetExhausted(usageLedger) {
  return () => {
    const ledger = usageLedger?.ledger;
    const cap = ledger?.caps?.ambient_turn;
    return Number.isFinite(cap) && ledger.tokensToday('ambient_turn') >= cap;
  };
}

const unrefTimer = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
};

export function createPresenceWiring({ playbackRuntime, sessionTrace = null, state, getActivity,
  virtualPerson = null, queueService = null, clientHub = null, usageLedger = null, publish = null,
  env = process.env, logger = console, now = () => Date.now(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, heartbeatOptions = {} } = {}) {
  const trace = (sessionId, event) => sessionTrace?.recordScoped?.(sessionId, event);
  const enabled = env.PRESENCE_AUTO !== '0';
  const clientCount = () => Number(clientHub?.clientCount) || 0;
  const preferences = createPresencePreferences({ state, env });
  // 说话角色的在场性格（metadata_json.presence），每次现读，编辑后立即生效。
  const temperamentFor = personId => presenceTemperamentOf(virtualPerson?.registry?.get?.(personId)).temperament;
  const observer = new PresenceObserver({
    enabled, trace, temperamentFor, getActivity, logger, now, timeZone,
    persistence: { load: () => state.getPref(PRESENCE_PREF_KEY), save: data => state.setPref(PRESENCE_PREF_KEY, data) },
  });
  const runtime = virtualPerson?.runtime;
  let heartbeat = null;
  let greeter = null;
  // 接收信号（D5）：节奏系数与「安静点」。「安静点」变了就广播给房间（可见状态 + 一键恢复），并重新判断上弦。
  const reception = createReceptionSignals({ now, trace, onChange: change => {
    if (change.type === 'quiet') {
      try { publish?.({ type: 'presence-listener-quiet', payload: { sessionId: change.sessionId, quiet: change.quiet } }); }
      catch { logger?.warn?.('[presence] quiet broadcast failed'); }
    }
    heartbeat?.refresh();
  } });
  if (enabled && typeof runtime?.handleAmbientTurn === 'function' && queueService) {
    const hooks = observer.heartbeatHooks();
    // 群聊一拍谁出声、谁文字跟（D9）：每次现读房间与主持人；只读，不改房间。
    const conversationStore = virtualPerson?.conversationStore || runtime.conversationStore;
    const voiceOf = snapshot => resolveVoice({ snapshot,
      room: snapshot?.activeListeningSessionId && typeof conversationStore?.getSession === 'function'
        ? conversationStore.getSession(snapshot.activeListeningSessionId) : null,
      isAvailable: id => {
        const person = virtualPerson?.registry?.get?.(id);
        return Boolean(person) && person.status !== 'archived';
      } });
    const ambient = createAmbientPresence({
      runtime, presentationService: virtualPerson.presentationService, queueService, logger, trace,
      canSpeakAloud: canSpeakAloudFor({ playbackRuntime, clientCount }),
      // 仍是这次唤醒时的听歌来源与陪伴模式；任一变了，入账前重验与交付都作废。
      isWakeCurrent: wake => {
        const snapshot = playbackRuntime.snapshot();
        return snapshot?.activeListeningSessionId === wake.sessionId
          && (snapshot.modeRevision ?? null) === (wake.modeRevision ?? null);
      },
      // 交付前出声者还是不是现在的解析结果（一拍进行中改了主持人，这句只出文字）。
      isVoiceHolder: wake => voiceOf(playbackRuntime.snapshot()).holderId === wake.personId,
    });
    heartbeat = new CompanionHeartbeat({
      trace, temperamentFor, getActivity, clientCount, logger, now, timeZone, setTimer: unrefTimer,
      isEnabled: () => preferences.ambientEnabled(),
      getSnapshot: () => playbackRuntime.snapshot(),
      getVoiceEntry: hooks.getVoiceEntry,
      pacing: hooks.pacing,
      llmBudgetExhausted: ambientBudgetExhausted(usageLedger),
      voiceOf,
      // 她自己约的 followup（只读）：笔记库读失败等同没有约。
      followupsFor: sessionId => conversationStore?.notes?.pendingFollowups?.(sessionId) || [],
      cadenceFactor: sessionId => reception.cadenceFactor(sessionId),
      listenerQuiet: sessionId => reception.isQuiet(sessionId),
      // 真的交付了她的话才记一句（出声的那句才参与「出声后 30 秒内切歌」）。
      onWake: async wake => {
        const result = await ambient(wake);
        if (result?.outcome === 'spoken' || result?.outcome === 'text-only') {
          reception.noteLine(wake.sessionId, { voiced: result.outcome === 'spoken' });
        }
        return result;
      },
      ...heartbeatOptions,
    });
    observer.useHeartbeat(heartbeat);
    // 回来了（add-app-open-greeting）：同一条 ambient 链路，只出文字；中止由 greeter 的 signal 决定。
    const greet = createAmbientPresence({
      runtime, presentationService: virtualPerson.presentationService, queueService, logger, trace,
      isWakeCurrent: wake => wake.signal?.aborted !== true,
    });
    greeter = createAppOpenGreeter({
      state, now, timeZone, trace, logger,
      isEnabled: () => preferences.greetingEnabled(),
      inQuietHours: () => inQuietHours(now(), timeZone),
      budgetExhausted: ambientBudgetExhausted(usageLedger),
      listenerQuiet: sessionId => reception.isQuiet(sessionId),
      // 这个聊天正在一起听、在放歌：心跳负责，不重复叫醒。
      isHeartbeatRoom: sessionId => {
        const snapshot = playbackRuntime.snapshot();
        return snapshot?.activeListeningSessionId === sessionId && AUDIBLE_PHASES.has(snapshot.phase);
      },
      listRooms: () => conversationStore?.listRooms?.() || [],
      notesFor: query => conversationStore?.notes?.listVisible?.(query) || [],
      runTurn: async wake => {
        const result = await greet(wake);
        if (result?.outcome === 'text-only') reception.noteLine(wake.sessionId, { voiced: false });
        return result;
      },
    });
  }
  observer.attach(playbackRuntime);
  // ambient 推荐（add-ambient-music-recommendation）：闸门沿用同一个「安静点」；换了听歌来源，
  // 上一个来源还没处理的推荐作废（不是不喜欢，不留口味记录）。暂停/停止不算换。
  const recommendations = virtualPerson?.ambientRecommendations || null;
  if (recommendations) {
    recommendations.setListenerQuiet?.(sessionId => reception.isQuiet(sessionId));
    let lastSource = playbackRuntime.snapshot?.()?.activeListeningSessionId ?? null;
    playbackRuntime.subscribe?.(next => {
      const source = next?.activeListeningSessionId ?? null;
      if (!source || source === lastSource) return;
      const previous = lastSource;
      lastSource = source;
      if (previous) {
        try { recommendations.expireSession(previous); } catch { logger?.warn?.('[presence] recommendation expiry failed'); }
      }
    });
  }
  if (heartbeat) {
    // 「app 开着」= 至少一个客户端在线：连上/断开都重新判断上弦条件。
    clientHub?.onClientsChanged?.(() => heartbeat.refresh());
    runtime.onUserTurn(sessionId => {
      reception.noteUserTurn(sessionId);
      observer.noteUserTurn(sessionId);
      greeter?.noteUserTurn(sessionId);
    });
    // 可见/正在输入的汇总：回来的边沿，以及「你开始打字/全都切走」时中止问候。
    if (greeter && typeof clientHub?.onPresenceChanged === 'function') {
      clientHub.onPresenceChanged(summary => greeter.updateClients(summary));
      if (typeof clientHub.presenceSummary === 'function') greeter.updateClients(clientHub.presenceSummary());
    }
    observer.onMoment(moment => {
      if (moment.kind === 'track_skipped') reception.noteSkip(moment.sessionId);
      if (moment.kind === 'session_open') reception.noteSessionOpen(moment.sessionId);
    });
    // 换了听歌来源：上一个来源的「安静点」到此为止（暂停/停止不算换）。
    playbackRuntime.subscribe?.(next => reception.noteSource(next?.activeListeningSessionId ?? null));
    if (virtualPerson?.toolRegistry) {
      registerPresencePreferenceTool(virtualPerson.toolRegistry, { getReception: () => reception,
        getListeningSessionId: () => playbackRuntime.snapshot()?.activeListeningSessionId || null });
    }
    heartbeat.refresh();
  }
  return Object.freeze({
    observer, heartbeat,
    reception, greeter,
    /** 产品事实：在场状态 + 哪个听歌来源被要求安静（null = 没有）。 */
    status: () => ({ ...observer.status(), listenerQuietSessionId: reception.quietSessionId() }),
    /** 房间里的一键恢复：只清这个来源的「安静点」。 */
    restoreListenerQuiet: sessionId => ({ restored: reception.restore(sessionId), listenerQuietSessionId: reception.quietSessionId() }),
    preferences: () => preferences.get(),
    /** 写入成功才返回新值；关闭时立即撤弦并中止进行中的 ambient turn / 问候。 */
    setPreferences(input) {
      const next = preferences.set(input);
      if (input?.greetingEnabled === false) greeter?.abort();
      heartbeat?.refresh();
      return next;
    },
    async settled() {
      await observer.settled();
      await heartbeat?.settled();
      await greeter?.settled();
    },
    stop: () => {
      heartbeat?.stop();
      greeter?.stop();
    },
  });
}
