// narrationPerformance.test.js — 串词表演意图（speech-performance）的写作、校验与产物。
//
// 覆盖 contextual-track-narration 的两条新增要求：
// - 写作素材只提供当前声音的表演能力；提交按能力校验标记，机械校验作用于纯文本；
// - 产物 text 为纯文本，另存 spokenText 与 performance；兜底与今日草稿不带表演；
//   重合成按原表演，旧数据回落 text。

import assert from 'node:assert/strict';
import test from 'node:test';

import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { createNarrationAgent } from './NarrationAgent.js';
import { NARRATION_SUBMIT_TOOL_NAME } from './narrationTools.js';
import { ProgramNarrationComposer } from './ProgramNarrationComposer.js';
import { resolvePerformanceCapability, NO_PERFORMANCE_CAPABILITY } from '../tts/performance/capabilities.js';

const MINIMAX = resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.8-hd' });
const BREEZE = resolvePerformanceCapability({ protocol: 'breeze', model: 'breeze-tts-2' });

const trackFacts = {
  song: { year: 2003, genre: '流行', mood: '怀旧', tempo: 'mid' },
  artist: { genre: '华语流行', region: '华语' },
};
const effect = () => ({
  track: { title: '晴天', artist: '周杰伦', voiceProfileId: 'voice-a', album: '叶惠美',
    intro: { context: { origin: 'prepared', reason: 'user_request', mode: 'discovery', softPreferences: '熟悉的华语旋律' } } },
  previousTrack: { title: '花海', artist: '周杰伦' },
  listeningSessionId: 'room', queueItemId: 'q-1', generationRevision: 1, correlationId: 'corr-1',
});
const PLAIN = '接下来听周杰伦的《晴天》。它收录在《叶惠美》里，曲库记录的发行年份是2003年。曲库标签把它归为流行与怀旧，节奏感偏中速，适合把注意力慢慢放回旋律。你刚才想沿着熟悉的华语旋律继续走，所以我把这一首放在这里。';
const MARKED = `{叹气}${PLAIN.replace('它收录在', '{停顿:0.5}它收录在')}`;

async function captureTask(capability, { submitText = null, submitPerformance = undefined, synthCalls = [] } = {}) {
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const runs = [];
  const agent = createNarrationAgent({
    agentLoop: {
      run: async runInput => {
        runs.push(runInput);
        if (submitText === null) throw Object.assign(new Error('round limit'), { code: 'AGENT_ROUND_LIMIT' });
        const args = { text: submitText, ...(submitPerformance !== undefined ? { performance: submitPerformance } : {}) };
        const outcome = await toolRegistry.execute(NARRATION_SUBMIT_TOOL_NAME, args, {
          ...runInput.toolContext, capabilities: ['narration'], finishReason: 'tool_calls',
        });
        runInput.onMessage({ kind: 'assistant_tool_calls', message: { tool_calls: [{ id: 'c1', function: { name: NARRATION_SUBMIT_TOOL_NAME } }] } });
        runInput.onMessage({ kind: 'tool_result', message: { tool_call_id: 'c1' }, outcome });
        return { finishReason: 'tool_calls' };
      },
    },
    toolRegistry,
    getContext: () => ({ trackFacts }),
    getPerformanceCapability: voiceProfileId => (voiceProfileId === 'voice-a' ? capability : NO_PERFORMANCE_CAPABILITY),
    synthesize: async (text, options) => { synthCalls.push({ text, ...options }); return { url: '/tts/x.mp3', hash: 'x' }; },
  });
  const result = await agent.prepareTrack(effect());
  return { task: runs[0].toolContext.narrationTaskRequest, runs, result, toolRegistry, synthCalls };
}

const submit = (toolRegistry, task, args) => toolRegistry.execute(NARRATION_SUBMIT_TOOL_NAME, args, {
  capabilities: ['narration'], narrationTaskRequest: task, finishReason: 'tool_calls', correlationId: 't',
});

// ---- 4.1 写作素材与提交校验 ----

