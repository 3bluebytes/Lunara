// sourceFailure.js — 音乐源失败的封闭原因集合。
//
// 在此之前，「为什么没拿到这首歌」是一条条自由文本：`not found`、`no match`、
// `no playable url (vip/cookie?)`、`resource-unavailable`、`all-sources-failed`。
// 这些字符串同时承担诊断与展示，于是上层只能对用户说「没找到歌」——四种完全
// 不同的原因（源里没有 / 需要会员 / 登录失效 / 源挂了）被压成同一句话。
//
// 这里只做一件事：把失败收敛到封闭枚举。原始异常、URL、cookie、堆栈一律不进入
// 枚举、不进入模型输入、不进入 TTS 文案。展示文案由上层按 code 决定。

export const SOURCE_FAILURE = Object.freeze({
  /** 源里没有这首歌，或没有达到最低匹配度的候选。用户换说法或换歌。 */
  NOT_FOUND: 'not-found',
  /** 有这首歌，但拿不到可播放音源（版权/下架/无法解析直链）。 */
  NOT_PLAYABLE: 'not-playable',
  /** 该源未登录或登录态失效。用户去登录这一个源即可。 */
  REQUIRES_AUTH: 'requires-auth',
  /** 该源可播但需要会员。 */
  REQUIRES_MEMBER: 'requires-member',
  /** 被限流或风控。稍后重试。 */
  RATE_LIMITED: 'rate-limited',
  /** 源服务不可用（连不上 / 端口没在听 / 上游 5xx）。 */
  UNAVAILABLE: 'unavailable',
  /** 超时。与 unavailable 分开：用户能区分「慢」和「挂」。 */
  TIMEOUT: 'timeout',
  /** 未能归因的失败。对外仍是通用文案，不外泄原文。 */
  INTERNAL: 'internal',
});

export const SOURCE_FAILURE_CODES = Object.freeze(Object.values(SOURCE_FAILURE));

const CODE_SET = new Set(SOURCE_FAILURE_CODES);

/** 每个 code 对应的用户下一步。上层据此决定提示与按钮，而不是自己猜。 */
export const SOURCE_FAILURE_NEXT_STEP = Object.freeze({
  [SOURCE_FAILURE.NOT_FOUND]: 'rephrase',
  [SOURCE_FAILURE.NOT_PLAYABLE]: 'none',
  [SOURCE_FAILURE.REQUIRES_AUTH]: 'login',
  [SOURCE_FAILURE.REQUIRES_MEMBER]: 'subscribe',
  [SOURCE_FAILURE.RATE_LIMITED]: 'retry',
  [SOURCE_FAILURE.UNAVAILABLE]: 'retry',
  [SOURCE_FAILURE.TIMEOUT]: 'retry',
  [SOURCE_FAILURE.INTERNAL]: 'retry',
});

// 归因顺序有意义：限流与登录态失效都可能表现为 401/403，限流先判。
const PATTERNS = Object.freeze([
  [SOURCE_FAILURE.RATE_LIMITED, /(?:429|rate[\s_-]?limit|too many requests|风控|访问频繁|请求频繁)/i],
  [SOURCE_FAILURE.REQUIRES_MEMBER, /(?:\bvip\b|会员|付费|购买|premium|subscription)/i],
  [SOURCE_FAILURE.REQUIRES_AUTH, /(?:401|403|unauthoriz|forbidden|login|cookie|未登录|登录态|登录失效)/i],
  [SOURCE_FAILURE.TIMEOUT, /(?:timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT)/i],
  [SOURCE_FAILURE.UNAVAILABLE, /(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|\b5\d\d\b|unavailable)/i],
]);

export function isSourceFailureCode(value) {
  return CODE_SET.has(String(value ?? '').trim());
}

/**
 * 把未知输入（原始 Error、字符串、已有 code）归因到一个封闭 code。
 * 只输出 code —— 原始文本不参与输出，避免凭据或内部细节随诊断外泄。
 */
export function classifySourceFailure(value) {
  if (isSourceFailureCode(value)) return String(value).trim();
  if (isSourceFailureCode(value?.code)) return String(value.code).trim();
  const raw = typeof value === 'string'
    ? value
    : `${value?.code ?? ''} ${value?.name ?? ''} ${value?.message ?? ''}`;
  const text = String(raw || '').trim();
  if (!text) return SOURCE_FAILURE.INTERNAL;
  for (const [code, pattern] of PATTERNS) {
    if (pattern.test(text)) return code;
  }
  return SOURCE_FAILURE.INTERNAL;
}

/** provider 侧返回的标准失败对象。只带 code 与源名，不带原文。 */
export function sourceFailure(code, { source = null, query = null } = {}) {
  const resolved = classifySourceFailure(code);
  return {
    ok: false,
    code: resolved,
    ...(source ? { source } : {}),
    ...(query ? { query } : {}),
  };
}

/**
 * 多个源都失败时的顶层原因：取**解析顺序里第一个非 not-found** 的 code——
 * 也就是用户主源给出的那个原因，确定性且可解释。全部 not-found 才是 not-found。
 */
export function dominantSourceFailure(failures = []) {
  const codes = (Array.isArray(failures) ? failures : [])
    .map(item => classifySourceFailure(item?.code ?? item))
    .filter(Boolean);
  if (!codes.length) return SOURCE_FAILURE.INTERNAL;
  return codes.find(code => code !== SOURCE_FAILURE.NOT_FOUND) || SOURCE_FAILURE.NOT_FOUND;
}

/** 把 failures 压成脱敏的 {source, code} 列表。 */
export function publicFailures(failures = []) {
  return (Array.isArray(failures) ? failures : [])
    .filter(item => item && typeof item === 'object')
    .map(item => ({ source: String(item.source ?? ''), code: classifySourceFailure(item.code) }))
    .filter(item => item.source);
}

/**
 * 面向用户的文案。与技术诊断严格分开：这里只用「源 + 现象 + 下一步」讲人话，
 * 不出现 code、状态码、URL、异常类型。上层可以据此直接展示；模型/TTS 仍应
 * 自然转述，不得把这里当成台词逐字念出。
 */
const COPY = Object.freeze({
  [SOURCE_FAILURE.NOT_FOUND]: '没有找到明确匹配的歌',
  [SOURCE_FAILURE.NOT_PLAYABLE]: '{source}拿不到这首歌的音源',
  [SOURCE_FAILURE.REQUIRES_AUTH]: '需要在{source}登录',
  [SOURCE_FAILURE.REQUIRES_MEMBER]: '{source}需要会员才能听这首歌',
  [SOURCE_FAILURE.RATE_LIMITED]: '{source}暂时限制了请求',
  [SOURCE_FAILURE.UNAVAILABLE]: '{source}暂时连不上',
  [SOURCE_FAILURE.TIMEOUT]: '{source}响应太慢',
  [SOURCE_FAILURE.INTERNAL]: '暂时没能拿到这首歌',
});

/** code → 一句中文说明。source 取展示名，缺省时省略主语。 */
export function describeSourceFailure(code, { source = '' } = {}) {
  const template = COPY[classifySourceFailure(code)] || COPY[SOURCE_FAILURE.INTERNAL];
  const name = String(source ?? '').trim();
  if (template.includes('{source}')) {
    return name ? template.replaceAll('{source}', name) : template.replaceAll('{source}', '这个音乐源');
  }
  return template;
}
