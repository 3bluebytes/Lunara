import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

const { createCustomProvider, fetchCustomModels, fetchCustomVoices, CUSTOM_PROVIDER_ID } =
  await import('./custom.js');
const { TtsProviderUnavailableError, TtsSynthesisError } = await import('../TtsProvider.js');

const CONFIG = {
  baseUrl: 'https://tts.example/v1/',
  apiKey: 'sk-secret',
  model: 'tts-1',
  voices: [{ sourceVoiceId: 'alloy-cn', displayName: '中文合金' }],
};

function jsonResponse(payload, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

function audioResponse(bytes, contentType = 'audio/mpeg') {
  return {
    ok: true, status: 200,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => '',
  };
}

test('未配置（缺 URL 或 key）时 isConfigured=false 且合成抛不可用', async () => {
  const provider = createCustomProvider({ getConfig: () => ({ baseUrl: '', apiKey: '', model: 'm' }) });
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(() => provider.synth('你好', { voiceRef: 'v' }), TtsProviderUnavailableError);
});

test('合成走 POST {base}/audio/speech：Bearer、model/voice/input 齐全，音频按 content-type 定扩展名', async () => {
  const seen = {};
  const provider = createCustomProvider({
    getConfig: () => CONFIG,
    fetchImpl: async (url, options = {}) => {
      seen.url = url;
      seen.headers = options.headers;
      seen.body = JSON.parse(options.body);
      return audioResponse(Buffer.from([1, 2, 3]));
    },
  });
  const audio = await provider.synth('晚安', { voiceRef: 'alloy-cn' });
  assert.equal(seen.url, 'https://tts.example/v1/audio/speech', 'URL 去尾斜杠后拼接');
  assert.equal(seen.headers.Authorization, 'Bearer sk-secret');
  assert.deepEqual(seen.body, { model: 'tts-1', voice: 'alloy-cn', input: '晚安' });
  assert.equal(audio.extension, 'mp3');
});

test('listVoices 暴露保留声音（源 id + 显示名）', () => {
  const provider = createCustomProvider({ getConfig: () => CONFIG });
  assert.deepEqual(provider.listVoices(), [{ id: 'alloy-cn', displayName: '中文合金' }]);
});

test('上游错误如实摘录但不包含 API key', async () => {
  const provider = createCustomProvider({
    getConfig: () => CONFIG,
    fetchImpl: async () => jsonResponse({ error: 'bad key' }, { status: 401 }),
  });
  await assert.rejects(() => provider.synth('x', { voiceRef: 'v' }), error => {
    assert.ok(error instanceof TtsSynthesisError);
    assert.match(error.message, /401/);
    assert.equal(error.message.includes('sk-secret'), false, '错误信息不得包含 key');
    return true;
  });
});

test('缺少 model 时给出可纠正错误而不是静默换声', async () => {
  const provider = createCustomProvider({ getConfig: () => ({ ...CONFIG, model: '' }) });
  await assert.rejects(() => provider.synth('x', { voiceRef: 'v' }), error => {
    assert.equal(error.code, 'TTS_CUSTOM_MODEL_REQUIRED');
    return true;
  });
});

test('fetchCustomModels：宽松解析 {data:[{id}]} 并去重', async () => {
  const seen = [];
  const models = await fetchCustomModels({
    getConfig: () => CONFIG,
    fetchImpl: async (url, options) => {
      seen.push({ url, auth: options.headers.Authorization });
      return jsonResponse({ data: [{ id: 'tts-1' }, 'tts-2', { id: 'tts-1' }] });
    },
  });
  assert.equal(seen[0].url, 'https://tts.example/v1/models');
  assert.equal(seen[0].auth, 'Bearer sk-secret');
  assert.deepEqual(models, ['tts-1', 'tts-2']);
});

test('fetchCustomVoices：宽松解析多种形状；404 如实报告可手填', async () => {
  const voices = await fetchCustomVoices({
    getConfig: () => CONFIG,
    fetchImpl: async () => jsonResponse({ voices: [{ voice_id: 'v1', name: '声一' }, 'v2'] }),
  });
  assert.deepEqual(voices, [{ id: 'v1', name: '声一' }, { id: 'v2', name: 'v2' }]);

  await assert.rejects(() => fetchCustomVoices({
    getConfig: () => CONFIG,
    fetchImpl: async () => jsonResponse({}, { status: 404 }),
  }), error => {
    assert.ok(error instanceof TtsProviderUnavailableError);
    assert.equal(error.code, 'TTS_CUSTOM_VOICES_UNAVAILABLE');
    assert.match(error.message, /手动填写/);
    return true;
  });
});

// ---- minimax 协议 ----

const MINIMAX_CONFIG = {
  protocol: 'minimax',
  baseUrl: 'https://api.minimax.cn/',
  apiKey: 'mm-secret',
  model: 'speech-2.8-hd',
  voices: [],
};

test('minimax 合成走 POST {base}/v1/t2a_v2：body 按官方文档，hex 音频解码为字节', async () => {
  const seen = {};
  const provider = createCustomProvider({
    getConfig: () => MINIMAX_CONFIG,
    fetchImpl: async (url, options = {}) => {
      seen.url = url;
      seen.method = options.method;
      seen.headers = options.headers;
      seen.body = JSON.parse(options.body);
      return jsonResponse({ data: { audio: '0001020304ff' }, base_resp: { status_code: 0, status_msg: 'success' } });
    },
  });
  const audio = await provider.synth('晚安', { voiceRef: 'Chinese (Mandarin)_Sweet_Lady' });
  assert.equal(seen.url, 'https://api.minimax.cn/v1/t2a_v2');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.headers.Authorization, 'Bearer mm-secret');
  assert.deepEqual(seen.body, {
    model: 'speech-2.8-hd',
    text: '晚安',
    stream: false,
    voice_setting: { voice_id: 'Chinese (Mandarin)_Sweet_Lady' },
    audio_setting: { format: 'mp3', sample_rate: 32000 },
    output_format: 'hex',
  });
  assert.equal(audio.extension, 'mp3');
  assert.equal(audio.bytes.length, 6);
  assert.deepEqual([...audio.bytes], [0, 1, 2, 3, 4, 255]);
});

