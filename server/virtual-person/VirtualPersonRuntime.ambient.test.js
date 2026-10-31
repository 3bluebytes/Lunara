// VirtualPersonRuntime.ambient.test.js — 心跳叫醒的一轮（ambient turn）合同
// （add-companion-heartbeat 3.2 / 3.3 / 3.4 / 3.6）。
//
// 用真实的 ConversationStore / PromptAssembler / AgentLoop / 工具注册表，只把模型换成脚本化的假 chat：
// ambient 调用按 taskId === 'ambient_turn' 识别，普通回合固定回一句文本。
process.env.TZ = 'Asia/Shanghai';

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoop } from './AgentLoop.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import { ConversationStore, presenceTurnId } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';
import { registerAmbientTools } from '../presence/ambientTools.js';
import { AMBIENT_MARKER_PREFIX } from '../presence/ambientTurn.js';
import { createAmbientRecommendations } from '../presence/ambientRecommendations.js';
import { registerMusicTools } from './musicTools.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';

const NOW = new Date('2026-09-03T14:30:00.000Z');
const LINE = '加班到这么晚，累坏了吧。';
const AMBIENT_SECTION = '\n\n## 这一轮（一起听歌，没有人在跟你说话）';

const respond = (action, text) => ({
  message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${action}`, type: 'function',
    function: { name: 'presence_respond', arguments: JSON.stringify(text == null ? { action } : { action, text }) } }] },
  finishReason: 'tool_calls',
});
const callTool = (name, args = {}) => ({
  message: { role: 'assistant', content: '', tool_calls: [{ id: `call_${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] },
  finishReason: 'tool_calls',
});

function createHarness({ recommend = null, music = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-vp-ambient-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath });
  const conversationStore = new ConversationStore({ dbPath });
  const tools = registerAmbientTools(new VirtualPersonToolRegistry({ logger: { error() {} } }));
  const musicCalls = [];
  tools.register('commit_music', {
    capability: 'music.mutate',
    definition: { description: '提交音乐', parameters: { type: 'object', properties: {}, additionalProperties: true } },
    handler: () => {
      musicCalls.push(1);
      return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'MUSIC_COMMITTED', terminal: true,
        presentation: { displayText: '已经切歌了。' } });
    },
  });
  // 普通回合要用真实的 select_music 时注入选歌服务替身（add-ambient-music-recommendation 3.2）。
  if (music) registerMusicTools(tools, () => music);
  const calls = [];
  const ambientScript = [];
  const ordinaryScript = [];
  let reply = 0;
  const chat = async (messages, definitions, options = {}) => {
    const kind = options.taskId === 'ambient_turn' ? 'ambient' : 'ordinary';
    calls.push({ kind, messages: structuredClone(messages), tools: (definitions || []).map(item => item.function.name),
      options: { taskId: options.taskId, traceContent: options.traceContent, sessionId: options.sessionId } });
    if (kind === 'ambient') {
      const next = ambientScript.shift();
      return typeof next === 'function' ? next({ messages, options }) : next;
    }
    if (ordinaryScript.length) {
      const next = ordinaryScript.shift();
      return typeof next === 'function' ? next({ messages, options }) : next;
    }
    reply += 1;
    return { message: { role: 'assistant', content: `第${reply}次回应。` } };
  };
  const traces = [];
  const activity = [];
  const sessionTrace = {
    record(context, event) { traces.push({ ...context, ...event }); },
    enter(context, run) { return run(); },
  };
  const budgeter = new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => NOW }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools, contextBudgeter: budgeter }),
    presentationService: new PresentationService(),
    capabilityResolver: () => (music ? [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY] : []),
    retrieveMemories: async () => [{ kind: 'memory', source: 'person:lunara:manual_seed', id: 41, content: '用户最近常加班。' }],
    getRuntimeState: () => ({ playback: { phase: 'playing', currentIndex: 0,
      queue: [{ songId: 's1', title: '夜航星', artist: '不才', source: 'qq' }] } }),
    sessionTrace,
    onActivity: event => activity.push(event),
    // 推荐（add-ambient-music-recommendation）：真实的推荐表与闸门，选歌服务换成脚本。
    ...(recommend ? { ambientRecommendations: createAmbientRecommendations({ conversationStore, now: () => NOW.getTime(),
      timeZone: 'Asia/Shanghai', playbackRuntime: { snapshot: () => ({ activeListeningSessionId: recommend.source ?? 'room' }) },
      getMusicService: () => ({ recommendTrack: async (target, input) => recommend.resolve(target, input) }),
      trace: (sessionId, event) => traces.push({ sessionId, ...event }) }) } : {}),
    logger: { error() {}, warn() {} },
  }).initialize();
  return {
    runtime, registry, conversationStore, calls, traces, musicCalls, ambientScript, ordinaryScript, activity,
    recommendations: runtime.ambientRecommendations,
    count: (sql, ...args) => conversationStore.db.prepare(sql).get(...args).n,
    close() {
      runtime.shutdown();
      conversationStore.close();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const wakeFor = (sessionId, personId, overrides = {}) => ({
  id: `ambient:${sessionId}:${personId}:${NOW.getTime()}`, sessionId, personId, reason: 'heartbeat',
  firedAtMs: NOW.getTime(), previousWakeAtMs: null, sinceLastWake: { completed: 1, skipped: 0 }, modeRevision: null,
  policy: { id: 'quiet', hint: '你话不多：没有真想说的就不说，开口也很短。' }, signal: new AbortController().signal,
  ...overrides,
});

test('上下文等于同一伙伴普通回合的组装结果，加 ambient 小节和末尾一条运行时提示', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(respond('speak', LINE));
    const wake = wakeFor('room', 'lunara');
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake });
    assert.equal(result.action, 'speak');
    assert.equal(result.turn.turnId, presenceTurnId(wake.id));
    assert.equal(result.turn.visibleText, LINE);
    assert.equal(result.turn.message.presentation, 'presence');
    assert.equal(result.turn.message.presence.kind, 'ambient');
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '嗯，有点累', speak: false });

    const ambient = h.calls.find(call => call.kind === 'ambient');
    const ordinary = h.calls.filter(call => call.kind === 'ordinary')[1];
    assert.deepEqual(ambient.options, { taskId: 'ambient_turn', traceContent: false, sessionId: 'room' });
    assert.deepEqual(ambient.tools, ['note_thought', 'schedule_followup', 'presence_respond']);
    const system = ambient.messages[0].content;
    const cut = system.indexOf(AMBIENT_SECTION);
    assert.ok(cut > 0, '有 ambient 小节');
    assert.equal(system.slice(0, cut),
      ordinary.messages[0].content.replace('## 当前可用能力\n普通对话', '## 当前可用能力\npresence.ambient'),
      'ambient 小节之前与普通回合逐字节一致（能力行除外）');
    assert.match(system.slice(cut), /你话不多/);

    const history = ambient.messages.slice(1, -1);
    assert.deepEqual(history, ordinary.messages.slice(1, 3), '历史与普通回合看到的一致');
    const marker = ambient.messages.at(-1);
    assert.equal(marker.role, 'user');
    assert.ok(marker.content.startsWith(AMBIENT_MARKER_PREFIX));
    assert.match(marker.content, /完整听完了 1 首/);
    assert.match(marker.content, /现在在放《夜航星》（不才）/);
    assert.deepEqual(ordinary.messages[3], { role: 'assistant', content: LINE }, '说出口的话进入下一轮历史');
  } finally { h.close(); }
});

