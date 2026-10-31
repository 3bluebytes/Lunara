// presencePreferences.js — 「一起听歌时伙伴会主动说话」开关（add-companion-heartbeat D7）
// 与「打开 app 时伙伴可以打招呼」开关（add-app-open-greeting D7），两者互相独立。
//
// 存在现有 state.db 的 prefs KV 里，独立 key `presence_prefs_v1`，不进 settings JSON，
// 所以别的设置保存不会把它冲掉。默认开；读坏了按默认值处理。
// 环境变量 PRESENCE_AUTO=0 是总开关，优先于这里存的值（available=false）。
// 写入失败抛出可恢复的封闭错误码，不回显底层异常；写成功后读回，调用方据此确认。
//
// Python 伪代码：
//   prefs = PresencePreferences(state, env)
//   prefs.set(ambient_enabled=False)   # 写入并读回；失败抛 PRESENCE_PREFS_WRITE_FAILED
//   prefs.ambient_enabled()            # env 允许 且 存的是开
//   prefs.set(greeting_enabled=False)  # 只改给出的那个开关
export const PRESENCE_PREFS_KEY = 'presence_prefs_v1';

function prefsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createPresencePreferences({ state, env = process.env } = {}) {
  const available = env.PRESENCE_AUTO !== '0';
  const read = () => {
    let data = null;
    try { data = state?.getPref?.(PRESENCE_PREFS_KEY) ?? null; } catch { data = null; }
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
    return { ambientEnabled: data?.ambientEnabled !== false, greetingEnabled: data?.greetingEnabled !== false };
  };
  let stored = read();
  const get = () => ({ ambientEnabled: stored.ambientEnabled, greetingEnabled: stored.greetingEnabled, available });
  return Object.freeze({
    get,
    ambientEnabled: () => available && stored.ambientEnabled,
    greetingEnabled: () => available && stored.greetingEnabled,
    set({ ambientEnabled, greetingEnabled } = {}) {
      const given = { ambientEnabled, greetingEnabled };
      const keys = Object.keys(given).filter(key => given[key] !== undefined);
      if (!keys.length || keys.some(key => typeof given[key] !== 'boolean')) {
        throw prefsError('INVALID_PRESENCE_PREFS', 'ambientEnabled / greetingEnabled 必须是布尔值');
      }
      const next = { ...stored, ...Object.fromEntries(keys.map(key => [key, given[key]])) };
      try { state.setPref(PRESENCE_PREFS_KEY, { version: 1, ambientEnabled: next.ambientEnabled, greetingEnabled: next.greetingEnabled }); }
      catch { throw prefsError('PRESENCE_PREFS_WRITE_FAILED', '没能保存这个开关'); }
      stored = read();
      return get();
    },
  });
}

export default createPresencePreferences;
