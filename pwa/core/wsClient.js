import { reduceServerMessage } from './appState.js';

function streamUrl(location) {
  const protocol = location?.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${location?.host}/stream`;
}

/**
 * Owns exactly one WebSocket and one reconnect timer. Server messages first
 * update authoritative state and are then forwarded to feature renderers.
 */
export function createWsClient({
  store,
  WebSocketImpl = globalThis.WebSocket,
  location = globalThis.location,
  onMessage = () => {},
  onOpen = () => {},
  onClose = () => {},
  onError = () => {},
  reconnectDelayMs = 1500,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelSchedule = timer => globalThis.clearTimeout(timer),
} = {}) {
  if (!store || typeof store.update !== 'function') throw new TypeError('app state store is required');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocket implementation is required');

  let socket = null;
  let reconnectTimer = null;
  let destroyed = false;

  function clearReconnect() {
    if (reconnectTimer == null) return;
    cancelSchedule(reconnectTimer);
    reconnectTimer = null;
  }

  function connect() {
    if (destroyed) return null;
    if (socket) return socket;
    clearReconnect();

    const current = new WebSocketImpl(streamUrl(location));
    socket = current;

    current.onopen = event => {
      if (socket !== current || destroyed) return;
      onOpen(event, current);
    };
    current.onmessage = event => {
      if (socket !== current || destroyed) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      reduceServerMessage(store, message);
      onMessage(message, event);
    };
    current.onerror = event => {
      if (socket === current && !destroyed) onError(event, current);
    };
    current.onclose = event => {
      if (socket !== current) return;
      socket = null;
      onClose(event, current);
      if (destroyed || reconnectTimer != null) return;
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        if (!destroyed) connect();
      }, reconnectDelayMs);
    };
    return current;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearReconnect();
    const current = socket;
    socket = null;
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      current.close?.();
    }
  }

  return Object.freeze({
    connect,
    destroy,
    getSocket: () => socket,
  });
}
