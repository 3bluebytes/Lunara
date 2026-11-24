import { wireRuntimeState } from '../playback/playbackRuntimeTypes.js';
import { WebSocket, WebSocketServer } from 'ws';
import { localRequestAllowed } from '../http/requestBoundary.js';

function asMessage(factory, fallback) {
  if (typeof factory !== 'function') return fallback;
  const value = factory();
  return value && typeof value === 'object' ? value : fallback;
}

export class WebSocketHub {
  constructor(options = {}) {
    this.path = options.path || '/stream';
    this.hello = options.hello || (() => ({ type: 'hello', name: 'Lunara' }));
    this.queueSnapshot = options.queueSnapshot || (() => ({ queue: [], cursor: -1 }));
    this.runtimeSnapshot = options.runtimeSnapshot || null;
    this.runtimeCommands = options.runtimeCommands || null;
    // 本地边界：配了就必须在握手阶段通过（HTTP 守卫不覆盖 upgrade 路径）。
    this.localBoundary = options.localBoundary || null;
    this.lastRejection = null;
    this.WebSocketServerClass = options.WebSocketServerClass || WebSocketServer;
    this.onError = typeof options.onError === 'function'
      ? options.onError
      : error => console.warn('[ws] server error:', error?.message || error);
    this.clients = new Set();
    // 在线客户端数变化的订阅者（陪伴心跳据此判断「app 开着」）；订阅者异常不影响连接。
    this.clientListeners = new Set();
    // 各连接上报的 client-presence（只有可见与是否正在输入两个布尔值）；没上报过的按「可见、没在输入」。
    this.clientPresence = new Map();
    this.presenceListeners = new Set();
    this.wss = null;
    this.attached = false;
    this.lastError = null;
  }

  get clientCount() {
    return this.clients.size;
  }

