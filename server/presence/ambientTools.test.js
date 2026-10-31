// ambientTools.test.js — presence_respond（ambient turn 的终止工具）合同（add-companion-heartbeat 3.5）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { ToolOutcomeKind } from '../virtual-person/VirtualPersonTypes.js';
import { createNoteStage } from '../virtual-person/companionNotes.js';
import { AMBIENT_CAPABILITY, AMBIENT_RECOMMEND_CAPABILITY, AMBIENT_RESPOND_TOOL_NAME, AMBIENT_TOOLS, INNER_NOTES_CAPABILITY,
  RECOMMEND_TRACK_TOOL_NAME, registerAmbientTools } from './ambientTools.js';

const ambientTask = { contextText: '正在放《夜航星》。', recentLines: [] };
const context = (overrides = {}) => ({ correlationId: 'ambient:test', capabilities: [AMBIENT_CAPABILITY],
  ambientTask, finishReason: 'tool_calls', ...overrides });

function registry() {
  return registerAmbientTools(new VirtualPersonToolRegistry({ logger: { error() {} } }));
}

test('ambient 白名单是三个心里话工具加 presence_respond；settle_thought 另挂 presence.notes；重复注册幂等', () => {
  const tools = registry();
  registerAmbientTools(tools);
  assert.deepEqual([...AMBIENT_TOOLS], ['note_thought', 'schedule_followup', 'settle_thought', AMBIENT_RESPOND_TOOL_NAME]);
  assert.deepEqual(tools.definitions({ capabilities: [AMBIENT_CAPABILITY] }).map(item => item.function.name),
    ['note_thought', 'schedule_followup', 'presence_respond']);
  assert.deepEqual(tools.definitions({ capabilities: [INNER_NOTES_CAPABILITY] }).map(item => item.function.name), ['settle_thought']);
  assert.equal(tools.isReadOnly(AMBIENT_RESPOND_TOOL_NAME), false);
  const schema = tools.definitions({ capabilities: [AMBIENT_CAPABILITY] })
    .find(item => item.function.name === AMBIENT_RESPOND_TOOL_NAME).function.parameters;
  assert.deepEqual(schema.properties.action.enum, ['speak', 'quiet']);
});

test('quiet 是正常终止：空呈现、不需要文本', async () => {
  const outcome = await registry().execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'quiet' }, context());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.code, 'AMBIENT_QUIET');
  assert.deepEqual(outcome.facts, { action: 'quiet' });
  assert.equal(outcome.presentation.displayText, '');
});

test('speak 通过校验后被接受；呈现留空，由运行时入账后自己交付', async () => {
  const outcome = await registry().execute(AMBIENT_RESPOND_TOOL_NAME,
    { action: 'speak', text: '  《夜航星》这段鼓点好像在下雨。 ' }, context());
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.code, 'AMBIENT_LINE_ACCEPTED');
  assert.deepEqual(outcome.facts, { action: 'speak', text: '《夜航星》这段鼓点好像在下雨。' });
  assert.equal(outcome.presentation.displayText, '');
  assert.doesNotMatch(outcome.modelContext, /已经(说|播)/);
});

test('模型照着群聊历史格式带出的说话人标签会被剥掉，不进可见文本', async () => {
  const outcome = await registry().execute(AMBIENT_RESPOND_TOOL_NAME,
    { action: 'speak', text: '[历史说话人：小满]\n《夜航星》这段鼓点好像在下雨。' }, context());
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.facts, { action: 'speak', text: '《夜航星》这段鼓点好像在下雨。' });
});

test('模型模仿的同伴信封标记同样被剥掉', async () => {
  const outcome = await registry().execute(AMBIENT_RESPOND_TOOL_NAME,
    { action: 'speak', text: '<peer_message from="小满" member="x" round="current">\n《夜航星》这段鼓点好像在下雨。\n</peer_message>' }, context());
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.facts, { action: 'speak', text: '《夜航星》这段鼓点好像在下雨。' });
});

test('不合法的 speak 是可纠正失败：不终止，带规则 id 与反馈', async () => {
  const outcome = await registry().execute(AMBIENT_RESPOND_TOOL_NAME,
    { action: 'speak', text: '要不要听听《晴天》？' }, context());
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, ToolOutcomeKind.BUSINESS_FAILURE);
  assert.equal(outcome.terminal, false);
  assert.equal(outcome.code, 'AMBIENT_LINE_REJECTED');
  assert.equal(outcome.facts.rejectedRule, 'entity_outside_context');
  assert.equal(outcome.presentation.retryable, true);
  assert.match(outcome.modelContext, /quiet/);
});

