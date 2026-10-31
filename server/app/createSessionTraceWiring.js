// createSessionTraceWiring.js — 会话执行记录的生产装配（组合根行数守卫）。
//
// 组合根只调用一次 createSessionTraceWiring()，把「记录存储 + 模型观测 + 服务事件归属
// + 删除清理」作为一个整体拿回去；归属元数据通过 getter 惰性读取，因此本模块可以先于
// ConversationStore 构造。

import { SessionTraceStore } from '../sessionTraceStore.js';
import { createSessionTrace } from '../sessionTrace.js';
import { setLlmObserver } from '../llm.js';
import { trace } from '../trace.js';
import { resolveSessionTraceDir, resolveTaskTraceDir } from '../runtimePaths.js';

function sessionOwner(room, registry) {
  const members = [...(room.memberIds || [])].sort();
  const active = members.includes(room.activeVirtualPersonId) ? room.activeVirtualPersonId : members[0];
  const entity = active ? registry?.get?.(active) : null;
  return members.length > 1
    ? { kind: 'group', id: `group:${members.join('+')}`, name: room.title || '群聊' }
    : { kind: 'host', id: active || 'lunara', name: entity?.displayName || active || 'lunara' };
}

export function createSessionTraceWiring({ getConversationStore = () => null, getRegistry = () => null,
  root = resolveSessionTraceDir(), taskRoot = resolveTaskTraceDir(), logger = console, onModelEvent = null } = {}) {
  const store = new SessionTraceStore({
    root,
    taskRoot,
    resolveSession: sessionId => {
      try {
        const room = getConversationStore()?.getSession?.(sessionId);
        if (!room) return null;
        return { sessionId: room.sessionId, title: room.title || '', createdAt: room.createdAt,
          owner: sessionOwner(room, getRegistry()) };
      } catch { return null; }
    },
    logger,
  });
  const sessionTrace = createSessionTrace({ store });
  // 模型调用观测：适配后的真实请求、供应商返回的思考内容与用量按同一执行身份记录。
  // onModelEvent 供能力探测接线复用同一观察者（惰性补探测），不在 llm.js 里挂第二个钩子。
  setLlmObserver(event => {
    sessionTrace.recordModel(event);
    try { onModelEvent?.(event); } catch { /* 观测附加动作绝不影响业务 */ }
  });
  // 服务事件：有会话身份的直接归属该会话；没有身份的维护调用不伪造会话文件。
  const recordServiceEvent = namespace => event => {
    const sessionId = event?.sessionId || event?.listeningSessionId || null;
    if (sessionId) sessionTrace.recordScoped(sessionId, { type: 'service_event', namespace, event });
    else trace(`[${namespace}] ${JSON.stringify(event)}`);
  };
  // 删除聊天后清理它的诊断副本；旧记录不会被迟到写入重建。清理失败如实告警但不回滚删除。
  const onRoomDeleted = sessionId => {
    Promise.resolve(sessionTrace.deleteSession(sessionId)).catch(error =>
      logger?.warn?.('[session-trace] 会话记录清理失败，可能残留本地副本：', error?.message || 'unknown'));
  };
  return { store, sessionTrace, recordServiceEvent, onRoomDeleted };
}

/**
 * 串词真正播放时的入账 + 记录（组合根行数守卫）：先写执行事实，再把 intro turn 广播给
 * 播放器协议；记录失败不影响入账。
 */
export function recordTrackIntroTurn({ sessionTrace = null, conversationStore, queueService, publish,
  snapshot, event, track } = {}) {
  sessionTrace?.recordScoped?.(snapshot.activeListeningSessionId, { type: 'track_narration_started',
    queueItemId: event.queueItemId, correlationId: event.correlationId,
    virtualPersonId: track.virtualPersonId || 'lunara', songId: track.songId,
    source: track.source, text: track.narration.text });
  const turn = conversationStore.recordTrackIntro({ sessionId: snapshot.activeListeningSessionId,
    personId: track.virtualPersonId || 'lunara', correlationId: event.correlationId,
    queueItemId: event.queueItemId, text: track.narration.text, track });
  if (!turn) return null;
  publish({ type: 'queue-update', ...queueService.snapshot(), conversationId: turn.sessionId,
    messages: [{ say: turn.visibleText, sourceTurnId: turn.turnId, virtualPersonId: turn.speakerVirtualPersonId,
      sequence: turn.sequence, presentation: turn.message.presentation,
      queueItemId: turn.message.queueItemId || event.queueItemId, tracks: turn.message.tracks }] });
  return turn;
}

export default createSessionTraceWiring;
