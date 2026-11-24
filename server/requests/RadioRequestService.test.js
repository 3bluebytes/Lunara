import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RadioRequestService } from './RadioRequestService.js';
import { CONTINUATION_BATCH_SIZE } from '../program/continuationBudget.js';
import { normalizeMusicSelection } from '../program/musicSelectionRequest.js';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { VirtualPersonRegistry } from '../virtual-person/VirtualPersonRegistry.js';
import { VirtualPersonToolRegistry } from '../virtual-person/VirtualPersonToolRegistry.js';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { ProgramCommitService } from '../program/ProgramCommitService.js';
import { MusicSelectionService } from '../program/MusicSelectionService.js';
import { createHostMusicRunner } from '../virtual-person/hostMusicRunner.js';
import { registerMusicTools } from '../virtual-person/musicTools.js';
import { validateResolvedTrackAgainstRequest } from '../program/programConstraintValidation.js';
const request = { mode: 'artist', artist: '歌手 A', delivery: 'append', count: 2 };

test('continuation carries cancellation and a lifecycle guard into the restricted runner', async () => {
  const h = fixture(), controller = new AbortController();
  let current = true, release;
  h.runner.run = input => {
    h.calls.push(input);
    return new Promise(resolve => { release = resolve; });
  };
  const running = h.service.handleContinue({ sessionId: 'a', outputGeneration: 4,
    signal: controller.signal, isCurrent: () => current });
  const { isCurrent } = h.calls[0];
  assert.equal(h.calls[0].signal, controller.signal);
  assert.equal(h.calls[0].mode, 'playback');
  assert.equal(isCurrent(), true);
  current = false; assert.equal(isCurrent(), false);
  current = true; controller.abort(); assert.equal(isCurrent(), false);
  release({ ok: false, code: 'NO_MATCHING_CANDIDATES' });
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(h.calls.length, 1);
});

function fixture({ getHostMusicRunner = null, curatorId = 'radiohost:a', room = null, isPersonAvailable = undefined } = {}) {
  const calls = [];
  const runner = { run: input => { calls.push(input); return { ok: true, tracks: [{}] }; } };
  const state = { activeListeningSessionId: 'a', outputGeneration: 4, phase: 'playing', radioMode: true,
    queue: [1], currentIndex: 0, listeningPlan: { request, curatorId } };
  const musicService = { context: input => input, execute: (selection, context) => { calls.push({ selection, context }); return { ok: true }; } };
  const service = new RadioRequestService({ conversationService: { handleChat: input => { calls.push(input); return input; } },
    playbackRuntime: { snapshot: () => state, listeningSnapshot: () => state },
    musicService,
    conversationStore: { getSession: id => ({ sessionId: id, activeVirtualPersonId: 'radiohost:a', ...(room || {}) }) },
    getHostMusicRunner: getHostMusicRunner === null ? () => runner : getHostMusicRunner,
    ...(isPersonAvailable ? { isPersonAvailable } : {}),
  });
  return { service, state, calls, musicService, runner };
}
test('user language goes directly to the persistent conversation loop', () => {
  const h = fixture(); h.service.handleChat({ message: '刚才第二首', sessionId: 'a' });
  assert.deepEqual(h.calls, [{ message: '刚才第二首', sessionId: 'a' }]);
});
test('continuation uses the active scoped plan and rejects delayed output generations', async () => {
  const h = fixture();
  assert.equal((await h.service.handleContinue({ sessionId: 'b', outputGeneration: 4 })).ok, false);
  assert.equal((await h.service.handleContinue({ sessionId: 'a', outputGeneration: 3 })).ok, false);
  await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4, requestId: 'next' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.mode, 'discovery', '续选不会把点名的歌手写成硬约束');
  assert.equal(h.calls[0].request.artist, '');
  assert.deepEqual(h.calls[0].request.preferredArtists, ['歌手 A']);
  assert.equal(h.calls[0].reason, 'auto_continue');
  assert.equal(h.calls[0].context.requestId, 'next');
  assert.equal(h.calls[0].context.virtualPersonId, 'radiohost:a');
  assert.equal(h.calls[0].isCurrent(), true);
  h.state.outputGeneration++; assert.equal(h.calls[0].isCurrent(), false);
});
test('preparation stops when there is no current listening plan', () => {
  const h = fixture(); assert.equal(h.service.preparationDemand().context.sessionId, 'a');
  h.state.radioMode = false;
  assert.equal(h.service.preparationDemand(), null);
  assert.equal(h.calls.length, 0);
});

test('legacy queues without a plan can continue, and switching the toggle off invalidates the request', async () => {
  const h = fixture();
  h.state.listeningPlan = null;
  h.state.pendingContinuation = { boundaryKey: 'end-one', status: 'requested' };
  await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4 });
  assert.equal(h.calls[0].request.mode, 'discovery');
  assert.equal(h.calls[0].request.count, CONTINUATION_BATCH_SIZE, '无 plan 的续播也用同一批量');
  assert.equal(h.calls[0].request.delivery, 'append', '无 plan 的续播也是追加：提前续选不能打断正在播的歌');
  assert.equal(h.calls[0].context.virtualPersonId, 'radiohost:a');
  assert.equal(h.calls[0].isCurrent(), true);
  h.state.radioMode = false;
  assert.equal(h.calls[0].isCurrent(), false);
});