test('没有任务、响应被截断都不接受（取消由工具注册表与 AgentLoop 统一处理）', async () => {
  const tools = registry();
  const missing = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'quiet' }, context({ ambientTask: null }));
  assert.equal(missing.code, 'AMBIENT_TASK_UNAVAILABLE');
  const truncated = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'speak', text: '嗯。' },
    context({ finishReason: 'length' }));
  assert.equal(truncated.code, 'AMBIENT_TRUNCATED');
  assert.equal(truncated.presentation.retryable, true);
  assert.equal(truncated.terminal, false);
});

function noteContext({ stage = createNoteStage(), store = null, currentQueueItemId = 'q1' } = {}) {
  return context({ capabilities: [AMBIENT_CAPABILITY, INNER_NOTES_CAPABILITY],
    innerNotes: { map: new Map([['n1', 'note:one']]), stage, store, personId: 'lunara', sessionId: 'chat',
      originKey: 'ambient:wake', sourceRefs: ['turn:u1'], currentQueueItemId, nowMs: () => 1_000_000 } });
}

test('note_thought 与 schedule_followup 只写暂存区，id 确定，带来源', async () => {
  const tools = registry();
  const ctx = noteContext();
  const thought = await tools.execute('note_thought', { text: '这几首都是雨天的歌' }, ctx);
  assert.equal(thought.ok, true);
  assert.equal(thought.terminal, false);
  const minutes = await tools.execute('schedule_followup', { about: '问问雨停了没', inMinutes: 10 }, ctx);
  const track = await tools.execute('schedule_followup', { about: '这首放完聊聊副歌', after: 'current_track' }, ctx);
  assert.equal(minutes.ok && track.ok, true);
  const [first, second, third] = ctx.innerNotes.stage.creates;
  assert.equal(first.kind, 'thought');
  assert.deepEqual(first.sourceRefs, ['turn:u1']);
  assert.equal(second.dueAt, 1_000_000 + 10 * 60_000);
  assert.equal(third.wakeCondition, 'afterCurrentTrack:q1');
  assert.equal(new Set([first.noteId, second.noteId, third.noteId]).size, 3);
  const fourth = await tools.execute('note_thought', { text: '再记一条' }, ctx);
  assert.equal(fourth.code, 'NOTES_LIMIT');
});

test('schedule_followup 的时间必须二选一；没有在放的歌不能约这首放完', async () => {
  const tools = registry();
  assert.equal((await tools.execute('schedule_followup', { about: 'x' }, noteContext())).code, 'FOLLOWUP_WHEN_INVALID');
  assert.equal((await tools.execute('schedule_followup', { about: 'x', inMinutes: 5, after: 'next_listening' }, noteContext())).code,
    'FOLLOWUP_WHEN_INVALID');
  assert.equal((await tools.execute('schedule_followup', { about: 'x', after: 'current_track' }, noteContext({ currentQueueItemId: null }))).code,
    'FOLLOWUP_NO_TRACK');
  assert.equal((await tools.execute('schedule_followup', { about: 'x', inMinutes: 1 }, noteContext())).code, 'INVALID_TOOL_ARGUMENTS');
});

test('没有暂存区（普通回合）时不能新建，只能了结；了结立即落库且只认本轮 n 编号', async () => {
  const tools = registry();
  const settled = [];
  const store = { settle: input => { settled.push(input); return true; } };
  const ordinary = noteContext({ stage: null, store });
  assert.equal((await tools.execute('note_thought', { text: '想记' }, ordinary)).code, 'NOTES_UNAVAILABLE');
  const outcome = await tools.execute('settle_thought', { noteId: 'n1', status: 'resolved' }, ordinary);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, false);
  assert.deepEqual(settled, [{ personId: 'lunara', sessionId: 'chat', noteId: 'note:one', status: 'resolved' }]);
  assert.equal((await tools.execute('settle_thought', { noteId: 'n9', status: 'resolved' }, ordinary)).code, 'NOTE_NOT_VISIBLE');
  assert.equal((await tools.execute('settle_thought', { noteId: 'note:one', status: 'resolved' }, ordinary)).code, 'INVALID_TOOL_ARGUMENTS');
});

