import assert from 'node:assert/strict';
import test from 'node:test';
import { registerVirtualPersonRoutes } from './virtualPersonRoutes.js';

function fakeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    headersSent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.headersSent = true; return this; },
  };
}

test('virtual-person routes expose create, list, get, activate and archive', async () => {
  const app = fakeApp();
  const calls = [];
  const person = { id: 'radiohost-1', displayName: '夜航' };
  registerVirtualPersonRoutes(app, {
    virtualPersonService: {
      list: () => [person],
      session: sessionId => ({ sessionId, activeVirtualPersonId: 'lunara' }),
      get: id => id === 'radiohost-1' ? person : null,
      create: async body => { calls.push(['create', body]); return person; },
      activate: async body => { calls.push(['activate', body]); return { entity: person, session: { sessionId: body.sessionId } }; },
      archive: id => { calls.push(['archive', id]); return person; },
      transcript: sessionId => [{ turnId: 't', role: 'assistant', speakerVirtualPersonId: 'lunara', text: sessionId }],
    },
  });

  const listRes = response();
  app.routes.get('GET /api/virtual-persons')({ query: { sessionId: 's' } }, listRes);
  assert.deepEqual(listRes.body.persons, [person]);
  assert.deepEqual(listRes.body.session, { sessionId: 's', activeVirtualPersonId: 'lunara' });

  const transcriptRes = response();
  app.routes.get('GET /api/conversations/:sessionId/turns')({ params: { sessionId: 's' }, query: {} }, transcriptRes);
  assert.equal(transcriptRes.body.turns[0].text, 's');

  const createRes = response();
  await app.routes.get('POST /api/virtual-persons')({ body: { displayName: '夜航' } }, createRes);
  assert.equal(createRes.body.person.id, 'radiohost-1');

  const activateRes = response();
  await app.routes.get('POST /api/virtual-persons/:id/activate')({ params: { id: 'radiohost-1' }, body: { sessionId: 's' } }, activateRes);
  assert.deepEqual(calls[1], ['activate', { id: 'radiohost-1', sessionId: 's' }]);

  const archiveRes = response();
  app.routes.get('POST /api/virtual-persons/:id/archive')({ params: { id: 'radiohost-1' } }, archiveRes);
  assert.equal(archiveRes.body.ok, true);
});

function managementApp(overrides = {}) {
  const app = fakeApp();
  const calls = [];
  registerVirtualPersonRoutes(app, {
    virtualPersonService: {
      list: () => [],
      session: () => ({ sessionId: 's' }),
      get: () => null,
      updatePerson: (id, fields) => { calls.push(['updatePerson', id, fields]); return { id, ...fields }; },
      deletePerson: async id => { calls.push(['deletePerson', id]); return { deleted: true, memories: 3, personaFile: true, legacyHost: true }; },
      personDeletionImpact: id => ({ id, displayName: '小晚', isRoot: false, deletable: true, memories: 3, rooms: 1 }),
      ...overrides,
    },
  });
  return { app, calls };
}