test('a continuation failure is reported instead of silently substituting different music', async () => {
  const h = fixture();
  let attempts = 0;
  h.runner.run = async () => {
    attempts += 1;
    return { ok: false, code: 'NO_MATCHING_CANDIDATES', message: '这次没有找到符合条件的候选歌曲，队列没有变化。' };
  };
  const result = await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'NO_MATCHING_CANDIDATES');
  assert.equal(attempts, 1, '失败只上报一次，不自动换成别的歌手');
});

test('without a runner the boundary fails closed and never falls back to a hidden chooser', async () => {
  const h = fixture({ getHostMusicRunner: () => null });
  const result = await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4, requestId: 'no-runner' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MUSIC_SELECTION_UNAVAILABLE');
  assert.equal(h.musicService.execute.called, undefined, '不再回落到 musicService.execute 内部选歌');
  assert.equal(h.calls.length, 0);
  const next = await h.service.handleNext({ sessionId: 'a', requestId: 'no-runner-next' });
  assert.equal(next.code, 'MUSIC_SELECTION_UNAVAILABLE');
});

test('a continuation that stops being current reports STALE_CONTINUATION after the runner returns', async () => {
  const h = fixture();
  let current = true;
  h.runner.run = async () => ({ ok: true, tracks: [{}] });
  const pending = h.service.handleContinue({ sessionId: 'a', outputGeneration: 4, requestId: 'stale', isCurrent: () => current });
  current = false;
  assert.deepEqual(await pending, { ok: false, code: 'STALE_CONTINUATION' });
});

test('a finished exact set continues with the played artist as a soft preference, constraints intact', async () => {
  const h = fixture();
  h.state.listeningPlan = { request: { mode: 'exact', delivery: 'replace_now', count: 2,
    constraints: { excludedSongIds: ['a9'] },
    targets: [{ title: 'Song A', artist: '歌手 A', songId: 'a1', source: 'qq' }] }, curatorId: 'radiohost:a' };
  h.state.queue = [{ songId: 'a1', artist: '歌手 A', title: 'Song A', programId: 'program-a' }];
  const attempts = [];
  h.runner.run = async input => {
    attempts.push(input.request);
    return { ok: true, tracks: [{}] };
  };
  const result = await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4 });
  assert.equal(result.ok, true);
  assert.equal(attempts.length, 1, '不再有一次“去掉硬约束再试一次”的隐形第二次选歌');
  assert.equal(attempts[0].mode, 'discovery');
  assert.equal(attempts[0].artist, '');
  assert.deepEqual(attempts[0].preferredArtists, ['歌手 A']);
  assert.deepEqual(attempts[0].constraints.excludedSongIds, ['a9'], '用户给的硬约束原样保留');
});

// ---- 预热采用：真实 runtime 低队列触发 → 受限运行器挂起 → 边界零模型调用 ----

const LIBRARY = [1, 2, 3, 4].map(id => ({ song_id: String(id), title: `歌${id}`, artist: '歌手', source: 'qq', album: '录音室' }));

/** STUB AgentLoop：驱动真实两步工具（与生产运行器同形），只替代模型回合本身。 */
async function stubTwoStepDriver(input, toolRegistry, { indexes = [1, 2] } = {}) {
  const base = { correlationId: 'stub', capabilities: input.capabilities, signal: input.signal, ...input.toolContext };
  const offered = await toolRegistry.execute('select_music', {}, { ...base, round: 1, toolCallCount: 1 });
  await input.onMessage?.({ kind: 'assistant_tool_calls', round: 1,
    message: { role: 'assistant', content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'select_music', arguments: '{}' } }] } });
  await input.onMessage?.({ kind: 'tool_result', round: 1,
    message: { role: 'tool', tool_call_id: 's1', content: '{}' }, outcome: offered });
  if (offered.code !== 'MUSIC_CANDIDATES_OFFERED') return { finalText: '没有候选。', rounds: 1, messages: [], outcomes: [offered], finishReason: 'stop' };
  // 窗口大小随队列收缩：stub 模型只在这一轮真正存在的序号里选。
  const available = offered.facts?.candidates?.length || offered.facts?.candidateCount || 0;
  const chosen = indexes.filter(index => index <= available).slice(0, 10);
  if (!chosen.length) chosen.push(1);
  const args = { offerId: offered.facts.offerId, indexes: chosen };
  const committed = await toolRegistry.execute('commit_music_selection', args, { ...base, round: 2, toolCallCount: 1 });
  await input.onMessage?.({ kind: 'assistant_tool_calls', round: 2,
    message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'commit_music_selection', arguments: JSON.stringify(args) } }] } });
  await input.onMessage?.({ kind: 'tool_result', round: 2,
    message: { role: 'tool', tool_call_id: 'c1', content: '{}' }, outcome: committed });
  return { finalText: committed.presentation?.displayText || '', rounds: 2, messages: [], outcomes: [offered, committed], finishReason: 'stop' };
}

