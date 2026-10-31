// llmProbe.test.js — 能力探测：四组最小请求的行为判定（任务 1.5b）。
//
// 用脚本化的假网关（按补丁字段决定接受/拒绝/是否仍在思考），验证探测结论与
// "被拒 ≠ 模型故障"、"观察不到保持 unknown" 的原则。
// Run: node --test server/llmProbe.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { probeModelCapability, isParameterRejection } from './llmProbe.js';

const ok = result => ({ ok: true, status: 200, detail: null, result });
const rejected = detail => ({ ok: false, status: 400, detail, result: null });
const textOk = (content, extra = {}) => ok({
  message: { role: 'assistant', content, tool_calls: null },
  finishReason: 'stop', usage: { prompt_tokens: 8, completion_tokens: 4 }, reasoning: null, reasoningTokens: null, ...extra,
});

/** 记录每次请求的补丁效果；responder 决定行为。 */
function scriptedAttempt(responder) {
  const calls = [];
  const attempt = async ({ patch, messages }) => {
    const body = {};
    if (typeof patch === 'function') patch(body, { api: 'openai-completions' });
    const call = { body, messages: messages || null };
    calls.push(call);
    return responder(call, calls.length);
  };
  attempt.calls = calls;
  return attempt;
}

test('DeepSeek 风格网关：思考可见、关闭被无视、有 reasoning_effort、支持 json_object', async () => {
  const attempt = scriptedAttempt(call => {
    const disableSent = call.body.thinking?.type === 'disabled';
    if (disableSent) {
      // 网关忽略未知字段：没有 400，但模型仍在思考 → 判定"关闭被无视"。
      return textOk('正常', { reasoning: '我在想', reasoningTokens: 20 });
    }
    if ('reasoning_effort' in call.body) return textOk('正常');
    if (call.body.response_format?.type === 'json_schema') return rejected('unknown field response_format.json_schema');
    if (call.body.response_format?.type === 'json_object') return textOk('{"ok":true}');
    return textOk('正常', { reasoning: '思考一下', reasoningTokens: 15 });
  });
  const { capability, probedAt, observations } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' },
    attempt,
  });
  assert.equal(capability.thinking.default, 'on');
  assert.equal(capability.thinking.canDisable, false, '发了关闭参数但仍在思考 = 关不掉');
  assert.equal(capability.thinking.budgetKnob, 'reasoning_effort');
  assert.equal(capability.structuredOutput, 'json_object', 'json_schema 被拒后回落 json_object');
  assert.equal(capability.source, 'probe');
  assert.ok(Date.parse(probedAt) > 0, 'probedAt 由调用方随档案持久化');
  assert.deepEqual(observations.map(o => [o.probe, o.outcome || null]),
    [['baseline', null], ['thinking.disable', 'ignored'], ['thinking.budget', 'accepted'], ['structured', 'rejected'], ['structured', 'accepted']]);
});

test('普通网关（无思考、拒绝所有私有参数）：观察不到就保持 unknown/保守', async () => {
  const attempt = scriptedAttempt(call => {
    if (call.body.thinking || call.body.reasoning_effort || call.body.response_format) {
      return rejected('unsupported parameter');
    }
    return textOk('正常');
  });
  const { capability } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'plain', api: 'openai-completions' },
    attempt,
  });
  assert.equal(capability.thinking.default, 'unknown', '没观察到思考不等于关闭思考');
  assert.equal(capability.thinking.canDisable, false, '400 拒绝关闭参数 = 不能关（不是模型故障）');
  assert.equal(capability.thinking.budgetKnob, null);
  assert.equal(capability.structuredOutput, 'none');
});

