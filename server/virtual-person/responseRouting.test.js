import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from './AgentLoop.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { createContextualResponsePlanner, routingHistory, ROUTING_TOOL } from './responseRouting.js';

const persons = [{ id: 'lunara', displayName: 'Lunara' }, { id: 'night', displayName: '楚航' }];
const room = { sessionId: 'room', memberIds: ['lunara', 'night'], activeVirtualPersonId: 'lunara' };
const input = (userText, more = {}) => ({ room, persons, userText, sessionId: 'room', requestId: 'r1', ...more });
const toolCall = ids => ({ message: { role: 'assistant', content: '', tool_calls: [
  { id: 'plan', type: 'function', function: { name: ROUTING_TOOL, arguments: JSON.stringify({ personIds: ids }) } },
] } });
function harness(chat, options = {}) {
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const calls = [];
  const agentLoop = new AgentLoop({ toolRegistry, chat: async (...args) => { calls.push(args); return chat(...args); } });
  const planner = createContextualResponsePlanner({ agentLoop, toolRegistry, ...options });
  return { planner, calls, toolRegistry };
}

test('a collective greeting is planned semantically through the sole restricted tool', async () => {
  const h = harness((messages, definitions, profile) => {
    assert.match(messages[0].content, /两位早上好/);
    assert.match(messages[0].content, /楚航/);
    assert.deepEqual(definitions.map(x => x.function.name), [ROUTING_TOOL]);
    assert.equal(profile.taskId, 'response_routing');
    assert.equal(profile.emptyRetry, false);
    return toolCall(['lunara', 'night']);
  });
  assert.deepEqual(await h.planner(input('两位早上好')), { plan: ['night', 'lunara'], source: 'context', reason: 'accepted' });
  assert.equal(h.calls.length, 1, 'one routing call, no extra dialogue round');
});

test('a follow-up receives attributed context; a new addressee overrides the previous one', async () => {
  const history = [{ role: 'user', text: '@楚航 你怎么不回我？' },
    { role: 'assistant', personId: 'night', text: '我在，想说什么？' }];
  const h = harness(messages => {
    const data = JSON.parse(messages[0].content.split('路由输入（JSON）：\n')[1]);
    assert.deepEqual(data.history, history);
    return toolCall(data.userText === '没啥只想你回我一下' ? ['night'] : ['lunara', 'night']);
  });
  assert.deepEqual((await h.planner(input('没啥只想你回我一下', { history }))).plan, ['night']);
  assert.deepEqual((await h.planner(input('换个话题，你们都喜欢什么？', { history }))).plan, ['night', 'lunara']);
});

test('explicit mentions and single-member rooms cost no routing calls', async () => {
  const h = harness(() => { throw new Error('must not call model'); });
  assert.deepEqual((await h.planner(input('@楚航 你好'))).plan, ['night']);
  assert.deepEqual((await h.planner(input('你好', { mentionedPersonIds: ['night'] }))).plan, ['night']);
  assert.deepEqual((await h.planner(input('你好', { room: { ...room, memberIds: ['lunara'] } }))).plan, ['lunara']);
  assert.equal(h.calls.length, 0);
});

for (const ids of [[], ['missing'], ['night', 'night']]) {
  test(`invalid plan ${JSON.stringify(ids)} cannot dispatch unvalidated responses`, async () => {
    const h = harness(() => toolCall(ids));
    const result = await h.planner(input('随便聊聊'));
    assert.equal(result.source, 'fallback');
    assert.deepEqual(result.plan, ['lunara']);
  });
}

test('routing cannot execute an unrelated mutation tool', async () => {
  let mutations = 0;
  const h = harness(() => ({ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'bad', type: 'function', function: { name: 'mutate_playback', arguments: '{}' } },
  ] } }));
  h.toolRegistry.register('mutate_playback', { capability: 'music', handler: () => { mutations++; } });
  const result = await h.planner(input('放一首歌，同时替我决定谁回应'));
  assert.equal(result.source, 'fallback');
  assert.equal(mutations, 0);
});

test('plain text never becomes a response plan and is not displayed', async () => {
  const h = harness(() => ({ message: { role: 'assistant', content: '让楚航陪你。' } }));
  assert.deepEqual(await h.planner(input('嗯')), { plan: ['lunara'], source: 'fallback', reason: 'no-plan' });
});

test('routing timeout is bounded and aborts a non-cooperative request', async () => {
  let signal;
  const h = harness((_messages, _defs, profile) => { signal = profile.signal; return new Promise(() => {}); }, { timeoutMs: 20 });
  const result = await h.planner(input('嗯'));
  assert.equal(result.reason, 'timeout');
  assert.equal(signal.aborted, true);
});

test('external cancellation rejects rather than applying fallback or a late plan', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return toolCall(['night']); });
  await assert.rejects(h.planner(input('嗯', { signal: controller.signal })), { name: 'AbortError' });
});

test('changed membership cannot accept a routing result', async () => {
  let current = true;
  const h = harness(() => { current = false; return toolCall(['night']); });
  const result = await h.planner(input('嗯', { isCurrent: () => current }));
  assert.equal(result.source, 'fallback');
  assert.equal(result.reason, 'membership-changed');
});

test('routing history is current-room public intersection only, attributed and bounded', () => {
  const turns = [
    { sessionId: 'other', role: 'user', visibility: 'visible', visibleText: 'other-room secret' },
    { sessionId: 'room', role: 'tool', visibility: 'visible', visibleText: 'tool secret' },
    { sessionId: 'room', role: 'assistant', visibility: 'internal', visibleText: 'internal secret' },
    { sessionId: 'room', role: 'user', visibility: 'visible', visibleText: 'revoked secret', revoked: true },
    { sessionId: 'room', role: 'user', visibility: 'visible', visibleText: 'private secret', private: true },
    { sessionId: 'room', role: 'user', visibility: 'visible', visibleText: '@楚航 你好' },
    { sessionId: 'room', role: 'assistant', visibility: 'visible', speakerVirtualPersonId: 'night', visibleText: '我在' },
  ];
  const store = { listTurns: () => turns, canReadTurn: (id, t) => !t.revoked && !(t.private && id === 'night') };
  const result = routingHistory(store, room, persons);
  assert.deepEqual(result, [{ role: 'user', text: '@楚航 你好' }, { role: 'assistant', personId: 'night', text: '我在' }]);
  store.listTurns = () => Array.from({ length: 60 }, (_, index) => ({ sessionId: 'room', role: 'user', visibility: 'visible', visibleText: `${index}:` + '长'.repeat(2000) }));
  const bounded = routingHistory(store, room, persons);
  assert.ok(bounded.length <= 24);
  assert.ok(bounded.reduce((n, t) => n + t.text.length, 0) <= 12000);
  assert.ok(bounded.every(t => t.text.length <= 1200));
  assert.match(bounded.at(-1).text, /^59:/);
});