/** 全真实链路（stub 模型回合）：受限运行器 + 真实工具 + 真实提交 + 真实 runtime。 */
function liveFixture(t, { sessionTrace = null, indexes = [1, 2], library = LIBRARY, tagStore = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-radio-prewarm-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  registry.createRadiohost({ id: 'host', displayName: '主播', voiceProfileId: 'voice-host' });
  conversationStore.createRoom({ sessionId: 'room', memberIds: ['host'] });
  const commands = [], effects = [];
  const playbackRuntime = new PlaybackRuntimeHost({ commandSink: item => commands.push(item), effectSink: item => effects.push(item) });
  const tags = tagStore || { getTags: () => ({ language: 'zh', genres: ['pop'] }), getArtistTags: () => ({ gender: 'female' }) };
  const commit = new ProgramCommitService({ playbackRuntime, queueService: { publishSnapshot() {} },
    synthesize: async () => ({ url: '/tts.mp3' }),
    resolveTrack: async (_query, { candidate }) => {
      const track = library.find(row => row.song_id === candidate.sourceSongId);
      return track ? { ...track, ok: true, url: `/audio/${track.song_id}.mp3` } : { ok: false };
    },
    validateResolvedTrack: (track, context) => validateResolvedTrackAgainstRequest(track,
      { request: context.candidateProgram.metadata.musicSelection, songTagStore: tags }) });
  const service = new MusicSelectionService({ programCommitService: commit, playbackRuntime, registry, conversationStore,
    getCandidates: async () => library, getSongTagStore: () => tags, getFamiliarArtists: () => [], getRecentPlays: () => [] });
  const toolRegistry = new VirtualPersonToolRegistry({ logger: { error() {} } });
  registerMusicTools(toolRegistry, () => service);
  const runs = [];
  let modelCalls = 0;
  const agentLoop = { run: async input => { runs.push(input); modelCalls += 1; return stubTwoStepDriver(input, toolRegistry, { indexes }); } };
  // 生产里运行器由 index.js 接线；这里等同装配，只把模型回合换成 stub。
  const host = { assembleHostContext: async () => ({ systemPrompt: 'host', messages: [], onContextUsage: null }) };
  const runner = createHostMusicRunner({ agentLoop, toolRegistry, host, registry, sessionTrace });
  const radio = new RadioRequestService({ conversationService: { handleChat: () => {} }, musicService: service,
    playbackRuntime, conversationStore, getHostMusicRunner: () => runner, sessionTrace });
  t.after(() => { conversationStore.close(); registry.close(); rmSync(dir, { recursive: true, force: true }); });
  return { radio, service, playbackRuntime, conversationStore, runs, commands, effects, agentLoop, toolRegistry,
    modelCalls: () => modelCalls, runner };
}

const identityOf = h => {
  const state = h.playbackRuntime.snapshot();
  return { runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, songId: state.currentSongId,
    programId: state.txn?.programId, correlationId: state.txn?.correlationId };
};

/** 点一首歌 → 真实开播；低队列时 runtime 自己建立续播边界。 */
async function startListening(h, songId = '1') {
  const committed = await h.service.execute({ mode: 'exact', delivery: 'replace_now', count: 1,
    targets: [{ songId, source: 'qq', title: `歌${songId}`, artist: '歌手' }] },
  { sessionId: 'room', virtualPersonId: 'host', requestId: `seed-${songId}` });
  assert.equal(committed.ok, true, committed.code);
  await h.playbackRuntime.submit({ type: 'TRACK_INTRO_READY', eventId: `intro-${songId}`, text: '', ...identityOf(h) });
  await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: `started-${songId}`, ...identityOf(h) });
  return h.playbackRuntime.snapshot();
}

// 登记一批“上一首时就备好的”歌。边界正等着实时任务时 host 不预热，所以这里让预热看不到那个边界。
async function holdBatch(h) {
  const snapshot = h.playbackRuntime.snapshot.bind(h.playbackRuntime);
  h.playbackRuntime.snapshot = () => ({ ...snapshot(), pendingContinuation: null });
  try { return await h.radio.prepareContinuation(); } finally { h.playbackRuntime.snapshot = snapshot; }
}