test('minimax 合成：HTTP 200 但 base_resp 非 0 如实报业务错误且不含 key', async () => {
  const provider = createCustomProvider({
    getConfig: () => MINIMAX_CONFIG,
    fetchImpl: async () => jsonResponse({ base_resp: { status_code: 2013, status_msg: 'invalid params' } }),
  });
  await assert.rejects(() => provider.synth('x', { voiceRef: 'v' }), error => {
    assert.ok(error instanceof TtsSynthesisError);
    assert.match(error.message, /2013/);
    assert.match(error.message, /invalid params/);
    assert.equal(error.message.includes('mm-secret'), false);
    return true;
  });
});

test('minimax 声音列表走 POST {base}/v1/get_voice，合并系统/快克/生成三类并取友好名', async () => {
  const seen = {};
  const voices = await fetchCustomVoices({
    getConfig: () => MINIMAX_CONFIG,
    fetchImpl: async (url, options = {}) => {
      seen.url = url;
      seen.method = options.method;
      seen.body = JSON.parse(options.body);
      return jsonResponse({
        system_voice: [
          { voice_id: 'Chinese (Mandarin)_Sweet_Lady', voice_name: '甜美女声', description: ['甜美女声描述'] },
          { voice_id: 'male-voice', description: ['沉稳男声', '第二条'] },
        ],
        voice_cloning: [{ voice_id: 'clone-1', description: [], created_time: '2025-08-20' }],
        voice_generation: [{ voice_id: 'clone-1', description: ['重复 id 应被去重'] }],
        base_resp: { status_code: 0, status_msg: 'success' },
      });
    },
  });
  assert.equal(seen.url, 'https://api.minimax.cn/v1/get_voice');
  assert.equal(seen.method, 'POST');
  assert.deepEqual(seen.body, { voice_type: 'all' });
  assert.deepEqual(voices, [
    { id: 'Chinese (Mandarin)_Sweet_Lady', name: '甜美女声' },
    { id: 'male-voice', name: '沉稳男声' },
    { id: 'clone-1', name: 'clone-1' },
  ]);
});

test('minimax 声音列表：base_resp 非 0 时如实报告', async () => {
  await assert.rejects(() => fetchCustomVoices({
    getConfig: () => MINIMAX_CONFIG,
    fetchImpl: async () => jsonResponse({ base_resp: { status_code: 1004, status_msg: 'auth failed' } }),
  }), error => {
    assert.ok(error instanceof TtsProviderUnavailableError);
    assert.match(error.message, /1004/);
    assert.equal(error.message.includes('mm-secret'), false);
    return true;
  });
});

test('minimax 无模型列表接口：如实报告并指路官方文档示例', async () => {
  await assert.rejects(() => fetchCustomModels({
    getConfig: () => MINIMAX_CONFIG,
    fetchImpl: async () => { throw new Error('不应发起请求'); },
  }), error => {
    assert.equal(error.code, 'TTS_CUSTOM_MODELS_UNAVAILABLE');
    assert.match(error.message, /speech-2\.8-hd/);
    return true;
  });
});

