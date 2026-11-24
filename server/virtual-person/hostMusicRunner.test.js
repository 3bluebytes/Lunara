// hostMusicRunner：没有听众消息时 host 自己选歌的回合（续播、手动下一首、预热）。
//
// STUB 只替代模型回合：两个工具在真实 MusicSelectionService / ProgramCommitService /
// PlaybackRuntime 上跑通；用的是 host 自己的上下文，不写对话账本，身份与代次守卫仍然生效。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from './ConversationStore.js';
import { VirtualPersonRegistry } from './VirtualPersonRegistry.js';
import { VirtualPersonToolRegistry } from './VirtualPersonToolRegistry.js';
import { AgentLoop } from './AgentLoop.js';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { ProgramCommitService } from '../program/ProgramCommitService.js';
import { MusicSelectionService } from '../program/MusicSelectionService.js';
import { createHostMusicRunner, publicRequestBrief } from './hostMusicRunner.js';
import { registerMusicTools } from './musicTools.js';
import { validateJsonSchema } from './jsonSchemaValidator.js';
import { normalizeMusicSelection, MUSIC_SELECTION_PARAMETERS } from '../program/musicSelectionRequest.js';
import { validateResolvedTrackAgainstRequest } from '../program/programConstraintValidation.js';

const SESSION = 'room';
const HOST = 'host';
const LIBRARY = [1, 2, 3, 4].map(id => ({ song_id: String(id), title: `歌${id}`, artist: '歌手', source: 'qq', album: '录音室' }));

/** STUB AgentLoop 驱动：真实工具、真实提交，只替代模型回合本身。 */
async function twoStepDriver(input, toolRegistry, { indexes = [1, 2], commitArgs = null, skipCommit = false } = {}) {
  const base = { correlationId: 'stub', capabilities: input.capabilities, signal: input.signal, ...input.toolContext };
  const offered = await toolRegistry.execute('select_music', {}, { ...base, round: 1, toolCallCount: 1 });
  await input.onMessage?.({ kind: 'assistant_tool_calls', round: 1,
    message: { role: 'assistant', content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'select_music', arguments: '{}' } }] } });
  await input.onMessage?.({ kind: 'tool_result', round: 1,
    message: { role: 'tool', tool_call_id: 's1', content: '{}' }, outcome: offered });
  const outcomes = [offered];
  if (skipCommit || offered.code !== 'MUSIC_CANDIDATES_OFFERED') {
    return { finalText: '没有候选。', rounds: 1, messages: [], outcomes, finishReason: 'stop' };
  }
  const args = commitArgs || { offerId: offered.facts.offerId, indexes };
  const committed = await toolRegistry.execute('commit_music_selection', args, { ...base, round: 2, toolCallCount: 1 });
  await input.onMessage?.({ kind: 'assistant_tool_calls', round: 2,
    message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'commit_music_selection', arguments: JSON.stringify(args) } }] } });
  await input.onMessage?.({ kind: 'tool_result', round: 2,
    message: { role: 'tool', tool_call_id: 'c1', content: '{}' }, outcome: committed });
  outcomes.push(committed);
  return { finalText: committed.presentation?.displayText || '', rounds: 2, messages: [], outcomes, finishReason: 'stop' };
}

