import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore } from './ConversationStore.js';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-edit-fork-'));
  let clock = 1_000;
  const store = new ConversationStore({ dbPath: join(dir, 'state.db'), now: () => ++clock }).initialize();
  return Promise.resolve(run({ store })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function exchange(store, sessionId, n, userText = `第${n}句`) {
  const { turn } = store.beginRequest({ sessionId, requestId: `rq-${sessionId}-${n}`, virtualPersonId: 'lunara', userText });
  store.appendMessage({ sessionId, requestId: `rq-${sessionId}-${n}`, role: 'assistant',
    message: { content: '', tool_calls: [{ id: `call-${n}`, type: 'function', function: { name: 'x', arguments: '{}' } }] } });
  store.completeRequest({ requestId: `rq-${sessionId}-${n}`, virtualPersonId: 'lunara', message: { content: `回应${n}` } });
  return turn;
}

test('rewind supersedes the target user turn and everything after it without deleting rows', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 's', memberIds: ['lunara'] });
    exchange(store, 's', 1);
    const second = exchange(store, 's', 2);
    exchange(store, 's', 3);
    store.saveSummary({ sessionId: 's', fromSequence: 1, toSequence: 3, content: '早先的摘要' });
    store.saveSummary({ sessionId: 's', fromSequence: 4, toSequence: 9, content: '覆盖被改写部分的摘要' });

    const result = store.rewindFromTurn('s', second.turnId);
    assert.equal(result.text, '第2句');
    assert.ok(result.supersededCount >= 6);

    assert.deepEqual(store.listTurns('s', { visibleOnly: true }).map(turn => turn.visibleText), ['第1句', '回应1']);
    assert.ok(store.listModelMessages('s').every(message => !/第2句|回应2|第3句/.test(message.content)));
    assert.deepEqual(store.listSummaries('s').map(summary => summary.content), ['早先的摘要']);
    const raw = store.db.prepare('SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = ? AND superseded_at IS NOT NULL').get('s');
    assert.equal(raw.n, result.supersededCount);
    assert.equal(store.getTurn(second.turnId).supersededAt != null, true);
    assert.ok(store.recentEncounters('lunara').every(turn => !/第2句|回应2/.test(turn.visibleText)));

    // 新的一轮接在改写点之前那条后面。
    exchange(store, 's', 4, '改写后的第2句');
    assert.deepEqual(store.listTurns('s', { visibleOnly: true }).map(turn => turn.visibleText),
      ['第1句', '回应1', '改写后的第2句', '回应4']);
  });
});

test('rewind rejects assistant, superseded and foreign turns and leaves the ledger unchanged', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 's', memberIds: ['lunara'] });
    store.createRoom({ sessionId: 'other', memberIds: ['lunara'] });
    const first = exchange(store, 's', 1);
    const foreign = exchange(store, 'other', 1);
    const reply = store.listTurns('s', { visibleOnly: true }).find(turn => turn.role === 'assistant');
    assert.throws(() => store.rewindFromTurn('s', reply.turnId), /user message/);
    assert.throws(() => store.rewindFromTurn('s', foreign.turnId), /not found/);
    assert.throws(() => store.rewindFromTurn('s', 'turn_missing'), /not found/);
    store.rewindFromTurn('s', first.turnId);
    assert.throws(() => store.rewindFromTurn('s', first.turnId), /not found/);
    assert.equal(store.listTurns('other', { visibleOnly: true }).length, 2);
  });
});

test('fork copies only visible history before the target into a new room with the same members', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 's', title: '深夜', memberIds: ['lunara', 'mira'], hostId: 'lunara' });
    exchange(store, 's', 1);
    const second = exchange(store, 's', 2);
    exchange(store, 's', 3);
    const before = store.listTurns('s').length;

    const { room, text } = store.forkFromTurn('s', second.turnId);
    assert.equal(text, '第2句');
    assert.notEqual(room.sessionId, 's');
    assert.equal(room.title, '深夜（分叉）');
    assert.deepEqual(room.memberIds, ['lunara', 'mira']);
    assert.equal(room.activeVirtualPersonId, 'lunara');
    const copied = store.listTurns(room.sessionId);
    assert.deepEqual(copied.map(turn => turn.visibleText), ['第1句', '回应1']);
    assert.ok(copied.every(turn => turn.requestId === null && turn.visibility === 'visible' && !turn.message.tool_calls));
    assert.deepEqual(store.listModelMessages(room.sessionId).map(message => message.role), ['user', 'assistant']);
    // 原聊天不变。
    assert.equal(store.listTurns('s').length, before);
  });
});

test('fork carries observation policies so restricted turns stay restricted', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 's', memberIds: ['lunara'] });
    exchange(store, 's', 1, '这件事只告诉你，别在群里说');
    const forgotten = exchange(store, 's', 2, '这句请忘掉');
    const target = exchange(store, 's', 3);
    store.revokeObservation('lunara', forgotten.turnId);

    const { room } = store.forkFromTurn('s', target.turnId);
    const copied = store.listTurns(room.sessionId, { visibleOnly: true });
    assert.deepEqual(copied.map(turn => turn.visibleText), ['这件事只告诉你，别在群里说', '回应1', '这句请忘掉', '回应2']);
    const policyOf = turn => JSON.parse(store.db.prepare('SELECT policy_json FROM conversation_observations WHERE person_id = ? AND turn_id = ?')
      .get('lunara', turn.turnId)?.policy_json || 'null');
    assert.equal(policyOf(copied[0]).disclosure, 'private');
    assert.equal(policyOf(copied[1]).disclosure, 'private');
    assert.equal(store.canReadTurn('lunara', copied[0], { sessionId: room.sessionId, isGroup: true }), false);
    // 已撤销（忘记）的观察不会因分叉复活。
    assert.equal(store.canReadTurn('lunara', copied[2], { sessionId: room.sessionId }), false);
    assert.equal(store.canReadTurn('lunara', copied[3], { sessionId: room.sessionId }), false);
  });
});

test('fork from the first message creates an empty room and does not copy superseded turns', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 's', memberIds: ['lunara'] });
    const first = exchange(store, 's', 1);
    const second = exchange(store, 's', 2);
    assert.equal(store.forkFromTurn('s', first.turnId).room.title, '分叉的聊天');
    assert.equal(store.listTurns(store.forkFromTurn('s', first.turnId).room.sessionId).length, 0);
    store.rewindFromTurn('s', second.turnId);
    assert.throws(() => store.forkFromTurn('s', second.turnId), /not found/);
  });
});
