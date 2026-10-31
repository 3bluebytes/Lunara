import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROVIDER_APIS, listModelProviders, saveModelProvider, deleteModelProvider,
  setActiveModel, getActiveModel, resolveModelEndpoint, resolveProviderEndpoint,
  createSessionModelOverrides, getModelCapability, saveModelCapability, deleteModelCapability,
  getModelFailoverPolicy, saveModelFailoverPolicy, resolveModelFailoverTargets,
} from './llmProviders.js';

function makeConfigDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-providers-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  t.after(() => {
    delete process.env.LUNARA_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function seedLegacy(dir, llm) {
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ llm }, null, 2)}\n`, { mode: 0o600 });
}

test('legacy llm 三元组自动迁移为第一个 provider 并成为使用中模型', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-old', model: 'deepseek-v4-flash' });
  const providers = await listModelProviders();
  assert.equal(providers.length, 1);
  assert.equal(providers[0].id, 'legacy');
  assert.equal(providers[0].api, 'openai-completions');
  assert.deepEqual(providers[0].models, ['deepseek-v4-flash']);
  assert.equal(providers[0].hasKey, true);
  assert.equal('apiKey' in providers[0], false, '对外视图不得含 apiKey');
  const active = await getActiveModel();
  assert.deepEqual(active, { providerId: 'legacy', model: 'deepseek-v4-flash' });
  const mode = statSync(join(dir, 'config.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('resolve 链：activeModel 生效；显式 endpoint 覆盖一切', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://legacy/v1', apiKey: 'k', model: 'm-legacy' });
  await saveModelProvider({ name: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'sk-m', api: 'openai-responses', models: ['deepseek/deepseek-flash'] });
  const providers = await listModelProviders();
  const magpie = providers.find(provider => provider.name === 'magpie');
  await setActiveModel({ providerId: magpie.id, model: 'deepseek/deepseek-flash' });

  const active = await resolveModelEndpoint({});
  assert.equal(active.source, 'active');
  assert.equal(active.baseUrl, 'http://127.0.0.1:3425/v1');
  assert.equal(active.api, 'openai-responses');
  assert.equal(active.model, 'deepseek/deepseek-flash');

  const explicit = await resolveModelEndpoint({ endpoint: { baseUrl: 'http://x/v1', apiKey: 'e', model: 'mx', api: 'anthropic-messages' } });
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.api, 'anthropic-messages');
});

test('会话覆盖生效；provider 消失时回落全局而不是报错', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://legacy/v1', apiKey: 'k', model: 'm-legacy' });
  await saveModelProvider({ name: 'a', baseUrl: 'http://a/v1', api: 'anthropic-messages', models: ['claude-x'] });
  const providers = await listModelProviders();
  const providerA = providers.find(provider => provider.name === 'a');
  await setActiveModel({ providerId: 'legacy', model: 'm-legacy' });

  const overrides = createSessionModelOverrides({
    getPref: key => store.get(key),
    setPref: (key, value) => store.set(key, value),
  });
  const store = new Map();

  // 未设置覆盖的会话：直接走全局（active）。
  const global = await resolveModelEndpoint({});
  assert.equal(global.source, 'active');

  await overrides.set('s1', { providerId: providerA.id, model: 'claude-x' });
  const sessionEndpoint = await resolveModelEndpoint({ sessionId: 's1', overrides });
  assert.equal(sessionEndpoint.source, 'session');
  assert.equal(sessionEndpoint.model, 'claude-x');

  // 其它会话不受影响
  const other = await resolveModelEndpoint({ sessionId: 's2', overrides });
  assert.equal(other.source, 'active');

  // provider 消失：覆盖被忽略，回落全局
  await deleteModelProvider(providerA.id);
  const fallen = await resolveModelEndpoint({ sessionId: 's1', overrides });
  assert.equal(fallen.source, 'active', '覆盖指向的 provider 消失必须回落全局');
  assert.equal(fallen.model, 'm-legacy');

  // 清除覆盖
  await overrides.set('s1', null);
  assert.equal((await overrides.get('s1')), null);
});

test('删除 provider 清除指向它的 activeModel；key 留空保存保持旧值', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://legacy/v1', apiKey: 'k', model: 'm' });
  const created = await saveModelProvider({ name: 'zhipu', baseUrl: 'http://z/v1', apiKey: 'sk-z', api: 'google-generative-ai', models: ['glm-5.3'] });
  await setActiveModel({ providerId: created.id, model: 'glm-5.3' });

  const updated = await saveModelProvider({ id: created.id, baseUrl: 'http://z2/v1', apiKey: '', models: ['glm-5.3', 'glm-5.3-flash'] });
  assert.equal(updated.hasKey, true, 'key 留空必须保留旧值');
  assert.deepEqual(updated.models, ['glm-5.3', 'glm-5.3-flash']);

  await deleteModelProvider(created.id);
  assert.equal(await getActiveModel(), null, '删除使用中 provider 必须清除 activeModel');
  const fallen = await resolveModelEndpoint({});
  assert.equal(fallen.source, 'legacy');
});

test('停用 provider 后其上的使用中标记被清除，解析回落 legacy', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://legacy/v1', apiKey: 'k', model: 'm' });
  const created = await saveModelProvider({ name: 'a', baseUrl: 'http://a/v1', models: ['ma'] });
  await setActiveModel({ providerId: created.id, model: 'ma' });
  await saveModelProvider({ id: created.id, enabled: false });
  assert.equal(await getActiveModel(), null, '停用使用中 provider 必须清除标记');
  assert.equal((await resolveModelEndpoint({})).source, 'legacy');
});

test('未知 api 协议回落 openai-completions；PROVIDER_APIS 覆盖四种协议', async t => {
  makeConfigDir(t);
  assert.deepEqual([...PROVIDER_APIS], ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
  const created = await saveModelProvider({ name: 'x', baseUrl: 'http://x/v1', api: 'something-else', models: ['mx'] });
  assert.equal(created.api, 'openai-completions');
});

test('空注册表 + 无 legacy → resolve 返回 null', async t => {
  makeConfigDir(t);
  assert.equal(await resolveModelEndpoint({}), null);
});

// ============================================================
// 能力档案（agent-budget-and-response-contract 任务 1.1/1.4/1.7）：
// 随注册表存储在 provider 下，切换使用中模型即切换档案
// ============================================================

test('能力档案随 provider 存储、可读可删，坏值回落 unknown 且不泄露 key', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-old', model: 'deepseek-v4-flash' });

  const saved = await saveModelCapability({
    providerId: 'legacy', model: 'deepseek-v4-flash', source: 'probe', probedAt: '2026-10-15T08:00:00.000Z',
    capability: {
      family: 'deepseek',
      thinking: { default: 'on', canDisable: true },
      structuredOutput: 'json_object',
      caps: { maxOutputTokens: 8192 },
    },
  });
  assert.equal(saved.thinking.canDisable, true);
  assert.equal(saved.source, 'probe');
  assert.equal(saved.probedAt, '2026-10-15T08:00:00.000Z');

  const record = await getModelCapability({ providerId: 'legacy', model: 'deepseek-v4-flash' });
  assert.equal(record.structuredOutput, 'json_object');
  const providers = await listModelProviders();
  assert.equal('apiKey' in providers[0], false, '对外视图仍然不含 apiKey');
  assert.equal(providers[0].capabilities['deepseek-v4-flash'].thinking.canDisable, true, '档案随注册表对外可见');

  // 手改坏值：读取时回落 unknown，不猜测。
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  raw.modelProviders[0].capabilities['deepseek-v4-flash'].structuredOutput = 'magic';
  raw.modelProviders[0].capabilities['deepseek-v4-flash'].thinking.canDisable = 'yes';
  raw.modelProviders[0].capabilities.broken = { thinking: { budgetKnob: 'nope' }, probedAt: 'not-a-date' };
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  const normalized = await getModelCapability({ providerId: 'legacy', model: 'deepseek-v4-flash' });
  assert.equal(normalized.structuredOutput, 'none');
  assert.equal(normalized.thinking.canDisable, null);
  const broken = await getModelCapability({ providerId: 'legacy', model: 'broken' });
  assert.equal(broken.thinking.budgetKnob, null);
  assert.equal(broken.probedAt, null);

  assert.equal(await deleteModelCapability({ providerId: 'legacy', model: 'broken' }), true);
  assert.equal(await getModelCapability({ providerId: 'legacy', model: 'broken' }), null);
});

test('解析出的端点携带对应模型的能力档案；切换使用中模型即切换档案', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({
    name: '网关', baseUrl: 'http://gw.test/v1', apiKey: 'sk-x', api: 'openai-completions',
    models: ['deepseek-v4-flash', 'glm-5.3'],
  });
  await saveModelCapability({ providerId: provider.id, model: 'deepseek-v4-flash', source: 'probe',
    capability: { family: 'deepseek', thinking: { default: 'on', canDisable: true } } });
  await saveModelCapability({ providerId: provider.id, model: 'glm-5.3', source: 'user',
    capability: { family: 'glm', thinking: { default: 'on', canDisable: false } } });

  await setActiveModel({ providerId: provider.id, model: 'deepseek-v4-flash' });
  const first = await resolveModelEndpoint({});
  assert.equal(first.capability?.thinking?.canDisable, true);
  assert.equal(first.capability?.source, 'probe');
  assert.equal(first.apiKey, 'sk-x', '解析自然带 key，但档案不含 key');
  assert.equal(JSON.stringify(first.capability).includes('sk-'), false);

  await setActiveModel({ providerId: provider.id, model: 'glm-5.3' });
  const second = await resolveModelEndpoint({});
  assert.equal(second.capability?.thinking?.canDisable, false, '换模型即换档案，无需重启');

  // 未登记档案的模型：capability = null → 调用侧走保守默认。
  const unknownModel = await resolveModelEndpoint({ endpoint: { baseUrl: 'http://x/v1', model: 'm', api: 'openai-completions' } });
  assert.equal(unknownModel.capability, undefined, '显式 endpoint 未带档案时不做猜测');
});

test('自动结论（probe/observed）不覆盖用户显式声明，除非显式 overwrite', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m'] });
  await saveModelCapability({ providerId: provider.id, model: 'm', source: 'user',
    capability: { thinking: { canDisable: true } } });
  const kept = await saveModelCapability({ providerId: provider.id, model: 'm', source: 'probe',
    capability: { thinking: { canDisable: false } }, overwrite: false });
  assert.equal(kept.thinking.canDisable, true, '用户声明优先');
  assert.equal(kept.source, 'user');
  const replaced = await saveModelCapability({ providerId: provider.id, model: 'm', source: 'probe',
    capability: { thinking: { canDisable: false } }, overwrite: true });
  assert.equal(replaced.thinking.canDisable, false, '显式 overwrite 才让自动结论生效');
});

// ============================================================
// 审查缺口修复（2026-10-16）：配置写入串行化、能力字段合并、端点变更失效
// ============================================================

test('并发能力保存不丢更新：真实文件系统的同时写入全部保留', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['a', 'b', 'c'] });
  await Promise.all(['a', 'b', 'c'].map(model => saveModelCapability({
    providerId: provider.id, model, source: 'probe', capability: { thinking: { default: 'on', canDisable: false } },
  })));
  const [saved] = await listModelProviders();
  assert.deepEqual(Object.keys(saved.capabilities).sort(), ['a', 'b', 'c'], '三份档案都在，没有旧快照覆盖');
});

test('后台写与切模型并发：使用中模型不会被能力保存写回旧值', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['a', 'b'] });
  await setActiveModel({ providerId: provider.id, model: 'a' });
  await Promise.all([
    saveModelCapability({ providerId: provider.id, model: 'a', source: 'probe',
      capability: { thinking: { default: 'on', canDisable: false } } }),
    setActiveModel({ providerId: provider.id, model: 'b' }),
  ]);
  assert.deepEqual(await getActiveModel(), { providerId: provider.id, model: 'b' }, '并发写入不倒退使用中模型');
  const capability = await getModelCapability({ providerId: provider.id, model: 'a' });
  assert.equal(capability.thinking.canDisable, false, '能力写入也没有被丢掉');
});

test('单项运行时观测按字段合并：结构化、旋钮与输出上限不被抹掉', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m'] });
  await saveModelCapability({ providerId: provider.id, model: 'm', source: 'probe', capability: {
    thinking: { default: 'on', canDisable: true, budgetKnob: 'reasoning_effort' },
    structuredOutput: 'json_schema', caps: { maxOutputTokens: 2048 },
  } });
  const merged = await saveModelCapability({ providerId: provider.id, model: 'm', source: 'observed',
    overwrite: false, capability: { thinking: { canDisable: false } } });
  assert.equal(merged.thinking.canDisable, false, '新观测生效');
  assert.equal(merged.thinking.budgetKnob, 'reasoning_effort', '未观测字段保持');
  assert.equal(merged.structuredOutput, 'json_schema', '结构化形态不被抹掉');
  assert.deepEqual(merged.caps, { maxOutputTokens: 2048, contextWindow: null });
  assert.equal(merged.source, 'observed');
});

test('探测在用户声明之后提交：用户声明优先且不被静默改写', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m'] });
  // 模拟时序：探测开始（无档案）→ 用户保存声明 → 探测结论提交（overwrite:false）。
  await saveModelCapability({ providerId: provider.id, model: 'm', source: 'user',
    capability: { thinking: { default: 'on', canDisable: false } } });
  const afterProbe = await saveModelCapability({ providerId: provider.id, model: 'm', source: 'probe',
    overwrite: false, capability: { thinking: { default: 'on', canDisable: true } } });
  assert.deepEqual([afterProbe.source, afterProbe.thinking.canDisable], ['user', false]);
});

test('端点协议/地址变更使旧探测结论失效：档案被清空且不指向旧端点', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw-a/v1', models: ['m'] });
  await saveModelCapability({ providerId: provider.id, model: 'm', source: 'probe',
    capability: { thinking: { canDisable: true } } });
  await saveModelProvider({ id: provider.id, name: 'p', baseUrl: 'http://gw-b/v1', models: ['m'] });
  assert.equal(await getModelCapability({ providerId: provider.id, model: 'm' }), null, '换端点后旧结论不再生效');
  // 仅改名不改端点：档案保留。
  await saveModelProvider({ id: provider.id, name: 'p2', baseUrl: 'http://gw-b/v1', models: ['m'] });
  await saveModelCapability({ providerId: provider.id, model: 'm', source: 'probe',
    capability: { thinking: { canDisable: true } } });
  const renamed = await saveModelProvider({ id: provider.id, name: 'p3', baseUrl: 'http://gw-b/v1', models: ['m'] });
  assert.equal(renamed.name, 'p3');
  assert.equal((await getModelCapability({ providerId: provider.id, model: 'm' })).thinking.canDisable, true);
});

test('保存 provider 不清除使用中模型；移除该模型才清', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'] });
  await setActiveModel({ providerId: provider.id, model: 'm1' });
  await saveModelProvider({ id: provider.id, name: '改名', baseUrl: 'http://gw/v1', models: ['m1', 'm2'] });
  assert.deepEqual(await getActiveModel(), { providerId: provider.id, model: 'm1' }, '改名/重存不清使用中模型');
  await saveModelProvider({ id: provider.id, name: '改名', baseUrl: 'http://gw/v1', models: ['m2'] });
  assert.equal(await getActiveModel(), null, '移除使用中的模型才清标记');
});

test('注册表以外的顶层字段在写入后原样保留', async t => {
  const dir = makeConfigDir(t);
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ llm: null, future: { keep: 1 } }, null, 2)}\n`, { mode: 0o600 });
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m'] });
  await saveModelCapability({ providerId: provider.id, model: 'm', source: 'probe', capability: { thinking: { canDisable: true } } });
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.future, { keep: 1 }, '未知顶层字段不被注册表写入丢掉');
});

