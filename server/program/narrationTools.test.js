// narrationTools：串词任务两个 typed 工具的机械校验。
//
// submit_track_narration 复用 ProgramNarrationComposer 的既有校验（narrationDefect）：
// 身份出现、长度/句数边界、unsupported fact、前曲承接、结构重复、听众回声、重复聊天
// 已介绍的专辑。每种缺陷都必须变成可纠正的 typed 失败（facts.rejectedRule +
// modelContext 点名规则），且永远不改变播放或其他状态。
//
// Run: node --test server/program/narrationTools.test.js

import assert from 'node:assert/strict';
import test from 'node:test';

import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { createNarrationAgent } from './NarrationAgent.js';
import { NARRATION_BRIEF_TOOL_NAME, NARRATION_SUBMIT_TOOL_NAME } from './narrationTools.js';

const trackFacts = {
  song: { year: 2003, genre: '流行', mood: '怀旧', tempo: 'mid', themes: ['青春', '错过'], instruments: ['吉他'] },
  artist: { genre: '华语流行', region: '华语' },
};

const effect = () => ({
  track: { title: '晴天', artist: '周杰伦', voiceProfileId: 'voice-a', album: '叶惠美',
    intro: { context: { origin: 'prepared', reason: 'user_request', mode: 'discovery', softPreferences: '熟悉的华语旋律' } } },
  previousTrack: { title: '花海', artist: '周杰伦' },
  listeningSessionId: 'room', queueItemId: 'q-1', generationRevision: 1, correlationId: 'corr-1',
});

const validNarration = '接下来听周杰伦的《晴天》。它收录在《叶惠美》里，曲库记录的发行年份是2003年。曲库标签把它归为流行与怀旧，节奏感偏中速，适合把注意力慢慢放回旋律。你刚才想沿着熟悉的华语旋律继续走，所以我把这一首放在这里。';

/** 用真实运行器捕获锁定任务（捕获驱动不提交），再直接执行两个工具。 */
async function captureTask({ effect: effectOption = null, context = () => ({ trackFacts }) } = {}) {
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const runs = [];
  const agent = createNarrationAgent({
    agentLoop: { run: async runInput => { runs.push(runInput);
      throw Object.assign(new Error('virtual person turn reached round limit'), { code: 'AGENT_ROUND_LIMIT' }); } },
    toolRegistry, getContext: context, synthesize: null,
  });
  const input = typeof effectOption === 'function' ? effectOption() : effectOption || effect();
  const result = await agent.prepareTrack(input);
  return { task: runs[0].toolContext.narrationTaskRequest, result, toolRegistry, runs };
}

const execute = (toolRegistry, name, args, task, extra = {}) => toolRegistry.execute(name, args, {
  capabilities: ['narration'], narrationTaskRequest: task, finishReason: 'tool_calls',
  correlationId: 'test-request', ...extra,
});
const submit = (toolRegistry, task, text, extra = {}) => execute(toolRegistry, NARRATION_SUBMIT_TOOL_NAME, { text }, task, extra);
const readBrief = (toolRegistry, task) => execute(toolRegistry, NARRATION_BRIEF_TOOL_NAME, {}, task);

test('both narration tools are registered with strict schemas and a terminal submit', async () => {
  const { toolRegistry, task } = await captureTask();
  const definitions = toolRegistry.definitions({ capabilities: ['narration'] });
  assert.deepEqual(definitions.map(definition => definition.function.name),
    [NARRATION_BRIEF_TOOL_NAME, NARRATION_SUBMIT_TOOL_NAME]);
  const [briefDefinition, submitDefinition] = definitions.map(definition => definition.function);
  assert.equal(briefDefinition.parameters.additionalProperties, false);
  assert.deepEqual(briefDefinition.parameters.properties, {});
  assert.deepEqual(submitDefinition.parameters.required, ['text']);
  assert.equal(submitDefinition.parameters.additionalProperties, false);
  assert.equal(submitDefinition.parameters.properties.text.type, 'string');

  const accepted = await submit(toolRegistry, task, validNarration);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.code, 'TRACK_NARRATION_ACCEPTED');
  assert.equal(accepted.terminal, true, '接受即终止本轮任务');
  assert.equal(accepted.facts.text, validNarration);
  assert.equal(accepted.facts.accepted, true);
  assert.ok(accepted.presentation.displayText.length > 0, 'terminal 必须有非空表现，避免 EMPTY_TOOL_PRESENTATION');
  const briefOutcome = await readBrief(toolRegistry, task);
  assert.equal(briefOutcome.terminal, false, 'brief 只读，不终止循环');
});

