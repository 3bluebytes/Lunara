import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../../app/createHttpApp.js';
import { registerTrackLikeRoutes } from './trackLikeRoutes.js';

async function fixture(t, service) {
  const app = createHttpApp();
  registerTrackLikeRoutes(app, { trackLikeService: service });
  const server = await new Promise(done => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

function stubService(overrides = {}) {
  const calls = [];
  return {
    calls,
    getLike: (provider, songId) => (provider === 'ncm' && songId === '186016'
      ? { provider, songId, desired: true, remoteState: 'synced' } : null),
    resolveLike: async ({ provider, songId }) => ({
      like: provider === 'ncm' && songId === '186016'
        ? { provider, songId, desired: true, remoteState: 'synced' } : null,
      adopted: false,
      canWriteRemote: provider === 'ncm',
      readError: null,
    }),
    canWriteRemote: provider => provider === 'ncm',
    setLike: async input => { calls.push(input); return { ok: true, like: { ...input, remoteState: 'synced', desired: input.desired }, idempotent: false }; },
    retry: async input => ({ ok: true, like: { provider: input.provider, songId: input.songId, desired: true, remoteState: 'synced' } }),
    ...overrides,
  };
}

test('unknown music sources are rejected instead of hitting the provider layer', async t => {
  const service = stubService();
  const origin = await fixture(t, service);
  const response = await fetch(`${origin}/api/track-like`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'kugou', songId: 'x', desired: true }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'unknown_provider');
  assert.equal(service.calls.length, 0);
});

test('desired must be an explicit boolean and requestId must be a token', async t => {
  const service = stubService();
  const origin = await fixture(t, service);
  const post = body => fetch(`${origin}/api/track-like`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  assert.equal((await post({ provider: 'ncm', songId: '186016', desired: 'yes' })).status, 400);
  const badRequestId = await post({ provider: 'ncm', songId: '186016', desired: true, requestId: 'has space' });
  assert.equal(badRequestId.status, 400);
  assert.equal((await badRequestId.json()).code, 'invalid_request_id');
  assert.equal(service.calls.length, 0);
});

test('a successful write reports intent saved plus the remote state', async t => {
  const service = stubService();
  const origin = await fixture(t, service);
  const response = await fetch(`${origin}/api/track-like`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ncm', songId: '186016', desired: true, requestId: 'r-1' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.like.remoteState, 'synced');
  assert.equal(body.idempotent, false);
  assert.equal(body.sync, null);
  assert.deepEqual(service.calls[0], { provider: 'ncm', songId: '186016', desired: true, requestId: 'r-1' });
});

test('a failed mirror still answers 200 but exposes the sync reason', async t => {
  const service = stubService({
    setLike: async input => ({ ok: false, reason: 'not_collectable', retryable: false,
      like: { ...input, remoteState: 'failed', desired: input.desired } }),
  });
  const origin = await fixture(t, service);
  const response = await fetch(`${origin}/api/track-like`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ncm', songId: '186016', desired: true }),
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.like.remoteState, 'failed');
  assert.deepEqual(body.sync, { reason: 'not_collectable', retryable: false });
});

test('reading a like state reports whether the source can write at all', async t => {
  const service = stubService();
  const origin = await fixture(t, service);

  const known = await (await fetch(`${origin}/api/track-like?provider=ncm&songId=186016`)).json();
  assert.equal(known.like.remoteState, 'synced');
  assert.equal(known.canWriteRemote, true);

  const unknown = await (await fetch(`${origin}/api/track-like?provider=qq&songId=186016`)).json();
  assert.equal(unknown.like, null);
  assert.equal(unknown.canWriteRemote, false);

  assert.equal((await fetch(`${origin}/api/track-like?provider=nope&songId=1`)).status, 400);
});

test('a song found in the remote playlist comes back as adopted, not as unliked', async t => {
  const service = stubService({
    resolveLike: async ({ provider, songId }) => ({
      like: { provider, songId, desired: true, remoteState: 'synced' },
      adopted: true,
      canWriteRemote: true,
      readError: null,
    }),
  });
  const origin = await fixture(t, service);
  const body = await (await fetch(`${origin}/api/track-like?provider=ncm&songId=1398654758`)).json();

  assert.equal(body.adopted, true);
  assert.equal(body.like.desired, true);
  assert.equal(body.readError, null);
});

test('an unreadable remote state is reported instead of being rendered as unliked', async t => {
  const service = stubService({
    resolveLike: async () => ({ like: null, adopted: false, canWriteRemote: true, readError: 'not_logged_in' }),
  });
  const origin = await fixture(t, service);
  const body = await (await fetch(`${origin}/api/track-like?provider=ncm&songId=1398654758`)).json();

  assert.equal(body.like, null);
  assert.equal(body.readError, 'not_logged_in');
});

test('retry answers 404 when there is no intent to retry', async t => {
  const origin = await fixture(t, stubService({ retry: async () => ({ ok: false, reason: 'no_intent' }) }));
  const response = await fetch(`${origin}/api/track-like/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'ncm', songId: '186016' }),
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'no_intent');
});

test('the route is inert when the service is missing', async t => {
  const origin = await fixture(t, undefined);
  const response = await fetch(`${origin}/api/track-like?provider=ncm&songId=186016`);
  assert.equal(response.status, 503);
});
