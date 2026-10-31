import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppState } from '../../core/appState.js';
import { createConversationController } from './conversationController.js';

function fixture(options = {}) {
  const { initialSessionId = 'one', ...controllerOptions } = options;
  const rooms = [{ sessionId: 'one', memberIds: ['a'], activeVirtualPersonId: 'a' }, { sessionId: 'two', memberIds: ['b'], activeVirtualPersonId: 'b' }];
  const store = createAppState({ sessionId: initialSessionId, virtualPersons: [{ id: 'a', displayName: 'A' }, { id: 'b', displayName: 'B' }], runtimeState: { activeListeningSessionId: 'one', queue: [{ songId: 'rnb' }] } });
  const calls = [], transcripts = { one: [], two: [] };
  const apiClient = { get: async path => {
    if (path.startsWith('/api/conversations?')) return { conversations: rooms };
    const sid = path.includes('/one/') ? 'one' : 'two';
    return { sessionId: sid, turns: transcripts[sid] };
  }, post: async (...args) => { calls.push(args); return { ok: true }; } };
  const controller = createConversationController({ store, apiClient, ...controllerOptions });
  return { store, controller, apiClient, transcripts, calls, rooms };
}

test('browsing preserves audio alongside independent drafts and scroll positions', async () => {
  const h = fixture(); await h.controller.refresh();
  const playback = h.store.getState().runtimeState;
  h.controller.saveView({ draft: '给 A 的 R&B', scroll: 72 });
  await h.controller.select('two');
  assert.equal(h.controller.snapshot().local.draft, '');
  h.controller.saveView({ draft: '给 B 的 Rap', scroll: 19 });
  await h.controller.select('one');
  assert.equal(h.controller.snapshot().local.draft, '给 A 的 R&B');
  assert.equal(h.controller.snapshot().local.scroll, 72);
  assert.deepEqual(h.store.getState().runtimeState, playback);
  assert.equal(h.calls.length, 0);
});

test('restoring selection and browsing an archived room never send a playback request', async () => {
  const h = fixture({ storage: { getItem: key => key === 'lunara.selected-room' ? 'two' : null } });
  await h.controller.refresh();
  assert.equal(h.store.getState().sessionId, 'two');
  h.controller.snapshot().rooms.find(room => room.sessionId === 'one').archivedAt = 123;
  await h.controller.select('one');
  assert.equal(h.store.getState().runtimeState.activeListeningSessionId, 'one');
  assert.deepEqual(h.calls, []);
});

test('initial load leaves an archived default room and opens the first active conversation', async () => {
  const h = fixture();
  h.rooms[0].archivedAt = 123;
  await h.controller.refresh();
  assert.equal(h.store.getState().sessionId, 'two');
  assert.equal(h.store.getState().runtimeState.activeListeningSessionId, 'one');
  assert.deepEqual(h.calls, []);
});

test('boot lands on the newest conversation even when the hardcoded initial session id matches a real room', async () => {
  const h = fixture({ initialSessionId: 'two' });
  await h.controller.refresh();
  assert.equal(h.store.getState().sessionId, 'one');
  assert.equal(h.store.getState().runtimeState.activeListeningSessionId, 'one');
  assert.deepEqual(h.calls, []);
});

test('a stale saved selection falls through to the newest conversation on boot', async () => {
  const h = fixture({ initialSessionId: 'one', storage: { getItem: key => key === 'lunara.selected-room' ? 'gone' : null } });
  h.rooms.push({ sessionId: 'gone', memberIds: ['b'], activeVirtualPersonId: 'b', archivedAt: 123 });
  await h.controller.refresh();
  assert.equal(h.store.getState().sessionId, 'one');
});

test('late group responses go to their originating room and retain individual identities', async () => {
  const h = fixture(); await h.controller.refresh(); await h.controller.select('two');
  h.controller.consume({ sessionId: 'one', messages: [
    { sourceTurnId: 'a1', virtualPersonId: 'a', say: 'A 的回应' },
    { sourceTurnId: 'c1', virtualPersonId: 'c', say: 'C 的补充' },
  ] });
  assert.equal(h.controller.snapshot().local.turns.length, 0);
  assert.equal(h.controller.stateFor('one').unread, true);
  assert.deepEqual(h.controller.stateFor('one').turns.map(turn => turn.speakerVirtualPersonId), ['a', 'c']);
});

