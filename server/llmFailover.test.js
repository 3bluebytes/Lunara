// llmFailover.test.js — 离线故障注入：不发起真实网络请求。
// 覆盖默认关闭、跨源授权、网络/鉴权错误资格、共享截止/取消、delta 不重放与请求次数。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFailoverChat, isEligibleFailoverError } from './llmFailover.js';
import {
  saveModelProvider, setActiveModel, saveModelFailoverPolicy,
  getModelFailoverPolicy, resolveModelFailoverTargets,
} from './llmProviders.js';

function makeConfigDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-failover-'));
  process.env.LUNARA_CONFIG_DIR = dir;
  t.after(() => {
    delete process.env.LUNARA_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function apiError(status = null) {
  const error = new Error('safe provider failure');
  error.code = 'LLM_API_ERROR';
  if (status != null) error.status = status;
  else error.transportFailure = true;
  return error;
}

function timeoutError() {
  const error = new Error('attempt timed out');
  error.name = 'TimeoutError';
  return error;
}

function result(content = 'ok', extra = {}) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: null, ...extra };
}

const primaryEndpoint = {
  baseUrl: 'http://primary.invalid/v1', apiKey: 'sk-primary', model: 'm-primary',
  api: 'openai-completions', providerId: 'p-primary', source: 'active',
};

const fallbackA = {
  baseUrl: 'http://a.invalid/v1', apiKey: 'sk-a', model: 'm-a',
  api: 'openai-completions', providerId: 'p-a', source: 'provider',
};

const fallbackB = {
  baseUrl: 'http://b.invalid/v1', apiKey: 'sk-b', model: 'm-b',
  api: 'openai-completions', providerId: 'p-b', source: 'provider',
};

/** 按调用序号依次执行 responder；没有更多 responder 时复用最后一个。 */
function makeChat(responders) {
  const calls = [];
  const chat = async (messages, tools, options) => {
    calls.push({ messages, tools, options });
    const responder = responders[calls.length - 1] ?? responders.at(-1);
    return responder(calls.at(-1).options);
  };
  return { chat, calls };
}

function makeFailover({ responders, fallbacks = [], primary = primaryEndpoint, extra = {} } = {}) {
  const fake = makeChat(responders);
  const fallbackCalls = [];
  const failover = createFailoverChat({
    chat: fake.chat,
    resolveEndpoint: async () => primary,
    resolveFallbacks: async () => {
      fallbackCalls.push(true);
      return fallbacks;
    },
    ...extra,
  });
  return { ...fake, failover, fallbackCalls };
}

test('主模型成功：只请求一次，备用未使用，结果带安全元数据', async () => {
  const { failover, calls, fallbackCalls } = makeFailover({
    responders: [() => result('primary text')],
    fallbacks: [fallbackA, fallbackB],
  });
  const out = await failover([{ role: 'user', content: 'hi' }], null, {});
  assert.equal(calls.length, 1);
  assert.equal(fallbackCalls.length, 1, '策略会解析，但没有失败就不请求备用');
  assert.deepEqual(out.failover, { used: false, providerId: 'p-primary', model: 'm-primary' });
  assert.equal(out.message.content, 'primary text');
});

test('failover:false 禁用：不解析全局策略，只发主请求', async () => {
  const { failover, calls, fallbackCalls } = makeFailover({
    responders: [() => result()],
    fallbacks: [fallbackA],
  });
  const out = await failover([{ role: 'user', content: 'hi' }], null, { failover: false });
  assert.equal(fallbackCalls.length, 0, '显式禁用时连策略都不读取');
  assert.equal(calls.length, 1);
  assert.equal(out.failover.used, false);
});

test('暂时性传输失败切到备用；onFailover 只含身份与数字', async () => {
  const events = [];
  const { failover, calls } = makeFailover({
    responders: [() => { throw apiError(); }, () => result('fallback text')],
    fallbacks: [fallbackA, fallbackB],
  });
  const out = await failover([{ role: 'user', content: 'hi' }], null, {
    failoverTimeoutMs: 1000,
    onFailover: event => events.push(event),
  });
  assert.equal(calls.length, 2, '主失败一次 + 第一个备用成功一次');
  assert.equal(calls[1].options.endpoint, fallbackA, '备用走既有 chat 的显式端点投影');
  assert.equal(out.failover.used, true);
  assert.deepEqual({ providerId: out.failover.providerId, model: out.failover.model },
    { providerId: 'p-a', model: 'm-a' });
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(),
    ['attempt', 'fromModel', 'fromProviderId', 'model', 'providerId', 'remainingMs']);
  assert.equal('error' in events[0], false, 'callback 不得泄漏原始错误');
  assert.equal(events[0].fromProviderId, 'p-primary');
  assert.equal(events[0].providerId, 'p-a');
  assert.equal(events[0].attempt, 2);
  assert.equal(typeof events[0].remainingMs, 'number');
});

