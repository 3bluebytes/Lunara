// musicTools：开放式选歌的两步工具契约（select_music 给候选 → commit_music_selection 提交）。
//
// Run: node --test server/virtual-person/musicTools.selection.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { registerMusicTools } from './musicTools.js';
import { AgentLoop } from './AgentLoop.js';
import { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } from '../program/musicSelectionRequest.js';

const context = { capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY], sessionId: 'conversation:a',
  requestId: 'request-1', userText: '来点轻快的', isCurrent: () => true, correlationId: 'request-1' };

function registryFor(service) {
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => service);
  return registry;
}

const offerResult = () => ({
  ok: true, code: 'MUSIC_CANDIDATES_OFFERED', offerId: 'offer:abc',
  request: { mode: 'discovery', delivery: 'replace_now', count: 2 },
  offer: { offerId: 'offer:abc', candidates: [
    { index: 1, source: 'qq', songId: 's1', title: '歌一', artist: '歌手一', album: '录音室', duration: 180 },
    { index: 2, source: 'qq', songId: 's2', title: '歌二', artist: '歌手二', album: '录音室', duration: 200 },
  ] },
  // 内部候选对象（含 orderedTarget）绝不能出现在模型可见 facts 里。
  candidates: [{ candidateId: 'c1', query: '歌手一 — 歌一', orderedTarget: { songId: 's1', exact: true } }],
  fallbackCandidates: [],
});

test('select_music hands a bounded numbered offer to the model instead of committing', async () => {
  let executed = null;
  const registry = registryFor({ execute: async (args, toolContext) => { executed = { args, toolContext }; return offerResult(); } });
  const outcome = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' }, context);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.notEqual(outcome.terminal, true, '候选不是终止性结果：模型还要选序号并提交');
  assert.equal(outcome.presentation.displayText, '', '候选阶段不产生用户可见回复');
  assert.equal(outcome.facts.offerId, 'offer:abc');
  assert.deepEqual(outcome.facts.candidates.map(candidate => [candidate.index, candidate.songId]), [[1, 's1'], [2, 's2']]);
  assert.equal(JSON.stringify(outcome.facts).includes('orderedTarget'), false, '内部候选对象不暴露给模型');
  assert.match(outcome.modelContext, /commit_music_selection/u);
  assert.match(outcome.modelContext, /候选只是候选，不代表已经播放/u);
  assert.match(outcome.modelContext, /recommend_only 提交后仍然不会播放/u);
  assert.equal(executed.args.mode, 'discovery');
});

test('select_music facts carry the brief once and per-candidate features with explicit null tags（3.5）', async () => {
  const brief = `选歌简报。优先级：本轮明确要求 > 显式反馈 > 口味画像 > 推断与近期观察。\n\n【口味画像】\n${'夜里偏爱慢歌。'.repeat(300)}`;
  const tags = { language: 'zh', genres: ['rnb', 'soul'], mood: 'calm', tempo: 'slow', energy: 0.3, year: 2019, hasVocal: true, themes: ['夜晚'] };
  const result = { ...offerResult(), brief, offer: { ...offerResult().offer,
    features: [{ tags, origin: 'liked', freshness: { lastPlayedDaysAgo: 3.5, plays14d: 1 }, tasteMatches: ['+music.genre.rnb'] },
      { tags: null, origin: 'discovery', freshness: { lastPlayedDaysAgo: null, plays14d: 0 }, tasteMatches: [], probe: true }] } };
  const registry = registryFor({ execute: async () => result });
  const outcome = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' }, context);
  assert.equal(outcome.facts.brief, brief, '简报不被 1200 字的通用上限截断');
  assert.deepEqual(outcome.facts.candidates[0].features.tags, tags, '标签结构保留到最内层');
  assert.equal(outcome.facts.candidates[1].features.tags, null);
  assert.equal(outcome.facts.candidates[1].features.probe, true);
  assert.equal(outcome.modelContext.split('夜里偏爱慢歌').length - 1, 0, '运行结果那一行不重复简报');
  assert.match(outcome.modelContext, /先读 facts\.brief/u);
  assert.match(outcome.modelContext, /未标注不等于不符合/u);
  assert.match(outcome.modelContext, /不放宽任何硬条件/u);
});

