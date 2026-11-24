// 桌面托盘通道的契约测试：主进程与预加载必须使用同一组通道名，
// 且预加载只能经 contextBridge 暴露窄接口（这是仓库里唯一的 IPC 面）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = name => readFile(resolve(here, name), 'utf8');

const electronMocks = new Map();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      const tag = context.parentURL ? new URL(context.parentURL).search : '';
      return { url: `mock:electron${tag}`, shortCircuit: true };
    }
    if (specifier.endsWith('/server/index.js')) {
      return { url: 'mock:server', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('mock:electron')) {
      const key = new URL(url).search || 'default';
      globalThis.__electronMockRegistry = electronMocks;
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const mock = globalThis.__electronMockRegistry.get(${JSON.stringify(key)});
          export const app = mock.app;
          export const BrowserWindow = mock.BrowserWindow;
          export const Menu = mock.Menu;
          export const Tray = mock.Tray;
          export const dialog = mock.dialog;
          export const ipcMain = mock.ipcMain;
          export const nativeImage = mock.nativeImage;
          export const nativeTheme = mock.nativeTheme;
          export const powerMonitor = mock.powerMonitor;
          export const session = mock.session;
        `,
      };
    }
    if (url === 'mock:server') {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export async function start() {} export async function stop() {}',
      };
    }
    return nextLoad(url, context);
  },
});

function createElectronHarness({ withPowerMonitor = true } = {}) {
  const appListeners = new Map();
  const ipcListeners = new Map();
  const powerListeners = new Map();
  const windows = [];
  const trayRecords = { title: '', tooltip: '', image: null, menuTemplate: null, destroyed: false, captures: 0 };
  const templateIcon = { kind: 'template', isEmpty: () => false };
  const renderedIcon = { kind: 'lyric-bitmap', isEmpty: () => false, getSize: () => ({ width: 200, height: 22 }), getScaleFactors: () => [2] };

  let resolveReady;
  const readyPromise = new Promise(r => { resolveReady = r; });

  class FakeBrowserWindow {
    constructor(options = {}) {
      this.options = options;
      this.destroyed = false;
      this.offscreen = Boolean(options?.webPreferences?.offscreen);
      this.webContents = {
        on() {},
        send() {},
        openDevTools() {},
        toggleDevTools() {},
        async executeJavaScript(code) {
          if (code.includes('getBoundingClientRect')) return [200, 22];
          if (code.includes('LunaraLyric.measure')) return 120;
          return undefined;
        },
        async capturePage() {
          trayRecords.captures += 1;
          return { isEmpty: () => false, toPNG: () => Buffer.from([1, 2, 3]) };
        },
      };
      windows.push(this);
    }
    async loadURL() {}
    on() {}
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    destroy() { this.destroyed = true; }
  }
  FakeBrowserWindow.getAllWindows = () => windows.filter(w => !w.offscreen && !w.destroyed);
  FakeBrowserWindow.fromWebContents = () => windows[0] || null;

  class FakeTray {
    constructor(img) { trayRecords.image = img; }
    setTitle(value) { trayRecords.title = value; }
    getTitle() { return trayRecords.title; }
    setToolTip(value) { trayRecords.tooltip = value; }
    setImage(img) { trayRecords.image = img; }
    setContextMenu(menu) { trayRecords.menuTemplate = menu; }
    destroy() { trayRecords.destroyed = true; }
  }

  const powerMonitor = withPowerMonitor
    ? {
        on(event, fn) {
          if (!powerListeners.has(event)) powerListeners.set(event, new Set());
          powerListeners.get(event).add(fn);
        },
        removeListener(event, fn) {
          powerListeners.get(event)?.delete(fn);
        },
        emit(event) {
          for (const fn of powerListeners.get(event) || []) fn();
        },
        listenerCount() {
          let count = 0;
          for (const set of powerListeners.values()) count += set.size;
          return count;
        },
      }
    : {};

  return {
    trayRecords,
    templateIcon,
    renderedIcon,
    resolveReady,
    emitApp(event) {
      for (const fn of appListeners.get(event) || []) fn();
    },
    emitIpc(channel, event, payload) {
      for (const fn of ipcListeners.get(channel) || []) fn(event, payload);
    },
    mock: {
      app: {
        commandLine: { appendSwitch() {} },
        requestSingleInstanceLock: () => true,
        whenReady: () => readyPromise,
        on(event, fn) {
          if (!appListeners.has(event)) appListeners.set(event, new Set());
          appListeners.get(event).add(fn);
        },
        quit() {},
        dock: { setIcon() {} },
      },
      BrowserWindow: FakeBrowserWindow,
      Menu: { buildFromTemplate: template => template, setApplicationMenu() {} },
      Tray: FakeTray,
      dialog: { showErrorBox() {} },
      ipcMain: {
        on(channel, fn) {
          if (!ipcListeners.has(channel)) ipcListeners.set(channel, new Set());
          ipcListeners.get(channel).add(fn);
        },
      },
      nativeImage: {
        createFromPath: () => templateIcon,
        createFromBuffer: () => renderedIcon,
      },
      nativeTheme: { shouldUseDarkColors: true, on() {} },
      powerMonitor,
      session: { defaultSession: { async clearStorageData() {}, async clearCache() {} } },
    },
  };
}

test('the tray channels are the same on both sides of the bridge', async () => {
  const main = await read('main.js');
  const preload = await read('preload.cjs');
  for (const channel of ['lunara:tray-state', 'lunara:tray-command']) {
    assert.match(main, new RegExp(`['"]${channel}['"]`), `main.js 必须使用通道 ${channel}`);
    assert.match(preload, new RegExp(`['"]${channel}['"]`), `preload.cjs 必须使用通道 ${channel}`);
  }
});

