// presenceTemperament.js — 在场性格：话多还是话少是人格的一部分，不是全局常数。
//
// 输入：角色 metadata_json.presence（{ temperament, style }）、当前陪伴模式、用户显式档位（可无）。
// 输出：一组运行时节奏参数（开放的时刻、需要多强的钩子、窗口/整场预算），或 null（不主动开口）。
// 分层：模式给上限；用户显式档位优先于角色默认；两者取更严格的那个。
// 120 秒人声间隔、静默时段、用户在场与交付门控不在这里，任何性格都绕不过。
//
// Python 伪代码：
//   level = user_level or person.temperament or 'balanced'
//   policy = PROFILES[min(level, MODE_CEILING[mode])]   # quiet < balanced < lively

export const PRESENCE_TEMPERAMENTS = Object.freeze(['quiet', 'balanced', 'lively']);
export const PRESENCE_STYLE_MAX = 200;

// heartbeatMs / minSpacingMs / perHour：ambient 唤醒的心跳间隔、两次唤醒的最小间距和每小时上限
// （add-companion-heartbeat D1）。perWindow / perSession 仍是开口预算。
const MIN = 60_000;
const PROFILES = Object.freeze({
  quiet: Object.freeze({ id: 'quiet', perWindow: 1, perSession: 4, hooks: 'strong', every: Object.freeze({}),
    heartbeatMs: 30 * MIN, minSpacingMs: 12 * MIN, perHour: 2,
    moments: new Set(['session_open', 'queue_exhausted', 'boundary_without_intro']),
    hint: '默认在场节奏偏安静简短，有贴切的话时轻声点到为止；具体语气与热络度以你的角色人设为准。' }),
  balanced: Object.freeze({ id: 'balanced', perWindow: 2, perSession: 8, hooks: 'any', every: Object.freeze({}),
    heartbeatMs: 15 * MIN, minSpacingMs: 6 * MIN, perHour: 4,
    moments: null, hint: '' }),
  lively: Object.freeze({ id: 'lively', perWindow: 3, perSession: 12, hooks: 'any', every: Object.freeze({ track_completed: 3 }),
    heartbeatMs: 8 * MIN, minSpacingMs: 3 * MIN, perHour: 8,
    moments: null, hint: '默认在场节奏偏健谈，看到合适的话头愿意主动分享或接话；具体语气与分寸以你的角色人设为准。' }),
});

// 模式上限：music_only 不主动开口；occasional 最多 balanced；对话型与 legacy 会话不额外收紧。
const MODE_CEILING = Object.freeze({ music_only: null, occasional: 'balanced', conversational: 'lively' });
const rank = id => PRESENCE_TEMPERAMENTS.indexOf(id);
const clean = value => String(value ?? '').trim();

/** 读角色声明的在场性格；缺省或非法都回到 balanced（读路径从不抛错）。 */
export function presenceTemperamentOf(person) {
  const declared = person?.metadata?.presence || {};
  const temperament = PRESENCE_TEMPERAMENTS.includes(declared.temperament) ? declared.temperament : 'balanced';
  return { temperament, style: clean(declared.style).slice(0, PRESENCE_STYLE_MAX) };
}

/** 写路径校验：编辑角色时调用，非法输入整体拒绝。 */
export function normalizePresenceSetting(value = {}) {
  const temperament = clean(value?.temperament) || 'balanced';
  if (!PRESENCE_TEMPERAMENTS.includes(temperament)) throw new TypeError(`invalid presence temperament; expected one of: ${PRESENCE_TEMPERAMENTS.join(', ')}`);
  const style = clean(value?.style);
  if (style.length > PRESENCE_STYLE_MAX) throw new TypeError(`presence style exceeds ${PRESENCE_STYLE_MAX} characters`);
  return { temperament, style };
}

/** @returns 节奏参数，或 null 表示这个模式下不主动开口。 */
export function resolvePresencePolicy({ modeId = null, temperament = 'balanced', userLevel = null } = {}) {
  const ceiling = modeId == null ? 'lively' : (modeId in MODE_CEILING ? MODE_CEILING[modeId] : 'balanced');
  if (!ceiling) return null;
  const chosen = PRESENCE_TEMPERAMENTS.includes(userLevel) ? userLevel
    : (PRESENCE_TEMPERAMENTS.includes(temperament) ? temperament : 'balanced');
  return PROFILES[rank(chosen) <= rank(ceiling) ? chosen : ceiling];
}

/**
 * 生效话量：把四层开关（启动参数 / 全局开关 / 陪伴模式 / 本次「安静点」/ 在场性格）折成界面能说清的一句话。
 * 只读、无副作用；档位来自上面同一个 resolvePresencePolicy，界面不另算一遍。
 *
 * @returns {{ level: 'silent'|'quiet'|'balanced'|'lively', limitedBy: null|'unavailable'|'ambient-off'|'listener-quiet'|'mode'|'temperament' }}
 *   limitedBy = 把话量压到「所选模式上限」以下的那个原因；'mode' 表示就是模式自己选的（界面不必另外解释）。
 *
 * Python 伪代码：
 *   if not available: return silent, 'unavailable'
 *   if not ambient_enabled: return silent, 'ambient-off'
 *   policy = resolve(mode, temperament)
 *   if policy is None: return silent, 'mode'          # 只听歌
 *   if listener_quiet: return silent, 'listener-quiet'
 *   if policy.id == 'quiet' and ceiling(mode) > 'quiet': return 'quiet', 'temperament'   # 「自然」是默认，不算被压低
 *   return policy.id, ('mode' if policy.id < temperament else None)
 */
export function describeEffectivePresence({ available = true, ambientEnabled = true, listenerQuiet = false,
  modeId = null, temperament = 'balanced' } = {}) {
  const silent = limitedBy => ({ level: 'silent', limitedBy });
  if (available !== true) return silent('unavailable');
  if (ambientEnabled !== true) return silent('ambient-off');
  const declared = PRESENCE_TEMPERAMENTS.includes(temperament) ? temperament : 'balanced';
  const policy = resolvePresencePolicy({ modeId, temperament: declared });
  if (!policy) return silent('mode');
  if (listenerQuiet === true) return silent('listener-quiet');
  const ceiling = resolvePresencePolicy({ modeId, temperament: 'lively' });
  if (policy.id === 'quiet' && rank(ceiling.id) > rank('quiet')) return { level: 'quiet', limitedBy: 'temperament' };
  return { level: policy.id, limitedBy: rank(policy.id) < rank(declared) ? 'mode' : null };
}
