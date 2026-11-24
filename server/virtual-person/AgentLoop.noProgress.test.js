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

test('MUSIC_CANDIDATES_OFFERED 不进跨轮 executionCache，同参再次 select_music 照常执行', async () => {
  let round = 0;
  let selections = 0;
  const loop = new AgentLoop({
    maxRounds: 4,
    chat: async () => {
      round += 1;
      if (round <= 2) {
        return { message: { role: 'assistant', content: '', tool_calls: [
          { id: `sel-${round}`, type: 'function', function: { name: 'select_music', arguments: '{"mode":"discovery"}' } },
        ] } };
      }
      return { message: { role: 'assistant', content: '选好了。' } };
    },
    toolRegistry: {
      definitions: () => [{ type: 'function', function: { name: 'select_music', parameters: { type: 'object' } } }],
      isReadOnly: () => false,
      execute: async () => {
        selections += 1;
        return createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'MUSIC_CANDIDATES_OFFERED',
          facts: { offerId: `offer-${selections}` }, presentation: { displayText: '候选', speak: false } });
      },
    },
  });
  const result = await loop.run({ systemPrompt: '选歌', messages: [{ role: 'user', content: '换批候选' }] });
  assert.equal(selections, 2, '第二轮同参 select_music 不应命中第一轮 offer 缓存');
  assert.equal(result.finalText, '选好了。');
});

test('跨轮重复完全相同的 INVALID_TOOL_ARGUMENTS 早停，改参数时保留重试机会', async () => {
  let calls = 0;
  const sameInvalidLoop = new AgentLoop({
    maxRounds: 5,
    chat: async () => {
      calls += 1;
      return { message: { role: 'assistant', content: '', tool_calls: [
        { id: `bad-${calls}`, type: 'function', function: { name: 'remember_person_fact', arguments: '{"bad":1}' } },
      ] } };
    },
    toolRegistry: {
      definitions: () => [{ type: 'function', function: { name: 'remember_person_fact', parameters: { type: 'object' } } }],
      execute: async () => createToolOutcome({
        kind: ToolOutcomeKind.BUSINESS_FAILURE,
        code: 'INVALID_TOOL_ARGUMENTS',
        modelContext: '缺少必需字段',
        presentation: { displayText: '这次操作的条件不完整，可以调整后再试。', speak: false },
      }),
    },
  });
  const stopped = await sameInvalidLoop.run({ systemPrompt: 's', messages: [{ role: 'user', content: '记住' }] });
  assert.equal(calls, 2, '第 1 轮给一次修正机会，第 2 轮重复相同非法参数即早停');
  assert.equal(stopped.rounds, 2);
  assert.equal(stopped.finalText, '这次操作的条件不完整，可以调整后再试。');

  // 参数变化时不误伤早停，仍能纠正成功。
  let changedCalls = 0;
  const changedLoop = new AgentLoop({
    maxRounds: 4,
    chat: async () => {
      changedCalls += 1;
      if (changedCalls === 1) {
        return { message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'remember_person_fact', arguments: '{"bad":1}' } },
        ] } };
      }
      if (changedCalls === 2) {
        return { message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c2', type: 'function', function: { name: 'remember_person_fact', arguments: '{"bad":2}' } },
        ] } };
      }
      return { message: { role: 'assistant', content: '已经记住了。' } };
    },
    toolRegistry: {
      definitions: () => [{ type: 'function', function: { name: 'remember_person_fact', parameters: { type: 'object' } } }],
      execute: async (_name, args) => args.bad === 2
        ? createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'PERSON_FACT_REMEMBERED' })
        : createToolOutcome({ kind: ToolOutcomeKind.BUSINESS_FAILURE, code: 'INVALID_TOOL_ARGUMENTS',
          presentation: { displayText: '条件不完整。', speak: false } }),
    },
  });
  const recovered = await changedLoop.run({ systemPrompt: 's', messages: [{ role: 'user', content: '记住' }] });
  assert.equal(changedCalls, 3);
  assert.equal(recovered.finalText, '已经记住了。');
});

test('preBudgeted 跳过第 1 轮重复 ContextBudgeter.prepare，第 2 轮与超长恢复仍照常调用', async () => {
  const prepareCalls = [];
  const budgeter = {
    async prepare(messages, options = {}) {
      prepareCalls.push({ count: messages.length, aggressive: Boolean(options.aggressive) });
      return messages;
    },
  };
  let round = 0;
  const loop = new AgentLoop({
    contextBudgeter: budgeter,
    chat: async () => {
      round += 1;
      if (round === 1) {
        return { message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
        ] } };
      }
      return { message: { role: 'assistant', content: '完成。' } };
    },
    toolRegistry: {
      definitions: () => [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      execute: async () => createToolOutcome({ kind: ToolOutcomeKind.SUCCESS, code: 'OK' }),
    },
  });
  const res = await loop.run({
    systemPrompt: 's',
    messages: [{ role: 'user', content: '查一下' }],
    preBudgeted: true,
  });
  assert.equal(res.finalText, '完成。');
  assert.deepEqual(prepareCalls, [{ count: 3, aggressive: false }], '第 1 轮跳过，第 2 轮调用一次');

  // 首轮触发 prompt_too_long 时仍调用 aggressive prepare。
  prepareCalls.length = 0;
  let recoveryAttempt = 0;
  const recoveryLoop = new AgentLoop({
    contextBudgeter: budgeter,
    chat: async () => {
      recoveryAttempt += 1;
      if (recoveryAttempt === 1) throw Object.assign(new Error('prompt too long'), { status: 413 });
      return { message: { role: 'assistant', content: '恢复成功。' } };
    },
    toolRegistry: { definitions: () => [], execute: async () => {} },
  });
  const rec = await recoveryLoop.run({
    systemPrompt: 's',
    messages: [{ role: 'user', content: '长历史' }],
    preBudgeted: true,
  });
  assert.equal(rec.finalText, '恢复成功。');
  assert.deepEqual(prepareCalls, [{ count: 1, aggressive: true }]);
});
