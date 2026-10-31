import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppState } from '../../core/appState.js';
import { createConversationController } from './conversationController.js';

const TURNS = [
  { turnId: 'turn_u1', role: 'user', text: '第1句', sequence: 1 },
  { turnId: 'turn_a1', role: 'assistant', text: '回应1', sequence: 2 },
  { turnId: 'turn_u2', role: 'user', text: '第2句', sequence: 3 },
  { turnId: 'turn_a2', role: 'assistant', text: '回应2', sequence: 4 },
];

function fixture({ rewind = async () => ({ ok: true }) } = {}) {
  const rooms = [{ sessionId: 'one', memberIds: ['a'], activeVirtualPersonId: 'a' }];
  const store = createAppState({ sessionId: 'one', virtualPersons: [{ id: 'a', displayName: 'A' }],
    runtimeState: { activeListeningSessionId: 'one' } });
  const calls = [];
  const transcripts = { one: [...TURNS] };
  const errors = [];
  const apiClient = {
    get: async path => {
      if (path.startsWith('/api/conversations?')) return { conversations: rooms };
      const sid = path.split('/')[3];
      return { sessionId: decodeURIComponent(sid), turns: transcripts[decodeURIComponent(sid)] || [] };
    },
    post: async (path, body) => {
      calls.push(['post', path, body]);
      if (path.endsWith('/rewind')) return rewind(path, body);
      if (path.endsWith('/fork')) {
        rooms.push({ sessionId: 'fork-1', memberIds: ['a'], activeVirtualPersonId: 'a', title: '（分叉）' });
        transcripts['fork-1'] = TURNS.slice(0, 2);
        return { ok: true, conversation: rooms.at(-1), text: '第2句' };
      }
      return { ok: true };
    },
    chat: async payload => {
      calls.push(['chat', payload.message]);
      transcripts.one = [...TURNS.slice(0, 2), { turnId: 'turn_u3', role: 'user', text: payload.message, sequence: 5, createdAt: Date.now() }];
      return { ok: true };
    },
  };
  const controller = createConversationController({ store, apiClient, onError: error => errors.push(error) });
  return { store, controller, calls, errors };
}

test('starting and cancelling an edit only touches the composer, never the server', async () => {
  const h = fixture();
  await h.controller.refresh(); await h.controller.select('one');
  assert.equal(h.controller.beginEdit('turn_u2'), true);
  const view = h.controller.snapshot().local;
  assert.deepEqual(view.edit, { turnId: 'turn_u2', text: '第2句' });
  assert.equal(view.draft, '第2句');
  assert.equal(view.restoreDraft, true);
  h.controller.cancelEdit();
  assert.equal(h.controller.snapshot().local.edit, null);
  assert.equal(h.controller.snapshot().local.draft, '');
  assert.equal(h.controller.snapshot().local.turns.length, 4);
  assert.deepEqual(h.calls, []);
});

test('an edit does not overwrite a different unsent draft, and assistant turns are not editable', async () => {
  const h = fixture();
  await h.controller.refresh(); await h.controller.select('one');
  h.controller.saveView({ draft: '还没发的草稿', scroll: null });
  assert.equal(h.controller.beginEdit('turn_u2'), false);
  assert.equal(h.controller.snapshot().local.draft, '还没发的草稿');
  assert.equal(h.controller.beginEdit('turn_a1'), false);
  assert.equal(h.controller.snapshot().local.edit, null);
  assert.equal(h.errors.length, 1);
});

test('sending an edit rewinds first, then sends through the normal chat path', async () => {
  const h = fixture();
  await h.controller.refresh(); await h.controller.select('one');
  h.controller.beginEdit('turn_u2');
  await h.controller.send('改写后的第2句');
  assert.deepEqual(h.calls.map(call => call.slice(0, 2)), [
    ['post', '/api/conversations/one/rewind'], ['chat', '改写后的第2句']]);
  assert.deepEqual(h.calls[0][2], { turnId: 'turn_u2' });
  assert.equal(h.controller.snapshot().local.edit, null);
  assert.deepEqual(h.controller.snapshot().local.turns.map(turn => turn.text), ['第1句', '回应1', '改写后的第2句']);
});

test('a failed rewind restores the draft and the pending edit without sending chat', async () => {
  const h = fixture({ rewind: async () => { throw new Error('正在回应，等这一轮结束再改写。'); } });
  await h.controller.refresh(); await h.controller.select('one');
  h.controller.beginEdit('turn_u2');
  await h.controller.send('改写后的第2句');
  assert.deepEqual(h.calls.map(call => call[0]), ['post']);
  const view = h.controller.snapshot().local;
  assert.deepEqual(view.edit, { turnId: 'turn_u2', text: '第2句' });
  assert.equal(view.draft, '改写后的第2句');
  assert.equal(view.restoreDraft, true);
  assert.equal(view.turns.length, 4);
  assert.equal(h.errors.length, 1);
});

test('forking opens the new conversation with the message in its composer and leaves the listening source alone', async () => {
  const h = fixture();
  await h.controller.refresh(); await h.controller.select('one');
  const conversation = await h.controller.fork('turn_u2');
  assert.equal(conversation.sessionId, 'fork-1');
  assert.deepEqual(h.calls[0].slice(1), ['/api/conversations/one/fork', { turnId: 'turn_u2' }]);
  assert.equal(h.store.getState().sessionId, 'fork-1');
  assert.equal(h.store.getState().runtimeState.activeListeningSessionId, 'one');
  const view = h.controller.snapshot().local;
  assert.equal(view.draft, '第2句');
  assert.equal(view.edit, null);
  assert.deepEqual(view.turns.map(turn => turn.text), ['第1句', '回应1']);
  // 原聊天不受影响。
  assert.equal(h.controller.stateFor('one').turns.length, 4);
});
