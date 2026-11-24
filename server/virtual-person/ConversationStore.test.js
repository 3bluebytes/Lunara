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

test('listTurns afterSequence returns only the turns after a compaction boundary, oldest first', async () => {
  await withStore(({ store }) => {
    for (const id of ['a', 'b', 'c']) {
      store.beginRequest({ sessionId: 's', requestId: id, virtualPersonId: 'lunara', userText: `问${id}` });
      store.completeRequest({ requestId: id, virtualPersonId: 'lunara', message: { role: 'assistant', content: `答${id}` } });
    }
    const all = store.listTurns('s', { limit: 500 });
    const boundary = all[1].sequence;
    assert.deepEqual(store.listTurns('s', { limit: 500, afterSequence: boundary }).map(turn => turn.visibleText),
      ['问b', '答b', '问c', '答c']);
    assert.deepEqual(store.listTurns('s', { limit: 500, afterSequence: all.at(-1).sequence }), []);
    assert.equal(store.listTurns('s', { limit: 500, afterSequence: 0 }).length, all.length);
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

test('每个聊天每个角色只保留最近 100 份摘要，另一个角色的不受影响', async () => {
  await withStore(({ store }) => {
    store.beginRequest({ sessionId: 'long', requestId: 'r', virtualPersonId: 'lunara', userText: '开头' });
    store.saveSummary({ sessionId: 'long', personId: 'night', fromSequence: 1, toSequence: 1, content: '夜航的摘要' });
    for (let i = 1; i <= 130; i += 1) {
      store.saveSummary({ sessionId: 'long', personId: 'lunara', fromSequence: 1, toSequence: 1, content: `摘要 ${i}` });
    }
    const count = person => store.db.prepare('SELECT COUNT(*) AS n FROM conversation_summaries WHERE session_id = ? AND person_id = ?')
      .get('long', person).n;
    assert.equal(count('lunara'), 100);
    assert.equal(count('night'), 1);
    assert.equal(store.listSummaries('long', { limit: 1, personId: 'lunara' })[0].content, '摘要 130');
    assert.equal(store.listSummaries('long', { limit: 1, personId: 'night' })[0].content, '夜航的摘要');
  });
});

test('摘要校验与逐条 canReadTurn 判断一致：保密、群聊、撤回', async () => {
  await withStore(({ store }) => {
    const say = (requestId, userText) => {
      const { turn } = store.beginRequest({ sessionId: 'mix', requestId, virtualPersonId: 'lunara', userText });
      store.completeRequest({ requestId, virtualPersonId: 'lunara', message: { content: '嗯。' } });
      return turn.turnId;
    };
    say('m1', '今天天气不错');
    const secret = say('m2', '别告诉别人，我在准备跳槽');
    say('m3', '放首歌吧');
    store.saveSummary({ sessionId: 'mix', personId: 'lunara', fromSequence: 1, toSequence: 6, content: '三句话' });
    const turns = store.listTurns('mix', { limit: 50 });
    const expected = isGroup => turns.every(turn => store.canReadTurn('lunara', turn, { isGroup }));
    const listed = isGroup => store.listSummaries('mix', { limit: 1, personId: 'lunara', isGroup }).length === 1;
    assert.equal(listed(false), expected(false));
    assert.equal(listed(true), expected(true));
    assert.equal(listed(false), true);
    assert.equal(listed(true), true, '保密的话她自己听到过，摘要在群聊里也照样给（提不提是她的分寸）');
    store.revokeObservation('lunara', secret);
    assert.equal(listed(false), expected(false));
    assert.equal(listed(false), false, '撤回后一对一也不再给');
  });
});

test('摘要校验与逐条 canReadTurn 一致：期限已过、限定别的聊天、策略读不懂、没有观察', async () => {
  await withStore(({ store }) => {
    const say = (requestId, userText) => {
      const { turn } = store.beginRequest({ sessionId: 'mix2', requestId, virtualPersonId: 'lunara', userText });
      store.completeRequest({ requestId, virtualPersonId: 'lunara', message: { content: '嗯。' } });
      return turn.turnId;
    };
    const first = say('n1', '今天天气不错');
    say('n2', '放首歌吧');
    store.saveSummary({ sessionId: 'mix2', personId: 'lunara', fromSequence: 1, toSequence: 4, content: '两句话' });
    const turns = store.listTurns('mix2', { limit: 50 });
    const check = (label, wanted) => {
      for (const isGroup of [false, true]) {
        const expected = turns.every(turn => store.canReadTurn('lunara', turn, { isGroup }));
        const listed = store.listSummaries('mix2', { limit: 1, personId: 'lunara', isGroup }).length === 1;
        assert.equal(listed, expected, `${label}（isGroup=${isGroup}）`);
      }
      assert.equal(store.listSummaries('mix2', { limit: 1, personId: 'lunara' }).length === 1, wanted, label);
    };
    const setPolicy = value => store.db.prepare('UPDATE conversation_observations SET policy_json = ? WHERE person_id = ? AND turn_id = ?')
      .run(value, 'lunara', first);
    check('普通', true);
    setPolicy(JSON.stringify({ disclosure: 'normal', until: Date.now() - 1000 }));
    check('期限已过（本聊天的历史不因期限消失）', true);
    setPolicy(JSON.stringify({ disclosure: 'normal', onlyConversationId: 'elsewhere' }));
    check('限定别的聊天', false);
    setPolicy('不是 JSON');
    check('策略读不懂', true);
    setPolicy('[1,2]');
    check('策略不是对象', true);
    store.db.prepare('DELETE FROM conversation_observations WHERE person_id = ? AND turn_id = ?').run('lunara', first);
    check('没有观察', true);
  });
});

test('摘要校验一次查完所有候选范围：读不了的回合只挡住覆盖它且没排除它的那几份', async () => {
  await withStore(({ store }) => {
    const say = (requestId, userText) => {
      const { turn } = store.beginRequest({ sessionId: 'mix3', requestId, virtualPersonId: 'lunara', userText });
      store.completeRequest({ requestId, virtualPersonId: 'lunara', message: { content: '嗯。' } });
      return turn.turnId;
    };
    const hidden = say('m1', '今天天气不错');
    say('m2', '放首歌吧');
    say('m3', '再来一首');
    store.db.prepare('UPDATE conversation_observations SET policy_json = ? WHERE person_id = ? AND turn_id = ?')
      .run(JSON.stringify({ disclosure: 'normal', onlyConversationId: 'elsewhere' }), 'lunara', hidden);
    store.saveSummary({ sessionId: 'mix3', personId: 'lunara', fromSequence: 1, toSequence: 2, content: '前两句' });
    store.saveSummary({ sessionId: 'mix3', personId: 'lunara', fromSequence: 3, toSequence: 6, content: '后四句' });
    store.saveSummary({ sessionId: 'mix3', personId: 'lunara', fromSequence: 1, toSequence: 6, content: '全部（已排除）',
      excludedTurnIds: [hidden] });
    store.saveSummary({ sessionId: 'mix3', personId: 'lunara', fromSequence: 1, toSequence: 6, content: '全部' });
    const listed = store.listSummaries('mix3', { limit: 10, personId: 'lunara' }).map(row => row.content);
    assert.deepEqual(listed, ['后四句', '全部（已排除）']);
  });
});

test('跨聊天摘录按聊天各取最新 k 条再合并：与对全部观察开窗排序的结果一致', async () => {
  await withStore(({ store }) => {
    let n = 0;
    for (let i = 0; i < 60; i += 1) {
      const sid = `enc${i % 5}`;
      const person = i % 7 === 3 ? 'b' : 'lunara';
      store.beginRequest({ sessionId: sid, requestId: `e${i}`, virtualPersonId: person, userText: `第 ${i} 句` });
      store.completeRequest({ requestId: `e${i}`, virtualPersonId: person, message: { content: `回 ${i}` } });
      n += 1;
    }
    // 同一时刻写下的回合、撤回的观察、被改写的回合
    store.db.prepare("UPDATE conversation_turns SET created_at = 1000 WHERE session_id = 'enc1'").run();
    const some = store.listTurns('enc2', { limit: 50 });
    store.db.prepare('UPDATE conversation_observations SET revoked_at = 1 WHERE turn_id = ?').run(some[0].turnId);
    store.db.prepare('UPDATE conversation_turns SET superseded_at = 1 WHERE turn_id = ?').run(some[1].turnId);
    const windowed = (personId, excludeSessionId, perSession) => store.db.prepare(`SELECT * FROM (SELECT t.*, t.rowid AS write_order,
        o.policy_json, ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.created_at DESC, t.sequence DESC) AS rank_in_session
      FROM conversation_observations o JOIN conversation_turns t ON t.turn_id = o.turn_id
      WHERE o.person_id = ? AND o.revoked_at IS NULL AND t.superseded_at IS NULL AND (? IS NULL OR t.session_id <> ?))
      WHERE rank_in_session <= ? ORDER BY created_at DESC, write_order DESC LIMIT ?`)
      .all(personId, excludeSessionId, excludeSessionId, perSession, 30 * perSession).reverse().map(row => row.turn_id);
    for (const [personId, exclude, k] of [['lunara', 'enc0', 3], ['lunara', null, 1], ['b', 'enc3', 8], ['lunara', 'enc4', 30]]) {
      assert.deepEqual(store.recentEncounters(personId, { excludeSessionId: exclude, perSession: k }).map(turn => turn.turnId),
        windowed(personId, exclude, k), `${personId} ${exclude} ${k}`);
    }
    assert.ok(n === 60);
  });
});

test('跨聊天摘录在凑够条数后提前停下，结果与逐个聊天全取一致；没观察过任何回合的角色直接为空', async () => {
  await withStore(({ store }) => {
    for (let i = 0; i < 40; i += 1) {
      const sid = `many${i}`;
      store.beginRequest({ sessionId: sid, requestId: `m${i}`, virtualPersonId: 'lunara', userText: `第 ${i} 句` });
      store.completeRequest({ requestId: `m${i}`, virtualPersonId: 'lunara', message: { content: `回 ${i}` } });
    }
    // 打乱活跃时间与回合时间的对应：较新的聊天里有更旧的回合（如沿用原时间的分叉副本）。
    store.db.prepare("UPDATE conversation_turns SET created_at = created_at - 100000 WHERE session_id = 'many39'").run();
    const all = store.db.prepare(`SELECT * FROM (SELECT t.turn_id, t.created_at, t.rowid AS write_order,
        ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY t.created_at DESC, t.sequence DESC) AS rank_in_session
      FROM conversation_observations o JOIN conversation_turns t ON t.turn_id = o.turn_id
      WHERE o.person_id = 'lunara' AND o.revoked_at IS NULL AND t.superseded_at IS NULL)
      WHERE rank_in_session <= 1 ORDER BY created_at DESC, write_order DESC LIMIT 30`).all().reverse().map(row => row.turn_id);
    let perSession = 0;
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => {
      const statement = prepare(sql);
      if (!/WHERE t\.session_id = \? AND t\.superseded_at IS NULL/.test(sql)) return statement;
      return { all: (...args) => { perSession += 1; return statement.all(...args); } };
    };
    assert.deepEqual(store.recentEncounters('lunara', { perSession: 1 }).map(turn => turn.turnId), all);
    assert.ok(perSession < 40, `提前停下（查了 ${perSession} 个聊天）`);
    perSession = 0;
    assert.deepEqual(store.recentEncounters('nobody', { perSession: 1 }), []);
    assert.equal(perSession, 0);
    store.db.prepare = prepare;
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

test('observersOf 列出看过这一回合的所有角色', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'g-obs', memberIds: ['lunara', 'night'] });
    const { turn } = store.beginRequest({ sessionId: 'g-obs', requestId: 'r-obs', virtualPersonId: 'lunara', userText: '大家好' });
    store.observeTurns(['night'], [turn.turnId]);
    assert.deepEqual(store.observersOf(turn.turnId).sort(), ['lunara', 'night']);
    assert.deepEqual(store.observersOf('missing-turn'), []);
  });
});

test('同一轮里共用 scan 的两次摘要读：只补扫新增尾部，结果与不共用时一致', async () => {
  await withStore(({ store }) => {
    const say = (requestId, userText) => {
      const { turn } = store.beginRequest({ sessionId: 'scan', requestId, virtualPersonId: 'lunara', userText });
      store.completeRequest({ requestId, virtualPersonId: 'lunara', message: { content: '嗯。' } });
      return turn.turnId;
    };
    say('s1', '今天天气不错');
    say('s2', '放首歌吧');
    const limited = say('s3', '我在准备跳槽');
    // 限定在别的聊天的回合在这里读不到（私下说的不再是读不到的理由）。
    store.db.prepare('UPDATE conversation_observations SET policy_json = ? WHERE person_id = ? AND turn_id = ?')
      .run(JSON.stringify({ disclosure: 'normal', onlyConversationId: 'elsewhere' }), 'lunara', limited);
    store.saveSummary({ sessionId: 'scan', personId: 'lunara', fromSequence: 1, toSequence: 4, content: '前两句' });
    const scan = {};
    const read = () => store.listSummaries('scan', { limit: 1, personId: 'lunara', scan }).map(row => row.content);
    const fresh = () => store.listSummaries('scan', { limit: 1, personId: 'lunara' }).map(row => row.content);
    assert.deepEqual(read(), ['前两句']);
    assert.equal(scan.hi, 4);
    // 续写的摘要延伸到读不到的那句：尾部补扫必须看到它，退回上一份。
    store.saveSummary({ sessionId: 'scan', personId: 'lunara', fromSequence: 1, toSequence: 6, content: '三句' });
    assert.deepEqual(read(), fresh());
    assert.deepEqual(read(), ['前两句']);
    assert.equal(scan.hi, 6);
    store.saveSummary({ sessionId: 'scan', personId: 'lunara', fromSequence: 1, toSequence: 6, content: '三句（已排除）',
      excludedTurnIds: store.listTurns('scan', { limit: 10 }).filter(turn => turn.sequence >= 5).map(turn => turn.turnId) });
    assert.deepEqual(read(), fresh());
    assert.deepEqual(read(), ['三句（已排除）']);
  });
});

test('「今天只…」到期后这段对话仍留在本聊天历史里；别的聊天读它时期限照常生效', async () => {
  await withStore(({ store }) => {
    const { turn } = store.beginRequest({ sessionId: 'today', requestId: 'r1', virtualPersonId: 'lunara',
      userText: '今天只想听爵士，顺便说一下我下个月要去东京' });
    store.completeRequest({ requestId: 'r1', virtualPersonId: 'lunara', message: { content: '好的。' } });
    const realNow = Date.now;
    Date.now = () => realNow() + 25 * 3600 * 1000;
    try {
      const turns = store.listTurns('today', { limit: 10 });
      assert.equal(turns.filter(item => store.canReadTurn('lunara', item, { isGroup: false })).length, 2);
      assert.equal(store.canReadTurn('lunara', turn, { sessionId: 'elsewhere' }), false);
    } finally { Date.now = realNow; }
  });
});

test('sessionRevision 仅在成员、切换人、归档或删房变更时递增并随 close 重置', async () => {
  await withStore(({ store }) => {
    assert.equal(store.sessionRevision('r'), 0);
    store.ensureSession('r', 'lunara');
    const r1 = store.sessionRevision('r');
    assert.ok(r1 > 0);
    store.beginRequest({ sessionId: 'r', requestId: 'req-1', virtualPersonId: 'lunara', userText: '聊聊' });
    store.completeRequest({ requestId: 'req-1', virtualPersonId: 'lunara', message: { content: '好' } });
    assert.equal(store.sessionRevision('r'), r1, '普通消息写入不改成员/归档状态');
    store.addMember('r', 'b');
    const r2 = store.sessionRevision('r');
    assert.ok(r2 > r1);
    store.removeMember('r', 'b');
    const r3 = store.sessionRevision('r');
    assert.ok(r3 > r2);
    store.updateRoom('r', { archived: true });
    const r4 = store.sessionRevision('r');
    assert.ok(r4 > r3);
    store.updateRoom('r', { archived: false });
    const r5 = store.sessionRevision('r');
    assert.ok(r5 > r4);
    store.setActiveVirtualPerson('r', 'b');
    assert.ok(store.sessionRevision('r') > r5);
    store.deleteRoom('r');
    assert.ok(store.sessionRevision('r') > r5);
    store.close();
    assert.equal(store.sessionRevision('r'), 0);
  });
});

test('recentSpokenLines 默认含串词，excludeTrackIntros=true 时跳过串词保住近期 presence 防复读窗口', async () => {
  await withStore(({ store }) => {
    store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
    store.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'k1', kind: 'ambient', text: '刚才风好大。' });
    for (let i = 1; i <= 3; i += 1) {
      store.recordTrackIntro({ sessionId: 'room', personId: 'lunara', correlationId: `c${i}`, queueItemId: `q${i}`,
        text: `第 ${i} 首串词正文。`, track: { songId: `s${i}`, title: `歌${i}`, artist: 'x', source: 'qq' } });
    }
    assert.deepEqual(store.recentSpokenLines('room', 'lunara', { limit: 3 }), ['第 1 首串词正文。', '第 2 首串词正文。', '第 3 首串词正文。']);
    assert.deepEqual(store.recentSpokenLines('room', 'lunara', { limit: 3, excludeTrackIntros: true }), ['刚才风好大。']);
  });
});

test('ConversationStore tracks return_greeted_turn_id, lastUserTurnId, per-beat voice updates, and $.beats hashes', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ConversationStore } = await import('./ConversationStore.js');

  const dir = mkdtempSync(join(tmpdir(), 'lunara-store-beats-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  try {
    const room = store.createRoom({ title: '分拍存储', memberIds: ['lunara'], hostId: 'lunara' });
    assert.equal(room.returnGreetedTurnId, null);
    assert.equal(room.lastUserTurnId, null);

    store.beginRequest({ requestId: 'r1', sessionId: room.sessionId, virtualPersonId: 'lunara', userText: '第一句' });
    const c1 = store.completeRequest({
      requestId: 'r1',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: '第一拍\n\n第二拍',
        beats: [
          { index: 0, say: '第一拍', pauseAfterMs: 650 },
          { index: 1, say: '第二拍', pauseAfterMs: 0 },
        ],
      },
      result: { ok: true },
    });
    const sessionAfterUser = store.getSession(room.sessionId);
    const u1TurnId = sessionAfterUser.lastUserTurnId;
    assert.ok(u1TurnId);
    assert.equal(store.getReturnGreetedTurnId(room.sessionId), null);

    store.setReturnGreetedTurnId(room.sessionId, u1TurnId);
    assert.equal(store.getReturnGreetedTurnId(room.sessionId), u1TurnId);
    assert.equal(store.getSession(room.sessionId).returnGreetedTurnId, u1TurnId);
    assert.equal(store.listRooms().find(r => r.sessionId === room.sessionId).returnGreetedTurnId, u1TurnId);

    store.updateTurnVoice(c1.turn.turnId, {
      beatIndex: 0,
      audioUrl: '/tts/beat_hash_0.wav',
      hash: 'beat_hash_0',
      durationMs: 420,
      voiceProfileId: 'vp-1',
    });
    store.updateTurnVoice(c1.turn.turnId, {
      beatIndex: 1,
      audioUrl: '/tts/beat_hash_1.wav',
      hash: 'beat_hash_1',
      durationMs: 510,
      voiceProfileId: 'vp-1',
    });
    const updatedTurn = store.getTurn(c1.turn.turnId);
    assert.equal(updatedTurn.message.beats[0].hash, 'beat_hash_0');
    assert.equal(updatedTurn.message.beats[1].audioUrl, '/tts/beat_hash_1.wav');
    assert.equal(store.voiceHashesForSession(room.sessionId).includes('beat_hash_0'), true);
    assert.equal(store.voiceHashesForSession(room.sessionId).includes('beat_hash_1'), true);
    assert.equal(store.voiceHashesForPerson('lunara').includes('beat_hash_1'), true);
    assert.equal(store.referencedVoiceHashes().has('beat_hash_0'), true);
    assert.equal(store.voiceHashesForTurnIds([c1.turn.turnId]).has('beat_hash_1'), true);

    store.rewindFromTurn(room.sessionId, u1TurnId);
    assert.equal(store.getReturnGreetedTurnId(room.sessionId), null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ConversationStore.updateTurnVoice treats marker-only/punctuation-only beats as silent so ready speakable beats summarize voice.audioUrl', async () => {
  await withStore(({ store }) => {
    const room = store.createRoom({ title: '静默拍汇总', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay' });
    store.beginRequest({ requestId: 'r-silent-mix', sessionId: room.sessionId, virtualPersonId: 'lunara', userText: '在吗' });
    const completed = store.completeRequest({
      requestId: 'r-silent-mix',
      virtualPersonId: 'lunara',
      message: {
        role: 'assistant',
        content: '（叹气）\n……\n\n你终于肯回我了。',
        beats: [
          { index: 0, action: '叹气', say: '……', spoken: '{叹气}', pauseAfterMs: 500 },
          { index: 1, say: '……', pauseAfterMs: 400 },
          { index: 2, say: '你终于肯回我了。', spoken: '{叹气}你终于肯回我了。', pauseAfterMs: 0 },
        ],
      },
      result: { ok: true },
    });

    const afterSingle = store.updateTurnVoice(completed.turn.turnId, {
      beatIndex: 2,
      audioUrl: '/tts/beat_mix_2.wav',
      hash: 'beat_mix_2',
      durationMs: 640,
      voiceProfileId: 'vp-1',
    });
    assert.equal(afterSingle.message.voice.audioUrl, '/tts/beat_mix_2.wav');
    assert.equal(afterSingle.message.voice.hash, 'beat_mix_2');
    assert.equal(afterSingle.message.voice.durationMs, 640);

    const afterBatch = store.updateTurnVoice(completed.turn.turnId, {
      voiceProfileId: 'vp-1',
      beats: [
        { index: 0, action: '叹气', say: '……', spoken: '{叹气}', pauseAfterMs: 500 },
        { index: 1, say: '……', pauseAfterMs: 400 },
        { index: 2, say: '你终于肯回我了。', spoken: '{叹气}你终于肯回我了。', pauseAfterMs: 0, audioUrl: '/tts/beat_mix_2b.wav', hash: 'beat_mix_2b', durationMs: 700 },
      ],
    });
    assert.equal(afterBatch.message.voice.audioUrl, '/tts/beat_mix_2b.wav');
    assert.equal(afterBatch.message.voice.hash, 'beat_mix_2b');
    assert.equal(afterBatch.message.voice.durationMs, 700);
  });
});
