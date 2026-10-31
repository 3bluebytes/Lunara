// llmCapabilities.js — 模型能力档案：描述「这台模型在协议上能做到什么」。
//
// 对应 change `agent-budget-and-response-contract` design §1。要点：
//   - 档案来源优先级：自动探测与运行时观测（默认）> 用户显式声明（可选覆盖）> unknown。
//   - 未知一律保守：canDisable=false（不发厂商私有参数）、思考可能占用输出额度
//     （由 llmTasks 追加思考余量）。正确性不依赖档案，档案只用于省钱省时。
//   - 命名家族推导（`deriveFamilyPrefill`）只用于设置页预填建议，MUST NOT 静默生效；
//     唯一的例外是过渡桥 `capabilityFromEndpoint` 对既有 DeepSeek 判定的保留，
//     待自动探测落地后删除（任务 1.7）。
//   - 「能否关闭思考」最终由一次尝试 + 负缓存判定（任务 1.6a），不询问用户。

/** 字段齐全的保守档案：什么都不知道时的立场。 */
export const UNKNOWN_CAPABILITY = Object.freeze({
  family: 'unknown',
  protocol: null,
  thinking: Object.freeze({
    default: 'unknown',   // 'on' | 'off' | 'unknown'
    canDisable: null,     // true/false = 已证实；null = 未证实（不发送任何厂商私有参数）
    budgetKnob: null,     // 'reasoning_effort' | 'thinking_budget' | null
    budgetRange: null,    // [min, max]
  }),
  structuredOutput: 'none', // 'json_schema' | 'json_object' | 'tool_force' | 'none'
  caps: Object.freeze({ maxOutputTokens: null, contextWindow: null }),
  price: null,
  source: 'unknown',        // 'user' | 'probe' | 'observed' | 'unknown'
});

const THINKING_DEFAULTS = new Set(['on', 'off', 'unknown']);
const BUDGET_KNOBS = new Set(['reasoning_effort', 'thinking_budget']);
const STRUCTURED_FORMS = new Set(['json_schema', 'json_object', 'tool_force', 'none']);
const SOURCES = new Set(['user', 'probe', 'observed', 'unknown']);

function normalizeRange(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [min, max] = value.map(Number);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) return null;
  return [min, max];
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/**
 * 校验并归一化一份档案；未知/坏字段回落保守默认，绝不因档案错误让调用失败。
 * 这不是「猜测」：无法确认的能力保持 unknown/false，调用侧按保守策略处理。
 */
export function normalizeCapability(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const thinking = input.thinking && typeof input.thinking === 'object' ? input.thinking : {};
  const caps = input.caps && typeof input.caps === 'object' ? input.caps : {};
  const family = typeof input.family === 'string' && input.family.trim() ? input.family.trim() : 'unknown';
  const protocol = input.protocol ? String(input.protocol) : null;
  return Object.freeze({
    family,
    protocol,
    thinking: Object.freeze({
      default: THINKING_DEFAULTS.has(thinking.default) ? thinking.default : 'unknown',
      // 三态：true/false 是已证实事实；缺省/坏值保持 null（未证实），调用侧按保守处理。
      canDisable: typeof thinking.canDisable === 'boolean' ? thinking.canDisable : null,
      budgetKnob: BUDGET_KNOBS.has(thinking.budgetKnob) ? thinking.budgetKnob : null,
      budgetRange: normalizeRange(thinking.budgetRange),
    }),
    structuredOutput: STRUCTURED_FORMS.has(input.structuredOutput) ? input.structuredOutput : 'none',
    caps: Object.freeze({
      maxOutputTokens: positiveOrNull(caps.maxOutputTokens),
      contextWindow: positiveOrNull(caps.contextWindow),
    }),
    price: input.price && typeof input.price === 'object' ? Object.freeze({ ...input.price }) : null,
    source: SOURCES.has(input.source) ? input.source : 'unknown',
  });
}

/**
 * 命名家族推导：**仅用于设置页预填建议**并标注「建议探测确认」，MUST NOT 静默生效。
 * 返回 null 表示命名给不出任何建议。
 */
export function deriveFamilyPrefill(model = '', baseUrl = '') {
  const name = String(model || '').split('/').at(-1).toLowerCase();
  const host = (() => { try { return new URL(String(baseUrl)).hostname; } catch { return ''; } })();
  if (/^deepseek(?:-|$)/.test(name)) {
    return { family: 'deepseek', thinking: { default: 'on', canDisable: true, budgetKnob: null },
      structuredOutput: 'json_object' };
  }
  if (/^glm(?:-|$)/.test(name)) return { family: 'glm', thinking: { default: 'on', canDisable: true, budgetKnob: null } };
  if (/^claude/.test(name)) return { family: 'claude', thinking: { default: 'on', canDisable: true, budgetKnob: 'thinking_budget', budgetRange: [1024, 32768] } };
  if (/^gpt-?\d|^o[1-9]/.test(name)) return { family: 'gpt', thinking: { default: 'unknown', canDisable: false, budgetKnob: 'reasoning_effort' } };
  if (/^gemini/.test(name)) return { family: 'gemini', thinking: { default: 'on', canDisable: true, budgetKnob: 'thinking_budget', budgetRange: [0, 24576] } };
  if (host === 'api.deepseek.com') return { family: 'deepseek', thinking: { default: 'on', canDisable: true, budgetKnob: null } };
  return null;
}

/**
 * 过渡桥（跟进任务 1.7）：档案尚未入库时，保留既有「明确 DeepSeek 模型 ID 或官方域名
 * 可携带 thinking.type 参数」的判定，避免收编过程中行为回退。注册表提供
 * `endpoint.capability` 时以档案为准；自动探测落地后删除本桥。
 */
export function capabilityFromEndpoint(endpoint = {}) {
  if (endpoint.capability) return normalizeCapability(endpoint.capability);
  const modelName = String(endpoint.model || '').split('/').at(-1);
  const officialHost = (() => {
    try { return new URL(String(endpoint.baseUrl)).hostname === 'api.deepseek.com'; }
    catch { return false; }
  })();
  if (/^deepseek(?:-|$)/i.test(modelName) || officialHost) {
    return normalizeCapability({
      family: 'deepseek',
      thinking: { default: 'on', canDisable: true },
      source: 'observed',
    });
  }
  return UNKNOWN_CAPABILITY;
}

/** 原生结构化能力 → 请求侧形态；'none' 表示只能退回文本抽取。 */
export function nativeStructuredForm(capability) {
  const form = capability?.structuredOutput;
  return STRUCTURED_FORMS.has(form) && form !== 'none' ? form : null;
}

export default { UNKNOWN_CAPABILITY, normalizeCapability, deriveFamilyPrefill, capabilityFromEndpoint, nativeStructuredForm };
