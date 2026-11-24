// 串词的表演意图：提交按当前声音的能力校验标记，机械校验只看纯文本；
// 产物 text 为纯文本，另存 spokenText 与 performance；重合成按原表演，旧数据回落 text。

import assert from 'node:assert/strict';
import test from 'node:test';

import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { ProgramNarrationComposer } from './ProgramNarrationComposer.js';
import { TRACK_LINES_CAPABILITY, TRACK_LINES_TOOL_NAME, registerTrackLineTools } from './trackLineTools.js';
import { describeCapability, resolvePerformanceCapability } from '../tts/performance/capabilities.js';

const MINIMAX = describeCapability(resolvePerformanceCapability({ protocol: 'minimax', model: 'speech-2.8-hd' }));
const BREEZE = describeCapability(resolvePerformanceCapability({ protocol: 'breeze', model: 'breeze-tts-2' }));

const track = { title: '晴天', artist: '周杰伦' };
const PLAIN = '《晴天》放在这里。天快黑了。路上人不多。听这首正合适。';
const MARKED = `{叹气}${PLAIN.replace('天快黑了', '{停顿:0.5}天快黑了')}`;

function writer(capability) {
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerTrackLineTools(registry);
  const saved = [];
  const task = { targets: new Map(), performance: capability,
    voiceProfileId: 'voice-a', membershipRevision: 1, now: () => 1000 };
  task.targets.set('t1', { saved: false, lastRule: null, save: async line => { saved.push(line); return true; }, fail: () => {},
    checks: { track, facts: { album: '', year: null }, recentConversation: [], minChars: 12, minSentences: 1, chatIntroduced: false,
      recommendation: null, lyricExcerpt: null, memories: [], liked: null, listenerAsked: false, overusedPhrases: [] } });
  const submit = entry => {
    task.targets.get('t1').saved = false;
    return registry.execute(TRACK_LINES_TOOL_NAME, { lines: [{ ref: 't1', ...entry }] }, {
      capabilities: [TRACK_LINES_CAPABILITY], trackLineTask: task, round: 1, finishReason: 'tool_calls', correlationId: 't' });
  };
  return { registry, saved, submit };
}

const ruleOf = outcome => outcome.facts.rejected[0]?.rule;

test('声音无表演能力：带标记的提交被可纠正地拒绝，performance 直接丢弃', async () => {
  const { submit, saved } = writer(null);
  const rejected = await submit({ text: `{笑}${PLAIN}` });
  assert.equal(rejected.ok, false);
  assert.equal(ruleOf(rejected), 'performance-unsupported');
  assert.match(rejected.modelContext, /不支持任何语气标记/);
  assert.equal(rejected.presentation.retryable, true);
  const accepted = await submit({ text: PLAIN, performance: { emotion: 'sad' } });
  assert.equal(accepted.ok, true);
  assert.equal(saved[0].performance, null);
  assert.equal(saved[0].spokenText, null);
});

test('有能力：超限、未知、越权标记与原生语法被拒，并提示可用列表', async () => {
  const { submit } = writer(BREEZE);
  const cases = [
    [`{笑}{叹气}{清嗓子}${PLAIN}`, 'performance-too-many-events'],
    [`{咳嗽}${PLAIN}`, 'performance-unknown-marker'],
    [`{换气}${PLAIN}`, 'performance-unsupported-marker'],
    [PLAIN.replace('天快黑了', '{停顿:0.5}天快黑了'), 'performance-unsupported-marker'],
    [`(sighs)${PLAIN}`, 'performance-native-syntax'],
    [`[叹气]${PLAIN}`, 'performance-native-syntax'],
  ];
  for (const [text, rule] of cases) {
    const outcome = await submit({ text });
    assert.equal(outcome.ok, false, text);
    assert.equal(ruleOf(outcome), rule, text);
    assert.match(outcome.modelContext, /\{叹气\}/, '反馈附带当前可用标记');
  }
  const { submit: minimax } = writer(MINIMAX);
  assert.equal(ruleOf(await minimax({ text: PLAIN.replace(/。/g, '。{停顿:0.3}') })), 'performance-too-many-pauses');
  assert.equal(ruleOf(await minimax({ text: PLAIN.replace('天快黑了', '{停顿:3}天快黑了') })), 'performance-invalid-pause');
});

test('performance 中能力不支持的字段（MiniMax 的 warm、direction）不导致拒绝，留到翻译时丢弃', async () => {
  const { submit, saved } = writer(MINIMAX);
  const accepted = await submit({ text: MARKED, performance: { emotion: 'warm', pace: 'slow', direction: '像在耳边说' } });
  assert.equal(accepted.ok, true);
  assert.deepEqual(saved[0].performance, { emotion: 'warm', pace: 'slow', intensity: null, direction: '像在耳边说' });
});

test('机械校验作用于纯文本：标记不计入长度与复述检查，接受后 text 为纯文本', async () => {
  const { submit, saved } = writer(MINIMAX);
  const accepted = await submit({ text: MARKED, performance: { emotion: 'calm' } });
  assert.equal(accepted.ok, true, accepted.modelContext);
  assert.equal(saved[0].text, PLAIN);
  assert.equal(saved[0].spokenText, MARKED);
  assert.doesNotMatch(saved[0].text, /\{/);
});

test('没有表演的提交不带 spokenText/performance', async () => {
  const { submit, saved } = writer(MINIMAX);
  await submit({ text: PLAIN });
  assert.equal(saved[0].spokenText, null);
  assert.equal(saved[0].performance, null);
});

test('提交 schema 带可选 performance，枚举与 direction 长度受限', () => {
  const { registry } = writer(MINIMAX);
  const definition = registry.definitions({ capabilities: [TRACK_LINES_CAPABILITY] })
    .find(item => item.function.name === TRACK_LINES_TOOL_NAME).function;
  const line = definition.parameters.properties.lines.items;
  assert.deepEqual(line.required, ['ref', 'text']);
  assert.equal(line.properties.performance.type, 'object');
  assert.equal(line.properties.performance.additionalProperties, false);
  assert.deepEqual(line.properties.performance.properties.emotion.enum, ['calm', 'warm', 'happy', 'playful', 'sad', 'surprised', 'serious']);
  assert.equal(line.properties.performance.properties.direction.maxLength, 60);
});

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