test('the runtime low-queue boundary triggers exactly one restricted preparation run for the next boundary', async t => {
  const h = liveFixture(t);
  const state = await startListening(h);

  assert.equal(state.phase, 'playing', '当前歌照常播放');
  assert.equal(state.pendingContinuation?.status, 'requested',
    '真实 runtime 的低队列检测（与今天请求续播同一条 REQUEST_CONTINUATION 路径）');
  assert.ok(h.effects.some(effect => effect.type === 'REQUEST_CONTINUATION'), '低队列边界已经发出');

  assert.equal((await h.radio.prepareContinuation()).code, 'HOST_BUSY', '这个边界归实时任务，host 不同时想两批歌');
  assert.equal(h.runs.length, 0);
  const live = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${state.pendingContinuation.boundaryKey}` });
  assert.equal(live.ok, true, live.code);
  assert.equal(h.runs.length, 1);
  h.runs.length = 0;

  const before = h.playbackRuntime.snapshot();
  const commandsBefore = h.commands.length;
  const result = await h.radio.prepareAfterBoundary({ sessionId: 'room' });

  assert.equal(result.ok, true, result.code);
  assert.equal(result.boundaryKey, null, '预热批次记录为“接受第一个到来的边界”');
  assert.equal(h.runs.length, 1, '预热就是同一个主 Agent 的一次受限任务');
  assert.deepEqual(h.runs[0].toolNames, ['select_music', 'commit_music_selection']);
  assert.equal(h.runs[0].toolContext.musicTaskRequest.mode, 'preparation');
  assert.equal(h.runs[0].toolContext.musicTaskRequest.resolveOnly, true);
  assert.equal(h.runs[0].toolContext.preparedFor.listeningSessionId, 'room');
  assert.equal(h.runs[0].toolContext.preparedFor.outputGeneration, before.outputGeneration);
  assert.equal(h.runs[0].toolContext.preparedFor.boundaryKey, null, '绝不绑定实时任务正在解析的边界');
  assert.deepEqual(h.playbackRuntime.snapshot(), before, '预热绝不触碰播放器');
  assert.equal(h.commands.length, commandsBefore, '预热不产生任何播放命令');
  assert.equal(h.service.preparedStats().prepared, 1);
  assert.equal(h.service.prepared.listReady({ sessionId: 'room', personId: 'host' }).length, 1);
});

test('prewarm bound to no boundary is adopted at the next boundary with zero model calls and zero agent runs', async t => {
  const h = liveFixture(t);
  const state = await startListening(h);
  const boundaryKey = state.pendingContinuation.boundaryKey;
  // 生产顺序：边界 N 的实时任务先落定，host 空下来才预热“下一个边界”。
  const live = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${boundaryKey}` });
  const prepared = await h.radio.prepareAfterBoundary({ sessionId: 'room' });

  assert.equal(live.ok, true, live.code);
  assert.equal(live.code, 'MUSIC_COMMITTED');
  assert.equal(prepared.ok, true, prepared.code);
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.boundaryKey, null, '预热批次面向下一个边界，不绑定正在解析的边界');
  assert.equal(h.runs.length, 2, '边界 N：一次实时任务 + 一次预热任务');
  assert.equal(h.service.preparedStats().consumed, 0, '边界 N 没有采用任何批次');
  const hold = h.service.prepared.listReady({ sessionId: 'room', personId: 'host' });
  assert.equal(hold.length, 1);
  assert.equal(hold[0].boundaryKey, null, '挂起批次接受第一个到来的边界');

  // 真实自然播完：下一个边界 N+1 到来，挂起的批次在这里零模型调用地采用。
  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'ended-next', natural: true, ...identityOf(h) });
  const nextBoundary = h.playbackRuntime.snapshot().pendingContinuation?.boundaryKey;
  assert.ok(nextBoundary && nextBoundary !== boundaryKey, '下一次低队列建立了新边界');
  const resolveCalls = [];
  const resolveTrack = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (...args) => {
    resolveCalls.push(args[1]?.candidate?.sourceSongId ?? null);
    return resolveTrack(...args);
  };
  const runsBefore = h.runs.length;
  const fallbackBefore = h.service.preparedStats().fallback;
  const adopted = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${nextBoundary}` });

  assert.equal(adopted.ok, true, adopted.code);
  assert.equal(adopted.code, 'MUSIC_COMMITTED');
  assert.equal(h.runs.length, runsBefore, '边界 N+1 采用挂起批次：零模型调用、零 Agent 运行');
  assert.deepEqual(resolveCalls, ['4'], '采用时仍然逐首重新做 canonical 解析');
  assert.equal(h.service.preparedStats().consumed, 1);
  assert.equal(h.service.preparedStats().fallback, fallbackBefore, '边界 N+1 没有回落到实时选歌');
  assert.ok(h.playbackRuntime.snapshot().queue.some(track => track.songId === '4'), '挂起批次已经进队列');
});

for (const trigger of ['natural-end', 'manual-retry']) {
  test(`失败期间准备的批次可在 ${trigger} 新请求中采用，不继承旧请求身份`, async t => {
    const h = liveFixture(t);
    const initial = await startListening(h);
    const oldKey = initial.pendingContinuation.boundaryKey;
    await h.playbackRuntime.submit({ type: 'CONTINUATION_FAILED', eventId: 'look-ahead-failed',
      boundaryKey: oldKey, error: 'resource-unavailable' });
    assert.equal(h.playbackRuntime.snapshot().pendingContinuation.status, 'failed');
    const prepared = await h.radio.prepareContinuation();
    assert.equal(prepared.prepared, true, prepared.code);
    assert.equal(prepared.boundaryKey, null, '预热面向下一次请求，不绑定已经失败的旧 key');
    assert.equal(h.service.prepared.get(prepared.preparedId).boundaryKey, null);
    const progress = await h.playbackRuntime.submit({ type: 'POSITION_REPORTED', eventId: 'progress-after-prewarm',
      positionSeconds: 30, ...identityOf(h) });
    assert.equal(progress.accepted, true, progress.reason);
    const requested = await h.playbackRuntime.submit({
      ...(trigger === 'natural-end' ? { type: 'TRACK_ENDED', natural: true } : { type: 'RETRY_REQUESTED' }),
      eventId: `next-${trigger}`, ...identityOf(h) });
    assert.equal(requested.accepted, true, requested.reason);
    const nextKey = requested.state.pendingContinuation.boundaryKey;
    assert.notEqual(nextKey, oldKey, '继续生成新的请求身份，不能为复用预热而复活旧请求');
    await h.playbackRuntime.submit({ type: 'CONTINUATION_FAILED', eventId: 'late-old-failure',
      boundaryKey: oldKey, error: 'late-failure' });
    assert.equal(h.playbackRuntime.snapshot().pendingContinuation.status, 'requested');
    assert.equal(h.playbackRuntime.snapshot().pendingContinuation.boundaryKey, nextKey);
    const runs = h.runs.length;
    const adopted = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: initial.outputGeneration,
      requestId: `runtime-continuation:${nextKey}` });
    assert.equal(adopted.code, 'MUSIC_COMMITTED');
    assert.equal(h.runs.length, runs, '有效预热零模型回合采用，不再回落实时选歌');
    assert.equal(h.service.preparedStats().consumed, 1);
    assert.equal(h.service.preparedStats().mismatch, 0);
    assert.equal(h.service.prepared.get(prepared.preparedId).status, 'consumed');
    assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '2', '3']);
    if (trigger === 'manual-retry') assert.equal(h.playbackRuntime.snapshot().currentSongId, '1', '播放中的重试只追加、不切歌');
  });
}

test('续播的软锚点只跟当前这首：存回计划的偏好歌手不随每个边界累积', async t => {
  const library = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((artist, index) => ({ song_id: String(index + 1),
    title: `歌${index + 1}`, artist: `歌手${artist}`, source: 'qq', album: '录音室' }));
  const h = liveFixture(t, { library, indexes: [1] });
  const state = await h.service.execute({ mode: 'exact', delivery: 'replace_now', count: 1,
    targets: [{ songId: '1', source: 'qq', title: '歌1', artist: '歌手A' }] },
  { sessionId: 'room', virtualPersonId: 'host', requestId: 'seed-1' });
  assert.equal(state.ok, true, state.code);
  await h.playbackRuntime.submit({ type: 'TRACK_INTRO_READY', eventId: 'intro-1', text: '', ...identityOf(h) });
  await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: 'started-1', ...identityOf(h) });
  const playedArtists = [];
  for (let round = 0; round < 4; round += 1) {
    const snapshot = h.playbackRuntime.snapshot();
    const boundaryKey = snapshot.pendingContinuation?.boundaryKey;
    assert.ok(boundaryKey, `第 ${round + 1} 个边界已建立`);
    playedArtists.push(snapshot.queue[snapshot.currentIndex].artist);
    const result = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: snapshot.outputGeneration,
      requestId: `runtime-continuation:${boundaryKey}` });
    assert.equal(result.ok, true, result.code);
    const locked = h.runs.at(-1).toolContext.musicTaskRequest.request;
    assert.equal(locked.preferredArtists[0], playedArtists.at(-1), '这一轮的软锚点是正在放的这首');
    assert.deepEqual(h.playbackRuntime.snapshot().listeningPlan.request.preferredArtists, ['歌手A'],
      '存回的计划只留用户当初点的歌手，不把每个边界的锚点叠进去');
    await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: `ended-${round}`, natural: true, ...identityOf(h) });
    await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: `started-next-${round}`, ...identityOf(h) });
  }
  assert.ok(new Set(playedArtists).size > 1, '确实换过歌手，才测得出累积');

  // 预热采用走另一条提交路径，同样只存不带锚点的计划。
  const prepared = await holdBatch(h);
  assert.equal(prepared.prepared, true, prepared.code);
  const snapshot = h.playbackRuntime.snapshot();
  const runsBefore = h.runs.length;
  const adopted = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: snapshot.outputGeneration,
    requestId: `runtime-continuation:${snapshot.pendingContinuation.boundaryKey}` });
  assert.equal(adopted.ok, true, adopted.code);
  assert.equal(h.runs.length, runsBefore, '这次是采用预热批次');
  assert.deepEqual(h.playbackRuntime.snapshot().listeningPlan.request.preferredArtists, ['歌手A']);
});

test('a stale batch is discarded and the boundary falls back to the live run exactly once', async t => {
  const h = liveFixture(t);
  const state = await startListening(h);
  const generation = state.outputGeneration;
  // 陈旧批次：请求签名与当前边界不同源（模拟条件已经变化后留下的旧候选）。
  const staleOffer = h.service.offers.create({ sessionId: 'room', personId: 'host',
    request: normalizeMusicSelection({ mode: 'discovery', delivery: 'append', count: 2,
      constraints: { tags: { language: 'yue' } } }), candidates: LIBRARY });
  assert.equal(h.service.offers.holdForPreparation(staleOffer.offerId, { indexes: [1],
    preparedFor: { listeningSessionId: 'room', outputGeneration: generation, boundaryKey: null } }), true);
  const saved = h.service.savePreparedBatch({ offerId: staleOffer.offerId, indexes: [1], sessionId: 'room', personId: 'host' });
  assert.equal(saved.ok, true, saved.code);
  assert.equal(h.service.prepared.listReady({ sessionId: 'room', personId: 'host' }).length, 1);

  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'ended-stale', natural: true, ...identityOf(h) });
  const boundaryKey = h.playbackRuntime.snapshot().pendingContinuation?.boundaryKey;
  const runsBefore = h.runs.length;
  const result = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: generation,
    requestId: `runtime-continuation:${boundaryKey}` });

  assert.equal(result.ok, true, result.code);
  assert.equal(h.runs.length, runsBefore + 1, '失配只回落到一次实时选歌，不再跑第二个运行器');
  assert.ok(h.service.preparedStats().mismatch >= 1);
  assert.equal(h.service.prepared.listReady({ sessionId: 'room', personId: 'host' }).length, 0, '失配批次被丢弃');
  assert.equal(h.service.prepared.get(saved.preparedId).status, 'failed');
});

test('a fresh hold blocks a second prewarm for the same generation until it is consumed', async t => {
  const h = liveFixture(t);
  const state = await startListening(h);
  const first = await holdBatch(h);
  assert.equal(first.ok, true, first.code);
  assert.equal(h.runs.length, 1);

  const second = await holdBatch(h);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'PREPARATION_ALREADY_HELD');
  assert.equal(h.runs.length, 1, '已有待采用批次时不再跑第二个模型任务');

  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'ended-held', natural: true, ...identityOf(h) });
  const boundaryKey = h.playbackRuntime.snapshot().pendingContinuation?.boundaryKey;
  const adopted = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${boundaryKey}` });
  assert.equal(adopted.ok, true, adopted.code);
  assert.equal(h.service.preparedStats().consumed, 1);

  const third = await holdBatch(h);
  assert.equal(third.ok, true, third.code);
  assert.equal(h.runs.length, 2, '批次被采用之后，下一次预热不再被去重闸门挡住');
});

