import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVirtualPersonRuntimeComposition } from './createVirtualPersonRuntimeComposition.js';
import { ROUTING_TOOL } from './responseRouting.js';

const response = (ids, name = ROUTING_TOOL) => ({ message: { role: 'assistant', content: '', tool_calls: [
  { id: 'plan', type: 'function', function: { name, arguments: JSON.stringify({ personIds: ids }) } },
] } });
function harness(route) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-routing-int-'));
  const calls = [];
  const writes = [];
  const composition = createVirtualPersonRuntimeComposition({
    dbPath: join(dir, 'state.db'),
    chat: async (messages, tools, profile) => {
      calls.push({ messages, tools, taskId: profile.taskId });
      if (profile.taskId === 'response_routing') {
        const data = JSON.parse(messages[0].content.split('路由输入（JSON）：\n')[1]);
        return route(data, composition, profile);
      }
      assert.ok(!(tools || []).some(t => t.function.name === ROUTING_TOOL), '普通角色不能操作回应名单');
      const speaker = /你的虚拟人 ID 是 ([\w-]+)。/u.exec(messages[0].content)?.[1];
      return { message: { role: 'assistant', content: `${speaker} 在。` } };
    },
    synthesize: async () => { throw new Error('no paid synthesis in tests'); },
    publish: () => {}, queueService: { snapshot: () => ({}), publishSnapshot: () => writes.push('queue') },
    playbackRuntime: { snapshot: () => ({ version: 1 }) }, logger: { error() {}, warn() {} },
  });
  composition.runtime.initialize();
  composition.registry.createRadiohost({ id: 'night', displayName: '楚航', voiceProfileId: 'voice-test' });
  composition.conversationStore.createRoom({ sessionId: 'room', memberIds: ['lunara', 'night'], hostId: 'lunara' });
  return { ...composition, calls, writes, close() { composition.runtime.shutdown(); rmSync(dir, { recursive: true, force: true }); } };
}
const turn = (h, requestId, userText) => h.runtime.handleTurn({ sessionId: 'room', requestId, userText, speak: false });

test('production composition applies both greeting and contextual follow-up plans without changing host or music', async () => {
  const h = harness(data => {
    if (data.userText === '两位早上好') return response(['lunara', 'night']);
    assert.equal(data.userText, '没啥只想你回我一下');
    assert.ok(data.history.some(t => t.role === 'user' && t.text === '@楚航 你怎么不回我？'));
    assert.ok(data.history.some(t => t.personId === 'night' && t.text === 'night 在。'));
    return response(['night']);
  });
  try {
    const greeting = await turn(h, 'r1', '两位早上好');
    assert.deepEqual(greeting.responses.map(r => r.virtualPersonId), ['night', 'lunara']);
    const mention = await turn(h, 'r2', '@楚航 你怎么不回我？');
    assert.equal(mention.virtualPersonId, 'night');
    const continuation = await turn(h, 'r3', '没啥只想你回我一下');
    assert.equal(continuation.virtualPersonId, 'night');
    assert.deepEqual(h.conversationStore.getRound('r3').responsePlan, ['night']);
    assert.equal(h.calls.filter(c => c.taskId === 'response_routing').length, 2, '@ 不多一次判断');
    const count = h.calls.length;
    assert.deepEqual(await turn(h, 'r3', '重复请求'), continuation);
    assert.equal(h.calls.length, count, '重放不重新路由或回答');
    assert.equal(h.conversationStore.getSession('room').activeVirtualPersonId, 'lunara');
    assert.deepEqual(h.writes, []);
    assert.equal(h.conversationStore.listTurns('room', { visibleOnly: true }).length, 7, '没有路由伪用户或调度台词入账');
  } finally { h.close(); }
});

test('a member removed while routing is not dispatched by the late model plan', async () => {
  const h = harness((_data, composition) => {
    composition.conversationStore.removeMember('room', 'night');
    return response(['night']);
  });
  try {
    const result = await turn(h, 'r1', '你怎么想？');
    assert.equal(result.virtualPersonId, 'lunara');
    assert.deepEqual(h.conversationStore.getRound('r1').responsePlan, ['lunara']);
    assert.equal(h.calls.filter(c => c.taskId !== 'response_routing').length, 1);
  } finally { h.close(); }
});

test('cancelling during semantic routing cannot start a late persona reply', async () => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  let finish;
  const h = harness(() => { started(); return new Promise(resolve => { finish = resolve; }); });
  try {
    const pending = turn(h, 'r1', '嗯，你说');
    await waiting;
    assert.equal(h.runtime.cancel('room', 'r1'), true);
    await assert.rejects(pending);
    finish(response(['night']));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 1, '取消后没有角色生成');
    assert.equal(h.conversationStore.getRound('r1'), null, '过期名单不落回合');
  } finally { h.close(); }
});