test('支持关闭思考的网关：关闭后没有思考 → canDisable true；google 走 thinkingBudget', async () => {
  const attempt = scriptedAttempt(call => {
    if (call.body.thinking?.type === 'disabled') return textOk('正常');
    if ('reasoning_effort' in call.body) return rejected('unsupported parameter: reasoning_effort');
    return textOk('正常', { reasoning: '想了一下', reasoningTokens: 9 });
  });
  const { capability } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' },
    attempt,
  });
  assert.equal(capability.thinking.canDisable, true);
  assert.equal(capability.thinking.budgetKnob, null, 'openai-completions 的 budget 候选被拒 → 无旋钮');

  // google：thinkingConfig 候选接受、responseMimeType 接受。
  const googleAttempt = scriptedAttempt(call => {
    if (call.body.generationConfig?.thinkingConfig) return textOk('正常');
    if (call.body.generationConfig?.responseSchema) return rejected('unsupported: responseSchema');
    if (call.body.generationConfig?.responseMimeType) return textOk('{"ok":true}');
    return textOk('正常', { reasoning: '思考' });
  });
  const google = await probeModelCapability({
    endpoint: { baseUrl: 'http://g/v1beta', model: 'gemini-x', api: 'google-generative-ai' },
    attempt: googleAttempt,
  });
  assert.equal(google.capability.thinking.canDisable, true, 'thinkingBudget:0 被接受且无思考');
  assert.equal(google.capability.thinking.budgetKnob, 'thinking_budget');
  assert.equal(google.capability.structuredOutput, 'json_object', 'responseSchema 被拒后回落 responseMimeType');
});

test('anthropic：强制工具探测结构化（tool_force）', async () => {
  const attempt = scriptedAttempt(call => {
    if (call.body.tool_choice?.name === 'probe_output') {
      return ok({ message: { role: 'assistant', content: '',
        tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'probe_output', arguments: '{"ok":true}' } }] },
        finishReason: 'tool_calls', usage: null, reasoning: null, reasoningTokens: null });
    }
    return ok({ message: { role: 'assistant', content: '正常', tool_calls: null },
      finishReason: 'stop', usage: null, reasoning: null, reasoningTokens: null });
  });
  const { capability, observations } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'claude-x', api: 'anthropic-messages' },
    attempt,
  });
  assert.equal(capability.structuredOutput, 'tool_force');
  assert.equal(capability.thinking.canDisable, undefined, 'anthropic 没有通用关闭形态：不写结论（部分事实）');
  assert.equal(capability.thinking.budgetKnob, 'thinking_budget');
  assert.equal(observations.find(o => o.probe === 'structured').outcome, 'accepted');
});

test('基线不可达：抛 LLM_PROBE_UNREACHABLE，且不产生任何结论', async () => {
  const attempt = async () => ({ ok: false, status: null, detail: 'transport failed', result: null });
  await assert.rejects(() => probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }, attempt,
  }), error => error?.code === 'LLM_PROBE_UNREACHABLE');
});

test('基线被 401 拒绝：错误带状态但不冒充能力结论', async () => {
  const attempt = async () => ({ ok: false, status: 401, detail: 'invalid key', result: null });
  await assert.rejects(() => probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }, attempt,
  }), error => error?.code === 'LLM_PROBE_BASELINE_FAILED' && error.status === 401);
});

test('isParameterRejection：400/422 即参数不可用（文案不认识也算）；限流/服务错误不算', () => {
  assert.equal(isParameterRejection({ status: 400, detail: 'unknown field: thinking' }), true);
  assert.equal(isParameterRejection({ status: 400, detail: 'Bad Request' }), true, '文案不含关键词的 400 同样归因到候选参数');
  assert.equal(isParameterRejection({ status: 422, detail: 'Unsupported parameter' }), true);
  assert.equal(isParameterRejection({ status: 429, detail: 'unknown field' }), false);
  assert.equal(isParameterRejection({ status: 500, detail: 'unknown' }), false);
  assert.equal(isParameterRejection({ status: null, detail: 'transport failed' }), false);
});

// ============================================================
// 审查缺口修复（2026-10-16）：思考 token 证据、严格 schema、参数合法性与部分事实
// ============================================================

test('只有 reasoning token、没有思考正文：不能据此声称“关闭生效”', async () => {
  const attempt = async ({ patch }) => {
    const body = {};
    typeof patch === 'function' && patch(body);
    // 无论发不发关闭参数，都只给 reasoning token、没有正文。
    return { ok: true, status: 200, detail: null, result: {
      message: { role: 'assistant', content: '', tool_calls: null }, finishReason: 'stop',
      usage: { prompt_tokens: 5, completion_tokens: 80 }, reasoning: null, reasoningTokens: 87,
    } };
  };
  const { capability } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'hidden-thinking', api: 'openai-completions' }, attempt,
  });
  assert.equal(capability.thinking.default, 'on', 'reasoning token 也是思考证据');
  assert.equal(capability.thinking.canDisable, false, '关闭后仍在消耗思考 token → 关不掉');
});

