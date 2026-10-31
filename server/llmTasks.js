// llmTasks.js — 任务预算规格：每个会调用模型的任务的**唯一数字来源**。
//
// 对应 change `agent-budget-and-response-contract` design §2。每条规格声明：
//   answerTokens   正文需要多少输出（结构化 JSON 按 schema 估算）
//   reasoning      'helpful' | 'light' | 'neutral' | 'wasteful'——思考对这类任务是否有帮助
//                  （light：需要思考但不必深想——发送较低档位，永不关闭思考）
//   structured     'json' | 'text' | 'tool'——结构化形态（决定原生结构化与 JSON 校验）
//   attempts       有界升级阶梯（倍数，首项恒为 1）；升级受 hardCap 与模型输出上限约束
//   hardCapTokens  该任务的输出硬上限（升级与显式参数都不越过）
//   timeoutMs      请求超时（null = 跟随 LLM_TIMEOUT_MS）
//   attemptTimeoutMs 单次请求上限（null = 不封顶）：卡住的一次尽快失败，把剩余截止留给
//                  同端点重试或故障切换（bound-model-attempt-timeout D1）
//   onExhausted    两次都不可用时的行为：'typed_failure' | 'deterministic_fallback' | 'skip'
//
// 生效额度（design §2 三态）：
//   1. 档案有原生思考预算旋钮 → 成本型任务（reasoning='wasteful' 或 'light'）按协议发送旋钮
//      （token budget 取思考余量 clamp 到 budgetRange；effort 档位取 'low'——探测已证实被接受）；
//      输出额度始终保留正文 + 思考余量，避免协议把思考计入总额度时挤空正文；
//   2. 无旋钮但档案声明可关思考且任务标 wasteful → 关闭思考，输出额度 = 正文需要
//      （只有协议真能表达关闭、且关闭被接受时才生效；被拒/被无视会恢复余量）；
//   3. 其余情况（含 unknown 与 helpful/neutral）→ 输出额度 = 正文需要 + 思考余量
//      （LLM_REASONING_ALLOWANCE_TOKENS）。
// 显式调用方参数与环境覆盖是**覆盖层**：它们给出的是生效输出总额，不再追加思考余量
//（覆盖永远赢；语义写入 docs/architecture.md 模型接入一节）。优先级：
//   任务规格默认 < 环境覆盖 < 显式调用方参数
// 「思考有帮助」的任务（reasoning='helpful' 或 'light'）不得携带关闭思考参数——由传输层强制。

export const DEFAULT_REASONING_ALLOWANCE_TOKENS = 1024;
// 串词的整个受限任务共享 generation 截止；上下文与 TTS 单独有界。
export const NARRATION_EXECUTION_LIMITS = Object.freeze({ maxRounds: 3, contextTimeoutMs: 1_000, synthesisBudgetMs: 30_000 });
const MODEL_DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const REASONING_KINDS = new Set(['helpful', 'light', 'neutral', 'wasteful']);
const STRUCTURED_FORMS = new Set(['json', 'text', 'tool']);
const EXHAUSTED_BEHAVIORS = new Set(['typed_failure', 'deterministic_fallback', 'skip']);

