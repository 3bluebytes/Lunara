// llmTasks.test.js — 任务预算规格注册表：校验、生效额度三态、覆盖层优先级。
//
// 对应 change `agent-budget-and-response-contract` 任务 2.1 / 2.3 / 2.4。
// Run: node --test server/llmTasks.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_REASONING_ALLOWANCE_TOKENS, LLM_TASKS, budgetForAttempt, envOverride,
  resolveTaskBudget, resolveTaskSpec, validateTaskSpec,
} from './llmTasks.js';
import { UNKNOWN_CAPABILITY, normalizeCapability } from './llmCapabilities.js';

test('内置规格全部通过校验；坏规格如实抛错', () => {
  for (const [id, spec] of Object.entries(LLM_TASKS)) {
    assert.equal(validateTaskSpec(id, spec), true, id);
  }
  const base = { id: 'x', answerTokens: 100, reasoning: 'neutral', structured: 'text', attempts: [1, 2], hardCapTokens: 1000, timeoutMs: null, onExhausted: 'typed_failure' };
  assert.throws(() => validateTaskSpec('x', { ...base, attempts: [2] }), /attempts/);
  assert.throws(() => validateTaskSpec('x', { ...base, attempts: [1, 1] }), /attempts/);
  assert.throws(() => validateTaskSpec('x', { ...base, reasoning: 'maybe' }), /reasoning/);
  assert.throws(() => validateTaskSpec('x', { ...base, structured: 'xml' }), /structured/);
  assert.throws(() => validateTaskSpec('x', { ...base, onExhausted: 'retry_forever' }), /onExhausted/);
  assert.throws(() => validateTaskSpec('x', { ...base, answerTokens: 0 }), /answerTokens/);
  assert.throws(() => validateTaskSpec('x', { ...base, id: 'y' }), /id mismatch/);
});

test('resolveTaskSpec：已知任务返回冻结规格；未知任务如实抛错', () => {
  assert.equal(resolveTaskSpec('song_tag').id, 'song_tag');
  assert.equal(Object.isFrozen(resolveTaskSpec('narration')), true);
  assert.throws(() => resolveTaskSpec('not_a_task'), /unknown LLM task/);
  assert.throws(() => resolveTaskSpec(''), /unknown LLM task/);
});

test('未声明任务：无 taskId 走 unspecified（旧默认 2048 + 思考余量），未知 id 抛错', () => {
  const budget = resolveTaskBudget({});
  assert.equal(budget.taskId, 'unspecified');
  assert.equal(budget.requested, 2048);
  assert.equal(budget.effective, 2048 + DEFAULT_REASONING_ALLOWANCE_TOKENS);
  assert.throws(() => resolveTaskBudget({ taskId: 'nope' }), /unknown LLM task/);
});

test('未知能力：输出额度 = 正文 + 思考余量，不假设思考免费', () => {
  const budget = resolveTaskBudget({ taskId: 'song_tag' });
  assert.equal(budget.requested, 1500);
  assert.equal(budget.allowance, DEFAULT_REASONING_ALLOWANCE_TOKENS);
  assert.equal(budget.effective, 1500 + DEFAULT_REASONING_ALLOWANCE_TOKENS);
  assert.equal(budget.disableThinking, false, '未知不能关闭：不发厂商私有参数');
  assert.equal(budget.overrideSources.length, 0);
});

test('思考有帮助的任务：即使调用方请求 disabled 也不关闭，且保留思考余量', () => {
  const capable = normalizeCapability({ thinking: { canDisable: true }, source: 'user' });
  for (const taskId of ['chat_dialogue', 'music_selection', 'narration']) {
    const budget = resolveTaskBudget({ taskId, capability: capable, thinkingMode: 'disabled' });
    assert.equal(budget.disableThinking, false, taskId);
    assert.equal(budget.allowance, DEFAULT_REASONING_ALLOWANCE_TOKENS, taskId);
    assert.equal(budget.effective, resolveTaskSpec(taskId).answerTokens + DEFAULT_REASONING_ALLOWANCE_TOKENS, taskId);
  }
});

test('机械任务 + 档案可关思考：关闭并只给正文额度（成本选择）', () => {
  const capable = normalizeCapability({ thinking: { canDisable: true }, source: 'user' });
  const budget = resolveTaskBudget({ taskId: 'song_tag', capability: capable, thinkingMode: 'disabled' });
  assert.equal(budget.disableThinking, true);
  assert.equal(budget.allowance, 0);
  assert.equal(budget.effective, 1500);
  // 未请求关闭时不主动关：默认仍留余量。
  const unasked = resolveTaskBudget({ taskId: 'song_tag', capability: capable });
  assert.equal(unasked.disableThinking, false);
  assert.equal(unasked.effective, 1500 + DEFAULT_REASONING_ALLOWANCE_TOKENS);
});

