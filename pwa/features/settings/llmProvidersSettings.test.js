// llmProvidersSettings.test.js — provider 注册表布局 + 模型行四动作（离线 fake DOM + apiClient 替身）。
// 断言风格与 routineSettings.test.js 一致：host.innerHTML 文本 + 解析节点的属性查询。

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlmProvidersSettings } from './llmProvidersSettings.js';

/** Minimal DOM stand-in: enough for markup injection, querying and click dispatch. */
function fakeDom() {
  const makeNode = (tag = 'div') => {
    const node = {
      tagName: tag.toUpperCase(), attributes: {}, _listeners: [],
      set innerHTML(value) { this._html = value; this._parsed = parse(value); },
      get innerHTML() { return this._html || ''; },
      querySelector(selector) { return (this._parsed || []).find(item => item.matches(selector)) || null; },
      querySelectorAll(selector) { return (this._parsed || []).filter(item => item.matches(selector)); },
      addEventListener(type, handler) { this._listeners.push({ type, handler }); },
      dispatch(type, payload = {}) { for (const entry of this._listeners.filter(item => item.type === type)) entry.handler({ preventDefault() {}, target: node, ...payload }); },
      getAttribute(name) { return this.attributes[name] ?? null; },
    };
    return node;
  };

  function parse(html) {
    const nodes = [];
    const elementPattern = /<(input|button|select|option|label|span|li|div|p|ul)\b([^>]*)>/giu;
    let match;
    while ((match = elementPattern.exec(html))) {
      const [, tag, rawAttrs] = match;
      const attributes = {};
      const attrPattern = /([a-zA-Z-]+)(?:="([^"]*)")?/gu;
      let attr;
      while ((attr = attrPattern.exec(rawAttrs))) attributes[attr[1]] = attr[2] ?? '';
      const node = {
        tagName: tag.toUpperCase(), attributes,
        matches(selector) {
          if (selector.startsWith('#')) return attributes.id === selector.slice(1);
          const bracket = selector.match(/^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/u);
          if (!bracket) return false;
          const [, tagName, attrName, attrValue] = bracket;
          if (tagName && tag.toUpperCase() !== tagName.toUpperCase()) return false;
          if (!Object.hasOwn(attributes, attrName)) return false;
          return attrValue === undefined ? true : attributes[attrName] === attrValue;
        },
        checked: Object.hasOwn(attributes, 'checked'), value: attributes.value ?? '',
        _listeners: [],
        addEventListener(type, handler) { this._listeners.push({ type, handler }); },
        dispatch(type, payload = {}) { for (const entry of this._listeners.filter(item => item.type === type)) entry.handler({ preventDefault() {}, target: node, ...payload }); },
        getAttribute(name) { return attributes[name] ?? null; },
        setAttribute(name, value) { attributes[name] = String(value); },
      };
      nodes.push(node);
    }
    return nodes;
  }

  const host = makeNode('div');
  const activeHost = makeNode('div');
  const documentLike = {
    querySelector: selector => (selector === '#llm-providers-settings' ? host
      : selector === '#llm-active-model-settings' ? activeHost : null),
  };
  return { host, activeHost, documentLike };
}

function fakeApi({ registry = null, discover = null, onCreate = null, onUpdate = null, onActive = null } = {}) {
  const calls = [];
  const apiClient = {
    get: async path => { calls.push(['GET', path]); return path === '/api/llm/providers' ? (registry ?? {}) : {}; },
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      if (path === '/api/llm/providers/discover-models') return discover ?? { ok: true, models: [] };
      return onCreate?.(body) ?? {};
    },
    put: async (path, body) => {
      calls.push(['PUT', path, body]);
      if (path === '/api/llm/active-model') return onActive?.(body) ?? { ok: true };
      if (path.startsWith('/api/llm/providers/')) return onUpdate?.(body) ?? { ok: true };
      return {};
    },
    delete: async path => { calls.push(['DELETE', path]); return { ok: true }; },
  };
  apiClient.calls = calls;
  return apiClient;
}

