import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlm } from './llm.js';

const endpoint = { baseUrl: 'http://fixture/v1', apiKey: 'fixture', model: 'fixture', api: 'openai-completions' };
const enc = new TextEncoder();
const chunk = (content, finish = null, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta: { content, ...extra }, finish_reason: finish }] })}\n\n`;
function response(text) { return new Response(text, { headers: { 'content-type': 'text/event-stream' } }); }
const messages = [{ role: 'user', content: '你好' }];
const options = { taskId: 'chat_dialogue', stream: true, streamRequired: true };

test('visible delta is delivered before completion and never includes reasoning', async () => {
  let wire;
  const stream = new ReadableStream({ start(controller) { wire = controller; } });
  let first;
  const gotFirst = new Promise(resolve => { first = resolve; });
  const events = [];
  const llm = createLlm({ resolveEndpoint: async () => endpoint, fetchImpl: async () => new Response(stream) });
  const pending = llm.chat(messages, null, { ...options, onTextDelta: event => { events.push(event); first(); } });
  wire.enqueue(enc.encode(chunk('你好', null, { reasoning_content: 'private reasoning' })));
  await gotFirst;
  assert.equal(events[0].text, '你好');
  assert.equal(JSON.stringify(events).includes('private'), false);
  wire.enqueue(enc.encode(chunk('。', 'stop') + 'data: [DONE]\n\n'));
  wire.close();
  assert.equal((await pending).message.content, '你好。');
});

test('each real streamed attempt resets the provisional text', async () => {
  let calls = 0;
  const events = [];
  const llm = createLlm({ resolveEndpoint: async () => endpoint, fetchImpl: async () => response(++calls === 1
    ? chunk('半句', 'length') + 'data: [DONE]\n\n'
    : chunk('完整', 'stop') + 'data: [DONE]\n\n') });
  const result = await llm.chat(messages, null, { ...options, onStreamReset: e => events.push(['reset', e.attempt]),
    onTextDelta: e => events.push(['text', e.attempt, e.text]) });
  assert.equal(result.message.content, '完整');
  assert.deepEqual(events, [['reset', 1], ['text', 1, '半句'], ['reset', 2], ['text', 2, '完整']]);
});

test('visible streams reject a clean EOF or DONE without a terminal choice', async () => {
  for (const tail of ['', 'data: [DONE]\n\n']) {
    const llm = createLlm({ resolveEndpoint: async () => endpoint, fetchImpl: async () => response(chunk('半句') + tail) });
    await assert.rejects(llm.chat(messages, null, options), { code: 'LLM_STREAM_INCOMPLETE' });
  }
});

test('visible streams reject malformed chunks rather than silently omitting text', async () => {
  const llm = createLlm({ resolveEndpoint: async () => endpoint,
    fetchImpl: async () => response('data: {broken}\n\n' + chunk('结尾', 'stop') + 'data: [DONE]\n\n') });
  await assert.rejects(llm.chat(messages, null, options), { code: 'LLM_STREAM_INCOMPLETE' });
});

test('aborting a stream cancels an uncooperative readable body promptly', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const llm = createLlm({ resolveEndpoint: async () => endpoint, fetchImpl: async () => new Response(stream) });
  const pending = llm.chat(messages, null, { ...options, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('required streaming rejects an unsupported protocol before sending a request', async () => {
  let calls = 0;
  const llm = createLlm({ resolveEndpoint: async () => ({ ...endpoint, api: 'anthropic-messages' }),
    fetchImpl: async () => { calls++; throw new Error('should not fetch'); } });
  await assert.rejects(llm.chat(messages, null, options), { code: 'LLM_STREAM_UNSUPPORTED' });
  assert.equal(calls, 0);
});

test('streamRequired alone requests SSE instead of silently buffering JSON', async () => {
  const llm = createLlm({ resolveEndpoint: async () => endpoint, fetchImpl: async (_url, request) => {
    assert.equal(JSON.parse(request.body).stream, true);
    return response(chunk('正文', 'stop') + 'data: [DONE]\n\n');
  } });
  const deltas = [];
  const result = await llm.chat(messages, null, { taskId: 'chat_dialogue', streamRequired: true,
    onTextDelta: e => deltas.push(e.text) });
  assert.equal(result.streamed, true);
  assert.deepEqual(deltas, ['正文']);
});