test('delivered track introductions retain their exact queue occurrence identity', async () => {
  const h = fixture(); await h.controller.refresh();
  h.controller.consume({ sessionId: 'one', messages: [{
    sourceTurnId: 'intro:queue:item-two', virtualPersonId: 'a',
    say: '这首适合现在稍微放松一点。', presentation: 'track_intro',
    queueItemId: 'queue:item-two', tracks: [{ queueItemId: 'queue:item-two', songId: 'same-song' }],
  }] });

  assert.deepEqual(h.controller.stateFor('one').turns[0], {
    turnId: 'intro:queue:item-two', role: 'assistant', text: '这首适合现在稍微放松一点。',
    speakerVirtualPersonId: 'a', presentation: 'track_intro', queueItemId: 'queue:item-two',
    tracks: [{ queueItemId: 'queue:item-two', songId: 'same-song' }], sequence: 1,
    createdAt: h.controller.stateFor('one').turns[0].createdAt,
  });
});

test('a pending A turn does not block B or unlock B when A finishes', async () => {
  const h = fixture(); await h.controller.refresh();
  const resolvers = {};
  h.apiClient.chat = input => new Promise(resolve => { resolvers[input.sessionId] = resolve; });
  const first = h.controller.send('A 你好');
  assert.equal(h.controller.isPending(), true);
  await h.controller.select('two');
  assert.equal(h.controller.isPending(), false);
  const second = h.controller.send('B 你好');
  resolvers.one({ ok: true }); await first;
  assert.equal(h.controller.isPending(), true);
  resolvers.two({ ok: true }); await second;
  assert.equal(h.controller.isPending(), false);
});

test('retrying an uncertain delivery reuses its request identity and restores the draft', async () => {
  const h = fixture(); await h.controller.refresh();
  const requests = [];
  h.apiClient.chat = async input => { requests.push(input); if (requests.length === 1) throw new Error('connection lost'); };
  await h.controller.send('播放晴天');
  assert.equal(h.controller.snapshot().local.draft, '播放晴天');
  assert.equal(h.controller.snapshot().local.restoreDraft, true);
  await h.controller.send('播放晴天');
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.equal(h.controller.snapshot().local.retry, null);
});

test('row-level updates and deletes target their own session and fall back for the browsed room', async () => {
  const h = fixture();
  await h.controller.refresh();
  const deletes = [];
  h.apiClient.delete = async path => { deletes.push(path); return { ok: true, deleted: true }; };
  h.rooms[0].lastTurnAt = 5;

  // 行内归档不必先选中目标会话；归档正在浏览的会话时回落到最新活跃会话。
  await h.controller.updateRoomById('two', { archived: true });
  assert.deepEqual(h.calls.at(-1), ['/api/conversations/two', { archived: true }]);
  assert.equal(h.controller.snapshot().sessionId, 'one');
  await h.controller.updateRoomById('one', { pinned: true });
  assert.deepEqual(h.calls.at(-1), ['/api/conversations/one', { pinned: true }]);
  assert.equal(h.controller.snapshot().sessionId, 'one', '非归档更新不改变浏览中的会话');

  // 删除正在浏览的会话同样回落；删除其他会话保持浏览不变。
  await h.controller.deleteRoomById('two');
  assert.deepEqual(deletes, ['/api/conversations/two']);
  await h.controller.deleteRoomById('one');
  assert.deepEqual(deletes, ['/api/conversations/two', '/api/conversations/one']);
  assert.equal(h.controller.snapshot().sessionId, 'one');
  assert.equal(h.store.getState().sessionId, 'one');
});

