// NarrationAgent：串词受限任务的入口（一切皆 tool）。
//
// 串词正文由主 AgentLoop 的受限任务生成：messages 为空、工具白名单、
// toolContext 锁定任务素材与校验边界、工具结果经 onMessage 捕获、外部取消原样上抛。
// 覆盖：接受路径（source=agent）、拒绝后可纠正重试、预算内失败/超时兜底、
// 今日节目草稿复用、陪伴模式与 persona 素材、predecessor 守卫与 TTS 有界降级。
//
// Run: node --test server/program/NarrationAgent.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { createNarrationAgent } from './NarrationAgent.js';
import { buildFallbackTrackNarration } from './ProgramNarrationComposer.js';

const trackFacts = {
  song: { year: 2003, genre: '流行', mood: '怀旧', tempo: 'mid', themes: ['青春', '错过'], instruments: ['吉他'] },
  artist: { genre: '华语流行', region: '华语' },
};

const richNarration = '接下来听周杰伦的《晴天》。它收录在《叶惠美》里，曲库记录的发行年份是2003年。曲库标签把它归为流行与怀旧，节奏感偏中速，适合把注意力慢慢放回旋律。你刚才想沿着熟悉的华语旋律继续走，所以我把这一首放在这里。';
const missingArtist = '接下来是《晴天》。这段旋律很干净，人声靠前，气口也留得比较自然。每一个字都放在了该放的位置上，听起来不急也不拖。我们可以安静听完，再判断它适不适合现在的状态。偶尔回头听这一段，会发现它一直没变。';

const effect = (origin = 'prepared', reason = 'user_request') => ({
  track: { title: '晴天', artist: '周杰伦', voiceProfileId: 'voice-a', album: '叶惠美',
    intro: { context: { origin, reason, mode: 'discovery', softPreferences: '熟悉的华语旋律' } } },
  previousTrack: { title: '花海', artist: '周杰伦' },
  listeningSessionId: 'room', queueItemId: 'q-1', generationRevision: 1, correlationId: 'corr-1',
});

const canonicalFallback = buildFallbackTrackNarration(effect().track, { previousTrack: effect().previousTrack });
const roundLimitError = () => Object.assign(new Error('virtual person turn reached round limit'),
  { code: 'AGENT_ROUND_LIMIT', finishReason: 'tool_calls' });

function createHarness({ driver, getContext, synthesize, sessionTrace = null, ...options } = {}) {
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const runs = [];
  const briefs = [];
  const journal = [];
  const spoken = [];
  const agentLoop = {
    run: async input => {
      runs.push(input);
      const tools = {
        briefs, journal,
        async execute(name, args, round, id) {
          await input.onMessage?.({ kind: 'assistant_tool_calls', round,
            message: { role: 'assistant', content: '',
              tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args ?? {}) } }] } });
          const outcome = await toolRegistry.execute(name, args, {
            correlationId: input.correlationId, round, toolCallCount: 1,
            capabilities: input.capabilities, finishReason: 'tool_calls',
            ...input.toolContext, signal: input.signal,
          });
          await input.onMessage?.({ kind: 'tool_result', round,
            message: { role: 'tool', tool_call_id: id, content: '{}' }, outcome });
          journal.push({ round, name, outcome });
          return outcome;
        },
      };
      return driver(input, tools);
    },
  };
  const agent = createNarrationAgent({ agentLoop, toolRegistry, sessionTrace,
    getContext: getContext || (() => ({ person: { displayName: 'A', voiceProfileId: 'voice-a' }, trackFacts })),
    synthesize: synthesize === undefined
      ? async (text, opts) => { spoken.push({ text, voiceProfileId: opts?.voiceProfileId }); return { url: '/tts.mp3', hash: 'hash-1' }; }
      : synthesize,
    ...options });
  return { agent, toolRegistry, runs, briefs, journal, spoken };
}

/** 真实循环的两回合形态：先取 brief，再按素材提交一次。 */
async function briefThenSubmit(input, tools, respond) {
  const briefOutcome = await tools.execute('get_track_narration_brief', {}, 1, 'b1');
  tools.briefs.push(briefOutcome.facts);
  const text = await respond(briefOutcome.facts, input);
  const submitted = await tools.execute('submit_track_narration', { text }, 2, 's1');
  if (submitted.ok && submitted.terminal) {
    return { finalText: submitted.presentation.displayText, rounds: 2, messages: [],
      outcomes: [briefOutcome, submitted], finishReason: 'tool_calls' };
  }
  throw roundLimitError();
}

