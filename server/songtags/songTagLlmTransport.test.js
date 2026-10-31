// songTagLlmTransport.test.js — 打标 LLM 跟随"使用中"模型的薄封装。
//
// 覆盖：
//   - 机械 JSON 调用显式关思考（thinkingMode='disabled'）、预算 1500、低温、显式无主 sessionId
//   - 复现线上故障：finishReason=length + reasoning 吃满 + 空正文 → 可诊断 code，且有界重试
//   - 失败分类（TRUNCATED / EMPTY_CONTENT / INVALID_JSON）与"未配置不重试"
//   - SONG_TAG_MAX_TOKENS / SONG_TAG_MAX_ATTEMPTS env 覆盖
//   - 端到端归属：后台打标（显式 null）不写进聊天 JSONL，前台调用仍归属该会话（真实 llm.js 适配器）

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTaggingLlm, SongTagLlmError,
  SONG_TAG_LLM_FAILURE, SONG_TAG_DEFAULT_MAX_TOKENS, SONG_TAG_DEFAULT_MAX_ATTEMPTS,
  songTagMaxTokens, songTagMaxAttempts,
} from './songTagGenerator.js';
import { createLlm, setLlmObserver } from '../llm.js';
import { createSessionTrace } from '../sessionTrace.js';

test('tagging LLM 走注入的 chat（使用中模型）：任务规格、低温、关思考成本选择、显式无主', async () => {
  const calls = [];
  const chat = async (messages, tools, options) => {
    calls.push({ messages, tools, options });
    return { message: { role: 'assistant', content: '{"mood":"calm"}' }, finishReason: 'stop' };
  };
  const llm = createTaggingLlm({ chat });
  const out = await llm('prompt');
  assert.equal(out, '{"mood":"calm"}');
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'prompt' }]);
  assert.equal(calls[0].tools, null);
  assert.equal(calls[0].options.taskId, 'song_tag', '预算/超时/升级阶梯的唯一数字来源是任务规格');
  assert.equal(calls[0].options.maxTokens, undefined, '本层不再自带预算数字');
  assert.equal(calls[0].options.timeoutMs, undefined, '超时同样由规格决定（SONG_TAG_TIMEOUT_MS 为覆盖层）');
  assert.equal(calls[0].options.temperature, 0.3);
  assert.equal(calls[0].options.thinkingMode, 'disabled', '机械 JSON 任务是成本选择：请求关思考');
  assert.equal(calls[0].options.sessionId, null, '后台打标显式声明无归属');
  assert.equal(calls.length, 1, '成功路径不重试');
});

test('复现线上故障：finishReason=length、reasoning 吃满 500、正文为空 → 有界重试后抛 SONG_TAG_LLM_TRUNCATED', async () => {
  let calls = 0;
  const sleeps = [];
  // 与事故现场同形：思考模型把全部 completion 预算花在 reasoning 上，正文为空。
  const chat = async () => {
    calls += 1;
    return {
      message: { role: 'assistant', content: '', tool_calls: null },
      finishReason: 'length',
      usage: { prompt_tokens: 900, completion_tokens: 500, total_tokens: 1400,
        completion_tokens_details: { reasoning_tokens: 500 } },
      reasoning: '一直在思考，没写成 JSON',
      reasoningTokens: 500,
    };
  };
  const llm = createTaggingLlm({ chat, sleep: async ms => { sleeps.push(ms); } });

  await assert.rejects(() => llm('p'), error => {
    assert.ok(error instanceof SongTagLlmError, '抛的是带 code 的 SongTagLlmError，不是无声 null');
    assert.equal(error.code, SONG_TAG_LLM_FAILURE.TRUNCATED);
    assert.equal(error.finishReason, 'length');
    assert.equal(error.reasoningTokens, 500);
    assert.equal(error.attempts, 2);
    return true;
  });
  assert.equal(calls, 2, '有界：默认最多 2 次，绝不死循环');
  assert.deepEqual(sleeps, [250], '重试之间有退避');
});

