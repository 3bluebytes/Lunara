import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentLoop } from './AgentLoop.js';
import { createToolOutcome, ToolOutcomeKind } from './VirtualPersonTypes.js';

test('repeated no-match selection ends with reviewed text before the full round budget', async () => {
  let modelCalls = 0;
  let selections = 0;
  const loop = new AgentLoop({ maxRounds: 6,
    chat: async () => ({ message: { role: 'assistant', content: '', tool_calls: [{
      id: `call-${++modelCalls}`, type: 'function', function: { name: 'select_music', arguments: '{"mode":"discovery"}' },
    }] } }),
    toolRegistry: {
      definitions: () => [{ type: 'function', function: { name: 'select_music', parameters: { type: 'object' } } }],
      execute: async () => { selections++; return createToolOutcome({ kind: ToolOutcomeKind.BUSINESS_FAILURE,
        code: 'NO_MATCHING_CANDIDATES', modelContext: '候选池为空',
        presentation: { displayText: '这次没有找到符合条件的歌，队列没有变化。', speak: false } }); },
    },
  });
  const result = await loop.run({ systemPrompt: '选歌', messages: [{ role: 'user', content: '推荐一首' }] });
  assert.equal(result.rounds, 2);
  assert.equal(modelCalls, 2);
  assert.equal(selections, 2); // a failed call is re-executed in a later round, never served from a stale cache
  assert.match(result.finalText, /队列没有变化/u);
});

test('a newly found online candidate cancels the no-progress stop in the same tool batch', async () => {
  let round = 0;
  const tool = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });
  const loop = new AgentLoop({ maxRounds: 3,
    chat: async () => ++round === 1
      ? { message: { role: 'assistant', content: '', tool_calls: [
        tool('a', 'select_music'), tool('b', 'select_music'), tool('c', 'search_music'),
      ] } }
      : { message: { role: 'assistant', content: '找到了新的候选，可以继续选择。' } },
    toolRegistry: {
      definitions: () => [],
      execute: async name => name === 'search_music'
        ? createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'MUSIC_RESULT', facts: { tracks: [{ songId: 'new' }] } })
        : createToolOutcome({ kind: ToolOutcomeKind.BUSINESS_FAILURE, code: 'NO_MATCHING_CANDIDATES',
          presentation: { displayText: '没找到歌。' } }),
    },
  });
  const result = await loop.run({ systemPrompt: '选歌', messages: [{ role: 'user', content: '推荐一首' }] });
  assert.equal(result.rounds, 2);
  assert.equal(result.finalText, '找到了新的候选，可以继续选择。');
});

test('a music action without fresh user intent stops after one reviewed correction', async () => {
  let calls = 0;
  const loop = new AgentLoop({ maxRounds: 6,
    chat: async () => { calls++; return { message: { role: 'assistant', content: '', tool_calls: [
      { id: `c${calls}`, type: 'function', function: { name: 'select_music', arguments: '{}' } },
    ] } }; },
    toolRegistry: { definitions: () => [], execute: async () => createToolOutcome({
      kind: ToolOutcomeKind.BUSINESS_FAILURE, code: 'NO_FRESH_MUSIC_REQUEST',
      presentation: { displayText: '请明确说要不要再换一首。', speak: false },
    }) },
  });
  const result = await loop.run({ messages: [{ role: 'user', content: '？' }] });
  assert.equal(calls, 1);
  assert.equal(result.finalText, '请明确说要不要再换一首。');
});

test('a later read-only search cannot turn a punctuation follow-up into a retry', async () => {
  let rounds = 0;
  const loop = new AgentLoop({ maxRounds: 4,
    chat: async () => { rounds++; return { message: { role: 'assistant', content: '', tool_calls: [
      { id: `select-${rounds}`, type: 'function', function: { name: 'select_music', arguments: '{}' } },
      { id: `search-${rounds}`, type: 'function', function: { name: 'search_music', arguments: '{}' } },
    ] } }; },
    toolRegistry: { definitions: () => [], execute: async name => name === 'search_music'
      ? createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'MUSIC_RESULT', facts: { tracks: [{ songId: 'candidate' }] } })
      : createToolOutcome({ kind: ToolOutcomeKind.BUSINESS_FAILURE, code: 'NO_FRESH_MUSIC_REQUEST',
        presentation: { displayText: '请明确说要不要再换一首。', speak: false } }) },
  });
  const result = await loop.run({ messages: [{ role: 'user', content: '？' }] });
  assert.equal(rounds, 1);
  assert.equal(result.finalText, '请明确说要不要再换一首。');
});
