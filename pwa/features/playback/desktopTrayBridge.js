/**
 * 渲染层 → 桌面托盘的桥。
 *
 * 只在桌面壳里存在（`window.lunaraDesktop`，由 electron/preload.cjs 经 contextBridge
 * 暴露）；普通浏览器里没有它，这里返回 null，调用方据此跳过全部托盘行为。
 *
 * 托盘命令必须回落到播放条按钮那批同一批函数（toggle/previous/next），
 * 不直接操作媒体元素、不新建播放状态。
 */

const noop = () => {};

export function createDesktopTrayBridge({ desktopLike = null, handlers = {} } = {}) {
  const tray = desktopLike?.tray;
  if (!tray || typeof tray.publishState !== 'function' || typeof tray.onCommand !== 'function') return null;

  const commandHandlers = {
    toggle: handlers.toggle,
    previous: handlers.previous,
    next: handlers.next,
  };
  let unsubscribe = tray.onCommand(command => {
    const handler = commandHandlers[command];
    if (typeof handler === 'function') handler();
  });

  let lastSignature = null;

  /**
   * 推送当前状态。只有构成托盘的字段变了才过线：runtime 广播很频繁，
   * 每次都发会让主进程不停重建菜单。
   */
  function publish(state) {
    const signature = [
      state?.title || '', state?.artist || '',
      state?.playing === true ? 'playing' : 'paused',
      state?.canPrevious === true ? 'prev' : 'first',
      // 菜单栏文字可以是曲名或歌词行：模式与歌词行都必须进入签名，
      // 否则「用户切到歌词」和「歌词换行」都会被去重吞掉。
      state?.textMode === 'lyrics' ? 'lyrics' : 'title',
      state?.subtitle || '',
      // 扫色进度按 2 位小数进签名：每帧都要过线不现实，但每 ~1% 刷新一次足够让主进程
      // 的插值锚点保持新鲜；同一句内进度不变时不重复过线。
      Number.isFinite(state?.subtitleProgress) ? (state.subtitleProgress).toFixed(2) : '',
      Number.isFinite(state?.subtitleSpanMs) ? String(Math.round(state.subtitleSpanMs)) : '',
    ].join('\u0000');
    if (signature === lastSignature) return false;
    lastSignature = signature;
    try { tray.publishState(state); } catch { return false; }
    return true;
  }

  return Object.freeze({
    publish,
    destroy() {
      try { unsubscribe?.(); } catch { /* 窗口已在销毁中，忽略 */ }
      unsubscribe = noop;
      lastSignature = null;
    },
  });
}
