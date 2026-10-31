import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_RECIPE_AUDIO_BYTES, recipeProtocol, renderRecipeRequest, sniffAudioFormat, testRecipe, validateRecipe,
} from './recipe.js';
import { RECIPE_PRESETS, recipePreset } from './recipePresets.js';

const KEY = 'sk-test-0123456789abcdef';
// 最小合法音频：ID3 头的 mp3。
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]);

const recipe = (overrides = {}) => ({
  version: 1,
  synth: {
    method: 'POST',
    path: '/v1/tts/{voice}',
    query: { format: 'mp3' },
    headers: { Authorization: 'Bearer {apiKey}' },
    body: { text: '{text}', voice_id: '{voice}', model: '{model}' },
    ...overrides.synth,
  },
  audio: { kind: 'binary', ...overrides.audio },
  ...(overrides.error ? { error: overrides.error } : {}),
  ...(overrides.voices ? { voices: overrides.voices } : {}),
});

/** 记录请求的 fetch 替身：按顺序返回 responses。 */
function fakeFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return typeof next === 'function' ? next(url, init) : next;
  };
  return { fetchImpl, calls };
}
const audioResponse = (bytes = MP3, headers = { 'content-type': 'audio/mpeg' }) => new Response(bytes, { status: 200, headers });
const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// ---- 1.1 schema 校验 ----

test('合法配方通过校验；未知占位符、绝对地址、//、..、换行被拒', () => {
  assert.equal(validateRecipe(recipe()).synth.path, '/v1/tts/{voice}');
  const bad = [
    [recipe({ synth: { body: { text: '{text}', speed: '{speed}' } } }), /占位符/],
    [recipe({ synth: { path: 'https://evil.example/tts' } }), /路径/],
    [recipe({ synth: { path: '//evil.example/tts' } }), /路径/],
    [recipe({ synth: { path: '/v1/../admin' } }), /路径/],
    [recipe({ synth: { path: '/v1/tts\nHost: evil' } }), /路径/],
    [recipe({ synth: { path: 'v1/tts' } }), /路径/],
    [recipe({ synth: { method: 'PUT' } }), /方法/],
    [{ ...recipe(), version: 2 }, /version/],
    [recipe({ audio: { kind: 'json' } }), /audioPath/],
    [recipe({ audio: { kind: 'json', audioPath: 'data.audio', encoding: 'utf8' } }), /encoding/],
  ];
  for (const [candidate, pattern] of bad) assert.throws(() => validateRecipe(candidate), pattern);
});

test('{apiKey} 只能出现在请求头的值里', () => {
  for (const synth of [
    { query: { key: '{apiKey}' } },
    { body: { text: '{text}', token: '{apiKey}' } },
    { path: '/v1/{apiKey}/tts' },
    { headers: { '{apiKey}': 'x' } },
  ]) {
    assert.throws(() => validateRecipe(recipe({ synth })), /apiKey|请求头/);
  }
  assert.throws(() => validateRecipe(recipe({ voices: { path: '/v1/voices', query: { k: '{apiKey}' }, itemsPath: 'voices', idPath: 'id' } })), /apiKey/);
});

test('配方不能改写 Host、Cookie 等由传输层决定的请求头', () => {
  for (const name of ['Host', 'cookie', 'Content-Length']) {
    assert.throws(() => validateRecipe(recipe({ synth: { headers: { [name]: 'x' } } })), /请求头/);
  }
});

// ---- 1.1 占位符替换 ----

test('路径与查询做 URL 编码；body 只替换叶子字符串，含引号和换行仍是合法 JSON', () => {
  const text = '她说："今晚\n听这首吧"\\';
  const { url, init } = renderRecipeRequest({
    baseUrl: 'https://tts.example.com',
    recipe: recipe({ synth: { query: { lang: '{voice}' }, body: { text: '{text}', nested: [{ v: '{voice}' }], n: 3 } } }),
    values: { text, voice: 'a b/c', model: 'm1', apiKey: KEY },
  });
  assert.equal(url, 'https://tts.example.com/v1/tts/a%20b%2Fc?lang=a+b%2Fc');
  const body = JSON.parse(init.body);
  assert.equal(body.text, text);
  assert.deepEqual(body.nested, [{ v: 'a b/c' }]);
  assert.equal(body.n, 3);
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.redirect, 'manual');
  assert.ok(!url.includes(KEY));
});