test('HTTP 401/403/408/429/5xx 有备用时切换；其他 4xx 与业务/内容错误不切换', async () => {
  for (const status of [401, 403, 408, 429, 500, 503]) {
    const { failover, calls } = makeFailover({
      responders: [() => { throw apiError(status); }, () => result('ok')],
      fallbacks: [fallbackA],
    });
    const out = await failover([{ role: 'user', content: 'hi' }], null, { failoverTimeoutMs: 1000 });
    assert.equal(calls.length, 2, `status ${status} 应该切换`);
    assert.equal(out.failover.used, true);
  }

  for (const status of [400, 404, 409]) {
    const { failover, calls } = makeFailover({
      responders: [() => { throw apiError(status); }, () => result('ok')],
      fallbacks: [fallbackA],
    });
    await assert.rejects(
      failover([{ role: 'user', content: 'hi' }], null, { failoverTimeoutMs: 1000 }),
      error => error.code === 'LLM_API_ERROR' && error.status === status,
    );
    assert.equal(calls.length, 1, `status ${status} 不切换`);
  }

  for (const code of ['LLM_BUDGET_EXHAUSTED', 'LLM_INVALID_RESPONSE', 'LLM_INVALID_JSON',
    'LLM_TRUNCATED_CONTENT', 'LLM_REASONING_ONLY', 'TOOL_BUSINESS_ERROR']) {
    const error = apiError();
    error.code = code;
    assert.equal(isEligibleFailoverError(error), false, `${code} 不属于暂时性传输失败`);
    assert.equal(isEligibleFailoverError(Object.assign(new Error('x'), { code, status: 503 })), false,
      '非 LLM_API_ERROR 的业务错误即使带状态也不切换');
  }
});

test('同网关不同模型：401 后切备用，首备用 403 后继续第二备用', async () => {
  const sameProvider = { ...fallbackA, providerId: primaryEndpoint.providerId };
  const { failover, calls } = makeFailover({
    responders: [() => { throw apiError(401); }, () => { throw apiError(403); }, () => result('healthy')],
    fallbacks: [sameProvider, fallbackB],
  });
  const out = await failover([], null, { timeoutMs: 1000 });
  assert.deepEqual(calls.map(call => call.options.endpoint.model), ['m-primary', 'm-a', 'm-b']);
  assert.equal(out.message.content, 'healthy');
  assert.deepEqual(out.failover, { used: true, providerId: 'p-b', model: 'm-b' });
});

test('鉴权全部失败：每目标仅一次，返回最后错误而非伪造成功', async () => {
  const { failover, calls } = makeFailover({
    responders: [() => { throw apiError(401); }, () => { throw apiError(403); }],
    fallbacks: [fallbackA, fallbackB],
  });
  await assert.rejects(failover([], null, { timeoutMs: 1000 }), { code: 'LLM_API_ERROR', status: 403 });
  assert.equal(calls.length, 3);
});

test('鉴权失败无可用备用、显式关闭或固定端点时不做同端点重试', async () => {
  for (const status of [401, 403]) {
    for (const mode of ['none', 'off', 'pinned']) {
      const { failover, calls } = makeFailover({
        responders: [() => { throw apiError(status); }],
        fallbacks: mode === 'none' ? [] : [fallbackA],
        extra: { minRetryMs: 1 },
      });
      const options = { timeoutMs: 1000,
        ...(mode === 'off' ? { failover: false } : {}),
        ...(mode === 'pinned' ? { endpoint: primaryEndpoint } : {}) };
      await assert.rejects(failover([], null, options), { status });
      assert.equal(calls.length, 1, status + ':' + mode);
    }
  }
});