test('失败分类：空正文 / 非 JSON 正文都是可诊断 code，且同样有界', async () => {
  let emptyCalls = 0;
  const empty = createTaggingLlm({
    chat: async () => { emptyCalls += 1; return { message: { content: '' }, finishReason: 'stop' }; },
    sleep: async () => {},
  });
  await assert.rejects(() => empty('p'), error => {
    assert.equal(error.code, SONG_TAG_LLM_FAILURE.EMPTY_CONTENT);
    return true;
  });
  assert.equal(emptyCalls, 2);

  let proseCalls = 0;
  const prose = createTaggingLlm({
    chat: async () => { proseCalls += 1; return { message: { content: '抱歉，我无法完成这个请求。' }, finishReason: 'stop' }; },
    sleep: async () => {},
  });
  await assert.rejects(() => prose('p'), error => {
    assert.equal(error.code, SONG_TAG_LLM_FAILURE.INVALID_JSON);
    return true;
  });
  assert.equal(proseCalls, 2);
});

test('finishReason=length 即便正文看起来可解析也不采信（半截 JSON 不落库）', async () => {
  const llm = createTaggingLlm({
    chat: async () => ({ message: { content: '{"mood":"calm"}' }, finishReason: 'length' }),
    sleep: async () => {},
  });
  await assert.rejects(() => llm('p'), error => {
    assert.equal(error.code, SONG_TAG_LLM_FAILURE.TRUNCATED);
    return true;
  });
});

test('未配置模型不重试：一次调用后原样上抛（上层写占位，不发第二次请求）', async () => {
  let calls = 0;
  const notConfigured = new Error('请先在设置里接入模型');
  notConfigured.code = 'LLM_NOT_CONFIGURED';
  const llm = createTaggingLlm({
    chat: async () => { calls += 1; throw notConfigured; },
    sleep: async () => { throw new Error('不应退避重试'); },
  });
  await assert.rejects(() => llm('p'), error => error.code === 'LLM_NOT_CONFIGURED');
  assert.equal(calls, 1);
});

test('重试上限降为 1 次：一次性失败不再发第二次请求（SONG_TAG_MAX_ATTEMPTS 语义）', async () => {
  const previous = process.env.SONG_TAG_MAX_ATTEMPTS;
  process.env.SONG_TAG_MAX_ATTEMPTS = '1';
  try {
    let calls = 0;
    const llm = createTaggingLlm({
      chat: async () => { calls += 1; return { message: { content: '' }, finishReason: 'length' }; },
      sleep: async () => {},
    });
    await assert.rejects(() => llm('p'), error => error.code === SONG_TAG_LLM_FAILURE.TRUNCATED);
    assert.equal(calls, 1, '上限 1 = 只打一次，失败交给占位 TTL 退避');
  } finally {
    if (previous === undefined) delete process.env.SONG_TAG_MAX_ATTEMPTS;
    else process.env.SONG_TAG_MAX_ATTEMPTS = previous;
  }
});