test('a 60-candidate offer reaches the model whole, features included（4.1）', async () => {
  const candidates = Array.from({ length: 60 }, (_, index) => ({ index: index + 1, source: 'qq', songId: `s${index + 1}`,
    title: `歌${index + 1}`, artist: `歌手${index + 1}`, album: '录音室', duration: 180 }));
  const features = candidates.map(() => ({ tags: null, origin: 'library', freshness: { lastPlayedDaysAgo: null, plays14d: 0 }, tasteMatches: [] }));
  const result = { ...offerResult(), offer: { offerId: 'offer:abc', candidates, features } };
  const registry = registryFor({ execute: async () => result });
  const outcome = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' }, context);
  assert.equal(outcome.facts.candidates.length, 60, '窗口上限内的候选一首不截');
  assert.equal(outcome.facts.candidates[59].index, 60);
  assert.equal(outcome.facts.candidates[59].features.origin, 'library');
});

test('select_music accepts an empty automated-task call and still reaches the service', async () => {
  let executed = null;
  const registry = registryFor({ execute: async args => { executed = args; return offerResult(); } });
  const outcome = await registry.execute('select_music', {},
    { capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY], sessionId: 'conversation:a', requestId: 'task-1', isCurrent: () => true });
  assert.equal(outcome.code, 'MUSIC_CANDIDATES_OFFERED', '自动任务里 select_music 可以传 {}');
  assert.deepEqual(executed, {});
});

test('commit_music_selection is a reviewed mutation tool and delegates the indexes', async () => {
  const seen = [];
  const registry = registryFor({
    execute: async () => offerResult(),
    commitSelection: async (args, toolContext) => {
      seen.push({ args, toolContext });
      return { ok: true, code: 'MUSIC_COMMITTED', terminal: true, delivery: 'replace_now', tracks: [{ songId: 's1' }],
        userMessage: '好，已经为这个聊天排好了。' };
    },
  });
  const outcome = await registry.execute('commit_music_selection', { offerId: 'offer:abc', indexes: [2] }, context);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.terminal, true, '播放提交是终止性动作');
  assert.equal(outcome.presentation.displayText, '好，已经为这个聊天排好了。');
  assert.equal(outcome.presentation.speak, false);
  assert.deepEqual(seen[0].args, { offerId: 'offer:abc', indexes: [2] });
  assert.equal(seen[0].toolContext.sessionId, 'conversation:a');
});

test('a committed selection lets the model line through only for the committed titles; a shortfall keeps the fixed copy', async () => {
  const commitWith = result => registryFor({ execute: async () => offerResult(), commitSelection: async () => result })
    .execute('commit_music_selection', { offerId: 'offer:abc', indexes: [1, 2] }, context);
  const full = await commitWith({ ok: true, code: 'MUSIC_COMMITTED', terminal: true, delivery: 'replace_now',
    tracks: [{ songId: 's1', title: '小小的太阳' }, { songId: 's2', title: '《特别的人》' }], requestedCount: 2, selectedCount: 2,
    userMessage: '好，《小小的太阳》和《特别的人》都安排上了。' });
  assert.deepEqual(full.presentation.modelLine, { allowedTitles: ['小小的太阳', '特别的人'] });
  const registry = registryFor({ execute: async () => offerResult() });
  const description = registry.definitions({ capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY] })
    .find(item => item.function.name === 'commit_music_selection').function.description;
  assert.match(description, /同一条消息/u, '提示模型在提交的同一条消息里写好要说的话');
  // select_music 的点播（exact）同样是终止性提交：说明也要写清同一条消息。
  const selectDescription = registry.definitions({ capabilities: [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY] })
    .find(item => item.function.name === 'select_music').function.description;
  assert.match(selectDescription, /同一条消息/u);
  const offered = await registry.execute('select_music', { mode: 'discovery' }, context);
  assert.match(offered.modelContext, /同一条消息/u);
  const short = await commitWith({ ok: true, code: 'MUSIC_COMMITTED', terminal: true, delivery: 'replace_now',
    tracks: [{ songId: 's1', title: '小小的太阳' }], requestedCount: 2, selectedCount: 1,
    userMessage: '好，这次只有 1 首可用，已经排好，不会用别的歌顶替。' });
  assert.equal(short.presentation.modelLine, undefined);
  // 群聊里收进来的别人推荐：歌名另列，校验时不许说成「我挑的」。
  const group = await commitWith({ ok: true, code: 'MUSIC_COMMITTED', terminal: true, delivery: 'replace_now',
    tracks: [{ songId: 's1', title: '春风吹' }, { songId: 's2', title: '三人游' }], requestedCount: 2, selectedCount: 2,
    recommendedTitles: ['《春风吹》'], userMessage: '好，小满推荐的《春风吹》和我挑的《三人游》都安排上了。' });
  assert.deepEqual(group.presentation.modelLine, { allowedTitles: ['春风吹', '三人游'], othersTitles: ['春风吹'] });
});