// ============================================================
// 模型级停用但保留（add-model-row-actions 任务 1.1/2.1/2.2）：
// disabledModels 是 models 的子集，旧配置缺字段 = 全部启用。
// ============================================================

test('旧配置缺少 disabledModels → 全部启用且视图给出空数组', async t => {
  const dir = makeConfigDir(t);
  // 显式写入一份"旧版本"注册表：有 modelProviders 但没有 disabledModels（不会走 legacy 迁移）。
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({
    modelProviders: [{
      id: 'p-old', name: '旧配置', baseUrl: 'http://old/v1', apiKey: 'sk-old',
      api: 'openai-completions', models: ['m1', 'm2'], enabled: true,
    }],
    activeModel: { providerId: 'p-old', model: 'm1' },
  }, null, 2)}\n`, { mode: 0o600 });

  const [provider] = await listModelProviders();
  assert.deepEqual(provider.disabledModels, [], '缺字段视为全部启用（不回写伪造字段）');
  assert.equal(provider.modelCount, 2);
  assert.equal(provider.enabledModelCount, 2);
  assert.equal('apiKey' in provider, false, '视图仍不得暴露 apiKey');

  const active = await resolveModelEndpoint({});
  assert.equal(active.source, 'active');
  assert.equal(active.model, 'm1');
});

test('保存时归一化 disabledModels：去重、转字符串、丢弃不在 models 的 id', async t => {
  makeConfigDir(t);
  const created = await saveModelProvider({
    name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2', '42'],
    // 含重复、空白、空值、数字（可转为已有模型 id）与不在 models 的 id。
    disabledModels: ['m2', ' m2 ', '', null, 42, 'ghost', 0],
  });
  assert.deepEqual(created.disabledModels, ['m2', '42'], '只保留 models 成员的字符串 id 并去重');
  assert.equal(created.modelCount, 3);
  assert.equal(created.enabledModelCount, 1);

  // patch 未给 disabledModels → 沿用 existing（不是被空数组覆盖）。
  const kept = await saveModelProvider({ id: created.id, models: ['m1', 'm2', '42'] });
  assert.deepEqual(kept.disabledModels, ['m2', '42']);

  // 非数组一律归一为 []。
  const cleared = await saveModelProvider({ id: created.id, disabledModels: 'm1' });
  assert.deepEqual(cleared.disabledModels, []);
  assert.equal(cleared.enabledModelCount, 3);
});

test('停用模型保留在列表，使用中标记被清除并回落 legacy；会话覆盖同样回落', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://legacy/v1', apiKey: 'k', model: 'm-legacy' });
  const created = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'] });
  await setActiveModel({ providerId: created.id, model: 'm1' });
  assert.equal((await resolveModelEndpoint({})).source, 'active');

  const disabled = await saveModelProvider({ id: created.id, disabledModels: ['m1'] });
  assert.deepEqual(disabled.models, ['m1', 'm2'], '停用不删除模型，行仍在列表');
  assert.deepEqual(disabled.disabledModels, ['m1']);
  assert.equal(disabled.modelCount, 2);
  assert.equal(disabled.enabledModelCount, 1);
  assert.equal(await getActiveModel(), null, '停用使用中模型必须清标记而不是报错');
  const fallen = await resolveModelEndpoint({});
  assert.equal(fallen.source, 'legacy', '停用的使用中模型不能生效');
  assert.equal(fallen.model, 'm-legacy');

  const store = new Map();
  const overrides = createSessionModelOverrides({
    getPref: key => store.get(key),
    setPref: (key, value) => store.set(key, value),
  });
  // 会话覆盖指向停用模型：视为不可用，继续回落，不报错。
  await overrides.set('s1', { providerId: created.id, model: 'm1' });
  assert.equal((await resolveModelEndpoint({ sessionId: 's1', overrides })).source, 'legacy');
  // 对照：覆盖指向启用模型仍生效。
  await overrides.set('s1', { providerId: created.id, model: 'm2' });
  const session = await resolveModelEndpoint({ sessionId: 's1', overrides });
  assert.equal(session.source, 'session');
  assert.equal(session.model, 'm2');
});

test('重新启用后恢复可用，能力档案与探测结论保留', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'] });
  await saveModelCapability({ providerId: provider.id, model: 'm2', source: 'probe',
    probedAt: '2026-10-15T08:00:00.000Z', capability: { thinking: { canDisable: true } } });

  await saveModelProvider({ id: provider.id, disabledModels: ['m2'] });
  const kept = await getModelCapability({ providerId: provider.id, model: 'm2' });
  assert.equal(kept?.thinking?.canDisable, true, '仅停用不得删除能力档案或探测结论');
  assert.equal(kept?.probedAt, '2026-10-15T08:00:00.000Z');

  const reenabled = await saveModelProvider({ id: provider.id, disabledModels: [] });
  assert.deepEqual(reenabled.disabledModels, []);
  assert.equal(reenabled.enabledModelCount, 2);
  await setActiveModel({ providerId: provider.id, model: 'm2' });
  const endpoint = await resolveModelEndpoint({});
  assert.equal(endpoint.source, 'active');
  assert.equal(endpoint.model, 'm2');
  assert.equal(endpoint.capability?.thinking?.canDisable, true, '重新启用后既有探测结论立即可用');
});

test('删除模型时同步裁剪 disabledModels 并清理能力档案', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'] });
  await saveModelCapability({ providerId: provider.id, model: 'm2', source: 'probe',
    capability: { thinking: { canDisable: true } } });
  await saveModelProvider({ id: provider.id, disabledModels: ['m2'] });
  assert.equal((await getModelCapability({ providerId: provider.id, model: 'm2' }))?.thinking?.canDisable, true);

  // 删除 = 从 models 移除；停用记录与能力档案随之消失（既有档案清理语义）。
  const trimmed = await saveModelProvider({ id: provider.id, models: ['m1'], disabledModels: ['m2'] });
  assert.deepEqual(trimmed.models, ['m1']);
  assert.deepEqual(trimmed.disabledModels, [], '不在 models 的 id 必须被丢弃');
  assert.equal(trimmed.enabledModelCount, 1);
  assert.equal(await getModelCapability({ providerId: provider.id, model: 'm2' }), null);
});

test('setActiveModel 拒绝停用模型并给出可读原因', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({ name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'] });
  await saveModelProvider({ id: provider.id, disabledModels: ['m2'] });
  await assert.rejects(
    () => setActiveModel({ providerId: provider.id, model: 'm2' }),
    error => /模型已停用/.test(error.message) && /不能设为使用中/.test(error.message),
  );
  assert.equal(await getActiveModel(), null, '失败不得写入使用中标记');
  // 重新启用后照常可设。
  await saveModelProvider({ id: provider.id, disabledModels: [] });
  await setActiveModel({ providerId: provider.id, model: 'm2' });
  assert.deepEqual(await getActiveModel(), { providerId: provider.id, model: 'm2' });
});

test('resolveProviderEndpoint：显式停用模型返回 null，默认模型跳过停用', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({
    name: 'p', baseUrl: 'http://gw/v1', apiKey: 'sk-x', models: ['m1', 'm2', 'm3'],
  });
  const first = await resolveProviderEndpoint({ providerId: provider.id });
  assert.equal(first.model, 'm1', '全部启用时默认取第一个模型');

  await saveModelProvider({ id: provider.id, disabledModels: ['m1', 'm2'] });
  const skipped = await resolveProviderEndpoint({ providerId: provider.id });
  assert.equal(skipped.model, 'm3', '未指定模型时跳过停用模型');
  assert.equal(await resolveProviderEndpoint({ providerId: provider.id, model: 'm1' }), null);
  assert.equal(await resolveProviderEndpoint({ providerId: provider.id, model: 'm2' }), null);

  await saveModelProvider({ id: provider.id, disabledModels: ['m1', 'm2', 'm3'] });
  assert.equal(await resolveProviderEndpoint({ providerId: provider.id }), null, '没有启用模型时返回 null');
  assert.equal(await resolveProviderEndpoint({ providerId: provider.id, model: 'm3' }), null);
});

// ============================================================
// 模型目录元数据与默认思考档（add-reasoning-effort-controls 任务 1.1/2.1）：
// modelInfo 存发现事实（档位/容量/模态），modelDefaults 存用户偏好；两者都裁剪到 models。
// ============================================================

test('模型元数据归一化：裁剪到 models、档位去重截断、坏值丢弃', async t => {
  makeConfigDir(t);
  const longEffort = 'x'.repeat(30);
  const manyEfforts = Array.from({ length: 20 }, (_, index) => `e${index}`);
  const created = await saveModelProvider({
    name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'],
    modelInfo: {
      m1: {
        // 空白/重复/非字符串/超长（截到 24）/超过 16 个（截断）都要归一。
        reasoningEfforts: [' low ', 'low', '', null, 42, 'high', longEffort, ...manyEfforts],
        contextWindow: 1_000_000.7,
        maxOutputTokens: '8192',
        modalities: ['text', 'text', 'image', 7, ''],
        unknownField: 'ignored',
      },
      // 没有有效字段的条目丢弃（空数组 / 负数 / 坏串 / 非数组都不算事实）。
      m2: { reasoningEfforts: [], contextWindow: -1, maxOutputTokens: 'lots', modalities: 'text' },
      // 不属于 models 的键丢弃。
      ghost: { reasoningEfforts: ['low'], contextWindow: 100 },
      '   ': { reasoningEfforts: ['low'] },
    },
    modelDefaults: {
      m1: { reasoningEffort: '  high  ' },
      m2: { reasoningEffort: '   ' },
      ghost: { reasoningEffort: 'low' },
    },
  });

  const expectedEfforts = ['low', 'high', longEffort.slice(0, 24), ...manyEfforts].slice(0, 16);
  assert.deepEqual(created.modelInfo, {
    m1: {
      reasoningEfforts: expectedEfforts,
      contextWindow: 1_000_000,
      maxOutputTokens: 8192,
      modalities: ['text', 'image'],
    },
  });
  assert.deepEqual(created.modelDefaults, { m1: { reasoningEffort: 'high' } });
  assert.equal(created.modelInfo.m1.reasoningEfforts.length, 16, '档位数量上限 16');

  const [reread] = await listModelProviders();
  assert.deepEqual(reread.modelInfo, created.modelInfo, '保存后回读同一份事实');
  assert.deepEqual(reread.modelDefaults, created.modelDefaults);
  assert.equal('apiKey' in reread, false);

  // 视图必须是副本：调用方修改不影响注册表。
  reread.modelInfo.m1.reasoningEfforts.push('mutated');
  reread.modelInfo.m1.modalities.push('mutated');
  reread.modelDefaults.m1.reasoningEffort = 'mutated';
  const [again] = await listModelProviders();
  assert.deepEqual(again.modelInfo, created.modelInfo);
  assert.deepEqual(again.modelDefaults, created.modelDefaults);
});

test('旧配置缺少 modelInfo/modelDefaults → 空对象，解析不猜测档位', async t => {
  const dir = makeConfigDir(t);
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify({
    modelProviders: [{
      id: 'p-old', name: '旧配置', baseUrl: 'http://old/v1', apiKey: 'sk-old',
      api: 'openai-completions', models: ['m1'], enabled: true,
    }],
    activeModel: { providerId: 'p-old', model: 'm1' },
  }, null, 2)}\n`, { mode: 0o600 });

  const [provider] = await listModelProviders();
  assert.deepEqual(provider.modelInfo, {});
  assert.deepEqual(provider.modelDefaults, {});

  const endpoint = await resolveModelEndpoint({});
  assert.equal(endpoint.source, 'active');
  assert.equal(endpoint.reasoningEffort, null);
  assert.deepEqual(endpoint.reasoningEfforts, []);

  const providerEndpoint = await resolveProviderEndpoint({ providerId: 'p-old', model: 'm1' });
  assert.equal(providerEndpoint.reasoningEffort, null);
  assert.deepEqual(providerEndpoint.reasoningEfforts, []);
});