test('host 正忙或边界正等着实时任务时预热跳过，不跑第二个选歌回合', async () => {
  const h = fixture();
  h.state.pendingContinuation = { boundaryKey: 'b-live', status: 'requested' };
  assert.equal((await h.service.prepareContinuation()).code, 'HOST_BUSY');
  h.state.pendingContinuation = null;
  h.runner.isBusy = () => true;
  assert.equal((await h.service.prepareContinuation()).code, 'HOST_BUSY');
  assert.equal(h.calls.length, 0);
});

test('边界落定之后：等 host 写完串词才预热，等待期间失效就不跑', async () => {
  const h = fixture();
  h.runner.run = async input => { h.calls.push(input); return { ok: true, code: 'MUSIC_CANDIDATES_SELECTED', offerId: 'offer:prewarm' }; };
  let idle;
  h.runner.whenIdle = () => new Promise(resolve => { idle = resolve; });
  const waiting = h.service.prepareAfterBoundary({ sessionId: 'a' });
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 0, 'host 还在写串词');
  idle();
  assert.equal((await waiting).ok, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].mode, 'preparation');
  assert.equal(h.calls[0].context.preparedFor.boundaryKey, null, '接受第一个到来的边界');

  h.calls.length = 0;
  h.runner.whenIdle = () => Promise.resolve();
  assert.equal((await h.service.prepareAfterBoundary({ sessionId: 'a', isCurrent: () => false })).code, 'STALE_BOUNDARY');
  assert.equal(h.calls.length, 0);
});