const REGISTRY = {
  ok: true,
  providers: [{
    id: 'p-magpie', name: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', api: 'openai-responses',
    models: ['deepseek/deepseek-flash', 'zhipu/glm-5.3'], enabled: true, hasKey: true, modelCount: 2,
    disabledModels: [],
  }],
  activeModel: { providerId: 'p-magpie', model: 'deepseek/deepseek-flash' },
};

function registryWith(overrides = {}) {
  return { ...REGISTRY, providers: [{ ...REGISTRY.providers[0], ...overrides }] };
}

function setup(overrides = {}) {
  const dom = fakeDom();
  const apiClient = fakeApi({
    registry: overrides.registry ?? REGISTRY,
    discover: overrides.discover,
    onCreate: overrides.onCreate,
    onUpdate: overrides.onUpdate,
    onActive: overrides.onActive,
  });
  const view = createLlmProvidersSettings({ apiClient, documentLike: dom.documentLike });
  return { dom, apiClient, view };
}

const settle = async () => new Promise(resolve => setTimeout(resolve, 5));
const rowsOf = dom => dom.host.querySelectorAll('[data-llm-model-row]')
  .map(node => node.attributes['data-llm-model-row']);

test('打开即渲染 provider 列表、模型行、启用开关与使用中下拉', async () => {
  const { dom, view } = setup();
  await view.refresh();
  const html = dom.host.innerHTML;
  assert.match(html, /magpie/);
  assert.match(html, /2 模型/);
  assert.match(html, /value="http:\/\/127\.0\.0\.1:3425\/v1"/);
  assert.match(html, /已保存（留空保持不变）/);
  assert.deepEqual(rowsOf(dom).sort(), ['deepseek/deepseek-flash', 'zhipu/glm-5.3']);
  // 每行右侧四个动作齐全，开关暴露 role=switch 与 aria-checked。
  for (const model of rowsOf(dom)) {
    for (const attr of ['data-llm-test-model', 'data-llm-edit-model', 'data-llm-remove-model', 'data-llm-model-toggle']) {
      assert.equal(dom.host.querySelectorAll(`[${attr}="${model}"]`).length, 1, `${attr} ${model}`);
    }
    const toggle = dom.host.querySelector(`[data-llm-model-toggle="${model}"]`);
    assert.equal(toggle.attributes.role, 'switch');
    assert.equal(toggle.attributes['aria-checked'], 'true');
  }
  const activeHtml = dom.activeHost.innerHTML;
  assert.match(activeHtml, /value="p-magpie::deepseek\/deepseek-flash" selected/);
  assert.match(activeHtml, /magpie · deepseek\/deepseek-flash/);
  assert.match(activeHtml, /当前使用：magpie · deepseek\/deepseek-flash/);
  assert.doesNotMatch(html, /当前使用：/, 'Provider 宿主不再嵌使用中卡');
});

test('使用中模型卡只留选择与说明，用量入口指向「使用统计」页', async () => {
  const { dom, view } = setup();
  await view.refresh();
  const activeHtml = dom.activeHost.innerHTML;
  assert.match(activeHtml, /id="llm-active-note"/);
  assert.match(activeHtml, /data-settings-page-link="usage"/, '提供跳转到使用统计页的入口');
  assert.match(activeHtml, /查看使用统计/);
  // 用量行已移出这张卡：不再请求 /api/llm/usage，也不渲染今日摘要。
  assert.doesNotMatch(activeHtml, /llm-usage-note|今日 .*次调用/u);
  assert.doesNotMatch(dom.host.innerHTML, /llm-usage-note/u);
});

test('旧配置没有 disabledModels 时全部按启用显示', async () => {
  const { dom, view } = setup({ registry: registryWith({ disabledModels: undefined }) });
  await view.refresh();
  const toggles = dom.host.querySelectorAll('[data-llm-model-toggle]');
  assert.equal(toggles.length, 2);
  assert.ok(toggles.every(node => node.attributes['aria-checked'] === 'true'), '缺字段即全部启用');
});