test('保存沿用未给出的元数据字段；显式给出时按新值归一裁剪', async t => {
  makeConfigDir(t);
  const created = await saveModelProvider({
    name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'],
    modelInfo: { m1: { reasoningEfforts: ['low'] }, m2: { contextWindow: 2048 } },
    modelDefaults: { m1: { reasoningEffort: 'low' } },
  });
  assert.deepEqual(created.modelInfo, {
    m1: { reasoningEfforts: ['low'] },
    m2: { contextWindow: 2048 },
  });

  // patch 未给两个字段 → 沿用 existing（不被空对象覆盖）。
  const renamed = await saveModelProvider({ id: created.id, name: 'renamed' });
  assert.deepEqual(renamed.modelInfo, created.modelInfo);
  assert.deepEqual(renamed.modelDefaults, created.modelDefaults);

  // 只给 modelInfo → modelDefaults 仍沿用旧值；modelInfo 整份替换并按新值归一。
  const replaced = await saveModelProvider({
    id: created.id,
    modelInfo: {
      m1: { reasoningEfforts: ['high', ' low ', 'high'] },
      ghost: { reasoningEfforts: ['x'] },
    },
  });
  assert.deepEqual(replaced.modelInfo, { m1: { reasoningEfforts: ['high', 'low'] } });
  assert.deepEqual(replaced.modelDefaults, { m1: { reasoningEffort: 'low' } }, '未给出的字段沿用');

  // 显式给出空对象 → 清空。
  const cleared = await saveModelProvider({ id: created.id, modelDefaults: {} });
  assert.deepEqual(cleared.modelDefaults, {});
  assert.deepEqual(cleared.modelInfo, replaced.modelInfo, 'modelInfo 未给出时仍沿用');
});

