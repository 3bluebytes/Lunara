import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getMusicVolumePreference,
  resetMusicVolumePreferenceForTest,
  setMusicVolumePreference,
} from './musicVolumePreference.js';

test('preference defaults to 1 and clamps out-of-range writes', () => {
  resetMusicVolumePreferenceForTest();
  assert.equal(getMusicVolumePreference(), 1);
  assert.equal(setMusicVolumePreference(1.7), 1);
  assert.equal(setMusicVolumePreference(-0.5), 0);
  assert.equal(setMusicVolumePreference('not-a-number'), 0, '非法输入保留当前值');
  resetMusicVolumePreferenceForTest();
  assert.equal(getMusicVolumePreference(), 1, '重置后回到默认');
});

test('preference persists through storage when available', () => {
  resetMusicVolumePreferenceForTest();
  const values = new Map();
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
      };
    },
  });
  try {
    setMusicVolumePreference(0.4);
    resetMusicVolumePreferenceForTest();
    assert.equal(getMusicVolumePreference(), 0.4, '进程内缓存清空后从存储读回');
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: previous, writable: true });
    resetMusicVolumePreferenceForTest();
  }
});
