import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConversationStore, presenceTurnId } from './ConversationStore.js';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-conversation-'));
  const dbPath = join(dir, 'state.db');
  const store = new ConversationStore({ dbPath }).initialize();
  return Promise.resolve(run({ store, dbPath })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test('actual track narration survives restart, replays once and belongs to its narrator and room', async () => {
  await withStore(({ store, dbPath }) => {
    store.createRoom({ sessionId: 'listening', memberIds: ['a', 'b'], hostId: 'a' });
    const intro = { sessionId: 'listening', personId: 'b', correlationId: 'transition:1', queueItemId: 'queue:item-one',
      text: '接下来是歌手的这首歌。', track: { songId: '1', title: '这首歌', artist: '歌手', source: 'qq' } };
    store.recordTrackIntro(intro);
    const reopened = new ConversationStore({ dbPath }).initialize();
    try {
      reopened.recordTrackIntro({ ...intro, correlationId: 'transition:2' });
      const turns = reopened.listTurns('listening', { visibleOnly: true });
      assert.equal(turns.length, 1);
      assert.equal(turns[0].speakerVirtualPersonId, 'b');
      assert.equal(turns[0].message.presentation, 'track_intro');
      assert.equal(turns[0].message.queueItemId, 'queue:item-one');
      assert.equal(turns[0].message.tracks[0].queueItemId, 'queue:item-one');
      assert.equal(turns[0].message.tracks[0].title, '这首歌');
      assert.equal(reopened.recentEncounters('a').length, 1);
      assert.equal(reopened.recentEncounters('c').length, 0);
    } finally { reopened.close(); }
  });
});

test('committed turns survive restart and running turns stay isolated', async () => {
  await withStore(({ store, dbPath }) => {
    const first = store.beginRequest({
      sessionId: 'session-a', requestId: 'request-1', virtualPersonId: 'lunara', userText: '你记得我吗？',
    });
    store.completeRequest({
      requestId: 'request-1',
      virtualPersonId: 'lunara',
      message: { role: 'assistant', content: '记得这段对话。' },
      result: { ok: true, displayText: '记得这段对话。' },
    });
    store.beginRequest({
      sessionId: 'session-a', requestId: 'request-running', virtualPersonId: 'lunara', userText: '还没完成',
    });

    assert.deepEqual(store.listModelMessages('session-a').map(message => message.content), [
      '你记得我吗？', '记得这段对话。',
    ]);
    assert.equal(store.listModelMessages('session-a', { includeRequestId: 'request-running' }).at(-1).content, '还没完成');
    assert.equal(first.turn.sequence, 1);

    store.close();
    const reopened = new ConversationStore({ dbPath }).initialize();
    assert.equal(reopened.getRequest('request-running').state, 'failed');
    assert.equal(reopened.listTurns('session-a', { visibleOnly: true }).at(-1).visibleText, '上一轮对话意外中断了。');
    reopened.close();
    store.db = null;
  });
});

test('tool calls and matching results retain provider message structure', async () => {
  await withStore(({ store }) => {
    store.beginRequest({
      sessionId: 'session-tool', requestId: 'request-tool', virtualPersonId: 'lunara', userText: '查一下',
    });
    store.appendMessage({
      sessionId: 'session-tool', requestId: 'request-tool', role: 'assistant', visibility: 'internal',
      message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
    });
    store.appendMessage({
      sessionId: 'session-tool', requestId: 'request-tool', role: 'tool', visibility: 'internal',
      message: { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
    });
    store.completeRequest({
      requestId: 'request-tool', virtualPersonId: 'lunara',
      message: { role: 'assistant', content: '查到了。' }, result: { ok: true },
    });
    const messages = store.listModelMessages('session-tool');
    assert.equal(messages[1].tool_calls[0].id, 'call-1');
    assert.equal(messages[2].tool_call_id, 'call-1');
    assert.equal(messages[3].content, '查到了。');
  });
});

test('request ids are idempotent after completion', async () => {
  await withStore(({ store }) => {
    store.beginRequest({ sessionId: 's', requestId: 'same', virtualPersonId: 'lunara', userText: '一次' });
    store.completeRequest({
      requestId: 'same', virtualPersonId: 'lunara', message: { role: 'assistant', content: '完成' },
      result: { ok: true, displayText: '完成' },
    });
    const replay = store.beginRequest({ sessionId: 's', requestId: 'same', virtualPersonId: 'lunara', userText: '重复' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.displayText, '完成');
    assert.equal(store.listTurns('s', { visibleOnly: true }).length, 2);
  });
});

test('presentation delivery uses a reclaimable lease and a terminal delivered state', async () => {
  await withStore(({ store }) => {
    let now = 100_000;
    store.now = () => now;
    store.beginRequest({ sessionId: 's', requestId: 'r', virtualPersonId: 'lunara', userText: '你好' });
    store.completeRequest({
      requestId: 'r', virtualPersonId: 'lunara',
      message: { role: 'assistant', content: '你好。' }, result: { ok: true },
    });
    assert.equal(store.claimPresentation('r'), true);
    assert.equal(store.claimPresentation('r'), false);
    assert.equal(store.getRequest('r').presentationState, 'delivering');
    now += 31_000;
    assert.equal(store.claimPresentation('r'), true);
    assert.equal(store.completePresentation('r'), true);
    assert.equal(store.getRequest('r').presentationState, 'delivered');
    assert.equal(store.claimPresentation('r'), false);
  });
});

test('conversation summaries persist auditable source ranges and revisions', async () => {
  await withStore(({ store }) => {
    store.beginRequest({ sessionId: 'summary', requestId: 'r', virtualPersonId: 'lunara', userText: '很久以前的话' });
    store.completeRequest({
      requestId: 'r', virtualPersonId: 'lunara',
      message: { role: 'assistant', content: '旧回复' }, result: { ok: true },
    });
    const first = store.saveSummary({
      sessionId: 'summary', fromSequence: 1, toSequence: 2,
      content: 'user: 很久以前的话\nassistant: 旧回复', method: 'deterministic-fallback',
    });
    const duplicate = store.saveSummary({
      sessionId: 'summary', fromSequence: 1, toSequence: 2,
      content: first.content, method: 'deterministic-fallback',
    });
    assert.equal(first.revision, 1);
    assert.equal(duplicate.summaryId, first.summaryId);
    assert.deepEqual(store.listSummaries('summary').map(item => [item.fromSequence, item.toSequence]), [[1, 2]]);
    assert.equal(store.getSession('summary').summaryRevision, 1);
  });
});

test('pinned and unread flags persist, clear and reorder the room list', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'room-old', title: '旧聊天', memberIds: ['lunara'] });
    store.createRoom({ sessionId: 'room-new', title: '新聊天', memberIds: ['lunara'] });
    // last_turn_at 相同的情况下按 pinned 优先；先验证默认顺序。
    assert.deepEqual(store.listRooms().map(room => room.sessionId), ['room-new', 'room-old']);

    const pinned = store.updateRoom('room-old', { pinned: true });
    assert.ok(pinned.pinnedAt > 0);
    assert.equal(store.updateRoom('room-new', { unread: true }).unreadAt > 0, true);
    assert.deepEqual(store.listRooms().map(room => room.sessionId), ['room-old', 'room-new']);
    assert.equal(store.listRooms()[0].pinnedAt > 0, true);
    assert.equal(store.listRooms()[1].unreadAt > 0, true);

    // 取消置顶并标记已读：两个标记都必须能清空。
    assert.equal(store.updateRoom('room-old', { pinned: false }).pinnedAt, null);
    assert.equal(store.updateRoom('room-new', { unread: false }).unreadAt, null);
    assert.deepEqual(store.listRooms().map(room => room.sessionId), ['room-new', 'room-old']);
    // 归档过滤不改变新字段的投影。
    store.updateRoom('room-new', { archived: true });
    assert.deepEqual(store.listRooms({ includeArchived: true }).map(room => room.sessionId), ['room-new', 'room-old']);
  });
});

