import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createTtsCustomService } = await import('./ttsCustomService.js');
const { resetCustomTtsConfigForTest } = await import('../ttsCustomConfig.js');
const { resetTtsFallbackConfigForTest } = await import('../ttsFallbackConfig.js');

function isolate(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-tts-service-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  resetCustomTtsConfigForTest();
  resetTtsFallbackConfigForTest();
  t.after(() => {
    delete process.env.LUNARA_CONFIG_DIR;
    resetCustomTtsConfigForTest();
    resetTtsFallbackConfigForTest();
    rmSync(dir, { recursive: true, force: true });
  });
}

test('保存第二个接口不影响第一个；每次变更都通知同步；对外视图不含 key', t => {
  isolate(t);
  const changes = [];
  const service = createTtsCustomService({ onConfigChanged: config => changes.push(config.endpoints.map(item => item.id)) });
  service.saveConfig({ endpoint: { id: 'custom', protocol: 'minimax', baseUrl: 'https://mm', apiKey: 'sk-mm', model: 'speech-2.8-hd' },
    voices: [{ endpointId: 'custom', sourceVoiceId: 'female-shaonv', displayName: '少女' }] });
  const saved = service.saveConfig({ endpoint: { name: 'Breeze', protocol: 'breeze', baseUrl: 'https://b', apiKey: 'brz-secret', model: 'breeze-tts-2' } });
  assert.equal(saved.savedEndpointId, 'custom-breeze');
  assert.deepEqual(saved.endpoints.map(item => [item.id, item.name, item.configured]), [['custom', 'MiniMax', true], ['custom-breeze', 'Breeze', true]]);
  assert.deepEqual(saved.voices.map(voice => [voice.endpointId, voice.profileId]), [['custom', 'vp_cx_d54f990d']]);
  assert.doesNotMatch(JSON.stringify(saved), /sk-mm|brz-secret|apiKey/);
  assert.deepEqual(changes, [['custom'], ['custom', 'custom-breeze']]);

  const removed = service.removeEndpoint({ endpointId: 'custom' });
  assert.equal(removed.removedVoices, 1);
  assert.deepEqual(removed.endpoints.map(item => item.id), ['custom-breeze']);
  assert.match(service.removeEndpoint({ endpointId: 'custom' }).error, /没有找到/);
  assert.equal(changes.length, 3, '删除失败不触发同步');
});

test('试听按所属接口与 model 合成；未指定接口时用第一个', async t => {
  isolate(t);
  const calls = [];
  const service = createTtsCustomService({ synthesize: async (_text, options) => { calls.push(options); return { url: '/tts/x.mp3' }; } });
  service.saveConfig({ endpoint: { id: 'custom', baseUrl: 'https://a', apiKey: 'k' } });
  await service.previewVoice({ endpointId: 'custom-b', voiceId: 'voc_1', model: 'breeze-tts-2' });
  await service.previewVoice({ voiceId: 'v' });
  assert.deepEqual(calls, [
    { providerId: 'custom-b', voiceId: 'voc_1', params: { model: 'breeze-tts-2' } },
    { providerId: 'custom', voiceId: 'v' },
  ]);
});

test('发现：接口未保存时如实报不可用', async t => {
  isolate(t);
  const service = createTtsCustomService();
  await assert.rejects(service.discoverModels({ endpointId: 'custom-nope' }), /先保存/);
});

// ---- 按描述设计声音 ----

function jsonResponse(payload, status = 200) {
  return { ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => payload, text: async () => JSON.stringify(payload) };
}

test('接口视图带设计能力：breeze/minimax 有、openai 为 null', t => {
  isolate(t);
  const service = createTtsCustomService();
  service.saveConfig({ endpoint: { id: 'custom', protocol: 'openai', baseUrl: 'https://o', apiKey: 'k' } });
  const view = service.saveConfig({ endpoint: { name: 'Breeze', protocol: 'breeze', baseUrl: 'https://b', apiKey: 'k2' } });
  assert.deepEqual(view.endpoints.map(item => [item.id, item.voiceDesign?.maxCandidates ?? null]), [['custom', null], ['custom-breeze', 3]]);
  assert.equal(service.getConfig().endpoints[1].voiceDesign.maxCandidates, 3);
});