test('停用模型仍留在列表、开关关闭、不出现在使用中下拉', async () => {
  const { dom, view } = setup({ registry: registryWith({ disabledModels: ['zhipu/glm-5.3'] }) });
  await view.refresh();
  assert.deepEqual(rowsOf(dom).sort(), ['deepseek/deepseek-flash', 'zhipu/glm-5.3'], '停用不等于删除');
  assert.match(dom.host.innerHTML, /已停用/);
  assert.equal(dom.host.querySelector('[data-llm-model-toggle="zhipu/glm-5.3"]').attributes['aria-checked'], 'false');
  assert.equal(dom.host.querySelector('[data-llm-model-toggle="deepseek/deepseek-flash"]').attributes['aria-checked'], 'true');
  assert.match(dom.host.innerHTML, /2 模型 · 1 停用/, 'Provider 列表同时给出停用数量');
  const activeHtml = dom.activeHost.innerHTML;
  assert.doesNotMatch(activeHtml, /zhipu\/glm-5\.3/, '停用模型不能出现在使用中下拉');
});

test('行内开关只改停用草稿，保存 Provider 时写 disabledModels', async () => {
  const updated = [];
  const { dom, apiClient, view } = setup({
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 2, enabled: true, hasKey: true } }; },
  });
  await view.refresh();
  dom.host.querySelector('[data-llm-model-toggle="zhipu/glm-5.3"]').dispatch('click');
  assert.equal(dom.host.querySelector('[data-llm-model-toggle="zhipu/glm-5.3"]').attributes['aria-checked'], 'false');
  assert.match(dom.host.innerHTML, /已停用/, '未保存前也如实显示停用状态');
  assert.equal(apiClient.calls.filter(call => call[0] === 'PUT').length, 0, '开关不立即写盘');

  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(updated[0].disabledModels, ['zhipu/glm-5.3']);
  assert.deepEqual(updated[0].models, ['deepseek/deepseek-flash', 'zhipu/glm-5.3']);
});

test('重新启用：开关切回并保存后 disabledModels 为空', async () => {
  const updated = [];
  const { dom, view } = setup({
    registry: registryWith({ disabledModels: ['zhipu/glm-5.3'] }),
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 2, enabled: true, hasKey: true } }; },
  });
  await view.refresh();
  dom.host.querySelector('[data-llm-model-toggle="zhipu/glm-5.3"]').dispatch('click');
  assert.equal(dom.host.querySelector('[data-llm-model-toggle="zhipu/glm-5.3"]').attributes['aria-checked'], 'true');
  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(updated[0].disabledModels, []);
});

test('删除行：只移出编辑列表，保存后 models 不再包含它', async () => {
  const updated = [];
  const { dom, view } = setup({
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 1, enabled: true, hasKey: true } }; },
  });
  await view.refresh();
  dom.host.querySelector('[data-llm-remove-model="zhipu/glm-5.3"]').dispatch('click');
  assert.deepEqual(rowsOf(dom), ['deepseek/deepseek-flash']);
  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(updated[0].models, ['deepseek/deepseek-flash']);
});

test('编辑：行内展开模型 id 与手动能力声明，改名随保存生效', async () => {
  const updated = [];
  const { dom, view } = setup({
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 2, enabled: true, hasKey: true } }; },
  });
  await view.refresh();
  assert.equal(dom.host.querySelector('[data-llm-model-editor]'), null, '默认不展开');

  dom.host.querySelector('[data-llm-edit-model="zhipu/glm-5.3"]').dispatch('click');
  assert.equal(dom.host.querySelector('[data-llm-edit-model="zhipu/glm-5.3"]').attributes['aria-expanded'], 'true');
  const editor = dom.host.querySelector('[data-llm-model-editor="zhipu/glm-5.3"]');
  assert.ok(editor, '行内编辑面板');
  assert.ok(dom.host.querySelector('[data-llm-model-rename="zhipu/glm-5.3"]'), '模型 id 可改');
  for (const field of ['default', 'disable', 'knob', 'structured']) {
    assert.ok(dom.host.querySelector(`[data-llm-cap-${field}="zhipu/glm-5.3"]`), `能力声明 ${field}`);
  }
  assert.ok(dom.host.querySelector('[data-llm-probe-model="zhipu/glm-5.3"]'), '编辑里有探测');

  const rename = dom.host.querySelector('[data-llm-model-rename="zhipu/glm-5.3"]');
  rename.value = 'zhipu/glm-5.3-preview';
  rename.dispatch('change');
  assert.deepEqual(rowsOf(dom).sort(), ['deepseek/deepseek-flash', 'zhipu/glm-5.3-preview']);

  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(updated[0].models, ['deepseek/deepseek-flash', 'zhipu/glm-5.3-preview']);
});