test('GET 配方不带 body', () => {
  const { init } = renderRecipeRequest({
    baseUrl: 'https://tts.example.com',
    recipe: recipe({ synth: { method: 'GET', body: undefined, query: { text: '{text}' } } }),
    values: { text: 'hi', voice: 'v', model: '', apiKey: KEY },
  });
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
});

// ---- 1.1 取音频与文件头 ----

test('按文件头识别 mp3/wav/ogg/aac/flac', () => {
  assert.equal(sniffAudioFormat(MP3), 'mp3');
  assert.equal(sniffAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0])), 'mp3');
  assert.equal(sniffAudioFormat(WAV), 'wav');
  assert.equal(sniffAudioFormat(Buffer.from('OggS\0\0\0\0')), 'ogg');
  assert.equal(sniffAudioFormat(Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0])), 'aac');
  assert.equal(sniffAudioFormat(Buffer.from('fLaC\0\0\0\0')), 'flac');
  assert.equal(sniffAudioFormat(Buffer.from('{"error":"bad"}')), null);
  assert.equal(sniffAudioFormat(Buffer.alloc(0)), null);
});

const base = { baseUrl: 'https://tts.example.com', apiKey: KEY, model: 'm1', voice: 'v1', text: '你好' };

test('binary / json-hex / json-base64 三种取音频方式都能通过试合成', async () => {
  let { fetchImpl } = fakeFetch(audioResponse());
  let result = await testRecipe({ ...base, recipe: recipe(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.audio.extension, 'mp3');

  ({ fetchImpl } = fakeFetch(jsonResponse({ data: { audio: WAV.toString('hex') } })));
  result = await testRecipe({ ...base, recipe: recipe({ audio: { kind: 'json', audioPath: 'data.audio', encoding: 'hex' } }), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.audio.extension, 'wav');

  ({ fetchImpl } = fakeFetch(jsonResponse({ audio: MP3.toString('base64') })));
  result = await testRecipe({ ...base, recipe: recipe({ audio: { kind: 'json', audioPath: 'audio', encoding: 'base64' } }), fetchImpl });
  assert.equal(result.ok, true);
});

test('HTTP 200 但内容是 JSON 错误：不算通过，摘要用 error.messagePath 的文字', async () => {
  const { fetchImpl } = fakeFetch(jsonResponse({ base_resp: { status_msg: 'invalid voice' } }));
  const result = await testRecipe({ ...base, recipe: recipe({ error: { messagePath: 'base_resp.status_msg' } }), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.summary.status, 200);
  assert.match(result.summary.contentType, /json/);
  assert.match(result.summary.message, /invalid voice/);
});

test('识别到 ogg 等 Lunara 暂不能播放的格式：不通过，并提示改要 mp3/wav', async () => {
  const { fetchImpl } = fakeFetch(audioResponse(Buffer.from('OggS\0\0\0\0padding'), { 'content-type': 'audio/ogg' }));
  const result = await testRecipe({ ...base, recipe: recipe(), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.summary.message, /ogg.*mp3/);
});

test('HTTP 错误：摘要带状态码，错误文本里的 Key 被抹掉', async () => {
  const { fetchImpl } = fakeFetch(jsonResponse({ error: { message: `bad key ${KEY}` } }, 401));
  const result = await testRecipe({ ...base, recipe: recipe({ error: { messagePath: 'error.message' } }), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.summary.status, 401);
  assert.ok(!result.summary.message.includes(KEY));
});

test('不合法的配方不发请求', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await testRecipe({ ...base, recipe: recipe({ synth: { query: { k: '{apiKey}' } } }), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'validate');
  assert.equal(calls.length, 0);
});

// ---- 1.2 origin 锁定与传输 ----

test('保留用户地址里的路径前缀；非 localhost 必须 HTTPS', () => {
  const values = { text: 't', voice: 'v', model: 'm', apiKey: KEY };
  assert.equal(
    renderRecipeRequest({ baseUrl: 'https://gw.example.com/api/', recipe: recipe(), values }).url,
    'https://gw.example.com/api/v1/tts/v?format=mp3',
  );
  assert.equal(
    renderRecipeRequest({ baseUrl: 'http://localhost:8080', recipe: recipe(), values }).url,
    'http://localhost:8080/v1/tts/v?format=mp3',
  );
  assert.ok(renderRecipeRequest({ baseUrl: 'http://127.0.0.1:9000', recipe: recipe(), values }).url.startsWith('http://127.0.0.1:9000/'));
  assert.throws(() => renderRecipeRequest({ baseUrl: 'http://tts.example.com', recipe: recipe(), values }), /HTTPS/);
  assert.throws(() => renderRecipeRequest({ baseUrl: 'https://user:pw@tts.example.com', recipe: recipe(), values }), /地址/);
});

test('重定向一律拒绝，不会把 Key 发往另一台主机', async () => {
  const { fetchImpl, calls } = fakeFetch(new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
  const result = await testRecipe({ ...base, recipe: recipe(), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.summary.message, /重定向/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'manual');
});

test('重定向说明：同一主机只给目标路径（不带查询串），其他主机只给主机名', async () => {
  const same = await testRecipe({ ...base, recipe: recipe(), fetchImpl: fakeFetch(new Response(null, { status: 307, headers: { location: `/v1/speech?token=${KEY}` } })).fetchImpl });
  assert.match(same.summary.message, /307 重定向.*同一主机的 \/v1\/speech；请把配方 path 改成/);
  assert.ok(!same.summary.message.includes(KEY));
  assert.ok(!same.summary.message.includes('token'));
  const other = await testRecipe({ ...base, recipe: recipe(), fetchImpl: fakeFetch(new Response(null, { status: 302, headers: { location: 'https://evil.example/steal?x=1' } })).fetchImpl });
  assert.match(other.summary.message, /重定向到其他主机 evil\.example$/);
});

test('接口地址已是完整合成地址时 path 写 "/"：不追加末尾斜杠', () => {
  const values = { text: 't', voice: 'v', model: 'm', apiKey: KEY };
  const full = renderRecipeRequest({ baseUrl: 'https://api.vendor.example/v1/t2a_v2', recipe: recipe({ synth: { method: 'POST', path: '/', body: { text: '{text}' } } }), values });
  assert.equal(full.url.split('?')[0], 'https://api.vendor.example/v1/t2a_v2');
  const root = renderRecipeRequest({ baseUrl: 'https://api.vendor.example', recipe: recipe({ synth: { method: 'POST', path: '/', body: { text: '{text}' } } }), values });
  assert.equal(root.url.split('?')[0], 'https://api.vendor.example/');
});

test('响应体积超过上限即失败', async () => {
  const big = new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': String(MAX_RECIPE_AUDIO_BYTES + 1) } });
  const { fetchImpl } = fakeFetch(big);
  const result = await testRecipe({ ...base, recipe: recipe(), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.summary.message, /过大/);

  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
  });
  const { fetchImpl: endless } = fakeFetch(new Response(stream, { status: 200, headers: { 'content-type': 'audio/mpeg' } }));
  const streamed = await testRecipe({ ...base, recipe: recipe(), fetchImpl: endless });
  assert.equal(streamed.ok, false);
  assert.match(streamed.summary.message, /过大/);
});

// ---- 1.2a audio.kind:'url' ----

const urlRecipe = () => recipe({ audio: { kind: 'url', audioPath: 'output.audio.url' } });

test('音频链接：不带 Key、Cookie 与配方请求头下载；http 链接升级为 https', async () => {
  const { fetchImpl, calls } = fakeFetch(
    jsonResponse({ output: { audio: { url: 'http://bucket.oss.example.com/a.wav?Expires=1&Signature=s' } } }),
    audioResponse(WAV, { 'content-type': 'audio/wav' }),
  );
  const result = await testRecipe({ ...base, recipe: urlRecipe(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.audio.extension, 'wav');
  const download = calls[1];
  assert.equal(download.url, 'https://bucket.oss.example.com/a.wav?Expires=1&Signature=s');
  assert.equal(download.init.method, 'GET');
  assert.equal(download.init.redirect, 'manual');
  assert.equal(download.init.credentials, 'omit');
  assert.deepEqual(download.init.headers || {}, {});
  assert.ok(!JSON.stringify(download.init).includes(KEY));
});

test('音频链接：非 http(s)、重定向、超限都拒绝', async () => {
  let { fetchImpl } = fakeFetch(jsonResponse({ output: { audio: { url: 'file:///etc/passwd' } } }));
  let result = await testRecipe({ ...base, recipe: urlRecipe(), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.summary.message, /链接/);

  ({ fetchImpl } = fakeFetch(
    jsonResponse({ output: { audio: { url: 'https://cdn.example.com/a.mp3' } } }),
    new Response(null, { status: 301, headers: { location: 'https://other.example/a.mp3' } }),
  ));
  result = await testRecipe({ ...base, recipe: urlRecipe(), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.summary.message, /重定向/);

  ({ fetchImpl } = fakeFetch(
    jsonResponse({ output: { audio: { url: 'https://cdn.example.com/a.mp3' } } }),
    new Response(MP3, { status: 200, headers: { 'content-length': String(MAX_RECIPE_AUDIO_BYTES + 1) } }),
  ));
  result = await testRecipe({ ...base, recipe: urlRecipe(), fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.summary.message, /过大/);
});

// ---- 运行时适配器（custom.js 分派用） ----

test('recipeProtocol：无需 model、表演能力为空、无声音设计；声音列表按配方拉取', async () => {
  assert.equal(recipeProtocol.modelOptional, true);
  assert.equal(typeof recipeProtocol.designVoice, 'undefined');
  const config = {
    baseUrl: 'https://tts.example.com', apiKey: KEY,
    recipe: recipe({ voices: { method: 'GET', path: '/v1/voices', headers: { Authorization: 'Bearer {apiKey}' }, itemsPath: 'data.list', idPath: 'voice_id', namePath: 'name' } }),
  };
  const { fetchImpl, calls } = fakeFetch(jsonResponse({ data: { list: [{ voice_id: 'a', name: '甲' }, { voice_id: 'a' }, { voice_id: 'b' }] } }));
  const voices = await recipeProtocol.fetchVoices({ base: config.baseUrl, config, fetchImpl, signal: null });
  assert.deepEqual(voices, [{ id: 'a', name: '甲' }, { id: 'b', name: 'b' }]);
  assert.equal(calls[0].url, 'https://tts.example.com/v1/voices');
  await assert.rejects(
    () => recipeProtocol.fetchVoices({ base: config.baseUrl, config: { ...config, recipe: recipe() }, fetchImpl, signal: null }),
    error => error.code === 'TTS_CUSTOM_VOICES_UNAVAILABLE',
  );
  await assert.rejects(() => recipeProtocol.fetchModels({ config }), error => error.code === 'TTS_CUSTOM_MODELS_UNAVAILABLE');
});

// ---- 1.2b 预设（按 2026-10-27 官方文档核对） ----

test('千问预设：DashScope 多模态生成接口、Bearer 鉴权、取 output.audio.url', async () => {
  const preset = recipePreset('qwen-tts');
  assert.equal(preset.defaults.baseUrl, 'https://dashscope.aliyuncs.com');
  assert.equal(preset.defaults.model, 'qwen3-tts-flash');
  const { url, init } = renderRecipeRequest({
    baseUrl: preset.defaults.baseUrl, recipe: preset.recipe,
    values: { text: '你好', voice: 'Cherry', model: 'qwen3-tts-flash', apiKey: KEY },
  });
  assert.equal(url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(init.body), { model: 'qwen3-tts-flash', input: { text: '你好', voice: 'Cherry' } });
  assert.deepEqual(preset.recipe.audio, { kind: 'url', audioPath: 'output.audio.url' });
  assert.equal(preset.recipe.error.messagePath, 'message');
});

test('豆包预设：v3 tts/create、X-Api-Key 单头鉴权、取 base64 的 audio 字段', async () => {
  const preset = recipePreset('doubao-tts');
  assert.equal(preset.defaults.baseUrl, 'https://openspeech.bytedance.com');
  const { url, init } = renderRecipeRequest({
    baseUrl: preset.defaults.baseUrl, recipe: preset.recipe,
    values: { text: '你好', voice: 'zh_female_vv_uranus_bigtts', model: 'seed-audio-1.0', apiKey: KEY },
  });
  assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/create');
  assert.equal(init.headers['X-Api-Key'], KEY);
  assert.deepEqual(JSON.parse(init.body), {
    model: 'seed-audio-1.0', text_prompt: '你好', speaker: 'zh_female_vv_uranus_bigtts',
    audio_config: { format: 'mp3', sample_rate: 24000 },
  });
  assert.deepEqual(preset.recipe.audio, { kind: 'json', audioPath: 'audio', encoding: 'base64' });
  const { fetchImpl } = fakeFetch(jsonResponse({ code: 0, message: '', audio: MP3.toString('base64') }));
  const result = await testRecipe({ ...base, baseUrl: preset.defaults.baseUrl, recipe: preset.recipe, fetchImpl });
  assert.equal(result.ok, true);
});

test('预设配方本身都能通过校验，且带有官方文档出处', () => {
  assert.deepEqual(RECIPE_PRESETS.map(preset => preset.id), ['qwen-tts', 'doubao-tts']);
  for (const preset of RECIPE_PRESETS) {
    validateRecipe(preset.recipe);
    assert.match(preset.docsUrl, /^https:\/\//);
    assert.ok(preset.defaults.voice);
  }
  assert.equal(recipePreset('nope'), null);
});