/** 逐回合直接提交：第 1 回合被拒后，第 2 回合用修正文本重试。 */
const submitOnly = texts => async (input, tools) => {
  const outcomes = [];
  for (const [index, text] of texts.entries()) {
    const outcome = await tools.execute('submit_track_narration', { text }, index + 1, `s${index + 1}`);
    outcomes.push(outcome);
    if (outcome.ok && outcome.terminal) {
      return { finalText: outcome.presentation.displayText, rounds: index + 1, messages: [], outcomes, finishReason: 'tool_calls' };
    }
  }
  throw roundLimitError();
};

const captureOnly = async () => { throw roundLimitError(); };

test('prepareTrack runs one bounded restricted loop with the locked task and a session trace wrapper', async () => {
  const events = [];
  const harness = createHarness({
    driver: async () => { events.push({ kind: 'run' }); throw roundLimitError(); },
    sessionTrace: { enter: (context, fn) => { events.push({ kind: 'enter', context }); return fn(); } },
  });
  const result = await harness.agent.prepareTrack(effect());

  const [run] = harness.runs;
  assert.deepEqual(run.messages, [], '不插入任何合成用户消息');
  assert.deepEqual(run.toolNames, ['get_track_narration_brief', 'submit_track_narration'], '受限工具白名单');
  assert.equal(run.profileOverrides.maxRounds, 3);
  assert.equal(run.profileOverrides.emptyRetry, false);
  assert.ok(run.profileOverrides.timeoutMs > 6_500 && run.profileOverrides.timeoutMs <= 60_000);
  assert.ok(run.profileOverrides.deadlineMs > Date.now());
  assert.equal(run.modelProfileId, 'narration');
  assert.deepEqual(run.capabilities, ['narration']);
  assert.equal(run.sessionId, 'room');
  assert.equal(run.correlationId, 'corr-1');
  assert.match(run.systemPrompt, /此刻对听众说的话/u, '串词以这个人说话的身份写，不是系统任务');
  assert.match(run.systemPrompt, /《晴天》/);
  assert.equal(run.toolContext.listeningSessionId, 'room');
  assert.equal(run.toolContext.queueItemId, 'q-1');
  assert.equal(run.toolContext.generationRevision, 1);
  assert.equal(typeof run.toolContext.isCurrent, 'function');
  const task = run.toolContext.narrationTaskRequest;
  assert.equal(task.track.title, '晴天');
  assert.equal(task.track.artist, '周杰伦');
  assert.equal(task.previousTrack.title, '花海');
  assert.equal(task.situation.occasion, 'chosen_for_request');
  assert.equal('plan' in task, false, '锁定任务里没有随机计划');
  assert.equal(task.minChars, 20);
  assert.equal(task.isCurrent, undefined, 'isCurrent 守卫不进冻结任务素材');
  assert.deepEqual(events[0], { kind: 'enter', context: { sessionId: 'room', requestId: 'corr-1', roundId: 'corr-1' } });
  assert.equal(events[1]?.kind, 'run', 'run 必须在 sessionTrace 上下文内执行');
  assert.equal(result.narrationSource, 'fallback');
  assert.equal(result.text, canonicalFallback);
});

test('an accepted submission is returned as the narration with source agent', async () => {
  const harness = createHarness({ driver: (input, tools) => briefThenSubmit(input, tools, () => richNarration) });
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.text, richNarration);
  assert.equal(result.narrationSource, 'agent');
  assert.equal(result.narrationRejection, null);
  assert.equal(result.narrationFinishReason, 'tool_calls');
  assert.equal(result.ttsUrl, '/tts.mp3');
  assert.equal(result.contentHash, 'hash-1');
  assert.equal(result.voiceProfileId, 'voice-a');
  assert.equal(result.previousSongId, null);
  assert.deepEqual(result.narrationDimensions, ['chosen_for_request'], '诊断字段记录场合');
  assert.equal(result.narrationBrief, false);
  assert.deepEqual(harness.spoken.map(item => item.voiceProfileId), ['voice-a']);
  assert.deepEqual(harness.spoken.map(item => item.text), [richNarration]);
});

