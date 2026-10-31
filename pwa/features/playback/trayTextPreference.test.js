import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getTrayTextMode, resetTrayTextModeForTest, setTrayTextMode, subscribeTrayTextMode,
} from './trayTextPreference.js';

function withStorage(store) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  return () => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  };
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    dump: () => Object.fromEntries(data),
  };
}

test('the menu bar shows the title unless the listener asks for lyrics', () => {
  const restore = withStorage(memoryStorage());
  resetTrayTextModeForTest();
  try {
    assert.equal(getTrayTextMode(), 'title', '默认是曲名：安静且不依赖歌词是否到手');
    assert.equal(setTrayTextMode('lyrics'), 'lyrics');
    assert.equal(getTrayTextMode(), 'lyrics');
    // 未知值收敛回曲名，不让坏数据把菜单栏变成空的
    assert.equal(setTrayTextMode('nonsense'), 'lyrics', '已经是 lyrics 时不因未知输入改写');
    assert.equal(setTrayTextMode('title'), 'title');
  } finally { restore(); }
});

test('the choice survives a reload and is shared with the tray bridge', () => {
  const store = memoryStorage();
  const restore = withStorage(store);
  try {
    resetTrayTextModeForTest();
    setTrayTextMode('lyrics');
    assert.equal(store.dump()['lunara.tray.text'], 'lyrics', '写在 STORAGE_KEYS.trayText 下');
    resetTrayTextModeForTest(); // 模拟重启：重新从存储读取
    assert.equal(getTrayTextMode(), 'lyrics');
  } finally { restore(); }
});

test('subscribers are told once per real change and can unsubscribe', () => {
  const restore = withStorage(memoryStorage());
  resetTrayTextModeForTest();
  try {
    const seen = [];
    const unsubscribe = subscribeTrayTextMode(mode => seen.push(mode));
    setTrayTextMode('lyrics');
    setTrayTextMode('lyrics'); // 同值不通知：避免无意义的托盘重发
    setTrayTextMode('title');
    assert.deepEqual(seen, ['lyrics', 'title']);
    unsubscribe();
    setTrayTextMode('lyrics');
    assert.deepEqual(seen, ['lyrics', 'title'], '取消订阅后不再通知');
  } finally { restore(); }
});

test('without storage the choice still works in-process', () => {
  resetTrayTextModeForTest();
  assert.equal(getTrayTextMode(), 'title');
  assert.equal(setTrayTextMode('lyrics'), 'lyrics');
  assert.equal(getTrayTextMode(), 'lyrics');
  resetTrayTextModeForTest();
});
