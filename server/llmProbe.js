// llmProbe.js — 能力探测：用数 token 级请求做行为判定（任务 1.5b，审查修复 2026-10-16）。
//
// 四组最小请求：思考是否存在 / 能否关闭 / 能否设思考预算 / 原生结构化形态。
// 原则：
//   - 被拒（400/422）≠ 模型故障；5xx/限流/超时是暂时性故障，结论保持未知。
//   - 观察不到思考不等于“没有思考”：`default` 只有看到思考证据才写 'on'，否则显式 unknown。
//   - “能否关闭”要有证据：发了关闭参数后**没有**任何思考证据（正文或 reasoning token）
//     才能写 true；被拒或仍在思考写 false；暂时性失败保持未知（不写）。
//   - 结构化只有“产出合法且满足 schema 的 JSON（或唯一强制工具调用）”才算支持；
//     坏 JSON、空输出、被截断都省略结论，不用坏输出冒充支持。
//   - 每次探测请求都走 capability_probe 任务规格（正文 1024 + 思考余量），
//     输出受限时按阶梯升级一次；参数被拒不升级。
//   - 返回的档案是**字段级部分事实**（未确认的键不出现）：注册表按字段合并，
//     不会用未观测值覆盖已确认结论。probedAt 由调用方随档案持久化。
//
// Run: node --test server/llmProbe.test.js

import { rawChatAttempt } from './llm.js';
import { budgetForAttempt, resolveTaskBudget } from './llmTasks.js';

const JSON_PROBE_PROMPT = '只输出一个 JSON 对象：{"ok": true}。不要输出别的文字。';

const SMALL_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
});

/**
 * 参数被网关拒绝：400/422 一律视为"这个参数用不了"（与 llm.js 同一判据：候选请求
 * 与基线请求的唯一差异就是候选参数）。5xx/429 是暂时性故障，结论保持 unknown。
 */
export function isParameterRejection(response) {
  const status = Number(response?.status);
  return status === 400 || status === 422;
}

/** 思考证据：可见思考正文，或（拿不到正文时的）非零 reasoning token。 */
function sawReasoning(result) {
  const text = typeof result?.reasoning === 'string' && result.reasoning.trim().length > 0;
  const tokens = Number.isInteger(result?.reasoningTokens) && result.reasoningTokens > 0;
  return text || tokens;
}

/** 协议侧候选参数：每项 { patch(body), kind }，由行为（接受/拒绝/效果）判定。 */
function disableCandidates(api) {
  if (api === 'openai-completions') return [{ patch: body => { body.thinking = { type: 'disabled' }; } }];
  if (api === 'google-generative-ai') {
    return [{ patch: body => { body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: { thinkingBudget: 0 } }; } }];
  }
  // anthropic-messages / openai-responses：没有通用的"关闭"形态，不猜。
  return [];
}

function budgetCandidates(api) {
  if (api === 'openai-completions') return [{ knob: 'reasoning_effort', patch: body => { body.reasoning_effort = 'low'; }, range: null }];
  if (api === 'openai-responses') return [{ knob: 'reasoning_effort', patch: body => { body.reasoning = { effort: 'low' }; }, range: null }];
  if (api === 'anthropic-messages') {
    return [{ knob: 'thinking_budget', range: [1024, 32768],
      // 扩展思考要求 temperature=1；max_tokens 由 capability_probe 规格给出（1024 + 余量），
      // 恒大于 budget_tokens=1024，不再构造自己的非法组合。
      patch: body => { body.thinking = { type: 'enabled', budget_tokens: 1024 }; body.temperature = 1; } }];
  }
  if (api === 'google-generative-ai') {
    return [{ knob: 'thinking_budget', range: [0, 24576],
      patch: body => { body.generationConfig = { ...(body.generationConfig || {}), thinkingConfig: { thinkingBudget: 1024 } }; } }];
  }
  return [];
}

