import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerRadioRoutes } from './radioRoutes.js';

function fixture(handler) {
  const routes = new Map();
  registerRadioRoutes({ post: (path, route) => routes.set(path, route) }, { radioRequestService: { handleChat: handler } });
  const req = Object.assign(new EventEmitter(), { body: { message: '你好', requestId: 'r', sessionId: 's', interruptRequestId: 'old' } });
  const lines = [];
  const headers = {};
  const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader: (key, value) => { headers[key] = value; },
    flushHeaders() {}, write(line) { lines.push(JSON.parse(line)); return true; }, end() { this.ended = true; },
    status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; } });
  return { req, res, routes, lines, headers };
}

test('JSON-lines route scopes drafts and final result, and forces tool-free mode', async () => {
  const h = fixture(async input => {
    assert.equal(input.mode, 'text_stream');
    assert.equal(input.interruptRequestId, 'old');
    input.onDraft({ type: 'delta', text: '片段', sessionId: 's', requestId: 'r', roundId: 'r', virtualPersonId: 'lunara', attempt: 1 });
    assert.equal(h.lines.at(-1).text, '片段');
    assert.equal(h.res.ended, undefined);
    return { ok: true, sessionId: 's', requestId: 'r', displayText: '完整文本' };
  });
  await h.routes.get('/api/chat/stream')(h.req, h.res);
  assert.deepEqual(h.lines.map(e => e.type), ['start', 'delta', 'result']);
  assert.match(h.headers['content-type'], /ndjson/);
  assert.equal(h.headers['cache-control'], 'no-store');
  assert.equal(h.res.ended, true);
});

test('disconnect cancels exactly the signal for this request, without a global cancel', async () => {
  let signal;
  const h = fixture(async input => { signal = input.signal; h.res.emit('close'); return {}; });
  await h.routes.get('/api/chat/stream')(h.req, h.res);
  assert.equal(signal.aborted, true);
  assert.deepEqual(h.lines.map(e => e.type), ['start']);
});

test('provider exceptions never become visible error details', async () => {
  const h = fixture(async () => { throw new Error('secret credential raw-stack'); });
  await h.routes.get('/api/chat/stream')(h.req, h.res);
  assert.equal(h.lines.at(-1).type, 'error');
  assert.doesNotMatch(JSON.stringify(h.lines), /secret|credential|raw-stack/);
});

test('normal chat only forwards a string interruption, not client callbacks or stream mode', async () => {
  let input;
  const h = fixture(async value => { input = value; return { ok: true }; });
  h.req.body.onDraft = 'injected'; h.req.body.mode = 'text_stream';
  await h.routes.get('/api/chat')(h.req, h.res);
  assert.equal(input.interruptRequestId, 'old');
  assert.equal(input.onDraft, undefined);
  assert.equal(input.mode, undefined);
});

test('normal chat forwards only the heard occurrence fields of a playback identity', async () => {
  const inputs = [];
  const h = fixture(async value => { inputs.push(value); return { ok: true }; });
  h.req.body.cursor = 3;
  h.req.body.playbackIdentity = { listeningSessionId: 's', queueItemId: 'q1', songId: 'song', sourceUrl: '/secret.mp3', nested: { x: 1 } };
  await h.routes.get('/api/chat')(h.req, h.res);
  h.req.body.playbackIdentity = { listeningSessionId: 's', queueItemId: 42 };
  await h.routes.get('/api/chat')(h.req, h.res);
  assert.deepEqual(inputs[0].playbackIdentity, { listeningSessionId: 's', queueItemId: 'q1', songId: 'song' });
  assert.equal('cursor' in inputs[0], false);
  assert.equal('playbackIdentity' in inputs[1], false);
});