test('编辑面板 Esc 收起并请求把焦点还给编辑按钮', async () => {
  const { dom, view } = setup();
  await view.refresh();
  dom.host.querySelector('[data-llm-edit-model="zhipu/glm-5.3"]').dispatch('click');
  const editor = dom.host.querySelector('[data-llm-model-editor="zhipu/glm-5.3"]');
  editor.dispatch('keydown', { key: 'Escape' });
  assert.equal(dom.host.querySelector('[data-llm-model-editor]'), null);
  assert.equal(dom.host.querySelector('[data-llm-edit-model="zhipu/glm-5.3"]').attributes['aria-expanded'], 'false');
});

test('获取模型列表把发现的模型并入列表并如实报告', async () => {
  const { dom, view } = setup({ discover: { ok: true, models: ['m-new', 'm-two'] } });
  await view.refresh();
  dom.host.querySelector('#llm-prov-discover').dispatch('click');
  await settle();
  const html = dom.host.innerHTML;
  assert.match(html, /m-new/);
  assert.match(html, /m-two/);
  assert.match(html, /发现 2 个模型/);
  // 发现但未接入的候选行开关关闭；打开即接入。
  assert.equal(dom.host.querySelector('[data-llm-model-toggle="m-new"]').attributes['aria-checked'], 'false');
  dom.host.querySelector('[data-llm-model-toggle="m-new"]').dispatch('click');
  assert.equal(dom.host.querySelector('[data-llm-model-toggle="m-new"]').attributes['aria-checked'], 'true');
});

test('保存走 POST/PUT 且 key 留空原样传空（服务端负责保留）', async () => {
  const created = [];
  const updated = [];
  const { dom, view } = setup({
    onCreate: body => { created.push(body); return { ok: true, provider: { id: 'p-new', name: body.name, modelCount: body.models.length, enabled: true, hasKey: Boolean(body.apiKey) } }; },
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 2, enabled: true, hasKey: true } }; },
  });
  await view.refresh();

  dom.host.querySelector('#llm-provider-add').dispatch('click');
  dom.host.querySelector('#llm-prov-name').value = 'zhipu';
  dom.host.querySelector('#llm-prov-url').value = 'http://z/v1';
  dom.host.querySelector('#llm-prov-manual').value = 'glm-5.3';
  dom.host.querySelector('#llm-prov-manual-add').dispatch('click');
  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(created[0], {
    name: 'zhipu', baseUrl: 'http://z/v1', apiKey: '', api: 'openai-completions', enabled: true,
    models: ['glm-5.3'], disabledModels: [], modelInfo: {}, modelDefaults: {},
  });

  dom.host.querySelector('[data-llm-select-provider="p-magpie"]').dispatch('click');
  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(updated[0], {
    name: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', apiKey: '', api: 'openai-responses',
    enabled: true, models: ['deepseek/deepseek-flash', 'zhipu/glm-5.3'], disabledModels: [],
    modelInfo: {}, modelDefaults: {},
  }, 'key 留空原样传空，服务端保留旧值');
});

test('Provider 启用开关保存在 enabled 字段', async () => {
  const updated = [];
  const { dom, view } = setup({
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 2, enabled: false, hasKey: true } }; },
  });
  await view.refresh();
  dom.host.querySelector('#llm-prov-enabled').dispatch('click');
  assert.equal(dom.host.querySelector('#llm-prov-enabled').getAttribute('aria-checked'), 'false');
  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.equal(updated[0].enabled, false);
});

test('使用中模型切换发送 providerId+model', async () => {
  const activeCalls = [];
  const { dom, view } = setup({ onActive: body => { activeCalls.push(body); return { ok: true }; } });
  await view.refresh();
  const select = dom.activeHost.querySelector('#llm-active-model');
  select.value = 'p-magpie::zhipu/glm-5.3';
  select.dispatch('change');
  await settle();
  assert.deepEqual(activeCalls[0], { providerId: 'p-magpie', model: 'zhipu/glm-5.3' });
});