test('designVoices：校验描述、存储试听音频、只把描述与试听文本发给厂商', async t => {
  isolate(t);
  const stored = [];
  const sent = [];
  const service = createTtsCustomService({
    storeAudio: audio => { stored.push(audio.bytes.toString()); return { url: `/tts/${stored.length}.mp3` }; },
    fetchImpl: async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ previews: [
        { generated_voice_id: 'gen_a', audio_base_64: Buffer.from('A').toString('base64') },
        { generated_voice_id: 'gen_b', audio_base_64: Buffer.from('B').toString('base64') },
      ] });
    },
  });
  service.saveConfig({ endpoint: { id: 'custom', protocol: 'breeze', baseUrl: 'https://b', apiKey: 'brz-key', model: 'breeze-tts-2' } });
  assert.match((await service.designVoices({ endpointId: 'custom', description: '短' })).error, /3/);
  assert.match((await service.designVoices({ endpointId: 'custom', description: '长'.repeat(501) })).error, /500/);
  assert.equal(sent.length, 0, '描述不合格不发请求');

  const result = await service.designVoices({ endpointId: 'custom', description: '  清亮的年轻女声  ', previewText: '晚上好', count: 2 });
  assert.deepEqual(result.candidates, [{ generatedId: 'gen_a', previewUrl: '/tts/1.mp3' }, { generatedId: 'gen_b', previewUrl: '/tts/2.mp3' }]);
  assert.deepEqual(stored, ['A', 'B']);
  assert.deepEqual(sent[0].body, { voice_description: '清亮的年轻女声', text: '晚上好', language_code: 'zh', preview_count: 2 });
  assert.doesNotMatch(JSON.stringify(result), /brz-key/);
});

test('designVoices：openai 接口如实报不支持', async t => {
  isolate(t);
  const service = createTtsCustomService({ fetchImpl: async () => { throw new Error('不该请求'); } });
  service.saveConfig({ endpoint: { id: 'custom', protocol: 'openai', baseUrl: 'https://o', apiKey: 'k' } });
  assert.match((await service.designVoices({ endpointId: 'custom', description: '温柔的女声' })).error, /不支持/);
});

test('draftVoiceDescription：只把伙伴人设交给 LLM，结果截断到 500 字且不落盘', async t => {
  isolate(t);
  const prompts = [];
  const service = createTtsCustomService({
    getPerson: id => (id === 'xm' ? { displayName: '小满', personaDocument: '小满是一个喜欢深夜电台的女孩，说话很轻。' } : null),
    askText: async (prompt, options) => { prompts.push({ prompt, options }); return `"${'温柔'.repeat(300)}"`; },
  });
  const result = await service.draftVoiceDescription({ personId: 'xm' });
  assert.equal(prompts[0].options.taskId, 'voice_design_prompt');
  assert.match(prompts[0].prompt, /喜欢深夜电台/);
  assert.match(prompts[0].prompt, /不写.*名字/);
  assert.equal(result.description.length, 500);
  assert.doesNotMatch(result.description, /^"/);
  assert.match((await service.draftVoiceDescription({ personId: 'nope' })).error, /没有找到/);
  assert.equal(service.getConfig().voices.length, 0);
});

test('activateDesignedVoice：Breeze 保存后返回永久 voice id；失败如实返回错误', async t => {
  isolate(t);
  let status = 200;
  const service = createTtsCustomService({
    fetchImpl: async () => (status === 200 ? jsonResponse({ voice_id: 'voc_new' }) : jsonResponse({ error: 'no slots' }, status)),
  });
  service.saveConfig({ endpoint: { id: 'custom', protocol: 'breeze', baseUrl: 'https://b', apiKey: 'k' } });
  assert.deepEqual(await service.activateDesignedVoice({ endpointId: 'custom', generatedId: 'gen_a', name: '小满', description: '清亮' }), { voiceId: 'voc_new' });
  status = 403;
  assert.match((await service.activateDesignedVoice({ endpointId: 'custom', generatedId: 'gen_a', name: '小满' })).error, /名额/);
  assert.match((await service.activateDesignedVoice({ endpointId: 'custom', generatedId: '' })).error, /缺少/);
});

// ---- 免费声音与代读 ----

test('免费声音：没确认不能开启；开启后同步 provider，配置视图带上开关与默认代读目标', t => {
  isolate(t);
  let changes = 0;
  const service = createTtsCustomService({ onConfigChanged: () => { changes += 1; } });
  assert.deepEqual(service.getConfig().fallback, { version: 1, freeVoicesEnabled: false, consentAt: null, fallbackEnabled: false, fallbackTarget: null });
  assert.match(service.saveFallback({ freeVoicesEnabled: true }).error, /确认/);
  assert.equal(changes, 0);
  const saved = service.saveFallback({ freeVoicesEnabled: true, consent: true });
  assert.equal(saved.fallback.freeVoicesEnabled, true);
  assert.deepEqual(saved.fallback.fallbackTarget, { providerId: 'free-edge', voiceId: 'zh-CN-XiaoxiaoNeural' });
  assert.equal(changes, 1, '开关变化后重新同步 provider');
  assert.match(service.saveFallback({ fallbackTarget: { providerId: 'custom', voiceId: 'x' } }).error, /目标/);
});

test('免费声音发现：开关关闭时如实报不可用，开启后取 provider 的中文声音列表', async t => {
  isolate(t);
  let provider = null;
  const service = createTtsCustomService({ freeVoiceProvider: async () => provider });
  await assert.rejects(service.discoverVoices({ endpointId: 'free-edge' }), /先开启免费声音/);
  provider = { fetchVoices: async () => [{ id: 'zh-CN-YunxiNeural', name: '云希' }] };
  assert.deepEqual(await service.discoverVoices({ endpointId: 'free-edge' }), [{ id: 'zh-CN-YunxiNeural', name: '云希' }]);
});

test('免费声音试听：开关关闭时提示先开启，而不是"接口未配置"', async t => {
  isolate(t);
  const service = createTtsCustomService({ synthesize: async () => { throw new Error('no usable tts provider (provider-unavailable)'); } });
  assert.match((await service.previewVoice({ endpointId: 'free-edge', voiceId: 'zh-CN-YunxiNeural' })).error, /先开启免费声音/);
});

// ---- 配方接口（add-tts-request-recipe）----

const RECIPE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32, 1)]);
const VENDOR_RECIPE = {
  version: 1,
  synth: { method: 'POST', path: '/tts', headers: { 'X-Key': '{apiKey}' }, body: { text: '{text}', voice: '{voice}' } },
  audio: { kind: 'binary' },
};
function recipeService({ responses = [] } = {}) {
  const calls = [];
  const stored = [];
  const service = createTtsCustomService({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return responses.shift() || new Response(RECIPE_MP3, { headers: { 'content-type': 'audio/mpeg' } });
    },
    storeAudio: audio => { stored.push(audio); return { url: `/tts/preview-${stored.length}.mp3` }; },
  });
  return { service, calls, stored };
}