test('the brief tool returns deterministic material without a model call', async () => {
  const { toolRegistry, task } = await captureTask();
  const first = await readBrief(toolRegistry, task);
  const second = await readBrief(toolRegistry, task);
  assert.equal(first.ok, true);
  assert.equal(first.code, 'NARRATION_BRIEF');
  assert.deepEqual(first.facts, second.facts, '素材是纯函数装配，重复读取一致');
  assert.deepEqual(first.facts.track, { title: '晴天', artist: '周杰伦' });
  assert.equal(first.facts.situation.occasion, 'chosen_for_request');
  assert.equal(first.facts.situation.softPreference, '熟悉的华语旋律');
  // 已核实素材全部给出、按优先级排列，不再按随机维度裁剪。
  assert.deepEqual(first.facts.knowledge.catalog, { album: '叶惠美', year: 2003 });
  assert.equal(first.facts.knowledge.soundTags.mood, '怀旧');
  assert.equal(first.facts.knowledge.soundTags.artistRegion, '华语');
  assert.deepEqual(first.facts.lengthTarget, { minChars: 20, maxChars: 200, minSentences: 1, maxSentences: 4 });
  assert.ok(Array.isArray(first.facts.writingGuide));
  assert.ok(first.facts.acceptanceRules.some(rule => rule.includes('晴天') && rule.includes('周杰伦')));
  assert.match(first.facts.fallbackAvoidance, /兜底/u);
  assert.equal(first.facts.previousTrack.title, '花海');
  assert.equal(first.facts.chatAlreadyIntroducedCurrent, false);
});

test('a tool call without the locked task is a typed, non-retryable failure', async () => {
  const { toolRegistry } = await captureTask();
  const calls = [[NARRATION_BRIEF_TOOL_NAME, {}], [NARRATION_SUBMIT_TOOL_NAME, { text: '一段没有任务的正文。' }]];
  for (const [name, args] of calls) {
    const outcome = await toolRegistry.execute(name, args, { capabilities: ['narration'], correlationId: 'x' });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'NARRATION_TASK_UNAVAILABLE');
    assert.equal(outcome.presentation.retryable, false);
  }
});

test('core artist and title forms are accepted', async () => {
  const { toolRegistry, task } = await captureTask({
    effect: () => ({ track: { title: '如诗般 宁静 (钢琴版)', artist: '袁娅维TIA RAY',
      intro: { context: { origin: 'live', reason: 'user_request', mode: 'exact', softPreferences: '' } } } }),
    context: () => ({}),
  });
  const core = '接下来是袁娅维的《如诗般宁静》。这首作品的旋律线条很干净，人声也留了很多空间。我们可以先把注意力放在她的气声处理上。整首听完再判断它适不适合现在。';
  const outcome = await submit(toolRegistry, task, core);
  assert.equal(outcome.ok, true, outcome.modelContext);
  assert.equal(outcome.facts.text, core);
});