test('deleteRoom removes a session with every dependent record exactly once', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'doomed', title: '待删聊天', memberIds: ['lunara', 'a'] });
    store.beginRequest({ sessionId: 'doomed', requestId: 'req-1', virtualPersonId: 'lunara', userText: '记住这首歌' });
    store.completeRequest({
      requestId: 'req-1', virtualPersonId: 'lunara',
      message: { role: 'assistant', content: '好的。' }, result: { ok: true },
    });
    store.saveSummary({ sessionId: 'doomed', fromSequence: 1, toSequence: 2, content: 'user: 记住这首歌', method: 'deterministic-fallback' });
    store.updateRoom('doomed', { pinned: true, unread: true });
    assert.ok(store.getSession('doomed'));
    assert.ok(store.db.prepare('SELECT 1 FROM conversation_observations LIMIT 1').get());

    assert.equal(store.deleteRoom('doomed'), true);
    assert.equal(store.getSession('doomed'), null);
    for (const table of ['conversation_turns', 'conversation_requests', 'conversation_rounds', 'conversation_summaries', 'conversation_members']) {
      assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get('doomed').n, 0, table);
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM conversation_observations').get().n, 0);
    // 重复删除是调用方可纠正的错误，而不是静默成功。
    assert.throws(() => store.deleteRoom('doomed'), /not found/);
    // 其他会话不受影响。
    store.createRoom({ sessionId: 'survivor', memberIds: ['lunara'] });
    assert.ok(store.getSession('survivor'));
  });
});