test('声音无表演能力：素材没有表演段落，带标记的提交被可纠正地拒绝', async () => {
  const { task, runs, toolRegistry } = await captureTask(NO_PERFORMANCE_CAPABILITY);
  assert.equal(task.performance, null);
  assert.doesNotMatch(runs[0].systemPrompt, /"performance"/);
  const rejected = await submit(toolRegistry, task, { text: `{笑}${PLAIN}` });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'NARRATION_REJECTED');
  assert.equal(rejected.facts.rejectedRule, 'performance-unsupported');
  assert.match(rejected.modelContext, /不支持任何语气标记/);
  assert.equal(rejected.presentation.retryable, true);
  const accepted = await submit(toolRegistry, task, { text: PLAIN, performance: { emotion: 'sad' } });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.facts.performance, null, '没有能力时 performance 直接丢弃');
  assert.equal(accepted.facts.spokenText, null);
});

test('有能力：素材列出可用标记、情绪与上限', async () => {
  const { task, runs } = await captureTask(MINIMAX);
  assert.ok(task.performance.markers.includes('{叹气}'));
  assert.ok(task.performance.markers.includes('{停顿:秒数}'));
  assert.equal(task.performance.limits.maxInlineEvents, 2);
  const brief = JSON.parse(runs[0].systemPrompt.split('本次素材与写作要求（JSON）：')[1]);
  assert.deepEqual(brief.performance.markers, task.performance.markers);
  assert.match(brief.performance.guide, /只在情绪需要时用/);
  assert.match(brief.performance.guide, /最多 2 个语气词/);
});

test('有能力：超限、未知、越权标记与原生语法被拒，并提示可用列表', async () => {
  const { task, toolRegistry } = await captureTask(BREEZE);
  const cases = [
    [`{笑}{叹气}{清嗓子}${PLAIN}`, 'performance-too-many-events'],
    [`{咳嗽}${PLAIN}`, 'performance-unknown-marker'],
    [`{换气}${PLAIN}`, 'performance-unsupported-marker'],
    [PLAIN.replace('它收录在', '{停顿:0.5}它收录在'), 'performance-unsupported-marker'],
    [`(sighs)${PLAIN}`, 'performance-native-syntax'],
    [`[叹气]${PLAIN}`, 'performance-native-syntax'],
  ];
  for (const [text, rule] of cases) {
    const outcome = await submit(toolRegistry, task, { text });
    assert.equal(outcome.ok, false, text);
    assert.equal(outcome.facts.rejectedRule, rule, text);
    assert.match(outcome.modelContext, /\{叹气\}/, '反馈附带当前可用标记');
  }
  const { task: minimaxTask, toolRegistry: minimaxTools } = await captureTask(MINIMAX);
  const pauses = PLAIN.replace(/。/g, '。{停顿:0.3}');
  assert.equal((await submit(minimaxTools, minimaxTask, { text: pauses })).facts.rejectedRule, 'performance-too-many-pauses');
  assert.equal((await submit(minimaxTools, minimaxTask, { text: `${PLAIN.replace('它收录在', '{停顿:3}它收录在')}` })).facts.rejectedRule,
    'performance-invalid-pause');
});

test('performance 中能力不支持的字段（MiniMax 的 warm、direction）不导致拒绝，留到翻译时丢弃', async () => {
  const { task, toolRegistry } = await captureTask(MINIMAX);
  const accepted = await submit(toolRegistry, task, { text: MARKED, performance: { emotion: 'warm', pace: 'slow', direction: '像在耳边说' } });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.facts.performance, { emotion: 'warm', pace: 'slow', intensity: null, direction: '像在耳边说' });
});