test('every defect becomes a correctable typed rejection that names the rule', async () => {
  const cases = [
    { text: '接下来是周杰伦的《晴天》。', rule: 'too-short' },
    { text: `${'周杰伦的《晴天》'}${'好听'.repeat(330)}。`, rule: 'too-long' },
    { text: '接下来是周杰伦的《晴天》。第一句补充听感。第二句补充听感。第三句补充听感。第四句补充听感。第五句补充听感。第六句补充听感。第七句补充听感。', rule: 'sentence-count' },
    { text: '接下来是周杰伦带来的一首歌。这段旋律很干净，人声靠前，气口也留得比较自然。他把每一个字都放在了该放的位置上，听起来不急也不拖。我们可以安静听完，再判断它适不适合现在的状态。', rule: 'missing-title' },
    { text: '接下来是《晴天》。这段旋律很干净，人声靠前，气口也留得比较自然。每一个字都放在了该放的位置上，听起来不急也不拖。我们可以安静听完，再判断它适不适合现在的状态。偶尔回头听这一段，会发现它一直没变。', rule: 'missing-artist' },
    { text: '接下来是周杰伦的《晴天》。这段旋律很干净，人声靠前，气口也留得比较自然。它是从缓存里命中之后直接准备的。我们可以安静听完，再判断它适不适合现在的状态。', rule: 'technical-or-claiming-search' },
    { text: '接下来是周杰伦的《晴天》。这首作品收录在《叶惠美》里。曲库记录的发行年份是2024年。现在一起把它完整听完，不用急着说什么，听完再聊。', rule: 'unsupported-fact' },
    { text: '接下来是周杰伦的《晴天》。它拿过很多奖项，也在各大榜单上待了很久。我们把注意力放回旋律本身，安静听完再聊别的，不用急着评价什么，慢慢来。', rule: 'unsupported-fact' },
    { text: '刚才那首《Absence of You》把话停在了缺席上，现在这首正好把镜头拉回来。周杰伦的《晴天》收在专辑《叶惠美》里，他唱这类歌有一种克制，想要却不把想要摊开给你看，情绪都压在句尾。让它自己沉一会儿。', rule: 'wrong-predecessor-reference' },
    { text: '接下来是周杰伦的《晴天》。这首作品收录在《叶惠美》中。听的时候可以留意旋律、人声和节奏怎样一起展开，看看哪一处最贴近你现在的状态。把它放在这里，是想顺着你刚才想听的方向。', rule: 'repeated-boilerplate' },
  ];
  const { toolRegistry, task } = await captureTask();
  for (const { text, rule } of cases) {
    const outcome = await submit(toolRegistry, task, text);
    assert.equal(outcome.ok, false, `应被拒绝（期望 ${rule}）`);
    assert.equal(outcome.code, 'NARRATION_REJECTED');
    assert.equal(outcome.facts.rejectedRule, rule);
    assert.match(outcome.modelContext, new RegExp(rule, 'u'), 'modelContext 必须点名违反的规则');
    assert.equal(outcome.presentation.retryable, true, '拒绝必须可纠正');
    assert.equal(outcome.terminal, false, '被拒绝的正文绝不能变成 terminal');
  }
});

test('a narration that repeats the listener verbatim is rejected with echoes-listener', async () => {
  const { toolRegistry, task } = await captureTask({
    context: () => ({ trackFacts, recentConversation: [
      { role: 'user', presentation: null, text: '怎么连续放了两次 best part，上一批里面已经有了' },
    ] }),
  });
  const quoted = '接下来是周杰伦的《晴天》。怎么连续放了两次 best part 的这种情况不会再出现。这一次先安静听他的咬字和气声处理。中段弦乐进来时可以留意编曲层次。我们把这一首完整听完。';
  const outcome = await submit(toolRegistry, task, quoted);
  assert.equal(outcome.facts.rejectedRule, 'echoes-listener');
  assert.match(outcome.modelContext, /echoes-listener/u);
});

test('verified catalog facts are accepted while absent facts are never invented', async () => {
  const { toolRegistry, task } = await captureTask();
  assert.equal((await submit(toolRegistry, task, validNarration)).ok, true);

  const sparse = await captureTask({
    effect: () => ({ track: { title: '晴天', artist: '周杰伦', album: '',
      intro: { context: { origin: 'prepared', reason: 'user_request', mode: 'exact', softPreferences: '' } } } }),
    context: () => ({}),
  });
  const inventedYear = await submit(sparse.toolRegistry, sparse.task,
    '接下来是周杰伦的《晴天》。它发行于2003年，那一年很多人第一次听到它。这段旋律很适合现在的状态，我们一起安静听完，再聊聊它带给你的感觉。');
  assert.equal(inventedYear.facts.rejectedRule, 'unsupported-fact', '没有曲库事实时年份不能被常识补全');
  assert.equal(sparse.result.text, '接下来是周杰伦的《晴天》。', '缺失素材时兜底就是一句可核实事实');
});

test('album attribution must match the verified album in every common wording', async () => {
  const baseEffect = () => ({ track: { title: '对爱渴望', artist: '杨宗纬', album: '鸽子',
      intro: { context: { origin: 'live', reason: 'user_request', mode: 'exact', softPreferences: '' } } },
    previousTrack: null, listeningSessionId: 'room', queueItemId: 'q-2', generationRevision: 1 });
  const context = () => ({ trackFacts: { song: { year: null }, artist: {} } });
  const sentence = album => `接下来是杨宗纬的《对爱渴望》。这首歌收在专辑《${album}》里，他把想要压在句尾，不摊开给你看。情绪不往外溢，越稳越能听出底下咽着的那口气。让它自己走。`;
  const accepted = await captureTask({ effect: baseEffect, context });
  assert.equal((await submit(accepted.toolRegistry, accepted.task, sentence('鸽子'))).ok, true);
  const rejected = await captureTask({ effect: baseEffect, context });
  const wrong = await submit(rejected.toolRegistry, rejected.task, sentence('错专辑'));
  assert.equal(wrong.facts.rejectedRule, 'unsupported-fact');
  // 修辞性“收在皮肤底下”不是专辑归属主张，不应被误拒。
  const metaphor = '接下来是杨宗纬的《对爱渴望》。他把想要压在句尾，情绪收在皮肤底下不往外溢，越稳越能听出底下咽着的那口气。让它自己走，听完大概会安静一会儿。';
  const gentle = await captureTask({ effect: baseEffect, context });
  assert.equal((await submit(gentle.toolRegistry, gentle.task, metaphor)).ok, true);
});

