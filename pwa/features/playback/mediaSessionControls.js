/**
 * 硬件媒体键的唯一入口：键盘上的上一首/播放暂停/下一首键（F7/F8/F9 这类系统键位、
 * 外接键盘的 Fn 组合、耳机线控按钮）。
 *
 * 它们**不是页面的 keydown 事件**——操作系统把它们当作媒体会话动作交给正在出声的
 * 页面。不注册处理器时浏览器只会自己把 `<audio>` 暂停/播放（绕过 runtime，播放器
 * 显示暂停但 runtime 仍以为在播），而 `nexttrack`/`previoustrack` 根本没有默认动作，
 * 所以「切歌键按了没反应」。注册之后三条动作都回到和播放条按钮同一批函数。
 */

/** 媒体会话动作 → 注入的 handler 名。键是 W3C 动作名，不是键盘按键。 */
const ACTION_HANDLERS = Object.freeze({
  play: 'play',
  pause: 'pause',
  nexttrack: 'next',
  previoustrack: 'previous',
});

export function createMediaSessionControls({
  mediaSessionLike = globalThis.navigator?.mediaSession,
  MediaMetadataImpl = globalThis.MediaMetadata,
  handlers = {},
} = {}) {
  const installed = [];
  const unsupported = [];
  for (const [action, key] of Object.entries(ACTION_HANDLERS)) {
    const handler = handlers[key];
    if (typeof handler !== 'function') continue;
    // 单个动作类型不被支持时只影响那一个键，不能拿掉其余媒体键。
    try {
      mediaSessionLike.setActionHandler(action, event => handler(event));
      installed.push(action);
    } catch {
      unsupported.push(action);
    }
  }

  let lastSignature = null;

  /**
   * 把播放器这一刻的身份与状态交给系统（锁屏、媒体中心、媒体键归属）。
   * `playbackState` 决定系统发来的是 play 还是 pause，所以必须来自 runtime 事实。
   */
  function setNowPlaying({ track = null, playing = false, artwork = '' } = {}) {
    if (!mediaSessionLike) return;
    try { mediaSessionLike.playbackState = track ? (playing ? 'playing' : 'paused') : 'none'; } catch { /* 只读环境忽略 */ }
    if (!track) { lastSignature = null; return; }
    const signature = [track.kind || '', track.title || '', track.artist || '', track.album || '', artwork].join('\u0000');
    if (signature === lastSignature) return;
    lastSignature = signature;
    if (typeof MediaMetadataImpl !== 'function') return;
    try {
      mediaSessionLike.metadata = new MediaMetadataImpl({
        title: track.title || '',
        artist: track.artist || '',
        album: track.album || '',
        artwork: artwork ? [{ src: artwork }] : [],
      });
    } catch { /* 元数据只影响系统显示，失败不影响媒体键 */ }
  }

  function destroy() {
    for (const action of installed.splice(0)) {
      try { mediaSessionLike.setActionHandler(action, null); } catch { /* 忽略清理失败 */ }
    }
  }

  return Object.freeze({
    setNowPlaying,
    destroy,
    installedActions: () => [...installed],
    unsupportedActions: () => [...unsupported],
  });
}