test('编辑伙伴经 PATCH 生效并透传字段', async () => {
  const { app, calls } = managementApp();
  const res = response();
  app.routes.get('PATCH /api/virtual-persons/:id')({ params: { id: 'radiohost-1' }, body: { displayName: '晚风', voiceProfileId: 'v2' } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.person.displayName, '晚风');
  assert.deepEqual(calls[0], ['updatePerson', 'radiohost-1', { displayName: '晚风', voiceProfileId: 'v2' }]);
});

test('删除前可通过 deletion-impact 读到真实影响面', () => {
  const { app } = managementApp();
  const res = response();
  app.routes.get('GET /api/virtual-persons/:id/deletion-impact')({ params: { id: 'radiohost-1' } }, res);
  assert.equal(res.body.impact.memories, 3, '必须披露将被永久移除的记忆条数');
  assert.equal(res.body.impact.deletable, true);
});

test('删除伙伴经 DELETE 执行并返回清理结果', async () => {
  const { app, calls } = managementApp();
  const res = response();
  await app.routes.get('DELETE /api/virtual-persons/:id')({ params: { id: 'radiohost-1' } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.memories, 3);
  assert.deepEqual(calls[0], ['deletePerson', 'radiohost-1']);
});

test('删除根陪伴者返回 400 而不是 500', async () => {
  const { app } = managementApp({
    deletePerson: async () => { throw new Error('root Lunara cannot be deleted'); },
  });
  const res = response();
  await app.routes.get('DELETE /api/virtual-persons/:id')({ params: { id: 'lunara' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /cannot be deleted/);
});

test('编辑校验失败返回 400 而不是 500', () => {
  const { app } = managementApp({
    updatePerson: () => { throw new TypeError('displayName exceeds 80 characters'); },
  });
  const res = response();
  app.routes.get('PATCH /api/virtual-persons/:id')({ params: { id: 'radiohost-1' }, body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /exceeds/);
});

test('删除不存在的伙伴返回 404', async () => {
  const { app } = managementApp({ deletePerson: async () => ({ deleted: false }) });
  const res = response();
  await app.routes.get('DELETE /api/virtual-persons/:id')({ params: { id: 'nope' } }, res);
  assert.equal(res.statusCode, 404);
});

test('deletion-impact 对不存在的伙伴返回 404', () => {
  const { app } = managementApp({ personDeletionImpact: () => null });
  const res = response();
  app.routes.get('GET /api/virtual-persons/:id/deletion-impact')({ params: { id: 'nope' } }, res);
  assert.equal(res.statusCode, 404);
});

test('创建时未知预设返回可纠正的 400 而不是 500', async () => {
  const app = fakeApp();
  registerVirtualPersonRoutes(app, {
    virtualPersonService: {
      create: async () => { throw new TypeError('invalid personaPresetId: unknown persona preset "bogus"'); },
    },
  });
  const res = response();
  await app.routes.get('POST /api/virtual-persons')({ body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /personaPresetId/);
});

test('创建时未知声音返回 404 而不是 500', async () => {
  const app = fakeApp();
  registerVirtualPersonRoutes(app, {
    virtualPersonService: {
      create: async () => { throw new Error('Voice profile not found: vp_none'); },
    },
  });
  const res = response();
  await app.routes.get('POST /api/virtual-persons')({ body: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /Voice profile not found/);
});

test('删除部分失败返回可重试的 500，而不是伪装成 not-found', async () => {
  const app = fakeApp();
  registerVirtualPersonRoutes(app, {
    virtualPersonService: {
      deletePerson: async () => ({ deleted: false, reason: 'purge-failed', errors: ['memory store exploded'] }),
    },
  });
  const res = response();
  await app.routes.get('DELETE /api/virtual-persons/:id')({ params: { id: 'radiohost-1' } }, res);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /删除未完成/);
});

test('确认 ambient 推荐：成功 200；找不到 404；过期/非当前来源/放不了 409；提交忙 503 可重试', async () => {
  const app = fakeApp();
  const results = {
    ok: { ok: true, code: 'RECOMMENDATION_QUEUED', recommendation: { turnId: 'ok', status: 'queued' } },
    missing: { ok: false, code: 'RECOMMENDATION_NOT_FOUND' },
    stale: { ok: false, code: 'RECOMMENDATION_NOT_LISTENING_SOURCE', recommendation: { turnId: 'stale', status: 'expired' } },
    busy: { ok: false, code: 'RECOMMENDATION_ACCEPT_RETRY', retryable: true, recommendation: { turnId: 'busy', status: 'pending' } },
  };
  const calls = [];
  registerVirtualPersonRoutes(app, { virtualPersonService: {
    acceptRecommendation: async (sessionId, turnId) => { calls.push([sessionId, turnId]); return results[turnId]; },
  } });
  const route = app.routes.get('POST /api/conversations/:sessionId/recommendations/:turnId/accept');
  const send = async turnId => { const res = response(); await route({ params: { sessionId: 'room', turnId }, body: {} }, res); return res; };
  const ok = await send('ok');
  assert.deepEqual([ok.statusCode, ok.body], [200, { ok: true, code: 'RECOMMENDATION_QUEUED', retryable: false,
    recommendation: { turnId: 'ok', status: 'queued' } }]);
  assert.equal((await send('missing')).statusCode, 404);
  const stale = await send('stale');
  assert.deepEqual([stale.statusCode, stale.body.code, stale.body.recommendation.status], [409, 'RECOMMENDATION_NOT_LISTENING_SOURCE', 'expired']);
  const busy = await send('busy');
  assert.deepEqual([busy.statusCode, busy.body.retryable], [503, true]);
  assert.deepEqual(calls[0], ['room', 'ok']);
});
