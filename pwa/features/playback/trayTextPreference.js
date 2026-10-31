// trayTextPreference.js — 桌面托盘在菜单栏图标旁显示什么。
//
// 两个取值：
//   · 'title'  当前曲名（默认）——安静、稳定，不知道这首歌也能看懂在放什么；
//   · 'lyrics' 当前歌词行——跟着唱的时候一眼能看，没有歌词/未到歌词时自动回落到曲名。
//
// 这是**本机显示偏好**（不是播放事实），所以只存 localStorage；localStorage 不可用时
// 退化为进程内值，行为与音量偏好一致。托盘/浏览器里不存在桌面桥时这个偏好自然无人读取。

import { STORAGE_KEYS } from '../../core/storageKeys.js';

const MODES = Object.freeze({ title: 'title', lyrics: 'lyrics' });
const listeners = new Set();
let cached = null;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalize(mode) {
  return mode === MODES.lyrics ? MODES.lyrics : MODES.title;
}

/** 当前生效的模式：'title' | 'lyrics'；默认 'title'。 */
export function getTrayTextMode() {
  if (cached != null) return cached;
  let stored = null;
  try { stored = storage()?.getItem(STORAGE_KEYS.trayText); } catch { stored = null; }
  cached = normalize(stored);
  return cached;
}

/** 写入模式并通知订阅者（播放器据此立刻刷新菜单栏文字）。非法值直接忽略，不改写用户的选择。 */
export function setTrayTextMode(mode) {
  if (mode !== MODES.title && mode !== MODES.lyrics) return getTrayTextMode();
  const next = mode;
  if (next === getTrayTextMode()) return next;
  cached = next;
  try { storage()?.setItem(STORAGE_KEYS.trayText, next); } catch { /* 无存储环境时只保留进程内值 */ }
  for (const listener of [...listeners]) {
    try { listener(next); } catch { /* 单个订阅者失败不影响其它 */ }
  }
  return next;
}

/** 订阅模式变化；返回取消订阅。 */
export function subscribeTrayTextMode(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试钩子：清空进程内缓存，恢复"从存储读取"的初始语义。 */
export function resetTrayTextModeForTest() {
  cached = null;
  listeners.clear();
}