function fixture(t, { driver = null, candidates = LIBRARY, sessionTrace = null, agentLoopFactory = null, contextError = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-selection-agent-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  registry.createRadiohost({ id: HOST, displayName: '主播', voiceProfileId: 'voice-host' });
  conversationStore.createRoom({ sessionId: SESSION, memberIds: [HOST] });
  const commands = [], effects = [];
  const playbackRuntime = new PlaybackRuntimeHost({ commandSink: item => commands.push(item), effectSink: item => effects.push(item) });
  const tags = { getTags: () => ({ language: 'zh', genres: ['pop'], artist_key: 'artist' }), getArtistTags: () => ({ gender: 'female' }) };
  const commit = new ProgramCommitService({ playbackRuntime, queueService: { publishSnapshot() {} },
    synthesize: async () => ({ url: '/tts.mp3' }),
    resolveTrack: async (_query, { candidate }) => {
      const track = candidates.find(row => row.song_id === candidate.sourceSongId);
      return track ? { ...track, ok: true, url: `/audio/${track.song_id}.mp3` } : { ok: false };
    },
    validateResolvedTrack: (track, context) => validateResolvedTrackAgainstRequest(track, {
      request: context.candidateProgram.metadata.musicSelection, songTagStore: tags }),
  });
  const service = new MusicSelectionService({ programCommitService: commit, playbackRuntime, registry, conversationStore,
    getCandidates: async () => candidates, getSongTagStore: () => tags, getFamiliarArtists: () => [], getRecentPlays: () => [] });
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(toolRegistry, () => service);
  const runs = [];
  const innerLoop = agentLoopFactory ? agentLoopFactory(toolRegistry)
    : { run: async input => (driver || twoStepDriver)(input, toolRegistry) };
  const agentLoop = { run: input => { runs.push(input); return innerLoop.run(input); } };
  const passes = [];
  const host = { busy: false, hostBusy() { return this.busy; },
    enterBackgroundHost: () => ({ signal: null, leave() {} }),
    assembleHostContext: async input => {
      if (contextError) throw contextError;
      assembled.push(input);
      return { systemPrompt: 'host 的完整人设', messages: [{ role: 'user', content: '之前聊的' }], onContextUsage: null };
    },
    startLinePass: input => { passes.push(input); return Promise.resolve(null); } };
  const assembled = [];
  const agent = createHostMusicRunner({ agentLoop, toolRegistry, host, sessionTrace, registry });
  t.after(() => { conversationStore.close(); registry.close(); rmSync(dir, { recursive: true, force: true }); });
  return { agent, service, toolRegistry, playbackRuntime, conversationStore, runs, commands, effects, host, passes, assembled };
}

const taskRequest = (delivery = 'replace_now') => normalizeMusicSelection({ mode: 'discovery', delivery, count: 2 });
const taskInput = (overrides = {}) => ({ request: taskRequest(), reason: 'user_request', sessionId: SESSION,
  isCurrent: () => true, ...overrides });

test('waiting behind a greeting revalidates generation and membership before any model call', async t => {
  for (const stale of ['generation', 'membership']) {
    const h = fixture(t);
    let admit, left = 0, current = true, token = 'old';
    h.host.conversationStore = { membershipToken: () => token };
    h.host.acquireBackgroundHost = () => new Promise(resolve => { admit = () => resolve({ signal: null, leave() { left += 1; } }); });
    const pending = h.agent.run(taskInput({ context: { requestId: `waiting-${stale}`, virtualPersonId: HOST }, isCurrent: () => current }));
    await new Promise(setImmediate);
    assert.equal(h.runs.length, 0);
    if (stale === 'generation') current = false;
    else token = 'new';
    admit();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.code, stale === 'generation' ? 'STALE_HOST_TASK' : 'HOST_UNAVAILABLE');
    assert.equal(h.runs.length, 0);
    assert.equal(h.commands.length, 0);
    assert.equal(left, 1, '过期等待也必须释放后台活动');
  }
});

test('the restricted runner executes one bounded loop with two tools and commits through them', async t => {
  const h = fixture(t);
  const result = await h.agent.run(taskInput({ context: { requestId: 'task-1', virtualPersonId: HOST } }));

  assert.equal(result.ok, true, result.code);
  assert.equal(result.code, 'MUSIC_COMMITTED');
  assert.deepEqual(result.tracks.map(track => track.songId), ['1', '2']);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '2']);
  assert.equal(h.playbackRuntime.snapshot().activeListeningSessionId, SESSION);

  const [run] = h.runs;
  assert.deepEqual(run.toolNames, ['select_music', 'commit_music_selection'], '受限工具白名单');
  assert.equal(run.systemPrompt, 'host 的完整人设', '用 host 自己的 system prompt');
  assert.equal(run.messages[0].content, '之前聊的', '带着 host 的聊天上下文');
  assert.match(run.messages.at(-1).content, /不是听众的消息/u, '触发消息标明不是听众说的');
  assert.deepEqual(run.profileOverrides, { maxRounds: 5, emptyRetry: false });
  assert.equal(run.modelProfileId, 'music_selection');
  assert.deepEqual(run.capabilities.sort(), ['music', 'music.commit'].sort());
  assert.equal(run.toolContext.musicTaskRequest.request.delivery, 'replace_now');
  assert.equal(run.toolContext.musicTaskRequest.reason, 'user_request');
  assert.equal(run.toolContext.musicTaskRequest.sessionId, SESSION);
  assert.equal(typeof run.toolContext.musicTaskRequest.isCurrent, 'function');
  assert.equal(h.conversationStore.listTurns(SESSION).length, 0, '自动任务不写对话账本');
  // 两个工具注册在同一个 registry 上，白名单由 AgentLoop 按 run.toolNames 过滤。
  const names = h.toolRegistry.definitions({ capabilities: run.capabilities })
    .map(definition => definition.function.name);
  assert.ok(names.includes('select_music') && names.includes('commit_music_selection'));
});

