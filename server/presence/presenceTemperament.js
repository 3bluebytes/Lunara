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
    hint: '你话不多：没有真想说的就不说，开口也很短。' }),
  balanced: Object.freeze({ id: 'balanced', perWindow: 2, perSession: 8, hooks: 'any', every: Object.freeze({}),
    heartbeatMs: 15 * MIN, minSpacingMs: 6 * MIN, perHour: 4,
    moments: null, hint: '' }),
  lively: Object.freeze({ id: 'lively', perWindow: 3, perSession: 12, hooks: 'any', every: Object.freeze({ track_completed: 3 }),
    heartbeatMs: 8 * MIN, minSpacingMs: 3 * MIN, perHour: 8,
    moments: null, hint: '你话比较多，愿意接话，但也不硬聊。' }),
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