test('运行时提示不入账、不进下一轮投影、不进观察或 trace 正文；不产生 request/round/user turn', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(respond('speak', LINE));
    const wake = wakeFor('room', 'lunara');
    await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake });
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '嗯，有点累', speak: false });

    const next = h.calls.filter(call => call.kind === 'ordinary')[1];
    assert.doesNotMatch(JSON.stringify(next.messages), /运行时提示|没有人在跟你说话/);
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room' AND message_json LIKE '%运行时提示%'"), 0);
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room'"), 5, 'u1 a1 presence u2 a2');
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room' AND role = 'user'"), 2);
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room' AND visibility <> 'visible'"), 0,
      '工具往返不写账本');
    assert.equal(h.count('SELECT COUNT(*) AS n FROM conversation_requests'), 2);
    assert.equal(h.count('SELECT COUNT(*) AS n FROM conversation_rounds'), 2);
    assert.equal(h.count('SELECT COUNT(*) AS n FROM conversation_observations WHERE turn_id = ?', presenceTurnId(wake.id)), 0);

    const ambientTrace = h.traces.filter(event => event.requestId === wake.id);
    assert.ok(ambientTrace.some(event => event.type === 'ambient_context_assembled'));
    assert.ok(ambientTrace.some(event => event.type === 'ambient_tool_result' && event.code === 'AMBIENT_LINE_ACCEPTED'));
    const traced = JSON.stringify(ambientTrace);
    for (const secret of ['运行时提示', '今天加班到很晚', LINE, '用户最近常加班', '夜航星']) {
      assert.ok(!traced.includes(secret), `trace 不含正文：${secret}`);
    }
  } finally { h.close(); }
});

test('纯文本被纠正一次：改用 speak 提交会过校验并出口；trace 记被纠正的那句，纠正与提示不入账、不进 trace 正文（12.2）', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    const plain = '这首挺适合收尾的，你忙你的。';
    h.ambientScript.push({ message: { role: 'assistant', content: plain } }, respond('speak', LINE));
    const wake = wakeFor('room', 'lunara');
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake });
    assert.equal(result.action, 'speak');
    const second = h.calls.filter(call => call.kind === 'ambient')[1];
    assert.equal(second.messages.at(-2).content, plain, '下一轮看到自己刚才那句');
    assert.ok(second.messages.at(-1).content.startsWith(AMBIENT_MARKER_PREFIX), '纠正是运行时提示');
    assert.match(second.messages.at(-1).content, /presence_respond/);
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room' AND message_json LIKE '%运行时提示%'"), 0);
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room' AND visible_text = ?", plain), 0,
      '纯文本本身不出口');

    const ambientTrace = h.traces.filter(event => event.requestId === wake.id);
    const corrected = ambientTrace.find(event => event.type === 'ambient_plain_text_corrected');
    assert.deepEqual({ chars: corrected.chars, text: corrected.text }, { chars: plain.length, text: plain });
    assert.ok(!ambientTrace.some(event => event.type === 'ambient_line_dropped'));
    const traced = JSON.stringify(ambientTrace);
    for (const secret of ['运行时提示', '今天加班到很晚', '用户最近常加班', LINE]) {
      assert.ok(!traced.includes(secret), `trace 不含正文：${secret}`);
    }
  } finally { h.close(); }
});