test('presence_respond 引用的 noteIds 必须本轮可见，接受后进暂存的 raises', async () => {
  const tools = registry();
  const ctx = noteContext();
  const rejected = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'speak', text: '雨好像小了。', noteIds: ['n7'] }, ctx);
  assert.equal(rejected.facts.rejectedRule, 'unknown_note');
  const outcome = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'speak', text: '雨好像小了。', noteIds: ['n1'] }, ctx);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.facts, { action: 'speak', text: '雨好像小了。', noteIds: ['n1'] });
  assert.deepEqual(ctx.innerNotes.stage.raises, ['note:one']);
});

test('invite 点名：短编号映射成员并交给 FloorRunner；未知编号、单聊或预算用完是可纠正失败，什么都不登记', async () => {
  const tools = registry();
  const registered = [];
  const ambientFloor = { refs: new Map([['m1', 'xiaoman']]), invite: personId => { registered.push(personId); return { ok: true }; } };
  const line = { action: 'speak', text: '《夜航星》这段鼓点好像在下雨，小满你听出来了吗？' };
  const ok = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { ...line, invite: 'm1' }, context({ ambientFloor }));
  assert.equal(ok.code, 'AMBIENT_LINE_ACCEPTED');
  assert.equal(ok.facts.invitedPersonId, 'xiaoman');
  assert.deepEqual(registered, ['xiaoman']);

  const unknown = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { ...line, invite: 'm9' }, context({ ambientFloor }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, 'AMBIENT_INVITE_INVALID');
  assert.equal(unknown.terminal, false);
  assert.match(unknown.modelContext, /m1/);
  assert.doesNotMatch(unknown.modelContext, /xiaoman/, '真实 id 不回给模型');

  const solo = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { ...line, invite: 'm1' }, context());
  assert.equal(solo.code, 'AMBIENT_INVITE_INVALID');

  const spent = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { ...line, invite: 'm1' },
    context({ ambientFloor: { refs: ambientFloor.refs, invite: () => ({ ok: false, code: 'FLOOR_ALREADY_SPENT' }) } }));
  assert.equal(spent.code, 'FLOOR_ALREADY_SPENT');
  assert.equal(spent.terminal, false);
  assert.deepEqual(registered, ['xiaoman'], '失败时不登记');

  const rejected = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'speak', text: '要不要听听《晴天》？', invite: 'm1' },
    context({ ambientFloor }));
  assert.equal(rejected.code, 'AMBIENT_LINE_REJECTED');
  assert.deepEqual(registered, ['xiaoman'], '话没通过校验时邀请也不登记');
});

// ===== add-ambient-music-recommendation：recommend_track 与「话里要点到这首」 =====

function recommendContext({ resolve, contextText = '正在放《夜航星》。' } = {}) {
  const task = { contextText, recentLines: [] };
  const calls = [];
  const recommendation = { stage: null, resolve: async target => { calls.push(target); return resolve(target); } };
  return { calls, recommendation, task,
    ctx: context({ capabilities: [AMBIENT_CAPABILITY, AMBIENT_RECOMMEND_CAPABILITY], ambientTask: task, ambientRecommendation: recommendation }) };
}
const resolved = { ok: true, selectionId: 'selection:abc', track: { songId: '42', source: 'qq', title: '晚风', artist: '陈婧霏' } };

test('recommend_track 挂在独立能力上，不在默认白名单里（闸门开时才由 runtime 加入）', () => {
  const tools = registry();
  assert.equal(AMBIENT_TOOLS.includes(RECOMMEND_TRACK_TOOL_NAME), false);
  assert.deepEqual(tools.definitions({ capabilities: [AMBIENT_RECOMMEND_CAPABILITY] }).map(item => item.function.name),
    [RECOMMEND_TRACK_TOOL_NAME]);
  const schema = tools.definitions({ capabilities: [AMBIENT_RECOMMEND_CAPABILITY] })[0].function.parameters;
  assert.deepEqual(schema.required, ['title', 'artist']);
});