test('从 models 删除模型同步清理 modelInfo 与 modelDefaults', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({
    name: 'p', baseUrl: 'http://gw/v1', models: ['m1', 'm2'],
    modelInfo: {
      m1: { reasoningEfforts: ['low'] },
      m2: { reasoningEfforts: ['high'], contextWindow: 4096 },
    },
    modelDefaults: { m1: { reasoningEffort: 'low' }, m2: { reasoningEffort: 'high' } },
  });
  const trimmed = await saveModelProvider({ id: provider.id, models: ['m1'], disabledModels: ['m2'] });
  assert.deepEqual(trimmed.modelInfo, { m1: { reasoningEfforts: ['low'] } });
  assert.deepEqual(trimmed.modelDefaults, { m1: { reasoningEffort: 'low' } });
  assert.deepEqual(trimmed.disabledModels, [], '停用记录同样只保留 models 成员');

  // 重新加回模型不会复活已裁剪的事实。
  const restored = await saveModelProvider({ id: provider.id, models: ['m1', 'm2'] });
  assert.deepEqual(restored.modelInfo, { m1: { reasoningEfforts: ['low'] } });
  assert.deepEqual(restored.modelDefaults, { m1: { reasoningEffort: 'low' } });
});

test('会话覆盖携带 reasoningEffort：保存/归一/清除', async t => {
  makeConfigDir(t);
  const store = new Map();
  const overrides = createSessionModelOverrides({
    getPref: key => store.get(key),
    setPref: (key, value) => store.set(key, value),
  });

  const saved = await overrides.set('s1', { providerId: 'p1', model: 'm1', reasoningEffort: '  high  ' });
  assert.deepEqual(saved, { providerId: 'p1', model: 'm1', reasoningEffort: 'high' });
  assert.deepEqual(await overrides.get('s1'), { providerId: 'p1', model: 'm1', reasoningEffort: 'high' });

  // 超长档位截到 24 字符；空/非字符串视为「跟随模型默认」，不写该字段。
  const long = await overrides.set('s1', { providerId: 'p1', model: 'm1', reasoningEffort: 'y'.repeat(40) });
  assert.equal(long.reasoningEffort, 'y'.repeat(24));
  assert.deepEqual(await overrides.set('s1', { providerId: 'p1', model: 'm1', reasoningEffort: '   ' }),
    { providerId: 'p1', model: 'm1' });
  assert.deepEqual(await overrides.set('s1', { providerId: 'p1', model: 'm1', reasoningEffort: 42 }),
    { providerId: 'p1', model: 'm1' });

  // 传 null/空清除整个覆盖（档位一起清除）。
  assert.equal(await overrides.set('s1', null), null);
  assert.equal(await overrides.get('s1'), null);
  assert.equal(store.get('model-override:s1'), '');
});