test('配方接口：没通过试合成不能保存；试合成通过后可保存，视图不含 key、带配方', async t => {
  isolate(t);
  const { service, calls } = recipeService();
  const endpoint = { name: 'Vendor', protocol: 'recipe', baseUrl: 'https://vendor.example', apiKey: 'vk-secret', recipe: VENDOR_RECIPE };
  assert.match(service.saveConfig({ endpoint }).error, /还没有通过试合成/);

  const tested = await service.testRecipe({ baseUrl: endpoint.baseUrl, apiKey: 'vk-secret', voice: 'lily', recipe: VENDOR_RECIPE });
  assert.equal(tested.previewUrl, '/tts/preview-1.mp3');
  assert.equal(calls[0].init.headers['X-Key'], 'vk-secret');

  // 键顺序不同也算同一份配方。
  const reordered = { audio: VENDOR_RECIPE.audio, synth: VENDOR_RECIPE.synth, version: 1 };
  const saved = service.saveConfig({ endpoint: { ...endpoint, recipe: reordered } });
  assert.equal(saved.error, undefined);
  const view = saved.endpoints.find(item => item.id === saved.savedEndpointId);
  assert.equal(view.protocol, 'recipe');
  assert.equal(view.recipeError, null);
  assert.equal(view.configured, true);
  assert.doesNotMatch(JSON.stringify(saved), /vk-secret/);

  // 只改 Key / 名字不用重新试合成；改配方要。
  assert.equal(service.saveConfig({ endpoint: { id: view.id, name: 'Vendor 2', apiKey: 'vk-new' } }).error, undefined);
  const changed = { ...VENDOR_RECIPE, synth: { ...VENDOR_RECIPE.synth, path: '/v2/tts' } };
  assert.match(service.saveConfig({ endpoint: { id: view.id, recipe: changed } }).error, /还没有通过试合成/);
});