test('注册表读取失败时如实显示错误而不是空屏', async () => {
  const dom = fakeDom();
  const apiClient = fakeApi({});
  apiClient.get = async () => { throw new Error('offline'); };
  const view = createLlmProvidersSettings({ apiClient, documentLike: dom.documentLike });
  await view.refresh();
  assert.match(dom.host.innerHTML, /模型配置读取失败/);
});

test('连通性测试按钮逐个调用 /api/llm/test-model 并把结果放在对应行', async () => {
  const testCalls = [];
  const dom = fakeDom();
  const apiClient = {
    get: async path => (path === '/api/llm/providers' ? REGISTRY : {}),
    post: async (path, body) => {
      if (path === '/api/llm/test-model') {
        testCalls.push(body);
        if (body.model === 'zhipu/glm-5.3') throw new Error('LLM API 401: bad key');
        return { ok: true, latencyMs: 823, reply: '正常' };
      }
      return {};
    },
    put: async () => ({}), delete: async () => ({}),
  };
  const view = createLlmProvidersSettings({ apiClient, documentLike: dom.documentLike });
  await view.refresh();
  dom.host.querySelector('#llm-prov-test').dispatch('click');
  await settle();
  await settle();
  const html = dom.host.innerHTML;
  assert.match(html, /✓ 823ms · 正常/);
  assert.match(html, /✗ LLM API 401/);
  assert.deepEqual(testCalls.map(call => call.model), ['deepseek/deepseek-flash', 'zhipu/glm-5.3']);
  // 测试用的是编辑区当前值（未保存也能测）
  assert.equal(testCalls[0].baseUrl, 'http://127.0.0.1:3425/v1');
});

test('每个模型行内单独测试：只测点击的那一个，思维链从展示中剥离', async () => {
  const testCalls = [];
  const dom = fakeDom();
  const apiClient = {
    get: async path => (path === '/api/llm/providers' ? REGISTRY : {}),
    post: async (path, body) => {
      if (path === '/api/llm/test-model') {
        testCalls.push(body);
        return { ok: true, latencyMs: 912, reply: '<think>reasoning here</think> 正常' };
      }
      return {};
    },
    put: async () => ({}), delete: async () => ({}),
  };
  const view = createLlmProvidersSettings({ apiClient, documentLike: dom.documentLike });
  await view.refresh();

  assert.equal(dom.host.querySelectorAll('[data-llm-test-model]').length, 2, '每行一个行内测试按钮');
  dom.host.querySelector('[data-llm-test-model="zhipu/glm-5.3"]').dispatch('click');
  await settle();
  await settle();
  assert.deepEqual(testCalls.map(call => call.model), ['zhipu/glm-5.3'], '行内测试只测被点击的模型');
  assert.match(dom.host.innerHTML, /✓ 912ms · 正常/);
  assert.doesNotMatch(dom.host.innerHTML, /<think>/, '思维链必须从结果展示中剥离');
  assert.equal(dom.host.querySelectorAll('[data-llm-test-result="deepseek/deepseek-flash"]').length, 0, '未点击的模型不出结果');
});

test('批量测试不再有 5 个上限：接入多少测多少', async () => {
  const testCalls = [];
  const dom = fakeDom();
  const bigRegistry = {
    ok: true,
    providers: [{ id: 'p', name: 'magpie', baseUrl: 'http://g/v1', api: 'openai-completions',
      models: Array.from({ length: 7 }, (_, index) => `m-${index + 1}`), enabled: true, hasKey: false, modelCount: 7, disabledModels: [] }],
    activeModel: { providerId: 'p', model: 'm-1' },
  };
  const apiClient = {
    get: async path => (path === '/api/llm/providers' ? bigRegistry : {}),
    post: async (path, body) => {
      if (path === '/api/llm/test-model') { testCalls.push(body.model); return { ok: true, latencyMs: 10, reply: '正常' }; }
      return {};
    },
    put: async () => ({}), delete: async () => ({}),
  };
  const view = createLlmProvidersSettings({ apiClient, documentLike: dom.documentLike });
  await view.refresh();
  dom.host.querySelector('#llm-prov-test').dispatch('click');
  for (let i = 0; i < 12; i++) await settle();
  assert.equal(testCalls.length, 7, '7 个已接入模型全部被测');
});