function intOrNull(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function validateTaskSpec(id, spec) {
  const fail = message => { throw new TypeError(`LLM task spec "${id}" is invalid: ${message}`); };
  if (!spec || typeof spec !== 'object') fail('not an object');
  if (spec.id !== id) fail(`id mismatch (${spec.id})`);
  if (!Number.isInteger(spec.answerTokens) || spec.answerTokens <= 0) fail('answerTokens must be a positive integer');
  if (!REASONING_KINDS.has(spec.reasoning)) fail(`reasoning must be one of ${[...REASONING_KINDS].join('/')}`);
  if (!STRUCTURED_FORMS.has(spec.structured)) fail(`structured must be one of ${[...STRUCTURED_FORMS].join('/')}`);
  if (!Array.isArray(spec.attempts) || !spec.attempts.length || spec.attempts[0] !== 1
    || spec.attempts.some(step => !Number.isInteger(step) || step < 1)
    || spec.attempts.some((step, index) => index > 0 && step <= spec.attempts[index - 1])
    || spec.attempts.length > 3) {
    fail('attempts must start at 1 and strictly increase (at most 3 steps)');
  }
  if (!Number.isInteger(spec.hardCapTokens) || spec.hardCapTokens <= 0) fail('hardCapTokens must be a positive integer');
  if (spec.timeoutMs !== null && (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)) fail('timeoutMs must be null or a positive integer');
  if (spec.attemptTimeoutMs != null && (!Number.isInteger(spec.attemptTimeoutMs) || spec.attemptTimeoutMs <= 0)) fail('attemptTimeoutMs must be null or a positive integer');
  if (!EXHAUSTED_BEHAVIORS.has(spec.onExhausted)) fail(`onExhausted must be one of ${[...EXHAUSTED_BEHAVIORS].join('/')}`);
  return true;
}

function task(id, fields) {
  const spec = Object.freeze({ id, timeoutMs: null, attemptTimeoutMs: null, onExhausted: 'typed_failure', hardCapTokens: MODEL_DEFAULT_MAX_OUTPUT_TOKENS, ...fields });
  validateTaskSpec(id, spec);
  return spec;
}

export const LLM_TASKS = Object.freeze({
  // 对话轮（AgentLoop 主循环）。思考对选歌/回应的质量有帮助，不关闭。
  // 单次请求 60s 封顶：当前模型峰值约 22s，回合 120s 内还够同端点再试一次。
  chat_dialogue: task('chat_dialogue', { answerTokens: 2048, reasoning: 'helpful', structured: 'tool', attempts: [1, 2], attemptTimeoutMs: 60_000 }),
  // 群聊回应对象：只读一次提交，短输出、有界等待，不继承聊天的多轮重试。
  response_routing: task('response_routing', { answerTokens: 256, reasoning: 'light', structured: 'tool', attempts: [1], timeoutMs: 15_000 }),
  // 自动续播/手动下一首的受限选歌任务（同一 AgentLoop、白名单工具）。候选与约束已确定，
  // 只挑序号：保留思考、降低档位（延迟优先）。
  music_selection: task('music_selection', { answerTokens: 1024, reasoning: 'light', structured: 'tool', attempts: [1, 2], attemptTimeoutMs: 30_000 }),
  // 串词任务（受限 Agent 运行器，模型写正文、工具机械校验）。要赶在开播窗口内：保留思考、降低档位。
  narration: task('narration', { answerTokens: 1024, reasoning: 'light', structured: 'tool', attempts: [1, 2], timeoutMs: 60_000 }),
  // 一起听时的主动一句话（presence_line）。短、可沉默；超时就沉默，不重试、不兜底。
  presence_utterance: task('presence_utterance', { answerTokens: 512, reasoning: 'light', structured: 'tool', attempts: [1], timeoutMs: 12_000, onExhausted: 'skip' }),
  // 一起听歌时心跳叫醒她的一轮（ambient turn）：完整上下文、她自己决定说不说。
  // 不升级重试：超时或失败就当这次安静，等下一次唤醒（add-companion-heartbeat D2）。
  ambient_turn: task('ambient_turn', { answerTokens: 1024, reasoning: 'light', structured: 'tool', attempts: [1], timeoutMs: 20_000, onExhausted: 'skip' }),
  // 批量机械打标（L2/L3/评论兜底）：思考不帮助判别，属成本选择。
  song_tag: task('song_tag', { answerTokens: 1500, reasoning: 'wasteful', structured: 'json', attempts: [1, 2], timeoutMs: 30_000 }),
  // 后台反思（读账本写观察 JSON）。
  reflection: task('reflection', { answerTokens: 1500, reasoning: 'wasteful', structured: 'json', attempts: [1, 2], timeoutMs: 15_000 }),
  // 口味图式（按周期归纳的机械 JSON）。
  taste_schema: task('taste_schema', { answerTokens: 1500, reasoning: 'wasteful', structured: 'json', attempts: [1, 2], timeoutMs: 20_000 }),
  // 口味整合（consolidator，低频重写 user/*.md）。
  taste_consolidation: task('taste_consolidation', { answerTokens: 1500, reasoning: 'neutral', structured: 'json', attempts: [1, 2] }),
  // 人格生成（兜底路径；Agent 已生成 personaDraft 时不调用）。
  persona_generation: task('persona_generation', { answerTokens: 1200, reasoning: 'neutral', structured: 'json', attempts: [1, 2] }),
  // 设置页「从人设起草」音色描述：用户点击触发、单次、短文本；结果交给用户审阅，失败就让用户手写。
  voice_design_prompt: task('voice_design_prompt', { answerTokens: 600, reasoning: 'light', structured: 'text', attempts: [1], timeoutMs: 30_000 }),
  // 设置页「其他（让助手接入）」：按用户给的 TTS 文档起草请求配方（JSON 文本），每轮都经校验和真实试合成。
  tts_recipe_draft: task('tts_recipe_draft', { answerTokens: 1500, reasoning: 'light', structured: 'text', attempts: [1], timeoutMs: 45_000 }),
  capability_probe: task('capability_probe', { answerTokens: 1024, reasoning: 'helpful', structured: 'text', attempts: [1, 2], hardCapTokens: 8192, timeoutMs: 20_000 }),
  // 连通性探针：只回答两个字；失败本身就是测量结果，不做升级重试。
  connectivity_probe: task('connectivity_probe', { answerTokens: 1024, reasoning: 'wasteful', structured: 'text', attempts: [1], hardCapTokens: 4096, timeoutMs: 20_000 }),
  // 未声明任务的调用方（测试与遗留路径）：沿用旧默认 2048 + 思考余量，行为保守。
  unspecified: task('unspecified', { answerTokens: 2048, reasoning: 'neutral', structured: 'text', attempts: [1, 2], onExhausted: 'deterministic_fallback' }),
});

/** 既有环境变量降级为覆盖层：给出的是该任务的**生效输出总额**。 */
const ENV_OVERRIDES = Object.freeze({
  chat_dialogue: {
    attemptTimeoutMs: { name: 'CHAT_ATTEMPT_TIMEOUT_MS', min: 5_000, max: 600_000 },
  },
  music_selection: {
    attemptTimeoutMs: { name: 'MUSIC_SELECTION_ATTEMPT_TIMEOUT_MS', min: 5_000, max: 600_000 },
  },
  song_tag: {
    answerTokens: { name: 'SONG_TAG_MAX_TOKENS', min: 256, max: 8192 },
    timeoutMs: { name: 'SONG_TAG_TIMEOUT_MS', min: 1_000, max: 600_000 },
  },
  reflection: {
    timeoutMs: { name: 'REFLECTION_LLM_TIMEOUT_MS', min: 1_000, max: 600_000 },
  },
});

/** 读取 env 覆盖（坏值回落默认、越界 clamp），返回 { value, source } 或 null。 */
export function envOverride(taskId, field, env = process.env) {
  const rule = ENV_OVERRIDES[taskId]?.[field];
  if (!rule) return null;
  const parsed = Number.parseInt(env?.[rule.name], 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return { value: Math.min(Math.max(parsed, rule.min), rule.max), source: `env:${rule.name}` };
}

export function reasoningAllowance(env = process.env) {
  return intOrNull(env?.LLM_REASONING_ALLOWANCE_TOKENS, { min: 0, max: 8192 }) ?? DEFAULT_REASONING_ALLOWANCE_TOKENS;
}

export function resolveTaskSpec(taskId) {
  const id = String(taskId ?? '').trim();
  const spec = id && Object.hasOwn(LLM_TASKS, id) ? LLM_TASKS[id] : null;
  if (!spec) throw new TypeError(`unknown LLM task: "${id}"`);
  return spec;
}

function clampThinkingBudget(value, range) {
  if (!Array.isArray(range) || range.length !== 2) return value;
  const [min, max] = range;
  return Math.min(max, Math.max(min, value));
}

/**
 * 生效预算（唯一入口）。capability 来自能力档案（未知时传 null）。
 *
 * @returns {{ taskId, spec, requested, effective, allowance, ceiling, attempts, hardCapTokens,
 *   timeoutMs, attemptTimeoutMs, onExhausted, structured, disableThinking, thinkingBudget, overrideSources }}
 */
export function resolveTaskBudget({
  taskId = null, capability = null, maxTokens = null, thinkingMode = null, env = process.env,
} = {}) {
  const spec = taskId == null || taskId === '' ? LLM_TASKS.unspecified : resolveTaskSpec(taskId);
  const caps = capability?.caps || {};
  const ceiling = Math.min(spec.hardCapTokens, caps.maxOutputTokens || MODEL_DEFAULT_MAX_OUTPUT_TOKENS);

  // 显式关闭：helpful/light 任务永不关闭（规格强制）；neutral/wasteful 尊重调用方的
  // 协议兼容请求（如强制 tool_choice 时必须同时关思考）。自动关闭（负缓存尝试）
  // 只在 wasteful 任务上发生，见 llm.js。
  const disableRequested = thinkingMode === 'disabled' && !['helpful', 'light'].includes(spec.reasoning);
  const disableThinking = disableRequested && capability?.thinking?.canDisable === true;
  const budgetKnob = capability?.thinking?.budgetKnob || null;

  let allowance = disableThinking ? 0 : reasoningAllowance(env);
  if (!disableThinking && budgetKnob) {
    allowance = clampThinkingBudget(allowance, capability?.thinking?.budgetRange);
  }

  const overrideSources = [];
  const explicitTokens = intOrNull(maxTokens, { min: 1, max: Number.MAX_SAFE_INTEGER });
  const envTokens = explicitTokens != null ? null : envOverride(spec.id, 'answerTokens', env);
  let requested;
  let effective;
  if (explicitTokens != null) {
    // 覆盖层给出的是生效总额：显式调用方参数 > 环境覆盖 > 规格默认。
    requested = explicitTokens;
    effective = explicitTokens;
    overrideSources.push('explicit:maxTokens');
  } else if (envTokens) {
    requested = envTokens.value;
    effective = envTokens.value;
    overrideSources.push(envTokens.source);
  } else {
    requested = spec.answerTokens;
    effective = spec.answerTokens + allowance;
  }
  effective = Math.min(effective, ceiling);
  const effectiveAllowance = Math.max(0, effective - requested);

  const timeoutOverride = envOverride(spec.id, 'timeoutMs', env);
  if (timeoutOverride) overrideSources.push(timeoutOverride.source);
  const attemptOverride = envOverride(spec.id, 'attemptTimeoutMs', env);
  if (attemptOverride) overrideSources.push(attemptOverride.source);

  return Object.freeze({
    taskId: spec.id,
    spec,
    requested,
    effective,
    allowance: effectiveAllowance,
    ceiling,
    attempts: spec.attempts,
    hardCapTokens: spec.hardCapTokens,
    timeoutMs: timeoutOverride?.value ?? spec.timeoutMs,
    attemptTimeoutMs: attemptOverride?.value ?? spec.attemptTimeoutMs,
    onExhausted: spec.onExhausted,
    structured: spec.structured,
    disableThinking,
    thinkingBudget: !disableThinking && budgetKnob ? allowance : null,
    overrideSources,
  });
}

/** 升级阶梯：第 n 次尝试的预算（首项恒等于 base effective），越界返回 null。 */
export function budgetForAttempt(budget, attemptNumber = 1) {
  const multiplier = budget.attempts[attemptNumber - 1];
  if (multiplier == null) return null;
  const effective = Math.min(budget.effective * multiplier, budget.ceiling);
  return Object.freeze({ ...budget, attempt: attemptNumber, effective,
    allowance: Math.max(0, effective - budget.requested) });
}