test('the locked-request brief is a public view: no internal null placeholders, still schema-valid', async t => {
  const h = fixture(t);
  // 续播/点播的归一化请求用 null 表示“没有这个条件”：内部表示，不是工具参数。
  const request = normalizeMusicSelection({ mode: 'discovery', delivery: 'replace_now', count: 2,
    softPreferences: '清晨、安静舒适' });
  assert.match(JSON.stringify(request), /"playlist":null/, '内部归一化请求确实带 null 占位');
  assert.match(JSON.stringify(request), /"requiredVersion":null/);

  const brief = publicRequestBrief(request);
  assert.doesNotMatch(brief, /null/, '提示里不得出现内部 null 占位');
  assert.doesNotMatch(brief, /"playlist"|"reference"/, '不存在的字段不出现在公开视图里');
  // 公开视图本身就是合法工具参数：模型照着它写也不会被 schema 拒。
  const validation = validateJsonSchema(JSON.parse(brief), MUSIC_SELECTION_PARAMETERS);
  assert.equal(validation.valid, true, validation.errors.join('; '));

  const result = await h.agent.run(taskInput({ request,
    context: { requestId: 'task-brief', virtualPersonId: HOST } }));
  assert.equal(result.ok, true, result.code);
  const [run] = h.runs;
  const trigger = run.messages.at(-1).content;
  assert.doesNotMatch(trigger, /:null/, '触发消息里不得出现内部 null 表示');
  assert.match(trigger, /锁定请求（只读/u);
  assert.match(trigger, /直接传 \{\}/u, '明确告诉模型 select_music 不需要参数');
});

test('preparation mode selects references without committing and without touching playback', async t => {
  const h = fixture(t);
  const before = h.playbackRuntime.snapshot();
  const result = await h.agent.run({ ...taskInput({ mode: 'preparation' }),
    context: { requestId: 'task-prep', virtualPersonId: HOST } });
  assert.equal(result.ok, true, result.code);
  assert.equal(result.code, 'MUSIC_CANDIDATES_SELECTED');
  assert.deepEqual(result.offeredIndexes, [1, 2]);
  assert.deepEqual(result.tracks.map(track => track.songId), ['1', '2'], '只返回选中的 canonical 候选');
  assert.deepEqual(h.playbackRuntime.snapshot(), before, '准备模式绝不提交播放');
  assert.deepEqual(h.commands, []);
  assert.equal(h.runs[0].toolContext.musicTaskRequest.resolveOnly, true);
  assert.equal(h.runs[0].toolContext.musicTaskRequest.mode, 'preparation');
  assert.match(h.runs[0].messages.at(-1).content, /只准备候选/u);
});

test('a cancelled task cannot commit playback even though the offer was created', async t => {
  const h = fixture(t);
  const result = await h.agent.run({ ...taskInput({ isCurrent: () => false }),
    context: { requestId: 'task-stale', virtualPersonId: HOST } });
  assert.equal(result.ok, false);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, 'isCurrent 守卫在提交时仍然生效');
  assert.deepEqual(h.commands, []);
});