test('纯文本被纠正后提交 quiet 记安静；纠正后仍是纯文本按安静并记 ambient_line_dropped', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push({ message: { role: 'assistant', content: '安静听着就好。' } }, respond('quiet'));
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara',
      wake: wakeFor('room', 'lunara') }), { action: 'quiet' });

    const again = '还是想说一句。';
    h.ambientScript.push({ message: { role: 'assistant', content: '第一句。' } }, { message: { role: 'assistant', content: again } });
    const later = wakeFor('room', 'lunara', { id: 'ambient:room:lunara:later' });
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: later }),
      { action: 'quiet', dropped: 'plain-text' }, '被丢的那句不随结果往外传');
    assert.equal(h.calls.filter(call => call.kind === 'ambient').length, 4, '每轮只纠正一次');
    const dropped = h.traces.find(event => event.requestId === later.id && event.type === 'ambient_line_dropped');
    assert.deepEqual({ reason: dropped.reason, chars: dropped.chars, text: dropped.text },
      { reason: 'plain-text', chars: again.length, text: again });
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room'"), 2, '都不入账');
  } finally { h.close(); }
});

test('ambient_context_assembled 记这一轮可见心里话按种类的条数，不含正文', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.conversationStore.notes.create({ noteId: 'note:loop', personId: 'lunara', sessionId: 'room', kind: 'open_loop',
      text: '她说周五要交方案', origin: 'reflection' });
    h.ambientScript.push(respond('quiet'));
    const wake = wakeFor('room', 'lunara');
    await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake });
    const assembled = h.traces.find(event => event.requestId === wake.id && event.type === 'ambient_context_assembled');
    assert.deepEqual(assembled.innerNotes, { open_loop: 1 });
    assert.ok(!JSON.stringify(assembled).includes('周五要交方案'));
  } finally { h.close(); }
});

test('群聊历史只含全员可读的回合；ambient 不写摘要', async () => {
  const h = createHarness();
  try {
    for (const id of ['a', 'b']) h.registry.createRadiohost({ id, displayName: id.toUpperCase(), voiceProfileId: `voice-${id}`, personaDocument: `${id} 的人设。` });
    h.conversationStore.createRoom({ sessionId: 'group', memberIds: ['a', 'b'], hostId: 'a' });
    await h.runtime.handleTurn({ sessionId: 'group', requestId: 'g1', userText: '大家各自说说今天', speak: false });
    await h.runtime.handleTurn({ sessionId: 'group', requestId: 'g2', userText: '我先去倒杯水', speak: false });
    const hidden = h.conversationStore.listTurns('group', { visibleOnly: true }).find(turn => turn.role === 'user');
    h.conversationStore.revokeObservation('b', hidden.turnId);
    const summaries = h.count('SELECT COUNT(*) AS n FROM conversation_summaries');

    h.ambientScript.push(respond('quiet'));
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'group', personId: 'a', wake: wakeFor('group', 'a') });
    assert.deepEqual(result, { action: 'quiet' });
    const ambient = h.calls.find(call => call.kind === 'ambient');
    const history = JSON.stringify(ambient.messages.slice(1, -1));
    assert.ok(!history.includes('大家各自说说今天'), 'b 不可读的回合不进群聊 ambient');
    assert.ok(history.includes('我先去倒杯水'));
    assert.equal(h.count('SELECT COUNT(*) AS n FROM conversation_summaries'), summaries);

    await h.runtime.handleTurn({ sessionId: 'group', requestId: 'g3', virtualPersonId: 'a', userText: '@A 你呢', speak: false });
    const ordinaryA = h.calls.filter(call => call.kind === 'ordinary').at(-1);
    assert.ok(JSON.stringify(ordinaryA.messages).includes('大家各自说说今天'), '普通回合仍按她自己的可读范围');
  } finally { h.close(); }
});

test('工具白名单只有 presence_respond 与心里话工具：点名音乐提交被拒绝，没有任何播放变更', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(callTool('commit_music', { songId: 's2' }), respond('quiet'));
    const wake = wakeFor('room', 'lunara');
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake });
    assert.deepEqual(result, { action: 'quiet' });
    assert.equal(h.musicCalls.length, 0);
    for (const call of h.calls.filter(item => item.kind === 'ambient')) {
      assert.deepEqual(call.tools, ['note_thought', 'schedule_followup', 'presence_respond']);
    }
    assert.ok(h.traces.some(event => event.requestId === wake.id && event.type === 'ambient_tool_result'
      && event.name === 'commit_music' && event.code === 'TOOL_NOT_AVAILABLE'));
  } finally { h.close(); }
});

test('生成期间用户开口：ambient 被中止，用户回合不等待，什么都不写', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    // 假模型无视取消、永不返回：用户回合仍要立刻完成，ambient 靠回合信号结束。
    h.ambientScript.push(() => { entered(); return new Promise(() => {}); });
    const pending = h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara') });
    await started;
    const reply = await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '在吗', speak: false });
    assert.equal(reply.ok, true);
    assert.deepEqual(await pending, { action: 'silent', reason: 'interrupted' });
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room'"), 4, 'u1 a1 u2 a2');
  } finally { h.close(); }
});

