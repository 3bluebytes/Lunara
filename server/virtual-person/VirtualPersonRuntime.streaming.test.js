import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from './AgentLoop.js';
import { ConversationStore } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createToolOutcome } from './VirtualPersonTypes.js';

function fixture(t, chat) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-stream-runtime-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath });
  const store = new ConversationStore({ dbPath });
  const tools = new VirtualPersonToolRegistry();
  const runtime = new VirtualPersonRuntime({ conversationStore: store, registry,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools }), promptAssembler: new PromptAssembler(),
    presentationService: new PresentationService(), capabilityResolver: () => ['general'],
    retrieveMemories: async () => [], logger: { error() {}, warn() {} } }).initialize();
  t.after(() => { runtime.shutdown(); registry.close(); rmSync(dir, { recursive: true, force: true }); });
  return { runtime, store, tools };
}
const input = (requestId, more = {}) => ({ sessionId: 'room', requestId, userText: '你好', speak: false, ...more });
const reply = text => ({ message: { role: 'assistant', content: text }, finishReason: 'stop' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('text_stream keeps tools, scopes drafts and commits one durable assistant message', async t => {
  const events = [];
  const h = fixture(t, async (messages, tools, options) => {
    assert.ok(Array.isArray(tools) && tools.some(tool => tool.function.name === 'write'));
    assert.equal(options.streamRequired, true);
    assert.doesNotMatch(messages[0].content, /没有工具|仅聊天流式模式/);
    options.onStreamReset({ attempt: 1 });
    options.onTextDelta({ text: '草稿', attempt: 1 });
    assert.equal(h.store.listTurns('room').filter(x => x.role === 'assistant').length, 0);
    return reply('最终正文');
  });
  let writes = 0;
  h.tools.register('write', { handler: async () => {
    writes += 1;
    return createToolOutcome({ kind: 'success', code: 'WRITTEN', facts: {} });
  } });
  const result = await h.runtime.handleTurn(input('s1', { mode: 'text_stream', onDraft: e => events.push(e) }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.displayText, '最终正文');
  assert.deepEqual(events.map(e => e.type), ['reset', 'delta', 'end']);
  assert.ok(events.every(e => e.sessionId === 'room' && e.roundId === 's1' && e.virtualPersonId === 'lunara'));
  assert.equal(writes, 0);
  assert.equal(h.store.listTurns('room').filter(x => x.role === 'assistant').length, 1);
});

test('a tool call clears a playback-claiming draft, then the committed answer is shown', async t => {
  let fallback = 0;
  let round = 0;
  const events = [];
  const h = fixture(t, async () => {
    round += 1;
    return round === 1 ? ({ message: { content: '已经给你换好了', tool_calls: [
      { id: 't', type: 'function', function: { name: 'write', arguments: '{}' } } ] } })
      : reply('这首已经安排。');
  });
  h.runtime.basicPlaybackFallback = async () => { fallback++; return {}; };
  let writes = 0;
  h.tools.register('write', { handler: async () => {
    writes += 1;
    return createToolOutcome({ kind: 'success', code: 'WRITTEN', facts: {} });
  } });
  const result = await h.runtime.handleTurn(input('s1', { mode: 'text_stream', onDraft: e => events.push(e) }));
  assert.equal(result.ok, true);
  assert.equal(result.displayText, '这首已经安排。');
  assert.equal(writes, 1);
  assert.equal(fallback, 0);
  assert.equal(events.some(e => e.type === 'delta' && e.text.includes('已经给你换好了')), false);
  assert.equal(events.at(-1).type, 'end');
});

test('scoped interruption aborts old model work and drops its late draft', async t => {
  const started = deferred(), finish = deferred();
  let lateDelta;
  const events = [];
  let calls = 0;
  const h = fixture(t, async (_m, _t, options) => {
    if (++calls === 1) { lateDelta = options.onTextDelta; started.resolve(); await finish.promise; }
    return reply(calls === 1 ? '旧回复' : '新回复');
  });
  const old = h.runtime.handleTurn(input('old', { mode: 'text_stream', onDraft: e => events.push(e) }));
  await started.promise;
  const next = h.runtime.handleTurn(input('new', { interruptRequestId: 'old' }));
  assert.equal((await old).ok, false);
  assert.equal((await next).ok, true);
  lateDelta({ text: '迟到', attempt: 1 }); finish.resolve();
  assert.equal(events.some(e => e.text === '迟到'), false);
  assert.equal(calls, 2);
  assert.equal(h.runtime.pendingTurns.size, 0);
});

test('a replay carrying an old interruption cannot abort a newer active round', async t => {
  const started = deferred(), finish = deferred();
  let calls = 0;
  const h = fixture(t, async () => { if (++calls === 2) { started.resolve(); await finish.promise; } return reply('回答'); });
  await h.runtime.handleTurn(input('old'));
  const active = h.runtime.handleTurn(input('active'));
  await started.promise;
  const replay = await h.runtime.handleTurn(input('old', { interruptRequestId: 'active' }));
  assert.equal(replay.ok, true);
  assert.equal(h.runtime.controllers.get('room').signal.aborted, false);
  assert.equal(h.runtime.cancel('room', 'unrelated'), false);
  finish.resolve();
  assert.equal((await active).ok, true);
});

test('an interruption targets queued work too, without cancelling the wrong active round', async t => {
  const started = deferred(), finish = deferred();
  let calls = 0;
  const h = fixture(t, async () => { if (++calls === 1) { started.resolve(); await finish.promise; } return reply('回答'); });
  const first = h.runtime.handleTurn(input('first'));
  await started.promise;
  const queued = h.runtime.handleTurn(input('queued'));
  const latest = h.runtime.handleTurn(input('latest', { interruptRequestId: 'queued' }));
  assert.equal(h.runtime.controllers.get('room').signal.aborted, false);
  finish.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await queued).cancelled, true);
  assert.equal((await latest).ok, true);
  assert.equal(calls, 2);
});

test('draft guard blocks credentials split across deltas', async t => {
  const events = [];
  const h = fixture(t, async (_m, _t, options) => {
    options.onTextDelta({ text: 'api_', attempt: 1 });
    options.onTextDelta({ text: 'key: sk-live-secret', attempt: 1 });
    options.onTextDelta({ text: '后续不该显示', attempt: 1 });
    return reply('安全正文');
  });
  await h.runtime.handleTurn(input('s1', { mode: 'text_stream', onDraft: e => events.push(e) }));
  assert.equal(JSON.stringify(events).includes('sk-live-secret'), false);
  assert.equal(events.some(e => e.type === 'reset'), true);
  assert.equal(events.some(e => String(e.text || '').includes('后续')), false);
});

test('split peer markers never reach the draft channel', async t => {
  const events = [];
  const h = fixture(t, async (_m, _t, options) => {
    options.onTextDelta({ text: '你好 <peer_', attempt: 1 });
    options.onTextDelta({ text: 'message from="x">好', attempt: 1 });
    return reply('安全正文');
  });
  await h.runtime.handleTurn(input('s1', { mode: 'text_stream', onDraft: e => events.push(e) }));
  let shown = '';
  for (const event of events) shown = event.type === 'reset' ? '' : shown + String(event.text || '');
  assert.equal(shown, '你好 好');
  assert.equal(events.some(e => e.type === 'reset'), true);
  assert.equal(events.at(-1).type, 'end');
});

test('a stale interrupt for a committed round cannot silence its pending presentation', async t => {
  const h = fixture(t, async () => reply('已经说完了'));
  await h.runtime.handleTurn(input('done'));
  assert.equal(h.runtime.isPresentationCurrent('room', 'done'), true);
  assert.equal(h.runtime.cancel('room', 'done'), false);
  assert.equal(h.runtime.isPresentationCurrent('room', 'done'), true);
});

test('a second text stream cannot hijack the same in-flight request', async t => {
  const started = deferred(), finish = deferred();
  const h = fixture(t, async () => { started.resolve(); await finish.promise; return reply('回答'); });
  const first = h.runtime.handleTurn(input('same', { mode: 'text_stream' }));
  await started.promise;
  await assert.rejects(h.runtime.handleTurn(input('same', { mode: 'text_stream' })),
    { code: 'REQUEST_ALREADY_STREAMING', statusCode: 409 });
  finish.resolve();
  assert.equal((await first).ok, true);
});

test('an accepted mutation survives interruption and is not repeated', async t => {
  const accepted = deferred(), settled = deferred();
  let mutations = 0, calls = 0;
  const h = fixture(t, async () => ++calls === 1 ? ({ message: { content: '', tool_calls: [
    { id: 't', type: 'function', function: { name: 'write', arguments: '{}' } } ] } }) : reply('新回合'));
  h.tools.register('write', { handler: async () => {
    mutations++; accepted.resolve(); await settled.promise;
    return createToolOutcome({ kind: 'success', code: 'MUSIC_COMMITTED', terminal: true,
      presentation: { displayText: '歌曲已安排。', speak: false } });
  } });
  const old = h.runtime.handleTurn(input('old'));
  await accepted.promise;
  const next = h.runtime.handleTurn(input('new', { interruptRequestId: 'old' }));
  settled.resolve();
  const committed = await old;
  assert.equal(committed.ok, true);
  assert.equal(committed.displayText, '歌曲已安排。');
  assert.equal(committed.presentation.speak, false);
  assert.equal((await next).ok, true);
  assert.equal(mutations, 1);
});

test('rapid interjections end superseded responses quietly and the last one answers all messages together', async t => {
  const gates = [deferred(), deferred()], started = [deferred(), deferred()];
  const seen = [];
  let calls = 0;
  const h = fixture(t, async messages => {
    const index = calls++;
    seen.push(messages);
    if (index < 2) { started[index].resolve(); await gates[index].promise; }
    return reply(index < 2 ? '旧回复' : '一起回答');
  });
  const first = h.runtime.handleTurn(input('m1', { userText: '你喜欢什么样的歌' }));
  await started[0].promise;
  const second = h.runtime.handleTurn(input('m2', { userText: '认识这么久还不知道', interruptRequestId: 'm1' }));
  await first;
  await started[1].promise;
  const third = h.runtime.handleTurn(input('m3', { userText: '我想听听你的喜欢', interruptRequestId: 'm2' }));
  gates.forEach(gate => gate.resolve());
  assert.equal((await second).cancelled, true);
  assert.equal((await third).ok, true);
  const turns = h.store.listTurns('room');
  assert.deepEqual(turns.filter(turn => turn.role === 'user').map(turn => turn.message.content),
    ['你喜欢什么样的歌', '认识这么久还不知道', '我想听听你的喜欢']);
  const assistant = turns.filter(turn => turn.role === 'assistant');
  assert.deepEqual(assistant.map(turn => turn.message.content), ['一起回答']);
  assert.equal(h.store.getRequest('m1:lunara:0')?.state ?? h.store.getRequest('m1')?.state, 'aborted');
  const lastUser = seen.at(-1).filter(message => message.role === 'user').at(-1).content;
  assert.match(lastUser, /你喜欢什么样的歌[\s\S]*认识这么久还不知道[\s\S]*我想听听你的喜欢/);
});

test('an explicit stop keeps its stop notice', async t => {
  const started = deferred(), finish = deferred();
  const h = fixture(t, async () => { started.resolve(); await finish.promise; return reply('回答'); });
  const running = h.runtime.handleTurn(input('s1'));
  await started.promise;
  h.runtime.cancel('room', 's1');
  finish.resolve();
  assert.equal((await running).ok, false);
  const assistant = h.store.listTurns('room').filter(turn => turn.role === 'assistant');
  assert.deepEqual(assistant.map(turn => turn.message.content), ['已停止这轮对话。']);
});

test('流式草稿在会话修订号未变时不再逐 delta 查库，成员/归档变更时回落并阻断滞后草稿', async t => {
  const events = [];
  let membershipReads = 0;
  let sessionReads = 0;
  let sawDeltaInsideLoop = false;
  const h = fixture(t, async (_messages, _tools, options) => {
    const beforeMem = membershipReads;
    const beforeSess = sessionReads;
    options.onTextDelta({ text: '第一段', attempt: 1 });
    options.onTextDelta({ text: '第二段', attempt: 1 });
    options.onTextDelta({ text: '第三段', attempt: 1 });
    assert.equal(membershipReads, beforeMem, '稳定期间每个 delta 不再查 membershipToken');
    assert.equal(sessionReads, beforeSess, '稳定期间每个 delta 不再查 getSession');
    sawDeltaInsideLoop = true;
    // 真实归档/变更会让 sessionRevision 递增，草稿门控随之回落核验并阻止后续草稿发出。
    h.store.updateRoom('room', { archived: true });
    options.onTextDelta({ text: '归档后的滞后草稿', attempt: 1 });
    return reply('已提交');
  });
  h.store.ensureSession('room', 'lunara');
  const origToken = h.store.membershipToken.bind(h.store);
  const origSession = h.store.getSession.bind(h.store);
  h.store.membershipToken = (...args) => { membershipReads += 1; return origToken(...args); };
  h.store.getSession = (...args) => { sessionReads += 1; return origSession(...args); };
  await h.runtime.handleTurn(input('stream-rev', { mode: 'text_stream', onDraft: e => events.push(e) }));
  assert.equal(sawDeltaInsideLoop, true);
  const deltas = events.filter(e => e.type === 'delta').map(e => e.text).join('');
  assert.equal(deltas, '第一段第二段第三段');
  assert.doesNotMatch(deltas, /归档后的滞后草稿/);
});