test('an empty candidate pool ends the task honestly as NO_MATCHING_CANDIDATES', async t => {
  const h = fixture(t, { candidates: [] });
  const result = await h.agent.run({ ...taskInput(), context: { requestId: 'task-empty', virtualPersonId: HOST } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_MATCHING_CANDIDATES');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.deepEqual(h.commands, []);
});

test('a loop failure after an accepted commit still reports the committed tracks', async t => {
  const h = fixture(t, { driver: async (input, toolRegistry) => {
    const result = await twoStepDriver(input, toolRegistry);
    const error = Object.assign(new Error('round limit'), { code: 'AGENT_ROUND_LIMIT' });
    error.agentOutcomes = result.outcomes;
    throw error;
  } });
  const result = await h.agent.run({ ...taskInput(), context: { requestId: 'task-late', virtualPersonId: HOST } });
  assert.equal(result.ok, true, '已接受的提交不因为后续回合失败而丢失');
  assert.equal(result.code, 'MUSIC_COMMITTED');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 2);
});

test('a bounded loop timeout is reported with its own code and no playback', async t => {
  const h = fixture(t, { driver: async () => {
    throw Object.assign(new Error('virtual person turn timed out'), { code: 'AGENT_TIMEOUT' });
  } });
  const result = await h.agent.run({ ...taskInput(), context: { requestId: 'task-timeout', virtualPersonId: HOST } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AGENT_TIMEOUT');
  assert.match(result.message, /timed out/u);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
});

test('the runner refuses to be built without the two registered tools', () => {
  const empty = new VirtualPersonToolRegistry({ logger: { error() {} } });
  assert.throws(() => createHostMusicRunner({ agentLoop: { run: async () => ({}) }, toolRegistry: empty,
    host: { assembleHostContext: async () => ({}) }, registry: { get: () => null } }),
    /requires registered tools: select_music, commit_music_selection/u);
});

test('preparation mode holds the offer with its adoption credential and yields offerId, indexes and canonical refs', async t => {
  const h = fixture(t);
  const preparedFor = { listeningSessionId: SESSION, outputGeneration: 5, boundaryKey: 'b-1' };
  const result = await h.agent.run({ ...taskInput({ mode: 'preparation' }),
    context: { requestId: 'task-prep-2', virtualPersonId: HOST, outputGeneration: 5, preparedFor } });

  assert.equal(result.ok, true, result.code);
  assert.equal(result.code, 'MUSIC_CANDIDATES_SELECTED');
  assert.match(result.offerId, /^offer:/);
  assert.deepEqual(result.indexes, [1, 2]);
  assert.deepEqual(result.offeredIndexes, [1, 2]);
  assert.deepEqual(result.tracks.map(track => track.songId), ['1', '2']);
  const offer = h.service.offers.get(result.offerId);
  assert.equal(offer.status, 'prepared', '预热任务只挂起候选，不消费 offer');
  assert.deepEqual(offer.preparedFor, preparedFor);
  assert.deepEqual(h.playbackRuntime.snapshot().queue, [], '挂起阶段绝不提交播放');
  assert.deepEqual(h.commands, []);
  assert.equal(h.runs[0].toolContext.musicTaskRequest.preparedFor.boundaryKey, 'b-1',
    '采用凭据随锁定任务进工具上下文');
  assert.equal(h.runs[0].toolContext.preparedFor.outputGeneration, 5);
});

test('the runner enters the per-session trace so runtime-triggered tasks land in the same JSONL', async t => {
  const entered = [];
  const h = fixture(t, { sessionTrace: { enter: (context, fn) => { entered.push(context); return fn(); } } });
  const result = await h.agent.run({ ...taskInput({ mode: 'preparation' }),
    context: { requestId: 'prewarm-1', roundId: 'round-9', virtualPersonId: HOST,
      preparedFor: { listeningSessionId: SESSION, outputGeneration: 5, boundaryKey: null } } });
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(entered, [{ sessionId: SESSION, requestId: 'prewarm-1', roundId: 'round-9', virtualPersonId: HOST }],
    '同一会话、同一请求身份进入追踪上下文');
  assert.equal(h.runs.length, 1, '只运行一次，且没有第二个模型链');
});

test('the per-run sessionTrace overrides the constructor one for runtime-triggered playback tasks', async t => {
  const calls = [];
  const constructorTrace = { enter: (_context, fn) => { calls.push('constructor'); return fn(); } };
  const runTrace = { enter: (_context, fn) => { calls.push('run'); return fn(); } };
  const h = fixture(t, { sessionTrace: constructorTrace });
  const result = await h.agent.run({ ...taskInput(), sessionTrace: runTrace,
    context: { requestId: 'runtime-continuation:b-1', virtualPersonId: HOST } });
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(calls, ['run'], '本次任务的追踪门面优先');
});

// ---- 失败上报与可诊断性：回合额度、具体失败码与受限任务的追踪事件 ----

/** 真实 AgentLoop + 脚本化模型：select → commit（越界序号，失败）→ commit（修正后成功）。 */
function scriptedCorrectionChat() {
  let round = 0;
  let offerId = null;
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  return async messages => {
    round += 1;
    if (round === 1) {
      return { message: { role: 'assistant', content: '', tool_calls: [call('s1', 'select_music', {})] }, finishReason: 'tool_calls' };
    }
    if (!offerId) {
      const toolMessage = [...messages].reverse().find(message => message.role === 'tool');
      offerId = JSON.parse(toolMessage.content)?.facts?.offerId || null;
    }
    return { message: { role: 'assistant', content: '', tool_calls: [
      round === 2 ? call('c1', 'commit_music_selection', { offerId, indexes: [99] })
        : call('c2', 'commit_music_selection', { offerId, indexes: [1, 2] })] }, finishReason: 'tool_calls' };
  };
}

test('select→commit(fail)→commit(ok) completes inside the playback round budget', async t => {
  const h = fixture(t, { agentLoopFactory: toolRegistry => new AgentLoop({ chat: scriptedCorrectionChat(), toolRegistry }) });
  const result = await h.agent.run(taskInput({ context: { requestId: 'task-correct', virtualPersonId: HOST } }));

  assert.equal(result.ok, true, result.code);
  assert.equal(result.code, 'MUSIC_COMMITTED', '一次修正之后仍然在额度内完成，而不是 AGENT_ROUND_LIMIT');
  assert.deepEqual(result.tracks.map(track => track.songId), ['1', '2']);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '2']);
  assert.ok(h.runs[0].profileOverrides.maxRounds >= 4, '播放任务预算留出一次纠正的余量');
});

for (const failureCode of ['not-playable', 'timeout']) {
  test(`真实 AgentLoop 在 ${failureCode} 后依据资源就绪序号纠正，三轮内提交且不打断当前歌`, async t => {
    let calls = 0, candidates = [], chosenSongId = null;
    const call = (id, name, args) => ({ message: { role: 'assistant', content: '', tool_calls: [
      { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finishReason: 'tool_calls' });
    const h = fixture(t, { agentLoopFactory: toolRegistry => new AgentLoop({ toolRegistry, chat: async messages => {
      calls++;
      if (calls === 1) return call('select', 'select_music', {});
      const outcome = JSON.parse([...messages].reverse().find(message => message.role === 'tool').content);
      if (calls === 2) {
        candidates = outcome.facts.candidates;
        // 给后台取流一个事件循环，不增加模型/源调用；其中一首失败，其余已有资源。
        await new Promise(setImmediate);
        return call('bad', 'commit_music_selection', { offerId: outcome.facts.offerId,
          indexes: [candidates.find(track => track.songId === '2').index] });
      }
      assert.equal(calls, 3, '接受提交后不得再进入下一轮模型调用');
      assert.equal(outcome.code, failureCode === 'not-playable' ? 'SELECTION_INDEXES_UNPLAYABLE' : 'MUSIC_NOT_COMMITTED');
      const ready = outcome.facts.resourceReadyIndexes;
      assert.equal(ready.length, 2);
      chosenSongId = candidates.find(track => track.index === ready[0]).songId;
      return call('corrected', 'commit_music_selection', { offerId: outcome.facts.offerId, indexes: [ready[0]] });
    } }) });
    const seeded = await h.service.execute({ mode: 'exact', delivery: 'replace_now', count: 1,
      targets: [{ songId: '1', source: 'qq', title: '歌1', artist: '歌手' }] },
    { sessionId: SESSION, virtualPersonId: HOST, requestId: 'recovery-seed' });
    assert.equal(seeded.ok, true, seeded.code);
    const identity = () => {
      const state = h.playbackRuntime.snapshot();
      return { runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
        outputGeneration: state.outputGeneration, songId: state.currentSongId,
        programId: state.txn?.programId, correlationId: state.txn?.correlationId };
    };
    await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: 'seed-started', ...identity() });
    const before = h.playbackRuntime.snapshot();
    const resolve = h.service.programCommitService.resolveTrack;
    h.service.preResolveConcurrency = 4;
    h.service.programCommitService.resolveTrack = async (query, options) => options.candidate.sourceSongId === '2'
      ? { ok: false, code: failureCode, error: 'canonical-resource-unavailable' } : resolve(query, options);
    let validations = 0;
    const validate = h.service.programCommitService.validateResolvedTrack;
    h.service.programCommitService.validateResolvedTrack = (...args) => { validations++; return validate(...args); };
    const result = await h.agent.run(taskInput({ request: taskRequest('append'), reason: 'auto_continue',
      context: { requestId: `runtime-continuation:${before.pendingContinuation.boundaryKey}`,
        virtualPersonId: HOST, outputGeneration: before.outputGeneration } }));
    assert.equal(result.code, 'MUSIC_COMMITTED', JSON.stringify(result));
    assert.equal(calls, 3);
    assert.equal(h.runs[0].profileOverrides.maxRounds, 5, '不靠放大预算掩盖问题');
    assert.equal(validations, 1, '复用资源仍经过 canonical 提交约束校验');
    const after = h.playbackRuntime.snapshot();
    assert.deepEqual(after.queue.map(track => track.songId), ['1', chosenSongId]);
    assert.equal(after.currentSongId, before.currentSongId);
    assert.equal(after.txn.correlationId, before.txn.correlationId, '只追加，不重建当前媒体事务');
    assert.equal(h.conversationStore.listTurns(SESSION).length, 0, '续播选择不落成听众聊天');
  });
}

test('a round limit does not mask the failed commit code and its reason', async t => {
  const h = fixture(t, { driver: async (input, toolRegistry) => {
    const base = { correlationId: 'stub', capabilities: input.capabilities, signal: input.signal, ...input.toolContext };
    const offered = await toolRegistry.execute('select_music', {}, { ...base, round: 1, toolCallCount: 1 });
    await input.onMessage?.({ kind: 'assistant_tool_calls', round: 1, message: { role: 'assistant', content: '',
      tool_calls: [{ id: 's1', type: 'function', function: { name: 'select_music', arguments: '{}' } }] } });
    await input.onMessage?.({ kind: 'tool_result', round: 1, message: { role: 'tool', tool_call_id: 's1', content: '{}' }, outcome: offered });
    // 供应商资源在边界处不可用：canonical 解析失败，两次提交都返回 MUSIC_NOT_COMMITTED。
    h.service.programCommitService.resolveTrack = async () => ({ ok: false });
    const args = { offerId: offered.facts.offerId, indexes: [1, 2] };
    const attempts = [];
    for (const [round, id] of [[2, 'c1'], [3, 'c2']]) {
      const failed = await toolRegistry.execute('commit_music_selection', args, { ...base, round, toolCallCount: 1 });
      await input.onMessage?.({ kind: 'assistant_tool_calls', round, message: { role: 'assistant', content: '',
        tool_calls: [{ id, type: 'function', function: { name: 'commit_music_selection', arguments: JSON.stringify(args) } }] } });
      await input.onMessage?.({ kind: 'tool_result', round, message: { role: 'tool', tool_call_id: id, content: '{}' }, outcome: failed });
      attempts.push(failed);
    }
    const error = Object.assign(new Error('virtual person turn reached round limit'), { code: 'AGENT_ROUND_LIMIT' });
    error.agentOutcomes = [offered, ...attempts];
    throw error;
  } });
  const result = await h.agent.run(taskInput({ context: { requestId: 'task-limit', virtualPersonId: HOST } }));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MUSIC_NOT_COMMITTED', '通用额度错误不能掩盖具体提交失败');
  assert.equal(result.loopErrorCode, 'AGENT_ROUND_LIMIT', '额度信息仍然保留为诊断字段');
  assert.equal(result.reason, 'resolution failed (qq)', '按来源的解析摘要穿过工具层');
  assert.match(result.message, /resolution failed \(qq\)/);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, '没有播放副作用');
});

test('restricted runs record bounded tool results and a completion event in the session trace', async t => {
  const events = [];
  const traceFacade = { enter: (_context, fn) => fn(),
    recordScoped: (sessionId, event, extra) => events.push({ sessionId, ...extra, ...event }) };
  const h = fixture(t, { sessionTrace: traceFacade });
  const result = await h.agent.run(taskInput({ context: { requestId: 'task-trace', virtualPersonId: HOST } }));
  assert.equal(result.ok, true, result.code);

  const toolEvents = events.filter(event => event.type === 'task_tool_result');
  assert.deepEqual(toolEvents.map(event => [event.name, event.code, event.ok, event.terminal, event.toolCallId]),
    [['select_music', 'MUSIC_CANDIDATES_OFFERED', true, false, 's1'],
      ['commit_music_selection', 'MUSIC_COMMITTED', true, true, 'c1']]);
  assert.equal(toolEvents.every(event => event.sessionId === SESSION), true);
  const [completed] = events.filter(event => event.type === 'task_completed');
  assert.equal(completed.code, 'MUSIC_COMMITTED');
  assert.equal(completed.ok, true);
  assert.equal(completed.mode, 'playback');
  assert.equal(completed.requestId, 'task-trace');
  assert.equal(JSON.stringify(completed).includes('锁定请求'), false, '追踪不记完整 prompt/上下文');

  // 失败提交同样留下有限原因与最终码，而不是整段内部报文。
  const failing = fixture(t, { sessionTrace: traceFacade, driver: async (input, toolRegistry) => {
    const base = { correlationId: 'stub', capabilities: input.capabilities, signal: input.signal, ...input.toolContext };
    const offered = await toolRegistry.execute('select_music', {}, { ...base, round: 1, toolCallCount: 1 });
    await input.onMessage?.({ kind: 'assistant_tool_calls', round: 1, message: { role: 'assistant', content: '',
      tool_calls: [{ id: 's1', type: 'function', function: { name: 'select_music', arguments: '{}' } }] } });
    await input.onMessage?.({ kind: 'tool_result', round: 1, message: { role: 'tool', tool_call_id: 's1', content: '{}' }, outcome: offered });
    const args = { offerId: offered.facts.offerId, indexes: [99] };
    const failed = await toolRegistry.execute('commit_music_selection', args, { ...base, round: 2, toolCallCount: 1 });
    await input.onMessage?.({ kind: 'assistant_tool_calls', round: 2, message: { role: 'assistant', content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'commit_music_selection', arguments: JSON.stringify(args) } }] } });
    await input.onMessage?.({ kind: 'tool_result', round: 2, message: { role: 'tool', tool_call_id: 'c1', content: '{}' }, outcome: failed });
    return { finalText: '', rounds: 2, messages: [], outcomes: [offered, failed], finishReason: 'stop' };
  } });
  const refused = await failing.agent.run(taskInput({ context: { requestId: 'task-trace-fail', virtualPersonId: HOST } }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'INVALID_SELECTION_INDEXES');
  const failureEvent = events.filter(event => event.type === 'task_tool_result' && event.code === 'INVALID_SELECTION_INDEXES').at(-1);
  assert.equal(failureEvent.name, 'commit_music_selection');
  assert.equal(failureEvent.ok, false);
  assert.ok(failureEvent.message.length > 0 && failureEvent.message.length <= 200, '有界的原因/文案');
  const failureCompleted = events.filter(event => event.type === 'task_completed').at(-1);
  assert.equal(failureCompleted.code, 'INVALID_SELECTION_INDEXES');
  assert.equal(failureCompleted.ok, false);
});