test('resolve 出生效档位：会话覆盖 > 模型默认 > null，并透出声明档位', async t => {
  makeConfigDir(t);
  const provider = await saveModelProvider({
    name: 'gw', baseUrl: 'http://gw/v1', models: ['m1', 'm2'],
    modelInfo: {
      m1: { reasoningEfforts: ['low', 'high', 'max'] },
      m2: { reasoningEfforts: ['none'] },
    },
    modelDefaults: { m1: { reasoningEffort: 'low' } },
  });
  await setActiveModel({ providerId: provider.id, model: 'm1' });

  const active = await resolveModelEndpoint({});
  assert.equal(active.source, 'active');
  assert.equal(active.reasoningEffort, 'low', '会话未指定时用模型默认');
  assert.deepEqual(active.reasoningEfforts, ['low', 'high', 'max']);

  const store = new Map();
  const overrides = createSessionModelOverrides({
    getPref: key => store.get(key),
    setPref: (key, value) => store.set(key, value),
  });

  await overrides.set('s1', { providerId: provider.id, model: 'm1' });
  assert.equal((await resolveModelEndpoint({ sessionId: 's1', overrides })).reasoningEffort, 'low');

  await overrides.set('s1', { providerId: provider.id, model: 'm1', reasoningEffort: 'high' });
  const session = await resolveModelEndpoint({ sessionId: 's1', overrides });
  assert.equal(session.source, 'session');
  assert.equal(session.reasoningEffort, 'high', '会话覆盖优先于模型默认');

  // 模型没有默认档 → null，但声明档位照常透出。
  await overrides.set('s2', { providerId: provider.id, model: 'm2' });
  const noDefault = await resolveModelEndpoint({ sessionId: 's2', overrides });
  assert.equal(noDefault.reasoningEffort, null);
  assert.deepEqual(noDefault.reasoningEfforts, ['none']);

  const providerEndpoint = await resolveProviderEndpoint({ providerId: provider.id, model: 'm2' });
  assert.equal(providerEndpoint.reasoningEffort, null);
  assert.deepEqual(providerEndpoint.reasoningEfforts, ['none']);

  // 显式 endpoint 不查注册表，不猜测档位。
  const explicit = await resolveModelEndpoint({
    endpoint: { baseUrl: 'http://x/v1', apiKey: 'e', model: 'mx', api: 'openai-completions' },
  });
  assert.equal(explicit.reasoningEffort, null);
  assert.deepEqual(explicit.reasoningEfforts, []);
});

