import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsController, validateEndpointSelection } from './settingsController.js';

test('settings load and save retain provider endpoint contract without a global voice field', async () => {
  const calls = [];
  const apiClient = {
    get: async () => ({ ok: true, current: { llm: { ready: true } }, options: { source: [{ id: 'qq' }], tts: [] } }),
    post: async (...args) => { calls.push(args); return { ok: true, current: { source: 'qq' } }; },
  };
  const controller = createSettingsController({ apiClient });
  const loaded = await controller.load();
  assert.equal(loaded.current.llm.ready, true);
  // 全局声音是遗留死字段（所有合成调用都显式按伙伴 voiceProfileId），设置页
  // 不再提交它；即使调用方误传也不入载荷，避免复活旧语义。
  await controller.save({ baseUrl: 'https://llm', apiKey: 'k', model: 'm', source: 'qq', primarySource: 'qq', voice: 'vp_sweet_lady' });
  assert.deepEqual(calls[0], ['/api/settings', {
    baseUrl: 'https://llm', apiKey: 'k', model: 'm', source: 'qq', primarySource: 'qq',
  }]);
  assert.equal('voice' in calls[0][1], false);
});

test('load 保留 provider 状态与声音选项', async () => {
  const apiClient = {
    get: async () => ({
      ok: true,
      current: {},
      options: {
        source: [],
        tts: [{ id: 'vp_sweet_lady', name: '柔声女声', isFallback: true }],
        ttsProviders: [{ id: 'system', configured: true }],
      },
    }),
    post: async () => ({ ok: true }),
  };
  const controller = createSettingsController({ apiClient });
  const loaded = await controller.load();
  assert.equal(loaded.options.tts[0].id, 'vp_sweet_lady');
  assert.equal(loaded.options.ttsProviders[0].id, 'system');
});

test('缺失或畸形选项被规范化为空数组而不是 undefined', async () => {
  const apiClient = { get: async () => ({ ok: true, current: {} }), post: async () => ({ ok: true }) };
  const controller = createSettingsController({ apiClient });
  const loaded = await controller.load();
  assert.deepEqual(loaded.options.tts, []);
  assert.deepEqual(loaded.options.source, []);
  assert.deepEqual(loaded.options.ttsProviders, []);
});

test('loadTtsStatus 只返回现有 provider 状态，不再提供模型下载', async () => {
  const controller = createSettingsController({ apiClient: { get: async () => ({ ok: true, providers: [{ id: 'system', configured: true }] }) } });
  assert.deepEqual(await controller.loadTtsStatus(), { providers: [{ id: 'system', configured: true }] });
  assert.equal(controller.downloadTtsModel, undefined);
});

test('endpoint selection allows blank key only when one is already stored', () => {
  assert.equal(validateEndpointSelection({ baseUrl: 'x', model: 'm', apiKey: '', apiKeySet: true }).ready, true);
  assert.equal(validateEndpointSelection({ baseUrl: 'x', model: 'm', apiKey: '', apiKeySet: false }).ready, false);
});
test('setLocation and clearLocation hit the location endpoints and update snapshot', async () => {
  const calls = [];
  const apiClient = {
    get: async () => ({ ok: true, current: {}, options: { source: [], tts: [] } }),
    post: async (path, body) => { calls.push(['POST', path, body]); return { ok: true, location: { cityName: '杭州', resolvedName: '杭州 · 浙江省 · 中国' } }; },
    delete: async path => { calls.push(['DELETE', path]); return { ok: true, location: null }; },
  };
  const controller = createSettingsController({ apiClient });
  await controller.load();

  const saved = await controller.setLocation('杭州');
  assert.deepEqual(calls[0], ['POST', '/api/settings/location', { city: '杭州' }]);
  assert.equal(saved.location.resolvedName, '杭州 · 浙江省 · 中国');
  assert.equal(controller.getSnapshot().current.location.cityName, '杭州');

  await controller.clearLocation();
  assert.deepEqual(calls[1], ['DELETE', '/api/settings/location']);
  assert.equal(controller.getSnapshot().current.location, null);
});

