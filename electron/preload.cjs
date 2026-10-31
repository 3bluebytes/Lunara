// electron/preload.cjs — 桌面壳与渲染层之间唯一的窄通道。
//
// 这里是仓库里唯一一处 contextBridge：只暴露「发布播放状态」和「接收托盘命令」，
// 渲染层拿不到 ipcRenderer、Node 模块或任意 invoke。沙箱预加载必须是 CJS，
// 所以文件扩展名是 .cjs（package.json 是 type: module）。
const { contextBridge, ipcRenderer } = require('electron');

const STATE_CHANNEL = 'lunara:tray-state';
const COMMAND_CHANNEL = 'lunara:tray-command';

contextBridge.exposeInMainWorld('lunaraDesktop', {
  platform: process.platform,
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
