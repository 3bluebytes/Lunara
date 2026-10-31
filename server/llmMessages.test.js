// llmMessages.test.js — 可移植消息形状与各协议译后校验。
//
// 背景（2026-10-19 实测）：Zhipu GLM 走 openai-completions，却对只有 system 的请求返回 400/1214；
// 受限任务（选歌、续播、串词）全部失败。消息形状统一在传输层修正与校验，
// 而不是在某个调用方或某个协议里打补丁。
//
// Run: node --test server/llmMessages.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlm } from './llm.js';
import { conformMessages, TASK_INPUT_MARKER, validateRequestBody, VALIDATED_PROTOCOLS } from './llmMessages.js';

const call = (id, name = 'probe') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const marker = { role: 'user', content: TASK_INPUT_MARKER };

test('system-only task input gets one neutral marker after the merged system message', () => {
  const input = [{ role: 'system', content: '任务说明' }];
  assert.deepEqual(conformMessages(input), [{ role: 'system', content: '任务说明' }, marker]);
  assert.deepEqual(input, [{ role: 'system', content: '任务说明' }], '不修改入参');
  assert.deepEqual(conformMessages([]), [marker]);
});

test('history that starts with an assistant turn or tool flow is led by the marker', () => {
  const out = conformMessages([
    { role: 'system', content: 'S' },
    { role: 'assistant', content: '', tool_calls: [call('c1')] },
    { role: 'tool', tool_call_id: 'c1', content: '{}' },
  ]);
  assert.deepEqual(out.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.equal(out[1].content, TASK_INPUT_MARKER);
});

test('a conversation that already starts with the user is unchanged; scattered system parts merge at the head', () => {
  const conversation = [{ role: 'system', content: 'A' }, { role: 'user', content: '放首歌' }, { role: 'system', content: 'B' }];
  assert.deepEqual(conformMessages(conversation), [{ role: 'system', content: 'A\n\nB' }, { role: 'user', content: '放首歌' }]);
});

test('unpairable tool flow and unknown roles fail closed with a typed error', () => {
  const invalid = code => error => error?.code === code;
  assert.throws(() => conformMessages([{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 'nope', content: '' }]),
    invalid('LLM_MESSAGE_SHAPE_INVALID'), '孤立的 tool 结果');
  assert.throws(() => conformMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [call('c1'), call('c2')] },
    { role: 'tool', tool_call_id: 'c1', content: '' }, { role: 'user', content: 'y' }]), invalid('LLM_MESSAGE_SHAPE_INVALID'), '漏答的 call');
  assert.throws(() => conformMessages([{ role: 'user', content: 'x' }, { role: 'assistant', content: '', tool_calls: [call('c1')] }]),
    invalid('LLM_MESSAGE_SHAPE_INVALID'), '末尾未回应的 call');
  assert.throws(() => conformMessages([{ role: 'developer', content: 'x' }]), invalid('LLM_MESSAGE_SHAPE_INVALID'));
});

test('protocol validators reject bodies the vendor would reject', () => {
  assert.deepEqual([...VALIDATED_PROTOCOLS].sort(),
    ['anthropic-messages', 'google-generative-ai', 'openai-completions', 'openai-responses']);
  assert.throws(() => validateRequestBody('openai-completions', { messages: [{ role: 'system', content: 'S' }] }), /first non-system/);
  assert.throws(() => validateRequestBody('openai-responses', { input: [{ role: 'system', content: 'S' }] }), /first non-system/);
  assert.throws(() => validateRequestBody('anthropic-messages', { messages: [] }), /empty/);
  assert.throws(() => validateRequestBody('google-generative-ai', { contents: [{ role: 'model', parts: [] }] }), /first content/);
  assert.throws(() => validateRequestBody('some-stream-protocol', {}), /unknown protocol/, '新协议必须先登记校验规则');
});

// 每个协议端到端：系统任务（只有 system）与工具往返都能被翻译成合法请求体。
const PROTOCOLS = {
  'openai-completions': {
    endpoint: { baseUrl: 'http://g/v1', apiKey: 'k', model: 'glm-like', api: 'openai-completions' },
    reply: { choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }] },
    firstUser: body => body.messages.find(message => message.role !== 'system'),
  },
  'openai-responses': {
    endpoint: { baseUrl: 'http://r/v1', apiKey: 'k', model: 'gpt-x', api: 'openai-responses' },
    reply: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好' }] }], status: 'completed' },
    firstUser: body => body.input.find(item => item.role !== 'system'),
  },
  'anthropic-messages': {
    endpoint: { baseUrl: 'http://a/v1', apiKey: 'k', model: 'claude-x', api: 'anthropic-messages' },
    reply: { content: [{ type: 'text', text: '好' }], stop_reason: 'end_turn' },
    firstUser: body => body.messages[0],
  },
  'google-generative-ai': {
    endpoint: { baseUrl: 'http://g/v1beta', apiKey: 'k', model: 'gemini-x', api: 'google-generative-ai' },
    reply: { candidates: [{ content: { role: 'model', parts: [{ text: '好' }] }, finishReason: 'STOP' }] },
    firstUser: body => body.contents[0],
  },
};

for (const [api, spec] of Object.entries(PROTOCOLS)) {
  test(`${api}: a system-only task and a tool round trip both produce valid bodies`, async () => {
    const bodies = [];
    const llm = createLlm({
      fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => spec.reply }; },
      resolveEndpoint: async () => spec.endpoint,
    });
    const options = { maxTokens: 64, temperature: 0, taskId: 'connectivity_probe' };
    await llm.chat([{ role: 'system', content: '任务说明' }], null, options);
    await llm.chat([{ role: 'system', content: '任务说明' }, { role: 'assistant', content: '', tool_calls: [call('c1')] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' }], null, options);
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.doesNotThrow(() => validateRequestBody(api, body));
      assert.match(JSON.stringify(spec.firstUser(body)), /系统任务输入/u);
    }
  });
}

test('an invalid message shape never reaches the network', async () => {
  let fetched = 0;
  const llm = createLlm({ fetchImpl: async () => { fetched += 1; return { ok: true, json: async () => ({}) }; },
    resolveEndpoint: async () => PROTOCOLS['openai-completions'].endpoint });
  await assert.rejects(llm.chat([{ role: 'tool', tool_call_id: 'x', content: '' }], null, { taskId: 'connectivity_probe' }),
    error => error?.code === 'LLM_MESSAGE_SHAPE_INVALID');
  assert.equal(fetched, 0);
});
