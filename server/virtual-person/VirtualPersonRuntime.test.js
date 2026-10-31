import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentLoop } from './AgentLoop.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import { ConversationStore } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime, keepCompleteToolProtocol } from './VirtualPersonRuntime.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { registerMusicTools } from './musicTools.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';
import { getFamiliarArtistCadence } from '../program/familiarArtistCadence.js';

function createHarness(chat, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-vp-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath });
  // 台本 turn 的读取门（fix-release-blocking-defects）：撤回依赖后台本正文不得进模型上下文。
  const conversationStore = new ConversationStore({ dbPath });
  const tools = new VirtualPersonToolRegistry({ logger: options.logger || { error() {} } });
  options.registerTools?.(tools, { conversationStore });
  const budgeter = options.contextBudgeter || new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => new Date('2026-09-03T00:00:00.000Z') }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools, contextBudgeter: budgeter, ...options.agentLoop }),
    presentationService: new PresentationService(),
    capabilityResolver: options.capabilityResolver || (() => []),
    retrieveMemories: options.retrieveMemories || (async () => []),
    getEnvironment: options.getEnvironment || null,
    getRuntimeState: options.getRuntimeState || (() => null),
    onTurnCommitted: options.onTurnCommitted,
    basicPlaybackFallback: options.basicPlaybackFallback,
    logger: options.logger || { error() {}, warn() {} },
  }).initialize();
  return {
    runtime, registry, conversationStore, tools,
    close() {
      conversationStore.close();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a second HTTP-style request receives the prior user and assistant turns', async () => {
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    const current = messages.at(-1).content;
    return { message: { role: 'assistant', content: current === '我今天有点累' ? '听起来这一天消耗了你不少。' : '记得，你刚才说今天有点累。' } };
  });
  try {
    await harness.runtime.handleTurn({ sessionId: 'session-1', requestId: 'request-1', userText: '我今天有点累', speak: false });
    await harness.runtime.handleTurn({ sessionId: 'session-1', requestId: 'request-2', userText: '你还记得我刚才说的吗？', speak: false });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].slice(1).map(message => [message.role, message.content]), [
      ['user', '我今天有点累'],
      ['assistant', '听起来这一天消耗了你不少。'],
      ['user', '你还记得我刚才说的吗？'],
    ]);
    const second = harness.conversationStore.getRequest('request-2');
    assert.equal(second.result.displayText, '记得，你刚才说今天有点累。');
  } finally {
    harness.close();
  }
});

test('familiar-artist feedback reaches the model and is saved by a source-backed typed tool', async () => {
  let modelCalls = 0;
  const quote = '最近总放我不熟悉的歌手，会有点不安；可以偶尔穿插新面孔，但请把频率降一点。';
  const harness = createHarness(async () => {
    modelCalls++;
    return { message: { role: 'assistant', content: '', tool_calls: [{
      id: 'cadence', type: 'function', function: { name: 'set_familiar_artist_cadence',
        arguments: JSON.stringify({ mode: 'familiar_first', sourceQuote: quote }) },
    }] } };
  }, {
    capabilityResolver: () => [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
    registerTools(tools, { conversationStore }) {
      registerMusicTools(tools, () => ({ conversationStore, pool: { invalidate() {} } }));
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'cadence', requestId: 'cadence-1', userText: quote, speak: false });
    assert.equal(response.ok, true);
    assert.match(response.displayText, /熟悉的歌手为主.*偶尔穿插陌生歌手/u);
    assert.equal(modelCalls, 1);
    assert.equal(getFamiliarArtistCadence(harness.conversationStore.db, 'lunara').sourceQuote, quote);
    assert.deepEqual(response.outcomeCodes, ['FAMILIAR_ARTIST_CADENCE_SAVED']);
    const replay = await harness.runtime.handleTurn({ sessionId: 'cadence', requestId: 'cadence-1', userText: quote, speak: false });
    assert.equal(replay.displayText, response.displayText);
    assert.equal(modelCalls, 1);
  } finally { harness.close(); }
});

test('cadence feedback runs before selection even when the model lists the tool calls in reverse order', async () => {
  const observed = [];
  const quote = '熟悉歌手多放一点，偶尔穿插陌生歌手，现在换一首。';
  const harness = createHarness(async () => ({ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'select', type: 'function', function: { name: 'select_music',
      arguments: '{"mode":"discovery","delivery":"replace_now"}' } },
    { id: 'cadence', type: 'function', function: { name: 'set_familiar_artist_cadence',
      arguments: JSON.stringify({ mode: 'familiar_first', sourceQuote: quote }) } },
  ] } }), {
    capabilityResolver: () => [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
    registerTools(tools, { conversationStore }) {
      registerMusicTools(tools, () => ({ conversationStore, pool: { invalidate() {} },
        execute: async () => {
          observed.push(getFamiliarArtistCadence(conversationStore.db, 'lunara')?.mode || null);
          return { ok: true, code: 'MUSIC_COMMITTED', terminal: true, userMessage: '已安排下一首。' };
        } }));
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'compound', requestId: 'compound-1', userText: quote, speak: false });
    assert.equal(response.ok, true);
    assert.deepEqual(observed, ['familiar_first']);
    assert.equal(response.displayText, '已安排下一首。');
    assert.deepEqual(response.outcomeCodes, ['FAMILIAR_ARTIST_CADENCE_SAVED', 'MUSIC_COMMITTED']);
  } finally { harness.close(); }
});