test('a narration that repeats the album the chat just introduced is rejected; a fresh chat is not', async () => {
  const baseEffect = () => ({ track: { title: '鱼', artist: '陈绮贞', album: '太阳',
      intro: { context: { origin: 'prepared', reason: 'user_request', mode: 'constrained', softPreferences: '没睡实，轻缓' } } },
    previousTrack: null, listeningSessionId: 'room', queueItemId: 'q-3', generationRevision: 1 });
  const repeated = '《鱼》。陈绮贞的声音像没关严的窗，风自己在屋里转了一圈。这首收在《太阳》里，编曲留得很空，鼓点几乎不推着人走。没睡实的一上午配这样的歌正合适，让它当个底就好。';
  const introduced = await captureTask({
    effect: baseEffect,
    context: () => ({ trackFacts: { song: { year: 2009 }, artist: {} },
      recentConversation: [{ role: 'assistant', presentation: null, text: '先是陈绮贞的《鱼》，收在《太阳》里——钢琴起得很低，整首没什么起伏。' }] }),
  });
  const rejected = await submit(introduced.toolRegistry, introduced.task, repeated);
  assert.equal(rejected.facts.rejectedRule, 'repeats-chat-introduction');
  const fresh = await captureTask({
    effect: baseEffect,
    context: () => ({ trackFacts: { song: { year: 2009 }, artist: {} },
      recentConversation: [{ role: 'assistant', presentation: null, text: '把那首《The Show》先撤下来了，接下来换成安静的一组。' }] }),
  });
  assert.equal((await submit(fresh.toolRegistry, fresh.task, repeated)).ok, true);
});

test('cross-song associations without immediacy framing are accepted', async () => {
  const { toolRegistry, task } = await captureTask({
    effect: () => ({ track: { title: '对爱渴望', artist: '杨宗纬', album: '鸽子',
        intro: { context: { origin: 'prepared', reason: 'auto_continue', mode: 'discovery', softPreferences: '' } } },
      previousTrack: { title: '传闻', artist: '周柏豪', songId: 'chuanchuan' },
      listeningSessionId: 'room', queueItemId: 'q-4', generationRevision: 1 }),
    context: () => ({ trackFacts: { song: { year: null }, artist: {} } }),
  });
  const callback = '还记得今天开场陈僖仪那首《蜚蜚》悬在半空的不甘吗？绕了一圈，杨宗纬的《对爱渴望》收在专辑《鸽子》里，把想要压在句尾。中间那些歌像《The Loneliness》一样往外放，这一首却往回收。让它自己沉一会儿。';
  assert.equal((await submit(toolRegistry, task, callback)).ok, true);
});