for (const [tool, args] of [
  ['select_music', { mode: 'exact', delivery: 'replace_now', targets: [{ title: '夜曲' }] }],
  ['commit_music_selection', { offerId: 'offer:abc', indexes: [1, 2] }],
]) {
  test(`${tool} keeps dialogue separate from the selection and the authoritative receipt`, async () => {
    const writes = [];
    const invoke = async received => {
      writes.push(received);
      return { ok: true, code: 'MUSIC_COMMITTED', terminal: true, requestedCount: 2, selectedCount: 1,
        tracks: [{ title: '夜曲' }], userMessage: '这次只安排了《夜曲》，没有用别的歌顶替。' };
    };
    const toolRegistry = registryFor({ execute: invoke, commitSelection: invoke });
    const dialogue = '我刚才不是在回避你。' + '只是想把话说清楚，不想随口让你觉得是你的错。'.repeat(12);
    const run = async text => {
      let calls = 0;
      const loop = new AgentLoop({ toolRegistry, chat: async () => {
        assert.equal(++calls, 1, '提交后不能再调用模型');
        return { message: { role: 'assistant', content: '另一首也响起来了。', tool_calls: [
          { id: 'one', function: { name: tool, arguments: JSON.stringify({ ...args, dialogue: text }) } },
        ] } };
      } });
      return loop.run({ systemPrompt: 'test', capabilities: context.capabilities, toolContext: context });
    };
    const receipt = '这次只安排了《夜曲》，没有用别的歌顶替。';
    assert.ok([...dialogue].length > 200);
    assert.equal((await run(dialogue)).finalText, dialogue + '\n\n' + receipt);
    assert.equal((await run('《另一首》已经在放了。')).finalText, receipt);
    assert.equal((await run('cookie: private-example')).finalText, receipt);
    assert.equal((await run('另一首已经加入队列。')).finalText, receipt);
    assert.deepEqual(writes, [args, args, args, args], '独立答话不是选歌参数，不改变提交');
  });
}

test('commit_music_selection propagates typed failures without leaking internal copy', async () => {
  const registry = registryFor({
    commitSelection: async () => ({ ok: false, code: 'SELECTION_OFFER_UNAVAILABLE',
      message: '这组候选来自另一轮请求，请在本轮重新调用 select_music。',
      userMessage: '之前那组候选已经不能用了，需要重新选一次。' }),
  });
  const outcome = await registry.execute('commit_music_selection', { offerId: 'offer:gone', indexes: [1] }, context);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'SELECTION_OFFER_UNAVAILABLE');
  assert.equal(outcome.presentation.displayText, '之前那组候选已经不能用了，需要重新选一次。');
  assert.match(outcome.modelContext, /另一轮请求/u);
});

test('commit_music_selection without commit authority is only a group non-owner recommendation; indexes are validated', async () => {
  const registry = registryFor({ commitSelection: async () => ({ ok: true, code: 'MUSIC_COMMITTED' }) });
  const denied = await registry.execute('commit_music_selection', { offerId: 'offer:abc', indexes: [1] },
    { ...context, capabilities: [MUSIC_CAPABILITY] });
  assert.equal(denied.code, 'MUSIC_OWNER_REQUIRED');
  const missing = await registry.execute('commit_music_selection', {}, context);
  assert.equal(missing.code, 'INVALID_TOOL_ARGUMENTS');
  const zero = await registry.execute('commit_music_selection', { offerId: 'offer:abc', indexes: [0] }, context);
  assert.equal(zero.code, 'INVALID_TOOL_ARGUMENTS');
  const tooMany = await registry.execute('commit_music_selection', { offerId: 'offer:abc',
    indexes: Array.from({ length: 11 }, (_, index) => index + 1) }, context);
  assert.equal(tooMany.code, 'INVALID_TOOL_ARGUMENTS');
});

