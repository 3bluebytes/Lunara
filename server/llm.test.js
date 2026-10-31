// llm.test.js — 传输层四协议适配器（离线 mock fetch）。
//
// 对应 unified-model-providers 任务 2.x：
//   - 解析链：显式 endpoint → 注册表 activeModel → legacy → LLM_NOT_CONFIGURED
//   - openai-completions：tools 透传、Bearer、thinkingMode 官方或明确的 DeepSeek 模型家族
//   - anthropic-messages：system 提取、max_tokens 必填、tool_use/tool_result 块、x-api-key
//   - google-generative-ai：systemInstruction、functionDeclarations、functionCall/Response、id→name
//   - openai-responses：input 转换、function_call/call_id 往返、max_output_tokens
//
// Run: node --test server/llm.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { createLlm, extractJson, LLMNotConfiguredError, rawChatAttempt, setCapabilityObserver, setLlmBudgetGuard, setLlmObserver } from './llm.js';

function fakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} });
    return responder(calls.length, calls[calls.length - 1]);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** 收集观测事件；测试结束必须卸载观察者（模块级状态）。 */
function collectObserver(t) {
  const events = [];
  setLlmObserver(event => events.push(event));
  t.after(() => setLlmObserver(null));
  return events;
}

const TOOLS = [{
  type: 'function',
  function: { name: 'search_music', description: '搜歌', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
}];

const MESSAGES_WITH_TOOLFLOW = [
  { role: 'system', content: '你是主持人。' },
  { role: 'user', content: '放首歌' },
  { role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_music', arguments: '{"query":"孙燕姿"}' } }] },
  { role: 'tool', tool_call_id: 'call-1', content: '{"tracks":[]}' },
];

test('openai-completions：tools 透传、Bearer、默认解析 legacy 配置', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: '好的', tool_calls: null }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-k', model: 'deepseek-v4-flash', api: 'openai-completions' }),
  });
  const out = await llm.chat(MESSAGES_WITH_TOOLFLOW, TOOLS, { maxTokens: 100, temperature: 0.5, thinkingMode: 'disabled', taskId: 'connectivity_probe' });
  assert.equal(out.message.content, '好的');
  assert.equal(out.finishReason, 'stop');
  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(call.headers.Authorization, 'Bearer sk-k');
  assert.equal(call.body.thinking.type, 'disabled', '官方 DeepSeek 允许 thinkingMode 扩展');
  assert.deepEqual(call.body.tools, TOOLS);
  assert.equal(call.body.max_tokens, 100);
});

test('anthropic-messages：system 提取、max_tokens 必填、tool_use/tool_result 往返', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'text', text: '找到了' }, { type: 'tool_use', id: 'tu_9', name: 'search_music', input: { query: 'a' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 4 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'ak-test', model: 'claude-x', api: 'anthropic-messages' }),
  });
  const out = await llm.chat(MESSAGES_WITH_TOOLFLOW, TOOLS, { maxTokens: 777, temperature: 0.4 });
  assert.deepEqual(out.message.tool_calls, [{ id: 'tu_9', type: 'function', function: { name: 'search_music', arguments: '{"query":"a"}' } }]);
  assert.equal(out.finishReason, 'tool_calls');
  assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://gw/v1/messages');
  assert.equal(call.headers['x-api-key'], 'ak-test');
  assert.equal(call.headers.Authorization, undefined, 'anthropic 不用 Bearer');
  assert.equal(call.body.max_tokens, 777, 'anthropic 契约必填 max_tokens');
  assert.equal(call.body.system, '你是主持人。', 'system 提取到顶层');
  assert.equal(call.body.messages.filter(message => message.role === 'system').length, 0);
  const assistant = call.body.messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant.content, [
    { type: 'tool_use', id: 'call-1', name: 'search_music', input: { query: '孙燕姿' } },
  ], '历史 assistant.tool_calls 必须变成 tool_use 块');
  const toolTurn = call.body.messages.filter(message => message.role === 'user').pop();
  assert.deepEqual(toolTurn.content, [
    { type: 'tool_result', tool_use_id: 'call-1', content: '{"tracks":[]}' },
  ], 'tool 消息合并为 user 消息的 tool_result 块');
  assert.deepEqual(call.body.tools, [{ name: 'search_music', description: '搜歌', input_schema: TOOLS[0].function.parameters }]);
});

test('google-generative-ai：systemInstruction、functionCall/Response、id→name 映射', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { role: 'model', parts: [{ text: '好' }, { functionCall: { name: 'search_music', args: { query: 'b' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1beta', apiKey: 'g-key', model: 'gemini-x', api: 'google-generative-ai' }),
  });
  const out = await llm.chat(MESSAGES_WITH_TOOLFLOW, TOOLS, { maxTokens: 50, temperature: 0.2 });
  assert.deepEqual(out.message.tool_calls, [{ id: 'gcall_search_music', type: 'function', function: { name: 'search_music', arguments: '{"query":"b"}' } }]);
  assert.equal(out.finishReason, 'tool_calls');
  assert.deepEqual(out.usage, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://g/v1beta/models/gemini-x:generateContent');
  assert.equal(call.headers['x-goog-api-key'], 'g-key');
  assert.deepEqual(call.body.systemInstruction, { parts: [{ text: '你是主持人。' }] });
  const modelTurn = call.body.contents.find(content => content.role === 'model');
  assert.deepEqual(modelTurn.parts, [{ functionCall: { name: 'search_music', args: { query: '孙燕姿' } } }]);
  const toolTurn = call.body.contents.filter(content => content.role === 'user').pop();
  assert.deepEqual(toolTurn.parts, [{ functionResponse: { name: 'search_music', response: { result: '{"tracks":[]}' } } }],
    'tool 消息按 id→name 映射为 functionResponse');
  assert.deepEqual(call.body.tools, [{ functionDeclarations: [{ name: 'search_music', description: '搜歌', parameters: TOOLS[0].function.parameters }] }]);
  assert.equal(call.body.generationConfig.maxOutputTokens, 50);
});

test('openai-responses：input 转换、function_call/call_id 往返', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'fc_1', name: 'search_music', arguments: '{"query":"c"}' },
      ],
      usage: { input_tokens: 6, output_tokens: 2 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://r/v1', apiKey: 'r-key', model: 'gpt-x', api: 'openai-responses' }),
  });
  const out = await llm.chat(MESSAGES_WITH_TOOLFLOW, TOOLS, { maxTokens: 64, temperature: 0.3 });
  assert.deepEqual(out.message.tool_calls, [{ id: 'fc_1', type: 'function', function: { name: 'search_music', arguments: '{"query":"c"}' } }]);
  assert.equal(out.finishReason, 'tool_calls');

  const call = fetchImpl.calls[0];
  assert.equal(call.url, 'http://r/v1/responses');
  assert.equal(call.headers.Authorization, 'Bearer r-key');
  assert.equal(call.body.max_output_tokens, 64);
  assert.deepEqual(call.body.tools, [{ type: 'function', name: 'search_music', description: '搜歌', parameters: TOOLS[0].function.parameters }]);
  const fc = call.body.input.find(item => item.type === 'function_call');
  assert.deepEqual(fc, { type: 'function_call', call_id: 'call-1', name: 'search_music', arguments: '{"query":"孙燕姿"}' });
  const fco = call.body.input.find(item => item.type === 'function_call_output');
  assert.deepEqual(fco, { type: 'function_call_output', call_id: 'call-1', output: '{"tracks":[]}' });
  const system = call.body.input.find(item => item.role === 'system');
  assert.equal(system.content, '你是主持人。');
});

test('无可用端点：抛 LLM_NOT_CONFIGURED', async () => {
  const fetchImpl = fakeFetch(() => { throw new Error('must not be called'); });
  const llm = createLlm({ fetchImpl, resolveEndpoint: async () => { throw new LLMNotConfiguredError(); } });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }]),
    error => error instanceof LLMNotConfiguredError);
  assert.equal(fetchImpl.calls.length, 0);
});

test('extractJson：从混有前后缀的文本中抠出 JSON', () => {
  assert.deepEqual(extractJson('前缀 {"a":1} 后缀'), { a: 1 });
  assert.deepEqual(extractJson('{"a":{"b":2}}'), { a: { b: 2 } });
  assert.equal(extractJson('no json'), null);
});

test('chat 允许调用者覆盖低延迟参数；未知模型不发 thinking 扩展', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }] }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'https://gateway.test/v1', apiKey: 'sk-test', model: 'agent-model', api: 'openai-completions' }),
  });
  await llm.chat([{ role: 'user', content: '分类' }], null, {
    maxTokens: 512, temperature: 0, timeoutMs: 1500, toolChoice: 'required', thinkingMode: 'disabled',
  });
  const call = fetchImpl.calls[0];
  assert.equal(call.body.max_tokens, 512);
  assert.equal(call.body.temperature, 0);
  assert.equal(call.body.tool_choice, 'required');
  assert.equal('thinking' in call.body, false, '厂商扩展不发给通用 OAI 端点');
  assert.ok(call.options.signal instanceof AbortSignal);
});