test('minimax baseUrl 多带的 /v1 自动纠正，不会拼出 /v1/v1', async () => {
  const seen = [];
  for (const baseUrl of ['https://api.minimax.cn/v1', 'https://api.minimax.cn/v1/', 'https://api.minimax.cn']) {
    await fetchCustomVoices({
      getConfig: () => ({ ...MINIMAX_CONFIG, baseUrl }),
      fetchImpl: async url => {
        seen.push(url);
        return jsonResponse({ system_voice: [{ voice_id: 'v', voice_name: '声' }], base_resp: { status_code: 0 } });
      },
    });
  }
  assert.deepEqual(seen, [
    'https://api.minimax.cn/v1/get_voice',
    'https://api.minimax.cn/v1/get_voice',
    'https://api.minimax.cn/v1/get_voice',
  ]);
});

test('minimax baseUrl 填文档完整接口地址也能纠正（用户实际粘贴方式）', async () => {
  const seen = [];
  for (const baseUrl of [
    'https://api-bj.minimaxi.com/v1/t2a_v2',
    'https://api-bj.minimaxi.com/v1/get_voice',
    'https://api-bj.minimaxi.com/v1',
    'https://api-bj.minimaxi.com',
  ]) {
    await fetchCustomVoices({
      getConfig: () => ({ ...MINIMAX_CONFIG, baseUrl }),
      fetchImpl: async url => {
        seen.push(url);
        return jsonResponse({ system_voice: [{ voice_id: 'v', voice_name: '声' }], base_resp: { status_code: 0 } });
      },
    });
  }
  assert.deepEqual(seen.map(url => url.replace('https://api-bj.minimaxi.com', '')), [
    '/v1/get_voice', '/v1/get_voice', '/v1/get_voice', '/v1/get_voice',
  ]);
});

test('minimax 带表演：native 合并进 voice_setting 并附加 voice_modify，文本已是原生语法', async () => {
  const seen = {};
  const provider = createCustomProvider({
    getConfig: () => MINIMAX_CONFIG,
    fetchImpl: async (url, options = {}) => {
      seen.body = JSON.parse(options.body);
      return jsonResponse({ data: { audio: '00' }, base_resp: { status_code: 0 } });
    },
  });
  const rendered = provider.renderPerformance('{叹气}已经很晚了。{停顿:0.6}我们听首安静的。', { emotion: 'sad', pace: 'slow', intensity: 'soft' });
  await provider.synth(rendered.text, { voiceRef: 'v', native: rendered.native });
  assert.equal(seen.body.text, '(sighs)已经很晚了。<#0.6#>我们听首安静的。');
  assert.deepEqual(seen.body.voice_setting, { voice_id: 'v', emotion: 'sad', speed: 0.9 });
  assert.deepEqual(seen.body.voice_modify, { intensity: 40 });
});

test('performanceCapability 按协议与 model 查表：openai 为 none，minimax speech-2.8 有语气词', () => {
  assert.equal(createCustomProvider({ getConfig: () => CONFIG }).performanceCapability().id, 'none');
  assert.equal(createCustomProvider({ getConfig: () => MINIMAX_CONFIG }).performanceCapability().id, 'minimax-speech-2.8');
  assert.equal(createCustomProvider({ getConfig: () => MINIMAX_CONFIG }).performanceCapability({ params: { model: 'speech-2.6-hd' } }).id,
    'minimax-speech-legacy');
});

// ---- breeze 协议 ----

const BREEZE_CONFIG = {
  protocol: 'breeze',
  baseUrl: 'https://api.breeze.blue',
  apiKey: 'brz_secret',
  model: 'breeze-tts-2',
  voices: [{ sourceVoiceId: 'voc_p36dbdewwvae', displayName: '邻家暖心' }],
};

test('breeze 合成：POST /v1/text-to-speech/{voice}?output_format=mp3，xi-api-key，无表演时 body 只有基础字段', async () => {
  const seen = {};
  const provider = createCustomProvider({
    getConfig: () => BREEZE_CONFIG,
    fetchImpl: async (url, options = {}) => {
      seen.url = url;
      seen.headers = options.headers;
      seen.body = JSON.parse(options.body);
      return audioResponse(Buffer.from([9, 9, 9]), 'audio/mpeg');
    },
  });
  const audio = await provider.synth('晚安', { voiceRef: 'voc_p36dbdewwvae' });
  assert.equal(seen.url, 'https://api.breeze.blue/v1/text-to-speech/voc_p36dbdewwvae?output_format=mp3');
  assert.equal(seen.headers['xi-api-key'], 'brz_secret');
  assert.equal(seen.headers.Authorization, undefined, 'breeze 不发 Bearer');
  assert.deepEqual(seen.body, { text: '晚安', model_id: 'breeze-tts-2', language_code: 'zh' });
  assert.equal(audio.extension, 'mp3');
  assert.equal(audio.bytes.length, 3);
});

