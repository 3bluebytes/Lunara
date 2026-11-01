// electron/main.js — Lunara 桌面壳
// 启动 Express 服务端，再开一个干净的 BrowserWindow。

import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, session } from 'electron';
import { resolve, dirname } from 'path';
// Windows 下动态 import() 必须用 file:// URL：
// `D:\\...` 会被 ESM loader 当成 `d:` 协议报 ERR_UNSUPPORTED_ESM_URL_SCHEME（macOS 的 /posix 路径无此问题）。
import { pathToFileURL, fileURLToPath } from 'url';
import { DESKTOP_WINDOW_BOUNDS } from './windowBounds.js';
import { installElectronShutdown } from './shutdown.js';
import { acquireSingleInstance } from './singleInstance.js';
import { createDesktopTray } from './tray.js';
import { createLyricCanvas } from './lyricCanvas.js';

// 允许无用户操作的自动播放（自动续播）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-http-cache');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// 应用图标（A01 珍珠月，scripts/generate-icons.mjs 从 A01 母版生成）：Windows/Linux 窗口图标 + macOS Dock 图标。
const APP_ICON = resolve(ROOT, 'pwa', 'icon.png');
// 托盘图标：macOS 用模板图（纯黑+alpha，随菜单栏明暗反相），Windows 用彩色图。
const TRAY_MAC_ICON = resolve(ROOT, 'pwa/assets/tray/menuTemplate.png');
const TRAY_WIN_ICON = resolve(ROOT, 'pwa/assets/tray/tray-win.png');
const PRELOAD = resolve(__dirname, 'preload.cjs');
// 桌面壳与渲染层之间只有这两个通道：状态上行、命令下行。
const TRAY_STATE_CHANNEL = 'lunara:tray-state';
const TRAY_COMMAND_CHANNEL = 'lunara:tray-command';
const PORT = parseInt(process.env.PORT || '8080', 10);
// 托盘排查用：LUNARA_TRAY_DEBUG=1 时把托盘状态/命令写到终端（默认静默）。
const TRAY_DEBUG = process.env.LUNARA_TRAY_DEBUG === '1';
const trayLog = (...parts) => { if (TRAY_DEBUG) console.log('[tray]', ...parts); };
// 启动看门狗：只做诊断记录，不改变启动行为；窗口创建成功即解除。
let lastBootStage = 'main.js evaluated';
const bootWatchdog = setTimeout(() => {
  console.warn(`[boot] 启动 30 秒仍未完成 — 最后完成阶段: ${lastBootStage}（窗口未出现时请带此日志反馈）`);
}, 30000);
bootWatchdog.unref?.();
let serverModule;
let serverStarting;
let booting;
let quitting = false;
installElectronShutdown(app, async () => {
  quitting = true;
  await serverStarting?.catch(() => {});
  await serverModule?.stop();
});

// 同一数据根只允许一个桌面进程：第二个实例聚焦既有窗口后退出。
// 必须在模块求值期申请（窗口创建之前），避免双进程同时初始化服务端。
const hasSingleInstance = acquireSingleInstance(app, {
  onSecondInstance: () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing) return;
    if (existing.isMinimized()) existing.restore();
    existing.focus();
  },
});
if (!hasSingleInstance) {
  // app.quit() 走 before-quit 的停机链；下面的 whenReady/activate 也必须让路，
  // 否则退出与启动会竞态出第二个服务端。
  app.quit();
}

// ---- 桌面托盘（macOS 菜单栏 / Windows 托盘） ----
// 只做展示与转发：播放状态由渲染层推送，命令回到渲染层的同一批传输函数。
let trayController = null;
// 菜单栏两色歌词的离屏渲染器（懒创建：只在真的用到歌词模式时才建窗口）。
let lyricCanvas = null;

function ensureLyricCanvas() {
  if (lyricCanvas) return lyricCanvas;
  lyricCanvas = createLyricCanvas({ BrowserWindow, nativeImage });
  return lyricCanvas;
}

