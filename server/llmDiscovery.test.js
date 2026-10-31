// llmDiscovery.test.js — 模型发现（离线 mock fetch，四种协议各自的 models 端点）。
//
// 返回形状：`models` 是 `{ id, name?, reasoningEfforts?, contextWindow?, maxOutputTokens?,
// modalities? }` 的对象数组（按 id 去重、保持首次出现顺序）；没有元数据时仍只有 `{ id }`。

import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverModels } from './llmDiscovery.js';

function fakeFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    if (status !== 200) return { ok: false, status, text: async () => 'boom' };
    return { ok: true, json: async () => payload };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('openai 协议：GET {base}/models 带 Bearer，取 data[] 按 id 去重', async () => {
  const fetchImpl = fakeFetch({ data: [{ id: 'm-a' }, { id: 'm-b' }, { id: 'm-a' }] });
  const out = await discoverModels({ baseUrl: 'http://127.0.0.1:3425/v1/', apiKey: 'sk-x', api: 'openai-completions', fetchImpl });
  assert.deepEqual(out.models, [{ id: 'm-a' }, { id: 'm-b' }]);
  assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:3425/v1/models');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer sk-x');
});

test('anthropic 协议：x-api-key + anthropic-version', async () => {
  const fetchImpl = fakeFetch({ data: [{ id: 'claude-x' }] });
  const out = await discoverModels({ baseUrl: 'http://a/v1', apiKey: 'ak', api: 'anthropic-messages', fetchImpl });
  assert.deepEqual(out.models, [{ id: 'claude-x' }]);
  assert.equal(fetchImpl.calls[0].headers['x-api-key'], 'ak');
  assert.equal(fetchImpl.calls[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(fetchImpl.calls[0].headers.Authorization, undefined);
});

test('google 协议：剥掉 models/ 前缀并只留支持 generateContent 的模型', async () => {
  const fetchImpl = fakeFetch({
    models: [
      { name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-y', supportedGenerationMethods: ['generateContent', 'embedContent'] },
      { name: 'models/embed-z', supportedGenerationMethods: ['embedContent'] },
      { name: 'models/no-methods' },
    ],
  });
  const out = await discoverModels({ baseUrl: 'http://g/v1beta', apiKey: 'gk', api: 'google-generative-ai', fetchImpl });
  assert.deepEqual(out.models, [{ id: 'gemini-x' }, { id: 'gemini-y' }, { id: 'no-methods' }]);
  assert.equal(fetchImpl.calls[0].headers['x-goog-api-key'], 'gk');
});

test('Magpie 形状：保留声明档位与容量元数据，重复 id 保留首次出现', async () => {
  const fetchImpl = fakeFetch({ data: [
    {
      id: 'zhipu/glm-5.3-flash', name: 'GLM-5.3-Flash',
      reasoning_levels: ['low', 'high', 'max'],
      context_window: 1_000_000, max_output_tokens: 65_536,
      modalities: { input: ['text', 'image', 'text'] },
    },
    { id: 'minimax-cn/MiniMax-M3' },
    // 重复 id：保留首次出现的元数据，不合并也不覆盖。
    { id: 'zhipu/glm-5.3-flash', reasoning_levels: ['none'], context_window: 1 },
  ] });
  const out = await discoverModels({ baseUrl: 'http://magpie/v1', api: 'openai-responses', fetchImpl });
  assert.deepEqual(out.models, [
    {
      id: 'zhipu/glm-5.3-flash', name: 'GLM-5.3-Flash',
      reasoningEfforts: ['low', 'high', 'max'],
      contextWindow: 1_000_000, maxOutputTokens: 65_536,
      modalities: ['text', 'image'],
    },
    { id: 'minimax-cn/MiniMax-M3' },
  ]);
});

test('supported_reasoning_levels[].effort 回退、reasoning_levels 优先，容量字段兼容 camel/Google', async () => {
  const fetchImpl = fakeFetch({ data: [
    { id: 'a', supported_reasoning_levels: [{ effort: ' minimal ' }, { effort: 'low' }, { effort: 'minimal' }, { level: 'x' }, null] },
    // reasoning_levels 有效时不再看 supported_reasoning_levels。
    { id: 'b', reasoning_levels: ['none', 'high'], supported_reasoning_levels: [{ effort: 'low' }] },
    { id: 'c', contextWindow: 128_000, maxOutputTokens: 4_096, input_modalities: ['text', 'audio'] },
  ] });
  const out = await discoverModels({ baseUrl: 'http://gw/v1', api: 'openai-completions', fetchImpl });
  assert.deepEqual(out.models, [
    { id: 'a', reasoningEfforts: ['minimal', 'low'] },
    { id: 'b', reasoningEfforts: ['none', 'high'] },
    { id: 'c', contextWindow: 128_000, maxOutputTokens: 4_096, modalities: ['text', 'audio'] },
  ]);
});

test('google 元数据：inputTokenLimit/outputTokenLimit 作为容量、displayName 作为 name', async () => {
  const fetchImpl = fakeFetch({ models: [
    {
      name: 'models/gemini-y', displayName: 'Gemini Y',
      supportedGenerationMethods: ['generateContent'],
      inputTokenLimit: 1_048_576, outputTokenLimit: 8_192,
      reasoning_levels: ['low', 'high'],
    },
  ] });
  const out = await discoverModels({ baseUrl: 'http://g/v1beta', api: 'google-generative-ai', fetchImpl });
  assert.deepEqual(out.models, [{
    id: 'gemini-y', name: 'Gemini Y',
    reasoningEfforts: ['low', 'high'],
    contextWindow: 1_048_576, maxOutputTokens: 8_192,
  }]);
});

test('坏元数据被忽略，模型仍以 { id } 返回；name 不是必填', async () => {
  const fetchImpl = fakeFetch({ data: [
    {
      id: 'bad',
      reasoning_levels: 'low',
      supported_reasoning_levels: [{ effort: '' }, { nope: 1 }],
      context_window: -1, max_output_tokens: 'lots',
      modalities: { input: 'text' },
    },
    { id: 'zero', context_window: 0, max_output_tokens: 0, reasoning_levels: [null, 3, ''] },
  ] });
  const out = await discoverModels({ baseUrl: 'http://gw/v1', api: 'openai-completions', fetchImpl });
  assert.deepEqual(out.models, [{ id: 'bad' }, { id: 'zero' }]);
});

test('失败如实报错且不含 key；空 Base URL 直接拒绝', async () => {
  const fetchImpl = fakeFetch({}, { status: 401 });
  await assert.rejects(() => discoverModels({ baseUrl: 'http://x/v1', apiKey: 'sk-secret', api: 'openai-completions', fetchImpl }),
    error => /401/.test(error.message) && !error.message.includes('sk-secret'));
  await assert.rejects(() => discoverModels({ baseUrl: '', api: 'openai-completions', fetchImpl }), /Base URL/);
});