test('breeze 带表演：语气词转 [x]、停顿丢弃，instructions 与 voice_settings 进 body', async () => {
  const seen = {};
  const provider = createCustomProvider({
    getConfig: () => BREEZE_CONFIG,
    fetchImpl: async (url, options = {}) => {
      seen.body = JSON.parse(options.body);
      return audioResponse(Buffer.from([1]), 'audio/mpeg');
    },
  });
  const rendered = provider.renderPerformance('{叹气}已经很晚了。{停顿:0.6}我们听首安静的。', { emotion: 'sad', pace: 'slow' });
  await provider.synth(rendered.text, { voiceRef: 'voc_x', native: rendered.native });
  assert.equal(seen.body.text, '[叹气]已经很晚了。我们听首安静的。');
  assert.match(seen.body.instructions, /低落伤感/);
  assert.deepEqual(seen.body.voice_settings, { guidance_scale: 4, speed: 0.9 });
});

test('breeze 基础 URL 三种写法都归一化到主域名', async () => {
  const seen = [];
  for (const baseUrl of [
    'https://api.breeze.blue',
    'https://api.breeze.blue/v1/',
    'https://api.breeze.blue/v1/text-to-speech/voc_abc',
  ]) {
    const provider = createCustomProvider({
      getConfig: () => ({ ...BREEZE_CONFIG, baseUrl }),
      fetchImpl: async url => { seen.push(url); return audioResponse(Buffer.from([1])); },
    });
    await provider.synth('好', { voiceRef: 'voc_x' });
  }
  assert.deepEqual(seen, Array(3).fill('https://api.breeze.blue/v1/text-to-speech/voc_x?output_format=mp3'));
});

test('breeze 402 如实报错并带错误码，不重试，错误文本不含 key', async () => {
  let calls = 0;
  const provider = createCustomProvider({
    id: 'custom-test-402',
    getConfig: () => BREEZE_CONFIG,
    fetchImpl: async () => { calls += 1; return jsonResponse({ ok: false, error: { code: 'INSUFFICIENT_CREDITS' } }, { status: 402 }); },
    wait: async () => { throw new Error('402 不应等待重试'); },
  });
  await assert.rejects(() => provider.synth('x', { voiceRef: 'voc_x' }), error => {
    assert.ok(error instanceof TtsSynthesisError);
    assert.equal(error.code, 'TTS_CREDIT_EXHAUSTED');
    assert.match(error.message, /402/);
    assert.equal(error.message.includes('brz_secret'), false);
    return true;
  });
  assert.equal(calls, 1, '402 不重试');
});

function retryAfterResponse(status, seconds) {
  const response = jsonResponse({ ok: false, error: { code: 'GENERATION_CONCURRENCY_EXCEEDED' } }, { status });
  const contentType = response.headers.get;
  response.headers = { get: name => (name.toLowerCase() === 'retry-after' ? String(seconds) : contentType(name)) };
  return response;
}

