import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ConversationStore } from './ConversationStore.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonService } from './VirtualPersonService.js';
import { registerVirtualPersonRoutes } from '../http/routes/virtualPersonRoutes.js';

function setup({ busy = false } = {}) {
  const db = new Database(':memory:');
  const conversationStore = new ConversationStore({ db });
  const submitted = [];
  const service = new VirtualPersonService({
    registry: new VirtualPersonRegistry({ db }), conversationStore,
    runtime: { presenceActivity: () => ({ busy }), cancel: () => false },
    playbackRuntime: { submit: async event => { submitted.push(event); return { accepted: true }; }, snapshot: () => ({}) },
  }).initialize();
  conversationStore.createRoom({ sessionId: 's', memberIds: ['lunara'] });
  const turns = [1, 2].map(n => {
    const { turn } = conversationStore.beginRequest({ sessionId: 's', requestId: `rq-${n}`, virtualPersonId: 'lunara', userText: `第${n}句` });
    conversationStore.completeRequest({ requestId: `rq-${n}`, virtualPersonId: 'lunara', message: { content: `回应${n}` } });
    return turn;
  });
  return { service, conversationStore, turns, submitted };
}

function fakeApp() {
  const routes = new Map();
  return { routes, get() {}, patch() {}, delete() {}, post(path, handler) { routes.set(path, handler); } };
}

function response() {
  return { statusCode: 200, body: null, headersSent: false,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; this.headersSent = true; return this; } };
}

async function call(app, path, params, body) {
  const res = response();
  await app.routes.get(path)({ params, body, query: {} }, res, error => { throw error; });
  return res;
}

test('rewind hides the edited exchange from the transcript and refuses while the room is answering', async () => {
  const { service, turns } = setup();
  assert.deepEqual(service.rewind('s', turns[1].turnId), { turnId: turns[1].turnId, text: '第2句' });
  assert.deepEqual(service.transcript('s').map(turn => turn.text), ['第1句', '回应1']);

  const busy = setup({ busy: true });
  assert.throws(() => busy.service.rewind('s', busy.turns[0].turnId), error => error.statusCode === 409);
  assert.equal(busy.service.transcript('s').length, 4);
});

test('fork creates a room with prior history and registers it as a listening session without switching to it', async () => {
  const { service, turns, submitted } = setup();
  const { conversation, text } = await service.fork('s', turns[1].turnId);
  assert.equal(text, '第2句');
  assert.deepEqual(service.transcript(conversation.sessionId).map(turn => turn.text), ['第1句', '回应1']);
  assert.deepEqual(submitted.map(event => event.type), ['LISTENING_SESSION_CREATED']);
  assert.equal(submitted[0].listeningSessionId, conversation.sessionId);
});

test('rewind and fork routes map invalid targets and busy rooms to correctable statuses', async () => {
  const { service, turns } = setup();
  const app = fakeApp();
  registerVirtualPersonRoutes(app, { virtualPersonService: service });

  const missing = await call(app, '/api/conversations/:sessionId/rewind', { sessionId: 's' }, { turnId: 'turn_missing' });
  assert.equal(missing.statusCode, 404);
  const reply = service.transcript('s').find(turn => turn.role === 'assistant');
  const wrongRole = await call(app, '/api/conversations/:sessionId/fork', { sessionId: 's' }, { turnId: reply.turnId });
  assert.equal(wrongRole.statusCode, 400);

  const forked = await call(app, '/api/conversations/:sessionId/fork', { sessionId: 's' }, { turnId: turns[1].turnId });
  assert.equal(forked.body.ok, true);
  assert.equal(forked.body.text, '第2句');
  assert.ok(forked.body.conversation.sessionId);

  const rewound = await call(app, '/api/conversations/:sessionId/rewind', { sessionId: 's' }, { turnId: turns[0].turnId });
  assert.deepEqual(rewound.body, { ok: true, turnId: turns[0].turnId, text: '第1句' });

  const busy = setup({ busy: true });
  const busyApp = fakeApp();
  registerVirtualPersonRoutes(busyApp, { virtualPersonService: busy.service });
  const refused = await call(busyApp, '/api/conversations/:sessionId/rewind', { sessionId: 's' }, { turnId: busy.turns[0].turnId });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.body.ok, false);
});