test('a consumed prepared batch falls back to the live runner path at the next boundary', async t => {
  const h = liveFixture(t);
  const state = await startListening(h);
  const boundaryKey = state.pendingContinuation.boundaryKey;
  assert.equal((await holdBatch(h)).ok, true);

  // 第一个边界：采用批次（零模型调用）。
  const adopted = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${boundaryKey}` });
  assert.equal(adopted.ok, true, adopted.code);
  assert.equal(h.runs.length, 1);
  assert.equal(h.service.preparedStats().consumed, 1);

  // 第二首激活时 runtime 再次低队列：新边界，但没有可用批次了。
  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'ended-2', natural: true, ...identityOf(h) });
  const secondBoundary = h.playbackRuntime.snapshot().pendingContinuation?.boundaryKey;
  assert.ok(secondBoundary && secondBoundary !== boundaryKey, '下一次低队列建立了新边界');
  const before = h.playbackRuntime.snapshot().queue.map(track => track.songId);

  const live = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${secondBoundary}` });
  assert.equal(live.ok, true, live.code);
  assert.equal(h.runs.length, 2, '没有可用批次时回到同一个受限实时运行器');
  assert.ok(h.service.preparedStats().fallback >= 1);
  assert.ok(h.playbackRuntime.snapshot().queue.length > before.length, '实时选歌照常续上');
});