test('the locked request still wins when the model passes different mode/delivery/count（5.1）', async t => {
  let offerId = null;
  const h = fixture(t, { driver: async (input, toolRegistry) => {
    const base = { correlationId: 'stub', capabilities: input.capabilities, signal: input.signal, ...input.toolContext };
    const offered = await toolRegistry.execute('select_music',
      { mode: 'discovery', delivery: 'replace_now', count: 5, softPreferences: '换成摇滚' }, { ...base, round: 1, toolCallCount: 1 });
    offerId = offered.facts?.offerId || null;
    return { finalText: '', rounds: 1, messages: [], outcomes: [offered], finishReason: 'stop' };
  } });
  await h.agent.run(taskInput({ reason: 'auto_continue', request: taskRequest('append'),
    context: { requestId: 'task-locked', virtualPersonId: HOST } }));
  assert.ok(offerId, 'select_music 仍出候选');
  const locked = h.service.offers.get(offerId).request;
  assert.equal(locked.delivery, 'append');
  assert.equal(locked.count, 2);
  assert.equal(locked.softPreferences || '', '', '模型参数被锁定请求取代');
});

test('host 上下文取不到就是这轮失败，不走简化路径，队列不变', async t => {
  const h = fixture(t, { contextError: Object.assign(new Error('no context'), { code: 'HOST_CONTEXT_UNAVAILABLE' }) });
  const result = await h.agent.run(taskInput({ context: { requestId: 'task-no-context', virtualPersonId: HOST } }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'HOST_CONTEXT_UNAVAILABLE');
  assert.equal(h.runs.length, 0, '不发起模型调用');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
});

test('提交之后接一轮 line pass，不等它，带上这一轮的选歌消息', async t => {
  const h = fixture(t);
  const result = await h.agent.run(taskInput({ context: { requestId: 'task-pass', virtualPersonId: HOST } }));
  assert.equal(result.ok, true, result.code);
  assert.equal(h.passes.length, 1);
  const [pass] = h.passes;
  assert.equal(pass.targets.length, 2);
  assert.equal(pass.sessionId, SESSION);
  assert.equal(pass.assembled.systemPrompt, 'host 的完整人设');
  assert.match(pass.extraMessages[0].content, /不是听众的消息/u);
  assert.ok(pass.extraMessages.some(message => message.tool_calls?.[0]?.function?.name === 'commit_music_selection'), '记得自己刚才选了什么');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(item => item.narration.status), ['preparing', 'preparing']);
});