test('能力状态行与探测按钮：未识别如实显示，探测走 /api/llm/probe-capability', async () => {
  const registry = {
    ok: true,
    providers: [{
      id: 'p-magpie', name: 'magpie', baseUrl: 'http://127.0.0.1:3425/v1', api: 'openai-responses',
      models: ['deepseek/deepseek-flash'], enabled: true, hasKey: true, modelCount: 1, disabledModels: [],
      capabilities: {
        'deepseek/deepseek-flash': {
          family: 'deepseek', thinking: { default: 'on', canDisable: true, budgetKnob: null },
          structuredOutput: 'json_object', source: 'probe', probedAt: '2026-10-15T08:00:00.000Z',
          caps: { contextWindow: 1_000_000 },
        },
      },
    }],
    activeModel: { providerId: 'p-magpie', model: 'deepseek/deepseek-flash' },
  };
  const probing = [];
  const { dom, apiClient, view } = setup({ registry });
  apiClient.post = async (path, body) => {
    apiClient.calls.push(['POST', path, body]);
    if (path === '/api/llm/probe-capability') {
      probing.push(body);
      return { ok: true, capability: { thinking: { default: 'on', canDisable: true }, structuredOutput: 'json_object', source: 'probe', probedAt: '2026-10-15T09:00:00.000Z' } };
    }
    return {};
  };
  await view.refresh();

  // 一行能力状态 + 上下文窗口徽标。
  assert.match(dom.host.innerHTML, /思考开启·可关闭·结构化 json_object（2026-10-15 自动探测）/u);
  assert.match(dom.host.innerHTML, /class="llm-badge" title="上下文窗口">1M<\/span>/);

  dom.host.querySelector('[data-llm-edit-model="deepseek/deepseek-flash"]').dispatch('click');
  dom.host.querySelector('[data-llm-probe-model="deepseek/deepseek-flash"]').dispatch('click');
  await settle();
  await settle();
  assert.deepEqual(probing, [{ providerId: 'p-magpie', model: 'deepseek/deepseek-flash' }]);
  assert.match(dom.host.innerHTML, /探测完成/u);
});

test('未识别模型如实显示"未识别"，而不是编造能力', async () => {
  const { dom, view } = setup();
  await view.refresh();
  assert.match(dom.host.innerHTML, /未识别（保守额度运行/u);
});

test('行内「保存能力声明」只写该模型的 /api/llm/capabilities（source user 由服务端落库）', async () => {
  const { dom, apiClient, view } = setup();
  await view.refresh();
  assert.equal(dom.host.querySelectorAll('[data-llm-cap-default]').length, 0, '未展开时没有能力声明控件');
  dom.host.querySelector('[data-llm-edit-model="zhipu/glm-5.3"]').dispatch('click');
  dom.host.querySelector('[data-llm-cap-default="zhipu/glm-5.3"]').value = 'on';
  dom.host.querySelector('[data-llm-cap-disable="zhipu/glm-5.3"]').value = 'true';
  dom.host.querySelector('[data-llm-cap-knob="zhipu/glm-5.3"]').value = 'thinking_budget';
  dom.host.querySelector('[data-llm-cap-structured="zhipu/glm-5.3"]').value = 'json_schema';
  dom.host.querySelector('[data-llm-cap-save="zhipu/glm-5.3"]').dispatch('click');
  await settle();
  const putCalls = apiClient.calls.filter(call => call[0] === 'PUT' && call[1] === '/api/llm/capabilities');
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0][2].model, 'zhipu/glm-5.3');
  assert.deepEqual(putCalls[0][2].capability.thinking, { default: 'on', canDisable: true, budgetKnob: 'thinking_budget' });
  assert.equal(putCalls[0][2].capability.structuredOutput, 'json_schema');
});