test('配方试合成：留空 Key 只在同一 origin 沿用已保存的 Key；失败返回脱敏原因', async t => {
  isolate(t);
  const { service, calls } = recipeService({
    responses: [
      new Response(RECIPE_MP3, { headers: { 'content-type': 'audio/mpeg' } }),
      new Response(RECIPE_MP3, { headers: { 'content-type': 'audio/mpeg' } }),
      new Response(JSON.stringify({ message: 'bad key vk-secret' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    ],
  });
  await service.testRecipe({ baseUrl: 'https://vendor.example', apiKey: 'vk-secret', recipe: VENDOR_RECIPE });
  const saved = service.saveConfig({ endpoint: { name: 'Vendor', protocol: 'recipe', baseUrl: 'https://vendor.example', apiKey: 'vk-secret', recipe: VENDOR_RECIPE } });
  const id = saved.savedEndpointId;

  assert.match((await service.testRecipe({ endpointId: id, baseUrl: 'https://other.example', recipe: VENDOR_RECIPE })).error, /重新填写 API Key/);
  assert.equal(calls.length, 1, '换了 origin 不发请求');

  const reused = await service.testRecipe({ endpointId: id, baseUrl: 'https://vendor.example/', recipe: VENDOR_RECIPE });
  assert.ok(reused.previewUrl);
  assert.equal(calls[1].init.headers['X-Key'], 'vk-secret');

  const failed = await service.testRecipe({ endpointId: id, baseUrl: 'https://vendor.example', recipe: VENDOR_RECIPE });
  assert.equal(failed.summary.status, 401);
  assert.doesNotMatch(failed.error, /vk-secret/);
});

test('预设：只填 Key 就能试合成，不调用 LLM；保存后和普通配方接口一样', async t => {
  isolate(t);
  let asked = 0;
  const calls = [];
  const service = createTtsCustomService({
    askText: async () => { asked += 1; return '{}'; },
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ code: 0, audio: RECIPE_MP3.toString('base64') }), { headers: { 'content-type': 'application/json' } });
    },
    storeAudio: () => ({ url: '/tts/p.mp3' }),
  });
  const presets = service.recipePresets();
  assert.deepEqual(presets.map(preset => preset.id), ['qwen-tts', 'doubao-tts']);
  const doubao = presets.find(preset => preset.id === 'doubao-tts');
  const tested = await service.testRecipe({
    presetId: 'doubao-tts', baseUrl: doubao.defaults.baseUrl, apiKey: 'db-key', model: doubao.defaults.model, voice: doubao.defaults.voice,
  });
  assert.equal(tested.previewUrl, '/tts/p.mp3');
  assert.equal(calls[0].url, 'https://openspeech.bytedance.com/api/v3/tts/create');
  const saved = service.saveConfig({ endpoint: {
    name: '豆包', protocol: 'recipe', presetId: 'doubao-tts', baseUrl: doubao.defaults.baseUrl, apiKey: 'db-key', model: doubao.defaults.model, recipe: tested.recipe,
  } });
  assert.equal(saved.error, undefined);
  assert.equal(saved.endpoints[0].presetId, 'doubao-tts');
  assert.equal(asked, 0, '预设不调用起草助手');
});

test('助手起草：只调模型不发厂商请求、不需要 Key；起草的配方要试合成通过才能保存', async t => {
  isolate(t);
  const prompts = [];
  const vendorCalls = [];
  const service = createTtsCustomService({
    askText: async prompt => { prompts.push(prompt); return JSON.stringify(VENDOR_RECIPE); },
    fetchImpl: async url => { vendorCalls.push(String(url)); return new Response(RECIPE_MP3, { headers: { 'content-type': 'audio/mpeg' } }); },
    storeAudio: () => ({ url: '/tts/d.mp3' }),
  });
  const keyless = await service.draftRecipe({ baseUrl: 'https://vendor.example', voice: 'lily', docText: 'POST /tts with X-Key header' });
  assert.equal(keyless.drafted, true, '不填 Key 也能读文档');
  const drafted = await service.draftRecipe({ baseUrl: 'https://vendor.example', apiKey: 'vk-secret', voice: 'lily', docText: 'POST /tts with X-Key header vk-secret' });
  assert.equal(drafted.drafted, true);
  assert.equal(vendorCalls.length, 0, '读文档不发厂商请求');
  const refused = service.saveConfig({ endpoint: { name: 'Vendor', protocol: 'recipe', baseUrl: 'https://vendor.example', apiKey: 'vk-secret', recipe: drafted.recipe } });
  assert.match(refused.error, /试合成/);

  const tested = await service.testRecipe({ baseUrl: 'https://vendor.example', apiKey: 'vk-secret', voice: 'lily', recipe: drafted.recipe });
  assert.equal(tested.previewUrl, '/tts/d.mp3');
  assert.equal(vendorCalls.length, 1);
  const revised = await service.draftRecipe({
    baseUrl: 'https://vendor.example', apiKey: 'vk-secret', docText: 'POST /tts',
    previous: { recipe: drafted.recipe, summary: { status: 400, message: 'bad voice vk-secret' } },
  });
  assert.equal(revised.drafted, true);
  assert.ok(prompts.every(prompt => !prompt.includes('vk-secret')), '文档和失败摘要里的 Key 都被抹掉');
  assert.match(prompts.at(-1), /bad voice/);
  const saved = service.saveConfig({ endpoint: { name: 'Vendor', protocol: 'recipe', baseUrl: 'https://vendor.example', apiKey: 'vk-secret', recipe: tested.recipe } });
  assert.equal(saved.error, undefined);
});
