// musicVolumePreference.js — 伴听音乐的本地设备音量偏好。
//
// 用户拖动音量滑块后，换歌、串词压低恢复、重连都必须保持这个设定，而不是被
// 激活逻辑重置回固定值。localStorage 不可用时（测试/隐私模式）退化为进程内默认值。

const MUSIC_VOLUME_KEY = 'lunara-music-volume';

let cached = null;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 当前生效的音乐音量偏好，范围 [0, 1]，默认 1。 */
export function getMusicVolumePreference() {
  if (cached != null) return cached;
  const store = storage();
  const stored = Number(store?.getItem(MUSIC_VOLUME_KEY));
  cached = Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : 1;
  return cached;
}

/** 写入音乐音量偏好；越界值按边界收敛，保证读回永远在 [0, 1]。 */
export function setMusicVolumePreference(value) {
  const next = Math.min(1, Math.max(0, Number(value)));
  if (!Number.isFinite(next)) return getMusicVolumePreference();
  cached = next;
  try {
    storage()?.setItem(MUSIC_VOLUME_KEY, String(next));
  } catch { /* 无存储环境时只保留进程内值 */ }
  return next;
}

/** 测试钩子：清空进程内缓存，恢复"从存储读取"的初始语义。 */
export function resetMusicVolumePreferenceForTest() {
  cached = null;
}
