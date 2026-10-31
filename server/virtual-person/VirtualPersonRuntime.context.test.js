// 普通回合上下文的逐字节基线（add-companion-heartbeat 1.1）。
//
// 抽出共用的 `_assembleContext` 之后，普通回合送给模型的 system prompt 与消息数组
// 必须与抽取前完全一致。夹具覆盖 1:1、群聊、较早摘要、今日计划、天气、被撤回回合。
// 有意修改提示词时，用 LUNARA_UPDATE_CONTEXT_BASELINE=1 重新生成基线并审阅 diff。
process.env.TZ = 'Asia/Shanghai';

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentLoop } from './AgentLoop.js';
import { ContextBudgeter } from './ContextBudgeter.js';
import { ConversationStore } from './ConversationStore.js';
import { PresentationService } from './PresentationService.js';
import { PromptAssembler } from './PromptAssembler.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonRuntime } from './VirtualPersonRuntime.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';

const BASELINE_PATH = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'runtime-context-baseline.json');
const UPDATE = process.env.LUNARA_UPDATE_CONTEXT_BASELINE === '1';
const NOW = new Date('2026-09-03T00:00:00.000Z');

const MEMORIES = [
  { kind: 'memory', source: 'person:lunara:manual_seed', id: 41, content: '用户在找工作。', createdAt: Date.parse('2026-08-08T13:14:00.000Z') },
  { kind: 'relationship', source: 'person:lunara:user_explicit_feedback', id: 7, content: '用户希望被直接指出问题。', createdAt: Date.parse('2026-08-01T04:00:00.000Z') },
  { kind: 'encounter', source: 'turn_x', content: '用户：上周聊过雨天通勤。', createdAt: Date.parse('2026-08-27T12:00:00.000Z') },
];

function createHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-vp-context-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath });
  const conversationStore = new ConversationStore({ dbPath });
  const tools = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const calls = [];
  let reply = 0;
  const chat = async messages => {
    calls.push(structuredClone(messages));
    reply += 1;
    return { message: { role: 'assistant', content: `第${reply}次回应。` } };
  };
  const budgeter = options.contextBudgeter || new ContextBudgeter({ maxBytes: 20_000, maxMessages: 20 });
  const runtime = new VirtualPersonRuntime({
    registry,
    conversationStore,
    promptAssembler: new PromptAssembler({ now: () => NOW }),
    contextBudgeter: budgeter,
    agentLoop: new AgentLoop({ chat, toolRegistry: tools, contextBudgeter: budgeter }),
    presentationService: new PresentationService(),
    capabilityResolver: () => [],
    retrieveMemories: options.retrieveMemories || (async () => []),
    getEnvironment: options.getEnvironment || null,
    getRuntimeState: options.getRuntimeState || (() => null),
    getLifeContext: options.getLifeContext || null,
    logger: { error() {}, warn() {} },
  }).initialize();
  return {
    runtime, registry, conversationStore, calls,
    close() {
      runtime.shutdown?.();
      conversationStore.close();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const snapshot = call => ({ system: call[0].content, messages: call.slice(1) });

// 回合 id 是随机生成的；按首次出现顺序换成稳定占位符，其余字节原样比较。
function stableIds(value) {
  const ids = new Map();
  return JSON.parse(JSON.stringify(value).replace(/\b(turn|round|req)_[0-9a-f]{12,}\b/g, id => {
    if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`);
    return ids.get(id);
  }));
}

const FIXTURES = {
  async oneToOne() {
    const h = createHarness({
      retrieveMemories: async () => MEMORIES,
      getRuntimeState: () => ({ playback: { phase: 'playing', title: '夜航星' } }),
    });
    try {
      await h.runtime.handleTurn({ sessionId: 'one', requestId: 'one-1', userText: '今天下雨了，通勤好慢', speak: false });
      await h.runtime.handleTurn({ sessionId: 'one', requestId: 'one-2', userText: '你觉得呢', speak: false });
      return h.calls.map(snapshot);
    } finally { h.close(); }
  },
  async group() {
    const h = createHarness({ retrieveMemories: async input => [{ kind: 'memory', source: input.namespace, content: `私有:${input.namespace}` }] });
    try {
      for (const id of ['a', 'b']) h.registry.createRadiohost({ id, displayName: id.toUpperCase(), voiceProfileId: `voice-${id}`, personaDocument: `${id} 的人设。` });
      h.conversationStore.createRoom({ sessionId: 'group', memberIds: ['a', 'b'] });
      await h.runtime.handleTurn({ sessionId: 'group', requestId: 'group-1', userText: '大家各自说说今天', speak: false });
      await h.runtime.handleTurn({ sessionId: 'group', requestId: 'group-2', userText: '@B 你接着说', speak: false });
      return h.calls.map(snapshot);
    } finally { h.close(); }
  },
  async summaries() {
    const h = createHarness({ contextBudgeter: new ContextBudgeter({ maxBytes: 10_000, maxMessages: 4 }) });
    try {
      for (let index = 1; index <= 8; index += 1) {
        await h.runtime.handleTurn({ sessionId: 'long', requestId: `long-${index}`, userText: index === 1 ? '请记住 CODEWORD-719' : `第${index}轮`, speak: false });
      }
      return h.calls.slice(-2).map(snapshot);
    } finally { h.close(); }
  },
  async lifeAndWeather() {
    const h = createHarness({
      getEnvironment: () => ({ available: true, resolvedName: '上海', summaryZh: '小雨', tempC: 21.4 }),
      getLifeContext: () => ({
        targetDate: '2026-09-03', timeZone: 'Asia/Shanghai', plannedScene: 'commute',
        entries: [{ status: 'planned', time: { start: '08:00', end: '09:00' }, type: 'commute', sceneTag: 'commute', note: '地铁' }],
      }),
    });
    try {
      await h.runtime.handleTurn({ sessionId: 'life', requestId: 'life-1', userText: '早上好', speak: false });
      return h.calls.map(snapshot);
    } finally { h.close(); }
  },
  async revokedTurn() {
    const h = createHarness();
    try {
      await h.runtime.handleTurn({ sessionId: 'revoke', requestId: 'revoke-1', userText: '我准备辞职了', speak: false });
      const userTurn = h.conversationStore.listTurns('revoke', { visibleOnly: true }).find(turn => turn.role === 'user');
      h.conversationStore.revokeObservation('lunara', userTurn.turnId);
      await h.runtime.handleTurn({ sessionId: 'revoke', requestId: 'revoke-2', userText: '刚才那句忘掉吧，聊点别的', speak: false });
      return h.calls.slice(-1).map(snapshot);
    } finally { h.close(); }
  },
};

test('ordinary turn context stays byte-for-byte identical to the recorded baseline', async () => {
  const actual = {};
  for (const [name, run] of Object.entries(FIXTURES)) actual[name] = stableIds(await run());
  if (UPDATE) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  for (const name of Object.keys(FIXTURES)) assert.deepEqual(actual[name], expected[name], `fixture ${name} drifted`);
});

test('baseline fixtures exercise the intended context features', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  assert.match(baseline.oneToOne.at(-1).system, /用户希望被直接指出问题/);
  assert.match(baseline.oneToOne.at(-1).system, /上周聊过雨天通勤/);
  assert.deepEqual(baseline.oneToOne.at(-1).messages.map(message => message.role), ['user', 'assistant', 'user']);
  assert.match(baseline.group[0].system, /本聊天参与者/);
  assert.ok(baseline.group.some(call => /私有:radiohost:b/.test(call.system)));
  assert.match(baseline.summaries.at(-1).system, /较早对话摘要[\s\S]*CODEWORD-719/);
  assert.match(baseline.lifeAndWeather[0].system, /今日计划/);
  assert.match(baseline.lifeAndWeather[0].system, /上海 · 小雨 21°C/);
  const revoked = JSON.stringify(baseline.revokedTurn);
  assert.doesNotMatch(revoked, /我准备辞职了/);
});
