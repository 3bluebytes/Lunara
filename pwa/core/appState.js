const DEFAULT_STATE = Object.freeze({
  queue: Object.freeze([]),
  cursor: -1,
  activeRadiohost: null,
  virtualPersons: Object.freeze([]),
  sessionId: 'conversation:primary',
  runtimeState: null,
});

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(cloneAndFreeze));
  }
  if (isPlainObject(value)) {
    const clone = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = cloneAndFreeze(nested);
    }
    return Object.freeze(clone);
  }
  return value;
}

function sameTopLevelValues(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.is(left[key], right[key]));
}

function normalizeQueueCursor(cursor, queueLength) {
  if (!Number.isInteger(cursor) || cursor < 0 || queueLength === 0) return -1;
  return Math.min(cursor, queueLength - 1);
}

/** The shared read-only projection for both the queue and current-track presentation. */
export function projectRuntimeQueueItem(snapshot, index = snapshot?.currentIndex) {
  const track = snapshot?.queue?.[index];
  if (!track) return null;
  return {
    kind: 'track',
    queueItemId: track.queueItemId,
    queue_item_id: track.queueItemId,
    song_id: track.songId,
    title: track.title,
    artist: track.artist,
    album: track.album || '',
    duration: Number(track.duration) || 0,
    url: track.url,
    pic_url: track.artwork || null,
    lyric: track.lyric || null,
    source: track.source || '',
    intro: track.intro?.ttsUrl ? {
      url: track.intro.ttsUrl,
      text: track.intro.text || '',
      correlationId: snapshot.txn?.songId === track.songId
        ? snapshot.txn.correlationId
        : null,
      songId: track.songId,
      programId: track.programId,
      requestId: track.requestId,
    } : null,
    programId: track.programId,
    program_id: track.programId,
    requestId: track.requestId,
    status: index < snapshot.currentIndex
      ? 'played'
      : index === snapshot.currentIndex ? 'playing' : 'upcoming',
  };
}

function projectRuntimeQueue(snapshot) {
  if (!Array.isArray(snapshot?.queue)) return [];
  return snapshot.queue.map((_track, index) => projectRuntimeQueueItem(snapshot, index));
}

/**
 * Small immutable store for state shared across otherwise independent browser
 * features. Feature-local animation/audio objects deliberately stay outside of
 * this store; queue and active-radiohost state do not.
 */
export function createAppState(initialState = {}) {
  let state = cloneAndFreeze({ ...DEFAULT_STATE, ...initialState });
  const listeners = new Set();

  function getState() {
    return state;
  }

  function update(change, action = { type: 'state.updated' }) {
    const patch = typeof change === 'function' ? change(state) : change;
    if (patch === state || patch == null) return state;
    if (!isPlainObject(patch)) {
      throw new TypeError('app state update must return an object');
    }

    const candidate = { ...state, ...patch };
    if (sameTopLevelValues(state, candidate)) return state;

    const previous = state;
    state = cloneAndFreeze(candidate);
    for (const listener of [...listeners]) {
      listener(state, previous, action);
    }
    return state;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('app state subscriber must be a function');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({ getState, update, subscribe });
}

/**
 * Apply server-owned state transitions before feature listeners render them.
 * Unknown event types are intentionally ignored.
 */
export function reduceServerMessage(store, message) {
  if (!store || typeof store.update !== 'function' || !message || typeof message !== 'object') {
    return store?.getState?.();
  }

  switch (message.type) {
    case 'queue-update':
      // Compatibility messages also carry chat/intro presentation, which the WS
      // consumer still receives. They must not become a second playback writer
      // once a complete runtime queue exists, even if their version is newer.
      if (Array.isArray(store.getState().runtimeState?.queue)) return store.getState();
      return store.update(current => {
        const queue = Array.isArray(message.queue) ? message.queue : current.queue;
        return { queue, cursor: normalizeQueueCursor(message.cursor, queue.length) };
      }, { type: 'server.queue-updated', source: message.type });

    case 'RADIOHOST_ACTIVATED': {
      const sid = message.conversationId || message.sessionId || message.payload?.conversationId;
      if (sid !== store.getState().sessionId || !message.payload?.active) return store.getState();
      return store.update({ activeRadiohost: message.payload.active }, { type: 'server.radiohost-activated' });
    }

    case 'runtime-state': {
      const runtimeState = message.state ?? null;
      // A listeningSnapshot also has a queue, but lacks the global version and
      // active-source identity. Never let that scoped projection replace runtime.
      if (!runtimeState || !Array.isArray(runtimeState.queue)
        || !Number.isInteger(runtimeState.version) || runtimeState.version < 0) return store.getState();
      if (runtimeState.version < store.getState().runtimeState?.version) return store.getState();
      return store.update({
        runtimeState,
        queue: projectRuntimeQueue(runtimeState),
        cursor: normalizeQueueCursor(runtimeState.currentIndex, runtimeState.queue.length),
      }, {
        type: 'server.playback-runtime-state',
        source: message.type,
      });
    }

    default:
      return store.getState();
  }
}