test('原生思考预算旋钮：旋钮值取思考余量并 clamp 到范围；输出额度仍含余量（协议安全）', () => {
  const capable = normalizeCapability({
    thinking: { default: 'on', canDisable: true, budgetKnob: 'thinking_budget', budgetRange: [2048, 4096] },
    source: 'probe',
  });
  const budget = resolveTaskBudget({ taskId: 'narration', capability: capable });
  assert.equal(budget.thinkingBudget, 2048, '默认余量 1024 低于下限，clamp 到 2048');
  assert.equal(budget.effective, 1024 + 2048, '输出上限仍按正文 + 余量给，协议侧再受旋钮约束');
});

test('覆盖层：显式参数与环境覆盖给出生效总额，不再追加余量；优先级 显式 > env', () => {
  const explicit = resolveTaskBudget({ taskId: 'song_tag', maxTokens: 512, env: { SONG_TAG_MAX_TOKENS: '2500' } });
  assert.equal(explicit.effective, 512);
  assert.equal(explicit.allowance, 0);
  assert.deepEqual(explicit.overrideSources, ['explicit:maxTokens']);

  const fromEnv = resolveTaskBudget({ taskId: 'song_tag', env: { SONG_TAG_MAX_TOKENS: '2500' } });
  assert.equal(fromEnv.requested, 2500);
  assert.equal(fromEnv.effective, 2500);
  assert.deepEqual(fromEnv.overrideSources, ['env:SONG_TAG_MAX_TOKENS']);

  assert.equal(envOverride('song_tag', 'answerTokens', { SONG_TAG_MAX_TOKENS: 'abc' }), null, '坏值回落规格');
  assert.equal(envOverride('song_tag', 'answerTokens', { SONG_TAG_MAX_TOKENS: '0' }), null);
  assert.equal(envOverride('song_tag', 'answerTokens', { SONG_TAG_MAX_TOKENS: '99999' }).value, 8192, '越界 clamp');
  assert.equal(envOverride('narration', 'answerTokens', { SONG_TAG_MAX_TOKENS: '2500' }), null, 'env 只作用于声明过覆盖的任务');
});

test('上限：hardCap 与模型输出上限取小；思考余量 env 可覆盖', () => {
  const smallModel = normalizeCapability({ caps: { maxOutputTokens: 3000 }, source: 'probe' });
  const budget = resolveTaskBudget({ taskId: 'chat_dialogue', capability: smallModel });
  assert.equal(budget.effective, 3000, '3072 被模型上限 3000 截断');

  const probeCapped = resolveTaskBudget({ taskId: 'connectivity_probe' });
  assert.equal(probeCapped.effective, 1024 + DEFAULT_REASONING_ALLOWANCE_TOKENS);

  const generous = resolveTaskBudget({ taskId: 'song_tag', env: { LLM_REASONING_ALLOWANCE_TOKENS: '2048' } });
  assert.equal(generous.allowance, 2048);

  const zero = resolveTaskBudget({ taskId: 'song_tag', env: { LLM_REASONING_ALLOWANCE_TOKENS: '0' } });
  assert.equal(zero.effective, 1500, '允许显式把余量置 0（成本选择）');
});

test('超时：规格声明 + env 覆盖', () => {
  assert.equal(resolveTaskBudget({ taskId: 'song_tag' }).timeoutMs, 30_000);
  assert.equal(resolveTaskBudget({ taskId: 'chat_dialogue' }).timeoutMs, null, '未声明则跟随 LLM_TIMEOUT_MS');
  const env = resolveTaskBudget({ taskId: 'song_tag', env: { SONG_TAG_TIMEOUT_MS: '5000' } });
  assert.equal(env.timeoutMs, 5000);
  assert.ok(env.overrideSources.includes('env:SONG_TAG_TIMEOUT_MS'));
  const reflection = resolveTaskBudget({ taskId: 'reflection', env: { REFLECTION_LLM_TIMEOUT_MS: '20000' } });
  assert.equal(reflection.timeoutMs, 20_000);
});