test('the task prompt already carries the brief so the model can submit in the first round', async () => {
  let inlined = null;
  const harness = createHarness({ driver: async (input, tools) => {
    const marker = '本次素材与写作要求（JSON）：';
    const at = input.systemPrompt.indexOf(marker);
    assert.ok(at >= 0, '素材内联在任务提示词里');
    inlined = JSON.parse(input.systemPrompt.slice(at + marker.length).split('\n')[0]);
    return submitOnly([richNarration])(input, tools);
  } });
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.narrationSource, 'agent');
  assert.deepEqual(harness.journal.map(entry => entry.name), ['submit_track_narration'], '首轮直接提交，不必先读素材');
  const [run] = harness.runs;
  assert.deepEqual(run.toolNames, ['get_track_narration_brief', 'submit_track_narration'], '读素材工具仍可用');
  const viaTool = await harness.toolRegistry.execute('get_track_narration_brief', {}, { ...run.toolContext, capabilities: run.capabilities });
  assert.deepEqual(inlined, viaTool.facts, '内联素材与读工具返回一致');
  assert.equal(run.profileOverrides.maxRounds, 3, '被拒后仍保留纠正机会');
});

test('a rejected narration names the violated rule and the model retries once with corrected text', async () => {
  const harness = createHarness({ driver: submitOnly([missingArtist, richNarration]) });
  const result = await harness.agent.prepareTrack(effect());
  const [first, second] = harness.journal.map(entry => entry.outcome);
  assert.equal(first.ok, false);
  assert.equal(first.code, 'NARRATION_REJECTED');
  assert.equal(first.facts.rejectedRule, 'missing-artist');
  assert.match(first.modelContext, /missing-artist/);
  assert.equal(first.presentation.retryable, true);
  assert.equal(second.ok, true);
  assert.equal(second.terminal, true);
  assert.equal(result.text, richNarration);
  assert.equal(result.narrationSource, 'agent');
  assert.equal(result.narrationRejection, null);
});

test('a task that never passes verification falls back to the deterministic sentence with diagnostics', async () => {
  const harness = createHarness({ driver: (input, tools) => briefThenSubmit(input, tools, () => '接下来是周杰伦的《晴天》。') });
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.text, canonicalFallback);
  assert.equal(result.narrationSource, 'fallback');
  assert.equal(result.narrationRejection, 'too-short');
  assert.equal(result.narrationFinishReason, 'AGENT_ROUND_LIMIT');
  assert.equal(result.ttsUrl, '/tts.mp3');
  assert.equal((result.text.match(/。/gu) || []).length, 1, '兜底永远只有一句可核实事实');
});

test('a generation budget timeout falls back without stalling playback and aborts the loop', async () => {
  const harness = createHarness({ driver: () => new Promise(() => {}), generationBudgetMs: 30, timeoutMs: 400, synthesisBudgetMs: 40 });
  const started = Date.now();
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.narrationSource, 'fallback');
  assert.equal(result.text, canonicalFallback);
  assert.equal(result.narrationFinishReason, 'NARRATION_GENERATION_TIMEOUT');
  assert.ok(Date.now() - started < 500, `超时必须有界，实际 ${Date.now() - started}ms`);
  assert.equal(harness.runs[0].signal.aborted, true, '预算到期必须中止循环，不留下后台模型调用');
});

