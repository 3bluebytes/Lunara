// presence_utterance 受限任务：真实 AgentLoop + 真实工具注册表 + 脚本化模型。
// Run: node --test server/presence/PresenceUtterance.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentLoop } from '../virtual-person/AgentLoop.js';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { buildPresenceTask } from './presenceLine.js';
import { createPresenceUtterance } from './PresenceUtterance.js';
import { registerPresenceTools } from './presenceTools.js';

const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const task = buildPresenceTask({ kind: 'track_completed', sessionId: 'room', personId: 'lunara', triggerKey: 'room/lunara/track_completed/q1',
  evidence: { track: { provider: 'qq', songId: 's1', title: '晴天', artist: '周杰伦', queueItemId: 'q1' } } }, { dayPart: '晚上' });

function harness(responses, { timeoutMs } = {}) {
  const requests = [];
  let index = 0;
  const chat = async (messages, tools, options) => {
    const request = { messages, tools, signal: options?.signal };
    requests.push(request);
    const next = responses[index++];
    if (typeof next === 'function') return next(request);
    if (!next) throw new Error('unexpected extra model round');
    return { message: { role: 'assistant', content: next.content || '', ...(next.calls ? { tool_calls: next.calls } : {}) } };
  };
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const agentLoop = new AgentLoop({ chat, toolRegistry });
  const runs = [];
  const loop = { run: input => { runs.push(input); return agentLoop.run(input); } };
  return { requests, runs, toolRegistry,
    utterance: createPresenceUtterance({ agentLoop: loop, toolRegistry, ...(timeoutMs ? { timeoutMs } : {}) }) };
}

test('首轮直接提交被接受：只拿到两件 presence 工具、素材内联、无消息历史', async () => {
  const h = harness([{ calls: [call('c1', 'submit_presence_utterance', { action: 'speak', text: '这首听完，房间好像安静了一点。', evidenceRefs: ['moment'] })] }]);
  const result = await h.utterance.generate(task, { persona: { displayName: '月', personaDocument: '温柔' } });
  assert.deepEqual(result, { action: 'speak', text: '这首听完，房间好像安静了一点。', evidenceRefs: ['moment'] });
  const [run] = h.runs;
  assert.deepEqual(run.messages, []);
  assert.equal(run.modelProfileId, 'presence');
  assert.equal(run.profileOverrides.allowEmptyTerminalPresentation, true);
  const tools = h.requests[0].tools.map(tool => tool.function.name).sort();
  assert.deepEqual(tools, ['get_presence_brief', 'submit_presence_utterance']);
  assert.match(run.systemPrompt, /你是 月/);
  assert.match(run.systemPrompt, /"ref":"track"/);
  assert.equal(h.requests.length, 1, '素材内联：一轮即结束');
});

test('silence 是正常终止，不触发 EMPTY_TOOL_PRESENTATION', async () => {
  const h = harness([{ calls: [call('c1', 'submit_presence_utterance', { action: 'silence' })] }]);
  assert.deepEqual(await h.utterance.generate(task), { action: 'silence', reason: 'model-silence' });
});

test('被拒后可纠正重试；两轮都不过 → 沉默且带规则 id，不写兜底句', async () => {
  const retry = harness([
    { calls: [call('c1', 'submit_presence_utterance', { action: 'speak', text: '听完了。真好。', evidenceRefs: ['moment'] })] },
    { calls: [call('c2', 'submit_presence_utterance', { action: 'speak', text: '听完了，真好。', evidenceRefs: ['moment'] })] },
  ]);
  assert.equal((await retry.utterance.generate(task)).text, '听完了，真好。');
  const rejected = harness([
    { calls: [call('c1', 'submit_presence_utterance', { action: 'speak', text: '《七里香》也好听', evidenceRefs: ['track'] })] },
    { calls: [call('c2', 'submit_presence_utterance', { action: 'speak', text: '已经给你切歌了', evidenceRefs: [] })] },
  ]);
  const result = await rejected.utterance.generate(task);
  assert.equal(result.action, 'silence');
  assert.equal(result.reason, 'rejected');
  assert.equal(result.rejectedRule, 'missing_evidence');
});

test('模型报错 / 超时 / 只说话不调工具 / 外部取消 → 沉默', async () => {
  const error = harness([() => { throw new Error('boom'); }]);
  assert.equal((await error.utterance.generate(task)).action, 'silence');
  const slow = harness([request => new Promise((resolve, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  })], { timeoutMs: 30 });
  assert.deepEqual(await slow.utterance.generate(task), { action: 'silence', reason: 'timeout' });
  const chatty = harness([{ content: '今晚真好' }]);
  assert.equal((await chatty.utterance.generate(task)).action, 'silence');
  const controller = new AbortController();
  const aborted = harness([request => new Promise((resolve, reject) => {
    controller.abort(new Error('user spoke'));
    request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    if (request.signal?.aborted) reject(request.signal.reason);
  })]);
  assert.deepEqual(await aborted.utterance.generate(task, { signal: controller.signal }), { action: 'silence', reason: 'aborted' });
});

test('失效守卫：isCurrent 为假时提交被拒为 STALE；工具幂等注册', async () => {
  const h = harness([{ calls: [call('c1', 'submit_presence_utterance', { action: 'speak', text: '嗯。', evidenceRefs: ['moment'] })] }]);
  const result = await h.utterance.generate(task, { isCurrent: () => false });
  assert.equal(result.action, 'silence');
  registerPresenceTools(h.toolRegistry);
  assert.equal(h.toolRegistry.definitions({ capabilities: ['presence'] }).length, 2);
});