test('a presence line lands as her bubble; unread elsewhere, read on the spot when that room is open', async () => {
  const h = fixture(); await h.controller.refresh(); await h.controller.select('two');
  h.controller.consume({ type: 'queue-update', conversationId: 'one', message: {
    sourceTurnId: 'presence:abc', virtualPersonId: 'a', say: '这首听完，房间好像安静了一点。', presentation: 'presence', sequence: 4,
  } });
  const [turn] = h.controller.stateFor('one').turns;
  assert.equal(turn.presentation, 'presence');
  assert.equal(turn.sequence, 4);
  assert.equal(h.controller.stateFor('one').unread, true);
  assert.deepEqual(h.calls, [], '不在看的聊天：只标未读，不发请求');
  h.controller.consume({ type: 'queue-update', conversationId: 'two', message: {
    sourceTurnId: 'presence:def', virtualPersonId: 'b', say: '嗯。', presentation: 'presence',
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.stateFor('two').unread, false);
  assert.deepEqual(h.calls, [['/api/conversations/two', { unread: false }]]);
  assert.equal(h.store.getState().runtimeState.activeListeningSessionId, 'one', '不切换听歌来源');
});

test('正在输入：只认这个聊天的成员；更新的 correlation 覆盖旧的，迟到 idle 被丢弃；气泡到了就收起；兜底超时', async () => {
  const timers = [];
  const h = fixture({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  await h.controller.refresh();
  assert.equal(h.controller.consumeActivity({ sessionId: 'one', personId: 'b', correlationId: 'c0', state: 'composing' }), false, '不是成员');
  assert.equal(h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c1', state: 'composing' }), true);
  assert.deepEqual(h.controller.snapshot().composing, ['a']);
  h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c2', state: 'composing' });
  assert.equal(h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c1', state: 'idle', outcome: 'ended' }), false, '迟到的旧 idle');
  assert.deepEqual(h.controller.snapshot().composing, ['a']);
  h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c2', state: 'idle', outcome: 'ended' });
  assert.deepEqual(h.controller.snapshot().composing, [], '没入账就立即收起');

  h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c3', state: 'composing' });
  h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c3', state: 'idle', outcome: 'committed' });
  assert.deepEqual(h.controller.snapshot().composing, ['a'], '已入账：撑到气泡出现');
  h.controller.consume({ sessionId: 'one', message: { say: '在呢。', sourceTurnId: 't1', virtualPersonId: 'a' } });
  assert.deepEqual(h.controller.snapshot().composing, [], '气泡到了');

  h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c4', state: 'composing' });
  timers.at(-1).fn();
  assert.deepEqual(h.controller.snapshot().composing, [], '丢了 idle 也会兜底收起');
  assert.equal(timers.at(-1).ms, 30_000);
  await h.controller.select('two');
  h.controller.consumeActivity({ sessionId: 'one', personId: 'a', correlationId: 'c5', state: 'composing' });
  assert.deepEqual(h.controller.snapshot().composing, [], '只显示正在看的聊天');
});

test('安静点：只在被要求安静的听歌来源里显示；服务端确认后才收起；失败保留并报错', async () => {
  const errors = [];
  const h = fixture({ onError: error => errors.push(error.message) });
  await h.controller.refresh();
  assert.equal(h.controller.consumeListenerQuiet({ sessionId: 'one', quiet: true }), true);
  assert.equal(h.controller.snapshot().listenerQuiet, true);
  await h.controller.select('two');
  assert.equal(h.controller.snapshot().listenerQuiet, false, '别的聊天不显示');
  assert.equal(h.controller.consumeListenerQuiet({ sessionId: 'two', quiet: false }), false, '不是这个来源的恢复被忽略');
  await h.controller.select('one');
  h.apiClient.post = async (...args) => { h.calls.push(args); return { ok: true, restored: true, listenerQuietSessionId: null }; };
  assert.equal(await h.controller.restoreListenerQuiet(), true);
  assert.deepEqual(h.calls.at(-1), ['/api/presence/listener-quiet/restore', { sessionId: 'one' }]);
  assert.equal(h.controller.snapshot().listenerQuiet, false);

  h.controller.consumeListenerQuiet({ sessionId: 'one', quiet: true });
  h.apiClient.post = async () => { throw new Error('500 internal: stack'); };
  assert.equal(await h.controller.restoreListenerQuiet(), false);
  assert.equal(h.controller.snapshot().listenerQuiet, true, '失败时仍显示，可再试');
  assert.deepEqual(errors, ['没能恢复主动说话，可以再试一次。'], '不回显底层错误');

  h.apiClient.get = async () => ({ ok: true, listenerQuietSessionId: null });
  await h.controller.refreshListenerQuiet();
  assert.equal(h.controller.snapshot().listenerQuiet, false, '重连后以服务端为准');
});

test('ambient 推荐：实时消息带卡片；确认只走推荐接口、不切换听歌来源，结果写回本地状态', async () => {
  const h = fixture(); await h.controller.refresh();
  const card = { provider: 'qq', songId: '42', title: '晚风', artist: '陈婧霏', recommendedBy: 'a', status: 'pending', expiresAt: 99 };
  h.controller.consume({ sessionId: 'one', message: { say: '想放《晚风》给你听。', sourceTurnId: 'presence:w', virtualPersonId: 'a',
    presentation: 'presence', musicRecommendation: card } });
  const turn = () => h.controller.snapshot().local.turns.find(item => item.turnId === 'presence:w');
  assert.deepEqual(turn().musicRecommendation, card);
  h.apiClient.post = async (...args) => { h.calls.push(args);
    return { ok: true, code: 'RECOMMENDATION_QUEUED', recommendation: { ...card, turnId: 'presence:w', status: 'queued' } }; };
  const result = await h.controller.acceptRecommendation('presence:w');
  assert.deepEqual(h.calls.filter(([path]) => path.includes('/recommendations/')),
    [['/api/conversations/one/recommendations/presence%3Aw/accept', {}]]);
  assert.equal(h.calls.some(([path]) => path === '/api/chat' || path.includes('/listen')), false, '不发聊天、不切换来源');
  assert.equal(result.code, 'RECOMMENDATION_QUEUED');
  assert.equal(turn().musicRecommendation.status, 'queued');
  assert.equal(h.store.getState().runtimeState.activeListeningSessionId, 'one');
});

test('ambient 推荐：被拒（409）时返回服务端结果并更新状态；网络失败时抛出由卡片提示重试', async () => {
  const h = fixture(); await h.controller.refresh();
  h.controller.consume({ sessionId: 'one', message: { say: '《晚风》', sourceTurnId: 'presence:w', virtualPersonId: 'a',
    presentation: 'presence', musicRecommendation: { title: '晚风', artist: '陈婧霏', recommendedBy: 'a', status: 'pending', expiresAt: 99 } } });
  h.apiClient.post = async () => { throw Object.assign(new Error('409'), { status: 409,
    body: { ok: false, code: 'RECOMMENDATION_NOT_PENDING', recommendation: { turnId: 'presence:w', status: 'expired' } } }); };
  const rejected = await h.controller.acceptRecommendation('presence:w');
  assert.equal(rejected.code, 'RECOMMENDATION_NOT_PENDING');
  assert.equal(h.controller.snapshot().local.turns.find(item => item.turnId === 'presence:w').musicRecommendation.status, 'expired');
  h.apiClient.post = async () => { throw new Error('无法连接 Lunara 服务'); };
  await assert.rejects(() => h.controller.acceptRecommendation('presence:w'));
});

test('a message from the listening chat names the occurrence the listener is hearing', async () => {
  const h = fixture();
  const sent = [];
  h.apiClient.chat = async payload => { sent.push(payload); return { ok: true }; };
  h.store.update(() => ({ runtimeState: { activeListeningSessionId: 'one', phase: 'playing', currentIndex: 1,
    queue: [{ songId: 'a', queueItemId: 'q-a' }, { songId: 'b', queueItemId: 'q-b' }], txn: { queueItemId: 'q-b' } } }));
  await h.controller.refresh();
  await h.controller.send('下一首');
  assert.deepEqual(sent[0].playbackIdentity, { listeningSessionId: 'one', queueItemId: 'q-b', songId: 'b' });

  // 浏览别的聊天、或本聊天没有在播的歌时不附带：服务端退回只看执行那一刻的当前歌。
  await h.controller.select('two');
  await h.controller.send('下一首');
  assert.equal('playbackIdentity' in sent[1], false);
  await h.controller.select('one');
  h.store.update(() => ({ runtimeState: { activeListeningSessionId: 'one', phase: 'exhausted', currentIndex: -1, queue: [] } }));
  await h.controller.send('继续');
  assert.equal('playbackIdentity' in sent[2], false);
});