test('生成期间有串词入账：提交重验头序号失败，什么都不写', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(() => {
      h.conversationStore.recordTrackIntro({ sessionId: 'room', personId: 'lunara', correlationId: 'c1', queueItemId: 'q2',
        text: '下一首是《夜航星》。', track: { songId: 's1', title: '夜航星', artist: '不才', source: 'qq' } });
      return respond('speak', LINE);
    });
    const wake = wakeFor('room', 'lunara');
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake }),
      { action: 'silent', reason: 'stale' });
    assert.equal(h.conversationStore.getTurn(presenceTurnId(wake.id)), null);
  } finally { h.close(); }
});

test('同一 wake id 重放只入账一次，第二次不调模型', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(respond('speak', LINE), respond('speak', '再说一句。'));
    const wake = wakeFor('room', 'lunara');
    assert.equal((await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake })).action, 'speak');
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake }),
      { action: 'silent', reason: 'stale' });
    assert.equal(h.calls.filter(call => call.kind === 'ambient').length, 1);
    assert.equal(h.count("SELECT COUNT(*) AS n FROM conversation_turns WHERE session_id = 'room' AND message_json LIKE '%\"presence\"%'"), 1);
  } finally { h.close(); }
});

test('交付回调在入账之后、用户开口之前运行；不是成员或聊天已归档就不调模型', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(respond('speak', LINE));
    const delivered = [];
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara'),
      deliver: ({ turn, entity, isCurrent }) => { delivered.push({ turnId: turn.turnId, entity: entity.id, current: isCurrent() }); return 'spoken'; } });
    assert.equal(result.delivery, 'spoken');
    assert.deepEqual(delivered, [{ turnId: result.turn.turnId, entity: 'lunara', current: true }]);

    const stranger = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'nobody',
      wake: wakeFor('room', 'nobody') });
    assert.deepEqual(stranger, { action: 'silent', reason: 'stale' });
    h.conversationStore.updateRoom('room', { archived: true });
    const archived = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara',
      wake: wakeFor('room', 'lunara', { id: 'ambient:room:lunara:2' }) });
    assert.deepEqual(archived, { action: 'silent', reason: 'stale' });
    assert.equal(h.calls.filter(call => call.kind === 'ambient').length, 1);
  } finally { h.close(); }
});

// ---- 9. 阶段 A2：群聊（D9） ----

test('单聊拉人变群：拉人前只告诉她的话不进任何成员的 ambient 上下文；主持人仍是原伙伴', async () => {
  const h = createHarness();
  try {
    h.registry.createRadiohost({ id: 'xiaoman', displayName: '小满', voiceProfileId: 'voice-x', personaDocument: '小满的人设。' });
    h.conversationStore.createRoom({ sessionId: 'solo', memberIds: ['lunara'], hostId: 'lunara' });
    await h.runtime.handleTurn({ sessionId: 'solo', requestId: 's1', userText: '这件事只告诉你：我准备辞职了', speak: false });
    await h.runtime.handleTurn({ sessionId: 'solo', requestId: 's2', userText: '今天加班到很晚', speak: false });
    h.conversationStore.addMember('solo', 'xiaoman');
    assert.equal(h.conversationStore.getSession('solo').activeVirtualPersonId, 'lunara');
    for (const personId of ['lunara', 'xiaoman']) {
      h.ambientScript.push(respond('quiet'));
      const result = await h.runtime.handleAmbientTurn({ sessionId: 'solo', personId,
        wake: wakeFor('solo', personId, { id: `ambient:solo:${personId}:${NOW.getTime()}` }) });
      assert.deepEqual(result, { action: 'quiet' }, personId);
      const ambient = h.calls.filter(call => call.kind === 'ambient').at(-1);
      const context = JSON.stringify(ambient.messages);
      assert.ok(!context.includes('我准备辞职了'), `${personId} 的 ambient 不含私密的单聊内容`);
      assert.ok(context.includes('今天加班到很晚'), `${personId} 仍能看到公开的聊天`);
    }
  } finally { h.close(); }
});

test('跟话的人知道自己是跟着说的：提示里有跟话说明，出声者没有', async () => {
  const h = createHarness();
  try {
    for (const id of ['a', 'b']) h.registry.createRadiohost({ id, displayName: id.toUpperCase(), voiceProfileId: `voice-${id}`, personaDocument: `${id} 的人设。` });
    h.conversationStore.createRoom({ sessionId: 'group', memberIds: ['a', 'b'], hostId: 'a' });
    h.ambientScript.push(respond('quiet'), respond('quiet'));
    await h.runtime.handleAmbientTurn({ sessionId: 'group', personId: 'a', wake: wakeFor('group', 'a', { role: 'holder' }) });
    await h.runtime.handleAmbientTurn({ sessionId: 'group', personId: 'b',
      wake: wakeFor('group', 'b', { id: `ambient:group:a:${NOW.getTime()}:b`, role: 'follower' }) });
    const [holder, follower] = h.calls.filter(call => call.kind === 'ambient').map(call => call.messages[0].content);
    assert.doesNotMatch(holder, /跟着/);
    assert.match(follower, /跟着/);
    assert.match(follower, /不要重复/);
  } finally { h.close(); }
});