test('recommend_track 成功：暂存一首，模型只看到 canonical 歌名与歌手，歌名进入本轮上下文', async () => {
  const h = recommendContext({ resolve: () => resolved });
  const outcome = await registry().execute(RECOMMEND_TRACK_TOOL_NAME, { title: '晚 风', artist: '陈婧霏' }, h.ctx);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, false);
  assert.equal(outcome.code, 'RECOMMENDATION_STAGED');
  assert.deepEqual(outcome.facts, { title: '晚风', artist: '陈婧霏' });
  assert.doesNotMatch(JSON.stringify(outcome), /selection:abc|"42"/);
  assert.deepEqual(h.recommendation.stage, { selectionId: 'selection:abc', provider: 'qq', songId: '42', title: '晚风', artist: '陈婧霏' });
  assert.match(h.task.contextText, /《晚风》/);
  assert.deepEqual(h.calls, [{ title: '晚 风', artist: '陈婧霏' }]);
});

test('recommend_track 每轮只能成功一次', async () => {
  const h = recommendContext({ resolve: () => resolved });
  await registry().execute(RECOMMEND_TRACK_TOOL_NAME, { title: '晚风', artist: '陈婧霏' }, h.ctx);
  const second = await registry().execute(RECOMMEND_TRACK_TOOL_NAME, { title: '别的歌', artist: '谁' }, h.ctx);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'RECOMMENDATION_ALREADY_SPENT');
  assert.equal(h.calls.length, 1);
  assert.equal(h.recommendation.stage.songId, '42');
});

test('recommend_track 找不到、放不了或被排除时可纠正地失败，不暂存、不提议替补', async () => {
  for (const code of ['RECOMMENDATION_UNRESOLVED', 'RECOMMENDATION_EXCLUDED', 'RECOMMENDATION_INVALID']) {
    const h = recommendContext({ resolve: () => ({ ok: false, code, reason: 'queued' }) });
    const outcome = await registry().execute(RECOMMEND_TRACK_TOOL_NAME, { title: '晚风', artist: '陈婧霏' }, h.ctx);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, code);
    assert.equal(outcome.presentation.retryable, true);
    assert.equal(h.recommendation.stage, null);
    assert.match(outcome.modelContext, /不要换成别的歌/);
  }
  const thrown = recommendContext({ resolve: () => { throw new Error('provider exploded: cookie=abc'); } });
  const outcome = await registry().execute(RECOMMEND_TRACK_TOOL_NAME, { title: '晚风', artist: '陈婧霏' }, thrown.ctx);
  assert.equal(outcome.code, 'RECOMMENDATION_UNRESOLVED');
  assert.doesNotMatch(JSON.stringify(outcome), /cookie|exploded/);
});

test('闸门没开（没有 ambientRecommendation）时调用 recommend_track 不做任何事', async () => {
  const outcome = await registry().execute(RECOMMEND_TRACK_TOOL_NAME, { title: '晚风', artist: '陈婧霏' },
    context({ capabilities: [AMBIENT_CAPABILITY, AMBIENT_RECOMMEND_CAPABILITY] }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'RECOMMENDATION_NOT_AVAILABLE');
});

test('暂存了推荐时，说出口的话必须点到这首歌；没点到是可纠正失败', async () => {
  const h = recommendContext({ resolve: () => resolved });
  const tools = registry();
  await tools.execute(RECOMMEND_TRACK_TOOL_NAME, { title: '晚风', artist: '陈婧霏' }, h.ctx);
  const other = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'speak', text: '《夜航星》之后想放点别的给你听。' }, h.ctx);
  assert.equal(other.ok, false);
  assert.equal(other.code, 'AMBIENT_LINE_REJECTED');
  assert.equal(other.facts.rejectedRule, 'recommendation_not_mentioned');
  const named = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'speak', text: '这首完了想放《晚风》给你听，很像今晚。' }, h.ctx);
  assert.equal(named.ok, true, named.modelContext);
  assert.equal(named.code, 'AMBIENT_LINE_ACCEPTED');
});

test('有推荐也不许说已经安排或在放', async () => {
  const h = recommendContext({ resolve: () => resolved });
  const tools = registry();
  await tools.execute(RECOMMEND_TRACK_TOOL_NAME, { title: '晚风', artist: '陈婧霏' }, h.ctx);
  const claim = await tools.execute(AMBIENT_RESPOND_TOOL_NAME, { action: 'speak', text: '我已经安排了《晚风》。' }, h.ctx);
  assert.equal(claim.ok, false);
  assert.equal(claim.facts.rejectedRule, 'playback_claim');
});