test('鉴权切换仍受正文、外层取消、绝对截止和授权撤回约束', async () => {
  for (const mode of ['delta', 'cancel', 'deadline', 'revoked']) {
    const controller = new AbortController();
    let clock = 1_000, targets = [fallbackA], calls = 0;
    const failover = createFailoverChat({
      resolveEndpoint: async () => primaryEndpoint,
      resolveFallbacks: async () => targets,
      now: () => clock,
      chat: async (_messages, _tools, options) => {
        calls++;
        if (mode === 'delta') options.onTextDelta({ text: '已经显示' });
        if (mode === 'cancel') controller.abort();
        if (mode === 'deadline') clock += 1000;
        if (mode === 'revoked') targets = [];
        throw apiError(401);
      },
    });
    await assert.rejects(failover([], null, { timeoutMs: 1000, signal: controller.signal }),
      mode === 'cancel' ? { name: 'AbortError' } : { status: 401 });
    assert.equal(calls, 1, mode);
  }
  for (const status of ['401', '403', NaN, null]) {
    assert.equal(isEligibleFailoverError({ code: 'LLM_API_ERROR', status }, { allowAuthFailover: true }), false);
  }
});

test('超时（外层未取消）有资格切换；备用在剩余截止内成功', async () => {
  const { failover, calls } = makeFailover({
    responders: [() => { throw timeoutError(); }, () => result('after timeout')],
    fallbacks: [fallbackA],
  });
  const out = await failover([{ role: 'user', content: 'hi' }], null, { failoverTimeoutMs: 500 });
  assert.equal(calls.length, 2);
  assert.equal(out.failover.used, true);
  assert.equal(out.message.content, 'after timeout');
});

test('备用最多两个：第三个已解析目标也不请求', async () => {
  const events = [];
  const third = { ...fallbackB, providerId: 'p-c', model: 'm-c' };
  const { failover, calls } = makeFailover({
    responders: [() => { throw apiError(503); }],
    fallbacks: [fallbackA, fallbackB, third],
  });
  await assert.rejects(
    failover([{ role: 'user', content: 'hi' }], null, {
      failoverTimeoutMs: 1000,
      onFailover: event => events.push(event),
    }),
    error => error.code === 'LLM_API_ERROR' && error.status === 503,
  );
  assert.equal(calls.length, 3, '主请求 + 两个备用，绝不请求第三个');
  assert.equal(events.length, 2, '只公告两次切换');
  assert.equal(calls[2].options.endpoint.providerId, 'p-b');
});

test('外层取消：已取消不发请求；中途取消不切换', async () => {
  const abortController = new AbortController();
  abortController.abort();
  const preAborted = makeFailover({ responders: [() => result()], fallbacks: [fallbackA] });
  await assert.rejects(
    preAborted.failover([{ role: 'user', content: 'hi' }], null, { signal: abortController.signal }),
    error => error.name === 'AbortError' && error.code === 'ABORT_ERR',
  );
  assert.equal(preAborted.calls.length, 0, '取消后不发起任何请求');

  const controller = new AbortController();
  const { failover, calls } = makeFailover({
    responders: [options => new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        reject(error);
      }, { once: true });
    })],
    fallbacks: [fallbackA],
  });
  const timer = setTimeout(() => controller.abort(), 5);
  await assert.rejects(
    failover([{ role: 'user', content: 'hi' }], null, {
      failoverTimeoutMs: 1000, signal: controller.signal,
    }),
    error => error.name === 'AbortError',
  );
  clearTimeout(timer);
  assert.equal(calls.length, 1, '外层取消不启动备用');
});

test('总截止用尽：忽略 abort 的端点也只能在总预算内尝试两个备用', async () => {
  const { failover, calls } = makeFailover({
    responders: [() => new Promise(() => {})],
    fallbacks: [fallbackA, fallbackB],
  });
  await assert.rejects(
    failover([{ role: 'user', content: 'hi' }], null, { failoverTimeoutMs: 20 }),
    error => error.name === 'TimeoutError' && error.code === 'LLM_TIMEOUT',
  );
  assert.ok(calls.length <= 3, '总预算内至多主端点加两个备用');
});

