import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppState } from '../../core/appState.js';
import { createConversationController } from './conversationController.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { resolve, reject, promise }; };

async function fixture() {
  const rooms = [{ sessionId: 's', memberIds: ['p'], activeVirtualPersonId: 'p' }, { sessionId: 'other', memberIds: ['q'], activeVirtualPersonId: 'q' }];
  const store = createAppState({ sessionId: 's', virtualPersons: [{ id: 'p' }, { id: 'q' }], runtimeState: { activeListeningSessionId: 's' } });
  const calls = [];
  const apiClient = { get: async path => path.includes('?archived=') ? { conversations: rooms }
    : { sessionId: path.includes('/other/') ? 'other' : 's', turns: [] },
    chat: async payload => { calls.push(payload); return { ok: true }; },
    post: async (...args) => { calls.push(args); return { ok: true }; } };
  const controller = createConversationController({ store, apiClient });
  await controller.refresh();
  return { controller, apiClient, calls, store };
}

test('explicit interjection sends prior identity and a distinct new request, old failure cannot restore input', async () => {
  const h = await fixture();
  const old = deferred(), next = deferred();
  h.apiClient.chat = async payload => { h.calls.push(payload); return h.calls.length === 1 ? old.promise : next.promise; };
  const first = h.controller.send('旧问题');
  const second = h.controller.send('新问题', { interrupt: true });
  assert.equal(h.calls[1].interruptRequestId, h.calls[0].requestId);
  assert.notEqual(h.calls[1].requestId, h.calls[0].requestId);
  old.reject(new Error('old network error'));
  await first;
  assert.equal(h.controller.snapshot().pending, true);
  assert.equal(h.controller.snapshot().local.draft, '');
  next.resolve({ ok: true }); await second;
  assert.equal(h.controller.snapshot().pending, false);
});

test('cancel uses the active request identity', async () => {
  const h = await fixture();
  const pending = deferred();
  h.apiClient.chat = async payload => { h.calls.push(payload); return pending.promise; };
  const sending = h.controller.send('你好');
  await h.controller.cancel();
  assert.equal(h.calls[1][1].requestId, h.calls[0].requestId);
  pending.resolve({ ok: true });
  await sending;
  assert.equal(h.controller.snapshot().pending, false);
});