test('invalid cadence evidence blocks a compound selection instead of playing without the correction', async () => {
  let selections = 0;
  const harness = createHarness(async () => ({ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'select', type: 'function', function: { name: 'select_music',
      arguments: '{"mode":"discovery","delivery":"replace_now"}' } },
    { id: 'cadence', type: 'function', function: { name: 'set_familiar_artist_cadence',
      arguments: '{"mode":"familiar_first","sourceQuote":"我讨厌所有陌生歌手"}' } },
  ] } }), {
    capabilityResolver: () => [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
    registerTools(tools, { conversationStore }) {
      registerMusicTools(tools, () => ({ conversationStore, execute: async () => { selections++; return { ok: true }; } }));
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'invalid-compound', requestId: 'invalid-compound-1',
      userText: '少放陌生歌手，换一首。', speak: false });
    assert.equal(response.ok, true);
    assert.equal(response.displayText, '这条偏好还没保存成功，所以我没有按它换歌。');
    assert.equal(selections, 0);
    assert.equal(getFamiliarArtistCadence(harness.conversationStore.db, 'lunara'), null);
  } finally { harness.close(); }
});

test('a failed agent does not silently save natural-language cadence feedback', async () => {
  let modelCalls = 0;
  const harness = createHarness(async () => { modelCalls++; return { message: { role: 'assistant', content: '' } }; });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'cadence-failed', requestId: 'cadence-failed-1',
      userText: '我不太喜欢一直放陌生歌手，偶尔穿插就好。', speak: false });
    assert.equal(response.ok, false);
    assert.equal(modelCalls, 2, 'bounded empty-response retry stays inside AgentLoop');
    assert.equal(getFamiliarArtistCadence(harness.conversationStore.db, 'lunara'), null);
  } finally { harness.close(); }
});

test('a successful AgentLoop response never calls the playback failure fallback', async () => {
  let fallbackCalls = 0;
  const harness = createHarness(async () => ({ message: { role: 'assistant', content: '好，继续听。' } }), {
    basicPlaybackFallback: async () => { fallbackCalls++; return null; },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'no-fallback', requestId: 'no-fallback-1',
      userText: '继续播放', speak: false });
    assert.equal(response.ok, true);
    assert.equal(fallbackCalls, 0);
  } finally { harness.close(); }
});

test('a successful post-agent-failure fallback commits the normal visible turn', async () => {
  let fallbackCalls = 0;
  const harness = createHarness(async () => ({ message: { role: 'assistant', content: '' } }), {
    basicPlaybackFallback: async () => {
      fallbackCalls++;
      return { finalText: '好，继续播放。', rounds: 0,
        outcomes: [{ code: 'LISTENING_CONTROLLED' }] };
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'fallback', requestId: 'fallback-1',
      userText: '继续播放', speak: false });
    assert.equal(response.ok, true);
    assert.equal(response.displayText, '好，继续播放。');
    assert.equal(fallbackCalls, 1);
    assert.deepEqual(response.outcomeCodes, ['LISTENING_CONTROLLED']);
  } finally { harness.close(); }
});

test('same-session requests are FIFO while different sessions can run concurrently', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const started = [];
  const harness = createHarness(async messages => {
    const text = messages.at(-1).content;
    started.push(text);
    if (text === 'first') await firstGate;
    return { message: { role: 'assistant', content: `reply:${text}` } };
  });
  try {
    const first = harness.runtime.handleTurn({ sessionId: 'same', requestId: 'r1', userText: 'first', speak: false });
    const second = harness.runtime.handleTurn({ sessionId: 'same', requestId: 'r2', userText: 'second', speak: false });
    const other = harness.runtime.handleTurn({ sessionId: 'other', requestId: 'r3', userText: 'other', speak: false });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'other']);
    releaseFirst();
    await Promise.all([first, second, other]);
    assert.deepEqual(started, ['first', 'other', 'second']);
  } finally {
    harness.close();
  }
});

test('a running request id cannot be reused by another session', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = createHarness(async messages => {
    if (messages.at(-1).content === 'first') await gate;
    return { message: { role: 'assistant', content: 'done' } };
  });
  try {
    const first = harness.runtime.handleTurn({ sessionId: 'session-a', requestId: 'same-running', userText: 'first', speak: false });
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(
      () => harness.runtime.handleTurn({ sessionId: 'session-b', requestId: 'same-running', userText: 'second', speak: false }),
      /different session/,
    );
    release();
    await first;
    assert.equal(harness.conversationStore.getRequest('same-running').sessionId, 'session-a');
  } finally {
    release?.();
    harness.close();
  }
});

test('tool calls return bounded typed context and raw exceptions never reach model or transcript', async () => {
  const seen = [];
  const logger = { error(_label, error) { assert.match(error.message, /SECRET_ENDPOINT/); }, warn() {} };
  const harness = createHarness(async (messages, tools) => {
    seen.push(structuredClone(messages));
    if (seen.length === 1) {
      assert.equal(tools[0].function.name, 'explode');
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call-explode', type: 'function', function: { name: 'explode', arguments: '{}' } }],
      } };
    }
    assert.doesNotMatch(messages.at(-1).content, /SECRET_ENDPOINT/);
    assert.match(messages.at(-1).content, /INTERNAL_TOOL_ERROR/);
    return { message: { role: 'assistant', content: '刚才没有操作成功，我们稍后再试。' } };
  }, {
    logger,
    capabilityResolver: () => ['danger-test'],
    registerTools(tools) {
      tools.register('explode', {
        capability: 'danger-test',
        definition: { description: 'test', parameters: { type: 'object', properties: {} } },
        handler() { throw new Error('SECRET_ENDPOINT=https://secret.invalid token=abc'); },
      });
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 's', requestId: 'r', userText: '执行', speak: false });
    assert.equal(response.ok, true);
    assert.equal(response.displayText, '刚才没有操作成功，我们稍后再试。');
    const serialized = JSON.stringify(harness.conversationStore.listTurns('s'));
    assert.doesNotMatch(serialized, /SECRET_ENDPOINT|token=abc/);
  } finally {
    harness.close();
  }
});