test('line pass 把串词存到对应 occurrence；不合身份的存不进去', async t => {
  const h = fixture(t);
  await h.agent.run(taskInput({ context: { requestId: 'task-save', virtualPersonId: HOST } }));
  const [first, second] = h.passes[0].targets;
  assert.equal(await first.save({ text: '《歌1》是你上周提过的。', voiceProfileId: 'voice-host', writtenAt: 1000, membershipRevision: 0 }), true);
  await second.fail('not-written');
  const [one, two] = h.playbackRuntime.snapshot().queue;
  assert.equal(one.narration.status, 'ready');
  assert.equal(one.narration.assetStatus !== 'ready', true, '只存文字，不合成');
  assert.equal(one.narration.text, '《歌1》是你上周提过的。');
  assert.equal(one.narration.writtenAt, 1000);
  assert.equal(two.narration.status, 'absent', '没写的安静播放');
  assert.equal(await second.save({ text: '晚了' }), false, '已经归位的不再接受');
});

test('预热回合不提交音乐，串词由批次存好后单独接', async t => {
  const h = fixture(t);
  const result = await h.agent.run({ ...taskInput({ mode: 'preparation' }),
    context: { requestId: 'task-prep-lines', virtualPersonId: HOST, outputGeneration: 0,
      preparedFor: { listeningSessionId: SESSION, outputGeneration: 0, boundaryKey: null } } });
  assert.equal(result.ok, true, result.code);
  assert.equal(h.passes.length, 0);
  assert.equal(h.runs[0].toolContext.linePass, undefined);
  const targets = [{ track: { title: '歌1' }, save() {}, fail() {} }];
  await h.agent.writePreparedLines(result, targets);
  assert.equal(h.passes.length, 1);
  assert.equal(h.passes[0].targets, targets);
  await h.agent.writePreparedLines(result, targets);
  assert.equal(h.passes.length, 1, '同一批次只写一次');
});

test('isBusy 反映 host 是否忙', async t => {
  const h = fixture(t);
  assert.equal(h.agent.isBusy(SESSION), false);
  h.host.busy = true;
  assert.equal(h.agent.isBusy(SESSION), true);
});