test('网关 DeepSeek 模型保留显式 thinkingMode，不向其它模型发送扩展', async () => {
  for (const [model, supported] of [
    ['deepseek/deepseek-flash', true],
    ['commandcode/deepseek/deepseek-v4.1-flash', true],
    ['DeepSeek-Chat', true],
    ['deepseek', true],
    ['zhipu/glm-5.3', false],
    ['openai/gpt-5', false],
    ['my-deepseek-chat', false],
    ['deepseekish-chat', false],
    ['deepseek/glm-5.3', false],
    ['agent-model', false],
  ]) {
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      json: async () => ({ choices: [{ message: { role: 'assistant', content: '正常' }, finish_reason: 'stop' }] }),
    }));
    const llm = createLlm({
      fetchImpl,
      resolveEndpoint: async () => ({ baseUrl: 'http://gateway.test/v1', model, api: 'openai-completions' }),
    });
    const toolChoice = { type: 'function', function: { name: 'search_music' } };
    for (const thinkingMode of ['disabled', 'enabled']) {
      await llm.chat([{ role: 'user', content: '测试' }], TOOLS, { thinkingMode, toolChoice, taskId: 'connectivity_probe' });
      const body = fetchImpl.calls.at(-1).body;
      assert.deepEqual(body.thinking, supported ? { type: thinkingMode } : undefined, model);
      assert.deepEqual(body.tool_choice, toolChoice, '不能靠移除指定工具来回避拒绝');
    }
    await llm.chat([{ role: 'user', content: '测试' }]);
    assert.equal('thinking' in fetchImpl.calls.at(-1).body, false, '未设置时不改变默认思考');
  }
});

test('其它协议即使模型命名为 DeepSeek 也不携带 thinking 扩展', async () => {
  for (const api of ['openai-responses', 'anthropic-messages', 'google-generative-ai']) {
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      json: async () => ({ output: [], content: [], candidates: [] }),
    }));
    const llm = createLlm({
      fetchImpl,
      resolveEndpoint: async () => ({ baseUrl: 'http://gateway.test/v1', model: 'deepseek/deepseek-flash', api }),
    });
    await llm.chat([{ role: 'user', content: '测试' }], null, { thinkingMode: 'disabled' });
    assert.equal('thinking' in fetchImpl.calls[0].body, false, api);
  }
});

test('传输失败/坏 JSON 的降级错误码；取消保持取消', async () => {
  const throwing = async () => { throw new TypeError('network unavailable'); };
  const llmA = createLlm({ fetchImpl: fakeFetch(throwing), resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }) });
  await assert.rejects(() => llmA.chat([{ role: 'user', content: '继续播放' }]),
    error => error?.code === 'LLM_API_ERROR' && !error.message.includes('network unavailable'),
    '传输失败不得把底层原因透给用户');

  const llmB = createLlm({ fetchImpl: fakeFetch(() => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } })),
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }) });
  await assert.rejects(() => llmB.chat([{ role: 'user', content: '继续播放' }]),
    error => error?.code === 'LLM_INVALID_RESPONSE');

  const controller = new AbortController();
  const llmC = createLlm({ fetchImpl: async () => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); },
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }) });
  await assert.rejects(() => llmC.chat([{ role: 'user', content: '继续播放' }], null, { signal: controller.signal }),
    error => error?.name === 'AbortError' && error?.code !== 'LLM_API_ERROR');
});

test('askText 转发 signal 与采样参数；返回纯文本', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: '{"say":"晚上好"}' } }] }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const controller = new AbortController();
  const text = await llm.askText('background observations', { signal: controller.signal, maxTokens: 600, temperature: 0.2, timeoutMs: 15000 });
  assert.match(text, /晚上好/);
  const call = fetchImpl.calls[0];
  assert.equal(call.options.signal.aborted, false);
  assert.equal(call.body.max_tokens, 600);
  assert.equal(call.body.temperature, 0.2);
  controller.abort();
  assert.equal(call.options.signal.aborted, true);
});

// ============================================================
// 观测钩子（会话 JSONL 记录）：start/end/error
// ============================================================

test('观测钩子：traceContent=false 只留数值与分类，不记请求 body、回复正文、工具参数与思考', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '她的草稿', reasoning_content: '思考草稿',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_music', arguments: '{"query":"私密"}' } }] },
        finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-secret', model: 'deepseek-v4-flash', api: 'openai-completions' }),
  });
  await llm.chat([{ role: 'user', content: '［运行时提示，不是对方说的话］' }], TOOLS,
    { sessionId: 'sess-1', maxTokens: 100, taskId: 'ambient_turn', traceContent: false });

  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'end']);
  const [start, attemptEvent, end] = events;
  assert.equal(start.sessionId, 'sess-1', '会话归属不变（会话模型覆盖照常生效）');
  assert.equal(start.body, null);
  assert.deepEqual(start.toolNames, ['search_music'], '工具名保留');
  assert.equal(end.text, null);
  assert.equal(end.reasoning, null);
  assert.deepEqual(end.toolCalls, [{ name: 'search_music' }], '只留工具名，不留参数');
  assert.deepEqual(attemptEvent.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, '用量照常落账');
  const serialized = JSON.stringify(events);
  for (const secret of ['运行时提示', '她的草稿', '思考草稿', '私密']) assert.equal(serialized.includes(secret), false, secret);
});

test('观测钩子：openai-completions 的 start/end 带适配后的 body 与公开响应字段', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '好的' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'https://api.deepseek.com', apiKey: 'sk-secret', model: 'deepseek-v4-flash', api: 'openai-completions', source: 'registry:default' }),
  });
  await llm.chat(MESSAGES_WITH_TOOLFLOW, TOOLS, {
    sessionId: 'sess-1', maxTokens: 100, temperature: 0.5, timeoutMs: 1234, thinkingMode: 'disabled', toolChoice: 'auto',
    taskId: 'connectivity_probe',
  });

  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'end']);
  const [start, attemptEvent, end] = events;
  assert.deepEqual({
    sessionId: start.sessionId, model: start.model, api: start.api, source: start.source,
    maxTokens: start.maxTokens, temperature: start.temperature, timeoutMs: start.timeoutMs,
    thinkingMode: start.thinkingMode, toolChoice: start.toolChoice, toolNames: start.toolNames,
  }, {
    sessionId: 'sess-1', model: 'deepseek-v4-flash', api: 'openai-completions', source: 'registry:default',
    maxTokens: 100, temperature: 0.5, timeoutMs: 1234, thinkingMode: 'disabled', toolChoice: 'auto', toolNames: ['search_music'],
  });
  // 每次尝试各留一条 model_attempt：分类、额度与用量（design §3 任务 3.4）。
  assert.deepEqual({
    taskId: attemptEvent.taskId, attempt: attemptEvent.attempt, outcome: attemptEvent.outcome,
    escalatedFrom: attemptEvent.escalatedFrom, finishReason: attemptEvent.finishReason,
  }, { taskId: 'connectivity_probe', attempt: 1, outcome: 'ok', escalatedFrom: null, finishReason: 'stop' });
  assert.deepEqual(attemptEvent.budget, { requested: 100, effective: 100, allowance: 0, reservedTokens: 100,
    taskId: 'connectivity_probe', overrideSources: ['explicit:maxTokens'] });
  assert.ok(typeof attemptEvent.attemptId === 'string' && attemptEvent.attemptId.length > 0, 'attemptId 是账本幂等键');
  assert.deepEqual(attemptEvent.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  // body 必须是实际适配后的请求（system 留在 messages 内、tools 透传），且不含 url/headers。
  assert.equal(start.body.model, 'deepseek-v4-flash');
  assert.deepEqual(start.body.messages, MESSAGES_WITH_TOOLFLOW);
  assert.equal(start.body.messages[0].role, 'system');
  assert.deepEqual(start.body.tools, TOOLS);
  assert.equal(start.body.thinking.type, 'disabled');
  for (const key of ['url', 'headers', 'apiKey', 'baseUrl', 'Authorization']) {
    assert.equal(Object.hasOwn(start, key), false, key);
    assert.equal(JSON.stringify(start).includes(key), false, key);
  }

  assert.equal(end.text, '好的');
  assert.equal(end.finishReason, 'stop');
  assert.deepEqual(end.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.equal(end.toolCalls, null);
  assert.ok(Number.isInteger(end.durationMs) && end.durationMs >= 0);
  assert.equal(end.reasoning, null, '供应商没返回思考就是 null，不伪造');
  assert.equal(end.reasoningTokens, null);
});

test('观测钩子：anthropic 的 start 是适配后请求（system 顶层），end 带 thinking 文本', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      content: [
        { type: 'thinking', thinking: '先确认用户想听什么' },
        { type: 'text', text: '找到了' },
        { type: 'tool_use', id: 'tu_9', name: 'search_music', input: { query: 'a' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 4 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'ak-test', model: 'claude-x', api: 'anthropic-messages' }),
  });
  const out = await llm.chat(MESSAGES_WITH_TOOLFLOW, TOOLS, { maxTokens: 777, temperature: 0.4 });
  assert.equal(out.reasoning, '先确认用户想听什么');
  assert.equal(out.reasoningTokens, null, 'anthropic usage 没有独立推理 token 计数');

  const [start, attemptEvent, end] = events;
  assert.equal(attemptEvent.outcome, 'ok');
  assert.equal(start.api, 'anthropic-messages');
  assert.equal(start.sessionId, undefined, '未显式提供会话身份时原样透传 undefined，由记录层决定是否回退上下文');
  assert.equal(start.source, null);
  assert.equal(start.body.system, '你是主持人。');
  assert.equal(start.body.messages.filter(message => message.role === 'system').length, 0);
  assert.deepEqual(start.body.tools, [{ name: 'search_music', description: '搜歌', input_schema: TOOLS[0].function.parameters }]);
  assert.equal('apiKey' in start.body, false);

  assert.equal(end.text, '找到了');
  assert.equal(end.reasoning, '先确认用户想听什么');
  assert.equal(end.reasoningTokens, null);
  assert.deepEqual(end.toolCalls, [{ id: 'tu_9', type: 'function', function: { name: 'search_music', arguments: '{"query":"a"}' } }]);
});