test('duplicate logical tool calls in one turn execute once but keep one result per provider call id', async () => {
  let executions = 0;
  const harness = createHarness(async messages => {
    if (!messages.some(message => message.role === 'tool')) {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'duplicate-a', type: 'function', function: { name: 'mutate', arguments: '{"value":"A"}' } },
          { id: 'duplicate-b', type: 'function', function: { name: 'mutate', arguments: '{"value":"A"}' } },
        ],
      } };
    }
    return { message: { role: 'assistant', content: '只执行了一次。' } };
  }, {
    capabilityResolver: () => ['mutate'],
    registerTools(tools) {
      tools.register('mutate', {
        capability: 'mutate',
        definition: { description: 'mutate', parameters: { type: 'object', properties: { value: { type: 'string' } } } },
        handler() {
          executions += 1;
          return { kind: 'success', code: 'DONE', facts: {}, modelContext: 'done', presentation: { speak: false } };
        },
      });
    },
  });
  try {
    await harness.runtime.handleTurn({ sessionId: 'dedupe', requestId: 'dedupe-r', userText: '执行', speak: false });
    assert.equal(executions, 1);
    const tools = harness.conversationStore.listTurns('dedupe').filter(turn => turn.role === 'tool');
    assert.deepEqual(tools.map(turn => turn.message.tool_call_id), ['duplicate-a', 'duplicate-b']);
  } finally {
    harness.close();
  }
});

test('a successful terminal playback control finishes the turn without another model round', async () => {
  let chatCalls = 0;
  const harness = createHarness(async () => {
    chatCalls += 1;
    if (chatCalls > 1) throw new Error('the model must not continue after committed playback control');
    return { message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'resume-once', type: 'function', function: { name: 'resume_playback', arguments: '{}' } }],
    } };
  }, {
    capabilityResolver: () => ['playback-control'],
    registerTools(tools) {
      tools.register('resume_playback', {
        capability: 'playback-control',
        definition: { description: 'resume', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        handler: () => ({
          kind: 'success', code: 'LISTENING_CONTROLLED', terminal: true, facts: {}, modelContext: '播放操作已经提交。',
          presentation: { displayText: '好，继续播放。', speak: false },
        }),
      });
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'resume', requestId: 'resume-r', userText: '回来了，继续播放歌曲', speak: false });
    assert.equal(response.ok, true);
    assert.equal(response.displayText, '好，继续播放。');
    assert.equal(chatCalls, 1);
    assert.deepEqual(response.outcomeCodes, ['LISTENING_CONTROLLED']);
  } finally {
    harness.close();
  }
});

test('a cancel that lands after an accepted music commit keeps the committed reply and stays silent', async () => {
  let harnessRef = null;
  const harness = createHarness(async () => ({ message: {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'commit-once', type: 'function', function: { name: 'commit_music', arguments: '{}' } }],
  } }), {
    capabilityResolver: () => ['music-commit'],
    registerTools(tools) {
      tools.register('commit_music', {
        capability: 'music-commit',
        definition: { description: 'commit', parameters: { type: 'object', properties: {}, additionalProperties: false } },
        handler: () => {
          // 提交已被播放器接受之后，用户才点了取消。
          harnessRef.runtime.cancel('late-cancel');
          return { kind: 'success', code: 'MUSIC_COMMITTED', terminal: true, facts: {}, modelContext: '已提交。',
            presentation: { displayText: '已经给你安排上《晴天》。', speak: true } };
        },
      });
    },
  });
  harnessRef = harness;
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'late-cancel', requestId: 'late-cancel-r', userText: '放晴天', speak: true });
    assert.equal(response.ok, true);
    assert.equal(response.displayText, '已经给你安排上《晴天》。');
    assert.deepEqual(response.outcomeCodes, ['MUSIC_COMMITTED']);
    assert.equal(response.presentation.speak, false);
  } finally {
    harness.close();
  }
});

test('an aborted round after a failed music action never dumps the tool status as the reply', async () => {
  const harness = createHarness(async messages => {
    if (!messages.some(message => message.role === 'tool')) {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'select-fail', type: 'function', function: { name: 'select_music', arguments: '{"mode":"discovery","delivery":"replace_now"}' } }],
      } };
    }
    return { message: { role: 'assistant', content: '' } };
  }, {
    capabilityResolver: () => [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
    registerTools(tools) {
      registerMusicTools(tools, () => ({
        execute: async () => ({ ok: false, code: 'MUSIC_NOT_COMMITTED',
          message: '提交被拒绝：播放状态已经变化，本轮没有提交任何歌曲。' }),
        playbackRuntime: { listeningSnapshot: () => ({ phase: 'idle', queue: [], currentIndex: -1 }) },
      }));
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'music-fallback', requestId: 'music-fallback-r',
      userText: '下面播放点人声吧', speak: false });
    assert.equal(response.ok, false);
    assert.doesNotMatch(response.displayText, /播放状态已经变化|提交被拒绝/u);
    assert.match(response.displayText, /队列/u);
    const serialized = JSON.stringify(harness.conversationStore.listTurns('music-fallback'));
    assert.doesNotMatch(serialized, /"content":"提交被拒绝/u);
  } finally {
    harness.close();
  }
});