test('the preload exposes only the narrow tray surface', async () => {
  const preload = await read('preload.cjs');
  assert.match(preload, /contextBridge\.exposeInMainWorld\(\s*'lunaraDesktop'/);
  assert.match(preload, /publishState/);
  assert.match(preload, /onCommand/);
  // 不允许把 ipcRenderer / require / Node 能力直接交给页面。
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/);
  assert.doesNotMatch(preload, /invoke\(/);
  assert.doesNotMatch(preload, /nodeIntegration/);
});

test('the main window keeps isolation and wires the tray once', async () => {
  const main = await read('main.js');
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /preload:\s*PRELOAD/);
  assert.match(main, /ipcMain\.on\(TRAY_STATE_CHANNEL/);
  // 状态通道必须校验来源，否则任意页面都能改写托盘。
  assert.match(main, /isAppWindow\(event\)/);
  assert.match(main, /trayController\?\.destroy\(\)/, '退出时必须销毁托盘');
  for (const eventName of ['suspend', 'lock-screen', 'resume', 'unlock-screen']) {
    assert.match(main, new RegExp(`['"]${eventName}['"]`), `main.js 必须接入 powerMonitor ${eventName}`);
  }
  assert.match(main, /cleanupPowerMonitor\?\.\(\)/, '退出时必须移除 powerMonitor 监听');
});

test('powerMonitor pauses high-frequency tray lyric sweeping on suspend/lock-screen and resumes on wake/unlock', async () => {
  const key = '?case=power-monitor';
  const harness = createElectronHarness({ withPowerMonitor: true });
  electronMocks.set(key, harness.mock);

  await import(`./main.js${key}`);
  harness.resolveReady();
  await new Promise(r => setTimeout(r, 20));

  const senderEvent = { senderFrame: { url: 'http://localhost:8080/' } };
  harness.emitIpc('lunara:tray-state', senderEvent, {
    title: '夜航船',
    artist: '陈粒',
    subtitle: '风吹过江面灯火渐远',
    textMode: 'lyrics',
    subtitleProgress: 0.1,
    subtitleSpanMs: 4000,
    playing: true,
    canPrevious: true,
  });
  await new Promise(r => setTimeout(r, 30));

  assert.equal(harness.mock.powerMonitor.listenerCount(), 4, 'whenReady 后注册 4 个电源/锁屏监听');
  assert.equal(harness.trayRecords.tooltip, 'Lunara · 正在播放：夜航船 — 陈粒');
  if (process.platform === 'darwin') {
    assert.equal(harness.trayRecords.image, harness.renderedIcon, '活跃播放歌词时使用扫色位图');
    assert.ok(harness.trayRecords.captures >= 2, '离屏画布已完成预热与首帧截图');
  }

  harness.mock.powerMonitor.emit('suspend');
  const capturesAtSuspend = harness.trayRecords.captures;
  await new Promise(r => setTimeout(r, 190));

  assert.equal(harness.trayRecords.captures, capturesAtSuspend, '休眠期间不再触发 80ms 离屏扫色截图');
  assert.equal(harness.trayRecords.tooltip, 'Lunara · 正在播放：夜航船 — 陈粒', '休眠期间保留曲目与播放状态提示');
  if (process.platform === 'darwin') {
    assert.equal(harness.trayRecords.image, harness.templateIcon, '休眠期间切回静态模板图标');
    assert.equal(harness.trayRecords.title, '夜航船', '休眠期间退回静态曲名');
  }

  // 锁屏与休眠叠加：唤醒系统但屏幕仍锁定时继续保持省电静止
  harness.mock.powerMonitor.emit('lock-screen');
  harness.mock.powerMonitor.emit('resume');
  harness.emitIpc('lunara:tray-state', senderEvent, {
    title: '奇妙能力歌',
    artist: '陈粒',
    subtitle: '我看过沙漠下暴雨',
    textMode: 'lyrics',
    subtitleProgress: 0.15,
    subtitleSpanMs: 4000,
    playing: true,
    canPrevious: true,
  });
  await new Promise(r => setTimeout(r, 120));
  assert.equal(harness.trayRecords.captures, capturesAtSuspend, '锁屏未解时新状态推送不重启扫色定时器');
  assert.equal(harness.trayRecords.tooltip, 'Lunara · 正在播放：奇妙能力歌 — 陈粒');
  if (process.platform === 'darwin') {
    assert.equal(harness.trayRecords.title, '奇妙能力歌', '锁屏期间同步最新静态曲名');
  }

  harness.mock.powerMonitor.emit('unlock-screen');
  await new Promise(r => setTimeout(r, 30));
  if (process.platform === 'darwin') {
    assert.equal(harness.trayRecords.image, harness.renderedIcon, '解锁后恢复歌词扫色渲染');
    assert.ok(harness.trayRecords.captures > capturesAtSuspend, '解锁后恢复离屏绘制');
  }

  harness.emitApp('will-quit');
  assert.equal(harness.mock.powerMonitor.listenerCount(), 0, 'will-quit 清理全部 powerMonitor 监听');
  assert.equal(harness.trayRecords.destroyed, true, 'will-quit 销毁托盘');
});

test('main.js degrades safely when powerMonitor mock omits .on', async () => {
  const key = '?case=missing-power-monitor';
  const harness = createElectronHarness({ withPowerMonitor: false });
  electronMocks.set(key, harness.mock);

  await import(`./main.js${key}`);
  harness.resolveReady();
  await new Promise(r => setTimeout(r, 20));

  harness.emitApp('will-quit');
  assert.equal(harness.trayRecords.destroyed, true);
});