test('观测钩子：google 思考片段进 reasoning，不混进可见正文', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { role: 'model', parts: [
        { thought: true, text: '内部推理：先理解点歌' },
        { text: '好' },
      ] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11, thoughtsTokenCount: 42 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1beta', apiKey: 'g-key', model: 'gemini-x', api: 'google-generative-ai' }),
  });
  const out = await llm.chat([{ role: 'user', content: '放首歌' }], null, { maxTokens: 50, temperature: 0.2 });
  assert.equal(out.message.content, '好', 'thought 片段不能混进可见正文');
  assert.equal(out.reasoning, '内部推理：先理解点歌');
  assert.equal(out.reasoningTokens, 42);
  const end = events.find(event => event.phase === 'end');
  assert.equal(end.reasoning, '内部推理：先理解点歌');
  assert.equal(end.reasoningTokens, 42);
  assert.equal(end.text, '好');
});

test('观测钩子：openai-responses 的 reasoning 摘要与推理 token', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: '想一下' }, { type: 'summary_text', text: '再选歌' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
      ],
      usage: { input_tokens: 6, output_tokens: 2, output_tokens_details: { reasoning_tokens: 30 } },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://r/v1', apiKey: 'r-key', model: 'gpt-x', api: 'openai-responses' }),
  });
  const out = await llm.chat([{ role: 'user', content: 'hi' }], null, { maxTokens: 64, temperature: 0.3 });
  assert.equal(out.reasoning, '想一下\n再选歌');
  assert.equal(out.reasoningTokens, 30);
  assert.equal(out.message.content, 'hi', 'reasoning 项不混进正文');
  const end = events.find(event => event.phase === 'end');
  assert.equal(end.reasoning, '想一下\n再选歌');
  assert.equal(end.reasoningTokens, 30);
});

test('观测钩子：openai-completions 捕获 reasoning_content 与推理 token；缺失时保持 null', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(callIndex => ({
    ok: true,
    json: async () => callIndex === 1
      ? {
          choices: [{ message: { role: 'assistant', content: '好的', reasoning_content: '思考中' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 12 } },
        }
      : { choices: [{ message: { role: 'assistant', content: '嗯' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const first = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(first.reasoning, '思考中');
  assert.equal(first.reasoningTokens, 12);
  const firstEnd = events.find(event => event.phase === 'end');
  assert.equal(firstEnd.reasoning, '思考中');
  assert.equal(firstEnd.reasoningTokens, 12);

  const second = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(second.reasoning, null, '供应商没返回思考 → null');
  assert.equal(second.reasoningTokens, null, '供应商没返回计数 → null，不写 0');
  const secondEnd = events.filter(event => event.phase === 'end')[1];
  assert.equal(secondEnd.reasoning, null);
  assert.equal(secondEnd.reasoningTokens, null);
  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'end', 'start', 'attempt', 'end']);
});

test('观测钩子异常/卸载绝不影响 chat', async t => {
  setLlmObserver(() => { throw new Error('observer exploded'); });
  t.after(() => setLlmObserver(null));
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: '正常' }, finish_reason: 'stop' }] }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const out = await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(out.message.content, '正常');

  const seen = [];
  setLlmObserver(event => seen.push(event.phase));
  await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(seen, ['start', 'attempt', 'end']);
  setLlmObserver(null);
  setLlmObserver('not-a-function');
  await llm.chat([{ role: 'user', content: 'hi' }]);
  assert.deepEqual(seen, ['start', 'attempt', 'end'], '卸载后不再收到事件');
});

test('观测钩子：失败路径 error 事件带失败码与状态，且不泄露凭据/URL', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 429, text: async () => 'rate limited: sk-leaked-inside-body' }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'https://gateway.example/v1', apiKey: 'sk-super-secret', model: 'm', api: 'openai-completions' }),
  });
  // failover:false：只观察单次请求（同端点重试另见 llmFailover 测试）。
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, { failover: false }),
    error => error?.code === 'LLM_API_ERROR' && error?.status === 429);

  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'error']);
  const [start, attemptEvent, errorEvent] = events;
  assert.equal(attemptEvent.outcome, 'provider_error', 'HTTP 失败也是一条实际尝试');
  assert.equal(attemptEvent.status, 429);
  assert.equal(errorEvent.errorCode, 'LLM_API_ERROR');
  assert.equal(errorEvent.status, 429);
  assert.ok(Number.isInteger(errorEvent.durationMs) && errorEvent.durationMs >= 0);
  assert.equal(errorEvent.model, 'm');
  assert.equal(errorEvent.api, 'openai-completions');
  assert.deepEqual(errorEvent.toolNames, []);
  const serialized = JSON.stringify(errorEvent);
  assert.doesNotMatch(serialized, /sk-super-secret|Bearer|gateway\.example|baseUrl|Authorization|headers/u);
  assert.equal(JSON.stringify(start).includes('sk-super-secret'), false);
  for (const key of ['url', 'headers', 'apiKey', 'baseUrl']) {
    assert.equal(Object.hasOwn(errorEvent, key), false, key);
  }
});

test('观测钩子：传输失败与取消同样发出 error，取消原因不被改写', async t => {
  const events = collectObserver(t);
  const llm = createLlm({
    fetchImpl: async () => { throw new TypeError('network unavailable'); },
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, { failover: false }),
    error => error?.code === 'LLM_API_ERROR');
  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'error']);
  assert.equal(events[1].outcome, 'provider_error', '失败请求同样是一条实际尝试（账本不漏账）');
  assert.equal(events[1].errorCode, 'LLM_API_ERROR');
  assert.equal(events[2].errorCode, 'LLM_API_ERROR');
  assert.equal(events[2].status, null);

  const controller = new AbortController();
  const cancelled = createLlm({
    fetchImpl: async () => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); },
    resolveEndpoint: async () => ({ baseUrl: 'http://g/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const before = events.length;
  await assert.rejects(() => cancelled.chat([{ role: 'user', content: 'hi' }], null, { signal: controller.signal }),
    error => error?.name === 'AbortError' && error?.code !== 'LLM_API_ERROR');
  assert.deepEqual(events.slice(before).map(event => event.phase), ['start', 'attempt', 'error']);
  assert.equal(events.at(-2).outcome, 'cancelled', '取消也是一条带分类的尝试记录');
  assert.notEqual(events.at(-1).errorCode, 'LLM_API_ERROR', '取消不是 LLM_API_ERROR；原始原因保留');
});

// ============================================================
// 传输契约（agent-budget-and-response-contract 任务 3.1–3.4）：
// 结果分类、有界升级、结构化优先、档案驱动的思考开关
// ============================================================

const okChoices = (content, finishReason = 'stop', extra = {}) => ({
  choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: finishReason }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

test('截断恢复：首次被截断 → 按 ×2 额度重试一次成功；两次尝试各留一条记录', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(callIndex => ({
    ok: true,
    json: async () => callIndex === 1
      ? okChoices('半截的回复', 'length', { reasoning_content: '思考吃满了额度' })
      : okChoices('完整的回复'),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const out = await llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'chat_dialogue' });

  assert.equal(out.message.content, '完整的回复');
  assert.equal(out.outcome, 'ok');
  assert.equal(out.truncated, false);
  assert.equal(out.attempt, 2);
  assert.equal(out.escalatedFrom, 3072, '对话任务 = 正文 2048 + 思考余量 1024');
  assert.deepEqual(out.budget, { requested: 2048, effective: 6144, allowance: 4096,
    taskId: 'chat_dialogue', overrideSources: [] });
  assert.deepEqual(fetchImpl.calls.map(call => call.body.max_tokens), [3072, 6144],
    '第二次尝试放大额度（受硬上限 8192 约束）');
  const attempts = events.filter(event => event.phase === 'attempt');
  assert.deepEqual(attempts.map(event => [event.attempt, event.outcome, event.budget.effective]),
    [[1, 'truncated', 3072], [2, 'ok', 6144]]);
  assert.equal(attempts[1].escalatedFrom, 3072);
  assert.equal(events.filter(event => event.phase === 'start').length, 1, 'start 只在首次尝试前发一次');
  assert.deepEqual(events.at(-1).outcome, 'ok');
});

test('只有思考：两次都不可用 → LLM_REASONING_ONLY，保留两次用量与分类', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: '一直在想' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 20, completion_tokens: 500, total_tokens: 520,
        completion_tokens_details: { reasoning_tokens: 500 } },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'song_tag' }),
    error => {
      assert.equal(error.code, 'LLM_REASONING_ONLY');
      assert.equal(error.outcome, 'reasoning_only');
      assert.equal(error.attempt, 2);
      assert.equal(error.reasoningTokens, 500);
      assert.equal(error.result?.message?.content, '');
      return true;
    });
  assert.equal(fetchImpl.calls.length, 2, '有界：升级一次后不再重试');
  const attempts = events.filter(event => event.phase === 'attempt');
  assert.deepEqual(attempts.map(event => event.outcome), ['reasoning_only', 'reasoning_only']);
  assert.deepEqual(attempts.map(event => event.budget.effective), [2524, 5048],
    '打标任务 = 1500 + 思考余量，升级 ×2');
  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'attempt', 'error']);
  assert.equal(events.at(-1).errorCode, 'LLM_REASONING_ONLY');
});