test('已输出正文 delta：失败关闭，不切换也不重放', async () => {
  const deltas = [];
  const resets = [];
  const events = [];
  const { failover, calls } = makeFailover({
    responders: [options => {
      options.onTextDelta({ text: '草稿片段', attempt: 7 });
      options.onStreamReset?.({ attempt: 7 });
      throw apiError(503);
    }, () => result('不该出现')],
    fallbacks: [fallbackA],
  });
  await assert.rejects(
    failover([{ role: 'user', content: 'hi' }], null, {
      failoverTimeoutMs: 1000,
      onTextDelta: delta => deltas.push(delta),
      onStreamReset: reset => resets.push(reset),
      onFailover: event => events.push(event),
    }),
    error => error.status === 503,
  );
  assert.equal(calls.length, 1, '已暴露正文后绝不请求备用');
  assert.deepEqual(deltas, [{ text: '草稿片段', attempt: 7 }], '保留底层真实尝试序号，不重放');
  assert.deepEqual(resets, [{ attempt: 7 }]);
  assert.equal(events.length, 0);
});

test('显式 options.endpoint 不自动套用全局备用', async () => {
  const { failover, calls, fallbackCalls } = makeFailover({
    responders: [() => result('explicit')],
    fallbacks: [fallbackA],
  });
  const explicit = {
    baseUrl: 'http://explicit.invalid/v1', apiKey: 'k', model: 'm-explicit',
    api: 'openai-completions', providerId: 'p-explicit',
  };
  const out = await failover([{ role: 'user', content: 'hi' }], null, { endpoint: explicit });
  assert.equal(fallbackCalls.length, 0, '显式端点时不解析全局策略');
  assert.equal(calls.length, 1);
  assert.deepEqual(out.failover, { used: false, providerId: 'p-explicit', model: 'm-explicit' });
});

test('切换后成功即返回，不重复请求工具动作', async () => {
  const toolCalls = [{ id: 'call-1', type: 'function', function: { name: 'demo', arguments: '{}' } }];
  const { failover, calls } = makeFailover({
    responders: [
      () => { throw apiError(503); },
      () => result('', { message: { role: 'assistant', content: '', tool_calls: toolCalls } }),
    ],
    fallbacks: [fallbackA],
  });
  const out = await failover([{ role: 'user', content: 'hi' }], [{ type: 'function' }], { failoverTimeoutMs: 1000 });
  assert.equal(calls.length, 2, '成功一次只返回一次结果');
  assert.equal(out.message.tool_calls, toolCalls);
  assert.equal(out.failover.used, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 2, '返回后不再有迟到请求');
});

test('默认策略：缺省关闭、跨 provider 需显式授权、停用目标被跳过', async t => {
  makeConfigDir(t);
  const a = await saveModelProvider({
    name: 'a', baseUrl: 'http://a.invalid/v1', models: ['m-a'], enabled: true,
  });
  const b = await saveModelProvider({
    name: 'b', baseUrl: 'http://b.invalid/v1', models: ['m-b'], enabled: true,
  });
  await setActiveModel({ providerId: a.id, model: 'm-a' });

  assert.deepEqual(await getModelFailoverPolicy(),
    { enabled: false, allowCrossProvider: false, targets: [] }, '缺省策略为关闭');

  const primary = { ...primaryEndpoint, providerId: a.id, model: 'm-a' };
  await saveModelFailoverPolicy({
    enabled: true, allowCrossProvider: false, targets: [{ providerId: b.id, model: 'm-b' }],
  });
  assert.deepEqual(await resolveModelFailoverTargets(primary, {}), [],
    '未显式 allowCrossProvider 时不得跨 provider');

  await saveModelFailoverPolicy({
    enabled: true, allowCrossProvider: true, targets: [{ providerId: b.id, model: 'm-b' }],
  });
  const resolved = await resolveModelFailoverTargets(primary, {});
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].providerId, b.id);
  assert.equal(resolved[0].model, 'm-b');
  assert.equal('apiKey' in resolved[0], true, '解析结果保留端点投影供底层 chat 使用');

  // provider 停用后，已保存的目标在运行时应被跳过（不报错、不换到停用端点）。
  await saveModelProvider({ id: b.id, enabled: false });
  assert.deepEqual(await resolveModelFailoverTargets(primary, {}), []);
});

// ── 单次请求上限与同端点重试（bound-model-attempt-timeout） ─────────────────