test('forced tool 参数损坏：不写结构化支持', async () => {
  const attempt = async ({ patch }) => {
    const body = {};
    typeof patch === 'function' && patch(body);
    if (body.tool_choice?.name === 'probe_output') {
      return { ok: true, status: 200, detail: null, result: {
        message: { role: 'assistant', content: '',
          tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'probe_output', arguments: '{invalid' } }] },
        finishReason: 'tool_calls', usage: null, reasoning: null, reasoningTokens: null,
      } };
    }
    return { ok: true, status: 200, detail: null, result: {
      message: { role: 'assistant', content: '正常', tool_calls: null }, finishReason: 'stop', usage: null, reasoning: null, reasoningTokens: null,
    } };
  };
  const { capability, observations } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'claude-x', api: 'anthropic-messages' }, attempt,
  });
  assert.equal('structuredOutput' in capability, false, '坏 JSON 不写结论（保留旧档案）');
  assert.equal(observations.find(o => o.probe === 'structured').outcome, 'inconclusive');
});

test('anthropic 思考预算候选自身参数合法：max_tokens 必须大于 budget_tokens 且 temperature=1', async () => {
  const seen = [];
  const attempt = async ({ patch, maxTokens }) => {
    const body = { max_tokens: maxTokens, temperature: 0 };
    typeof patch === 'function' && patch(body);
    seen.push({ maxTokens: body.max_tokens, temperature: body.temperature, thinking: body.thinking || null });
    // 网关按协议约束校验：违反就 400。
    if (body.thinking?.type === 'enabled' && !(body.max_tokens > body.thinking.budget_tokens && body.temperature === 1)) {
      return { ok: false, status: 400, detail: 'thinking requires temperature=1 and max_tokens > budget_tokens', result: null };
    }
    return { ok: true, status: 200, detail: null, result: {
      message: { role: 'assistant', content: '正常', tool_calls: null }, finishReason: 'stop', usage: null, reasoning: '想了', reasoningTokens: 5,
    } };
  };
  const { capability } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'claude-x', api: 'anthropic-messages' }, attempt,
  });
  assert.equal(capability.thinking.budgetKnob, 'thinking_budget', '合法参数组合被接受');
  const budgetCall = seen.find(call => call.thinking);
  assert.ok(budgetCall.maxTokens > budgetCall.thinking.budget_tokens, 'max_tokens 大于 budget_tokens');
  assert.equal(budgetCall.temperature, 1);
});

test('暂时性失败（500）保持未知：不写 canDisable、不写旋钮，但保留确定性结论', async () => {
  const attempt = async ({ patch, probeKind }) => {
    const body = {};
    typeof patch === 'function' && patch(body);
    if (probeKind === 'thinking.disable' || probeKind === 'thinking.budget') {
      return { ok: false, status: 503, detail: 'upstream busy', result: null };
    }
    if (body.response_format?.type === 'json_object') {
      return { ok: true, status: 200, detail: null, result: {
        message: { role: 'assistant', content: '{"ok":true}', tool_calls: null }, finishReason: 'stop', usage: null, reasoning: null, reasoningTokens: null,
      } };
    }
    if (body.response_format) return { ok: false, status: 400, detail: 'unsupported', result: null };
    return { ok: true, status: 200, detail: null, result: {
      message: { role: 'assistant', content: '正常', tool_calls: null }, finishReason: 'stop', usage: null, reasoning: null, reasoningTokens: null,
    } };
  };
  const { capability } = await probeModelCapability({
    endpoint: { baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }, attempt,
  });
  assert.equal('canDisable' in capability.thinking, false, '暂时性失败不写关闭结论');
  assert.equal('budgetKnob' in capability.thinking, false, '暂时性失败不写旋钮结论');
  assert.equal(capability.structuredOutput, 'json_object', '确定性结论照常写入');
});
