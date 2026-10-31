// 串词的 predecessor 隐私守卫：撤歌后的空位不是“上一首歌”，
// 不得进入 getContext、系统提示、锁定任务、brief 素材或兜底 TTS。
//
// Run: node --test server/program/ProgramNarrationComposer.predecessor.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { createNarrationAgent } from './NarrationAgent.js';
import { buildFallbackTrackNarration } from './ProgramNarrationComposer.js';

const track = { title: 'New Song', artist: 'Artist', songId: 'new', queueItemId: 'q-new',
  narration: { status: 'preparing', context: { origin: 'live', reason: 'user_request' } } };

test('a withdrawn-song predecessor cannot reach narration context, task, prompt or fallback TTS', async () => {
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const runs = [], briefs = [], seen = [], spoken = [];
  const agentLoop = { run: async input => {
    runs.push(input);
    await input.onMessage?.({ kind: 'assistant_tool_calls', round: 1, message: { role: 'assistant', content: '',
      tool_calls: [{ id: 'b1', type: 'function', function: { name: 'get_track_narration_brief', arguments: '{}' } }] } });
    const outcome = await toolRegistry.execute('get_track_narration_brief', {}, {
      capabilities: input.capabilities, correlationId: input.correlationId, round: 1, toolCallCount: 1,
      finishReason: 'tool_calls', ...input.toolContext, signal: input.signal });
    await input.onMessage?.({ kind: 'tool_result', round: 1,
      message: { role: 'tool', tool_call_id: 'b1', content: '{}' }, outcome });
    briefs.push(outcome.facts);
    throw Object.assign(new Error('virtual person turn reached round limit'), { code: 'AGENT_ROUND_LIMIT' });
  } };
  const agent = createNarrationAgent({ agentLoop, toolRegistry,
    getContext: effect => { seen.push(effect); return {}; },
    synthesize: async text => { spoken.push(text); return { url: '/safe.mp3' }; } });

  for (const previousTrack of [{ songId: null, title: 'PRIVATE_TITLE' }]) {
    assert.doesNotMatch(buildFallbackTrackNarration(track, { previousTrack }), /PRIVATE_/);
    const result = await agent.prepareTrack({ track, previousTrack, listeningSessionId: 'room', queueItemId: 'q-new' });
    assert.doesNotMatch(result.text, /PRIVATE_/);
  }
  assert.equal(runs.length, 1);
  assert.deepEqual(runs.map(run => run.toolContext.narrationTaskRequest.previousTrack), [null]);
  assert.ok(briefs.every(item => item.previousTrack === null));
  const modelVisible = JSON.stringify([seen, runs.map(run => run.systemPrompt),
    runs.map(run => run.toolContext.narrationTaskRequest), briefs, spoken]);
  assert.doesNotMatch(modelVisible, /PRIVATE_/);
});