/** 遵守 signal 的挂起请求：被中止时以 signal.reason 拒绝。 */
const hang = options => new Promise((_, reject) => {
  options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
});

test('无备用：卡住的首次尝试在单次上限处截断，同端点重试成功', async () => {
  const { failover, calls } = makeFailover({
    responders: [hang, () => result('retried')],
    extra: { resolveAttemptTimeout: () => 30, minRetryMs: 10 },
  });
  const started = Date.now();
  const out = await failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000 });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].options.timeoutMs <= 30, '首次尝试拿到的是单次上限');
  assert.equal(calls[1].options.endpoint.providerId, 'p-primary', '重试同一端点，不请求别的 provider');
  assert.equal(out.message.content, 'retried');
  assert.equal(out.failover.used, false);
  assert.ok(Date.now() - started < 500);
});

test('无备用：502 同端点重试一次；仍失败则如实返回，不再请求', async () => {
  const { failover, calls } = makeFailover({
    responders: [() => { throw apiError(502); }],
    extra: { minRetryMs: 10 },
  });
  await assert.rejects(failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000 }),
    error => error.status === 502);
  assert.equal(calls.length, 2, '主请求 + 一次重试');
});

test('无备用：剩余不足、已暴露正文、外层取消、4xx 都不重试', async () => {
  const short = makeFailover({ responders: [() => { throw apiError(503); }] });
  await assert.rejects(short.failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000 }), { status: 503 });
  assert.equal(short.calls.length, 1, '默认 8s 门槛下 1s 预算不够重试');

  const exposed = makeFailover({
    responders: [options => { options.onTextDelta({ text: '半句' }); throw apiError(503); }],
    extra: { minRetryMs: 10 },
  });
  await assert.rejects(exposed.failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000, onTextDelta: () => {} }),
    { status: 503 });
  assert.equal(exposed.calls.length, 1);

  const controller = new AbortController();
  const cancelled = makeFailover({ responders: [hang], extra: { minRetryMs: 10 } });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(cancelled.failover([{ role: 'user', content: 'hi' }], null,
    { timeoutMs: 1000, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(cancelled.calls.length, 1);

  const client = makeFailover({ responders: [() => { throw apiError(400); }], extra: { minRetryMs: 10 } });
  await assert.rejects(client.failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000 }), { status: 400 });
  assert.equal(client.calls.length, 1);
});

test('无上限任务：首次尝试仍拿到全部剩余时间', async () => {
  const { failover, calls } = makeFailover({ responders: [() => result()], extra: { resolveAttemptTimeout: () => null } });
  await failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000 });
  assert.ok(calls[0].options.timeoutMs > 900, `got ${calls[0].options.timeoutMs}`);
});

test('有备用：每次尝试取 min(平分份额, 单次上限)', async () => {
  const { failover, calls } = makeFailover({
    responders: [() => { throw apiError(503); }, () => { throw apiError(503); }, () => result('b')],
    fallbacks: [fallbackA, fallbackB],
    extra: { resolveAttemptTimeout: () => 100 },
  });
  const out = await failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 600, failoverTimeoutMs: 600 });
  assert.equal(out.message.content, 'b');
  assert.equal(calls.length, 3, '有备用时不额外做同端点重试');
  assert.ok(calls.every(call => call.options.timeoutMs <= 100));

  const wide = makeFailover({ responders: [() => result()], fallbacks: [fallbackA],
    extra: { resolveAttemptTimeout: () => 10_000 } });
  await wide.failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 600, failoverTimeoutMs: 600 });
  assert.ok(wide.calls[0].options.timeoutMs <= 300, '份额更小时取份额');
});

test('failover:false 或显式端点：同端点也不重试，只发一次', async () => {
  const off = makeFailover({ responders: [() => { throw apiError(503); }], extra: { minRetryMs: 10 } });
  await assert.rejects(off.failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000, failover: false }), { status: 503 });
  assert.equal(off.calls.length, 1);
  const pinned = makeFailover({ responders: [() => { throw apiError(503); }], extra: { minRetryMs: 10 } });
  await assert.rejects(pinned.failover([{ role: 'user', content: 'hi' }], null, { timeoutMs: 1000, endpoint: fallbackA }),
    { status: 503 });
  assert.equal(pinned.calls.length, 1);
});