function currentWindow() {
  return BrowserWindow.getAllWindows().find(win => !win.isDestroyed()) || null;
}

function sendTrayCommand(command) {
  const win = currentWindow();
  trayLog('command', command, win ? '→ window' : '(no window)');
  if (!win) return;
  win.webContents.send(TRAY_COMMAND_CHANNEL, command);
}

function showOrCreateWindow() {
  const win = currentWindow();
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  // macOS 关窗后进程仍在：托盘是把它重新叫回来的入口。
  void boot().catch(reportBootFailure);
}

function ensureTray() {
  if (trayController) return trayController;
  trayController = createDesktopTray({
    Tray,
    Menu,
    nativeImage,
    platform: process.platform,
    icons: { macTemplate: TRAY_MAC_ICON, windows: TRAY_WIN_ICON },
    // 菜单栏文字用「图像 + 扫色」渲染；明暗外观由 nativeTheme 决定配色。
    lyricCanvas: ensureLyricCanvas(),
    nativeTheme,
    onFrame: TRAY_DEBUG ? payload => trayLog('frame', JSON.stringify(payload)) : null,
    // 菜单栏标题文字是公共横向空间，可用 LUNARA_TRAY_TITLE=0 关掉；图标与菜单不受影响。
    showTitleText: process.env.LUNARA_TRAY_TITLE !== '0',
    actions: {
      toggle: () => sendTrayCommand('toggle'),
      previous: () => sendTrayCommand('previous'),
      next: () => sendTrayCommand('next'),
      show: showOrCreateWindow,
      quit: () => app.quit(),
    },
  });
  trayLog('ready', process.platform, trayController ? 'created' : 'unavailable');
  return trayController;
}

// 只认应用自己的窗口发来的状态；渲染层之外的任何页面都不能改写托盘。
function isAppWindow(event) {
  const url = event?.senderFrame?.url || '';
  return url.startsWith(`http://localhost:${PORT}`);
}

// 自绘窗控（frame:false，Windows）：渲染层的最小化/最大化/关闭经由这条窄通道。
// 用与托盘通道相同的 isAppWindow 校验，避免任意页面向窗口发指令。
const WINDOW_CONTROL_CHANNEL = 'lunara:window-control';
const WINDOW_MAXIMIZED_CHANNEL = 'lunara:window-maximized';
ipcMain.on(WINDOW_CONTROL_CHANNEL, (event, command) => {
  if (!isAppWindow(event)) return;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (command === 'minimize') win.minimize();
  else if (command === 'toggle-maximize') (win.isMaximized() ? win.unmaximize() : win.maximize());
  else if (command === 'close') win.close();
});

ipcMain.on(TRAY_STATE_CHANNEL, (event, state) => {
  if (!trayController || !isAppWindow(event)) return;
  trayController.setState(state);
  // macOS Tray 有 getTitle()：调试时把真正写进菜单栏的文字也打出来。
  trayLog('state', JSON.stringify(state), '→ 菜单栏文字:', JSON.stringify(trayController.tray?.getTitle?.() ?? null),
    '图像:', trayController.hasImage?.() === true);
});

// The primary product layout is the persistent listening + conversation split.
// Keep compact/mobile composition available when the user resizes the window,
// but do not launch every desktop session inside that breakpoint.
function boot() {
  if (!booting) booting = bootOnce().finally(() => { booting = null; });
  return booting;
}