test('结构化不合法：invalid_json 同样走一次升级；仍不可用 → LLM_INVALID_JSON', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('抱歉，我无法完成。') }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' }),
    error => error?.code === 'LLM_INVALID_JSON' && error?.attempt === 2);
  assert.equal(fetchImpl.calls.length, 2);

  // 结构化结果合法时一次通过。
  const good = createLlm({
    fetchImpl: fakeFetch(() => ({ ok: true, json: async () => okChoices('{"mood":"calm"}') })),
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const out = await good.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' });
  assert.equal(out.outcome, 'ok');
  assert.equal(out.attempt, 1);
});

test('供应方错误不升级；取消原样传播且不升级', async () => {
  const failing = fakeFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
  const llmA = createLlm({
    fetchImpl: failing,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llmA.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'chat_dialogue', failover: false }),
    error => error?.code === 'LLM_API_ERROR');
  assert.equal(failing.calls.length, 1, 'provider_error 不触发升级重试（同端点重试由 failover 包装层负责，这里关闭）');

  const controller = new AbortController();
  const cancelled = fakeFetch(async () => { controller.abort(); throw new DOMException('cancelled', 'AbortError'); });
  const llmB = createLlm({
    fetchImpl: cancelled,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llmB.chat([{ role: 'user', content: 'hi' }], null,
    { taskId: 'chat_dialogue', signal: controller.signal }), error => error?.name === 'AbortError');
  assert.equal(cancelled.calls.length, 1, '取消不重试');
});

test('截断但工具调用完整可用：不升级、结果照常返回（下游 fail-closed 继续）', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_music', arguments: '{"query":"x"}' } }] },
        finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const out = await llm.chat([{ role: 'user', content: '搜歌' }], TOOLS, { taskId: 'chat_dialogue' });
  assert.equal(out.outcome, 'truncated');
  assert.equal(out.truncated, true);
  assert.equal(out.attempt, 1);
  assert.equal(out.message.tool_calls.length, 1, '完整可解析的工具调用不能因为截断被丢弃');
  assert.equal(fetchImpl.calls.length, 1, '可用结果不触发升级');
});

test('工具参数被截断（不可解析）：按截断升级，仍不可用 → LLM_TRUNCATED_CONTENT', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { role: 'assistant', content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_music', arguments: '{"query":"孙' } }] },
        finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 9, total_tokens: 12 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: '搜歌' }], TOOLS, { taskId: 'chat_dialogue' }),
    error => error?.code === 'LLM_TRUNCATED_CONTENT');
  assert.equal(fetchImpl.calls.length, 2);
});

test('原生结构化优先：档案声明 json_object → 携带 response_format 并标注 native', async t => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"mood":"calm"}') }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
      capability: { structuredOutput: 'json_object', source: 'probe' } }),
  });
  const out = await llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' });
  assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: 'json_object' });
  assert.equal(out.structuredMeans, 'native');

  const unknown = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"mood":"calm"}') }));
  const llmB = createLlm({
    fetchImpl: unknown,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const outB = await llmB.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' });
  assert.equal('response_format' in unknown.calls[0].body, false, '未知模型不假装原生结构化');
  assert.equal(outB.structuredMeans, 'text_extraction', '如实标注退回方式');
});

test('anthropic 强制工具结构化：structured_output 调用还原为正文 JSON', async () => {
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => ({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'structured_output', input: { mood: 'calm' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 9, output_tokens: 4 },
    }),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'claude-x', api: 'anthropic-messages',
      capability: { structuredOutput: 'tool_force', source: 'probe' } }),
  });
  const schema = { type: 'object', properties: { mood: { type: 'string' } }, required: ['mood'] };
  const out = await llm.chat([{ role: 'user', content: '打标' }], null,
    { taskId: 'song_tag', jsonSchema: schema, jsonSchemaName: 'structured_output' });
  const body = fetchImpl.calls[0].body;
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'structured_output' });
  assert.deepEqual(body.tools.at(-1).input_schema, schema);
  assert.equal(out.message.content, '{"mood":"calm"}');
  assert.equal(out.message.tool_calls, null, '结构化工具调用不外泄为普通工具调用');
  assert.equal(out.outcome, 'ok');
  assert.equal(out.structuredMeans, 'native');
});

test('思考开关按档案：helpful 任务丢弃关闭请求；wasteful + 可关才发送；未知不发厂商字段', async () => {
  const capable = {
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
      capability: { thinking: { canDisable: true }, source: 'probe' } }),
  };
  const fetchA = fakeFetch(() => ({ ok: true, json: async () => okChoices('好') }));
  const llmA = createLlm({ fetchImpl: fetchA, ...capable });
  await llmA.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'chat_dialogue', thinkingMode: 'disabled' });
  assert.equal('thinking' in fetchA.calls[0].body, false, '思考有帮助的任务不得携带关闭参数');
  assert.equal(fetchA.calls[0].body.max_tokens, 3072, '关闭请求被丢弃后仍保留思考余量');

  const fetchB = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"mood":"calm"}') }));
  const llmB = createLlm({ fetchImpl: fetchB, ...capable });
  await llmB.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag', thinkingMode: 'disabled' });
  assert.deepEqual(fetchB.calls[0].body.thinking, { type: 'disabled' });
  assert.equal(fetchB.calls[0].body.max_tokens, 1500, '关闭是成本选择：额度只给正文');

  const fetchC = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"mood":"calm"}') }));
  const llmC = createLlm({
    fetchImpl: fetchC,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await llmC.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag', thinkingMode: 'disabled' });
  assert.equal('thinking' in fetchC.calls[0].body, false, '没有观测接线时不冒然发送厂商私有参数');
  assert.equal(fetchC.calls[0].body.max_tokens, 2524, '未知按保守预留思考余量');

  // neutral 任务的显式关闭请求被尊重（协议兼容路径：要求 tool_choice 时必须关思考），
  // 但不会自动关闭，也不发送 effort 档位——旋钮只是成本选择，只用于 wasteful 任务。
  const fetchD = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const llmD = createLlm({ fetchImpl: fetchD, ...capable });
  await llmD.chat([{ role: 'user', content: '起草' }], null, { taskId: 'persona_generation', thinkingMode: 'disabled' });
  assert.deepEqual(fetchD.calls[0].body.thinking, { type: 'disabled' }, 'neutral 任务的显式关闭被尊重');
  const fetchE = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const llmE = createLlm({
    fetchImpl: fetchE,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
      capability: { thinking: { canDisable: false, budgetKnob: 'reasoning_effort' }, source: 'probe' } }),
  });
  await llmE.chat([{ role: 'user', content: '起草' }], null, { taskId: 'persona_generation' });
  assert.equal('reasoning_effort' in fetchE.calls[0].body, false, 'effort 档位只用于成本型（wasteful）任务');
});

test('任务规格读取与结果字段：显式 maxTokens 覆盖规格（e2e 语义）', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  const out = await llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'song_tag', maxTokens: 700 });
  assert.equal(fetchImpl.calls[0].body.max_tokens, 700);
  assert.equal(out.budget.requested, 700);
  assert.equal(out.budget.effective, 700);
  assert.deepEqual(out.budget.overrideSources, ['explicit:maxTokens']);
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'no_such_task' }),
    /unknown LLM task/);
});

test('日内预算守卫：超限在 fetch 之前显式拒绝，不升级、不发请求', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => { throw new Error('must not be called'); });
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  setLlmBudgetGuard(() => ({ ok: false, code: 'LLM_BUDGET_EXHAUSTED', taskId: 'song_tag', cap: 1000, used: 1200 }));
  t.after(() => setLlmBudgetGuard(null));

  await assert.rejects(() => llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' }),
    error => {
      assert.equal(error.code, 'LLM_BUDGET_EXHAUSTED');
      assert.equal(error.cap, 1000);
      assert.equal(error.used, 1200);
      assert.doesNotMatch(error.message, /http|key|Bearer/u, '拒绝文案不泄漏端点与凭据');
      return true;
    });
  assert.equal(fetchImpl.calls.length, 0, '拒绝发生在 fetch 之前');
  assert.deepEqual(events.map(event => event.phase), ['start', 'error']);
  assert.equal(events.at(-1).errorCode, 'LLM_BUDGET_EXHAUSTED');
});

test('日内预算守卫：放行时按次预留、请求结束必释放；升级重试各留一次', async () => {
  let releaseCalls = 0;
  const reserves = [];
  setLlmBudgetGuard(({ taskId, tokens }) => ({
    ok: true, reserved: tokens, taskId,
    release: () => { releaseCalls += 1; },
  }));
  try {
    const fetchImpl = fakeFetch(callIndex => ({
      ok: true,
      json: async () => (callIndex === 1
        ? { choices: [{ message: { role: 'assistant', content: '半截', reasoning_content: '思考' }, finish_reason: 'length' }], usage: null }
        : { choices: [{ message: { role: 'assistant', content: '完整' }, finish_reason: 'stop' }], usage: null }),
    }));
    const llm = createLlm({
      fetchImpl,
      resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
    });
    const out = await llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'chat_dialogue' });
    assert.equal(out.outcome, 'ok');
    assert.equal(releaseCalls, 2, '两次尝试各自预留并释放，绝不泄漏');
    assert.deepEqual(fetchImpl.calls.map(call => call.body.max_tokens), [3072, 6144]);
  } finally {
    setLlmBudgetGuard(null);
  }
});

