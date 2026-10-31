import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../../app/createHttpApp.js';
import { registerRecordingReviewRoutes } from './recordingReviewRoutes.js';

async function fixture(t, service) {
  const app = createHttpApp();
  registerRecordingReviewRoutes(app, { recordingReviewService: service });
  const server = await new Promise(done => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
  t.after(() => new Promise(done => server.close(done)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('reading proposals never calls the mutation methods', async t => {
  let mutations = 0;
  const origin = await fixture(t, { snapshot: () => ({ proposals: [] }), confirm: () => mutations++ });
  const response = await fetch(`${origin}/api/library/recordings`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { proposals: [] });
  assert.equal(mutations, 0);
});

test('confirm is POST-only and protected by the local JSON boundary', async t => {
  let calls = 0;
  const origin = await fixture(t, { confirm: body => { calls++; return { ok: true, requestId: body.requestId }; } });
  assert.equal((await fetch(`${origin}/api/library/recordings/confirm`)).status, 404);
  assert.equal((await fetch(`${origin}/api/library/recordings/confirm`, { method: 'POST', body: 'plain form' })).status, 415);
  assert.equal(calls, 0);
  const accepted = await fetch(`${origin}/api/library/recordings/confirm`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{"requestId":"local-confirm"}' });
  assert.equal(accepted.status, 200);
  assert.equal(calls, 1);
});

test('internal failures do not echo SQL, private metadata, paths or stacks', async t => {
  const origin = await fixture(t, { snapshot: () => { throw new Error('SQLite at /private/state.db with token=secret'); } });
  const response = await fetch(`${origin}/api/library/recordings`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /SQLite|private|secret|token|stack/);
});