test('breeze 429 按 Retry-After 有界重试，成功即返回音频', async () => {
  const waits = [];
  let calls = 0;
  const provider = createCustomProvider({
    id: 'custom-test-429',
    getConfig: () => BREEZE_CONFIG,
    fetchImpl: async () => { calls += 1; return calls === 1 ? retryAfterResponse(429, 2) : audioResponse(Buffer.from([7])); },
    wait: async ms => { waits.push(ms); },
    random: () => 0,
  });
  const audio = await provider.synth('x', { voiceRef: 'voc_x' });
  assert.equal(audio.extension, 'mp3');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test('breeze 503 重试用尽后如实报错并保留错误码', async () => {
  let calls = 0;
  const provider = createCustomProvider({
    id: 'custom-test-503',
    getConfig: () => BREEZE_CONFIG,
    fetchImpl: async () => { calls += 1; return jsonResponse({ ok: false }, { status: 503 }); },
    wait: async () => {},
  });
  await assert.rejects(() => provider.synth('x', { voiceRef: 'voc_x' }), error => error.code === 'TTS_UPSTREAM_BUSY');
  assert.equal(calls, 3, '首次 + 最多两次重试');
});

test('breeze 同一接口最多两个请求在途，取消的排队请求释放位置', async () => {
  const pending = [];
  let inFlight = 0;
  let peak = 0;
  const provider = createCustomProvider({
    id: 'custom-test-gate',
    getConfig: () => BREEZE_CONFIG,
    fetchImpl: () => new Promise(resolve => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      pending.push(() => { inFlight -= 1; resolve(audioResponse(Buffer.from([1]))); });
    }),
  });
  const first = provider.synth('a', { voiceRef: 'voc_x' });
  const second = provider.synth('b', { voiceRef: 'voc_x' });
  const cancelled = new AbortController();
  const third = provider.synth('c', { voiceRef: 'voc_x', signal: cancelled.signal });
  const fourth = provider.synth('d', { voiceRef: 'voc_x' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2, '第三、四个在排队');
  cancelled.abort(new Error('stale'));
  await assert.rejects(third);
  pending.shift()();
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2, '取消者不占位，第四个进入');
  pending.splice(0).forEach(release => release());
  await Promise.all([second, fourth]);
  assert.equal(peak, 2);
});

test('失败带分段耗时：429 用尽重试时记下尝试次数、状态与重试等待', async () => {
  const { synthesisTimingOf } = await import('../synthesisTiming.js');
  let clock = 0;
  const provider = createCustomProvider({
    id: 'custom-test-timing-429',
    getConfig: () => BREEZE_CONFIG,
    now: () => clock,
    fetchImpl: async () => { clock += 300; return retryAfterResponse(429, 2); },
    wait: async ms => { clock += ms; },
    random: () => 0,
  });
  const error = await provider.synth('x', { voiceRef: 'voc_x' }).catch(caught => caught);
  assert.equal(error.code, 'TTS_RATE_LIMITED');
  assert.deepEqual(synthesisTimingOf(error), {
    phase: 'request', queueMs: 0, retryWaitMs: 4000, requestMs: 900, readMs: 0, attempts: 3, statuses: [429, 429, 429], elapsedMs: 4900,
  });
});

test('失败带分段耗时：预算在排队时到期，阶段是 queue 且记下排队时长；网关包一层仍能查到', async () => {
  const { synthesisTimingOf } = await import('../synthesisTiming.js');
  let clock = 0;
  const releases = [];
  const provider = createCustomProvider({
    id: 'custom-test-timing-queue',
    getConfig: () => BREEZE_CONFIG,
    now: () => clock,
    fetchImpl: () => new Promise(resolve => releases.push(() => resolve(audioResponse(Buffer.from([1]))))),
  });
  const busy = [provider.synth('a', { voiceRef: 'voc_x' }), provider.synth('b', { voiceRef: 'voc_x' })];
  const budget = new AbortController();
  const queued = provider.synth('c', { voiceRef: 'voc_x', signal: budget.signal }).catch(caught => caught);
  await new Promise(resolve => setImmediate(resolve));
  clock += 30_000;
  budget.abort(new DOMException('synthesis budget expired', 'TimeoutError'));
  const error = await queued;
  assert.equal(error.name, 'TimeoutError');
  const timing = synthesisTimingOf(new Error('all tts providers failed', { cause: error }));
  assert.equal(timing.phase, 'queue');
  assert.equal(timing.queueMs, 30_000);
  assert.equal(timing.attempts, 0);
  releases.splice(0).forEach(release => release());
  await Promise.all(busy);
});

test('失败带分段耗时：请求自身超时，阶段是 request', async () => {
  const { synthesisTimingOf } = await import('../synthesisTiming.js');
  let clock = 0;
  const provider = createCustomProvider({
    id: 'custom-test-timing-request',
    getConfig: () => BREEZE_CONFIG,
    now: () => clock,
    fetchImpl: async () => { clock += 30_000; throw new DOMException('request timed out', 'TimeoutError'); },
  });
  const error = await provider.synth('x', { voiceRef: 'voc_x' }).catch(caught => caught);
  assert.equal(error.code, 'TTS_TIMEOUT');
  assert.equal(synthesisTimingOf(error).phase, 'request');
  assert.equal(synthesisTimingOf(error).requestMs, 30_000);
  assert.equal(synthesisTimingOf(error).queueMs, 0);
});

test('失败带分段耗时：厂商已回 200、音频没收完就超时，等响应与接收音频分开计', async () => {
  const { synthesisTimingOf } = await import('../synthesisTiming.js');
  let clock = 0;
  const provider = createCustomProvider({
    id: 'custom-test-timing-read',
    getConfig: () => BREEZE_CONFIG,
    now: () => clock,
    fetchImpl: async () => {
      clock += 1_200;
      return { ...audioResponse(Buffer.from([1])), arrayBuffer: async () => { clock += 28_800; throw new DOMException('request timed out', 'TimeoutError'); } };
    },
  });
  const error = await provider.synth('x', { voiceRef: 'voc_x' }).catch(caught => caught);
  assert.equal(error.code, 'TTS_TIMEOUT');
  assert.deepEqual(synthesisTimingOf(error), {
    phase: 'read', queueMs: 0, retryWaitMs: 0, requestMs: 1_200, readMs: 28_800, attempts: 1, statuses: [200], elapsedMs: 30_000,
  });
});

test('openai 协议不设并发闸门', async () => {
  let inFlight = 0;
  const releases = [];
  const provider = createCustomProvider({
    id: 'custom-test-open',
    getConfig: () => CONFIG,
    fetchImpl: () => new Promise(resolve => { inFlight += 1; releases.push(() => resolve(audioResponse(Buffer.from([1])))); }),
  });
  const all = [1, 2, 3].map(() => provider.synth('x', { voiceRef: 'alloy-cn' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inFlight, 3);
  releases.forEach(release => release());
  await Promise.all(all);
});

test('breeze 模型发现：GET /v1/models，解析 model_id', async () => {
  const seen = {};
  const models = await fetchCustomModels({
    getConfig: () => BREEZE_CONFIG,
    fetchImpl: async (url, options = {}) => {
      seen.url = url;
      seen.key = options.headers['xi-api-key'];
      return jsonResponse([{ model_id: 'breeze-tts-2', name: 'Breeze TTS 2' }, { model_id: 'breeze-tts-2-multilingual', name: 'M' }]);
    },
  });
  assert.equal(seen.url, 'https://api.breeze.blue/v1/models');
  assert.equal(seen.key, 'brz_secret');
  assert.deepEqual(models, ['breeze-tts-2', 'breeze-tts-2-multilingual']);
});

test('breeze 音色发现：个人音色 + 公开目录按热度翻页（next_page_token），中文过滤、去重并标分组', async () => {
  const urls = [];
  const voices = await fetchCustomVoices({
    getConfig: () => ({ ...BREEZE_CONFIG, baseUrl: 'https://api.breeze.blue/v1' }),
    fetchImpl: async url => {
      urls.push(url);
      const params = new URL(url).searchParams;
      if (params.get('voice_type') === 'personal') {
        return jsonResponse({ voices: [{ voice_id: 'voc_mine', name: '我的声音' }], has_more: false, total: 1, page: 1, page_size: 100 });
      }
      if (!params.get('next_page_token')) {
        return jsonResponse({ voices: [{ voice_id: 'voc_p36dbdewwvae', name: '邻家暖心' }, { voice_id: 'voc_mine', name: '重复' }],
          has_more: true, next_page_token: 'tok2', total: 3, page: 1, page_size: 100 });
      }
      return jsonResponse({ voices: [{ voice_id: 'voc_vgqhwwajjjht', name: '月下织梦人' }], has_more: true, next_page_token: 'tok3', total: 3, page: 2, page_size: 100 });
    },
  });
  assert.equal(urls.length, 3, '公开目录最多翻 2 页');
  for (const url of urls) {
    assert.ok(url.startsWith('https://api.breeze.blue/v1/voices?'));
    assert.equal(new URL(url).searchParams.get('language_code'), 'zh');
  }
  assert.equal(new URL(urls[1]).searchParams.get('sort'), 'trend');
  assert.equal(new URL(urls[2]).searchParams.get('next_page_token'), 'tok2');
  assert.deepEqual(voices, [
    { id: 'voc_mine', name: '我的声音', group: 'personal' },
    { id: 'voc_p36dbdewwvae', name: '邻家暖心', group: 'trending' },
    { id: 'voc_vgqhwwajjjht', name: '月下织梦人', group: 'trending' },
  ], '个人音色在前且去重时保留 personal 分组');
});

// ---- 按描述设计声音（voice design）----

const { voiceDesignCapability, designCustomVoices, activateCustomDesignedVoice } = await import('./custom.js');

test('设计能力按协议声明：breeze 最多 3 个、minimax 1 个、openai 没有', () => {
  assert.equal(voiceDesignCapability('breeze').maxCandidates, 3);
  assert.equal(voiceDesignCapability('minimax').maxCandidates, 1);
  assert.match(voiceDesignCapability('breeze').costNote, /计费/);
  assert.equal(voiceDesignCapability('openai'), null);
  assert.equal(voiceDesignCapability('nope'), null);
});

test('openai 协议设计声音：如实报不支持，不发请求', async () => {
  let called = false;
  await assert.rejects(() => designCustomVoices({
    getConfig: () => CONFIG, description: '温柔的女声', fetchImpl: async () => { called = true; },
  }), error => error.code === 'TTS_VOICE_DESIGN_UNSUPPORTED');
  await assert.rejects(() => activateCustomDesignedVoice({
    getConfig: () => CONFIG, generatedId: 'x', fetchImpl: async () => { called = true; },
  }), error => error.code === 'TTS_VOICE_DESIGN_UNSUPPORTED');
  assert.equal(called, false);
});

test('breeze 设计：POST voice-previews/design，不带 model_id，候选数受上限约束，解析 base64 试听', async () => {
  const seen = {};
  const candidates = await designCustomVoices({
    getConfig: () => BREEZE_CONFIG,
    description: '二十多岁的女声，音色清亮，语速偏慢',
    previewText: '你好，今晚想听点什么？',
    count: 9,
    fetchImpl: async (url, init) => {
      Object.assign(seen, { url, headers: init.headers, body: JSON.parse(init.body) });
      return jsonResponse({ text: '你好', previews: [
        { generated_voice_id: 'gen_a', audio_base_64: Buffer.from('AAA').toString('base64'), media_type: 'audio/mpeg' },
        { generated_voice_id: 'gen_b', audio_base_64: Buffer.from('BBB').toString('base64'), media_type: 'audio/mpeg' },
      ] });
    },
  });
  assert.equal(seen.url, 'https://api.breeze.blue/v1/voice-previews/design?output_format=mp3');
  assert.equal(seen.headers['xi-api-key'], 'brz_secret');
  assert.deepEqual(seen.body, {
    voice_description: '二十多岁的女声，音色清亮，语速偏慢', text: '你好，今晚想听点什么？', language_code: 'zh', preview_count: 3,
  });
  assert.deepEqual(candidates.map(item => [item.generatedId, item.audio.bytes.toString(), item.audio.extension]),
    [['gen_a', 'AAA', 'mp3'], ['gen_b', 'BBB', 'mp3']]);
});

test('breeze 设计失败：402 如实报出并带错误码，不含 key', async () => {
  await assert.rejects(() => designCustomVoices({
    getConfig: () => BREEZE_CONFIG, description: '温柔的女声',
    fetchImpl: async () => jsonResponse({ error: { message: 'insufficient credits' } }, { status: 402 }),
  }), error => error.code === 'TTS_CREDIT_EXHAUSTED' && /额度/.test(error.message) && !/brz_secret/.test(error.message));
});

test('breeze 转正：POST voice-previews/{id}/save，返回永久 voice_id；名额已满如实报出', async () => {
  const seen = {};
  const result = await activateCustomDesignedVoice({
    getConfig: () => BREEZE_CONFIG, generatedId: 'gen/a', name: '小满的声音', description: '清亮女声',
    fetchImpl: async (url, init) => {
      Object.assign(seen, { url, body: JSON.parse(init.body) });
      return jsonResponse({ voice_id: 'voc_new', name: '小满的声音' });
    },
  });
  assert.equal(seen.url, 'https://api.breeze.blue/v1/voice-previews/gen%2Fa/save');
  assert.deepEqual(seen.body, { voice_name: '小满的声音', voice_description: '清亮女声', language_code: 'zh' });
  assert.deepEqual(result, { voiceId: 'voc_new' });

  await assert.rejects(() => activateCustomDesignedVoice({
    getConfig: () => BREEZE_CONFIG, generatedId: 'gen_a', name: 'x',
    fetchImpl: async () => jsonResponse({ error: { code: 'FORBIDDEN' } }, { status: 403 }),
  }), /403.*名额/);
});

test('minimax 设计：POST /v1/voice_design，解析 voice_id 与 hex 试听；base_resp 非 0 报错', async () => {
  const seen = {};
  const candidates = await designCustomVoices({
    getConfig: () => MINIMAX_CONFIG, description: '低沉的男声', previewText: '晚上好。', count: 3,
    fetchImpl: async (url, init) => {
      Object.assign(seen, { url, headers: init.headers, body: JSON.parse(init.body) });
      return jsonResponse({ voice_id: 'ttv-voice-1', trial_audio: Buffer.from('MP3').toString('hex'), base_resp: { status_code: 0 } });
    },
  });
  assert.equal(seen.url, 'https://api.minimax.cn/v1/voice_design');
  assert.match(seen.headers.Authorization, /^Bearer /);
  assert.deepEqual(seen.body, { prompt: '低沉的男声', preview_text: '晚上好。' });
  assert.deepEqual(candidates.map(item => [item.generatedId, item.audio.bytes.toString()]), [['ttv-voice-1', 'MP3']]);

  await assert.rejects(() => designCustomVoices({
    getConfig: () => MINIMAX_CONFIG, description: '低沉的男声',
    fetchImpl: async () => jsonResponse({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
  }), /1008.*insufficient balance/);
});

test('minimax 转正：用接口 model 做一次短合成，voice id 不变；没有 model 时报错', async () => {
  const seen = {};
  const result = await activateCustomDesignedVoice({
    getConfig: () => MINIMAX_CONFIG, generatedId: 'ttv-voice-1', name: '低沉',
    fetchImpl: async (url, init) => {
      Object.assign(seen, { url, body: JSON.parse(init.body) });
      return jsonResponse({ data: { audio: Buffer.from('MP3').toString('hex') }, base_resp: { status_code: 0 } });
    },
  });
  assert.equal(seen.url, 'https://api.minimax.cn/v1/t2a_v2');
  assert.equal(seen.body.voice_setting.voice_id, 'ttv-voice-1');
  assert.equal(seen.body.model, MINIMAX_CONFIG.model);
  assert.ok(seen.body.text.length <= 10, '转正合成要尽量短');
  assert.deepEqual(result, { voiceId: 'ttv-voice-1' });

  await assert.rejects(() => activateCustomDesignedVoice({
    getConfig: () => ({ ...MINIMAX_CONFIG, model: '' }), generatedId: 'ttv-voice-1', fetchImpl: async () => jsonResponse({}),
  }), /model/);
});

test('recipe 协议：按配方合成、不要求 model、表演标记剥掉；不合法配方按不可用处理', async () => {
  const recipe = {
    version: 1,
    synth: { method: 'POST', path: '/tts', headers: { 'X-Key': '{apiKey}' }, body: { text: '{text}', voice: '{voice}' } },
    audio: { kind: 'json', audioPath: 'audio', encoding: 'base64' },
  };
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16, 1)]);
  const seen = {};
  const provider = createCustomProvider({
    getConfig: () => ({ protocol: 'recipe', baseUrl: 'https://vendor.example', apiKey: 'sk-secret', model: '', recipe }),
    fetchImpl: async (url, init) => {
      seen.url = url;
      seen.init = init;
      return new Response(JSON.stringify({ audio: mp3.toString('base64') }), { headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(provider.performanceCapability().pace, false);
  const rendered = provider.renderPerformance('{叹气}今晚好。{停顿:0.6}', { emotion: 'sad', pace: 'slow' });
  assert.doesNotMatch(rendered.text, /[{}]|叹气|停顿/, '配方接口没有表演能力，标记全部剥掉');
  assert.deepEqual(rendered.native, {}, '也没有原生风格字段');
  const audio = await provider.synth(rendered.text, { voiceRef: 'v1' });
  assert.equal(JSON.parse(seen.init.body).text, rendered.text);
  assert.equal(seen.url, 'https://vendor.example/tts');
  assert.equal(seen.init.headers['X-Key'], 'sk-secret');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(audio.extension, 'mp3');

  const broken = createCustomProvider({
    getConfig: () => ({ protocol: 'recipe', baseUrl: 'https://vendor.example', apiKey: 'sk-secret', recipe: { ...recipe, version: 9 } }),
    fetchImpl: async () => { throw new Error('should not request'); },
  });
  await assert.rejects(() => broken.synth('你好', { voiceRef: 'v1' }), error => error instanceof TtsProviderUnavailableError && /配方不合法/.test(error.message));
});

test('recipe 协议：重定向不跟随，错误不含 key', async () => {
  const recipe = { version: 1, synth: { path: '/tts', headers: { Authorization: 'Bearer {apiKey}' }, body: { t: '{text}' } }, audio: { kind: 'binary' } };
  const provider = createCustomProvider({
    getConfig: () => ({ protocol: 'recipe', baseUrl: 'https://vendor.example', apiKey: 'sk-secret', recipe }),
    fetchImpl: async () => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } }),
  });
  await assert.rejects(() => provider.synth('你好', { voiceRef: 'v' }), error => /重定向/.test(error.message) && !error.message.includes('sk-secret'));
});