test('setLocation 失败时把服务端可纠正错误抛给界面', async () => {
  const apiClient = {
    get: async () => ({ ok: true, current: {}, options: { source: [], tts: [] } }),
    post: async () => ({ ok: false, error: '没有找到“xyz”，换个写法试试。' }),
  };
  const controller = createSettingsController({ apiClient });
  await controller.load();
  await assert.rejects(() => controller.setLocation('xyz'), /没有找到/);
});

test('redetectLocation hits the auto endpoint and marks source auto', async () => {
  const calls = [];
  const apiClient = {
    get: async () => ({ ok: true, current: {}, options: { source: [], tts: [] } }),
    post: async (path, body) => { calls.push([path, body]); return { ok: true, location: { cityName: '苏州', resolvedName: '苏州 · 江苏省 · 中国', source: 'auto' } }; },
  };
  const controller = createSettingsController({ apiClient });
  await controller.load();

  const result = await controller.redetectLocation();

  assert.deepEqual(calls[0], ['/api/settings/location/auto', undefined]);
  assert.equal(result.location.source, 'auto');
  assert.equal(controller.getSnapshot().current.location.cityName, '苏州');
});

test('声音设计：生成、起草、转正与伙伴列表各走自己的端点', async () => {
  const calls = [];
  const apiClient = {
    get: async path => { calls.push(['get', path]); return { ok: true, persons: [{ id: 'xm', displayName: '小满', personaDocument: '不该被带进设置页' }] }; },
    post: async (path, body) => {
      calls.push([path, body]);
      if (path.endsWith('/design')) return { ok: true, candidates: [{ generatedId: 'g', previewUrl: '/tts/g.mp3' }] };
      if (path.endsWith('/design-draft')) return { ok: true, description: '清亮女声' };
      return { ok: true, voiceId: 'voc_new' };
    },
  };
  const controller = createSettingsController({ apiClient });
  assert.deepEqual(await controller.listPersons(), [{ id: 'xm', displayName: '小满' }], '设置页只要 id 和名字');
  assert.deepEqual(await controller.draftVoiceDescription('xm'), { description: '清亮女声' });
  assert.deepEqual(await controller.designCustomVoices({ endpointId: 'custom', description: 'd', previewText: 'p', count: 2 }),
    { candidates: [{ generatedId: 'g', previewUrl: '/tts/g.mp3' }] });
  assert.deepEqual(await controller.activateDesignedVoice({ endpointId: 'custom', generatedId: 'g', name: 'n', description: 'd', model: 'm' }), { voiceId: 'voc_new' });
  assert.deepEqual(calls, [
    ['get', '/api/virtual-persons'],
    ['/api/tts/custom/design-draft', { personId: 'xm' }],
    ['/api/tts/custom/design', { endpointId: 'custom', description: 'd', previewText: 'p', count: 2 }],
    ['/api/tts/custom/design-activate', { endpointId: 'custom', generatedId: 'g', name: 'n', description: 'd', model: 'm' }],
  ]);
});

test('配方试合成：通过回 passed:true；400 带摘要折成 passed:false，其他错误照常抛出', async () => {
  const responses = [
    async () => ({ ok: true, recipe: { version: 1 }, previewUrl: '/tts/a.mp3', testText: '你好' }),
    async () => { throw Object.assign(new Error('试合成没有通过'), { body: { ok: false, error: '试合成没有通过', summary: { status: 401, message: 'bad key' } } }); },
    async () => { throw new Error('无法连接 Lunara 服务'); },
  ];
  const posts = [];
  const apiClient = {
    get: async path => (path === '/api/tts/custom/recipe-presets' ? { ok: true, presets: [{ id: 'qwen-tts' }] } : {}),
    post: async (path, body) => { posts.push([path, body]); return responses.shift()(); },
  };
  const controller = createSettingsController({ apiClient });
  assert.deepEqual(await controller.loadRecipePresets(), [{ id: 'qwen-tts' }]);
  const ok = await controller.testRecipe({ presetId: 'qwen-tts' });
  assert.equal(ok.passed, true);
  assert.equal(ok.previewUrl, '/tts/a.mp3');
  assert.deepEqual(await controller.testRecipe({ recipe: {} }), { passed: false, error: '试合成没有通过', summary: { status: 401, message: 'bad key' } });
  await assert.rejects(controller.testRecipe({}), /无法连接/);
  assert.equal(posts[0][0], '/api/tts/custom/recipe-test');
});
