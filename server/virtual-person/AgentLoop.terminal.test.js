import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const ok = (code, extra = {}) => createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code, modelContext: code,
  presentation: { displayText: '', speak: false }, ...extra });
const fail = code => createToolOutcome({ kind: ToolOutcomeKind.BUSINESS_FAILURE, code, modelContext: code,
  presentation: { displayText: '没有完成。', speak: false, retryable: true } });

function fakeRegistry(handlers, { readOnly = [] } = {}) {
  const executed = [];
  return {
    executed,
    definitions: () => Object.keys(handlers).map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    isReadOnly: name => readOnly.includes(name),
    async execute(name, args, context) {
      executed.push(name);
      return handlers[name](args, context);
    },
  };
}

function scriptedChat(responses) {
  let index = 0;
  const chat = async () => {
    const next = responses[index++];
    if (!next) throw new Error('unexpected extra model round');
    return { message: { role: 'assistant', content: next.content || '', ...(next.calls ? { tool_calls: next.calls } : {}) } };
  };
  chat.calls = () => index;
  return chat;
}

test('calls after an accepted terminal outcome in the same batch are skipped, not executed', async () => {
  const registry = fakeRegistry({
    control_listening: () => ok('LISTENING_CONTROLLED', { terminal: true, presentation: { displayText: '好，继续播放。', speak: false } }),
    remember_person_fact: () => ok('PERSON_FACT_REMEMBERED'),
  });
  const chat = scriptedChat([{ calls: [call('c1', 'control_listening', { action: 'resume' }), call('c2', 'remember_person_fact', { fact: 'x' })] }]);
  const messages = [];
  const result = await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's', messages: [],
    onMessage: event => { if (event.kind === 'tool_result') messages.push(event); } });
  assert.deepEqual(registry.executed, ['control_listening']);
  assert.equal(result.finalText, '好，继续播放。');
  assert.deepEqual(result.outcomes.map(item => item.code), ['LISTENING_CONTROLLED', 'SKIPPED_AFTER_TERMINAL']);
  // tool 协议保持完整：每个 provider call id 都有结果。
  assert.deepEqual(messages.map(event => event.message.tool_call_id), ['c1', 'c2']);
  assert.equal(chat.calls(), 1);
});

test('cancellation arriving after an accepted terminal outcome does not turn it into an error', async () => {
  const outer = new AbortController();
  const registry = fakeRegistry({
    // 不用 commit_music_selection：IntentRouter 会把它排到同批最后。
    control_listening: () => {
      const outcome = ok('LISTENING_CONTROLLED', { terminal: true, presentation: { displayText: '已经安排好了。', speak: false } });
      outer.abort(new Error('user cancelled'));
      return outcome;
    },
    remember_person_fact: () => ok('PERSON_FACT_REMEMBERED'),
  });
  const chat = scriptedChat([{ calls: [call('c1', 'control_listening', { action: 'play' }), call('c2', 'remember_person_fact')] }]);
  const result = await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's', signal: outer.signal });
  assert.equal(result.finalText, '已经安排好了。');
  assert.deepEqual(registry.executed, ['control_listening']);
});

test('read-only tools re-execute in a later round so the model sees current state', async () => {
  let queueLength = 1;
  const registry = fakeRegistry({
    get_listening_state: () => ok('LISTENING_STATE', { facts: { queueLength } }),
    edit_listening_queue: () => { queueLength = 2; return ok('QUEUE_EDITED'); },
  }, { readOnly: ['get_listening_state'] });
  const chat = scriptedChat([
    { calls: [call('a', 'get_listening_state')] },
    { calls: [call('b', 'edit_listening_queue', { add: 1 })] },
    { calls: [call('c', 'get_listening_state')] },
    { content: '现在有两首。' },
  ]);
  const result = await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's' });
  assert.deepEqual(registry.executed, ['get_listening_state', 'edit_listening_queue', 'get_listening_state']);
  assert.equal(result.outcomes[2].facts.queueLength, 2);
});

test('a failed call is re-executed when retried in a later round', async () => {
  let attempts = 0;
  const registry = fakeRegistry({ search_music: () => (++attempts === 1 ? fail('SEARCH_UNAVAILABLE') : ok('SEARCH_OK')) });
  const chat = scriptedChat([
    { calls: [call('a', 'search_music', { q: '晴天' })] },
    { calls: [call('b', 'search_music', { q: '晴天' })] },
    { content: '找到了。' },
  ]);
  const result = await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's' });
  assert.equal(attempts, 2);
  assert.deepEqual(result.outcomes.map(item => item.code), ['SEARCH_UNAVAILABLE', 'SEARCH_OK']);
});