// ── 心里话（add-companion-heartbeat 阶段 B：6.4 / 6.6 / 6.7）────────────────────────────

const INNER_SECTION = '## 你心里记着的事';
const loopNote = (h, extra = {}) => h.conversationStore.notes.create({ noteId: 'note:loop', personId: 'lunara',
  sessionId: 'room', kind: 'open_loop', text: '她说周五要交方案', origin: 'reflection', ...extra });
const notesOf = h => h.conversationStore.db.prepare('SELECT note_id, kind, text, status, raised_count FROM companion_notes ORDER BY created_at, note_id').all();

test('ambient 心里话写入先暂存，与可见回合同一次入账；speak 引用的编号记为提过一次', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    loopNote(h);
    let pendingDuringLoop = null;
    h.ambientScript.push(
      callTool('note_thought', { text: '这几首都挺适合夜里' }),
      callTool('schedule_followup', { about: '问问方案交了没', inMinutes: 30 }),
      () => { pendingDuringLoop = notesOf(h).length; return {
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_speak', type: 'function',
          function: { name: 'presence_respond', arguments: JSON.stringify({ action: 'speak', text: '方案还顺利吗？', noteIds: ['n1'] }) } }] },
        finishReason: 'tool_calls' }; },
    );
    const wake = wakeFor('room', 'lunara');
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake });
    assert.equal(result.action, 'speak');
    assert.equal(pendingDuringLoop, 1, '模型还在想的时候一条也没写');
    const ambient = h.calls.find(call => call.kind === 'ambient');
    assert.ok(ambient.tools.includes('settle_thought'));
    const system = ambient.messages[0].content;
    assert.ok(system.includes(INNER_SECTION));
    assert.match(system, /n1 · 没完的事：她说周五要交方案/);
    assert.doesNotMatch(system, /note:loop/, '真实 noteId 不进提示词');
    const rows = notesOf(h);
    assert.deepEqual(rows.map(row => [row.kind, row.status]).sort(),
      [['followup', 'open'], ['open_loop', 'raised'], ['thought', 'open']]);
    assert.equal(rows.find(row => row.kind === 'open_loop').raised_count, 1);
  } finally { h.close(); }
});

test('安静的一轮也能留下心里话；重验失败时整批丢弃', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(callTool('note_thought', { text: '先不打扰' }), respond('quiet'));
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara',
      wake: wakeFor('room', 'lunara') }), { action: 'quiet' });
    assert.deepEqual(notesOf(h).map(row => row.text), ['先不打扰']);

    h.ambientScript.push(callTool('note_thought', { text: '不会被写下' }), () => {
      h.conversationStore.recordTrackIntro({ sessionId: 'room', personId: 'lunara', correlationId: 'c1', queueItemId: 'q2',
        text: '下一首是《夜航星》。', track: { songId: 's1', title: '夜航星', artist: '不才', source: 'qq' } });
      return respond('speak', LINE);
    });
    const later = wakeFor('room', 'lunara', { id: 'ambient:room:lunara:later' });
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: later }),
      { action: 'silent', reason: 'stale' });
    assert.deepEqual(notesOf(h).map(row => row.text), ['先不打扰']);
  } finally { h.close(); }
});

test('普通回合看得到心里话并可以了结，但没有新建心里话的工具', async () => {
  const h = createHarness();
  try {
    loopNote(h);
    h.ordinaryScript.push(callTool('settle_thought', { noteId: 'n1', status: 'resolved' }),
      { message: { role: 'assistant', content: '交了就好。' } });
    const response = await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '方案交啦', speak: false });
    assert.equal(response.displayText, '交了就好。');
    const ordinary = h.calls.filter(call => call.kind === 'ordinary');
    assert.ok(ordinary[0].tools.includes('settle_thought'));
    assert.ok(!ordinary[0].tools.includes('note_thought'));
    assert.ok(!ordinary[0].tools.includes('schedule_followup'));
    assert.ok(ordinary[0].messages[0].content.includes(INNER_SECTION));
    assert.equal(h.conversationStore.notes.get('note:loop').status, 'resolved');
    // 了结后没有可见心里话：下一轮的提示词与能力集回到没有心里话时的样子。
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '嗯', speak: false });
    const next = h.calls.filter(call => call.kind === 'ordinary').at(-1);
    assert.ok(!next.messages[0].content.includes(INNER_SECTION));
    assert.ok(!next.tools.includes('settle_thought'));
  } finally { h.close(); }
});

test('敏感的心里话只在普通回合出现，ambient 看不到', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    loopNote(h, { sensitive: true, text: '体检复查结果' });
    h.ambientScript.push(respond('quiet'));
    await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara') });
    const ambient = h.calls.find(call => call.kind === 'ambient');
    assert.ok(!ambient.messages[0].content.includes('体检'));
    assert.ok(!ambient.tools.includes('settle_thought'));
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '嗯', speak: false });
    const ordinary = h.calls.filter(call => call.kind === 'ordinary').at(-1);
    assert.match(ordinary.messages[0].content, /体检复查结果.*（私密：对方不提就不要主动提起）/);
  } finally { h.close(); }
});