test('a turn that times out while correcting a music action says it timed out, not that the songs failed', async () => {
  const harness = createHarness(async (messages, _tools, { signal } = {}) => {
    if (!messages.some(message => message.role === 'tool')) {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'commit-fail', type: 'function', function: { name: 'select_music', arguments: '{"mode":"discovery","delivery":"replace_now"}' } }],
      } };
    }
    // 模型还在改选时撞上回合截止。
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, {
    agentLoop: { timeoutMs: 150 },
    capabilityResolver: () => [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY],
    registerTools(tools) {
      registerMusicTools(tools, () => ({
        execute: async () => ({ ok: false, code: 'MUSIC_NOT_COMMITTED', message: '有两首解析失败，本批尚未提交。' }),
        playbackRuntime: { listeningSnapshot: () => ({ phase: 'idle', queue: [], currentIndex: -1 }) },
      }));
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'music-timeout', requestId: 'music-timeout-r',
      userText: '先放点歌吧', speak: false });
    assert.equal(response.ok, false);
    assert.equal(response.failureCode, 'AGENT_TIMEOUT');
    assert.match(response.displayText, /太久|超时/u);
    assert.match(response.displayText, /没有变化/u, '尝试过音乐动作时仍如实说明没改动');
    assert.doesNotMatch(response.displayText, /没能把歌排上去/u);
  } finally {
    harness.close();
  }
});

test('a model attempt timeout (LLM_TIMEOUT) shows the timeout copy, not the generic failure', async () => {
  const harness = createHarness(async () => {
    throw Object.assign(new Error('LLM request deadline exceeded'), { name: 'TimeoutError', code: 'LLM_TIMEOUT' });
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'llm-timeout', requestId: 'llm-timeout-r',
      userText: '聊聊天', speak: false });
    assert.equal(response.ok, false);
    assert.equal(response.failureCode, 'LLM_TIMEOUT');
    assert.match(response.displayText, /太久|超时/u);
    assert.doesNotMatch(response.displayText, /deadline|LLM_/u, '原始异常文本不外露');
  } finally {
    harness.close();
  }
});

test('a timeout without any music action does not mention the queue', async () => {
  const harness = createHarness(async (_messages, _tools, { signal } = {}) => {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, { agentLoop: { timeoutMs: 150 } });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'plain-timeout', requestId: 'plain-timeout-r',
      userText: '聊聊天', speak: false });
    assert.equal(response.failureCode, 'AGENT_TIMEOUT');
    assert.match(response.displayText, /太久|超时/u);
    assert.doesNotMatch(response.displayText, /队列|播放/u);
  } finally {
    harness.close();
  }
});

test('fabricated unavailable tools and untyped handler results never become successful outcomes', async () => {
  const harness = createHarness(async (messages) => {
    if (!messages.some(message => message.role === 'tool')) {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call-plain', type: 'function', function: { name: 'plain', arguments: '{}' } }],
      } };
    }
    assert.match(messages.at(-1).content, /TOOL_NOT_AUTHORIZED/);
    return { message: { role: 'assistant', content: '这项能力当前不能用。' } };
  }, {
    capabilityResolver: () => ['allowed-only'],
    registerTools(tools) {
      tools.register('plain', {
        capability: 'different-capability',
        definition: { description: 'test', parameters: { type: 'object', properties: {} } },
        handler: () => 'legacy success string',
      });
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 's', requestId: 'fabricated', userText: '执行', speak: false });
    assert.equal(response.displayText, '这项能力当前不能用。');
    assert.doesNotMatch(JSON.stringify(harness.conversationStore.listTurns('s')), /legacy success string/);
    const untyped = await harness.tools.execute('plain', {}, { correlationId: 'direct', capabilities: ['different-capability'] });
    assert.equal(untyped.kind, 'internal_failure');
    assert.equal(untyped.code, 'INTERNAL_TOOL_ERROR');
  } finally {
    harness.close();
  }
});

test('provider failure produces a safe non-spoken turn and supports idempotent replay', async () => {
  const harness = createHarness(async () => {
    throw new Error('PRIVATE_API_KEY=secret provider stack');
  });
  try {
    const first = await harness.runtime.handleTurn({ sessionId: 's', requestId: 'same', userText: '你好' });
    const replay = await harness.runtime.handleTurn({ sessionId: 's', requestId: 'same', userText: '不应新增' });
    assert.equal(first.ok, false);
    assert.equal(first.presentation.speak, false);
    assert.deepEqual(replay, first);
    assert.doesNotMatch(JSON.stringify(harness.conversationStore.listTurns('s')), /PRIVATE_API_KEY|provider stack/);
    assert.equal(harness.conversationStore.listTurns('s', { visibleOnly: true }).length, 2);
  } finally {
    harness.close();
  }
});

test('a model failure after a typed business failure uses the actionable non-spoken fallback', async () => {
  const harness = createHarness(async messages => {
    if (!messages.some(message => message.role === 'tool')) {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'business-failure', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      } };
    }
    throw new Error('provider unavailable after tool');
  }, {
    capabilityResolver: () => ['lookup'],
    registerTools(tools) {
      tools.register('lookup', {
        capability: 'lookup',
        definition: { description: 'lookup', parameters: { type: 'object', properties: {} } },
        handler: () => ({
          kind: 'business_failure', code: 'NOT_FOUND', facts: {}, modelContext: '没有找到匹配项。',
          presentation: { displayText: '没有找到匹配内容，换一个条件再试试。', speak: false, retryable: true },
        }),
      });
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'fallback', requestId: 'fallback-r', userText: '查找' });
    assert.equal(response.ok, false);
    assert.equal(response.failureCode, 'TURN_INTERNAL_ERROR');
    assert.equal(response.displayText, '没有找到匹配内容，换一个条件再试试。');
    assert.equal(response.presentation.speak, false);
  } finally {
    harness.close();
  }
});