test('an all-failed selection guides one correction with other indexes, not a verbatim repeat', async () => {
  const registry = registryFor({ commitSelection: async () => ({ ok: false, code: 'MUSIC_NOT_COMMITTED',
    offerId: 'offer:abc', resolvedIndexes: [],
    failedItems: [{ index: 2, provider: 'qq', songId: 's2', title: '歌二', artist: '歌手二', reason: 'resolution-failed' }],
    message: '这次没放成，队列没有变化。' }) });
  const outcome = await registry.execute('commit_music_selection', { offerId: 'offer:abc', indexes: [2] }, context);
  assert.equal(outcome.facts.offerId, 'offer:abc');
  assert.equal(outcome.facts.failedItems[0].index, 2);
  assert.match(outcome.modelContext, /failedItems/);
  assert.match(outcome.modelContext, /换别的序号/);
  assert.match(outcome.modelContext, /不要原样重复/);
  assert.match(outcome.modelContext, /交付方式.*硬约束/);
  assert.match(outcome.modelContext, /队列没有变化/);
  assert.notEqual(outcome.terminal, true);
});

test('失败纠正把完整窗口的资源就绪序号交给 host，但不宣称已经提交或出声', async () => {
  for (const code of ['SELECTION_INDEXES_UNPLAYABLE', 'MUSIC_NOT_COMMITTED']) {
    const resourceReadyIndexes = Array.from({ length: 60 }, (_, index) => index + 1);
    const registry = registryFor({ commitSelection: async () => ({ ok: false, code,
      offerId: 'offer:abc', resourceReadyIndexes, knownUnplayableIndexes: [],
      failedItems: [], message: '这次没有提交，队列没有变化。' }) });
    const outcome = await registry.execute('commit_music_selection', { offerId: 'offer:abc', indexes: [1] }, context);
    assert.deepEqual(outcome.facts.resourceReadyIndexes, resourceReadyIndexes, '最多六十个序号不被截成二十个');
    assert.match(outcome.modelContext, /resourceReadyIndexes/);
    assert.match(outcome.modelContext, /优先.*符合.*要求/u);
    assert.match(outcome.modelContext, /少选/u);
    assert.match(outcome.modelContext, /不代表.*提交.*出声/u);
    assert.match(outcome.modelContext, /硬约束/u);
    assert.notEqual(outcome.terminal, true);
    assert.equal(outcome.presentation.speak, false);
  }
});

test('a punctuation-only follow-up cannot replay either step of the selection flow', async () => {
  const calls = [];
  const registry = registryFor({
    execute: async () => { calls.push('select'); return offerResult(); },
    commitSelection: async () => { calls.push('commit'); return { ok: true, code: 'MUSIC_COMMITTED' }; },
  });
  const stale = { ...context, userText: '？' };
  const selection = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' }, stale);
  const commit = await registry.execute('commit_music_selection', { offerId: 'offer:abc', indexes: [1] }, stale);
  for (const outcome of [selection, commit]) {
    assert.equal(outcome.code, 'NO_FRESH_MUSIC_REQUEST');
    assert.equal(outcome.ok, false);
    assert.match(outcome.presentation.displayText, /明确/u);
  }
  assert.deepEqual(calls, []);
});

test('群聊非负责人只有 music 能力也能看到 commit_music_selection：提交即登记推荐', async () => {
  let committed = null;
  const registry = registryFor({
    execute: async () => offerResult(),
    commitSelection: async (args, toolContext) => { committed = { args, toolContext };
      return { ok: true, code: 'MUSIC_RECOMMENDED', delivery: 'recommend_only', tracks: [], message: '已记下你的推荐。' }; },
  });
  const nonOwner = { ...context, capabilities: [MUSIC_CAPABILITY], virtualPersonId: 'mio',
    groupAction: { ownerId: 'lunara', recommendations: [] } };
  const names = registry.definitions({ capabilities: nonOwner.capabilities }).map(item => item.function.name);
  assert.ok(names.includes('select_music') && names.includes('commit_music_selection'));
  const offered = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' }, nonOwner);
  assert.match(offered.modelContext, /登记为你的推荐/u);
  const outcome = await registry.execute('commit_music_selection', { offerId: 'offer:abc', indexes: [1] }, nonOwner);
  assert.equal(outcome.code, 'MUSIC_RECOMMENDED');
  assert.equal(committed.toolContext.virtualPersonId, 'mio');
  // 负责人看到的候选说明不带这句。
  const ownerOffer = await registry.execute('select_music', { mode: 'discovery', delivery: 'replace_now' }, context);
  assert.doesNotMatch(ownerOffer.modelContext, /登记为你的推荐/u);
});