test('lastUserTurnAt reads the latest committed listener turn of one room', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'room', memberIds: ['lunara'] });
    assert.equal(store.lastUserTurnAt('room'), null);
    assert.equal(store.lastUserTurnAt('missing'), null);
    store.recordTrackIntro({ sessionId: 'room', personId: 'lunara', correlationId: 'c1', queueItemId: 'q1', text: '下一首。',
      track: { songId: 's1', title: '歌', artist: '歌手', source: 'qq' } });
    assert.equal(store.lastUserTurnAt('room'), null, '她的串词不是用户发言');
    store.beginRound({ sessionId: 'room', roundId: 'r1', userText: '你好', responsePlan: [{ personId: 'lunara' }] });
    assert.ok(store.lastUserTurnAt('room') > 0);
  });
});

test('presence turn: deterministic id, idempotent, visible, no user turn/request/observation, survives restart', async () => {
  await withStore(({ store, dbPath }) => {
    store.createRoom({ sessionId: 'room', memberIds: ['lunara', 'b'], hostId: 'lunara' });
    const input = { sessionId: 'room', personId: 'lunara', triggerKey: 'room/lunara/track_completed/q1:c1',
      kind: 'track_completed', text: '这首听完，房间好像安静了一点。', sourceRefs: ['moment', 'track'] };
    const turn = store.recordPresenceTurn(input);
    assert.match(turn.turnId, /^presence:[0-9a-f]{32}$/);
    assert.equal(turn.turnId, presenceTurnId(input.triggerKey));
    assert.equal(turn.role, 'assistant');
    assert.equal(turn.requestId, null);
    assert.deepEqual(turn.message.presence, { kind: 'track_completed', triggerKey: input.triggerKey, sourceRefs: ['moment', 'track'] });
    assert.equal(store.recordPresenceTurn(input), null, '重放不新增');
    assert.equal(store.recordPresenceTurn({ ...input, triggerKey: 'x', personId: 'stranger' }), null, '非成员不能开口');
    assert.equal(store.recordPresenceTurn({ ...input, triggerKey: 'y', sessionId: 'missing' }), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = ?').get('room').n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM conversation_requests').get().n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM conversation_observations').get().n, 0);
    assert.equal(store.lastUserTurnAt('room'), null);
    assert.deepEqual(store.recentSpokenLines('room', 'lunara'), ['这首听完，房间好像安静了一点。']);
    const reopened = new ConversationStore({ dbPath }).initialize();
    try {
      const [restored] = reopened.listTurns('room', { visibleOnly: true });
      assert.equal(restored.turnId, turn.turnId);
      assert.equal(restored.message.presentation, 'presence');
      assert.equal(reopened.recordPresenceTurn(input), null, '重启后同一触发仍只有一行');
    } finally { reopened.close(); }
  });
});

test('canReadTurn never infers a disclosure policy from presence text', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'room', memberIds: ['lunara', 'b'], hostId: 'lunara' });
    // 文本里有「只告诉你」也不该被当成用户的私密声明。
    const turn = store.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'k', kind: 'session_open',
      text: '只告诉你，这首我也很喜欢。', sourceRefs: ['moment'] });
    assert.equal(store.canReadTurn('b', turn, { isGroup: true }), true);
  });
});

test('presence turns survive recovery untouched and are removed with their room', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
    store.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'k', kind: 'session_open', text: '来了。', sourceRefs: ['moment'] });
    assert.equal(store.recoverIncomplete(), 0, '没有请求可恢复：不补安全失败句');
    assert.deepEqual(store.listTurns('room').map(turn => turn.visibleText), ['来了。']);
    store.deleteRoom('room');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM conversation_turns WHERE turn_id LIKE 'presence:%'").get().n, 0);
  });
});

test('headSequence: 任何一行入账都推进，ambient turn 靠它判断模型调用期间聊天是否前进', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
    assert.equal(store.headSequence('missing'), null);
    const start = store.headSequence('room');
    assert.equal(typeof start, 'number');
    store.recordTrackIntro({ sessionId: 'room', personId: 'lunara', correlationId: 'c1', queueItemId: 'q1', text: '下一首。',
      track: { songId: 's1', title: '歌', artist: '歌手', source: 'qq' } });
    const afterIntro = store.headSequence('room');
    assert.ok(afterIntro > start, '串词入账推进');
    store.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'k', kind: 'ambient', text: '嗯。' });
    assert.ok(store.headSequence('room') > afterIntro, '主动开口入账推进');
  });
});