test('a failed model round records a safe cause without exposing upstream details', async () => {
  const messages = [];
  const harness = createHarness(async () => {
    const error = new Error('provider body with private details');
    error.code = 'LLM_API_ERROR';
    throw error;
  }, { logger: { error: line => messages.push(line), warn() {} } });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'model-failure',
      requestId: 'model-failure-r', userText: '换一首', speak: false });
    assert.equal(response.ok, false);
    assert.equal(response.failureCode, 'LLM_API_ERROR');
    assert.equal(harness.conversationStore.getRequest('model-failure-r').result.failureCode, 'LLM_API_ERROR');
    assert.doesNotMatch(JSON.stringify([response, messages]), /provider body with private details/u);
  } finally { harness.close(); }
});

test('final model authentication failures explain recovery without exposing or speaking diagnostics', async () => {
  for (const status of [401, 403]) {
    const logs = [];
    const harness = createHarness(async () => {
      throw Object.assign(new Error('Authorization token=private-fixture provider-body'), { code: 'LLM_API_ERROR', status });
    }, { logger: { error: line => logs.push(line), warn() {} } });
    try {
      const response = await harness.runtime.handleTurn({ sessionId: 'auth-failure',
        requestId: 'auth-failure-' + status, userText: '继续聊聊', speak: true });
      assert.equal(response.ok, false);
      assert.match(response.displayText, /认证或访问权限/);
      assert.match(response.displayText, /模型.*设置|切换.*模型/);
      assert.equal(response.presentation.speak, false);
      assert.equal(response.presentation.spokenText, '');
      assert.doesNotMatch(JSON.stringify([response.displayText,
        harness.conversationStore.listTurns('auth-failure')]), /private-fixture|provider-body|Authorization|err_/);
      assert.doesNotMatch(JSON.stringify(logs), /private-fixture|provider-body|Authorization/);
    } finally { harness.close(); }
  }
});

test('a model diagnostic echo is replaced by the typed tool fallback and is never marked speakable', async () => {
  const harness = createHarness(async messages => {
    if (!messages.some(message => message.role === 'tool')) {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'explode-diagnostic', type: 'function', function: { name: 'explode', arguments: '{}' } }],
      } };
    }
    return { message: { role: 'assistant', content: 'INTERNAL_TOOL_ERROR token=secret err_deadbeef12345678' } };
  }, {
    capabilityResolver: () => ['danger-test'],
    registerTools(tools) {
      tools.register('explode', {
        capability: 'danger-test',
        definition: { description: 'test', parameters: { type: 'object', properties: {} } },
        handler() { throw new Error('provider private details'); },
      });
    },
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 'safe-diagnostic', requestId: 'safe-r', userText: '执行' });
    assert.equal(response.displayText, '刚才的操作没有完成，你可以稍后再试。');
    assert.equal(response.presentation.speak, false);
    assert.doesNotMatch(JSON.stringify(harness.conversationStore.listTurns('safe-diagnostic')), /deadbeef|token=secret/);
  } finally {
    harness.close();
  }
});

test('incomplete and orphaned tool protocol fragments are excluded from model history', () => {
  const turns = [
    { role: 'tool', message: { role: 'tool', tool_call_id: 'orphan', content: '{}' } },
    { role: 'assistant', message: { role: 'assistant', content: '', tool_calls: [
      { id: 'c1', function: { name: 'one', arguments: '{}' } },
      { id: 'c2', function: { name: 'two', arguments: '{}' } },
    ] } },
    { role: 'tool', message: { role: 'tool', tool_call_id: 'c1', content: '{}' } },
    { role: 'assistant', message: { role: 'assistant', content: '恢复后的安全可见回复' } },
  ];
  assert.deepEqual(
    keepCompleteToolProtocol(turns).map(turn => turn.message.content),
    ['恢复后的安全可见回复'],
  );
});

test('memory retrieval receives the current user text as query', async () => {
  const queries = [];
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    return { message: { role: 'assistant', content: '知道了。' } };
  }, {
    retrieveMemories: async input => {
      queries.push(input);
      return [
        { source: 'echo', content: input.query },
        { source: 'explicit', content: '相关记忆' },
      ];
    },
  });
  try {
    await harness.runtime.handleTurn({ sessionId: 's', requestId: 'r', userText: '我现在想听安静一点的', speak: false });
    assert.equal(queries[0].query, '我现在想听安静一点的');
    assert.equal(queries[0].namespace, 'person:lunara');
    assert.doesNotMatch(calls[0][0].content, /我现在想听安静一点的/);
    assert.equal(calls[0].filter(message => message.content === '我现在想听安静一点的').length, 1);
  } finally {
    harness.close();
  }
});

test('prompt-too-long response triggers one aggressive context recovery without duplicating the turn', async () => {
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    if (calls.length === 1) {
      const error = new Error('maximum context length exceeded');
      error.code = 'context_length_exceeded';
      throw error;
    }
    return { message: { role: 'assistant', content: '我接着说。' } };
  });
  try {
    const response = await harness.runtime.handleTurn({ sessionId: 's', requestId: 'r', userText: '继续', speak: false });
    assert.equal(response.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].at(-1).content, '继续');
    assert.equal(harness.conversationStore.listTurns('s', { visibleOnly: true }).length, 2);
  } finally {
    harness.close();
  }
});