test('a prepared ref that no longer resolves fails closed at the boundary without substitution or playback', async t => {
  const h = liveFixture(t);
  const state = await startListening(h);
  const boundaryKey = state.pendingContinuation.boundaryKey;
  assert.equal((await holdBatch(h)).ok, true);
  assert.equal(h.runs.length, 1);
  const before = h.playbackRuntime.snapshot().queue.map(track => track.songId);

  // 供应商资源在边界时已经不可用：canonical 解析失败。
  h.service.programCommitService.resolveTrack = async () => ({ ok: false });
  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'ended-ghost', natural: true, ...identityOf(h) });
  const result = await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${boundaryKey}` });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'MUSIC_NOT_COMMITTED');
  assert.equal(h.runs.length, 1, '解析失败不偷偷改走实时选歌，也不换一批歌');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), before, '队列没有变化');
  assert.equal(h.service.preparedStats().failed, 1);
  // 批次已作废：runtime 的有界重试会是正常的实时选歌。
  assert.equal(h.service.prepared.listReady({ sessionId: 'room', personId: 'host' }).length, 0);
});

test('recommend_only never adopts a prepared batch and never plays', async t => {
  const h = liveFixture(t);
  const state = await startListening(h);
  assert.equal((await holdBatch(h)).ok, true);
  const before = h.playbackRuntime.snapshot().queue.map(track => track.songId);

  const result = await h.radio.handleNext({ sessionId: 'room', delivery: 'recommend_only', requestId: 'ro-next' });
  assert.equal(result.ok, true, result.code);
  assert.equal(result.code, 'MUSIC_RECOMMENDED', '只推荐不播放的请求走实时运行器且不提交播放');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), before, '队列没有变化');
  assert.equal(h.service.preparedStats().consumed, 0, '预热批次没有被采用');
  assert.equal(h.service.prepared.listReady({ sessionId: 'room', personId: 'host' }).length, 1, '批次仍然有效');
  assert.equal(h.runs.length, 2, '只推荐不播放仍是一次正常实时选歌（不是预热采用）');
});

test('a second low-queue trigger does not start a duplicate preparation task', async () => {
  const h = fixture();
  let release;
  let runs = 0;
  h.runner.run = () => { runs += 1; return new Promise(resolve => { release = resolve; }); };
  const first = h.service.prepareContinuation();
  const second = await h.service.prepareContinuation();
  assert.equal(second.code, 'PREPARATION_IN_FLIGHT');
  assert.equal(runs, 1, '同一会话+输出代次一次只跑一个预热任务');
  release({ ok: true, code: 'MUSIC_CANDIDATES_SELECTED' });
  assert.equal((await first).ok, true);
  h.runner.run = input => { h.calls.push(input); return { ok: true, code: 'MUSIC_CANDIDATES_SELECTED' }; };
  assert.equal((await h.service.prepareContinuation()).ok, true, '上一个任务结束后可以再预热');
  assert.equal(h.calls[0].mode, 'preparation');
});

test('runtime-triggered continuation and prewarm tasks enter the same per-session trace', async t => {
  const entered = [];
  const traceFacade = { enter: (context, fn) => { entered.push(context); return fn(); } };
  const h = liveFixture(t, { sessionTrace: traceFacade });
  const state = await startListening(h);
  const boundaryKey = state.pendingContinuation.boundaryKey;

  await h.radio.handleContinue({ sessionId: 'room', outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${boundaryKey}` });
  await holdBatch(h);

  assert.equal(entered.length, 2, '两次运行时任务各进入一次追踪上下文');
  assert.deepEqual({ ...entered[0], requestId: 'x' }, { sessionId: 'room', requestId: 'x', roundId: null, virtualPersonId: 'host' });
  assert.equal(entered[0].requestId, `runtime-continuation:${boundaryKey}`);
  assert.equal(entered[1].sessionId, 'room');
  assert.match(entered[1].requestId, /^prewarm:/);
  assert.equal(entered[1].virtualPersonId, 'host');
});

test('续选、预热与预热需求都跟房间当前主持人，不跟上一次提交者', async () => {
  const room = { memberIds: ['radiohost:a', 'radiohost:b'], activeVirtualPersonId: 'radiohost:a' };
  const h = fixture({ curatorId: 'radiohost:b', room });
  await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4, requestId: 'next' });
  assert.equal(h.calls[0].context.virtualPersonId, 'radiohost:a');
  assert.equal(h.service.preparationDemand().context.virtualPersonId, 'radiohost:a');
  await h.service.prepareContinuation({ requestId: 'prep' });
  assert.equal(h.calls.at(-1).context.virtualPersonId, 'radiohost:a');
});

