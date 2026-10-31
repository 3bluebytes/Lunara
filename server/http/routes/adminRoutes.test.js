import assert from 'node:assert/strict';
import test from 'node:test';

import { registerAdminRoutes } from './adminRoutes.js';

function fakeApp() {
  const routes = new Map();
  return {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
    routes,
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

test('admin routes are thin delegates for warm pool, reflection, taste, library and tags', async () => {
  const calls = [];
  const app = fakeApp();
  registerAdminRoutes(app, {
    warmPoolAdminService: {
      status: () => ({ enabled: true }),
      refresh: input => { calls.push(['warm', input]); return { ok: true }; },
    },
    reflectionAdminService: {
      status: () => ({ enabled: true }),
      run: input => { calls.push(['reflection', input]); return { ok: true }; },
    },
    tasteAdminService: {
      consolidate: input => { calls.push(['taste', input]); return { ok: true }; },
      log: () => ({ ok: true }), status: () => ({ ok: true }), profile: () => ({ taste: '' }), today: () => ({ date: 'x' }),
    },
    libraryAdminService: { snapshot: () => ({ ok: true, candidates: [] }) },
    librarySyncService: {
      import: input => { calls.push(['library-import', input]); return { ok: true, accepted: true }; },
      status: () => ({ ok: true, sources: [] }),
    },
    songTagAdminService: {
      status: () => ({ ok: true }),
      backfill: input => { calls.push(['tags', input]); return { ok: true }; },
      list: input => { calls.push(['tags-list', input]); return { ok: true, items: [], total: 0, ...input }; },
      update: input => { calls.push(['tags-update', input]); return { ok: true }; },
      remove: input => { calls.push(['tags-remove', input]); return { ok: true, deleted: 1 }; },
      config: () => ({ baseUrl: 'http://gw/v1', model: 'm', hasKey: true, auto: true }),
      saveConfig: async patch => { calls.push(['tags-config', patch]); return { baseUrl: 'http://gw/v1', model: 'm', hasKey: false, auto: false }; },
    },
  });

  const warmResponse = response();
  await app.routes.get('POST /api/warmpool/refresh')({ body: { radiohostId: 'a' } }, warmResponse);
  assert.deepEqual(warmResponse.payload, { ok: true });
  const reflectionResponse = response();
  await app.routes.get('POST /api/reflection/run')({ body: { radiohostId: 'a', window: 'short' } }, reflectionResponse);
  const tasteResponse = response();
  await app.routes.get('POST /api/taste/consolidate')({ body: {}, query: { dryRun: 'true' } }, tasteResponse);
  const tagsResponse = response();
  await app.routes.get('POST /api/songtags/backfill')({ body: { force: true } }, tagsResponse);
  const tagsListResponse = response();
  await app.routes.get('GET /api/songtags')({ query: { search: 'eason', limit: '50' } }, tagsListResponse);
  assert.equal(tagsListResponse.payload.search, 'eason', 'list forwards query params');
  const tagsUpdateResponse = response();
  await app.routes.get('PUT /api/songtags')({ body: { provider: 'ncm', songId: '1', patch: { mood: '平静' } } }, tagsUpdateResponse);
  assert.equal(tagsUpdateResponse.payload.ok, true);
  const tagsRemoveResponse = response();
  await app.routes.get('DELETE /api/songtags')({ body: { provider: 'ncm', songId: '1' } }, tagsRemoveResponse);
  assert.deepEqual(tagsRemoveResponse.payload, { ok: true, deleted: 1 });
  const tagsConfigResponse = response();
  await app.routes.get('GET /api/songtags/config')({}, tagsConfigResponse);
  assert.deepEqual(tagsConfigResponse.payload, { ok: true, config: { baseUrl: 'http://gw/v1', model: 'm', hasKey: true, auto: true } });
  const tagsConfigSaveResponse = response();
  await app.routes.get('PUT /api/songtags/config')({ body: { model: 'next' } }, tagsConfigSaveResponse);
  assert.equal(tagsConfigSaveResponse.payload.ok, true);
  const libraryResponse = response();
  await app.routes.get('POST /api/library/import')({ body: { provider: 'ncm' } }, libraryResponse);
  assert.equal(libraryResponse.statusCode, 202);
  assert.deepEqual(calls, [
    ['warm', { radiohostId: 'a' }],
    ['reflection', { radiohostId: 'a', window: 'short' }],
    ['taste', { dryRun: true }],
    ['tags', { force: true }],
    ['tags-list', { search: 'eason', limit: '50', offset: undefined }],
    ['tags-update', { provider: 'ncm', songId: '1', patch: { mood: '平静' } }],
    ['tags-remove', { provider: 'ncm', songId: '1' }],
    ['tags-config', { model: 'next' }],
    ['library-import', { provider: 'ncm' }],
  ]);
});