test('runtime persists an auditable compaction summary without deleting transcript turns', async () => {
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    return { message: { role: 'assistant', content: `回答:${messages.at(-1).content}` } };
  }, {
    contextBudgeter: new ContextBudgeter({ maxBytes: 10_000, maxMessages: 4 }),
  });
  try {
    for (let index = 1; index <= 4; index++) {
      await harness.runtime.handleTurn({
        sessionId: 'compact', requestId: `compact-${index}`, userText: `第${index}轮`, speak: false,
      });
    }
    const summaries = harness.conversationStore.listSummaries('compact');
    assert(summaries.length >= 1);
    assert.equal(summaries[0].fromSequence, 1);
    assert(summaries[0].toSequence < harness.conversationStore.getSession('compact').nextSequence);
    assert.equal(harness.conversationStore.listTurns('compact', { visibleOnly: true }).length, 8);
    assert.match(calls.at(-1)[0].content, /较早对话摘要/);
    assert.match(calls.at(-1)[0].content, /第1轮/);
  } finally {
    harness.close();
  }
});

test('single-speaker handoff keeps shared transcript but retrieves only the active private namespace', async () => {
  const calls = [];
  const memoryQueries = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    const replies = ['Lunara 在这里。', '夜航接住了刚才的话。', '晨雾也知道我们聊到哪里。', 'Lunara 回来了。'];
    return { message: { role: 'assistant', content: replies[calls.length - 1] } };
  }, {
    retrieveMemories: async input => {
      memoryQueries.push(input);
      return [{ source: input.namespace, content: `private:${input.namespace}` }];
    },
  });
  try {
    harness.registry.createRadiohost({
      id: 'radiohost-night', displayName: '夜航', voiceProfileId: 'voice-night',
      personaDocument: '说话克制、有夜间电台感。', memoryNamespace: 'radiohost:radiohost-night',
    });
    harness.registry.createRadiohost({
      id: 'radiohost-morning', displayName: '晨雾', voiceProfileId: 'voice-morning',
      personaDocument: '清醒、轻快。', memoryNamespace: 'radiohost:radiohost-morning',
    });
    await harness.runtime.handleTurn({ sessionId: 'handoff', requestId: 'root-turn', userText: '我今天有点累', speak: false });
    harness.conversationStore.setActiveVirtualPerson('handoff', 'radiohost-night');
    await harness.runtime.handleTurn({ sessionId: 'handoff', requestId: 'child-turn', userText: '换你来接着聊', speak: false });
    harness.conversationStore.setActiveVirtualPerson('handoff', 'radiohost-morning');
    await harness.runtime.handleTurn({ sessionId: 'handoff', requestId: 'sibling-turn', userText: '晨雾也接一下', speak: false });
    harness.conversationStore.setActiveVirtualPerson('handoff', 'lunara');
    await harness.runtime.handleTurn({ sessionId: 'handoff', requestId: 'root-return', userText: 'Lunara 回来吧', speak: false });

    assert.deepEqual(memoryQueries.map(item => item.namespace), [
      'person:lunara', 'radiohost:radiohost-night', 'radiohost:radiohost-morning', 'person:lunara',
    ]);
    assert.match(calls[1][0].content, /夜航/);
    assert.match(calls[1][0].content, /说话克制/);
    assert.match(calls[1][0].content, /private:radiohost:radiohost-night/);
    assert.doesNotMatch(calls[1][0].content, /private:person:lunara/);
    assert.match(calls[2][0].content, /private:radiohost:radiohost-morning/);
    assert.match(calls[2][0].content, /清醒、轻快/);
    assert.doesNotMatch(calls[2][0].content, /private:radiohost:radiohost-night/);
    // 别人说过的话是 user 角色里的同伴信封，与相邻的用户发言合并成一条。
    assert.deepEqual(calls[1].slice(1).map(message => [message.role, message.content]), [
      ['user', '我今天有点累\n\n<peer_message from="Lunara" member="lunara" round="earlier">\nLunara 在这里。\n</peer_message>\n\n换你来接着聊'],
    ]);
    // 自己说过的话保持 assistant 且不加标注：模型看到自己的话带标签，会照着格式把标签说出来。
    assert.deepEqual(calls[3].slice(1).map(message => [message.role, message.content]), [
      ['user', '我今天有点累'],
      ['assistant', 'Lunara 在这里。'],
      ['user', '换你来接着聊\n\n<peer_message from="夜航" member="radiohost-night" round="earlier">\n夜航接住了刚才的话。\n</peer_message>\n\n晨雾也接一下\n\n<peer_message from="晨雾" member="radiohost-morning" round="earlier">\n晨雾也知道我们聊到哪里。\n</peer_message>\n\nLunara 回来吧'],
    ]);
    const visibleTurns = harness.conversationStore.listTurns('handoff', { visibleOnly: true });
    assert.deepEqual(
      visibleTurns.filter(turn => turn.role === 'assistant').map(turn => turn.speakerVirtualPersonId),
      ['lunara', 'radiohost-night', 'radiohost-morning', 'lunara'],
    );
  } finally {
    harness.close();
  }
});