test('music tools beats slot merges beats with receipt on MUSIC_COMMITTED, discards on failure/offer, and rejects action outside single roleplay', async () => {
  const { VirtualPersonToolRegistry } = await import('./VirtualPersonToolRegistry.js');
  const { registerMusicTools } = await import('./musicTools.js');
  const { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } = await import('../program/musicSelectionRequest.js');

  let nextResult = null;
  const service = {
    execute: async () => nextResult,
    commitSelection: async () => nextResult,
  };
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => service);

  const baseCaps = [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY];
  const selectRadioDef = registry.definitions({ capabilities: baseCaps, interactionMode: 'radio', isGroup: false })
    .find(d => d.function.name === 'select_music');
  const selectRpDef = registry.definitions({ capabilities: baseCaps, interactionMode: 'roleplay', isGroup: false })
    .find(d => d.function.name === 'select_music');
  const commitGroupDef = registry.definitions({ capabilities: baseCaps, interactionMode: 'roleplay', isGroup: true })
    .find(d => d.function.name === 'commit_music_selection');
  assert.equal('action' in selectRadioDef.function.parameters.properties.beats.items.properties, false);
  assert.equal('action' in selectRpDef.function.parameters.properties.beats.items.properties, true);
  assert.equal('action' in commitGroupDef.function.parameters.properties.beats.items.properties, false);

  const rejectedAction = await registry.execute('commit_music_selection', {
    offerId: 'offer:x',
    indexes: [1],
    beats: [{ action: '点头', say: '来听夜曲。' }],
  }, { capabilities: baseCaps, userText: '换首夜曲', interactionMode: 'radio', isGroup: false });
  assert.equal(rejectedAction.ok, false);
  assert.equal(rejectedAction.code, 'INVALID_TOOL_ARGUMENTS');

  nextResult = {
    ok: true,
    code: 'MUSIC_COMMITTED',
    terminal: true,
    selectedCount: 1,
    requestedCount: 1,
    tracks: [{ title: '夜曲', artist: '周杰伦' }],
    userMessage: '已经给你排好《夜曲》。',
  };
  const committed = await registry.execute('commit_music_selection', {
    offerId: 'offer:x',
    indexes: [1],
    beats: [
      { action: '轻轻放下杯子', say: '我找了一下。', pauseAfterMs: 500 },
      { say: '挑了这首《夜曲》。' },
    ],
  }, { capabilities: baseCaps, userText: '放首夜曲', interactionMode: 'roleplay', isGroup: false });
  assert.equal(committed.ok, true);
  assert.equal(committed.terminal, true);
  assert.equal(committed.presentation.beats.length, 3);
  assert.equal(committed.presentation.beats[0].action, '轻轻放下杯子');
  assert.equal(committed.presentation.beats[0].say, '我找了一下。');
  assert.equal(committed.presentation.beats[0].pauseAfterMs, 500);
  assert.equal(committed.presentation.beats[1].say, '挑了这首《夜曲》。');
  assert.equal(committed.presentation.beats[1].pauseAfterMs, 650);
  assert.equal(committed.presentation.beats[2].say, '已经给你排好《夜曲》。');
  assert.equal(committed.presentation.beats[2].pauseAfterMs, 0);

  nextResult = {
    ok: true,
    code: 'MUSIC_CANDIDATES_OFFERED',
    offerId: 'offer:y',
    request: { mode: 'discovery', delivery: 'replace_now', count: 1 },
    offer: { candidates: [{ index: 1, songId: '1', title: '晴天', artist: '周杰伦', album: '叶惠美', source: 'qq', duration: 269 }] },
  };
  const offered = await registry.execute('select_music', {
    mode: 'discovery',
    delivery: 'replace_now',
    beats: [{ say: '挑好之前先写一句' }],
  }, { capabilities: baseCaps, userText: '挑首歌', interactionMode: 'radio', isGroup: false });
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(offered.presentation.beats, undefined);
});