test('a successful mutation is reused across rounds instead of repeating its side effect', async () => {
  const registry = fakeRegistry({ remember_person_fact: () => ok('PERSON_FACT_REMEMBERED') });
  const chat = scriptedChat([
    { calls: [call('a', 'remember_person_fact', { fact: 'x' })] },
    { calls: [call('b', 'remember_person_fact', { fact: 'x' })] },
    { content: '记住了。' },
  ]);
  await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's' });
  assert.deepEqual(registry.executed, ['remember_person_fact']);
});

test('identical read-only calls inside one batch still execute once', async () => {
  const registry = fakeRegistry({ get_listening_state: () => ok('LISTENING_STATE') }, { readOnly: ['get_listening_state'] });
  const chat = scriptedChat([
    { calls: [call('a', 'get_listening_state'), call('b', 'get_listening_state')] },
    { content: '好。' },
  ]);
  await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's' });
  assert.deepEqual(registry.executed, ['get_listening_state']);
});

function deferredRegistry(names, { readOnly = [] } = {}) {
  const pending = new Map();
  const log = [];
  return {
    log,
    release: id => pending.get(id)?.(),
    definitions: () => names.map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    isReadOnly: name => readOnly.includes(name),
    execute(name, args) {
      log.push(`start:${args.id}`);
      return new Promise(resolve => pending.set(args.id, () => {
        log.push(`end:${args.id}`);
        resolve(ok(`${name}:${args.id}`));
      }));
    },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('consecutive read-only calls in one batch run concurrently and keep their result order', async () => {
  const registry = deferredRegistry(['search_music'], { readOnly: ['search_music'] });
  const chat = scriptedChat([
    { calls: [call('a', 'search_music', { id: 1 }), call('b', 'search_music', { id: 2 }), call('c', 'search_music', { id: 3 })] },
    { content: '好。' },
  ]);
  const seen = [];
  const running = new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's',
    onMessage: event => { if (event.kind === 'tool_result') seen.push(event.message.tool_call_id); } });
  await tick(); await tick();
  assert.deepEqual(registry.log, ['start:1', 'start:2', 'start:3']);
  registry.release(3); registry.release(2); await tick();
  assert.deepEqual(seen, []);
  registry.release(1);
  const result = await running;
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual(result.outcomes.map(item => item.code), ['search_music:1', 'search_music:2', 'search_music:3']);
});

test('a side-effect call never overlaps read-only calls around it', async () => {
  const registry = deferredRegistry(['search_music', 'remember_person_fact'], { readOnly: ['search_music'] });
  const chat = scriptedChat([
    { calls: [call('a', 'search_music', { id: 1 }), call('b', 'remember_person_fact', { id: 2 }), call('c', 'search_music', { id: 3 })] },
    { content: '好。' },
  ]);
  const running = new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's' });
  await tick(); await tick();
  assert.deepEqual(registry.log, ['start:1']);
  registry.release(1); await tick(); await tick();
  assert.deepEqual(registry.log, ['start:1', 'end:1', 'start:2']);
  registry.release(2); await tick(); await tick();
  assert.deepEqual(registry.log.slice(3), ['end:2', 'start:3']);
  registry.release(3);
  await running;
});

test('a failing read-only call does not disturb its concurrent siblings', async () => {
  const registry = fakeRegistry({
    search_music: args => (args.q === 'bad' ? fail('SEARCH_UNAVAILABLE') : ok('SEARCH_OK')),
  }, { readOnly: ['search_music'] });
  const chat = scriptedChat([
    { calls: [call('a', 'search_music', { q: 'bad' }), call('b', 'search_music', { q: 'good' })] },
    { content: '好。' },
  ]);
  const result = await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's' });
  assert.deepEqual(result.outcomes.map(item => item.code), ['SEARCH_UNAVAILABLE', 'SEARCH_OK']);
});

test('a long read-only batch is bounded so external sources never see the whole batch at once', async () => {
  let active = 0;
  let peak = 0;
  const registry = fakeRegistry({
    search_music: async () => { active++; peak = Math.max(peak, active); await tick(); active--; return ok('SEARCH_OK'); },
  }, { readOnly: ['search_music'] });
  const calls = Array.from({ length: 9 }, (_, index) => call(`s${index}`, 'search_music', { q: index }));
  const chat = scriptedChat([{ calls }, { content: '好。' }]);
  const result = await new AgentLoop({ chat, toolRegistry: registry }).run({ systemPrompt: 's' });
  assert.equal(result.outcomes.length, 9);
  assert.ok(peak > 1 && peak <= 4, `peak concurrency ${peak}`);
});