test('cancellation propagates as AbortError instead of returning a stale narration', async () => {
  const harness = createHarness({ driver: captureOnly });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(harness.agent.prepareTrack(effect(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(harness.runs.length, 0);
});

test('an abort during the loop never returns audio prepared after cancellation', async () => {
  const controller = new AbortController();
  const harness = createHarness({
    driver: async input => { controller.abort(); await Promise.resolve(); throw input.signal?.reason || new Error('cancelled'); },
    synthesize: async () => ({ url: '/late.mp3' }),
  });
  await assert.rejects(harness.agent.prepareTrack(effect(), { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(harness.spoken, []);
});

test('slow TTS has a bounded fallback inside the same deadline', async () => {
  let synthesisSignal = null;
  const harness = createHarness({
    driver: (input, tools) => briefThenSubmit(input, tools, () => richNarration),
    synthesize: (text, options) => { synthesisSignal = options.signal; return new Promise(() => {}); },
    timeoutMs: 400, synthesisBudgetMs: 20,
  });
  const started = Date.now();
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.ttsUrl, null);
  assert.equal(result.text, richNarration, '超时也必须保留已接受正文');
  assert.equal(result.narrationSynthesisReason, 'timeout', '封闭合成原因');
  assert.ok(result.narrationSynthesisElapsedMs >= 0 && result.narrationSynthesisElapsedMs < 400);
  assert.equal(synthesisSignal?.aborted, true, '预算到期必须中止合成，而不是只放弃等待');
  assert.ok(Date.now() - started < 500);
});

test('synthesizer throwing degrades to ttsUrl null instead of rejecting', async () => {
  const harness = createHarness({
    driver: (input, tools) => briefThenSubmit(input, tools, () => richNarration),
    synthesize: async () => { const error = new Error('all tts providers failed'); error.code = 'TTS_ALL_PROVIDERS_FAILED'; throw error; },
    timeoutMs: 50, synthesisBudgetMs: 20,
  });
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.ttsUrl, null, '全 provider 失败必须降级为无音频，而不是让运行时崩溃');
  assert.equal(result.contentHash, null);
  assert.equal(result.text, richNarration);
  assert.equal(result.narrationSynthesisReason, 'failed', '失败原因是封闭枚举');
  assert.doesNotMatch(JSON.stringify(result), /all tts providers failed|TTS_ALL_PROVIDERS_FAILED/u,
    '原始错误不得进入结果或诊断');
});

test('an unwired synthesizer reports a closed not-configured reason and keeps the text', async () => {
  const harness = createHarness({
    driver: (input, tools) => briefThenSubmit(input, tools, () => richNarration),
    synthesize: null,
  });
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.ttsUrl, null);
  assert.equal(result.text, richNarration);
  assert.equal(result.narrationSynthesisReason, 'not-configured');
});

test('an external abort during synthesis returns promptly and aborts the child synthesis', async () => {
  const controller = new AbortController();
  let synthesisSignal = null;
  const harness = createHarness({
    driver: (input, tools) => briefThenSubmit(input, tools, () => richNarration),
    synthesize: (text, options) => { synthesisSignal = options.signal; return new Promise(() => {}); },
    timeoutMs: 8_000, synthesisBudgetMs: 8_000,
  });
  const pending = harness.agent.prepareTrack(effect(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  for (let i = 0; i < 200 && !synthesisSignal; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(synthesisSignal, '合成已经开始');
  const abortedAt = Date.now();
  controller.abort();
  await rejected;
  assert.ok(Date.now() - abortedAt < 1_000, '外部取消必须尽快返回');
  assert.equal(synthesisSignal.aborted, true, '外部取消必须中止合成');
});

test('a prepared narration with valid stored text reuses it for asset-only synthesis', async () => {
  let modelCalls = 0;
  const synthesized = [];
  const storedText = '接下来是周杰伦的《晴天》。这首作品收录在《叶惠美》里，可以安静听下去。';
  const storedSpoken = `{叹气}接下来是周杰伦的《晴天》。这首作品收录在《叶惠美》里，可以安静听下去。`;
  const harness = createHarness({
    driver: async () => { modelCalls += 1; throw roundLimitError(); },
    getContext: () => ({ person: { voiceProfileId: 'voice-a' }, recentConversation: [] }),
    synthesize: async (text, options) => { synthesized.push({ text, options }); return { url: '/reuse.mp3', hash: 'reuse-hash' }; },
  });
  const track = { title: '晴天', artist: '周杰伦', songId: 'song-1', queueItemId: 'q-1',
    narration: { status: 'ready', assetStatus: 'failed', generationRevision: 3,
      text: storedText, spokenText: storedSpoken, performance: { emotion: 'sad' },
      voiceProfileId: 'voice-a', previousSongId: 'prev-1' } };
  const result = await harness.agent.prepareTrack({ track, listeningSessionId: 'room', queueItemId: 'q-1',
    generationRevision: 3, previousTrack: { songId: 'prev-1', title: '花海' } });
  assert.equal(modelCalls, 0, '复用正文时不再调用模型');
  assert.deepEqual(harness.runs, []);
  assert.equal(result.narrationSource, 'stored-text-reuse');
  assert.equal(result.text, storedText);
  assert.equal(result.spokenText, storedSpoken);
  assert.deepEqual(result.performance, { emotion: 'sad' });
  assert.equal(result.previousSongId, 'prev-1');
  assert.equal(result.ttsUrl, '/reuse.mp3');
  assert.equal(result.narrationSynthesisReason, null);
  assert.equal(synthesized.length, 1);
  assert.equal(synthesized[0].text, storedSpoken, '按原表演重合成');
  assert.deepEqual(synthesized[0].options.performance, { emotion: 'sad' });
  assert.equal(synthesized[0].options.voiceProfileId, 'voice-a');
});

test('persona and companion-mode guidance reach the restricted loop and the brief', async () => {
  const harness = createHarness({
    getContext: async () => ({ person: { displayName: 'Lunara', voiceProfileId: 'voice-1', personaDocument: 'persona-document-line' },
      companionMode: { modeId: 'occasional', label: '偶尔介绍' }, recentConversation: [] }),
    driver: (input, tools) => briefThenSubmit(input, tools, () => '这首《Mode Song》来自 Mode Artist，节奏轻，适合现在听。'),
  });
  const track = { title: 'Mode Song', artist: 'Mode Artist', songId: 'm1', queueItemId: 'q-m1',
    narration: { status: 'preparing', generationRevision: 1, context: { origin: 'live' } } };
  const result = await harness.agent.prepareTrack({ track, listeningSessionId: 'conversation:x', queueItemId: 'q-m1' });
  assert.match(harness.runs[0].systemPrompt, /persona-document-line/u);
  assert.match(harness.runs[0].systemPrompt, /Lunara/u);
  assert.match(harness.briefs[0].modeGuide, /偶尔介绍/u);
  assert.deepEqual(harness.briefs[0].lengthTarget, { minChars: 12, maxChars: 100, minSentences: 1, maxSentences: 2 });
  assert.equal(result.narrationSource, 'agent', 'occasional 的短串词不被字数下限误杀');
  assert.equal(result.text, '这首《Mode Song》来自 Mode Artist，节奏轻，适合现在听。');
  assert.equal(result.ttsUrl, '/tts.mp3');
});

test('prepared and live tracks both get fresh narration with the actual predecessor and owner voice', async () => {
  const harness = createHarness({ driver: (input, tools) => briefThenSubmit(input, tools, () => richNarration) });
  for (const origin of ['prepared', 'live']) await harness.agent.prepareTrack(effect(origin));
  // prepared 与 live 是同一个场合：提前选好不改变“为什么是这首”。
  assert.deepEqual(harness.briefs.map(item => item.situation.occasion), ['chosen_for_request', 'chosen_for_request']);
  assert.equal(harness.briefs[0].previousTrack.title, '花海');
  assert.deepEqual(harness.briefs[0].knowledge.catalog, { album: '叶惠美', year: 2003 });
  assert.equal(harness.briefs[0].knowledge.soundTags.mood, '怀旧');
  assert.deepEqual(harness.spoken.map(item => item.voiceProfileId), ['voice-a', 'voice-a']);
  assert.deepEqual(harness.spoken.map(item => item.text), [richNarration, richNarration]);
});

test('prepared narration reports the predecessor it was written for', async () => {
  const harness = createHarness({ driver: (input, tools) => briefThenSubmit(input, tools, () => richNarration) });
  const result = await harness.agent.prepareTrack({ ...effect(),
    previousTrack: { title: '花海', artist: '周杰伦', songId: 'song-prev' } });
  assert.equal(result.previousSongId, 'song-prev');
});

test('the brief carries recent introductions; repeated boilerplate is rejected', async () => {
  const repeated = '接下来是周杰伦的《晴天》。这首作品收录在《叶惠美》中。听的时候可以留意旋律、人声和节奏怎样一起展开，看看哪一处最贴近你现在的状态。把它放在这里，是想顺着你刚才想听的方向。';
  const recent = '接下来是林海的《月光边境》。这首作品收录在《月光边境》中。听的时候可以留意旋律、人声和节奏怎样一起展开，看看哪一处最贴近你现在的状态。把它放在这里，是想顺着你刚才想听的方向。';
  const harness = createHarness({
    getContext: () => ({ trackFacts, recentConversation: [
      { role: 'assistant', presentation: 'track_intro', text: recent },
      { role: 'user', presentation: null, text: '想听熟悉的华语旋律' },
    ] }),
    driver: (input, tools) => briefThenSubmit(input, tools, () => repeated),
  });
  const result = await harness.agent.prepareTrack(effect());
  assert.deepEqual(harness.briefs[0].recentIntroductions, [recent]);
  assert.equal(result.narrationRejection, 'repeated-boilerplate');
  assert.equal(result.narrationSource, 'fallback');
  assert.notEqual(result.text, repeated);
  assert.doesNotMatch(result.text, /听的时候可以留意旋律、人声和节奏|看看哪一处最贴近你现在的状态/u);
});

test('a narration that repeats the listener verbatim is rejected before it can reach the air', async () => {
  const quoted = '接下来是周杰伦的《晴天》。怎么连续放了两次 best part 的这种情况不会再出现。这一次先安静听他的咬字和气声处理。中段弦乐进来时可以留意编曲层次。我们把这一首完整听完。';
  const harness = createHarness({
    getContext: () => ({ trackFacts, recentConversation: [
      { role: 'user', presentation: null, text: '怎么连续放了两次 best part，上一批里面已经有了' },
    ] }),
    driver: submitOnly([quoted]),
  });
  const result = await harness.agent.prepareTrack(effect());
  assert.equal(result.narrationRejection, 'echoes-listener');
  assert.equal(result.text, canonicalFallback);
  assert.doesNotMatch(result.text, /best part|连续放了两次/u);
  assert.ok(harness.spoken.every(item => !item.text.includes('best part')));
});

test('a taste probe reaches the brief and the writing guide, and stays absent without one', async () => {
  const base = { title: '对爱渴望', artist: '杨宗纬', album: '鸽子',
    intro: { context: { origin: 'prepared', reason: 'auto_continue', mode: 'discovery', softPreferences: '' } } };
  const probeNarration = '杨宗纬的《对爱渴望》，收在专辑《鸽子》里，他把想要压在句尾，不摊开给你看。这次想试试你对这类歌的感觉，不用急着回答，听完再聊也好。情绪都收在旋律里，让它自己走一会儿。';
  const withProbe = createHarness({
    getContext: () => ({ trackFacts: { song: { year: null }, artist: {} }, tasteProbe: { claimKey: 'music.genre.rnb', topic: 'rnb' } }),
    driver: (input, tools) => briefThenSubmit(input, tools, () => probeNarration),
  });
  const result = await withProbe.agent.prepareTrack({ track: base, previousTrack: null });
  assert.equal(withProbe.briefs[0].situation.occasion, 'probe');
  assert.equal(withProbe.briefs[0].situation.probe, 'rnb');
  assert.ok(withProbe.briefs[0].writingGuide.some(line => line.includes('试听')));
  assert.equal(result.narrationSource, 'agent', '合规的披露句不触发串词拒绝');

  const plain = createHarness({
    getContext: () => ({ trackFacts: { song: { year: null }, artist: {} } }),
    driver: (input, tools) => briefThenSubmit(input, tools, () => probeNarration),
  });
  const plainResult = await plain.agent.prepareTrack({ track: base, previousTrack: null });
  assert.equal(plain.briefs[0].situation.probe, null, '无 probe 时字段为空');
  assert.equal(plainResult.narrationSource, 'agent');
});

test('the runner registers both narration tools once on the shared registry', () => {
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  createNarrationAgent({ agentLoop: { run: async () => ({}) }, toolRegistry });
  createNarrationAgent({ agentLoop: { run: async () => ({}) }, toolRegistry });
  const names = toolRegistry.definitions({ capabilities: ['narration'] }).map(definition => definition.function.name);
  assert.deepEqual(names, ['get_track_narration_brief', 'submit_track_narration']);
});

test('the runner refuses to be built without agentLoop.run or a registry', () => {
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  assert.throws(() => createNarrationAgent({ toolRegistry }), /requires agentLoop\.run/u);
  assert.throws(() => createNarrationAgent({ agentLoop: { run: async () => ({}) } }), /requires toolRegistry/u);
});