test('模型元数据与默认思考档：徽标、只列声明档位、保存携带 modelInfo/modelDefaults', async () => {
  const updated = [];
  const registry = registryWith({
    modelInfo: {
      'zhipu/glm-5.3': { reasoningEfforts: ['low', 'high', 'max'], contextWindow: 1_000_000 },
      'deepseek/deepseek-flash': { reasoningEfforts: ['none', 'low', 'high'] },
    },
    modelDefaults: { 'zhipu/glm-5.3': { reasoningEffort: 'low' } },
  });
  const { dom, view } = setup({
    registry,
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 2, enabled: true, hasKey: true } }; },
  });
  await view.refresh();
  assert.match(dom.host.innerHTML, /思考·低/, '行徽标显示模型默认档');
  assert.match(dom.host.innerHTML, /title="上下文窗口">1M/, '发现到的上下文窗口直接显示');

  dom.host.querySelector('[data-llm-edit-model="zhipu/glm-5.3"]').dispatch('click');
  assert.ok(dom.host.querySelector('[data-llm-effort-default="zhipu/glm-5.3"]'), '行内编辑有对话思考强度');
  const html = dom.host.innerHTML;
  assert.match(html, /data-llm-effort-default="zhipu\/glm-5\.3"[\s\S]{0,400}?value="low" selected/, '默认档选中');
  assert.match(html, /data-llm-effort-default="zhipu\/glm-5\.3"[\s\S]{0,600}?value="high"/);
  assert.match(html, /data-llm-effort-default="zhipu\/glm-5\.3"[\s\S]{0,600}?value="max"/);
  assert.doesNotMatch(html, /data-llm-effort-default="zhipu\/glm-5\.3"[\s\S]{0,600}?value="medium"/, '未声明档位不出现');

  const select = dom.host.querySelector('[data-llm-effort-default="zhipu/glm-5.3"]');
  select.value = 'high';
  select.dispatch('change');
  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(updated[0].modelDefaults['zhipu/glm-5.3'], { reasoningEffort: 'high' });
  assert.deepEqual(updated[0].modelInfo['zhipu/glm-5.3'].reasoningEfforts, ['low', 'high', 'max']);
  assert.deepEqual(updated[0].modelInfo['zhipu/glm-5.3'].contextWindow, 1_000_000);
});

test('没有档位信息的模型只提供「模型默认」', async () => {
  const { dom, view } = setup();
  await view.refresh();
  dom.host.querySelector('[data-llm-edit-model="zhipu/glm-5.3"]').dispatch('click');
  assert.ok(dom.host.querySelector('[data-llm-effort-default="zhipu/glm-5.3"]'));
  const html = dom.host.innerHTML;
  assert.match(html, /data-llm-effort-default="zhipu\/glm-5\.3"[\s\S]{0,200}?模型默认/);
  assert.doesNotMatch(html, /data-llm-effort-default="zhipu\/glm-5\.3"[\s\S]{0,200}?value="low"/);
  // 清空默认档不会伪造一个偏好。
  const select = dom.host.querySelector('[data-llm-effort-default="zhipu/glm-5.3"]');
  select.value = '';
  select.dispatch('change');
  assert.doesNotMatch(dom.host.innerHTML, /思考·/);
});

test('获取模型列表保留声明的档位与容量，并在保存时写入 modelInfo', async () => {
  const updated = [];
  const { dom, view } = setup({
    discover: { ok: true, models: [{ id: 'm-rich', reasoningEfforts: ['low', 'max'], contextWindow: 272000 }] },
    onUpdate: body => { updated.push(body); return { ok: true, provider: { id: 'p-magpie', modelCount: 3, enabled: true, hasKey: true } }; },
  });
  await view.refresh();
  dom.host.querySelector('#llm-prov-discover').dispatch('click');
  await settle();
  assert.match(dom.host.innerHTML, /262\.5K|272K/, '发现到的容量显示为徽标');
  dom.host.querySelector('[data-llm-model-toggle="m-rich"]').dispatch('click');
  dom.host.querySelector('#llm-prov-save').dispatch('click');
  await settle();
  assert.deepEqual(updated[0].modelInfo['m-rich'], { reasoningEfforts: ['low', 'max'], contextWindow: 272000 });
  assert.deepEqual(updated[0].models, ['deepseek/deepseek-flash', 'zhipu/glm-5.3', 'm-rich']);
});