test('a terminal commit may carry the line the model wrote in the same message, if it passes the commit line check', async () => {
  const committed = () => ok('MUSIC_COMMITTED', { terminal: true,
    presentation: { displayText: '好，《特别的人》已经安排上了。', speak: false, modelLine: { allowedTitles: ['特别的人'] } } });
  const run = async content => new AgentLoop({
    chat: scriptedChat([{ content, calls: [call('c1', 'commit_music_selection', { offerId: 'o', indexes: [1] })] }]),
    toolRegistry: fakeRegistry({ commit_music_selection: committed }),
  }).run({ systemPrompt: 's', messages: [] });
  assert.equal((await run('我挑了《特别的人》，这首的温度刚好。')).finalText, '我挑了《特别的人》，这首的温度刚好。');
  assert.equal((await run('《特别的人》已经在放了。')).finalText, '好，《特别的人》已经安排上了。', '宣称已经出声就用复核过的固定文案');
  assert.equal((await run('《爱爱爱》也加上了。')).finalText, '好，《特别的人》已经安排上了。', '提到没提交的歌就用固定文案');
  assert.equal((await run('')).finalText, '好，《特别的人》已经安排上了。');
});

test('terminal outcomes without a model line policy keep their reviewed copy even when the model wrote text', async () => {
  const result = await new AgentLoop({
    chat: scriptedChat([{ content: '我已经帮你暂停了。', calls: [call('c1', 'control_listening', { action: 'resume' })] }]),
    toolRegistry: fakeRegistry({
      control_listening: () => ok('LISTENING_CONTROLLED', { terminal: true, presentation: { displayText: '好，继续播放。', speak: false } }),
    }),
  }).run({ systemPrompt: 's', messages: [] });
  assert.equal(result.finalText, '好，继续播放。');
});

// ============================================================
// 受限任务的请求形状（add-reasoning-effort-controls 任务 3.3）：
// 空历史补一条中性 user 指令，只进请求不进对话账本
// ============================================================

const noToolsRegistry = {
  definitions: () => [],
  execute: () => { throw new Error('unexpected tool call'); },
};

test('empty-history task sends system + one neutral user instruction, without writing it to history', async () => {
  const sent = [];
  const loop = new AgentLoop({
    toolRegistry: noToolsRegistry,
    chat: async messages => {
      sent.push(messages);
      return { message: { role: 'assistant', content: '好了。' } };
    },
  });
  const result = await loop.run({ systemPrompt: '选一首合适的歌。', messages: [] });
  assert.equal(result.finalText, '好了。');
  assert.equal(sent.length, 1, 'one model call');
  assert.deepEqual(sent[0].map(message => message.role), ['system', 'user']);
  assert.equal(sent[0][0].content, '选一首合适的歌。');
  assert.equal(sent[0][1].content, '按系统说明执行本轮任务。');
  assert.deepEqual(result.messages, [], '补的用户消息只进请求，不写进账本/可见记录');
  assert.deepEqual(result.outcomes, []);
});

test('prompt-too-long recovery request also carries the minimum user instruction', async () => {
  const sent = [];
  let calls = 0;
  const contextBudgeter = { prepare: async () => [] };
  const loop = new AgentLoop({
    toolRegistry: noToolsRegistry,
    contextBudgeter,
    chat: async messages => {
      sent.push(messages);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('context length exceeded'), { code: 'context_length_exceeded' });
      return { message: { role: 'assistant', content: '好了。' } };
    },
  });
  const result = await loop.run({ systemPrompt: '选一首合适的歌。', messages: [] });
  assert.equal(result.finalText, '好了。');
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].map(message => message.role), ['system', 'user'], '恢复请求同样补最少 user 消息');
  assert.equal(sent[1][1].content, '按系统说明执行本轮任务。');
});

test('existing chat history is not rewritten with the neutral user instruction', async () => {
  const history = [
    { role: 'user', content: '推荐一首歌' },
    { role: 'assistant', content: '好的。' },
  ];
  const sent = [];
  const loop = new AgentLoop({
    toolRegistry: noToolsRegistry,
    chat: async messages => {
      sent.push(messages);
      return { message: { role: 'assistant', content: '继续。' } };
    },
  });
  const result = await loop.run({ systemPrompt: 's', messages: history });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 3, '不追加第五条消息');
  assert.deepEqual(sent[0][0], { role: 'system', content: 's' });
  assert.equal(sent[0].filter(message => message.role === 'user').length, 1, '不重复注入中性指令');
  assert.deepEqual(sent[0].slice(1), history, '已有聊天历史原样发送');
  assert.deepEqual(result.messages, history);
});