test('为 followup 叫醒时它作为到期心里话出现，这一轮入账后就不再等它（安静也算想过了）', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.conversationStore.notes.create({ noteId: 'note:f1', personId: 'lunara', sessionId: 'room', kind: 'followup',
      text: '问问方案交了没', origin: 'ambient', wakeCondition: 'afterCurrentTrack:q-other-still-unknown' });
    h.conversationStore.notes.create({ noteId: 'note:f2', personId: 'lunara', sessionId: 'room', kind: 'followup',
      text: '还没到时候', origin: 'ambient', dueAt: Date.now() + 60 * 60_000 });
    h.ambientScript.push(respond('quiet'));
    const wake = wakeFor('room', 'lunara', { reason: 'followup', followupNoteIds: ['note:f1'],
      followups: [{ noteId: 'note:f1', personId: 'lunara', about: '问问方案交了没' }] });
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake }), { action: 'quiet' });
    const ambient = h.calls.find(call => call.kind === 'ambient');
    assert.match(ambient.messages[0].content, /n1 · 你打算再想想的 · 到时候了：问问方案交了没/);
    assert.doesNotMatch(ambient.messages[0].content, /还没到时候/, '没到期的 followup 不进 ambient');
    assert.match(ambient.messages.at(-1).content, /你之前想着「问问方案交了没」/);
    assert.equal(h.conversationStore.notes.get('note:f1').status, 'resolved');
    assert.equal(h.conversationStore.notes.get('note:f2').status, 'open');
    assert.deepEqual(h.conversationStore.notes.pendingFollowups('room').map(item => item.noteId), ['note:f2']);
  } finally { h.close(); }
});

test('群聊点名：提示词只给短编号与名字，presence_respond.invite 经 floor 映射成成员；被点名的人看到是谁点的她', async () => {
  const h = createHarness();
  try {
    for (const id of ['a', 'b']) h.registry.createRadiohost({ id, displayName: id.toUpperCase(), voiceProfileId: `voice-${id}`, personaDocument: `${id} 的人设。` });
    h.conversationStore.createRoom({ sessionId: 'group', memberIds: ['a', 'b'], hostId: 'a' });
    await h.runtime.handleTurn({ sessionId: 'group', requestId: 'g1', userText: '今天加班到很晚', speak: false });
    const invited = [];
    const floor = { targets: [{ personId: 'b', displayName: 'B' }], invite: personId => { invited.push(personId); return { ok: true }; } };
    h.ambientScript.push({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_invite', type: 'function',
      function: { name: 'presence_respond', arguments: JSON.stringify({ action: 'speak', text: `${LINE}B 你呢？`, invite: 'm1' }) } }] },
    finishReason: 'tool_calls' });
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'group', personId: 'a', wake: wakeFor('group', 'a'), floor });
    assert.equal(result.action, 'speak');
    assert.deepEqual(invited, ['b']);
    const system = h.calls.find(call => call.kind === 'ambient').messages[0].content;
    assert.match(system, /invite（编号）：m1 B/);
    assert.doesNotMatch(system, /score|intent|followup-due/i, '打分不进提示词');

    h.ambientScript.push(respond('quiet'));
    await h.runtime.handleAmbientTurn({ sessionId: 'group', personId: 'b',
      wake: wakeFor('group', 'b', { id: 'ambient:group:a:x:b', role: 'invited', invitedBy: { personId: 'a', displayName: 'A' } }),
      floor: { targets: [{ personId: 'a', displayName: 'A' }], invite: () => ({ ok: true }) } });
    const invitedSystem = h.calls.filter(call => call.kind === 'ambient').at(-1).messages[0].content;
    assert.match(invitedSystem, /A 刚在群里点名请你接话/);
    assert.match(invitedSystem, /invite=m1/);
  } finally { h.close(); }
});

test('单聊 ambient 的提示词没有任何点名内容', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    h.ambientScript.push(respond('quiet'));
    await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara'),
      floor: { targets: [{ personId: 'x', displayName: 'X' }], invite: () => ({ ok: true }) } });
    assert.doesNotMatch(h.calls.find(call => call.kind === 'ambient').messages[0].content, /点名|invite/);
  } finally { h.close(); }
});

test('正在输入：普通回合开始调模型时 composing，入账后 idle(committed)；重放不再发；ambient 回合自己不发', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    assert.deepEqual(h.activity.map(({ sessionId, personId, correlationId, state, outcome }) => [sessionId, personId, correlationId, state, outcome]),
      [['room', 'lunara', 'r1', 'composing', undefined], ['room', 'lunara', 'r1', 'idle', 'committed']]);
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天加班到很晚', speak: false });
    assert.equal(h.activity.length, 2, '重放不调模型，也不显示正在输入');
    h.ambientScript.push(respond('quiet'));
    await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara') });
    assert.equal(h.activity.length, 2, '安静的 ambient 回合从不显示正在输入');
  } finally { h.close(); }
});

test('正在输入：模型失败也以 idle 收尾', async () => {
  const h = createHarness();
  try {
    h.ordinaryScript.push(() => { throw Object.assign(new Error('boom'), { code: 'PROVIDER_DOWN' }); });
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '在吗', speak: false });
    assert.deepEqual(h.activity.map(event => event.state), ['composing', 'idle']);
    assert.equal(h.activity[1].correlationId, 'r1');
  } finally { h.close(); }
});