test('升级阶梯：第 2 次尝试 ×2、受 ceiling 约束；单步任务没有第二次', () => {
  const budget = resolveTaskBudget({ taskId: 'song_tag' });
  assert.equal(budgetForAttempt(budget, 1).effective, budget.effective);
  assert.equal(budgetForAttempt(budget, 2).effective, (1500 + DEFAULT_REASONING_ALLOWANCE_TOKENS) * 2);
  assert.equal(budgetForAttempt(budget, 2).allowance, 5048 - 1500, '升级后的余量随额度增大');
  assert.equal(budgetForAttempt(budget, 3), null);

  const capped = resolveTaskBudget({ taskId: 'capability_probe', maxTokens: 8192 });
  assert.equal(capped.effective, 8192);
  assert.equal(budgetForAttempt(capped, 2).effective, 8192, '到硬上限后升级不再放大');

  const probe = resolveTaskBudget({ taskId: 'connectivity_probe' });
  assert.equal(budgetForAttempt(probe, 2), null, '探针失败本身就是测量结果，不升级');

  const overridden = resolveTaskBudget({ taskId: 'song_tag', maxTokens: 2500 });
  assert.equal(budgetForAttempt(overridden, 2).effective, 5000, '覆盖层同样按阶梯升级');
});

test('规格自检覆盖全部内置任务的关键字段', () => {
  for (const id of ['chat_dialogue', 'music_selection', 'narration', 'song_tag', 'reflection',
    'taste_schema', 'taste_consolidation', 'persona_generation',
    'connectivity_probe']) {
    assert.ok(LLM_TASKS[id], id);
    assert.equal(LLM_TASKS[id].attempts[0], 1, id);
    assert.ok(LLM_TASKS[id].answerTokens > 0, id);
  }
  assert.equal(UNKNOWN_CAPABILITY.thinking.canDisable, null, '未证实 = 不发厂商私有参数');
});

test('presence_utterance 规格：短、单次、可沉默，超时即跳过', () => {
  const spec = resolveTaskSpec('presence_utterance');
  assert.equal(spec.answerTokens, 512);
  assert.equal(spec.reasoning, 'light');
  assert.equal(spec.structured, 'tool');
  assert.deepEqual(spec.attempts, [1]);
  assert.equal(spec.timeoutMs, 12_000);
  assert.equal(spec.onExhausted, 'skip');
  assert.ok(spec.answerTokens <= spec.hardCapTokens);
});

test('ambient_turn 规格：一轮带完整上下文的主动唤醒，单次、可安静，超时即跳过', () => {
  const spec = resolveTaskSpec('ambient_turn');
  assert.equal(spec.answerTokens, 1024);
  assert.equal(spec.reasoning, 'light');
  assert.equal(spec.structured, 'tool');
  assert.deepEqual(spec.attempts, [1]);
  assert.equal(spec.timeoutMs, 20_000);
  assert.equal(spec.onExhausted, 'skip');
  assert.ok(spec.answerTokens <= spec.hardCapTokens);
});

test('单次请求上限：chat_dialogue 60s、music_selection 30s，其余为 null；env 覆盖 clamp、坏值回落', () => {
  assert.equal(resolveTaskBudget({ taskId: 'chat_dialogue' }).attemptTimeoutMs, 60_000);
  assert.equal(resolveTaskBudget({ taskId: 'music_selection' }).attemptTimeoutMs, 30_000);
  for (const id of ['narration', 'song_tag', 'ambient_turn', 'unspecified']) {
    assert.equal(resolveTaskBudget({ taskId: id }).attemptTimeoutMs, null, id);
  }
  const chat = resolveTaskBudget({ taskId: 'chat_dialogue', env: { CHAT_ATTEMPT_TIMEOUT_MS: '45000' } });
  assert.equal(chat.attemptTimeoutMs, 45_000);
  assert.ok(chat.overrideSources.includes('env:CHAT_ATTEMPT_TIMEOUT_MS'));
  assert.equal(resolveTaskBudget({ taskId: 'chat_dialogue', env: { CHAT_ATTEMPT_TIMEOUT_MS: '10' } }).attemptTimeoutMs, 5_000);
  assert.equal(resolveTaskBudget({ taskId: 'chat_dialogue', env: { CHAT_ATTEMPT_TIMEOUT_MS: 'x' } }).attemptTimeoutMs, 60_000);
  assert.equal(resolveTaskBudget({ taskId: 'music_selection', env: { MUSIC_SELECTION_ATTEMPT_TIMEOUT_MS: '20000' } })
    .attemptTimeoutMs, 20_000);
  assert.throws(() => validateTaskSpec('x', { id: 'x', answerTokens: 100, reasoning: 'neutral', structured: 'text',
    attempts: [1], hardCapTokens: 1000, timeoutMs: null, attemptTimeoutMs: 0, onExhausted: 'typed_failure' }), /attemptTimeoutMs/);
});
