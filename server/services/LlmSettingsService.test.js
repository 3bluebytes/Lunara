// LlmSettingsService.test.js — 保存后的后台能力探测与手动探测的模型停用过滤。
// 全部使用替身 capabilityProbe，不发起真实网络请求；注册表写临时 LUNARA_CONFIG_DIR。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LlmSettingsService } from './LlmSettingsService.js';

function makeConfigDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-settings-service-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  t.after(() => {
    delete process.env.LUNARA_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeProbeStub() {
  const scheduled = [];
  const probed = [];
  return {
    scheduled,
    probed,
    probe: {
      scheduleAfterSave(input) { scheduled.push(input); },
      async probeNow(input) { probed.push(input); return { ok: true, capability: {} }; },
    },
  };
}

test('保存 Provider 后只对启用模型排后台探测', async t => {
  makeConfigDir(t);
  const { scheduled, probe } = makeProbeStub();
  const service = new LlmSettingsService({ capabilityProbe: probe });

  const created = await service.createProvider({
    name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2', 'm3'], disabledModels: ['m2'],
  });
  assert.deepEqual(scheduled[0], { providerId: created.provider.id, models: ['m1', 'm3'] },
    '停用模型不进入保存后的探测计划');

  // 全部停用 → 计划为空，不探测任何模型。
  scheduled.length = 0;
  await service.updateProvider(created.provider.id, { disabledModels: ['m1', 'm2', 'm3'] });
  assert.deepEqual(scheduled[0].models, []);

  // patch 未给 disabledModels 时沿用旧值（仍是全停用）。
  scheduled.length = 0;
  await service.updateProvider(created.provider.id, { name: 'p2' });
  assert.deepEqual(scheduled[0].models, []);

  // 重新启用后恢复全量。
  scheduled.length = 0;
  await service.updateProvider(created.provider.id, { disabledModels: [] });
  assert.deepEqual(scheduled[0].models, ['m1', 'm2', 'm3']);
});

test('手动探测停用模型被拒绝且不发起探测；启用模型照常探测', async t => {
  makeConfigDir(t);
  const { probed, probe } = makeProbeStub();
  const service = new LlmSettingsService({ capabilityProbe: probe });
  const { provider } = await service.createProvider({
    name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'], disabledModels: ['m2'],
  });

  const rejected = await service.probeCapability({ providerId: provider.id, model: 'm2' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /模型已停用/);
  assert.equal(probed.length, 0, '停用模型不发起任何探测请求');

  const allowed = await service.probeCapability({ providerId: provider.id, model: 'm1' });
  assert.equal(allowed.ok, true);
  assert.deepEqual(probed[0], { providerId: provider.id, model: 'm1', force: true });

  // 未指定 model：保持原有行为（交给探测接线决定默认模型）。
  const defaulted = await service.probeCapability({ providerId: provider.id });
  assert.equal(defaulted.ok, true);
  assert.equal(probed.length, 2);
  assert.equal(probed[1].model, null);

  // provider 不存在：保持原有行为，不在服务层虚构停用判断。
  const missing = await service.probeCapability({ providerId: 'nope', model: 'm2' });
  assert.equal(missing.ok, true);
  assert.equal(probed.length, 3);
});

/** 会话覆盖替身：记录 set 入参，get 返回存下来的对象（服务层只负责透传）。 */
function makeOverridesStub() {
  const store = new Map();
  const calls = [];
  return {
    store,
    calls,
    overrides: {
      async get(sessionId) { return store.get(sessionId) || null; },
      async set(sessionId, override) {
        calls.push(override);
        if (override) store.set(sessionId, override); else store.delete(sessionId);
        return override;
      },
    },
  };
}

test('会话模型覆盖透传 reasoningEffort，清除模型覆盖时档位一起清除', async t => {
  makeConfigDir(t);
  const { overrides, calls } = makeOverridesStub();
  const service = new LlmSettingsService({ sessionOverrides: overrides });

  const saved = await service.setSessionModel({
    sessionId: 's1', providerId: 'p1', model: 'm1', reasoningEffort: 'high',
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.override, { providerId: 'p1', model: 'm1', reasoningEffort: 'high' });
  assert.deepEqual(calls.at(-1), { providerId: 'p1', model: 'm1', reasoningEffort: 'high' },
    '档位原样透传给 overrides.set');

  // 读取原样带出档位（sessionModel 本身不加工）。
  assert.deepEqual((await service.sessionModel('s1')).override,
    { providerId: 'p1', model: 'm1', reasoningEffort: 'high' });

  // 缺省/null = 跟随模型默认：不写该字段。
  const followed = await service.setSessionModel({
    sessionId: 's1', providerId: 'p1', model: 'm1', reasoningEffort: null,
  });
  assert.deepEqual(followed.override, { providerId: 'p1', model: 'm1' });
  assert.equal('reasoningEffort' in followed.override, false, '未指定档位时不伪造字段');

  // 清除模型覆盖 → 整个覆盖（含档位）一起清除。
  const cleared = await service.setSessionModel({ sessionId: 's1' });
  assert.equal(cleared.override, null);
  assert.equal((await service.sessionModel('s1')).override, null);
  assert.deepEqual(calls.at(-1), null);
});

test('usageReport：账本不可用如实返回；可用时透传 days 并展开报告', async () => {
  const offline = new LlmSettingsService({});
  assert.deepEqual(await offline.usageReport(), { ok: false, error: '用量账本不可用' });

  const seen = [];
  const online = new LlmSettingsService({
    usageLedger: {
      report(args) {
        seen.push(args);
        return { days: args.days, retentionDays: 30, daily: [], totals: { calls: 2 } };
      },
    },
  });
  const report = await online.usageReport({ days: 7 });
  assert.deepEqual(seen, [{ days: 7 }]);
  assert.deepEqual(report, { ok: true, days: 7, retentionDays: 30, daily: [], totals: { calls: 2 } });

  const defaulted = await online.usageReport();
  assert.deepEqual(seen.at(-1), { days: 30 }, '缺省 days=30，与契约一致');
  assert.equal(defaulted.ok, true);
});

test('故障切换策略：缺省关闭、保存合法目标、非法目标返回 ok:false 且不泄漏凭据', async t => {
  makeConfigDir(t);
  const service = new LlmSettingsService({});
  const a = await service.createProvider({ name: 'a', baseUrl: 'http://a/v1', models: ['m1', 'm2'] });
  const b = await service.createProvider({ name: 'b', baseUrl: 'http://b/v1', models: ['mb'], apiKey: 'sk-secret' });

  const initial = await service.failoverPolicy();
  assert.deepEqual(initial, { ok: true, policy: { enabled: false, allowCrossProvider: false, targets: [] } });
  assert.equal(JSON.stringify(initial).includes('sk-secret'), false);
  assert.equal(JSON.stringify(initial).includes('http://'), false, '策略响应不含 baseUrl');

  const saved = await service.saveFailoverPolicy({
    enabled: true,
    allowCrossProvider: true,
    targets: [{ providerId: a.provider.id, model: 'm2' }, { providerId: b.provider.id, model: 'mb' }],
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.policy.targets,
    [{ providerId: a.provider.id, model: 'm2' }, { providerId: b.provider.id, model: 'mb' }]);
  assert.equal(JSON.stringify(saved).includes('sk-secret'), false);
  assert.equal(JSON.stringify(saved).includes('http://'), false);

  const tooMany = await service.saveFailoverPolicy({
    enabled: true,
    targets: [
      { providerId: a.provider.id, model: 'm1' },
      { providerId: a.provider.id, model: 'm2' },
      { providerId: b.provider.id, model: 'mb' },
    ],
  });
  assert.equal(tooMany.ok, false, '非法目标不抛原始异常');
  assert.match(tooMany.error, /最多两个/);
  assert.equal(JSON.stringify(tooMany).includes('sk-secret'), false);

  const unknown = await service.saveFailoverPolicy({
    enabled: true, targets: [{ providerId: 'missing', model: 'm' }],
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /不存在/);

  // 失败保存不覆盖已保存策略。
  assert.deepEqual((await service.failoverPolicy()).policy.targets,
    [{ providerId: a.provider.id, model: 'm2' }, { providerId: b.provider.id, model: 'mb' }]);
});