test('停用模型回落时不带该模型的档位；既有停用计数不变', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://legacy/v1', apiKey: 'k', model: 'm-legacy' });
  const created = await saveModelProvider({
    name: 'p', baseUrl: 'http://gw/v1', models: ['m1'],
    modelInfo: { m1: { reasoningEfforts: ['low'], contextWindow: 8192 } },
    modelDefaults: { m1: { reasoningEffort: 'low' } },
  });
  await setActiveModel({ providerId: created.id, model: 'm1' });
  assert.equal((await resolveModelEndpoint({})).reasoningEffort, 'low');

  await saveModelProvider({ id: created.id, disabledModels: ['m1'] });
  const fallen = await resolveModelEndpoint({});
  assert.equal(fallen.source, 'legacy');
  assert.equal(fallen.reasoningEffort, null, '回落的不再是停用模型，不能带它的默认档');
  assert.deepEqual(fallen.reasoningEfforts, []);

  const view = (await listModelProviders()).find(provider => provider.id === created.id);
  assert.equal(view.modelCount, 1);
  assert.equal(view.enabledModelCount, 0);
  assert.equal(view.modelInfo.m1.reasoningEfforts[0], 'low', '停用只影响可用性，不删发现事实');
  assert.equal(view.modelDefaults.m1.reasoningEffort, 'low');
});

