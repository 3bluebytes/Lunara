// electron/preload.cjs — 桌面壳与渲染层之间唯一的窄通道。
//
// 这里是仓库里唯一一处 contextBridge：只暴露「发布播放状态」和「接收托盘命令」，
// 渲染层拿不到 ipcRenderer、Node 模块或任意 invoke。沙箱预加载必须是 CJS，
// 所以文件扩展名是 .cjs（package.json 是 type: module）。
const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'lunara:tray-state';
const COMMAND_CHANNEL = 'lunara:tray-command';
const WINDOW_CONTROL_CHANNEL = 'lunara:window-control';
const WINDOW_MAXIMIZED_CHANNEL = 'lunara:window-maximized';

contextBridge.exposeInMainWorld('lunaraDesktop', {
  platform: process.platform,
  win: {
    /** 自绘窗控（frame:false）专用的窄通道；主进程侧有同源窗口校验。 */
    minimize() { ipcRenderer.send(WINDOW_CONTROL_CHANNEL, 'minimize'); },
    toggleMaximize() { ipcRenderer.send(WINDOW_CONTROL_CHANNEL, 'toggle-maximize'); },
    close() { ipcRenderer.send(WINDOW_CONTROL_CHANNEL, 'close'); },
    /** 主进程 → 渲染层：最大化状态变化（切换最大化/还原图标）。返回取消订阅。 */
    onMaximizeChange(listener) {
      const handler = (_event, maximized) => { listener(maximized); };
      ipcRenderer.on(WINDOW_MAXIMIZED_CHANNEL, handler);
      return () => ipcRenderer.removeListener(WINDOW_MAXIMIZED_CHANNEL, handler);
    },
  },
  tray: {
    isAvailable: true,
    /** 渲染层 → 主进程：当前播放身份与状态（主进程只用于展示）。 */
    publishState(state) {
      ipcRenderer.send(STATE_CHANNEL, state);
    },
    /** 主进程 → 渲染层：托盘点下的动作（toggle / previous / next）。返回取消订阅。 */
    onCommand(listener) {
      const handler = (_event, command) => { listener(command); };
      ipcRenderer.on(COMMAND_CHANNEL, handler);
      return () => ipcRenderer.removeListener(COMMAND_CHANNEL, handler);
    },
  },
});
