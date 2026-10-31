import { STORAGE_KEYS } from '../../core/storageKeys.js';

const NOOP = () => {};

/**
 * 默认播放源候选来自服务端源注册表（`options.source` 里 ready 的可播源），
 * 前端不再维护第二份名单：新增音乐源时不需要同时改这里。
 */
function playableSources(settings) {
  const options = settings?.options?.source;
  if (!Array.isArray(options)) return null; // 没有快照时不做判断，交给下游的 source 校验
  return new Set(options.filter(option => option.ready === true).map(option => option.id));
}

function sessionHasQueue(session) {
  return Boolean(session && ((Array.isArray(session.queue) && session.queue.length)
    || session.currentSongId != null || session.lastOutputTrack));
}

/** A persisted cursor/queue is authoritative; never replace it with a first-run program. */
export function hasRecoverableListeningState(runtime) {
  if (!runtime) return false;
  if (sessionHasQueue(runtime)) return true;
  return Object.values(runtime.suspendedSessions || {}).some(sessionHasQueue);
}

export function firstRunReadiness({ settings, auth } = {}) {
  const current = settings?.current || settings || {};
  const allowed = playableSources(settings);
  const configured = allowed ? allowed.has(current.primarySource) : Boolean(current.primarySource);
  const source = configured ? current.primarySource : null;
  if (current.llm?.ready !== true) return { ready: false, missing: 'llm', source };
  if (!source) return { ready: false, missing: 'source-settings', source: null };
  // 已保存过凭据（cookieStored）即使此刻登录态核验失败（上游故障/离线），
  // 也不算「未连接音乐源」：把用户困在首启设置后面比让它稍后播放失败更糟，
  // 播放失败有自己的提示与重试路径。
  const login = auth?.[source] || {};
  const connected = login.loggedIn === true || login.cookieStored === true;
  if (!connected) return { ready: false, missing: 'source-login', source };
  return { ready: true, source };
}

export function canDismissRequiredSetup({ status, settings, auth } = {}) {
  if (!['started', 'returning-session', 'completed', 'autoplay-blocked'].includes(status?.kind)) return false;
  return firstRunReadiness({ settings, auth }).ready;
}

function rootRoom(rooms) {
  const available = (Array.isArray(rooms) ? rooms : []).filter(room => !room.archivedAt);
  return available.find(room => room.sessionId === 'conversation:primary')
    || available.find(room => room.memberIds?.includes('lunara') && room.activeVirtualPersonId === 'lunara')
    || null;
}