test('故障切换策略：缺省关闭、保存两个以内启用目标并保留其它配置键', async t => {
  const dir = makeConfigDir(t);
  seedLegacy(dir, { baseUrl: 'https://legacy/v1', apiKey: 'k', model: 'm-legacy' });
  const a = await saveModelProvider({ name: 'a', baseUrl: 'http://a/v1', models: ['m-a1', 'm-a2'] });
  const b = await saveModelProvider({ name: 'b', baseUrl: 'http://b/v1', models: ['m-b'] });

  assert.deepEqual(await getModelFailoverPolicy(),
    { enabled: false, allowCrossProvider: false, targets: [] }, '缺失时默认关闭');

  const saved = await saveModelFailoverPolicy({
    enabled: true,
    allowCrossProvider: true,
    targets: [
      { providerId: a.id, model: 'm-a1' },
      { providerId: b.id, model: 'm-b' },
      { providerId: a.id, model: 'm-a1' },
    ],
  });
  assert.deepEqual(saved, {
    enabled: true,
    allowCrossProvider: true,
    targets: [{ providerId: a.id, model: 'm-a1' }, { providerId: b.id, model: 'm-b' }],
  }, '重复条目去重，顺序保留');
  assert.deepEqual(await getModelFailoverPolicy(), saved);
  assert.equal('apiKey' in saved, false, '策略不含凭据');
  assert.equal('baseUrl' in saved, false, '策略不含地址');

  // 普通注册表写入不能丢掉已保存的故障切换策略。
  await saveModelProvider({ id: a.id, name: 'a-renamed' });
  assert.deepEqual(await getModelFailoverPolicy(), saved);
  const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(raw.modelFailover, saved);
  assert.equal(typeof raw.llm, 'object', 'legacy llm 键仍保留');
  assert.equal(statSync(join(dir, 'config.json')).mode & 0o777, 0o600);

  // 只有显式 true 才启用；字符串/缺省都回到关闭。
  assert.equal((await saveModelFailoverPolicy({ enabled: 'yes', targets: [] })).enabled, false);
});