test('select_music and commit_music_selection safely truncate slightly overlong voice.direction while still rejecting disallowed content', async () => {
  const { VirtualPersonToolRegistry } = await import('./VirtualPersonToolRegistry.js');
  const { registerMusicTools } = await import('./musicTools.js');
  const { MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY } = await import('../program/musicSelectionRequest.js');

  const overlongDir = '压低音量贴近收音麦带点微沙哑的气声慢慢吐字说给你听好不好呀';
  assert.ok([...overlongDir].length > 25 && [...overlongDir].length <= 40);

  const committedResult = {
    ok: true,
    code: 'MUSIC_COMMITTED',
    terminal: true,
    selectedCount: 1,
    requestedCount: 1,
    tracks: [{ title: '夜曲', artist: '周杰伦' }],
    userMessage: '已经给你排好《夜曲》。',
  };
  const registry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(registry, () => ({
    execute: async () => committedResult,
    commitSelection: async () => committedResult,
  }));

  const caps = [MUSIC_CAPABILITY, MUSIC_MUTATION_CAPABILITY];
  const toolCtx = { capabilities: caps, userText: '放首夜曲', interactionMode: 'roleplay', isGroup: false };

  const selectOk = await registry.execute('select_music', {
    mode: 'exact',
    delivery: 'replace_now',
    targets: [{ title: '夜曲' }],
    beats: [{ action: '轻轻推近杯子', say: '挑了这首《夜曲》。', voice: { pace: 'slow', direction: overlongDir } }],
  }, toolCtx);
  assert.equal(selectOk.ok, true);
  assert.equal(selectOk.presentation.beats.length, 2);
  assert.equal(selectOk.presentation.beats[0].say, '挑了这首《夜曲》。');
  assert.equal([...selectOk.presentation.beats[0].voice.direction].length, 25);
  assert.equal(selectOk.presentation.beats[0].voice.direction, [...overlongDir].slice(0, 25).join(''));

  const commitOk = await registry.execute('commit_music_selection', {
    offerId: 'offer:z',
    indexes: [1],
    beats: [{ say: '这首《夜曲》给你排好了。', voice: { direction: overlongDir } }],
  }, toolCtx);
  assert.equal(commitOk.ok, true);
  assert.equal(commitOk.presentation.beats.length, 2);
  assert.equal(commitOk.presentation.beats[0].say, '这首《夜曲》给你排好了。');
  assert.equal([...commitOk.presentation.beats[0].voice.direction].length, 25);

  for (const badBeat of [
    { say: '这首《夜曲》给你排好了。', voice: { direction: '压低音量贴近麦克风带上{叹气}效果慢慢说话' } },
    { say: '这首《夜曲》给你排好了。', voice: { direction: 'https://example.com 压低音量慢慢说' } },
    { say: '这首《夜曲》给你排好了。', voice: { direction: '用 commit_music_selection 压低音量' } },
    { say: '《夜曲》已经在放了。', voice: { direction: overlongDir } },
  ]) {
    const rejected = await registry.execute('commit_music_selection', {
      offerId: 'offer:z',
      indexes: [1],
      beats: [badBeat],
    }, toolCtx);
    assert.equal(rejected.ok, true);
    assert.equal(rejected.presentation.displayText, '已经给你排好《夜曲》。');
    assert.equal(rejected.presentation.beats, undefined);
  }
});

test('select_music schema reserves constraints.tags for objective boundaries while keeping search_library full tags', async () => {
  const executed = [];
  const registry = registryFor({
    execute: async args => { executed.push(args); return offerResult(); },
    getCandidates: async () => [{ song_id: 's1', title: 'Moon River', artist: '手嶌葵', source: 'qq:library' }],
    getSongTagStore: () => ({
      getTags: id => (id === 's1' ? { genre: '爵士', mood: 'calm', energy: 0.3 } : null),
      getArtistTags: () => null,
    }),
  });

  for (const tags of [{ genre: '爵士', tempo: 'slow' }, { mood: '慵懒' }, { maxEnergy: 0.4 }]) {
    const blocked = await registry.execute('select_music', {
      mode: 'constrained',
      delivery: 'replace_now',
      constraints: { tags },
    }, context);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'INVALID_TOOL_ARGUMENTS');
  }
  assert.equal(executed.length, 0);

  const discoveryOk = await registry.execute('select_music', {
    mode: 'discovery',
    delivery: 'replace_now',
    softPreferences: '浪漫、jazz且慵懒',
  }, context);
  assert.equal(discoveryOk.ok, true);
  assert.equal(discoveryOk.code, 'MUSIC_CANDIDATES_OFFERED');

  const objectiveOk = await registry.execute('select_music', {
    mode: 'constrained',
    delivery: 'replace_now',
    constraints: { tags: { language: 'cantonese', gender: 'female', has_vocal: true, minYear: 2000, region: '港台' } },
  }, context);
  assert.equal(objectiveOk.ok, true);
  assert.equal(objectiveOk.code, 'MUSIC_CANDIDATES_OFFERED');

  const librarySearch = await registry.execute('search_library', {
    tags: { genre: '爵士', mood: 'calm', maxEnergy: 0.4 },
  }, context);
  assert.equal(librarySearch.ok, true);
  assert.equal(librarySearch.facts.total, 1);
});
