import test from 'node:test';
import assert from 'node:assert/strict';
import { createLlm, setLlmObserver, setLlmBudgetGuard } from './llm.js';
import { createFailoverChat, isEligibleFailoverError } from './llmFailover.js';
const a = { providerId: 'a', model: 'a', api: 'openai-completions', baseUrl: 'http://a.invalid', apiKey: 'fixture' };
const b = { ...a, providerId: 'b', model: 'b', baseUrl: 'http://b.invalid' };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 1 } }));
const input = [{ role: 'user', content: 'hello' }];

test('production transport fixes primary identity and accounts each real HTTP request', async t => {
  const attempts = [], urls = [];
  let resolves = 0;
  setLlmObserver(e => { if (e.phase === 'attempt') attempts.push(e); });
  t.after(() => setLlmObserver(null));
  const llm = createLlm({ resolveEndpoint: async () => { resolves++; return a; }, resolveFallbacks: async () => [b],
    fetchImpl: async url => { urls.push(url); return urls.length === 1 ? new Response('unavailable', { status: 503 }) : ok(); } });
  const result = await llm.chat(input, null, { timeoutMs: 1000 });
  assert.equal(result.failover.used, true);
  assert.deepEqual(urls, ['http://a.invalid/chat/completions', 'http://b.invalid/chat/completions']);
  assert.equal(resolves, 1);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].attemptId, attempts[1].attemptId);
  assert.deepEqual(attempts.map(e => e.providerId), ['a', 'b']);
});

test('budget rejection and invalid request do not start fallbacks', async t => {
  let requests = 0;
  const llm = createLlm({ resolveEndpoint: async () => a, resolveFallbacks: async () => [b],
    fetchImpl: async () => { requests++; return new Response('invalid request', { status: 400 }); } });
  await assert.rejects(llm.chat(input, null), { status: 400 });
  assert.equal(requests, 1);
  setLlmBudgetGuard(() => ({ ok: false }));
  t.after(() => setLlmBudgetGuard(null));
  await assert.rejects(llm.chat(input, null), { code: 'LLM_BUDGET_EXHAUSTED' });
  assert.equal(requests, 1);
});

test('production transport accounts 401/403 and switches across models on the same gateway', async t => {
  const attempts = [], models = [], notices = [];
  setLlmObserver(e => { if (e.phase === 'attempt') attempts.push(e); });
  t.after(() => setLlmObserver(null));
  const glm = { ...a, model: 'glm' }, gemini = { ...a, model: 'gemini' };
  const llm = createLlm({ resolveEndpoint: async () => a, resolveFallbacks: async () => [glm, gemini],
    fetchImpl: async (_url, init) => {
      models.push(JSON.parse(init.body).model);
      return models.length < 3
        ? new Response('fixture upstream authorization failed', { status: models.length === 1 ? 401 : 403 })
        : ok();
    } });
  const result = await llm.chat(input, null, { timeoutMs: 1000, onFailover: e => notices.push(e) });
  assert.equal(result.message.content, 'ok');
  assert.equal(result.failover.model, 'gemini');
  assert.deepEqual(models, ['a', 'glm', 'gemini']);
  assert.deepEqual(attempts.map(e => e.outcome), ['provider_error', 'provider_error', 'ok']);
  assert.deepEqual(attempts.map(e => e.model), models);
  assert.equal(new Set(attempts.map(e => e.attemptId)).size, 3);
  assert.equal(notices.length, 2);
});

