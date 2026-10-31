// 桌面托盘通道的契约测试：主进程与预加载必须使用同一组通道名，
// 且预加载只能经 contextBridge 暴露窄接口（这是仓库里唯一的 IPC 面）。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = name => readFile(resolve(here, name), 'utf8');

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
});