test('speaker labels the model imitates are stripped from replies and from stored history', async () => {
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    const replies = ['[历史说话人：Lunara]\n先听这首吧。', '[历史说话人：夜航] 我接着说。', '好。'];
    return { message: { role: 'assistant', content: replies[calls.length - 1] } };
  });
  try {
    harness.registry.createRadiohost({
      id: 'radiohost-night', displayName: '夜航', voiceProfileId: 'voice-night',
      personaDocument: '说话克制。', memoryNamespace: 'radiohost:radiohost-night',
    });
    const first = await harness.runtime.handleTurn({ sessionId: 'label', requestId: 'label-1', userText: '你好', speak: false });
    assert.equal(first.displayText, '先听这首吧。');
    harness.conversationStore.setActiveVirtualPerson('label', 'radiohost-night');
    const second = await harness.runtime.handleTurn({ sessionId: 'label', requestId: 'label-2', userText: '换你', speak: false });
    assert.equal(second.displayText, '我接着说。');
    // 旧版本已经存进账本的带标签文本：投影时先去掉原有标签，只按真实说话人重新标注一次。
    const stored = harness.conversationStore.listTurns('label', { visibleOnly: true })
      .filter(turn => turn.role === 'assistant').map(turn => turn.message.content);
    assert.deepEqual(stored, ['先听这首吧。', '我接着说。']);
    harness.conversationStore.setActiveVirtualPerson('label', 'lunara');
    await harness.runtime.handleTurn({ sessionId: 'label', requestId: 'label-3', userText: '回来', speak: false });
    assert.deepEqual(calls[2].slice(1).map(message => [message.role, message.content]), [
      ['user', '你好'],
      ['assistant', '先听这首吧。'],
      ['user', '换你\n\n<peer_message from="夜航" member="radiohost-night" round="earlier">\n我接着说。\n</peer_message>\n\n回来'],
    ]);
  } finally {
    harness.close();
  }
});

test('legacy stored replies that already carry a speaker label are projected once by their real speaker', async () => {
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    return { message: { role: 'assistant', content: '好。' } };
  });
  try {
    harness.registry.createRadiohost({
      id: 'radiohost-night', displayName: '夜航', voiceProfileId: 'voice-night',
      personaDocument: '说话克制。', memoryNamespace: 'radiohost:radiohost-night',
    });
    await harness.runtime.handleTurn({ sessionId: 'legacy', requestId: 'legacy-1', userText: '你好', speak: false });
    harness.conversationStore.setActiveVirtualPerson('legacy', 'radiohost-night');
    await harness.runtime.handleTurn({ sessionId: 'legacy', requestId: 'legacy-2', userText: '换你', speak: false });
    const turns = harness.conversationStore.listTurns('legacy', { visibleOnly: true }).filter(turn => turn.role === 'assistant');
    harness.conversationStore.db.prepare('UPDATE conversation_turns SET message_json = ? WHERE turn_id = ?')
      .run(JSON.stringify({ role: 'assistant', content: '[历史说话人：Lunara]\n旧的话。' }), turns[0].turnId);
    harness.conversationStore.db.prepare('UPDATE conversation_turns SET message_json = ? WHERE turn_id = ?')
      .run(JSON.stringify({ role: 'assistant', content: '[历史说话人：小满]\n[历史说话人：夜航]\n夜航的旧话。' }), turns[1].turnId);
    harness.conversationStore.setActiveVirtualPerson('legacy', 'lunara');
    await harness.runtime.handleTurn({ sessionId: 'legacy', requestId: 'legacy-3', userText: '回来', speak: false });
    // 旧账本里漏进正文的标签在投影时剥掉，再按真实说话人投影一次。
    assert.deepEqual(calls.at(-1).slice(1).map(message => [message.role, message.content]), [
      ['user', '你好'],
      ['assistant', '旧的话。'],
      ['user', '换你\n\n<peer_message from="夜航" member="radiohost-night" round="earlier">\n夜航的旧话。\n</peer_message>\n\n回来'],
    ]);
  } finally {
    harness.close();
  }
});

test('long sessions reload a cumulative persisted summary instead of forgetting the earliest turn', async () => {
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    return { message: { role: 'assistant', content: `收到:${messages.at(-1).content}` } };
  }, {
    contextBudgeter: new ContextBudgeter({ maxBytes: 10_000, maxMessages: 4 }),
  });
  try {
    for (let index = 1; index <= 55; index += 1) {
      const text = index === 1 ? '请记住 CODEWORD-719' : `第${index}轮`;
      await harness.runtime.handleTurn({
        sessionId: 'long-context', requestId: `long-${index}`, userText: text, speak: false,
      });
    }
    assert.ok(harness.conversationStore.listTurns('long-context', { limit: 500 }).length > 100);
    assert.match(calls.at(-1)[0].content, /CODEWORD-719/);
  } finally {
    harness.close();
  }
});

test('speaker handoff shares visible dialogue but not the previous persona tool context', async () => {
  const calls = [];
  const harness = createHarness(async messages => {
    calls.push(structuredClone(messages));
    const current = messages.at(-1);
    if (current.role === 'user' && current.content === 'root operation') {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'root-private', type: 'function', function: { name: 'private_tool', arguments: '{}' } }],
      } };
    }
    if (current.role === 'tool') {
      return { message: { role: 'assistant', content: '根人格处理好了。' } };
    }
    return { message: { role: 'assistant', content: '子人格只接着可见对话。' } };
  }, {
    capabilityResolver: () => ['private-capability'],
    registerTools(tools) {
      tools.register('private_tool', {
        capability: 'private-capability',
        definition: { description: 'private', parameters: { type: 'object', properties: {} } },
        handler: () => ({
          kind: 'success',
          code: 'PRIVATE_TOOL_DONE',
          facts: {},
          modelContext: 'ROOT_PRIVATE_TOOL_CONTEXT',
          presentation: { speak: false },
        }),
      });
    },
  });
  try {
    harness.registry.createRadiohost({
      id: 'radiohost-child', displayName: '子人格', voiceProfileId: 'voice-child',
      personaDocument: '保持自己的边界。', memoryNamespace: 'radiohost:radiohost-child',
    });
    await harness.runtime.handleTurn({
      sessionId: 'private-handoff', requestId: 'root-private-turn', userText: 'root operation', speak: false,
    });
    harness.conversationStore.setActiveVirtualPerson('private-handoff', 'radiohost-child');
    await harness.runtime.handleTurn({
      sessionId: 'private-handoff', requestId: 'child-visible-turn', userText: '接着聊', speak: false,
    });

    const childCall = calls.at(-1);
    assert.match(JSON.stringify(childCall), /根人格处理好了/);
    assert.doesNotMatch(JSON.stringify(childCall), /ROOT_PRIVATE_TOOL_CONTEXT|root-private/);
    assert.equal(childCall.some(message => message.role === 'tool'), false);
  } finally {
    harness.close();
  }
});

