// clientPresence.js — 把「这个窗口看得见吗、有没有在输入」告诉服务端（add-app-open-greeting D1）。
//
// 只发两个布尔值 { type: 'client-presence', visible, typing }，不带草稿内容、不带正在看的聊天。
// 服务端据此判断「离开一阵后回来了」（打招呼的边沿），以及你开始打字时让问候作废。
// 连上时补发一次当前状态；之后只在变化时发。没连上就丢弃，下次连上再补。
//
// Python 伪代码：
//   def report(force=False):
//       state = (document.visibility_state != 'hidden', bool(input.value.strip()))
//       if (force or state != last) and socket.open: socket.send(client_presence(*state)); last = state
const OPEN = 1;

export function createClientPresence({ getSocket, documentLike = globalThis.document, input = null } = {}) {
  if (typeof getSocket !== 'function') throw new TypeError('client presence requires getSocket()');
  const cleanups = [];
  let last = null;

  const current = () => ({
    visible: documentLike?.visibilityState !== 'hidden',
    typing: String(input?.value ?? '').trim().length > 0,
  });

  function report({ force = false } = {}) {
    const state = current();
    const key = `${state.visible}:${state.typing}`;
    if (!force && key === last) return false;
    const socket = getSocket();
    if (!socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify({ type: 'client-presence', ...state }));
    } catch {
      return false;
    }
    last = key;
    return true;
  }

  function listen(element, type) {
    if (!element?.addEventListener) return;
    const listener = () => { report(); };
    element.addEventListener(type, listener);
    cleanups.push(() => element.removeEventListener(type, listener));
  }

  return Object.freeze({
    init() {
      if (cleanups.length) return;
      listen(documentLike, 'visibilitychange');
      // 输入框清空（回车发送）不触发 input 事件，所以 keyup/blur 也看一眼。
      for (const type of ['input', 'keyup', 'blur']) listen(input, type);
    },
    /** WebSocket 连上（含重连）时调用：补发当前状态。 */
    connected: () => report({ force: true }),
    report,
    destroy() {
      while (cleanups.length) cleanups.pop()();
    },
  });
}

export default createClientPresence;