function structuredCandidates(api) {
  if (api === 'openai-completions') {
    return [
      { form: 'json_schema', patch: body => { body.response_format = { type: 'json_schema', json_schema: { name: 'probe', schema: SMALL_JSON_SCHEMA } }; } },
      { form: 'json_object', patch: body => { body.response_format = { type: 'json_object' }; } },
    ];
  }
  if (api === 'google-generative-ai') {
    return [
      { form: 'json_schema', patch: body => { body.generationConfig = { ...(body.generationConfig || {}), responseMimeType: 'application/json', responseSchema: SMALL_JSON_SCHEMA }; } },
      { form: 'json_object', patch: body => { body.generationConfig = { ...(body.generationConfig || {}), responseMimeType: 'application/json' }; } },
    ];
  }
  if (api === 'openai-responses') {
    return [{ form: 'json_schema', patch: body => { body.text = { format: { type: 'json_schema', name: 'probe', schema: SMALL_JSON_SCHEMA } }; } }];
  }
  if (api === 'anthropic-messages') {
    return [{ form: 'tool_force', forcedTool: 'probe_output',
      patch: body => {
        body.tools = [...(body.tools || []), { name: 'probe_output', description: '返回探测结果。', input_schema: SMALL_JSON_SCHEMA }];
        body.tool_choice = { type: 'tool', name: 'probe_output' };
      } }];
  }
  return [];
}

function parseJsonObject(result) {
  const text = typeof result?.message?.content === 'string' ? result.message.content.trim() : '';
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** 严格校验探测 schema：必须是 {ok:true} 且没有多余键（坏 JSON 不算支持）。 */
function matchesSmallSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.ok !== true) return false;
  return Object.keys(value).every(key => key === 'ok');
}

/**
 * 探测一个端点的能力。`attempt` 默认 rawChatAttempt（同协议适配器、带日内守卫与记账）。
 * 基线失败（网络/401/5xx）→ 抛 LLM_PROBE_UNREACHABLE；候选参数被拒不算失败。
 *
 * @returns {{ capability: object, probedAt: string, observations: object[] }}
 *   capability 是部分事实（source 'probe'），未确认字段不出现。
 */