test('预算与重试上限走 env 且坏值回落默认（预算数字归属 llmTasks，见 llmTasks.test.js）', async () => {
  assert.equal(songTagMaxTokens({}), SONG_TAG_DEFAULT_MAX_TOKENS);
  assert.equal(songTagMaxTokens({ SONG_TAG_MAX_TOKENS: '2500' }), 2500);
  assert.equal(songTagMaxTokens({ SONG_TAG_MAX_TOKENS: 'abc' }), SONG_TAG_DEFAULT_MAX_TOKENS);
  assert.equal(songTagMaxTokens({ SONG_TAG_MAX_TOKENS: '0' }), SONG_TAG_DEFAULT_MAX_TOKENS);
  assert.equal(songTagMaxTokens({ SONG_TAG_MAX_TOKENS: '99999' }), 8192);
  assert.equal(songTagMaxAttempts({}), SONG_TAG_DEFAULT_MAX_ATTEMPTS);
  assert.equal(songTagMaxAttempts({ SONG_TAG_MAX_ATTEMPTS: '3' }), 3);
  assert.equal(songTagMaxAttempts({ SONG_TAG_MAX_ATTEMPTS: 'nope' }), SONG_TAG_DEFAULT_MAX_ATTEMPTS);

  // env 覆盖的实际生效点在传输层：这里只验证本层不再自行读取预算数字。
  const previous = process.env.SONG_TAG_MAX_TOKENS;
  process.env.SONG_TAG_MAX_TOKENS = '2500';
  try {
    const calls = [];
    const llm = createTaggingLlm({ chat: async (m, t, options) => { calls.push(options); return { message: { content: '{"ok":true}' } }; } });
    await llm('p');
    assert.equal(calls[0].taskId, 'song_tag', 'env 覆盖由任务规格在传输层解析');
  } finally {
    if (previous === undefined) delete process.env.SONG_TAG_MAX_TOKENS;
    else process.env.SONG_TAG_MAX_TOKENS = previous;
  }
});

test('chat 抛未配置错误时如实传播（上层写 L1 占位，不发请求）', async () => {
  const llm = createTaggingLlm({ chat: async () => { throw new Error('请先在设置里接入模型'); }, sleep: async () => {} });
  await assert.rejects(() => llm('p'), /接入模型/);
});

test('超时不再由本层传递：数字与 env 覆盖都在规格层（llmTasks.test.js 覆盖）', async () => {
  const calls = [];
  const llm = createTaggingLlm({
    chat: async (m, t, options) => { calls.push(options); return { message: { content: '{"ok":true}' } }; },
  });
  await llm('p');
  assert.equal('timeoutMs' in calls[0], false);
  assert.equal(calls[0].taskId, 'song_tag');
});

test('归属端到端：后台打标（显式 null）不写进聊天记录，前台调用仍归属该会话（真实适配器）', async t => {
  const rows = [];
  const store = {
    record: (context, event) => rows.push({ context, event }),
    flush: async () => {}, deleteSession: async () => {}, status: () => ({}),
  };
  const sessionTrace = createSessionTrace({ store });
  const bodies = [];
  const llm = createLlm({
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({
        choices: [{ message: { role: 'assistant', content: '{"mood":"calm"}' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
      }) };
    },
    resolveEndpoint: async () => ({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-test',
      model: 'deepseek-flash', api: 'openai-completions', source: 'registry:active' }),
  });
  setLlmObserver(event => sessionTrace.recordModel(event));
  t.after(() => setLlmObserver(null));
  const taggingLlm = createTaggingLlm({ chat: llm.chat, sleep: async () => {} });

  await sessionTrace.enter({ sessionId: 'chat-1', requestId: 'req-1', virtualPersonId: 'lunara' }, async () => {
    // 模拟"播放某个聊天时异步入队打标"：它继承了聊天的 ALS 上下文。
    const tagged = await taggingLlm('打标 prompt');
    assert.equal(tagged, '{"mood":"calm"}');
    await llm.chat([{ role: 'user', content: '你好' }], null, { sessionId: 'chat-1', maxTokens: 2048, temperature: 0.8 });
  });

  const types = rows.map(row => row.event.type);
  assert.deepEqual(types, ['model_request', 'model_attempt', 'model_response'], '后台打标不落任何事件，只有前台调用被记录');
  assert.equal(rows[1].event.taskId, 'unspecified', '每次尝试的分类记录随请求');
  assert.equal(rows[0].context.sessionId, 'chat-1', '前台调用仍归属当前会话');
  assert.equal(rows[0].event.model, 'deepseek-flash');
  // 真实适配后的请求体：打标请求显式关思考 + 1500 预算；前台请求不受影响。
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[0].max_tokens, 1500);
  assert.equal(bodies[1].thinking, undefined, '前台调用不带 thinking 扩展');
  assert.equal(bodies[1].max_tokens, 2048);
});
