import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createApiClient } from './apiClient.js';

test('api client sends JSON, stable request id, and parses successful response', async () => {
  const calls = [];
  const client = createApiClient({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    requestIdFactory: () => 'rq-browser',
  });

  const playbackIdentity = { listeningSessionId: 'conversation:primary', queueItemId: 'q-street', songId: 'street' };
  const result = await client.chat({
    message: '下一首',
    sessionId: 'conversation:primary',
    playbackIdentity,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0][0], '/api/chat');
  assert.equal(calls[0][1].headers['x-request-id'], 'rq-browser');
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    message: '下一首',
    sessionId: 'conversation:primary',
    playbackIdentity,
    requestId: 'rq-browser',
  });
});

test('caller-supplied request id survives a retry', async () => {
  const ids = [];
  const client = createApiClient({
    fetchImpl: async (_url, init) => {
      ids.push(init.headers['x-request-id']);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await client.chat({ message: '删除第二首', requestId: 'rq-stable' });
  await client.chat({ message: '删除第二首', requestId: 'rq-stable' });
  assert.deepEqual(ids, ['rq-stable', 'rq-stable']);
});

test('non-2xx and invalid JSON responses become typed ApiError', async () => {
  const failed = createApiClient({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'offline' }) }),
  });
  await assert.rejects(failed.get('/api/health'), error => {
    assert.equal(error instanceof ApiError, true);
    assert.equal(error.status, 503);
    assert.equal(error.message, 'offline');
    return true;
  });
});

test('put 走真实链路时是 method=PUT + JSON body（回归：模型设置曾反序调用 request 导致全局/会话模型切换不保存）', async () => {
  const calls = [];
  const client = createApiClient({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  await client.put('/api/llm/active-model', { providerId: 'p', model: 'm' });
  assert.equal(calls[0][0], '/api/llm/active-model');
  assert.equal(calls[0][1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0][1].body), { providerId: 'p', model: 'm' });
  assert.equal(calls[0][1].headers['content-type'], 'application/json');
});

test('所有状态变更方法都带 JSON content-type（含无 body 的 DELETE）', async () => {
  const calls = [];
  const client = createApiClient({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });

  await client.post('/api/virtual-persons', { displayName: '夜航' });
  await client.patch('/api/virtual-persons/radiohost-1', { displayName: '晚风' });
  await client.delete('/api/virtual-persons/radiohost-1');

  for (const [url, init] of calls) {
    // 服务端的 request boundary 对所有 POST/PATCH/PUT/DELETE 都要求这个头，
    // 缺了会被 415 拒绝——DELETE 不带 body 也必须带（真实故障：删除伙伴完全不可用）。
    assert.equal(init.headers['content-type'], 'application/json', `${init.method} ${url} 必须带 JSON content-type`);
  }
  const del = calls.find(([, init]) => init.method === 'DELETE');
  assert.ok(del, '应发出 DELETE');
  assert.equal(del[1].body, undefined, '无 body 的删除不应凭空造一个 body');
});