export async function probeModelCapability({ endpoint, attempt = rawChatAttempt, timeoutMs = 20_000 } = {}) {
  if (!endpoint?.baseUrl || !endpoint?.model) throw new TypeError('probeModelCapability requires an endpoint');
  const api = endpoint.api || 'openai-completions';
  const observations = [];
  const traceTaskId = `probe:${endpoint.providerId || 'provider'}:${endpoint.model}`;
  const budget = resolveTaskBudget({ taskId: 'capability_probe', capability: null });
  const metaFor = attemptNumber => {
    const step = budgetForAttempt(budget, attemptNumber);
    if (!step) return null;
    return {
      attemptNumber,
      maxTokens: step.effective,
      budget: { requested: budget.requested, effective: step.effective,
        allowance: step.allowance, taskId: budget.taskId, overrideSources: budget.overrideSources },
    };
  };
  const call = ({ patch = null, messages = null, probeKind, meta }) => attempt({
    endpoint, timeoutMs, patch, probeKind, traceTaskId,
    taskId: 'capability_probe', sessionId: null, taskType: 'capability_probe',
    attempt: meta.attemptNumber, maxTokens: meta.maxTokens, budget: meta.budget,
    ...(messages ? { messages } : {}),
  });
  const budgetError = response => {
    const error = new Error('LLM probe skipped: daily token budget exhausted');
    error.code = 'LLM_PROBE_BUDGET_EXHAUSTED';
    error.detail = response?.detail || null;
    return error;
  };

  /**
   * 跑一组候选：确定结论（含参数被拒）立即返回；只在“暂时性失败 / 输出不可用”时
   * 按规格阶梯升级一次，耗尽后给 inconclusive。
   */
  const runGroup = async ({ probeKind, patch = null, messages = null, verdictOf }) => {
    let lastInconclusive = null;
    for (let attemptNumber = 1; ; attemptNumber += 1) {
      const meta = metaFor(attemptNumber);
      if (!meta) break;
      const response = await call({ patch, messages, probeKind, meta });
      if (!response.ok && response.code === 'LLM_BUDGET_EXHAUSTED') throw budgetError(response);
      if (!response.ok && isParameterRejection(response)) return { kind: 'rejected', response };
      if (!response.ok) {
        // 传输错误/5xx/坏响应：暂时性——升级一次再看，仍失败保持未知。
        lastInconclusive = { kind: 'inconclusive', status: response.status, code: response.code || null };
        if (!metaFor(attemptNumber + 1)) break;
        continue;
      }
      const verdict = verdictOf(response.result, response);
      if (verdict) return { kind: 'confirmed', verdict, response };
      lastInconclusive = { kind: 'inconclusive', status: response.status, reason: 'unusable_output' };
      if (!metaFor(attemptNumber + 1)) break;
    }
    return lastInconclusive || { kind: 'inconclusive', status: null };
  };

  // 1) 基线：连通性 + 思考是否可见。基线失败不是能力结论，而是“探不了”。
  const baseline = await call({ probeKind: 'baseline', meta: metaFor(1) });
  if (!baseline.ok && baseline.code === 'LLM_BUDGET_EXHAUSTED') throw budgetError(baseline);
  if (!baseline.ok && baseline.status == null) {
    const error = new Error('LLM probe could not reach the endpoint');
    error.code = 'LLM_PROBE_UNREACHABLE';
    throw error;
  }
  if (!baseline.ok) {
    const error = new Error(`LLM probe baseline rejected (${baseline.status})`);
    error.code = 'LLM_PROBE_BASELINE_FAILED';
    error.status = baseline.status;
    throw error;
  }
  const baselineThinking = sawReasoning(baseline.result);
  observations.push({ probe: 'baseline', ok: true, reasoning: baselineThinking });

  const capability = {
    family: 'unknown',
    protocol: api,
    thinking: {
      // 看到思考证据 → on；观察不到 → 显式 unknown（不臆断“没有思考”）。
      default: baselineThinking ? 'on' : 'unknown',
    },
    source: 'probe',
  };

  // 2) 能否关闭思考。
  for (const candidate of disableCandidates(api)) {
    const group = await runGroup({
      probeKind: 'thinking.disable', patch: candidate.patch,
      verdictOf: result => ({ canDisable: !sawReasoning(result) }),
    });
    if (group.kind === 'rejected') {
      capability.thinking.canDisable = false;
      observations.push({ probe: 'thinking.disable', outcome: 'rejected' });
    } else if (group.kind === 'confirmed') {
      capability.thinking.canDisable = group.verdict.canDisable;
      observations.push({ probe: 'thinking.disable', outcome: group.verdict.canDisable ? 'accepted' : 'ignored' });
    } else {
      observations.push({ probe: 'thinking.disable', outcome: 'inconclusive', status: group.status ?? null });
    }
    break;
  }

  // 3) 能否单独设思考预算。
  for (const candidate of budgetCandidates(api)) {
    const group = await runGroup({
      probeKind: 'thinking.budget', patch: candidate.patch, verdictOf: () => ({ knob: candidate.knob }),
    });
    if (group.kind === 'rejected') {
      // 端点明确说这个参数用不了：显式清掉（不保留旧结论的误导）。
      capability.thinking.budgetKnob = null;
      capability.thinking.budgetRange = null;
      observations.push({ probe: 'thinking.budget', outcome: 'rejected' });
    } else if (group.kind === 'confirmed') {
      capability.thinking.budgetKnob = candidate.knob;
      capability.thinking.budgetRange = candidate.range;
      observations.push({ probe: 'thinking.budget', outcome: 'accepted', knob: candidate.knob });
    } else {
      observations.push({ probe: 'thinking.budget', outcome: 'inconclusive', status: group.status ?? null });
    }
    break;
  }

  // 4) 结构化输出：能产出合法且满足 schema 的 JSON 才算支持。
  const candidates = structuredCandidates(api);
  let allRejected = candidates.length > 0;
  for (const candidate of candidates) {
    const group = await runGroup({
      probeKind: `structured.${candidate.form}`,
      patch: candidate.patch,
      messages: [{ role: 'user', content: JSON_PROBE_PROMPT }],
      verdictOf: result => {
        if (candidate.forcedTool) {
          const calls = Array.isArray(result?.message?.tool_calls) ? result.message.tool_calls : [];
          if (calls.length !== 1 || calls[0]?.function?.name !== candidate.forcedTool) return null;
          let parsed = null;
          try { parsed = JSON.parse(String(calls[0].function.arguments || '')); } catch { return null; }
          return matchesSmallSchema(parsed) ? {} : null;
        }
        const parsed = parseJsonObject(result);
        return matchesSmallSchema(parsed) ? {} : null;
      },
    });
    if (group.kind === 'confirmed') {
      capability.structuredOutput = candidate.form;
      observations.push({ probe: 'structured', form: candidate.form, outcome: 'accepted' });
      allRejected = false;
      break;
    }
    if (group.kind === 'rejected') {
      observations.push({ probe: 'structured', form: candidate.form, outcome: 'rejected' });
      continue;
    }
    allRejected = false;
    observations.push({ probe: 'structured', form: candidate.form, outcome: 'inconclusive', status: group.status ?? null });
  }
  // 所有候选都被协议明确拒绝 → 如实写 none；有任何暂时性失败 → 省略，保留旧结论。
  if (allRejected) capability.structuredOutput = 'none';

  return { capability, probedAt: new Date().toISOString(), observations };
}

export default { probeModelCapability, isParameterRejection };