async function bootOnce() {
  lastBootStage = 'bootOnce';
  // 导入与启动分开；退出时等启动收尾再释放服务端资源。
  lastBootStage = 'importing server module';
  serverStarting = (async () => {
    serverModule = await import(pathToFileURL(resolve(ROOT, 'server/index.js')).href);
    lastBootStage = 'server module imported';
    if (!quitting) await serverModule.start(PORT);
    lastBootStage = 'server started';
  })();
  await serverStarting;
  if (quitting) return;

  // 启动时清掉 service worker + http cache，避免本地开发反复被旧 SW 截胡。
  // 本地壳应用没必要走 SW 缓存，每次起干净环境最省心。
  try {
    await session.defaultSession.clearStorageData({
      storages: ['serviceworkers', 'cachestorage'],
    });
    await session.defaultSession.clearCache();
  } catch (e) {
    console.warn('[boot] cache clear failed (non-fatal):', e.message);
  }

  if (quitting) return;
  const win = new BrowserWindow({
    ...DESKTOP_WINDOW_BOUNDS,
    center: true,
    // macOS: hiddenInset（红绿灯内嵌）；Windows: hidden + titleBarOverlay ——
    // hiddenInset 在 Windows 不生效会回落到默认标题栏（上个世纪观感的来源），
    // 必须 hidden + overlay 才能得到融入主题的无边框窗口（Web 端 #drag-bar 已就绪）。
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' }
      : {
          // Windows: 彻底无框 + 自绘窗控（index.html #win-controls）。
          // 不用 titleBarOverlay：本机 Windows build 26200 上 WCO 按钮在部分窗口状态下不绘制（系统层 bug）。
          frame: false,
        }),
    backgroundColor: '#07050c',
    title: 'Lunara',
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 唯一的桥：只暴露托盘状态与托盘命令（见 preload.cjs）。
      preload: PRELOAD,
    },
  });

  // Windows: 去掉默认菜单栏（File/Edit/View… 是「上个世纪观感」的另一半）。
  // 菜单去掉后 DevTools 快捷键会失效，这里补回 F12 / Ctrl+Shift+I。
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const isF12 = input.key === 'F12';
      const isCtrlShiftI = input.control && input.shift && input.key.toLowerCase() === 'i';
      if (isF12 || isCtrlShiftI) {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
  }

  lastBootStage = 'creating window';
  clearTimeout(bootWatchdog);
  win.loadURL(`http://localhost:${PORT}?_=${Date.now()}`);

  // 最大化状态上行：渲染层用它在最大化 ⇄ 还原之间切换窗控图标。
  const pushMaximized = () => { if (!win.isDestroyed()) win.webContents.send(WINDOW_MAXIMIZED_CHANNEL, win.isMaximized()); };
  win.on('maximize', pushMaximized);
  win.on('unmaximize', pushMaximized);

  // 开发时设 LUNARA_DEVTOOLS=1 可开 DevTools。
  if (process.env.LUNARA_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

function reportBootFailure(error) {
  console.error('[boot] failed', error);
  // Finder 启动没有终端：关键失败必须用户可见，不能只写控制台。
  try {
    const detail = String(error?.stack || error?.message || error || '未知错误').split('\n').slice(0, 6).join('\n');
    dialog.showErrorBox('Lunara 启动失败', `${detail}\n\n（更多上下文请从终端启动查看完整日志）`);
  } catch { /* 无对话框环境（如测试替身）时保留 console.error */ }
  if (!quitting) app.quit();
}

app.whenReady().then(() => {
  if (!hasSingleInstance) return undefined;
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(APP_ICON); } catch (e) { console.warn('[boot] dock icon failed (non-fatal):', e.message); }
  }
  lastBootStage = 'whenReady (dock done)';
  // 托盘先于窗口：窗口创建慢或失败时，用户仍能看到应用在跑并能从托盘点开窗口。
  try { ensureTray(); } catch (error) { console.warn('[tray] init failed (non-fatal):', error?.message); }
  return boot();
}).catch(reportBootFailure);

app.on('will-quit', () => {
  trayController?.destroy();
  trayController = null;
  lyricCanvas?.destroy();
  lyricCanvas = null;
});

app.on('window-all-closed', () => {
  // macOS 上通常是点击窗口红点不退出
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  // macOS dock 点击：如果没有窗口就重新开一个
  if (!hasSingleInstance) return;
  if (BrowserWindow.getAllWindows().length === 0) void boot().catch(reportBootFailure);
});