  /** 订阅在线客户端数变化（连上/断开各一次）；返回取消订阅。 */
  onClientsChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this.clientListeners.add(listener);
    return () => this.clientListeners.delete(listener);
  }

  _notifyClients() {
    for (const listener of this.clientListeners) {
      try { listener(this.clients.size); } catch { /* 订阅者异常不影响连接 */ }
    }
    this._notifyPresence();
  }

  /** 在线客户端汇总：连接数、可见连接数、有没有人正在输入（「回来了」问候据此判断）。 */
  presenceSummary() {
    let visible = 0, typing = false, visibleActiveSessionId = null, fallbackActiveSessionId = null;
    for (const ws of this.clients) {
      const entry = this.clientPresence.get(ws);
      const isVisible = entry?.visible !== false;
      if (isVisible) visible += 1;
      if (entry?.typing === true) typing = true;
      if (entry?.activeSessionId) {
        if (isVisible && !visibleActiveSessionId) visibleActiveSessionId = entry.activeSessionId;
        else if (!fallbackActiveSessionId) fallbackActiveSessionId = entry.activeSessionId;
      }
    }
    const activeSessionId = visibleActiveSessionId || fallbackActiveSessionId;
    return {
      connected: this.clients.size,
      visible,
      typing,
      ...(activeSessionId ? { activeSessionId } : {}),
    };
  }

  /** 订阅客户端汇总变化（连上/断开/上报）；返回取消订阅。 */
  onPresenceChanged(listener) {
    if (typeof listener !== 'function') return () => {};
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  _notifyPresence(idleReturn = null) {
    if (!this.presenceListeners.size) return;
    const summary = this.presenceSummary();
    const payload = idleReturn ? { ...summary, idleReturn: { ...idleReturn } } : summary;
    for (const listener of this.presenceListeners) {
      try { listener({ ...payload }); } catch { /* 订阅者异常不影响连接 */ }
    }
  }

  // 客户端上行消息：client-presence { visible, typing, activeSessionId?, idleReturn? }。其余内容一律忽略，不回显、不记录正文。
  _receive(ws, raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message?.type !== 'client-presence' || typeof message.visible !== 'boolean') return;
    const previous = this.clientPresence.get(ws);
    let activeSessionId = null;
    if (typeof message.activeSessionId === 'string') {
      const trimmed = message.activeSessionId.trim().slice(0, 128);
      if (trimmed) activeSessionId = trimmed;
    } else if (message.activeSessionId === undefined && previous?.activeSessionId) {
      activeSessionId = previous.activeSessionId;
    }
    this.clientPresence.set(ws, {
      visible: message.visible,
      typing: message.typing === true,
      ...(activeSessionId ? { activeSessionId } : {}),
    });
    let idleReturn = null;
    if (message.visible === true && message.typing !== true && message.idleReturn && typeof message.idleReturn === 'object') {
      const awayMs = Number(message.idleReturn.awayMs);
      if (Number.isFinite(awayMs) && awayMs > 0) {
        const rawSessionId = typeof message.idleReturn.sessionId === 'string'
          ? message.idleReturn.sessionId.trim().slice(0, 128)
          : '';
        const sessionId = rawSessionId || activeSessionId || null;
        const firedAtMs = Number(message.idleReturn.firedAtMs);
        idleReturn = {
          ...(sessionId ? { sessionId } : {}),
          awayMs,
          ...(Number.isFinite(firedAtMs) && firedAtMs > 0 ? { firedAtMs } : {}),
        };
      }
    }
    this._notifyPresence(idleReturn);
  }

  attach(server) {
    if (!server || typeof server.on !== 'function') {
      throw new TypeError('WebSocketHub.attach requires an HTTP server');
    }
    if (this.attached) throw new Error('WebSocketHub is already attached');

    this.wss = new this.WebSocketServerClass({
      server,
      path: this.path,
      // 客户端只上行很小的 client-presence；超大帧直接断开。
      maxPayload: 4096,
      ...(this.localBoundary ? { verifyClient: info => this._authorizeUpgrade(info) } : {}),
    });
    // When the underlying HTTP server cannot bind, `ws` mirrors that failure
    // as an `error` event. Owning the listener here lets startRuntime report
    // and clean up the original listen failure instead of Node hard-crashing.
    this.wss.on('error', error => {
      this.lastError = error;
      this.onError(error);
    });
    this.wss.on('connection', ws => {
      this.clients.add(ws);
      ws.once('close', () => {
        this.clientPresence.delete(ws);
        if (this.clients.delete(ws)) this._notifyClients();
      });
      ws.on?.('message', raw => this._receive(ws, raw));

      this._send(ws, asMessage(this.hello, { type: 'hello', name: 'Lunara' }));
      this._send(ws, {
        type: 'queue-update',
        ...asMessage(this.queueSnapshot, { queue: [], cursor: -1 }),
      });

      if (this.runtimeSnapshot) {
        const state = this.runtimeSnapshot();
        if (state) {
          this._send(ws, { type: 'runtime-state', state: wireRuntimeState(state) });
          const commands = this.runtimeCommands?.(state) || [];
          for (const command of commands) this._send(ws, { type: 'runtime-command', command });
        }
      }
      this._notifyClients();
    });
    this.attached = true;
    return this;
  }

  /**
   * 握手阶段拒绝非法 upgrade：必须在发出任何消息之前返回 false。
   * 与 HTTP 共用同一条 Host/Origin 规则，不另造一套本地判定。
   */
  _authorizeUpgrade({ req, origin } = {}) {
    const headers = req?.headers || {};
    const verdict = localRequestAllowed(
      { host: headers.host, origin: origin ?? headers.origin },
      { bindHost: this.localBoundary?.bindHost },
    );
    if (!verdict.ok) {
      this.lastRejection = verdict.reason;
      this.onError?.(Object.assign(
        new Error(`[ws] upgrade rejected: ${verdict.reason}`), { code: 'WS_UPGRADE_REJECTED', reason: verdict.reason },
      ));
      return false;
    }
    return true;
  }

  _send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  broadcast(message) {
    let sent = 0;
    for (const ws of this.clients) {
      if (this._send(ws, message)) sent += 1;
    }
    return sent;
  }

  async close() {
    if (!this.wss) {
      this.attached = false;
      this.clients.clear();
      return;
    }

    for (const ws of this.clients) {
      try { ws.terminate(); } catch { /* best-effort client cleanup */ }
    }
    this.clients.clear();
    this.clientPresence.clear();

    const wss = this.wss;
    this.wss = null;
    this.attached = false;
    await new Promise((resolve, reject) => {
      wss.close(error => error ? reject(error) : resolve());
    });
  }
}