test('回来了（app_open）：系统提示换成刚打开 app 的情境，运行时提示只有粗粒度离开时长；工具仍只有在场工具', async () => {
  const h = createHarness();
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '明天面试，有点紧张', speak: false });
    h.ambientScript.push(respond('speak', '早，昨晚睡得还行吗？'));
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara',
      wake: wakeFor('room', 'lunara', { id: `app_open:room:${NOW.getTime()}`, reason: 'app_open', awayMs: 9 * 3_600_000,
        policy: null, sinceLastWake: {}, followerIds: [], followups: [], followupNoteIds: [] }) });
    assert.equal(result.action, 'speak');
    const ambient = h.calls.find(call => call.kind === 'ambient');
    assert.deepEqual(ambient.tools, ['note_thought', 'schedule_followup', 'presence_respond']);
    const system = ambient.messages[0].content;
    assert.ok(system.includes('## 这一轮（对方刚打开 app，还没有开口）'));
    assert.ok(!system.includes(AMBIENT_SECTION));
    assert.match(system, /离上次见面过了大半天/);
    const marker = ambient.messages.at(-1).content;
    assert.match(marker, /对方刚打开 app，离你们上次见面过了大半天/);
    assert.doesNotMatch(marker, /一起听|现在在放|app_open/);
  } finally { h.close(); }
});

// ===== add-ambient-music-recommendation：闸门、绑定可见话、同事务入账 =====

const WANFENG = { ok: true, code: 'RECOMMENDATION_RESOLVED', selectionId: 'selection:wanfeng',
  track: { songId: '42', source: 'qq', title: '晚风', artist: '陈婧霏' } };
const RECOMMEND_LINE = '这首完了想放《晚风》给你听，很像今晚的风。';
const recommendationRows = h => h.conversationStore.db.prepare('SELECT * FROM ambient_music_recommendations').all();

test('闸门开：多一个 recommend_track 与一句「想到具体的歌才推荐」；推荐随说出口的话同一事务入账', async () => {
  const resolved = [];
  const h = createHarness({ recommend: { resolve: (target, input) => { resolved.push({ target, input }); return WANFENG; } } });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.ambientScript.push(callTool('recommend_track', { title: '晚风', artist: '陈婧霏' }), respond('speak', RECOMMEND_LINE));
    const wake = wakeFor('room', 'lunara');
    const result = await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake });
    assert.equal(result.action, 'speak');
    const ambient = h.calls.find(call => call.kind === 'ambient');
    assert.deepEqual(ambient.tools, ['note_thought', 'schedule_followup', 'recommend_track', 'presence_respond']);
    assert.match(ambient.messages[0].content, /心里正好想到一首/);
    assert.doesNotMatch(ambient.messages[0].content, /每次|至少|应该推荐/);
    assert.deepEqual(resolved[0].target, { title: '晚风', artist: '陈婧霏' });
    assert.deepEqual({ sessionId: resolved[0].input.sessionId, virtualPersonId: resolved[0].input.virtualPersonId,
      requestId: resolved[0].input.requestId }, { sessionId: 'room', virtualPersonId: 'lunara', requestId: wake.id });
    assert.deepEqual(result.turn.message.musicRecommendation, { selectionId: 'selection:wanfeng', provider: 'qq', songId: '42',
      title: '晚风', artist: '陈婧霏', recommendedBy: 'lunara', status: 'pending', expiresAt: NOW.getTime() + 30 * 60_000 });
    assert.equal(h.recommendations.pending('room').turnId, result.turn.turnId);
    assert.equal(h.musicCalls.length, 0, '推荐不碰播放');
    // 下一轮普通回合的投影里不带推荐元数据（它在上下文小节里出现，不在历史正文里）。
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '好啊', speak: false });
    const ordinary = h.calls.filter(call => call.kind === 'ordinary').at(-1);
    assert.equal(ordinary.messages.some(message => /selection:wanfeng|musicRecommendation/.test(String(message.content))), false);
  } finally { h.close(); }
});

test('闸门关（已有 pending）：工具与提示里都没有推荐', async () => {
  const h = createHarness({ recommend: { resolve: () => WANFENG } });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.conversationStore.db.transaction(() => h.recommendations.record({ turnId: 'presence:earlier', sessionId: 'room',
      personId: 'lunara', item: { selectionId: 's', provider: 'qq', songId: '1', title: '旧', artist: '人' } }))();
    h.ambientScript.push(respond('quiet'));
    await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara') });
    const ambient = h.calls.find(call => call.kind === 'ambient');
    assert.equal(ambient.tools.includes('recommend_track'), false);
    assert.doesNotMatch(ambient.messages[0].content, /recommend_track|心里正好想到一首/);
    assert.ok(h.traces.some(event => event.type === 'ambient_recommendation_gate' && event.reason === 'pending'));
  } finally { h.close(); }
});

test('闸门关（不是当前听歌来源）时同样不提供推荐', async () => {
  const h = createHarness({ recommend: { source: 'elsewhere', resolve: () => WANFENG } });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.ambientScript.push(respond('quiet'));
    await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara') });
    assert.equal(h.calls.find(call => call.kind === 'ambient').tools.includes('recommend_track'), false);
  } finally { h.close(); }
});