test('机械校验作用于纯文本：标记不计入长度与复述检查，接受后 text 为纯文本', async () => {
  const { task, toolRegistry } = await captureTask(MINIMAX);
  const accepted = await submit(toolRegistry, task, { text: MARKED, performance: { emotion: 'calm' } });
  assert.equal(accepted.ok, true, accepted.modelContext);
  assert.equal(accepted.facts.text, PLAIN);
  assert.equal(accepted.facts.spokenText, MARKED);
  assert.equal(accepted.facts.chars, PLAIN.length);
  assert.doesNotMatch(accepted.facts.text, /\{/);
});

test('提交 schema 带可选 performance，枚举与 direction 长度受限', async () => {
  const { toolRegistry } = await captureTask(MINIMAX);
  const definition = toolRegistry.definitions({ capabilities: ['narration'] })
    .find(item => item.function.name === NARRATION_SUBMIT_TOOL_NAME).function;
  const performance = definition.parameters.properties.performance;
  assert.deepEqual(definition.parameters.required, ['text']);
  assert.equal(performance.type, 'object');
  assert.equal(performance.additionalProperties, false);
  assert.deepEqual(performance.properties.emotion.enum, ['calm', 'warm', 'happy', 'playful', 'sad', 'surprised', 'serious']);
  assert.equal(performance.properties.direction.maxLength, 60);
});

// ---- 4.3 NarrationAgent 产物 ----

test('被接受的提交：text 为纯文本，另存 spokenText 与 performance，合成时传入表演', async () => {
  const synthCalls = [];
  const { result } = await captureTask(MINIMAX, { submitText: MARKED, submitPerformance: { emotion: 'sad', pace: 'slow' }, synthCalls });
  assert.equal(result.narrationSource, 'agent');
  assert.equal(result.text, PLAIN);
  assert.equal(result.spokenText, MARKED);
  assert.deepEqual(result.performance, { emotion: 'sad', pace: 'slow', intensity: null, direction: null });
  assert.equal(synthCalls.length, 1);
  assert.equal(synthCalls[0].text, MARKED);
  assert.deepEqual(synthCalls[0].performance, result.performance);
  assert.equal(synthCalls[0].voiceProfileId, 'voice-a');
});

test('没有表演的提交与兜底文本都不带 spokenText/performance', async () => {
  const plainCalls = [];
  const { result: plain } = await captureTask(MINIMAX, { submitText: PLAIN, synthCalls: plainCalls });
  assert.equal(plain.spokenText, null);
  assert.equal(plain.performance, null);
  assert.equal(plainCalls[0].performance, null);

  const fallbackCalls = [];
  const { result: fallback } = await captureTask(MINIMAX, { synthCalls: fallbackCalls });
  assert.equal(fallback.narrationSource, 'fallback');
  assert.equal(fallback.spokenText, null);
  assert.equal(fallback.performance, null);
  assert.equal(fallbackCalls[0].performance, null);
});

// ---- 4.4 重合成 ----

test('重合成：有 spokenText 与 performance 时按原表演合成；旧数据回落 text', async () => {
  const calls = [];
  const composer = new ProgramNarrationComposer({ synthesize: async (text, options) => { calls.push({ text, ...options }); return { url: '/tts/r.mp3', hash: 'r' }; } });
  const performance = { emotion: 'sad', pace: 'slow', intensity: null, direction: null };
  const withPerformance = await composer.resolveTrackNarrationAsset({ track: {
    voiceProfileId: 'voice-a', narration: { text: PLAIN, spokenText: MARKED, performance, voiceProfileId: 'voice-a' } } });
  assert.equal(withPerformance.ttsUrl, '/tts/r.mp3');
  const { signal, ...synthesized } = calls[0];
  assert.ok(signal instanceof AbortSignal, '重合成使用有界的子取消信号');
  assert.deepEqual(synthesized, { text: MARKED, voiceProfileId: 'voice-a', performance });

  await composer.resolveTrackNarrationAsset({ track: { voiceProfileId: 'voice-a', narration: { text: PLAIN, voiceProfileId: 'voice-a' } } });
  assert.equal(calls[1].text, PLAIN);
  assert.equal(calls[1].performance, null);

  // spokenText 与 text 不对应（被篡改或过期）时不信任它，回落 text。
  await composer.resolveTrackNarrationAsset({ track: { narration: { text: PLAIN, spokenText: '{笑}别的话。', performance } } });
  assert.equal(calls[2].text, PLAIN);
  assert.equal(calls[2].performance, null);
});
