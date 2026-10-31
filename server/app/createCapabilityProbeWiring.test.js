// createCapabilityProbeWiring.test.js — 探测自动化接线：保存后探测、惰性补探测、负缓存合并。
//
// 对应 change `agent-budget-and-response-contract` 任务 1.5/1.5b/1.6/1.6a。
// Run: node --test server/app/createCapabilityProbeWiring.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityProbeWiring } from './createCapabilityProbeWiring.js';
import { setCapabilityObserver } from '../llm.js';

const silentLogger = { warn() {}, info() {}, error() {} };

function harness({ probeImpl } = {}) {
  const calls = [];
  const saved = new Map();
  const wiring = createCapabilityProbeWiring({
    logger: silentLogger,
    probe: probeImpl || (async ({ endpoint }) => {
      calls.push(endpoint.model);
      return { capability: { source: 'probe', thinking: { canDisable: true } }, probedAt: '2026-10-15T00:00:00.000Z', observations: [] };
    }),
    readCapability: async ({ providerId, model }) => saved.get(`${providerId}:${model}`) || null,
    record: async ({ providerId, model, capability, source, overwrite }) => {
      const key = `${providerId}:${model}`;
      const existing = saved.get(key) || null;
      if (!overwrite && existing?.source === 'user') return existing;
      const next = { ...capability, source, probedAt: '2026-10-15T00:00:00.000Z' };
      saved.set(key, next);
      return next;
    },
    resolveEndpoint: async ({ providerId, model }) => ({ baseUrl: 'http://gw/v1', model, api: 'openai-completions', providerId }),
  });
  return { wiring, calls, saved };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test('保存后自动探测：只探测尚无档案的模型，单次有界', async () => {
  const { wiring, calls, saved } = harness();
  saved.set('p:has-archive', { source: 'user' });
  wiring.scheduleAfterSave({ providerId: 'p', models: ['has-archive', 'm1', 'm2', 'm3', 'm4'] });
  await flush();
  assert.deepEqual(calls, ['m1', 'm2', 'm3'], '已有档案跳过；单次最多 3 个，不阻塞返回');
  assert.equal(saved.get('p:m1').source, 'probe');
});

test('惰性补探测：每进程每模型一次；已有持久档案不触发；过渡桥来源标记不阻止探测', async () => {
  const { wiring, calls, saved } = harness();
  saved.set('p:known', { source: 'user', thinking: { canDisable: true } });
  wiring.maybeLazyProbe({ phase: 'start', providerId: 'p', model: 'm1' });
  wiring.maybeLazyProbe({ phase: 'start', providerId: 'p', model: 'm1' });
  wiring.maybeLazyProbe({ phase: 'end', providerId: 'p', model: 'm2' });
  wiring.maybeLazyProbe({ phase: 'start', providerId: 'p', model: 'known' });
  // E2E 实测：DeepSeek 过渡桥把未知模型标成 observed；不能因此跳过真正的探测。
  wiring.maybeLazyProbe({ phase: 'start', providerId: 'p', model: 'bridged', capabilitySource: 'observed' });
  await flush();
  assert.deepEqual(calls, ['m1', 'bridged'], '非 start 相位不触发；已有档案与同模型去重；桥接来源仍探测');
});

test('负缓存事实并入档案；不覆盖用户显式声明', async () => {
  const saved = new Map();
  saved.set('p:declared', { source: 'user', thinking: { canDisable: true } });
  const wiring = createCapabilityProbeWiring({
    logger: silentLogger,
    probe: async () => ({ capability: {}, probedAt: null, observations: [] }),
    readCapability: async ({ providerId, model }) => saved.get(`${providerId}:${model}`) || null,
    record: async ({ providerId, model, capability, source, overwrite }) => {
      const key = `${providerId}:${model}`;
      const existing = saved.get(key) || null;
      if (!overwrite && existing?.source === 'user') return existing;
      saved.set(key, { ...capability, source });
      return saved.get(key);
    },
    resolveEndpoint: async () => null,
  });
  // 等价于 llm.js 上报"关闭参数被拒/被无视"。
  wiring.applyObservedFact({ providerId: 'p', model: 'fresh', api: 'openai-completions', thinking: { canDisable: false } });
  wiring.applyObservedFact({ providerId: 'p', model: 'declared', api: 'openai-completions', thinking: { canDisable: false } });
  await flush();
  assert.equal(saved.get('p:fresh').thinking.canDisable, false);
  assert.equal(saved.get('p:fresh').source, 'observed');
  assert.equal(saved.get('p:declared').thinking.canDisable, true, '用户声明优先，观测事实不静默改写');
});

test('探测在用户声明之后提交：不覆盖用户声明（自动结论一律 overwrite:false）', async () => {
  const saved = new Map([['p:m', { source: 'user', thinking: { canDisable: false }, probedAt: null }]]);
  const wiring = createCapabilityProbeWiring({
    logger: silentLogger,
    probe: async () => ({ capability: { thinking: { canDisable: true } }, probedAt: '2026-10-16T00:00:00.000Z', observations: [] }),
    readCapability: async ({ providerId, model }) => saved.get(`${providerId}:${model}`) || null,
    record: async ({ providerId, model, capability, source, overwrite }) => {
      const key = `${providerId}:${model}`;
      const existing = saved.get(key) || null;
      if (!overwrite && existing?.source === 'user') return existing;
      saved.set(key, { ...capability, source });
      return saved.get(key);
    },
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }),
  });
  // 用户点“探测”也一样：手动触发不能悄悄改写手动声明。
  await wiring.probeNow({ providerId: 'p', model: 'm', force: true });
  assert.deepEqual([saved.get('p:m').source, saved.get('p:m').thinking.canDisable], ['user', false]);
});