test('production target resolver still enforces cross-provider consent after 401', async t => {
  const { saveModelProvider, setActiveModel, saveModelFailoverPolicy,
    resolveModelFailoverTargets } = await import('./llmProviders.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previous = process.env.LUNARA_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'lunara-auth-consent-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.LUNARA_CONFIG_DIR;
    else process.env.LUNARA_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const primary = await saveModelProvider({ name: 'a', baseUrl: a.baseUrl, models: ['a'] });
  const backup = await saveModelProvider({ name: 'b', baseUrl: b.baseUrl, models: ['b'] });
  await setActiveModel({ providerId: primary.id, model: 'a' });
  const endpoint = { ...a, providerId: primary.id };
  const urls = [];
  const llm = createLlm({ resolveEndpoint: async () => endpoint, resolveFallbacks: resolveModelFailoverTargets,
    fetchImpl: async url => { urls.push(url); return url.includes('a.invalid')
      ? new Response('fixture auth failure', { status: 401 }) : ok(); } });
  for (const allowCrossProvider of [false, true]) {
    await saveModelFailoverPolicy({ enabled: true, allowCrossProvider,
      targets: [{ providerId: backup.id, model: 'b' }] });
    if (allowCrossProvider) assert.equal((await llm.chat(input)).message.content, 'ok');
    else await assert.rejects(llm.chat(input), { status: 401 });
  }
  assert.deepEqual(urls, ['http://a.invalid/chat/completions',
    'http://a.invalid/chat/completions', 'http://b.invalid/chat/completions']);
});

test('unknown null/string/dirty status is not positive transport evidence', () => {
  for (const status of [undefined, null, '503', 'garbage', NaN, 0]) {
    assert.equal(isEligibleFailoverError({ code: 'LLM_API_ERROR', status }), false);
  }
  assert.equal(isEligibleFailoverError({ code: 'LLM_API_ERROR', transportFailure: true }), true);
  assert.equal(isEligibleFailoverError({ name: 'AbortError' }), false);
});

test('shared deadline is not multiplied and each endpoint receives remaining time', async () => {
  const timeouts = [];
  const started = Date.now();
  const chat = createFailoverChat({ resolveEndpoint: async () => a, resolveFallbacks: async () => [b],
    chat: async (_m, _t, options) => { timeouts.push(options.timeoutMs); return new Promise(() => {}); } });
  await assert.rejects(chat(input, null, { timeoutMs: 40, failoverTimeoutMs: 1000 }), { code: 'LLM_TIMEOUT' });
  assert.equal(timeouts.length, 2);
  assert.ok(timeouts[0] <= 20);
  assert.ok(Date.now() - started < 250);
});

test('disabled fallback is revalidated after primary failure', async () => {
  let targets = [b], calls = 0;
  const chat = createFailoverChat({ resolveEndpoint: async () => a, resolveFallbacks: async () => targets,
    chat: async () => { calls++; targets = []; throw Object.assign(new Error('safe'), { code: 'LLM_API_ERROR', status: 503 }); } });
  await assert.rejects(chat(input, null), { status: 503 });
  assert.equal(calls, 1);
});

test('no fallback policy preserves stream reset/delta attempt numbers', async () => {
  const received = [];
  const chat = createFailoverChat({ resolveEndpoint: async () => a, resolveFallbacks: async () => [],
    chat: async (_m, _t, options) => {
      options.onStreamReset({ attempt: 3 }); options.onTextDelta({ text: 'hi', attempt: 3 }); return {};
    } });
  await chat(input, null, { onStreamReset: e => received.push(e), onTextDelta: e => received.push(e) });
  assert.deepEqual(received, [{ attempt: 3 }, { text: 'hi', attempt: 3 }]);
});

test('a hung chat_dialogue attempt is cut by its cap, retried on the same endpoint, and ledgered as timeout', async t => {
  const attempts = [];
  let requests = 0;
  setLlmObserver(e => { if (e.phase === 'attempt') attempts.push(e); });
  t.after(() => { setLlmObserver(null); delete process.env.CHAT_ATTEMPT_TIMEOUT_MS; });
  process.env.CHAT_ATTEMPT_TIMEOUT_MS = '5000';
  const llm = createLlm({ resolveEndpoint: async () => a, resolveFallbacks: async () => [],
    fetchImpl: async (_url, init) => {
      requests++;
      if (requests > 1) return ok();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } });
  const started = Date.now();
  const result = await llm.chat(input, null, { taskId: 'chat_dialogue', timeoutMs: 20_000 });
  assert.equal(result.message.content, 'ok');
  assert.equal(result.failover.retried, true);
  assert.equal(requests, 2);
  assert.ok(Date.now() - started < 7_000, '卡住的首次请求在单次上限处截断');
  assert.equal(attempts[0].outcome, 'timeout');
  assert.equal(attempts.at(-1).outcome, 'ok');
});
