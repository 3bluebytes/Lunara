import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentLoop } from '../virtual-person/AgentLoop.js';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { createNarrationAgent } from './NarrationAgent.js';

const text = '周杰伦的《晴天》让吉他的线条慢慢展开，人声沿着旋律停留，又把那些没有说完的话轻轻收起。让这一段熟悉的旋律自然走完，听它在最后一个音符里留下的回声。';
const effect = { listeningSessionId: 'isolated-room', queueItemId: 'q1', generationRevision: 1,
  track: { songId: 'song', title: '晴天', artist: '周杰伦', voiceProfileId: 'voice', narration: { context: {} } } };
const tool = (name, args, id) => ({ finishReason: 'tool_calls', message: { role: 'assistant', content: '',
  tool_calls: [{ id: String(id), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });

function fixture({ respond, ...options } = {}) {
  const calls = [];
  const spoken = [];
  const registry = new VirtualPersonToolRegistry();
  const loop = new AgentLoop({ toolRegistry: registry, timeoutMs: 120_000,
    chat: async (messages, definitions, opts) => {
      calls.push({ messages, opts });
      return respond(calls.length, opts);
    } });
  const agent = createNarrationAgent({ agentLoop: loop, toolRegistry: registry,
    getContext: () => ({ person: { displayName: 'Lunara', voiceProfileId: 'voice' },
      companionMode: { modeId: 'occasional' } }),
    synthesize: async (value, opts) => { spoken.push({ text: value, signal: opts.signal }); return { url: '/local.mp3' }; },
    ...options });
  return { agent, calls, spoken };
}

test('default narration accepts a two-round submission beyond the old 6.5 second cutoff', async () => {
  const h = fixture({ respond: async round => {
    if (round === 1) return tool('get_track_narration_brief', {}, round);
    await delay(6_600);
    return tool('submit_track_narration', { text }, round);
  } });
  const result = await h.agent.prepareTrack(effect);
  assert.equal(result.narrationSource, 'agent');
  assert.equal(result.text, text);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[0].opts.timeoutMs <= 60_000, 'HTTP timeout must respect the shared task deadline');
  assert.ok(h.calls[1].opts.timeoutMs <= h.calls[0].opts.timeoutMs);
});

test('real AgentLoop allows brief, rejected submission, then one correction and stops', async () => {
  const h = fixture({ respond: async round => round === 1
    ? tool('get_track_narration_brief', {}, round)
    : tool('submit_track_narration', { text: round === 2 ? '晴天。' : text }, round) });
  const result = await h.agent.prepareTrack(effect);
  assert.equal(result.narrationSource, 'agent');
  assert.equal(h.calls.length, 3);
  assert.equal(h.spoken.length, 1);
  assert.ok(h.calls[2].messages.some(m => m.role === 'tool' && m.content.includes('NARRATION_REJECTED')));
});

test('a delivery deadline clips generation and leaves the reserved synthesis time', async () => {
  let aborted = false;
  const h = fixture({ generationBudgetMs: 1_000, timeoutMs: 1_100, synthesisBudgetMs: 40,
    respond: async (round, opts) => {
      opts.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    } });
  const result = await h.agent.prepareTrack(effect, { deadlineMs: Date.now() + 120 });
  assert.equal(result.narrationFinishReason, 'NARRATION_GENERATION_TIMEOUT');
  assert.equal(result.narrationSource, 'fallback');
  assert.ok(h.calls[0].opts.timeoutMs <= 80);
  assert.equal(aborted, true);
  assert.equal(h.spoken.length, 1);
  assert.notEqual(h.spoken[0].signal?.aborted, true, 'generation cancellation must not cancel fallback synthesis');
});

test('external cancellation during model work propagates and never synthesizes a stale fallback', async () => {
  const controller = new AbortController();
  const h = fixture({ respond: async () => {
    controller.abort(new DOMException('cancelled', 'AbortError'));
    return new Promise(() => {});
  } });
  await assert.rejects(h.agent.prepareTrack(effect, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.spoken.length, 0);
});