// ============================================================
// 审查缺口修复（2026-10-16）：关闭参数回退、协议思考控制与工具选择、
// 结构化如实标注、空 JSON 恢复、探测记账
// ============================================================

test('关闭参数被拒：移除参数、恢复思考余量并上报负缓存（不再重发同一请求）', async t => {
  const events = collectObserver(t);
  const facts = [];
  setCapabilityObserver(fact => facts.push(fact));
  t.after(() => setCapabilityObserver(null));
  const fetchImpl = fakeFetch((_count, call) => call.body.thinking
    ? { ok: false, status: 400, text: async () => 'unsupported parameter: thinking' }
    : { ok: true, json: async () => okChoices('{"mood":"calm"}') });
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
      providerId: 'prov-1', capability: { thinking: { canDisable: true }, source: 'probe' } }),
  });
  const out = await llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag', thinkingMode: 'disabled' });
  assert.equal(out.outcome, 'ok', '回退后的请求正常返回');
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(fetchImpl.calls[0].body.thinking, { type: 'disabled' });
  assert.equal(fetchImpl.calls[0].body.max_tokens, 1500, '档案确认可关时额度只给正文');
  assert.equal('thinking' in fetchImpl.calls[1].body, false, '被拒后必须移除参数');
  assert.equal(fetchImpl.calls[1].body.max_tokens, 2524, '被拒后恢复思考余量，不再静默扣除');
  assert.deepEqual(facts, [{ providerId: 'prov-1', model: 'm', api: 'openai-completions',
    source: 'observed', thinking: { canDisable: false } }]);
  const attempts = events.filter(event => event.phase === 'attempt');
  assert.deepEqual(attempts.map(event => event.outcome), ['provider_error', 'ok'], '被拒的一次也是实际请求，如实记账');
});

test('关闭被无视（仍在思考）：恢复余量并把 canDisable 记为 false', async t => {
  const facts = [];
  setCapabilityObserver(fact => facts.push(fact));
  t.after(() => setCapabilityObserver(null));
  const fetchImpl = fakeFetch((_count, call) => ({
    ok: true,
    json: async () => call.body.thinking
      ? { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '还在想' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 5, completion_tokens: 1500, completion_tokens_details: { reasoning_tokens: 1400 } } }
      : okChoices('{"mood":"calm"}'),
  }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
      providerId: 'prov-2', capability: { thinking: { canDisable: true }, source: 'probe' } }),
  });
  const out = await llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag', thinkingMode: 'disabled' });
  assert.equal(out.outcome, 'ok');
  assert.equal('thinking' in fetchImpl.calls[1].body, false, '被无视同样不再发送');
  assert.deepEqual(fetchImpl.calls.map(call => call.body.max_tokens), [1500, 5048],
    '第二次按恢复后的保守基数升级（1500+1024）×2，受硬上限约束');
  assert.deepEqual(facts.at(-1).thinking, { canDisable: false });
});

test('思考预算旋钮与指定工具选择按协议发送', async () => {
  const payloadFor = api => {
    const text = '{"mood":"calm"}';
    if (api === 'anthropic-messages') return { content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 } };
    if (api === 'google-generative-ai') return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } };
    if (api === 'openai-responses') return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 3, output_tokens: 4 } };
    return okChoices(text);
  };
  const cases = [
    { api: 'openai-completions', url: 'http://gw/v1/chat/completions',
      capability: { thinking: { canDisable: false, budgetKnob: 'reasoning_effort' }, structuredOutput: 'none' } },
    { api: 'openai-responses', url: 'http://gw/v1/responses',
      capability: { thinking: { canDisable: false, budgetKnob: 'reasoning_effort' }, structuredOutput: 'none' } },
    { api: 'anthropic-messages', url: 'http://gw/v1/messages',
      capability: { thinking: { canDisable: false, budgetKnob: 'thinking_budget', budgetRange: [1024, 32768] }, structuredOutput: 'none' } },
    { api: 'google-generative-ai', url: 'http://gw/v1/models/m:generateContent',
      capability: { thinking: { canDisable: false, budgetKnob: 'thinking_budget', budgetRange: [0, 24576] }, structuredOutput: 'none' } },
  ];
  for (const entry of cases) {
    const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => payloadFor(entry.api) }));
    const llm = createLlm({
      fetchImpl,
      resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: entry.api, capability: entry.capability }),
    });
    const out = await llm.chat([{ role: 'user', content: '打标' }], TOOLS,
      { taskId: 'song_tag', thinkingMode: 'disabled', toolChoice: { type: 'function', function: { name: 'search_music' } } });
    assert.equal(fetchImpl.calls[0].url, entry.url, entry.api);
    assert.equal(out.outcome, 'ok', entry.api);
    const body = fetchImpl.calls[0].body;
    if (entry.api === 'openai-completions') {
      assert.equal(body.reasoning_effort, 'low', '成本选择发送 effort 档位');
      assert.equal('thinking' in body, false, '档案不可关就不发关闭字段');
      assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'search_music' } });
    }
    if (entry.api === 'openai-responses') {
      assert.deepEqual(body.reasoning, { effort: 'low' });
      assert.deepEqual(body.tool_choice, { type: 'function', name: 'search_music' }, '指定工具选择必须发送');
    }
    if (entry.api === 'anthropic-messages') {
      assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
      assert.equal(body.temperature, 1, '扩展思考要求 temperature=1');
      assert.deepEqual(body.tool_choice, { type: 'tool', name: 'search_music' });
    }
    if (entry.api === 'google-generative-ai') {
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 1024 });
      assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search_music'] } });
    }
  }
});

test('json_schema 档案但没有具体 schema：降级为真实 json_object 约束并如实标注', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"mood":"calm"}') }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
      capability: { structuredOutput: 'json_schema', thinking: { canDisable: false }, source: 'probe' } }),
  });
  const out = await llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' });
  assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: 'json_object' }, '发送真实可用的对象约束');
  assert.equal(out.structuredMeans, 'native', '标注与真实请求一致');
});

test('anthropic 有 tool_force 但没有 schema：如实退回文本抽取，不假装原生', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({
    content: [{ type: 'text', text: '{"mood":"calm"}' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 4 },
  }) }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'claude-x', api: 'anthropic-messages',
      capability: { structuredOutput: 'tool_force', thinking: { canDisable: false }, source: 'probe' } }),
  });
  const out = await llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' });
  assert.equal(out.structuredMeans, 'text_extraction');
  assert.equal('tool_choice' in fetchImpl.calls[0].body, false);
});

test('JSON 任务的空正文进入结构化恢复：仍为空 → LLM_INVALID_JSON', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('') }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag' }),
    error => error?.code === 'LLM_INVALID_JSON' && error?.attempt === 2 && error?.outcome === 'invalid_json');
  assert.equal(fetchImpl.calls.length, 2, '空正文不再当作 ok 直接返回');
});

test('隐藏思考模型：正文为空且达到上限、只有 reasoning token 也判“只有思考”', async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 5, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 880 } },
  }) }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'song_tag' }),
    error => error?.code === 'LLM_REASONING_ONLY');
});

test('探测调用同样经过日内守卫与记账：每次实际请求一条 attempt（探测不再漏账）', async t => {
  const events = collectObserver(t);
  const guardCalls = [];
  setLlmBudgetGuard(args => { guardCalls.push(args); return { ok: true, reserved: args.tokens, release: () => {} }; });
  t.after(() => setLlmBudgetGuard(null));
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const result = await rawChatAttempt({
    endpoint: { baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions', providerId: 'prov-1' },
    fetchImpl, probeKind: 'baseline', traceTaskId: 'prov-1:m:probe', maxTokens: 2048,
  });
  assert.equal(result.ok, true);
  assert.equal(guardCalls.length, 1);
  assert.equal(guardCalls[0].taskId, 'capability_probe');
  assert.equal(guardCalls[0].sessionId, null, '探测没有聊天归属，不伪造 sessionId');
  assert.ok(typeof guardCalls[0].attemptId === 'string' && guardCalls[0].attemptId.length > 0);
  const attempt = events.find(event => event.phase === 'attempt');
  assert.equal(attempt.taskId, 'capability_probe');
  assert.equal(attempt.taskType, 'capability_probe');
  assert.equal(attempt.traceTaskId, 'prov-1:m:probe');
  assert.equal(attempt.probeKind, 'baseline');
  assert.equal(attempt.outcome, 'ok');

  // 守卫拒绝：不发请求、不落 attempt（拒绝本身由守卫写 budget_rejected）。
  setLlmBudgetGuard(() => ({ ok: false, code: 'LLM_BUDGET_EXHAUSTED', cap: 1, used: 2 }));
  const before = events.length;
  const blocked = await rawChatAttempt({ endpoint: { baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }, fetchImpl });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'LLM_BUDGET_EXHAUSTED');
  assert.equal(fetchImpl.calls.length, 1, '被预算拒绝的探测不发请求');
  assert.equal(events.length, before, '没有实际请求就没有 attempt 事件');
});