test('主持人不可用时续选交给第一个可用成员', async () => {
  const h = fixture({ curatorId: 'radiohost:a', room: { memberIds: ['radiohost:a', 'radiohost:b'], activeVirtualPersonId: 'radiohost:a' },
    isPersonAvailable: id => id !== 'radiohost:a' });
  await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4, requestId: 'next' });
  assert.equal(h.calls[0].context.virtualPersonId, 'radiohost:b');
});

test('换主持人后，旧主持人名下的预热批次不被采用，回落到实时选歌', async () => {
  const room = { memberIds: ['radiohost:a', 'radiohost:b'], activeVirtualPersonId: 'radiohost:a' };
  const h = fixture({ curatorId: 'radiohost:b', room });
  const fallbacks = [];
  const consumed = [];
  // 预热批次在旧主持人 b 名下：按 person 核对，失配即 'person'。
  h.musicService.consumePrepared = async input => {
    consumed.push(input.virtualPersonId);
    return input.virtualPersonId === 'radiohost:b'
      ? { matched: true, ok: true, result: { ok: true, adopted: true } }
      : { matched: false, reason: 'person' };
  };
  h.musicService.notePrewarmFallback = event => fallbacks.push(event.reason);
  const result = await h.service.handleContinue({ sessionId: 'a', outputGeneration: 4, requestId: 'next' });
  assert.deepEqual(consumed, ['radiohost:a']);
  assert.deepEqual(fallbacks, ['person']);
  assert.notEqual(result.adopted, true);
  assert.equal(h.calls.at(-1).context.virtualPersonId, 'radiohost:a', '回落到以现任主持人运行的实时选歌');
});

test('persisted listeningPlan with subjective vibe tags softens during continuation and unlocks adjacent or untagged tracks', async t => {
  const customLibrary = [
    { song_id: 't1', title: 'City Of Stars', artist: 'Ryan Gosling', source: 'qq', album: 'La La Land' },
    { song_id: 't2', title: '莫比乌斯号的船医', artist: '裘德', source: 'qq', album: '颁奖的时候我要缺席' },
    { song_id: 't3', title: 'Slow R&B', artist: '歌手3', source: 'qq', album: '夜色' },
    { song_id: 't4', title: 'Unlabeled Jazz', artist: '歌手4', source: 'qq', album: '微醺' },
  ];
  const tagMap = {
    t1: { language: 'english', genre: '爵士', genres: ['爵士'], tempo: 'slow', mood: '浪漫', energy: 0.3 },
    t2: { language: 'mandarin', genre: '爵士', genres: ['爵士'], tempo: 'slow', mood: '慵懒', energy: 0.3 },
    t3: { language: 'mandarin', genre: 'R&B', genres: ['R&B'], tempo: 'slow', mood: '浪漫', energy: 0.35 },
  };
  const h = liveFixture(t, {
    library: customLibrary,
    tagStore: { getTags: id => tagMap[id] || null, getArtistTags: () => null },
    indexes: [1, 2],
  });
  const offered = await h.service.execute({
    mode: 'constrained',
    delivery: 'replace_now',
    count: 2,
    constraints: { tags: { genre: '爵士', tempo: 'slow' } },
    softPreferences: '浪漫慵懒',
  }, { sessionId: 'room', virtualPersonId: 'host', requestId: 'seed-vibe-plan' });
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 2] },
    { sessionId: 'room', virtualPersonId: 'host', requestId: 'seed-vibe-plan' });
  assert.equal(committed.ok, true, committed.code);

  await h.playbackRuntime.submit({ type: 'TRACK_INTRO_READY', eventId: 'vibe-intro-1', text: '', ...identityOf(h) });
  await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: 'vibe-start-1', ...identityOf(h) });
  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'vibe-end-1', natural: true, ...identityOf(h) });
  const state = h.playbackRuntime.snapshot();
  assert.equal(state.currentSongId, 't2');
  assert.equal(state.pendingContinuation?.status, 'requested');

  const continued = await h.radio.handleContinue({
    sessionId: 'room',
    outputGeneration: state.outputGeneration,
    requestId: `runtime-continuation:${state.pendingContinuation.boundaryKey}`,
  });
  assert.equal(continued.ok, true, continued.code);
  const taskRequest = h.runs.at(-1).toolContext.musicTaskRequest.request;
  assert.equal(taskRequest.mode, 'discovery');
  assert.deepEqual(taskRequest.constraints.tags, {});
  assert.ok(taskRequest.softPreferences.includes('浪漫慵懒'));
  assert.ok(taskRequest.softPreferences.includes('爵士'));
  assert.ok(taskRequest.softPreferences.includes('慢歌'));
  assert.deepEqual(h.playbackRuntime.snapshot().queue.slice(2).map(track => track.songId).sort(), ['t3', 't4']);
});
