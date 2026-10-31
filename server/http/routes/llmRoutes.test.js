// llmRoutes.test.js — /api/llm/* 路由与 LlmSettingsService（离线替身）。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerLlmRoutes } from './llmRoutes.js';
import { LlmSettingsService } from '../../services/LlmSettingsService.js';

// 隔离用户配置目录：注册表读写的是真实 config.json，测试绝不触碰。
function makeConfigDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-routes-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  t.after(() => {
    delete process.env.LUNARA_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeApp() {
  const routes = new Map();
  return {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
    routes,
  };
}

function response() {
  return {
    statusCode: 200, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function makeService({ discoverFails = false, chat = null } = {}) {
  const store = new Map();
  const overrides = {
    async get(sessionId) { return store.get(sessionId) || null; },
    async set(sessionId, override) {
      if (override) store.set(sessionId, override); else store.delete(sessionId);
      return override;
    },
  };
  const discoverCalls = [];
  return {
    overrides, store, discoverCalls,
    service: new LlmSettingsService({
      sessionOverrides: overrides,
      discover: async input => {
        discoverCalls.push(input);
        if (discoverFails) throw new Error('gateway unreachable');
        return { ok: true, models: ['m-1', 'm-2'] };
      },
      ...(chat ? { chat } : {}),
    }),
  };
}

test('provider 注册表路由：列表/创建/更新/发现/使用中/删除/测试全链', async t => {
  makeConfigDir(t);
  const { service, discoverCalls } = makeService({
    chat: async (messages, tools, options) => {
      chatCalls.push({ messages, options });
      return { message: { role: 'assistant', content: '正常' }, finishReason: 'stop', usage: null };
    },
  });
  const chatCalls = [];
  const app = fakeApp();
  registerLlmRoutes(app, { llmSettingsService: service });

  const created = response();
  await app.routes.get('POST /api/llm/providers')({ body: { name: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'sk-x', api: 'openai-responses', models: ['m-1'] } }, created);
  assert.equal(created.payload.provider.hasKey, true);
  const providerId = created.payload.provider.id;

  const list = response();
  await app.routes.get('GET /api/llm/providers')({}, list);
  assert.equal(list.payload.providers.length, 1);
  assert.equal('apiKey' in list.payload.providers[0], false);

  const updated = response();
  await app.routes.get('PUT /api/llm/providers/:id')({ params: { id: providerId }, body: { models: ['m-1', 'm-2'] } }, updated);
  assert.deepEqual(updated.payload.provider.models, ['m-1', 'm-2']);

  const discovered = response();
  await app.routes.get('POST /api/llm/providers/discover-models')({ body: { baseUrl: 'http://x/v1', api: 'openai-completions' } }, discovered);
  assert.deepEqual(discovered.payload.models, ['m-1', 'm-2']);
  assert.deepEqual(discoverCalls[0], { baseUrl: 'http://x/v1', api: 'openai-completions' });

  const active = response();
  await app.routes.get('PUT /api/llm/active-model')({ body: { providerId, model: 'm-1' } }, active);
  assert.deepEqual(active.payload.activeModel, { providerId, model: 'm-1' });

  const tested = response();
  await app.routes.get('POST /api/llm/test-model')({ body: { baseUrl: 'http://x/v1', apiKey: 'k', api: 'openai-completions', model: 'm-1' } }, tested);
  assert.equal(tested.payload.ok, true);
  assert.match(tested.payload.reply, /正常/);
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].options.endpoint.model, 'm-1', '测试必须用给定端点而非注册表解析');
  assert.equal(chatCalls[0].options.maxTokens, undefined, '探针预算由 connectivity_probe 规格决定');
  assert.equal(chatCalls[0].options.taskId, 'connectivity_probe', '探针预算要容纳思维链，不能挤空正文');
  assert.equal(chatCalls[0].options.thinkingMode, 'disabled');

  const removed = response();
  await app.routes.get('DELETE /api/llm/providers/:id')({ params: { id: providerId } }, removed);
  assert.equal(removed.payload.removed, true);
  const after = response();
  await app.routes.get('GET /api/llm/providers')({}, after);
  assert.equal(after.payload.activeModel, null, '删除使用中 provider 必须清除 activeModel');
});

test('会话覆盖路由：设置/读取/清除；发现失败返回 400', async t => {
  makeConfigDir(t);
  const { service, overrides } = makeService({ discoverFails: true });
  const app = fakeApp();
  registerLlmRoutes(app, { llmSettingsService: service });

  const set = response();
  await app.routes.get('PUT /api/llm/session-model')({ body: { sessionId: 's1', providerId: 'p1', model: 'm' } }, set);
  assert.deepEqual(set.payload.override, { providerId: 'p1', model: 'm' });

  const get = response();
  await app.routes.get('GET /api/llm/session-model')({ query: { sessionId: 's1' } }, get);
  assert.deepEqual(get.payload.override, { providerId: 'p1', model: 'm' });

  const cleared = response();
  await app.routes.get('PUT /api/llm/session-model')({ body: { sessionId: 's1' } }, cleared);
  assert.equal(cleared.payload.override, null);

  const fail = response();
  await app.routes.get('POST /api/llm/providers/discover-models')({ body: { baseUrl: 'http://x/v1', api: 'openai-completions' } }, fail);
  assert.equal(fail.statusCode, 400, '发现失败必须如实 400');
});

test('LlmSettingsService.registry 无 key 泄漏，会话读取在无覆盖时为 null', async t => {
  makeConfigDir(t);
  const { service } = makeService();
  await service.createProvider({ name: 'a', baseUrl: 'http://a/v1', apiKey: 'sk-a', models: ['ma'] });
  const registry = await service.registry();
  assert.equal('apiKey' in registry.providers[0], false);
  assert.equal(registry.providers[0].hasKey, true);
  const session = await service.sessionModel('s9');
  assert.equal(session.override, null);
});

test('用量报告路由：只读转发 days，缺省/非法值交回服务层回落', async () => {
  const seen = [];
  const llmSettings = {
    async usageReport(args) {
      seen.push(args);
      return { ok: true, days: args?.days ?? 30, daily: [], totals: {}, byModel: [] };
    },
  };
  const app = fakeApp();
  registerLlmRoutes(app, { llmSettingsService: llmSettings });
  assert.ok(app.routes.has('GET /api/llm/usage/report'), '新报告路由已注册');
  assert.ok(app.routes.has('GET /api/llm/usage'), '旧摘要路由保留不动');

  const missing = response();
  await app.routes.get('GET /api/llm/usage/report')({ query: {} }, missing);
  assert.deepEqual(seen[0], {}, '缺省不传 days，由账本回落默认 30');
  assert.equal(missing.statusCode, 200);
  assert.deepEqual(missing.payload, { ok: true, days: 30, daily: [], totals: {}, byModel: [] });

  const seven = response();
  await app.routes.get('GET /api/llm/usage/report')({ query: { days: '7' } }, seven);
  assert.deepEqual(seen[1], { days: 7 }, '整数原样传给服务层');
  assert.equal(seven.payload.days, 7);

  const beyond = response();
  await app.routes.get('GET /api/llm/usage/report')({ query: { days: '9999' } }, beyond);
  assert.deepEqual(seen[2], { days: 9999 }, '越界不在路由层改写，由账本按保留期夹紧');

  for (const invalid of ['abc', '-3', '0', '']) {
    const res = response();
    await app.routes.get('GET /api/llm/usage/report')({ query: { days: invalid } }, res);
    assert.deepEqual(seen.at(-1), {}, `非法 days=${invalid || '空'} 交给服务层回落默认`);
    assert.equal(res.payload.ok, true);
  }
  assert.equal(seen.length, 7, '每次请求只调一次报告接口，没有额外写操作');
});

test('用量报告路由：没有 llm settings 服务时 503，不抛错', async () => {
  const app = fakeApp();
  registerLlmRoutes(app, {});
  const res = response();
  await app.routes.get('GET /api/llm/usage/report')({ query: { days: '7' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.ok, false);
});

test('故障切换策略路由：GET 默认关闭、PUT 合法保存、非法目标 400 且不回显凭据', async t => {
  makeConfigDir(t);
  const { service } = makeService();
  const app = fakeApp();
  registerLlmRoutes(app, { llmSettingsService: service });

  const provider = (await service.createProvider({
    name: 'p', baseUrl: 'http://p/v1', apiKey: 'sk-routes-secret', models: ['m1', 'm2'],
  })).provider;

  const initial = response();
  await app.routes.get('GET /api/llm/failover')({}, initial);
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.payload, {
    ok: true,
    policy: { enabled: false, allowCrossProvider: false, targets: [] },
  });
  assert.equal(JSON.stringify(initial.payload).includes('sk-routes-secret'), false);

  const saved = response();
  await app.routes.get('PUT /api/llm/failover')({
    body: { enabled: true, allowCrossProvider: false, targets: [{ providerId: provider.id, model: 'm2' }] },
  }, saved);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.payload.policy,
    { enabled: true, allowCrossProvider: false, targets: [{ providerId: provider.id, model: 'm2' }] });

  const invalid = response();
  await app.routes.get('PUT /api/llm/failover')({
    body: { enabled: true, targets: [{ providerId: provider.id, model: 'not-enabled' }] },
  }, invalid);
  assert.equal(invalid.statusCode, 400, '非法目标必须如实 400，不能静默保存');
  assert.equal(invalid.payload.ok, false);
  assert.match(invalid.payload.error, /不在该 provider/);
  assert.equal(JSON.stringify(invalid.payload).includes('sk-routes-secret'), false);

  const after = response();
  await app.routes.get('GET /api/llm/failover')({}, after);
  assert.deepEqual(after.payload.policy.targets, [{ providerId: provider.id, model: 'm2' }],
    '失败的 PUT 不覆盖已保存策略');
});

test('故障切换策略路由：没有 llm settings 服务时 503', async () => {
  const app = fakeApp();
  registerLlmRoutes(app, {});
  const get = response();
  await app.routes.get('GET /api/llm/failover')({}, get);
  assert.equal(get.statusCode, 503);
  assert.equal(get.payload.ok, false);

  const put = response();
  await app.routes.get('PUT /api/llm/failover')({ body: {} }, put);
  assert.equal(put.statusCode, 503);
});