test('探测失败同样是实际请求：provider_error 与失效响应都留 attempt 记录', async t => {
  const events = collectObserver(t);
  const failing = fakeFetch(() => ({ ok: false, status: 500, text: async () => 'boom' }));
  const failed = await rawChatAttempt({ endpoint: { baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }, fetchImpl: failing });
  assert.deepEqual([failed.ok, failed.status, failed.code], [false, 500, 'LLM_API_ERROR']);
  const broken = fakeFetch(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }));
  const invalid = await rawChatAttempt({ endpoint: { baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }, fetchImpl: broken });
  assert.deepEqual([invalid.ok, invalid.code], [false, 'LLM_INVALID_RESPONSE']);
  const attempts = events.filter(event => event.phase === 'attempt');
  assert.deepEqual(attempts.map(event => event.outcome), ['provider_error', 'provider_error']);
});

test('未知模型的关闭参数只尝试一次：被无视后负缓存生效，后续不再发送', async t => {
  let capability = null; // 注册表视角：观测之前没有档案
  setCapabilityObserver(fact => {
    if (fact?.providerId === 'prov-try' && fact?.thinking?.canDisable === false) {
      capability = { thinking: { canDisable: false }, source: 'observed' };
    }
  });
  t.after(() => setCapabilityObserver(null));
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({
    choices: [{ message: { role: 'assistant', content: '{"mood":"calm"}', reasoning_content: '想了想' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } },
  }) }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
      providerId: 'prov-try', capability }),
  });
  await llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag', thinkingMode: 'disabled' });
  assert.deepEqual(fetchImpl.calls[0].body.thinking, { type: 'disabled' }, '未知能力：尝试一次关闭参数');
  assert.equal(fetchImpl.calls[0].body.max_tokens, 2524, '尝试期间保持保守额度，不静默扣余量');
  assert.deepEqual(capability, { thinking: { canDisable: false }, source: 'observed' }, '被无视 → 负缓存');

  await llm.chat([{ role: 'user', content: '打标' }], null, { taskId: 'song_tag', thinkingMode: 'disabled' });
  assert.equal('thinking' in fetchImpl.calls[1].body, false, '负缓存之后不再发送');
  assert.equal(fetchImpl.calls[1].body.max_tokens, 2524);
});

test('供应方错误正文只作内部属性，不进错误 message（不泄露到日志/设置页）', async t => {
  const secret = 'sk-should-not-appear';
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, text: async () => `bad request body: {"messages":[{"content":"${secret}"}]}` }));
  const llm = createLlm({
    fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }]), error => {
    assert.equal(error.code, 'LLM_API_ERROR');
    assert.equal(error.status, 400);
    assert.doesNotMatch(error.message, /sk-should-not-appear|messages/, 'message 不含供应商正文');
    assert.match(String(error.detail), /bad request body/, 'detail 仅作内部诊断属性');
    return true;
  });
});

test('供应方错误正文脱敏截断后只随 error 观测事件交给私有 trace（providerDetail）', async t => {
  const events = collectObserver(t);
  const body = `{"error":"messages must not end with assistant","auth":"Bearer sk-abc123secret","url":"https://x.test/v1?api_key=k1&token=t2"}${'x'.repeat(400)}`;
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, text: async () => body }));
  const llm = createLlm({ fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }) });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, { sessionId: 's1' }));
  const error = events.find(event => event.phase === 'error');
  assert.match(error.providerDetail, /must not end with assistant/);
  assert.doesNotMatch(error.providerDetail, /sk-abc123secret|api_key=k1|token=t2/);
  assert.ok(error.providerDetail.length <= 300);
});

test('traceContent=false 时 error 观测不带 providerDetail', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, text: async () => 'bad: echoed private text' }));
  const llm = createLlm({ fetchImpl,
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' }) });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, { traceContent: false }));
  assert.equal(events.find(event => event.phase === 'error').providerDetail, null);
});

test('选歌与串词按 light 档发送较低思考量，但永不关闭思考；对话轮保持模型默认', async () => {
  const endpoint = capability => async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions', capability });
  for (const taskId of ['music_selection', 'narration']) {
    const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
    const llm = createLlm({ fetchImpl,
      resolveEndpoint: endpoint({ thinking: { canDisable: false, budgetKnob: 'reasoning_effort' }, source: 'probe' }) });
    await llm.chat([{ role: 'user', content: '选' }], null, { taskId });
    assert.equal(fetchImpl.calls[0].body.reasoning_effort, 'low', taskId);
    const disableFetch = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
    const disableLlm = createLlm({ fetchImpl: disableFetch,
      resolveEndpoint: endpoint({ thinking: { canDisable: true }, source: 'probe' }) });
    await disableLlm.chat([{ role: 'user', content: '选' }], null, { taskId, thinkingMode: 'disabled' });
    assert.equal('thinking' in disableFetch.calls[0].body, false, `${taskId} 不关闭思考`);
  }
  const fetchChat = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const llmChat = createLlm({ fetchImpl: fetchChat,
    resolveEndpoint: endpoint({ thinking: { canDisable: false, budgetKnob: 'reasoning_effort' }, source: 'probe' }) });
  await llmChat.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue' });
  assert.equal('reasoning_effort' in fetchChat.calls[0].body, false);
});

// ============================================================
// 思考档位（add-reasoning-effort-controls 任务 3.1/3.2）：
// 声明夹紧、用户偏好优先、thinking budget 映射、reasoning_only 降档
// ============================================================

const effortEndpoint = (capability, extra = {}) => async () => ({
  baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions',
  capability: capability ?? { thinking: { canDisable: false, budgetKnob: 'reasoning_effort' }, source: 'probe' },
  ...extra,
});

test('思考档位：声明档位被发送，端点生效档位优先于 helpful 任务默认', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('好') }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEffort: 'low', reasoningEfforts: ['low', 'high', 'max'],
  }) });
  await llm.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue' });
  assert.equal(fetchImpl.calls[0].body.reasoning_effort, 'low', '聊天任务默认不发档位，但用户/端点偏好要生效');
  const start = events.find(event => event.phase === 'start');
  assert.equal(start.reasoningEffort, 'low');
  assert.equal(start.effortSkipped, undefined, '发送成功就不应该记录跳过原因');

  // 显式请求参数优先于端点解析出的档位。
  const explicit = fakeFetch(() => ({ ok: true, json: async () => okChoices('好') }));
  const llmExplicit = createLlm({ fetchImpl: explicit, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEffort: 'low', reasoningEfforts: ['low', 'high', 'max'],
  }) });
  await llmExplicit.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue', reasoningEffort: 'high' });
  assert.equal(explicit.calls[0].body.reasoning_effort, 'high', 'options.reasoningEffort > endpoint.reasoningEffort');
});

test('思考档位：未声明的档位不发送，observation 记录 effortSkipped 且调用不失败', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('好') }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEffort: 'high', reasoningEfforts: ['low'],
  }) });
  const out = await llm.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue' });
  assert.equal(out.outcome, 'ok', '档位发送不了不是调用失败');
  assert.equal('reasoning_effort' in fetchImpl.calls[0].body, false);
  for (const phase of ['start', 'attempt', 'end']) {
    const event = events.find(item => item.phase === phase);
    assert.equal(event.reasoningEffort, null, phase);
    assert.equal(event.effortSkipped, 'level_not_declared', phase);
  }
});

test('思考档位：没有偏好时 light/wasteful 仍走 low，但只有可发送时才发', async () => {
  const declaredFetch = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const declared = createLlm({ fetchImpl: declaredFetch, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEfforts: ['low', 'high', 'max'],
  }) });
  await declared.chat([{ role: 'user', content: '选' }], null, { taskId: 'music_selection' });
  assert.equal(declaredFetch.calls[0].body.reasoning_effort, 'low', 'light 任务默认档位保持不变');

  const undeclaredLow = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const blocked = createLlm({ fetchImpl: undeclaredLow, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEfforts: ['high', 'max'],
  }) });
  await blocked.chat([{ role: 'user', content: '选' }], null, { taskId: 'music_selection' });
  assert.equal('reasoning_effort' in undeclaredLow.calls[0].body, false, 'low 未被声明时不能凭任务默认硬发');

  const unknownFetch = fakeFetch(() => ({ ok: true, json: async () => okChoices('{"ok":true}') }));
  const unknown = createLlm({ fetchImpl: unknownFetch, resolveEndpoint: async () => ({
    baseUrl: 'http://gw/v1', apiKey: 'k', model: 'agent-model', api: 'openai-completions',
  }) });
  await unknown.chat([{ role: 'user', content: '选' }], null, { taskId: 'music_selection' });
  assert.equal('reasoning_effort' in unknownFetch.calls[0].body, false, '无旋钮无声明保持 fail-closed');
  assert.equal('thinking' in unknownFetch.calls[0].body, false);
});