test('recent correction is resolved before one contextual radio tool execution', async () => {
  const modelCalls = [];
  const toolCalls = [];
  const harness = createHarness(async messages => {
    modelCalls.push(structuredClone(messages));
    const current = messages.at(-1);
    if (modelCalls.length === 1) {
      return { message: { role: 'assistant', content: '记下陈奕迅《十年》，先不播放。' } };
    }
    if (current.role === 'user') {
      return { message: {
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'radio-correction', type: 'function',
          function: { name: 'radio_request', arguments: JSON.stringify({ request: '播放陈奕迅的粤语歌《明年今日》，不要播放国语歌《十年》' }) },
        }],
      } };
    }
    return { message: { role: 'assistant', content: '改成粤语的《明年今日》了。' } };
  }, {
    capabilityResolver: () => ['radio.dispatch'],
    registerTools(tools) {
      tools.register('radio_request', {
        capability: 'radio.dispatch',
        definition: { description: 'radio', parameters: { type: 'object', properties: { request: { type: 'string' } } } },
        handler(args) {
          toolCalls.push(args);
          return {
            kind: 'success', code: 'RADIO_REQUEST_COMPLETED',
            facts: { title: '明年今日', artist: '陈奕迅' },
            modelContext: '已提交：陈奕迅《明年今日》',
            presentation: { speak: false },
          };
        },
      });
    },
  });
  try {
    await harness.runtime.handleTurn({ sessionId: 'correction', requestId: 'before', userText: '想听陈奕迅的十年，不过先别放', speak: false });
    const response = await harness.runtime.handleTurn({ sessionId: 'correction', requestId: 'after', userText: '不是国语那首，要它的粤语版本，现在放', speak: false });
    assert.equal(response.displayText, '改成粤语的《明年今日》了。');
    assert.deepEqual(toolCalls, [{ request: '播放陈奕迅的粤语歌《明年今日》，不要播放国语歌《十年》' }]);
    assert.equal(modelCalls.length, 3);
    assert.deepEqual(modelCalls[1].slice(1).map(message => [message.role, message.content]), [
      ['user', '想听陈奕迅的十年，不过先别放'],
      ['assistant', '记下陈奕迅《十年》，先不播放。'],
      ['user', '不是国语那首，要它的粤语版本，现在放'],
    ]);
    const turns = harness.conversationStore.listTurns('correction');
    assert.equal(turns.filter(turn => turn.role === 'tool').length, 1);
  } finally {
    harness.close();
  }
});

test('a turn that requests track narration hands the voice to the narration instead of speaking twice', async () => {
  const terminal = (code, displayText) => ({
    kind: 'success', code, facts: {}, modelContext: 'ok',
    presentation: { displayText, speak: false },
    terminal: true,
  });
  const harness = createHarness(async () => ({
    message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'narrate', type: 'function', function: { name: 'narrate', arguments: '{}' } }],
    },
  }), {
    capabilityResolver: () => ['narrate-cap'],
    registerTools(tools) {
      tools.register('narrate', {
        capability: 'narrate-cap',
        definition: { description: 'narrate', parameters: { type: 'object', properties: {} } },
        handler: (_args, context) => terminal(context.requestId.includes('other') ? 'MUSIC_RECOMMENDED' : 'NARRATION_REQUESTED',
          '好，我来说说这一首。'),
      });
    },
  });
  try {
    const narrating = await harness.runtime.handleTurn({ sessionId: 'voice-a', requestId: 'narrate-r', userText: '讲讲这首' });
    assert.equal(narrating.presentation.displayText, '好，我来说说这一首。');
    assert.equal(narrating.presentation.speak, false);

    const other = await harness.runtime.handleTurn({ sessionId: 'voice-a', requestId: 'other-r', userText: '嗯' });
    assert.equal(other.presentation.speak, true);
  } finally {
    harness.close();
  }
});

test('environment snapshot reaches the prompt; failures never block the turn', async () => {
  const seen = [];
  const harness = createHarness(async messages => {
    seen.push(String(messages[0]?.content || ''));
    return { message: { role: 'assistant', content: '外面在下雨呢。' } };
  }, {
    getEnvironment: async () => ({ available: true, cityName: '上海 · 上海市 · 中国', summaryZh: '雨', tempC: 24 }),
  });
  try {
    await harness.runtime.handleTurn({ sessionId: 's', requestId: 'r', userText: '今天天气怎么样', speak: false });
    assert.match(seen[0], /当地天气（来源 Open-Meteo/);
    assert.match(seen[0], /上海 · 上海市 · 中国 · 雨 24°C/);
  } finally {
    harness.close();
  }

  const failing = createHarness(async () => ({ message: { role: 'assistant', content: '在呢。' } }), {
    getEnvironment: async () => { throw new Error('env down'); },
  });
  try {
    const result = await failing.runtime.handleTurn({ sessionId: 's', requestId: 'r2', userText: '在吗', speak: false });
    assert.ok(result);
  } finally {
    failing.close();
  }
});