test('故障切换策略拒绝超过两个、未知/停用/非成员模型', async t => {
  makeConfigDir(t);
  const a = await saveModelProvider({ name: 'a', baseUrl: 'http://a/v1', models: ['m1', 'm2'] });
  const b = await saveModelProvider({ name: 'b', baseUrl: 'http://b/v1', models: ['mb'] });
  const c = await saveModelProvider({ name: 'c', baseUrl: 'http://c/v1', models: ['mc'] });

  await assert.rejects(saveModelFailoverPolicy({
    enabled: true,
    targets: [
      { providerId: a.id, model: 'm1' },
      { providerId: b.id, model: 'mb' },
      { providerId: c.id, model: 'mc' },
    ],
  }), /最多两个/);

  await assert.rejects(saveModelFailoverPolicy({
    enabled: true, targets: [{ providerId: 'missing', model: 'm1' }],
  }), /不存在/);

  await assert.rejects(saveModelFailoverPolicy({
    enabled: true, targets: [{ providerId: a.id, model: 'not-in-list' }],
  }), /不在该 provider/);

  await saveModelProvider({ id: a.id, disabledModels: ['m2'] });
  await assert.rejects(saveModelFailoverPolicy({
    enabled: true, targets: [{ providerId: a.id, model: 'm2' }],
  }), /已停用/);

  await saveModelProvider({ id: b.id, enabled: false });
  await assert.rejects(saveModelFailoverPolicy({
    enabled: true, targets: [{ providerId: b.id, model: 'mb' }],
  }), /未启用/);
});

test('故障切换解析：同 provider 免跨源授权，显式 endpoint 与关闭策略不返回目标', async t => {
  makeConfigDir(t);
  const a = await saveModelProvider({ name: 'a', baseUrl: 'http://a/v1', models: ['m1', 'm2'] });
  const b = await saveModelProvider({ name: 'b', baseUrl: 'http://b/v1', models: ['mb'] });
  const primary = { baseUrl: 'http://a/v1', model: 'm1', api: 'openai-completions', providerId: a.id };

  await saveModelFailoverPolicy({
    enabled: true,
    allowCrossProvider: false,
    targets: [{ providerId: a.id, model: 'm2' }, { providerId: b.id, model: 'mb' }],
  });
  const sameSource = await resolveModelFailoverTargets(primary, {});
  assert.equal(sameSource.length, 1, '同 provider 目标不需要跨源授权');
  assert.equal(sameSource[0].model, 'm2');
  assert.deepEqual(await resolveModelFailoverTargets(primary, { endpoint: { baseUrl: 'http://x/v1', model: 'mx' } }), [],
    '显式 endpoint 不套用全局策略');

  await saveModelFailoverPolicy({ enabled: false, targets: [{ providerId: a.id, model: 'm2' }] });
  assert.deepEqual(await resolveModelFailoverTargets(primary, {}), [], '关闭策略不返回目标');
});