test('思考档位：thinking_budget 档位映射为 token 预算并按区间/输出上限夹紧', async t => {
  const anthropicPayload = { content: [{ type: 'text', text: '{"mood":"calm"}' }], stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 4 } };
  const run = async (level, { range = [1024, 2048], maxTokens = 4000 } = {}) => {
    const events = [];
    setLlmObserver(event => events.push(event));
    try {
      const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => anthropicPayload }));
      const llm = createLlm({ fetchImpl, resolveEndpoint: async () => ({
        baseUrl: 'http://gw/v1', apiKey: 'k', model: 'claude-x', api: 'anthropic-messages',
        capability: { thinking: { canDisable: false, budgetKnob: 'thinking_budget', budgetRange: range }, source: 'probe' },
      }) });
      await llm.chat([{ role: 'user', content: '打标' }], null,
        { taskId: 'song_tag', reasoningEffort: level, maxTokens });
      return { body: fetchImpl.calls[0].body, events };
    } finally {
      setLlmObserver(null);
    }
  };

  const low = await run('low');
  assert.equal(low.body.thinking.budget_tokens, 1024);
  assert.equal(low.body.temperature, 1, '扩展思考要求 temperature=1');
  assert.equal(low.events.find(event => event.phase === 'start').reasoningEffort, 'low');

  const medium = await run('medium');
  assert.equal(medium.body.thinking.budget_tokens, 1536, 'medium = 区间中值向下取整');
  const high = await run('high');
  assert.equal(high.body.thinking.budget_tokens, 2048, 'high = 区间上界');

  // 区间上界超过输出上限时如实夹紧到 max_tokens-1（anthropic 要求 budget_tokens < max_tokens）。
  const clamped = await run('high', { range: [1024, 20000], maxTokens: 3000 });
  assert.equal(clamped.body.thinking.budget_tokens, 2999);
  assert.ok(clamped.body.thinking.budget_tokens < clamped.body.max_tokens);

  // none 且未证实可关：用区间下界，而不是假装关闭。
  const none = await run('none');
  assert.equal(none.body.thinking.budget_tokens, 1024);
  assert.equal(none.events.find(event => event.phase === 'start').reasoningEffort, 'none');
});

test('思考档位：none 且能力证实可关时走关闭通道，不发送档位枚举', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => okChoices('好') }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: effortEndpoint(
    { thinking: { canDisable: true, budgetKnob: 'reasoning_effort' }, source: 'probe' },
    { reasoningEfforts: ['low', 'high'], reasoningEffort: 'none' },
  ) });
  await llm.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue' });
  const body = fetchImpl.calls[0].body;
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal('reasoning_effort' in body, false);
  const start = events.find(event => event.phase === 'start');
  assert.equal(start.reasoningEffort, 'none', '关闭也是 “none” 档位的真实表达');
  assert.equal(start.thinkingMode, 'disabled');
  assert.equal(start.effortSkipped, undefined);
});

test('reasoning_only：第二次尝试降档且 max_tokens 不提高', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(callIndex => ({
    ok: true,
    json: async () => callIndex === 1
      ? { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '想太多' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 2900 } } }
      : okChoices('想好了'),
  }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEfforts: ['low', 'high', 'max'], reasoningEffort: 'high',
  }) });
  const out = await llm.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue' });
  assert.equal(out.outcome, 'ok');
  assert.deepEqual(fetchImpl.calls.map(call => call.body.reasoning_effort), ['high', 'low'],
    '只从声明档位里降一档（high → low，medium 未声明）');
  assert.deepEqual(fetchImpl.calls.map(call => call.body.max_tokens), [3072, 3072],
    'reasoning_only 不放大输出额度');
  const attempts = events.filter(event => event.phase === 'attempt');
  assert.deepEqual(attempts.map(event => event.reasoningEffort), ['high', 'low']);
  assert.deepEqual(attempts.map(event => event.budget.effective), [3072, 3072]);
});

test('reasoning_only：已是可发送最低档时保持档位且仍不放大额度', async () => {
  const fetchImpl = fakeFetch(callIndex => ({
    ok: true,
    json: async () => callIndex === 1
      ? { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '还在想' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 3000 } }
      : okChoices('想好了'),
  }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEfforts: ['low', 'high'], reasoningEffort: 'low',
  }) });
  await llm.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue' });
  assert.deepEqual(fetchImpl.calls.map(call => call.body.reasoning_effort), ['low', 'low']);
  assert.deepEqual(fetchImpl.calls.map(call => call.body.max_tokens), [3072, 3072]);
});

test('truncated：升级阶梯不变，思考档位不被强制改变', async () => {
  const fetchImpl = fakeFetch(callIndex => ({
    ok: true,
    json: async () => (callIndex === 1 ? okChoices('半截', 'length') : okChoices('完整')),
  }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: effortEndpoint(undefined, {
    reasoningEfforts: ['low', 'high'], reasoningEffort: 'high',
  }) });
  const out = await llm.chat([{ role: 'user', content: '聊' }], null, { taskId: 'chat_dialogue' });
  assert.equal(out.message.content, '完整');
  assert.deepEqual(fetchImpl.calls.map(call => call.body.reasoning_effort), ['high', 'high']);
  assert.deepEqual(fetchImpl.calls.map(call => call.body.max_tokens), [3072, 6144], '截断仍按既有阶梯翻倍');
});

// ============================================================
// 可选流式传输（add-streaming-transport-eval 任务 1.1 / 2.1）：
// 仅 openai-completions + 显式 options.stream === true 走 SSE；
// 结果形状、错误分类与观测语义与非流式一致。
// ============================================================

const streamEncoder = new TextEncoder();

/** 把 chunk 对象/原始 data 字符串编成 SSE 文本（每个事件以空行分隔）。 */
function sseText(events) {
  return events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
}

/**
 * web ReadableStream 构造的 fake SSE 响应。
 * chunkSize > 0 时按字节切分 enqueue（验证 TextDecoder 的流式解码与跨块行缓冲）。
 */
function sseResponse(events, { chunkSize = 0 } = {}) {
  const bytes = streamEncoder.encode(sseText(events));
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        if (!chunkSize) controller.enqueue(bytes);
        else {
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            controller.enqueue(bytes.slice(offset, offset + chunkSize));
          }
        }
        controller.close();
      },
    }),
    json: async () => { throw new Error('stream response must not use response.json()'); },
    text: async () => '',
  };
}

const streamEndpoint = async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api: 'openai-completions' });

test('流式正文：多 delta 拼接、streamed/ttftMs、usage 结算与 start/attempt/end 观测', async t => {
  const events = collectObserver(t);
  const settles = [];
  const fetchImpl = fakeFetch(() => sseResponse([
    { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] },
    { choices: [{ index: 0, delta: { content: '晚上' } }] },
    { choices: [{ index: 0, delta: { content: '好呀' } }] },
    { choices: [{ index: 0, delta: { content: '。' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 } },
    '[DONE]',
  ], { chunkSize: 7 }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: streamEndpoint });
  const out = await llm.chat([{ role: 'user', content: 'hi' }], null, {
    taskId: 'chat_dialogue', stream: true,
    budget: { reserve: () => ({ settle: usage => settles.push(usage) }) },
  });

  const call = fetchImpl.calls[0];
  assert.equal(call.body.stream, true, '显式 stream 才请求 SSE');
  assert.deepEqual(call.body.stream_options, { include_usage: true });
  assert.equal(out.message.content, '晚上好呀。', '正文 delta 按序拼接');
  assert.equal(out.finishReason, 'stop');
  assert.equal(out.streamed, true);
  assert.ok(Number.isFinite(out.ttftMs) && out.ttftMs >= 0, 'ttftMs 是数字语义');
  assert.deepEqual(out.usage, { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 });
  assert.deepEqual(settles, [out.usage], '账本按流式返回的真实 usage 结算');

  const start = events.find(event => event.phase === 'start');
  assert.equal(start.streamed, true);
  assert.equal(start.ttftMs, null, 'start 在请求发出前，首字时间尚不可知');
  assert.equal(start.body.stream, true, 'start 记录的 body 与实际请求一致');
  const attempt = events.find(event => event.phase === 'attempt');
  assert.equal(attempt.streamed, true);
  assert.ok(Number.isFinite(attempt.ttftMs) && attempt.ttftMs >= 0);
  const end = events.find(event => event.phase === 'end');
  assert.equal(end.streamed, true);
  assert.equal(end.ttftMs, out.ttftMs);
  assert.equal(end.text, '晚上好呀。');
});

test('流式 tool_calls：按 index 累积 id/name/arguments 片段；缺 index 归 0、无 id 不伪造', async () => {
  const args = ['{"query":', '"孙燕姿"}'];
  const fetchImpl = fakeFetch(() => sseResponse([
    {
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: '',
          tool_calls: [{ index: 0, id: 'call_stream_1', type: 'function', function: { name: 'search_music', arguments: '' } }],
        },
      }],
    },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args[0] } }] } }] },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: args[1] } }] },
        finish_reason: 'tool_calls',
      }],
    },
    '[DONE]',
  ]));
  const llm = createLlm({ fetchImpl, resolveEndpoint: streamEndpoint });
  const out = await llm.chat([{ role: 'user', content: '放首歌' }], TOOLS, { taskId: 'chat_dialogue', stream: true });
  assert.deepEqual(out.message.tool_calls, [{
    id: 'call_stream_1', type: 'function',
    function: { name: 'search_music', arguments: '{"query":"孙燕姿"}' },
  }]);
  assert.equal(out.finishReason, 'tool_calls');
  assert.equal(out.outcome, 'ok', '工具循环不需要区分流式与非流式');

  // 缺失 index 用 0；没有 id 的片段不伪造 id。
  const noIndex = fakeFetch(() => sseResponse([
    { choices: [{ index: 0, delta: { tool_calls: [{ function: { name: 'no_id_tool', arguments: '{"a":1}' } }] },
      finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]));
  const llmNoIndex = createLlm({ fetchImpl: noIndex, resolveEndpoint: streamEndpoint });
  const outNoIndex = await llmNoIndex.chat([{ role: 'user', content: '放首歌' }], TOOLS,
    { taskId: 'chat_dialogue', stream: true });
  assert.deepEqual(outNoIndex.message.tool_calls, [{
    type: 'function', function: { name: 'no_id_tool', arguments: '{"a":1}' },
  }]);
  assert.equal('id' in outNoIndex.message.tool_calls[0], false, '没有 id 就不伪造');
});

test('流式思考与 usage：reasoning delta 累积；网关不返回 usage 时保持 null', async t => {
  const events = collectObserver(t);
  const withUsage = createLlm({
    fetchImpl: fakeFetch(() => sseResponse([
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先确认用户' } }] },
      { choices: [{ index: 0, delta: { reasoning_content: '想听什么' } }] },
      { choices: [{ index: 0, delta: { content: '找到了' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
        completion_tokens_details: { reasoning_tokens: 5 } } },
      '[DONE]',
    ])),
    resolveEndpoint: streamEndpoint,
  });
  const out = await withUsage.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'chat_dialogue', stream: true });
  assert.equal(out.reasoning, '先确认用户想听什么', '思考增量不进可见正文');
  assert.equal(out.message.content, '找到了');
  assert.equal(out.reasoningTokens, 5, 'usage 里的推理 token 可读');
  assert.deepEqual(out.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18,
    completion_tokens_details: { reasoning_tokens: 5 } });
  const withUsageEnd = events.find(event => event.phase === 'end');
  assert.equal(withUsageEnd.reasoningTokens, 5);

  const noUsage = createLlm({
    fetchImpl: fakeFetch(() => sseResponse([
      { choices: [{ index: 0, delta: { content: '没有用量' }, finish_reason: 'stop' }] },
      '[DONE]',
    ])),
    resolveEndpoint: streamEndpoint,
  });
  const outNoUsage = await noUsage.chat([{ role: 'user', content: 'hi' }], null,
    { taskId: 'chat_dialogue', stream: true });
  assert.equal(outNoUsage.usage, null, '网关不返回 usage 时保持 null，不写 0');
  assert.equal(outNoUsage.reasoningTokens, null);
  assert.equal(outNoUsage.streamed, true);
});