test('a truncated model response can never be accepted as a complete narration', async () => {
  const { toolRegistry, task } = await captureTask();
  const outcome = await submit(toolRegistry, task, validNarration, { finishReason: 'length' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'NARRATION_TRUNCATED');
  assert.equal(outcome.presentation.retryable, true);
});

test('a stale task cannot be accepted through the tools', async () => {
  const { toolRegistry, task } = await captureTask();
  const stale = await submit(toolRegistry, task, validNarration, { isCurrent: () => false });
  assert.equal(stale.ok, false);
  assert.notEqual(stale.code, 'TRACK_NARRATION_ACCEPTED', '取消/切换后不得接受正文');
  assert.deepEqual(stale.facts, {});
});

test('rejection feedback is bounded and keeps the rule machine-readable for a retry', async () => {
  const { toolRegistry, task } = await captureTask();
  const outcome = await submit(toolRegistry, task, '周杰伦的《晴天》。');
  assert.match(outcome.modelContext, /违反校验规则「too-short」/u);
  assert.match(outcome.modelContext, /至少需要 20 个字符/u);
  assert.match(outcome.modelContext, /submit_track_narration/u, '提示模型重试入口');
  assert.equal(outcome.facts.rejectedRule, 'too-short');
});

const recommendationContext = (publicNote = '我想推《晴天》，前奏一出来就很夏天。') => () => ({
  trackFacts, person: { id: 'lunara', displayName: 'Lunara' },
  memberNames: ['Lunara', '小满', '阿澈'],
  recommendation: { personId: 'xiaoman', displayName: '小满', publicNote },
});
const attributed = '这一首是小满刚才推荐的，周杰伦的《晴天》，收在《叶惠美》里。她说前奏一出来就很夏天，我也想听听看。曲库把它归为流行与怀旧，节奏偏中速。就让它先自己响一会儿。';

test('推荐人的歌：串词素材把推荐作为事实交给模型，不给示范句', async () => {
  const { toolRegistry, task, runs } = await captureTask({ context: recommendationContext() });
  const brief = await readBrief(toolRegistry, task);
  assert.deepEqual(brief.facts.recommendation, { recommender: '小满', publicNote: '我想推《晴天》，前奏一出来就很夏天。' });
  assert.ok(brief.facts.writingGuide.some(line => line.includes('recommendation') && line.includes('publicNote')));
  assert.ok(brief.facts.acceptanceRules.some(line => line.includes('小满')));
  assert.match(runs[0].systemPrompt, /小满/u);
  assert.ok((await submit(toolRegistry, task, attributed)).ok, '用自己的话交代来源即可通过');
});

test('推荐人的歌：漏掉推荐人、自称挑的、归错推荐人都会被可纠正地拒绝', async () => {
  const { toolRegistry, task } = await captureTask({ context: recommendationContext() });
  const cases = [
    { text: '接下来是周杰伦的《晴天》，收在《叶惠美》里。前奏一出来就很夏天。曲库把它归为流行与怀旧，节奏偏中速。就让它先自己响一会儿。', rule: 'missing-recommender' },
    { text: '这首是我挑的，周杰伦的《晴天》，收在《叶惠美》里。小满刚才也提到过它。曲库把它归为流行与怀旧，节奏偏中速。就让它先自己响一会儿。', rule: 'self-claims-recommendation' },
    { text: '这一首是阿澈推荐的，周杰伦的《晴天》，收在《叶惠美》里。小满刚才也在。曲库把它归为流行与怀旧，节奏偏中速。就让它先自己响一会儿。', rule: 'wrong-recommender' },
  ];
  for (const { text, rule } of cases) {
    const outcome = await submit(toolRegistry, task, text);
    assert.equal(outcome.facts?.rejectedRule, rule, text);
    assert.match(outcome.modelContext, new RegExp(rule, 'u'));
    assert.match(outcome.modelContext, /小满/u);
    assert.doesNotMatch(outcome.modelContext, /例如|比如|可以说/u, '纠正提示不提供示范句');
  }
});

test('没有推荐人时不检查归属；降级串词不加归属套句，并记录被拒规则', async () => {
  const plain = await captureTask();
  assert.equal((await readBrief(plain.toolRegistry, plain.task)).facts.recommendation, null);
  assert.ok((await submit(plain.toolRegistry, plain.task, validNarration)).ok);
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  const agent = createNarrationAgent({
    agentLoop: { run: async ({ toolContext, onMessage }) => {
      const outcome = await toolRegistry.execute(NARRATION_SUBMIT_TOOL_NAME,
        { text: '接下来是周杰伦的《晴天》，收在《叶惠美》里。前奏一出来就很夏天。曲库把它归为流行与怀旧，节奏偏中速。就让它先自己响一会儿。' },
        { capabilities: ['narration'], narrationTaskRequest: toolContext.narrationTaskRequest, finishReason: 'tool_calls' });
      onMessage({ kind: 'assistant_tool_calls', message: { tool_calls: [{ id: 'c1', function: { name: NARRATION_SUBMIT_TOOL_NAME } }] } });
      onMessage({ kind: 'tool_result', message: { tool_call_id: 'c1' }, outcome });
      return { messages: [], finishReason: 'stop' };
    } },
    toolRegistry, getContext: recommendationContext(), synthesize: null,
  });
  const result = await agent.prepareTrack(effect());
  assert.equal(result.narrationSource, 'fallback');
  assert.equal(result.narrationRejection, 'missing-recommender');
  assert.doesNotMatch(result.text, /小满|推荐/u);
});
