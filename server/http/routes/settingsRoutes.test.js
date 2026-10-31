import assert from 'node:assert/strict';
import test from 'node:test';

import { registerSettingsRoutes } from './settingsRoutes.js';

function fakeApp() {
  const routes = new Map();
  return {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
    routes,
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function baseServices() {
  return {
    settingsService: { snapshot: async () => ({ current: {} }), update: async () => ({ current: {} }) },
    healthService: { snapshot: async () => ({}) },
    ttsStatusService: { status: () => ({ providers: [] }) },
    ttsPreviewService: { preview: async () => ({}) },
  };
}

test('location endpoints store, clear and report environment payload', async () => {
  const calls = [];
  const app = fakeApp();
  registerSettingsRoutes(app, {
    ...baseServices(),
    locationService: {
      setLocation: async city => { calls.push(['set', city]); return { location: { cityName: '杭州', resolvedName: '杭州 · 浙江省 · 中国', latitude: 30.27, longitude: 120.16, source: 'manual' } }; },
      clearLocation: async () => { calls.push(['clear']); return { ok: true }; },
      redetectLocation: async () => { calls.push(['redetect']); return { location: { cityName: '杭州', resolvedName: '杭州 · 浙江省 · 中国', latitude: 30.27, longitude: 120.16, source: 'auto' } }; },
    },
    environmentService: { getNow: () => ({}), environmentEvent: async () => ({ available: true, cityName: '杭州', summaryZh: '雨', tempC: 24 }) },
  });

  const setRes = response();
  await app.routes.get('POST /api/settings/location')({ body: { city: '杭州' } }, setRes);
  assert.equal(setRes.statusCode, 200);
  assert.deepEqual(calls[0], ['set', '杭州']);
  // 城市名回给界面，坐标不出接口
  assert.deepEqual(setRes.payload, { ok: true, location: { cityName: '杭州', resolvedName: '杭州 · 浙江省 · 中国', source: 'manual' } });

  const clearRes = response();
  await app.routes.get('DELETE /api/settings/location')({}, clearRes);
  assert.equal(clearRes.statusCode, 200);
  assert.deepEqual(clearRes.payload, { ok: true, location: null });

  const envRes = response();
  await app.routes.get('GET /api/environment')({}, envRes);
  assert.equal(envRes.payload.ok, true);
  assert.equal(envRes.payload.environment.available, true);
  assert.equal(JSON.stringify(envRes.payload).includes('120.16'), false);
});

test('location errors fail closed with 400 and a correctable message', async () => {
  const app = fakeApp();
  registerSettingsRoutes(app, {
    ...baseServices(),
    locationService: { setLocation: async () => ({ error: '没有找到“xyz”，换个写法试试。' }), clearLocation: async () => ({ ok: true }) },
    environmentService: { getNow: () => ({}), environmentEvent: async () => ({ available: false }) },
  });

  const res = response();
  await app.routes.get('POST /api/settings/location')({ body: { city: 'xyz' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.ok, false);
  assert.match(res.payload.error, /没有找到/);
});

test('missing services are rejected with a 503-style payload', async () => {
  const app = fakeApp();
  registerSettingsRoutes(app, baseServices());

  const res = response();
  await app.routes.get('POST /api/settings/location')({ body: { city: '杭州' } }, res);
  assert.notEqual(res.statusCode, 200);

  const envRes = response();
  await app.routes.get('GET /api/environment')({}, envRes);
  assert.notEqual(envRes.statusCode, 200);
});

test('redetect endpoint delegates to the service and returns auto location', async () => {
  const app = fakeApp();
  const calls = [];
  registerSettingsRoutes(app, {
    ...baseServices(),
    locationService: {
      setLocation: async () => ({}),
      clearLocation: async () => ({}),
      redetectLocation: async () => { calls.push('redetect'); return { location: { cityName: '苏州', resolvedName: '苏州 · 江苏省 · 中国', source: 'auto' } }; },
    },
    environmentService: { getNow: () => ({}), environmentEvent: async () => ({ available: true }) },
  });

  const res = response();
  await app.routes.get('POST /api/settings/location/auto')({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, ['redetect']);
  assert.equal(res.payload.location.source, 'auto');
});

test('custom tts endpoints：读配置不含 key、保存与发现按 endpointId、失败如实透传', async () => {
  const app = fakeApp();
  const saved = [];
  const discovered = [];
  let discoverModelsError = null;
  registerSettingsRoutes(app, {
    ...baseServices(),
    ttsCustomService: {
      getConfig: () => ({ endpoints: [{ id: 'custom', name: 'MiniMax', protocol: 'minimax', baseUrl: 'https://tts.example', model: 'm', hasKey: true }],
        voices: [{ profileId: 'vp_cx_1', endpointId: 'custom', sourceVoiceId: 'v1', displayName: '声一' }] }),
      saveConfig: patch => { saved.push(patch); return { endpoints: [], voices: patch.voices || [], savedEndpointId: 'custom-b' }; },
      discoverModels: async ({ endpointId }) => { discovered.push(['models', endpointId]); if (discoverModelsError) throw discoverModelsError; return ['m1', 'm2']; },
      discoverVoices: async ({ endpointId }) => { discovered.push(['voices', endpointId]); const error = new Error('该端点未提供声音列表（HTTP 404）'); error.code = 'TTS_CUSTOM_VOICES_UNAVAILABLE'; throw error; },
    },
  });

  const view = response();
  await app.routes.get('GET /api/tts/custom')(request(), view);
  assert.equal(view.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(view.payload), /apiKey/, '读配置不得回传 apiKey');
  assert.equal(view.payload.config.endpoints[0].hasKey, true);

  const savedView = response();
  await app.routes.get('POST /api/tts/custom')(request({ endpoint: { name: 'B', baseUrl: 'https://x', apiKey: 'sk-new' }, junk: 1 }), savedView);
  assert.deepEqual(saved[0], { endpoint: { name: 'B', baseUrl: 'https://x', apiKey: 'sk-new' } }, '只透传 endpoint 与 voices');
  assert.equal(savedView.payload.config.savedEndpointId, 'custom-b');

  for (const body of [{ voices: 'not-array' }, { endpoint: 'x' }, { endpoint: [] }]) {
    const badView = response();
    await app.routes.get('POST /api/tts/custom')(request(body), badView);
    assert.equal(badView.statusCode, 400);
  }
  assert.equal(saved.length, 1, '非法请求不得调用 saveConfig');

  const modelsView = response();
  await app.routes.get('POST /api/tts/custom/discover-models')(request({ endpointId: 'custom-b' }), modelsView);
  assert.deepEqual(modelsView.payload.models, ['m1', 'm2']);

  const voicesView = response();
  await app.routes.get('POST /api/tts/custom/discover-voices')(request({ endpointId: 'custom' }), voicesView);
  assert.equal(voicesView.statusCode, 502);
  assert.equal(voicesView.payload.code, 'TTS_CUSTOM_VOICES_UNAVAILABLE');
  assert.deepEqual(discovered, [['models', 'custom-b'], ['voices', 'custom']]);

  discoverModelsError = new Error('获取模型列表失败（HTTP 401）');
  const failView = response();
  await app.routes.get('POST /api/tts/custom/discover-models')(request(), failView);
  assert.equal(failView.statusCode, 502);
  assert.match(failView.payload.error, /401/);
});

test('custom tts protocol：minimax/breeze 可保存，未知协议 400 且不落盘', async () => {
  const app = fakeApp();
  const saved = [];
  registerSettingsRoutes(app, {
    ...baseServices(),
    ttsCustomService: {
      getConfig: () => ({ endpoints: [], voices: [] }),
      saveConfig: patch => { saved.push(patch); return { endpoints: [{ id: 'custom', protocol: patch.endpoint.protocol }], voices: [] }; },
      discoverModels: async () => [],
      discoverVoices: async () => [],
    },
  });

  for (const protocol of ['minimax', 'breeze']) {
    const okView = response();
    await app.routes.get('POST /api/tts/custom')(request({ endpoint: { id: 'custom', protocol } }), okView);
    assert.equal(okView.statusCode, 200);
    assert.equal(okView.payload.config.endpoints[0].protocol, protocol);
  }

  const badView = response();
  await app.routes.get('POST /api/tts/custom')(request({ endpoint: { protocol: 'http-wildcard' } }), badView);
  assert.equal(badView.statusCode, 400);
  assert.match(badView.payload.error, /protocol/);
  assert.deepEqual(saved.map(patch => patch.endpoint.protocol), ['minimax', 'breeze'], '非法协议不得调用 saveConfig');
});

test('custom tts remove-endpoint：透传 endpointId，找不到时 400', async () => {
  const app = fakeApp();
  const removed = [];
  registerSettingsRoutes(app, {
    ...baseServices(),
    ttsCustomService: {
      getConfig: () => ({}), saveConfig: () => ({}), discoverModels: async () => [], discoverVoices: async () => [],
      removeEndpoint: ({ endpointId }) => { removed.push(endpointId); return endpointId === 'custom-b' ? { endpoints: [], voices: [], removedVoices: 2 } : { error: '没有找到这个接口。' }; },
    },
  });
  const okView = response();
  await app.routes.get('POST /api/tts/custom/remove-endpoint')(request({ endpointId: 'custom-b' }), okView);
  assert.equal(okView.statusCode, 200);
  assert.equal(okView.payload.config.removedVoices, 2);
  const badView = response();
  await app.routes.get('POST /api/tts/custom/remove-endpoint')(request({ endpointId: 'nope' }), badView);
  assert.equal(badView.statusCode, 400);
  assert.deepEqual(removed, ['custom-b', 'nope']);
});

test('custom tts preview：透传 endpointId/voiceId/model 合成试听，失败回 400 与可纠正信息', async () => {
  const app = fakeApp();
  const calls = [];
  registerSettingsRoutes(app, {
    ...baseServices(),
    ttsCustomService: {
      getConfig: () => ({ endpoints: [], voices: [] }),
      saveConfig: () => ({}),
      discoverModels: async () => [],
      discoverVoices: async () => [],
      previewVoice: async ({ endpointId, voiceId, model }) => {
        calls.push([endpointId, voiceId, model]);
        if (voiceId === 'bad') return { error: 'custom tts requires a model（请在设置里填写或拉取）' };
        return { url: '/tts/abc123.mp3', source: 'custom:speech-2.8-hd' };
      },
    },
  });

  const okView = response();
  await app.routes.get('POST /api/tts/custom/preview')(request({ endpointId: 'custom', voiceId: 'female-shaonv', model: 'speech-2.8-hd' }), okView);
  assert.equal(okView.statusCode, 200);
  assert.deepEqual(calls, [['custom', 'female-shaonv', 'speech-2.8-hd']]);
  assert.equal(okView.payload.ok, true);
  assert.equal(okView.payload.url, '/tts/abc123.mp3');

  const badView = response();
  await app.routes.get('POST /api/tts/custom/preview')(request({ voiceId: 'bad' }), badView);
  assert.equal(badView.statusCode, 400);
  assert.equal(badView.payload.ok, false);
  assert.match(badView.payload.error, /model/);
});

test('免费声音与代读：只转交白名单字段，服务拒绝时 400', async () => {
  const app = fakeApp();
  const patches = [];
  registerSettingsRoutes(app, {
    ...baseServices(),
    ttsCustomService: {
      saveFallback: patch => {
        patches.push(patch);
        return patch.freeVoicesEnabled && !patch.consent ? { error: '开启免费声音前需要先阅读说明并确认。' } : { fallback: { freeVoicesEnabled: true } };
      },
    },
  });
  const ok = response();
  await app.routes.get('POST /api/tts/fallback')(request({ freeVoicesEnabled: true, consent: true, extra: 'x' }), ok);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.payload, { ok: true, config: { fallback: { freeVoicesEnabled: true } } });
  assert.deepEqual(patches[0], { freeVoicesEnabled: true, consent: true });
  const refused = response();
  await app.routes.get('POST /api/tts/fallback')(request({ freeVoicesEnabled: true }), refused);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.payload.error, /确认/);
});

test('model download and system voice routes are gone; status only reports providers', async () => {
  const app = fakeApp();
  registerSettingsRoutes(app, { ...baseServices() });
  for (const route of ['POST /api/tts/model/download', 'GET /api/tts/system', 'POST /api/tts/system', 'POST /api/tts/system/preview']) {
    assert.equal(app.routes.has(route), false, `${route} must be removed`);
  }
  const status = response();
  await app.routes.get('GET /api/tts/status')({}, status);
  assert.deepEqual(status.payload, { ok: true, providers: [] });
});

function request(body) {
  return { body: body || {} };
}

test('声音设计路由：参数按白名单透传，失败返回 400 与原因', async () => {
  const calls = [];
  const app = fakeApp();
  registerSettingsRoutes(app, {
    ...baseServices(),
    ttsCustomService: {
      designVoices: async input => { calls.push(['design', input]); return input.description === 'bad' ? { error: '描述太短' } : { candidates: [{ generatedId: 'g', previewUrl: '/tts/a.mp3' }] }; },
      draftVoiceDescription: async input => { calls.push(['draft', input]); return { description: '清亮女声' }; },
      activateDesignedVoice: async input => { calls.push(['activate', input]); return { voiceId: 'voc_new' }; },
    },
  });
  const designed = response();
  await app.routes.get('POST /api/tts/custom/design')(request({ endpointId: 'custom', description: 'd', previewText: 'p', count: 2, junk: 1 }), designed);
  assert.deepEqual(designed.payload, { ok: true, candidates: [{ generatedId: 'g', previewUrl: '/tts/a.mp3' }] });
  const bad = response();
  await app.routes.get('POST /api/tts/custom/design')(request({ description: 'bad' }), bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.payload.error, '描述太短');

  const draft = response();
  await app.routes.get('POST /api/tts/custom/design-draft')(request({ personId: 'xm' }), draft);
  assert.equal(draft.payload.description, '清亮女声');
  const activated = response();
  await app.routes.get('POST /api/tts/custom/design-activate')(request({ endpointId: 'custom', generatedId: 'g', name: 'n', description: 'd', model: 'm' }), activated);
  assert.equal(activated.payload.voiceId, 'voc_new');
  assert.deepEqual(calls.map(([kind, input]) => [kind, input]), [
    ['design', { endpointId: 'custom', description: 'd', previewText: 'p', count: 2 }],
    ['design', { endpointId: '', description: 'bad', previewText: undefined, count: undefined }],
    ['draft', { personId: 'xm' }],
    ['activate', { endpointId: 'custom', generatedId: 'g', name: 'n', description: 'd', model: 'm' }],
  ]);
});

test('发声失败记录：按接口过滤转交，未接线时 503', async () => {
  const calls = [];
  const app = fakeApp();
  registerSettingsRoutes(app, {
    ...baseServices(),
    ttsFailureLog: { list: query => { calls.push(query); return [{ endpointId: 'custom', reason: 'timeout', phase: 'queue' }]; } },
  });
  const res = response();
  await app.routes.get('GET /api/tts/failures')({ query: { endpointId: 'custom', limit: '5' } }, res);
  assert.deepEqual(calls, [{ endpointId: 'custom', limit: 5 }]);
  assert.deepEqual(res.payload.failures, [{ endpointId: 'custom', reason: 'timeout', phase: 'queue' }]);
  const bare = fakeApp();
  registerSettingsRoutes(bare, baseServices());
  const missing = response();
  await bare.routes.get('GET /api/tts/failures')({ query: {} }, missing);
  assert.equal(missing.statusCode, 503);
});