export function createFirstRunCoordinator({
  storage = globalThis.localStorage,
  store,
  requestDefaultMusic,
  focusRoot = NOOP,
  onSetupRequired = NOOP,
  onState = NOOP,
  requestIdFactory = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}:${Math.random().toString(36).slice(2)}`,
  playbackRuntimeClient = null,
} = {}) {
  if (!store?.getState || typeof requestDefaultMusic !== 'function') {
    throw new TypeError('first-run store and request operation are required');
  }

  let inFlight = null;
  let status = Object.freeze({ kind: 'idle' });
  let startedSessionId = null;
  let startedRequestId = null;
  let autoplayBlocked = false;
  let blockedQueueItemId = null;

  function stableRequestId() {
    if (startedRequestId) return startedRequestId;
    let saved = null;
    try { saved = storage?.getItem?.(STORAGE_KEYS.firstRunRequestId); } catch {}
    if (saved) return startedRequestId = saved;
    if (!storage?.getItem || !storage?.setItem) return null;
    const candidate = `first-run:${requestIdFactory()}`;
    try { storage?.setItem?.(STORAGE_KEYS.firstRunRequestId, candidate); } catch {}
    try { saved = storage?.getItem?.(STORAGE_KEYS.firstRunRequestId); } catch {}
    return startedRequestId = saved === candidate ? candidate : null;
  }

  function publish(kind, details = {}) {
    status = Object.freeze({ kind, ...details });
    onState(status);
    return status;
  }

  async function run(bootstrap = {}) {
    const runtime = Object.hasOwn(bootstrap, 'runtime') ? bootstrap.runtime : store.getState().runtimeState;
    let completed = null;
    try { completed = storage?.getItem?.(STORAGE_KEYS.firstRunCompleted) ?? null; }
    catch { return publish('bootstrap-unavailable', { reason: 'storage-unavailable' }); }
    if (completed === '1') return publish('completed');

    // Starting music requires a complete, successful bootstrap. Failed health,
    // settings, or runtime reads are not evidence that the install is empty.
    if (!runtime || !Array.isArray(runtime.queue) || !bootstrap.settings || !bootstrap.auth) {
      return publish('bootstrap-unavailable', { reason: 'incomplete-bootstrap' });
    }

    if (hasRecoverableListeningState(runtime)) {
      storage?.setItem?.(STORAGE_KEYS.firstRunCompleted, '1');
      return publish('returning-session', { sessionId: runtime.activeListeningSessionId || null });
    }

    const readiness = firstRunReadiness({ settings: bootstrap.settings, auth: bootstrap.auth });
    if (!readiness.ready) {
      const state = publish('needs-setup', { missing: readiness.missing, source: readiness.source });
      onSetupRequired(state);
      return state;
    }

    const room = rootRoom(bootstrap.rooms);
    if (!room) return publish('root-unavailable');

    await focusRoot(room.sessionId);
    const id = stableRequestId();
    if (!id) return publish('bootstrap-unavailable', { reason: 'idempotency-unavailable' });
    startedSessionId = room.sessionId;
    startedRequestId = id;
    autoplayBlocked = false;
    blockedQueueItemId = null;
    publish('requesting', { sessionId: room.sessionId });

    try {
      const result = await requestDefaultMusic({
        sessionId: room.sessionId,
        requestId: id,
        mode: 'discovery',
        delivery: 'replace_now',
        count: 2,
      });
      if (!result || result.ok !== true) {
        return publish('request-failed', { sessionId: room.sessionId, code: result?.code || 'UNKNOWN' });
      }
      storage?.setItem?.(STORAGE_KEYS.firstRunCompleted, '1');
      return publish(autoplayBlocked ? 'autoplay-blocked' : 'started', { sessionId: room.sessionId });
    } catch {
      // Keep the request id. A reload/retry must consult the server receipt
      // under the same key instead of starting a second program.
      return publish('request-failed', { sessionId: room.sessionId, code: 'REQUEST_UNCONFIRMED' });
    }
  }

  function start(bootstrap) {
    if (inFlight) return inFlight;
    if (status.kind === 'completed' || status.kind === 'returning-session' || status.kind === 'started') {
      return Promise.resolve(status);
    }
    inFlight = run(bootstrap).finally(() => { inFlight = null; });
    return inFlight;
  }

  function handleAutoplayBlocked(error, command) {
    if (error?.name !== 'NotAllowedError' || !startedSessionId
      || !['requesting', 'started', 'retrying', 'autoplay-blocked'].includes(status.kind)) return false;
    const runtime = store.getState().runtimeState;
    const index = Number.isInteger(runtime?.currentIndex) ? runtime.currentIndex : -1;
    const current = runtime?.queue?.[index];
    if (runtime?.activeListeningSessionId !== startedSessionId || !current) return false;
    if (command?.listeningSessionId && command.listeningSessionId !== startedSessionId) return false;
    if (command?.queueItemId && current.queueItemId !== command.queueItemId) return false;
    if (command?.correlationId && runtime?.txn?.correlationId !== command.correlationId) return false;
    if (command?.songId && String(current.songId ?? current.song_id) !== String(command.songId)) return false;
    autoplayBlocked = true;
    blockedQueueItemId = current.queueItemId || command?.queueItemId || null;
    publish('autoplay-blocked', { sessionId: startedSessionId });
    return true;
  }

  async function startPreparedPlayback() {
    if (!autoplayBlocked || !startedSessionId || typeof playbackRuntimeClient?.retry !== 'function') return false;
    const runtime = store.getState().runtimeState;
    const index = Number.isInteger(runtime?.currentIndex) ? runtime.currentIndex : -1;
    const current = runtime?.queue?.[index];
    if (runtime?.activeListeningSessionId !== startedSessionId || !current
      || (blockedQueueItemId && current.queueItemId !== blockedQueueItemId)) {
      autoplayBlocked = false;
      blockedQueueItemId = null;
      publish('started', { sessionId: startedSessionId });
      return false;
    }
    autoplayBlocked = false;
    publish('retrying', { sessionId: startedSessionId });
    try {
      await playbackRuntimeClient.retry();
      if (autoplayBlocked) return false;
      blockedQueueItemId = null;
      publish('started', { sessionId: startedSessionId });
      return true;
    } catch {
      autoplayBlocked = true;
      publish('autoplay-blocked', { sessionId: startedSessionId });
      return false;
    }
  }

  return Object.freeze({
    start,
    init: start,
    handleAutoplayBlocked,
    startPreparedPlayback,
    getSnapshot: () => status,
    getRequestId: () => startedRequestId || storage?.getItem?.(STORAGE_KEYS.firstRunRequestId) || null,
  });
}