test('暂存推荐后没点到歌名被拒；改成 quiet 时推荐整条丢弃', async () => {
  const h = createHarness({ recommend: { resolve: () => WANFENG } });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.ambientScript.push(callTool('recommend_track', { title: '晚风', artist: '陈婧霏' }),
      respond('speak', '今晚的风真大。'), respond('quiet'));
    const wake = wakeFor('room', 'lunara');
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake }), { action: 'quiet' });
    assert.ok(h.traces.some(event => event.type === 'ambient_tool_result' && event.rejectedRule === 'recommendation_not_mentioned'));
    assert.equal(h.conversationStore.getTurn(presenceTurnId(wake.id)), null);
    assert.deepEqual(recommendationRows(h), []);
    assert.ok(h.traces.some(event => event.type === 'ambient_recommendation_dropped' && event.reason === 'quiet'));
  } finally { h.close(); }
});

test('重验失败（生成期间有新回合入账）时推荐与这句话一起丢弃', async () => {
  const h = createHarness({ recommend: { resolve: () => WANFENG } });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.ambientScript.push(callTool('recommend_track', { title: '晚风', artist: '陈婧霏' }), () => {
      h.conversationStore.recordTrackIntro({ sessionId: 'room', personId: 'lunara', correlationId: 'c1', queueItemId: 'q2',
        text: '下一首是《夜航星》。', track: { songId: 's1', title: '夜航星', artist: '不才', source: 'qq' } });
      return respond('speak', RECOMMEND_LINE);
    });
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara') }),
      { action: 'silent', reason: 'stale' });
    assert.deepEqual(recommendationRows(h), []);
  } finally { h.close(); }
});

test('没有推荐时，声称已经安排的话照旧被拒', async () => {
  const h = createHarness({ recommend: { resolve: () => WANFENG } });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.ambientScript.push(respond('speak', '我已经安排了《夜航星》。'), respond('quiet'));
    assert.deepEqual(await h.runtime.handleAmbientTurn({ sessionId: 'room', personId: 'lunara', wake: wakeFor('room', 'lunara') }),
      { action: 'quiet' });
    assert.ok(h.traces.some(event => event.type === 'ambient_tool_result' && event.rejectedRule === 'playback_claim'));
  } finally { h.close(); }
});

test('有 pending 推荐时普通回合看得到「刚推荐过」与短引用 r1；select_music 用 r1 提交后推荐变 queued', async () => {
  const executed = [];
  const music = { execute: async (args, context) => {
    executed.push({ args: structuredClone(args), accepting: context.acceptingRecommendation });
    return { ok: true, code: 'MUSIC_COMMITTED', terminal: true, delivery: 'after_current', selectionId: 'selection:accepted',
      tracks: [{ songId: '42', source: 'qq', title: '晚风', artist: '陈婧霏' }], userMessage: '排上了。' };
  } };
  const h = createHarness({ recommend: { resolve: () => WANFENG }, music });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.conversationStore.db.transaction(() => h.recommendations.record({ turnId: 'presence:earlier', sessionId: 'room',
      personId: 'lunara', item: { selectionId: 'selection:wanfeng', provider: 'qq', songId: '42', title: '晚风', artist: '陈婧霏' } }))();
    h.ordinaryScript.push(callTool('select_music', { mode: 'exact', delivery: 'after_current', count: 1,
      reference: { selectionId: 'r1', indexes: [1] } }));
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '好，放刚才那首', speak: false });
    const prompt = h.calls.filter(call => call.kind === 'ordinary').at(-1).messages[0].content;
    assert.match(prompt, /刚推荐过/);
    assert.match(prompt, /《晚风》/);
    assert.match(prompt, /r1/);
    assert.doesNotMatch(prompt, /selection:wanfeng/, '模型只看到短引用');
    assert.equal(executed.length, 1);
    assert.equal(executed[0].args.reference.selectionId, 'selection:wanfeng', '短引用映射回真实 selection');
    assert.deepEqual(executed[0].accepting, { turnId: 'presence:earlier', selectionId: 'selection:wanfeng', recommendedBy: 'lunara' });
    assert.equal(h.recommendations.view('presence:earlier').status, 'queued');
  } finally { h.close(); }
});

test('没有 pending 推荐时普通回合没有「刚推荐过」小节，r1 不会被映射', async () => {
  const executed = [];
  const music = { execute: async (args, context) => {
    executed.push({ args: structuredClone(args), accepting: context.acceptingRecommendation });
    return { ok: false, code: 'INVALID_MUSIC_REQUEST', userMessage: '没听清。' };
  } };
  const h = createHarness({ recommend: { resolve: () => WANFENG }, music });
  try {
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r1', userText: '今天风好大', speak: false });
    h.ordinaryScript.push(callTool('select_music', { mode: 'exact', delivery: 'after_current', count: 1,
      reference: { selectionId: 'r1', indexes: [1] } }));
    await h.runtime.handleTurn({ sessionId: 'room', requestId: 'r2', userText: '放刚才那首', speak: false });
    assert.doesNotMatch(h.calls.filter(call => call.kind === 'ordinary').at(-1).messages[0].content, /刚推荐过/);
    assert.equal(executed[0].args.reference.selectionId, 'r1');
    assert.equal(executed[0].accepting ?? null, null);
  } finally { h.close(); }
});