test('stream 未设置：请求体不含 stream 字段，仍走 response.json() 且不伪造流式字段', async () => {
  let jsonCalls = 0;
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    json: async () => { jsonCalls += 1; return okChoices('普通回复'); },
  }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: streamEndpoint });
  const out = await llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'chat_dialogue' });
  const body = fetchImpl.calls[0].body;
  assert.equal('stream' in body, false);
  assert.equal('stream_options' in body, false);
  assert.equal(jsonCalls, 1, '默认路径仍是 response.json()');
  assert.equal(out.message.content, '普通回复');
  assert.equal(out.streamed, undefined, '非流式不设置 streamed');
  assert.equal(out.ttftMs, undefined, '非流式不伪造 ttftMs');
});

test('stream: true 只对 openai-completions 生效：其它协议忽略选项走非流式', async () => {
  const cases = [
    ['anthropic-messages', { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 } }],
    ['google-generative-ai', { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] },
      finishReason: 'STOP' }] }],
    ['openai-responses', { status: 'completed', output: [{ type: 'message',
      content: [{ type: 'output_text', text: 'ok' }] }] }],
  ];
  for (const [api, payload] of cases) {
    let jsonCalls = 0;
    const fetchImpl = fakeFetch(() => ({
      ok: true,
      json: async () => { jsonCalls += 1; return payload; },
    }));
    const llm = createLlm({
      fetchImpl,
      resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', apiKey: 'k', model: 'm', api }),
    });
    const out = await llm.chat([{ role: 'user', content: 'hi' }], null, { taskId: 'chat_dialogue', stream: true });
    assert.equal(jsonCalls, 1, `${api} 仍走 response.json()`);
    assert.equal('stream' in fetchImpl.calls[0].body, false, `${api} 请求体不带 stream`);
    assert.equal('stream_options' in fetchImpl.calls[0].body, false, `${api} 请求体不带 stream_options`);
    assert.notEqual(out.streamed, true, `${api} 不标记为已流式`);
    assert.equal(out.ttftMs, undefined, `${api} 不伪造首字时间`);
    assert.equal(out.outcome, 'ok', api);
  }
});

test('流式 HTTP 错误：与既有传输失败同分类，不静默回退 stream_options', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => ({ ok: false, status: 400, text: async () => 'stream_options unsupported' }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: streamEndpoint });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null,
    { taskId: 'chat_dialogue', stream: true }),
  error => error?.code === 'LLM_API_ERROR' && error?.status === 400);
  assert.equal(fetchImpl.calls.length, 1, '被拒就如实上抛，不静默重发两种行为');
  assert.equal(fetchImpl.calls[0].body.stream, true);
  assert.deepEqual(fetchImpl.calls[0].body.stream_options, { include_usage: true });
  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'error']);
  assert.equal(events[1].outcome, 'provider_error');
  assert.equal(events[2].errorCode, 'LLM_API_ERROR');
  assert.equal(events[2].streamed, true);
  assert.equal(events[2].ttftMs, null, '失败时首字时间允许为 null');
});

test('流式中断：读取失败按传输/失效响应分类，预留不按零成本结算', async t => {
  const events = collectObserver(t);
  const settles = [];
  const fetchImpl = fakeFetch(() => {
    let reads = 0;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        pull(controller) {
          reads += 1;
          if (reads === 1) {
            controller.enqueue(streamEncoder.encode('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n'));
          } else {
            controller.error(new TypeError('socket closed'));
          }
        },
      }),
      json: async () => { throw new Error('stream response must not use response.json()'); },
      text: async () => '',
    };
  });
  const llm = createLlm({ fetchImpl, resolveEndpoint: streamEndpoint });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null, {
    taskId: 'chat_dialogue', stream: true,
    budget: { reserve: () => ({ settle: usage => settles.push(usage) }) },
  }), error => error?.code === 'LLM_API_ERROR');
  assert.deepEqual(settles, [null], '读取失败保留预留（不是零成本）');
  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'error']);
  assert.equal(events[1].outcome, 'provider_error', '失败请求同样留下一次尝试记录');

  // 网关忽略 stream 直接回普通 JSON（没有 data: 事件）：与 response.json() 失败同等归类。
  const notSse = fakeFetch(() => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(streamEncoder.encode(JSON.stringify(okChoices('普通 JSON'))));
        controller.close();
      },
    }),
    json: async () => { throw new Error('stream response must not use response.json()'); },
    text: async () => '',
  }));
  const llmNotSse = createLlm({ fetchImpl: notSse, resolveEndpoint: streamEndpoint });
  await assert.rejects(() => llmNotSse.chat([{ role: 'user', content: 'hi' }], null,
    { taskId: 'chat_dialogue', stream: true }), error => error?.code === 'LLM_INVALID_RESPONSE');
});

test('流式取消：AbortError 原样上抛，不降级为 LLM_API_ERROR', async t => {
  const events = collectObserver(t);
  const controller = new AbortController();
  const fetchImpl = fakeFetch(() => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      pull(streamController) {
        if (!controller.signal.aborted) controller.abort();
        streamController.error(new DOMException('cancelled', 'AbortError'));
      },
    }),
    json: async () => { throw new Error('stream response must not use response.json()'); },
    text: async () => '',
  }));
  const llm = createLlm({ fetchImpl, resolveEndpoint: streamEndpoint });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'hi' }], null,
    { taskId: 'chat_dialogue', stream: true, signal: controller.signal }),
  error => error?.name === 'AbortError' && error?.code !== 'LLM_API_ERROR');
  assert.deepEqual(events.map(event => event.phase), ['start', 'attempt', 'error']);
  assert.equal(events[1].outcome, 'cancelled');
  assert.notEqual(events[2].errorCode, 'LLM_API_ERROR', '取消不是供应方错误');
});

test('只有思考的流交给既有 classifyOutcome：不抛流式特例错误', async t => {
  const events = collectObserver(t);
  const fetchImpl = fakeFetch(() => sseResponse([
    { choices: [{ index: 0, delta: { reasoning_content: '一直在想' }, finish_reason: 'length' }] },
    '[DONE]',
  ]));
  const llm = createLlm({ fetchImpl, resolveEndpoint: streamEndpoint });
  await assert.rejects(() => llm.chat([{ role: 'user', content: '打标' }], null,
    { taskId: 'song_tag', stream: true }), error => {
    assert.equal(error?.code, 'LLM_REASONING_ONLY', '仍按既有结果分类处理');
    assert.equal(error?.attempt, 2);
    assert.equal(error?.result?.streamed, true);
    assert.equal(error?.result?.ttftMs, null, '没有正文 delta 时首字时间为 null');
    return true;
  });
  assert.equal(fetchImpl.calls.length, 2, '既有升级阶梯不变');
  const attempts = events.filter(event => event.phase === 'attempt');
  assert.deepEqual(attempts.map(event => event.outcome), ['reasoning_only', 'reasoning_only']);
  assert.equal(attempts[0].streamed, true);
});
