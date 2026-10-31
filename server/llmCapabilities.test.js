// llmCapabilities.test.js — 能力档案结构、保守默认与命名预填。
//
// 对应 change `agent-budget-and-response-contract` 任务 1.1 / 1.2。
// Run: node --test server/llmCapabilities.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNKNOWN_CAPABILITY, capabilityFromEndpoint, deriveFamilyPrefill,
  nativeStructuredForm, normalizeCapability,
} from './llmCapabilities.js';

test('未知能力保守且冻结：不能关思考、无旋钮、不猜结构化', () => {
  assert.equal(UNKNOWN_CAPABILITY.family, 'unknown');
  assert.equal(UNKNOWN_CAPABILITY.thinking.canDisable, null, '未证实不臆断');
  assert.equal(UNKNOWN_CAPABILITY.thinking.budgetKnob, null);
  assert.equal(UNKNOWN_CAPABILITY.structuredOutput, 'none');
  assert.equal(UNKNOWN_CAPABILITY.caps.maxOutputTokens, null);
  assert.equal(Object.isFrozen(UNKNOWN_CAPABILITY), true);
});

test('normalizeCapability：合法字段原样，坏字段回落 unknown 而不是猜测', () => {
  const good = normalizeCapability({
    family: 'deepseek',
    thinking: { default: 'on', canDisable: true, budgetKnob: 'thinking_budget', budgetRange: [1024, 8192] },
    structuredOutput: 'json_object',
    caps: { maxOutputTokens: 8192, contextWindow: 128000 },
    price: { inputPerMTok: 1, outputPerMTok: 2 },
    source: 'probe',
  });
  assert.equal(good.thinking.budgetKnob, 'thinking_budget');
  assert.deepEqual(good.thinking.budgetRange, [1024, 8192]);
  assert.equal(good.source, 'probe');

  const bad = normalizeCapability({
    family: 42,
    thinking: { default: 'sometimes', canDisable: 'yes', budgetKnob: 'magic', budgetRange: [5] },
    structuredOutput: 'xml',
    caps: { maxOutputTokens: -3 },
    source: 'guess',
  });
  assert.equal(bad.family, 'unknown');
  assert.equal(bad.thinking.default, 'unknown');
  assert.equal(bad.thinking.canDisable, null, '坏值回落未证实，不臆断');
  assert.equal(bad.thinking.budgetKnob, null);
  assert.equal(bad.thinking.budgetRange, null);
  assert.equal(bad.structuredOutput, 'none');
  assert.equal(bad.caps.maxOutputTokens, null);
  assert.equal(bad.source, 'unknown');

  assert.deepEqual(normalizeCapability(), UNKNOWN_CAPABILITY, '空输入 == 保守默认');
  assert.deepEqual(normalizeCapability(null), UNKNOWN_CAPABILITY);
});

test('deriveFamilyPrefill：只给命名明确的家族建议，含糊子串不猜', () => {
  assert.equal(deriveFamilyPrefill('deepseek-chat').family, 'deepseek');
  assert.equal(deriveFamilyPrefill('agent/deepseek/deepseek-v4.1-flash').family, 'deepseek');
  assert.equal(deriveFamilyPrefill('glm-5.3').family, 'glm');
  assert.equal(deriveFamilyPrefill('claude-sonnet-4').thinking.budgetKnob, 'thinking_budget');
  assert.equal(deriveFamilyPrefill('gemini-2.5-pro').family, 'gemini');
  assert.equal(deriveFamilyPrefill('deepseek-chat', 'http://gateway.test/v1').family, 'deepseek');
  assert.equal(deriveFamilyPrefill('my-deepseek-chat'), null, 'deepseekish 不猜');
  assert.equal(deriveFamilyPrefill('deepseekish-chat'), null);
  assert.equal(deriveFamilyPrefill('agent-model'), null);
  assert.equal(deriveFamilyPrefill('qwen-max'), null, '未收录家族一律 null');
});

test('capabilityFromEndpoint：显式档案优先；过渡桥只保留 DeepSeek 既有判定', () => {
  const explicit = capabilityFromEndpoint({
    model: 'some-model',
    capability: { family: 'custom', thinking: { canDisable: false }, source: 'user' },
  });
  assert.equal(explicit.source, 'user');
  assert.equal(explicit.family, 'custom');

  const byName = capabilityFromEndpoint({ model: 'gateway/deepseek/deepseek-v4.1-flash', baseUrl: 'http://gw/v1' });
  assert.equal(byName.thinking.canDisable, true, '明确 DeepSeek 模型 ID 沿用既有可关判定');

  const byHost = capabilityFromEndpoint({ model: 'anything', baseUrl: 'https://api.deepseek.com' });
  assert.equal(byHost.thinking.canDisable, true, '官方域名沿用既有判定');

  const unknown = capabilityFromEndpoint({ model: 'glm-5.3', baseUrl: 'http://gw/v1' });
  assert.equal(unknown, UNKNOWN_CAPABILITY, '其它模型保持保守默认，不再命名猜测');
});

test('nativeStructuredForm：只有档案声明形态才走原生结构化', () => {
  assert.equal(nativeStructuredForm(normalizeCapability({ structuredOutput: 'json_object' })), 'json_object');
  assert.equal(nativeStructuredForm(normalizeCapability({ structuredOutput: 'json_schema' })), 'json_schema');
  assert.equal(nativeStructuredForm(normalizeCapability({ structuredOutput: 'tool_force' })), 'tool_force');
  assert.equal(nativeStructuredForm(UNKNOWN_CAPABILITY), null);
  assert.equal(nativeStructuredForm(null), null);
});
