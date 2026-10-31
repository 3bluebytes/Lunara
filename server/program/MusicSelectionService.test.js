import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { VirtualPersonRegistry } from '../virtual-person/VirtualPersonRegistry.js';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { ProgramCommitService } from './ProgramCommitService.js';
import { MusicSelectionService } from './MusicSelectionService.js';
import { findCuratedFallbacks, validateCuratedFallback } from './curatedFallbacks.js';
import { normalizeMusicSelection, continuationSelection } from './musicSelectionRequest.js';
import { validateResolvedTrackAgainstRequest } from './programConstraintValidation.js';
import { WarmPoolService } from '../agents/WarmPoolService.js';
import { RadioRequestService } from '../requests/RadioRequestService.js';
import { saveFamiliarArtistFeedback } from './familiarArtistCadence.js';
import { offerWindowSize, normalizeOfferIndexes } from './musicSelectionOffers.js';

const library = [1, 2, 3, 4].map(id => ({ song_id: String(id), title: `歌${id}`, artist: '歌手', source: 'qq', album: id === 4 ? 'Live' : '录音室' }));
// `legacyChat` 刻意保留：构造器已不再接收模型句柄，传进去也只是证明它不会被使用。
function fixture(t, { continuationCandidates = null, userCandidates = null, getMemoryService = undefined, getTags = null,
  getFamiliarArtists = () => [], getRecentPlays = null, legacyChat = null, searchArtistCatalog = null, now = Date.now,
  preResolveConcurrency = 0, albums = null, tagStore = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-music-contract-'));
  const dbPath = join(dir, 'state.db');
  const registry = new VirtualPersonRegistry({ dbPath }).initialize();
  const conversationStore = new ConversationStore({ dbPath }).initialize();
  for (const id of ['a', 'b', 'c']) registry.createRadiohost({ id, displayName: id, voiceProfileId: `voice-${id}` });
  conversationStore.createRoom({ sessionId: 'room', memberIds: ['a', 'b', 'c'] });
  conversationStore.createRoom({ sessionId: 'other', memberIds: ['b'] });
  const commands = [], effects = [], tts = [];
  const playbackRuntime = new PlaybackRuntimeHost({ commandSink: item => commands.push(item), effectSink: item => effects.push(item) });
  const tags = tagStore || (getTags
    ? { getTags, getArtistTags: () => ({ gender: 'female' }) }
    : { getTags: () => ({ language: 'zh', genres: ['pop'], artist_key: 'artist' }), getArtistTags: () => ({ gender: 'female' }) });
  const resolveLibrary = continuationCandidates ? [...library, ...continuationCandidates] : library;
  const commit = new ProgramCommitService({ playbackRuntime, queueService: { publishSnapshot() {} },
    synthesize: async text => { tts.push(text); return { url: '/tts.mp3' }; },
    resolveTrack: async (_query, { candidate }) => {
      const track = resolveLibrary.find(row => row.song_id === candidate.sourceSongId || candidate.query.includes(row.title));
      return track ? { ...track, ok: true, url: `/audio/${track.song_id}.mp3` } : { ok: false };
    }, validateResolvedTrack: (track, context) => validateResolvedTrackAgainstRequest(track, {
      request: context.candidateProgram.metadata.musicSelection, songTagStore: tags,
    }),
  });
  const service = new MusicSelectionService({ programCommitService: commit, playbackRuntime, registry, conversationStore,
    getMemoryService,
    getCandidates: async ({ reason } = {}) => (reason === 'auto_continue'
      ? (continuationCandidates || library) : (userCandidates || library)),
    getSongTagStore: () => tags, getFamiliarArtists, getRecentPlays, chat: legacyChat, searchArtistCatalog, now,
    getAlbumTracks: albums ? async ({ source, albumId, limit = 200, offset = 0 }) => {
      const rows = (albums[`${source}:${albumId}`] || []).slice(offset, offset + limit);
      if (!rows.length) return { ok: false, data: { reason: 'album_unavailable', source, albumId } };
      return { ok: true, data: { matches: [{ source, album: { source, albumId },
        tracks: rows.map(row => ({ ...row, source })) }] } };
    } : null,
    preResolveConcurrency });
  t.after(() => { conversationStore.close(); registry.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, playbackRuntime, conversationStore, registry, commands, effects, tts };
}
const exact = (id, delivery = 'replace_now') => ({ mode: 'exact', delivery, count: 1,
  targets: [{ songId: String(id), source: 'qq', title: `歌${id}`, artist: '歌手' }] });
const context = requestId => ({ sessionId: 'room', virtualPersonId: 'a', requestId });

/** 候选身份取自 fixture 曲库（song_id 1..4），保证 canonical 解析与显式匹配可核对。 */
const candidatesOf = (...ids) => ids.map(id => ({ song_id: String(id), title: `歌${id}`, artist: '歌手', source: 'qq:library' }));

/**
 * 用真实的 select_music/commit_music_selection 契约替真实 AgentLoop，驱动续播链路。
 * 运行器只允许在锁定请求上选序号，与生产运行器同形（toolContext.musicTaskRequest）。
 */
function agentRunnerStub(service, { indexes = null } = {}) {
  return {
    run: async ({ request, reason, sessionId, signal, isCurrent, context = null }) => {
      const toolContext = {
        sessionId, virtualPersonId: context?.virtualPersonId || null,
        requestId: context?.requestId || `stub:${reason}`,
        reason, signal, isCurrent,
        outputGeneration: context?.outputGeneration,
        musicTaskRequest: { request, reason, sessionId, isCurrent },
      };
      const offered = await service.execute({}, toolContext);
      if (offered.ok !== true) return { ok: false, code: offered.code || 'NO_MATCHING_CANDIDATES' };
      // 默认最多选窗口前三首，与生产运行器里“模型选序号”的位置一致。
      const chosen = indexes || offered.offer.candidates.map(candidate => candidate.index).slice(0, 3);
      const committed = await service.commitSelection({ offerId: offered.offerId, indexes: chosen }, toolContext);
      return committed.ok === true
        ? { ok: true, code: committed.code, tracks: committed.tracks, delivery: committed.delivery }
        : { ok: false, code: committed.code, message: committed.message };
    },
  };
}

/** 把当前歌沿真实 runtime 事件播完（内含激活下一首），供需要推进 currentIndex 的用例复用。 */
async function playCurrentThrough(h, label) {
  const identify = () => {
    const state = h.playbackRuntime.snapshot();
    return { runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
      outputGeneration: state.outputGeneration, songId: state.currentSongId,
      programId: state.txn?.programId, correlationId: state.txn?.correlationId };
  };
  await h.playbackRuntime.submit({ type: 'TRACK_INTRO_READY', eventId: `intro-${label}`, text: '', ...identify() });
  await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: `started-${label}`, ...identify() });
  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: `ended-${label}`, natural: true, ...identify() });
  await new Promise(resolve => setImmediate(resolve));
}

test('curated selection carries candidate provenance through the commit proposal', async t => {
  const h = fixture(t, { userCandidates: [{ song_id: 'new-id', title: '新歌', artist: '新人', source: 'qq:discovery' }] });
  const selected = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 1 }, context('origin'));
  assert.equal(selected.ok, true);
  assert.equal(selected.candidates[0].evidence.source, 'qq');
  assert.equal(selected.candidates[0].evidence.candidateOrigin, 'qq:discovery');
});

test('open-ended selection never calls a hidden chooser model（回归：去掉工具内的选歌模型调用）', async t => {
  const seen = [];
  const h = fixture(t, {
    userCandidates: [
      { song_id: 'c-1', title: '歌一', artist: '歌手一', source: 'qq:library' },
      { song_id: 'c-2', title: '歌二', artist: '歌手二', source: 'qq:library' },
    ],
    legacyChat: async (_messages, _tools, options) => { seen.push(options); return { message: { content: '{"indexes":[1]}' } }; },
  });
  const selection = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 1 }, context('no-chooser'));
  assert.equal(seen.length, 0, '候选再多也不能触发任何隐藏模型调用');
  assert.equal('chat' in h.service, false, '选歌服务不再持有聊天模型句柄');
  assert.equal(selection.ok, true);
  assert.equal(selection.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(selection.offer.candidates.length, 2, '候选窗口原样交给本轮 Agent');
});

test('a two-step select→commit plays only the numbered candidates the Agent chose', async t => {
  const candidates = candidatesOf(1, 2, 3);
  const h = fixture(t, { userCandidates: candidates, continuationCandidates: candidates });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 3 }, context('two-step'));
  assert.equal(offered.ok, true, offered.code);
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(offered.offer.candidates.length, 3);
  assert.deepEqual(offered.offer.candidates.map(item => [item.index, item.songId]),
    [[1, '1'], [2, '2'], [3, '3']]);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, '候选 offer 绝不改播放器');

  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [3, 1] }, context('two-step'));
  assert.equal(committed.ok, true, committed.code);
  assert.equal(committed.code, 'MUSIC_COMMITTED');
  assert.equal(committed.terminal, true, '播放提交是终止性动作');
  assert.equal(committed.userMessage, '好，《歌1》和《歌3》都安排上了。', '固定文案也说出排了哪几首');
  assert.deepEqual(committed.tracks.map(track => track.songId), ['1', '3'], '只提交选中的序号');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '3']);
  assert.equal(h.service.offers.get(offered.offerId).status, 'consumed', 'offer 单次使用');

  // 提交过的 offer 不能再被使用，也不能第二次改播放器。
  const again = await h.service.commitSelection({ offerId: offered.offerId, indexes: [2] }, context('two-step-2'));
  assert.equal(again.ok, false);
  assert.equal(again.code, 'SELECTION_OFFER_UNAVAILABLE');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '3']);
});

test('a same-round replay returns the stored commit result instead of playing twice', async t => {
  const candidates = candidatesOf(2);
  const h = fixture(t, { userCandidates: candidates, continuationCandidates: candidates });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('replay-round'));
  const first = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('replay-round'));
  assert.equal(first.ok, true);
  const replay = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('replay-round'));
  assert.equal(replay.replayed, true, '同一轮重放返回收据里的结果');
  assert.equal(replay.code, 'MUSIC_COMMITTED');
  assert.match(replay.message, /不再重复修改播放器/u);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 1, '重放不产生第二次提交');
});

test('offer commits reject bad indexes, foreign, expired and unknown offers without touching playback', async t => {
  const candidates = candidatesOf(1, 2);
  const h = fixture(t, { userCandidates: candidates, continuationCandidates: candidates });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, context('guards'));
  const before = h.playbackRuntime.snapshot();

  const duplicates = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 1] }, context('guards'));
  assert.equal(duplicates.code, 'INVALID_SELECTION_INDEXES');
  const outOfRange = await h.service.commitSelection({ offerId: offered.offerId, indexes: [3] }, context('guards'));
  assert.equal(outOfRange.code, 'INVALID_SELECTION_INDEXES');
  const foreignRoom = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] },
    { sessionId: 'other', virtualPersonId: 'b', requestId: 'guards' });
  assert.equal(foreignRoom.code, 'SELECTION_OFFER_UNAVAILABLE');
  const foreignPerson = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] },
    { sessionId: 'room', virtualPersonId: 'b', requestId: 'guards' });
  assert.equal(foreignPerson.code, 'SELECTION_OFFER_UNAVAILABLE');
  const foreignRequest = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] },
    { sessionId: 'room', virtualPersonId: 'a', requestId: 'another-round' });
  assert.equal(foreignRequest.code, 'SELECTION_OFFER_UNAVAILABLE', '另一轮请求不能消费这一轮的候选');
  const unknown = await h.service.commitSelection({ offerId: 'offer:nope', indexes: [1] }, context('guards'));
  assert.equal(unknown.code, 'SELECTION_OFFER_UNAVAILABLE');
  assert.deepEqual(h.playbackRuntime.snapshot(), before, '以上失败都没有触碰播放器');
  assert.deepEqual(h.commands, []);
  assert.equal(h.service.offers.get(offered.offerId).status, 'open', '无副作用的失败不消耗 offer');

  // 过期：直接把 expires_at 拨到过去，提交必须 fail closed。
  h.conversationStore.db.prepare('UPDATE music_selection_offers SET expires_at = ? WHERE offer_id = ?')
    .run(Date.now() - 1, offered.offerId);
  const expired = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('guards'));
  assert.equal(expired.code, 'SELECTION_OFFER_UNAVAILABLE');
  assert.deepEqual(h.playbackRuntime.snapshot(), before);

  // 失败后可修正：同一 offer 仍然可用。
  h.conversationStore.db.prepare('UPDATE music_selection_offers SET expires_at = ? WHERE offer_id = ?')
    .run(Date.now() + 600_000, offered.offerId);
  const fixed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [2] }, context('guards'));
  assert.equal(fixed.ok, true);
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '2');
});

test('a batch with one unplayable pick commits the playable ones in order and names the rest', async t => {
  const h = fixture(t);
  const calls = [], traces = [];
  h.service.trace = event => traces.push(event);
  h.service.programCommitService.trace = event => traces.push(event);
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    calls.push(options.candidate.sourceSongId);
    if (options.candidate.sourceSongId === '2') throw new Error('https://secret.test?cookie=private');
    return resolve(query, options);
  };
  const input = context('partial-batch');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 3 }, input);
  const result = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 2, 3] }, input);
  assert.equal(result.ok, true, '成功多少交多少');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '3'], '按原顺序，不找替补');
  assert.deepEqual(result.unavailable.map(item => item.title), ['歌2']);
  assert.match(result.message, /歌2/);
  assert.match(result.userMessage, /歌2.*放不了.*2 首.*没有用别的歌顶替/);
  assert.doesNotMatch(JSON.stringify({ result, traces }), /secret|private|cookie|https:/);
  for (const table of ['music_selection_offers', 'music_action_receipts', 'music_selections']) {
    assert.doesNotMatch(JSON.stringify(h.conversationStore.db.prepare(`SELECT * FROM ${table}`).all()), /\/audio\//);
  }
});

test('a batch where nothing plays still fails with failedItems and leaves the queue unchanged', async t => {
  const h = fixture(t);
  h.service.programCommitService.resolveTrack = async () => { throw new Error('https://secret.test?cookie=private'); };
  const input = context('all-failed');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 3 }, input);
  const failed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 2] }, input);
  assert.equal(failed.ok, false);
  assert.equal(failed.offerId, offered.offerId);
  assert.deepEqual(failed.failedItems.map(item => item.index), [1, 2]);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.doesNotMatch(JSON.stringify(failed), /secret|private|cookie|https:/);
});

/** 让后台预解析把已排队的工作跑完。 */
const drain = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('offered candidates are pre-resolved in the background and commit reuses them after revalidation', async t => {
  const h = fixture(t, { preResolveConcurrency: 2 });
  const calls = [], traces = [];
  let active = 0, peak = 0;
  h.service.programCommitService.trace = event => traces.push(event);
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    calls.push(options.candidate.sourceSongId);
    active++; peak = Math.max(peak, active);
    await new Promise(r => setImmediate(r));
    active--;
    return resolve(query, options);
  };
  const input = context('pre-resolve');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, input);
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, '预解析不碰播放器');
  await drain();
  assert.deepEqual([...calls].sort(), ['1', '2', '3', '4']);
  assert.ok(peak <= 2, `并发上限 ${peak}`);
  let validations = 0;
  const validate = h.service.programCommitService.validateResolvedTrack;
  h.service.programCommitService.validateResolvedTrack = (...args) => { validations++; return validate(...args); };
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [3] }, input);
  assert.equal(committed.ok, true, committed.code);
  assert.equal(calls.length, 4, '提交复用预解析结果，不再请求音乐源');
  assert.equal(validations, 1, '复用结果仍逐项校验约束');
  assert.ok(traces.some(event => event.event === 'program-resolution-reused'));
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['3']);
  for (const table of ['music_selection_offers', 'music_action_receipts', 'music_selections']) {
    assert.doesNotMatch(JSON.stringify(h.conversationStore.db.prepare(`SELECT * FROM ${table}`).all()), /\/audio\//);
  }
});

test('a commit waits for an in-flight pre-resolution instead of requesting the source twice', async t => {
  const h = fixture(t, { preResolveConcurrency: 4 });
  const calls = [];
  const gates = new Map();
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = (query, options) => {
    const id = options.candidate.sourceSongId;
    calls.push(id);
    return new Promise(done => gates.set(id, () => done(resolve(query, options))));
  };
  const input = context('pre-resolve-inflight');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, input);
  await drain();
  const committing = h.service.commitSelection({ offerId: offered.offerId, indexes: [2] }, input);
  await drain();
  assert.equal(calls.filter(id => id === '2').length, 1);
  for (const open of gates.values()) open();
  const committed = await committing;
  assert.equal(committed.ok, true, committed.code);
  assert.equal(calls.filter(id => id === '2').length, 1);
});

test('a failed pre-resolution falls back to normal resolution at commit', async t => {
  const h = fixture(t, { preResolveConcurrency: 2 });
  const calls = [];
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    const id = options.candidate.sourceSongId;
    calls.push(id);
    if (id === '2' && calls.filter(item => item === '2').length === 1) return { ok: false };
    return resolve(query, options);
  };
  const input = context('pre-resolve-miss');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, input);
  await drain();
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [2] }, input);
  assert.equal(committed.ok, true, committed.code);
  assert.equal(calls.filter(id => id === '2').length, 2);
});

test('prewarm offers that only pick indexes are not pre-resolved', async t => {
  const h = fixture(t, { preResolveConcurrency: 2 });
  const calls = [];
  h.service.programCommitService.resolveTrack = async (_query, options) => { calls.push(options.candidate.sourceSongId); return { ok: false }; };
  const request = { mode: 'discovery', delivery: 'append', count: 1 };
  const offered = await h.service.execute(request, { ...context('prewarm-offer'), musicTaskRequest: { request, resolveOnly: true } });
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  await drain();
  assert.deepEqual(calls, []);
});

/**
 * 预置同一 offer 的跨提交解析缓存：部分提交后「有成功项但整批失败」的提交不再存在，
 * 这里按提交时同形的候选直接走生产缓存（命中则不再解析），只用于检查缓存边界。
 */
const primeResolutionCache = async (h, offerId, input, indexes) => {
  const offer = h.service.offers.get(offerId);
  const context = h.service._executionContext(input, null);
  const cache = h.service._offerResolutionCache(offer, context, input);
  const { candidates } = h.service._targetSelection(h.service._exactRequestFromOffer(offer, indexes), context);
  for (const candidate of candidates) {
    if (cache.get(candidate)) continue;
    const result = await h.service.programCommitService.resolveTrack(candidate.query, { candidate, attempt: 1 });
    if (result?.ok) cache.set(candidate, result);
  }
};

test('resolution cache expires at 30 seconds without extending TTL on reuse', async t => {
  let clock = Date.now();
  const h = fixture(t, { now: () => clock });
  const calls = [];
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    calls.push(options.candidate.sourceSongId);
    return options.candidate.sourceSongId === '2' ? { ok: false } : resolve(query, options);
  };
  const input = context('ttl');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, input);
  await primeResolutionCache(h, offered.offerId, input, [1, 2]);
  clock += 29_999;
  await primeResolutionCache(h, offered.offerId, input, [1, 2]);
  assert.equal(calls.filter(id => id === '1').length, 1, '30 秒内命中');
  clock += 1;
  await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, input);
  assert.equal(calls.filter(id => id === '1').length, 2, '从首次写入算起 30 秒过期，命中不续期');
});

test('cached results are revalidated against changed constraints and canonical identity', async t => {
  for (const kind of ['constraints', 'identity']) {
    const h = fixture(t);
    const input = context(`revalidate-${kind}`);
    const resolve = h.service.programCommitService.resolveTrack;
    let successes = 0;
    h.service.programCommitService.resolveTrack = async (query, options) => {
      if (options.candidate.sourceSongId === '2') return { ok: false };
      successes++; return resolve(query, options);
    };
    const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, input);
    await primeResolutionCache(h, offered.offerId, input, [1, 2]);
    if (kind === 'constraints') h.service.programCommitService.validateResolvedTrack = () => ({ ok: false });
    else {
      const original = h.service._targetSelection.bind(h.service);
      h.service._targetSelection = (...args) => {
        const selected = original(...args);
        selected.candidates[0].sourceSongId = '3';
        return selected;
      };
    }
    const rejected = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, input);
    assert.equal(rejected.ok, false, kind);
    assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
    assert.equal(successes, kind === 'constraints' ? 1 : 2);
  }
});

test('cached successes cannot bypass final member, owner or cancellation guards', async t => {
  for (const kind of ['member', 'owner', 'cancel']) {
    const h = fixture(t);
    const controller = new AbortController();
    const groupAction = { ownerId: 'a', recommendations: [] };
    const input = { ...context(`final-${kind}`), groupAction, signal: controller.signal };
    const resolve = h.service.programCommitService.resolveTrack;
    h.service.programCommitService.resolveTrack = async (query, options) => options.candidate.sourceSongId === '2'
      ? { ok: false } : resolve(query, options);
    const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, input);
    await primeResolutionCache(h, offered.offerId, input, [1, 2]);
    h.service.programCommitService.validateResolvedTrack = () => {
      if (kind === 'member') h.conversationStore.removeMember('room', 'b');
      if (kind === 'owner') groupAction.ownerId = 'c';
      if (kind === 'cancel') controller.abort();
      return { ok: true };
    };
    await assert.rejects(h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, input));
    assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
    assert.equal(h.conversationStore.db.prepare('SELECT count(*) AS n FROM music_selections').get().n, 0);
  }
});

test('cache is bounded and cannot reuse resources across offers or output generations', async t => {
  const h = fixture(t);
  const calls = [];
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    calls.push(options.candidate.sourceSongId);
    return options.candidate.sourceSongId === '2' ? { ok: false } : resolve(query, options);
  };
  const input = context('cache-scope');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, input);
  const fail = (offerId, extra = {}) => primeResolutionCache(h, offerId, { ...input, ...extra }, [1, 2]);
  await fail(offered.offerId, { outputGeneration: 1 });
  await fail(offered.offerId, { outputGeneration: 2 });
  const second = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, input);
  await fail(second.offerId, { outputGeneration: 2 });
  assert.equal(calls.filter(id => id === '1').length, 3, '不同 offer 或输出权限不得复用');
  for (let i = 0; i < 205; i++) {
    const offer = { ...offered.offer, offerId: `capacity-${i}` };
    const cache = h.service._offerResolutionCache(offer, h.service.context(input), input);
    cache.set({ sourceSongId: '1', evidence: { source: 'qq' } }, { ok: true, url: '/private-media.mp3' });
  }
  assert.equal(h.service._resolutionCache.size, 200, '进程缓存有固定容量上限');
});

test('cached offer failures cannot bypass foreign request, session, member or owner checks', async t => {
  const h = fixture(t);
  const input = context('cached-guards');
  const resolve = h.service.programCommitService.resolveTrack;
  let calls = 0;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    calls++;
    return options.candidate.sourceSongId === '2' ? { ok: false } : resolve(query, options);
  };
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, input);
  const args = { offerId: offered.offerId, indexes: [1, 2] };
  await primeResolutionCache(h, offered.offerId, input, [1, 2]);
  // 非负责人提交自己的 offer 不再被拒，而是登记为推荐（见下方专门的测试）；这里只看真正的拒绝。
  for (const extra of [{ requestId: 'foreign' }, { sessionId: 'other', virtualPersonId: 'b' },
    { virtualPersonId: 'b' }, { virtualPersonId: 'b', groupAction: { ownerId: 'c', recommendations: [] } }]) {
    const rejected = await h.service.commitSelection(args, { ...input, ...extra });
    assert.equal(rejected.ok, false);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(h.service.commitSelection(args, { ...input, signal: controller.signal }), { name: 'AbortError' });
  h.conversationStore.removeMember('room', 'b');
  assert.equal((await h.service.commitSelection(args, input)).ok, false);
  assert.equal(calls, 2, '所有失败都发生在解析/缓存访问之前');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
});

test('cache reuse cannot bypass the final playback guard when membership changes during validation', async t => {
  const h = fixture(t);
  const input = context('final-playback');
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => options.candidate.sourceSongId === '2'
    ? { ok: false } : resolve(query, options);
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, input);
  await primeResolutionCache(h, offered.offerId, input, [1, 2]);
  h.service.programCommitService.validateResolvedTrack = () => {
    h.conversationStore.removeMember('room', 'b'); return { ok: true };
  };
  await assert.rejects(h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, input));
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.deepEqual(h.commands, []);
});

test('a resolution failure keeps the offer open for a corrected pick but never substitutes a song', async t => {
  const h = fixture(t);
  h.service.programCommitService.findSubstitutes = findCuratedFallbacks;
  h.service.programCommitService.validateSubstitute = validateCuratedFallback;
  h.service.programCommitService.resolveTrack = async (_query, { candidate }) => {
    if (candidate.sourceSongId === '1') return { ok: false };
    const row = library.find(track => track.song_id === candidate.sourceSongId);
    return row ? { ...row, ok: true, url: `/audio/${row.song_id}.mp3` } : { ok: false };
  };
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, context('dead-url'));
  const failed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('dead-url'));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'MUSIC_NOT_COMMITTED');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, '绝不换成列表以外的歌顶替');
  assert.equal(failed.terminal, undefined, '失败不是终止性结果');
  assert.equal(h.service.musicActionStatus({ requestId: 'dead-url' }), 'failed', '失败收据允许同轮修正');
  // 同一轮用另一个序号修正：offer 没有被失败烧掉。
  const corrected = await h.service.commitSelection({ offerId: offered.offerId, indexes: [2] }, context('dead-url'));
  assert.equal(corrected.ok, true);
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '2');
});

test('a recommend_only commit resolves the picks but never touches playback', async t => {
  const candidates = [
    { song_id: 'r-1', title: '歌一', artist: '歌手一', source: 'qq' },
    { song_id: 'r-2', title: '歌二', artist: '歌手二', source: 'qq' },
  ];
  const h = fixture(t, { userCandidates: candidates, continuationCandidates: candidates });
  const before = h.playbackRuntime.snapshot();
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, context('recommend'));
  const result = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 2], delivery: 'replace_now' }, context('recommend'));
  assert.equal(result.ok, true);
  assert.equal(result.code, 'MUSIC_RECOMMENDED');
  assert.equal(result.delivery, 'recommend_only', '提交参数不能改写锁定的交付方式');
  assert.notEqual(result.terminal, true, '只推荐不是终止性动作，模型还要向用户说明');
  assert.deepEqual(h.playbackRuntime.snapshot(), before);
  assert.deepEqual(h.commands, []);
  assert.deepEqual(result.tracks.map(track => track.songId), ['r-1', 'r-2'], '仍然按 canonical 解析并留下引用');
  assert.equal(h.service.musicActionStatus({ requestId: 'recommend' }), null, '只推荐不占用本轮音乐动作收据');
  // 推荐留下的引用仍可被下一次点播消化。
  const referenced = await h.service.execute({ mode: 'exact', delivery: 'replace_now', reference: { selectionId: result.selectionId, indexes: [2] } },
    context('recommend-play'));
  assert.equal(referenced.ok, true);
  assert.equal(h.playbackRuntime.snapshot().currentSongId, 'r-2');
});

test('automated task mode locks the request so model arguments cannot rewrite it', async t => {
  const candidates = candidatesOf(1, 2);
  const h = fixture(t, { userCandidates: candidates, continuationCandidates: candidates });
  const locked = normalizeMusicSelection({ mode: 'discovery', delivery: 'replace_now', count: 2, constraints: { excludedSongIds: ['1'] } });
  const taskInput = { ...context('locked-task'), musicTaskRequest: { request: locked, reason: 'user_request', sessionId: 'room' } };
  const offered = await h.service.execute({ mode: 'exact', delivery: 'recommend_only', count: 5, targets: [{ title: '跑偏' }] }, taskInput);
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.deepEqual(offered.offer.candidates.map(item => item.songId), ['2'], '锁定请求的硬约束不被模型参数改写');
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1], delivery: 'append' }, taskInput);
  assert.equal(committed.ok, true, committed.code);
  assert.equal(committed.delivery, 'replace_now', '交付方式始终来自锁定请求');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['2']);
});

test('saved familiar-artist cadence orders the offered window and never filters candidates', async t => {
  const candidates = [
    { song_id: 'unknown', title: '新歌', artist: '新歌手', source: 'qq:discovery' },
    { song_id: 'known-1', title: '熟歌一', artist: '熟悉歌手', source: 'qq:library' },
    { song_id: 'known-2', title: '熟歌二', artist: '熟悉歌手', source: 'qq:library' },
  ];
  let plays = [];
  const h = fixture(t, { userCandidates: candidates, continuationCandidates: candidates,
    getFamiliarArtists: () => ['熟悉歌手'], getRecentPlays: () => plays });
  saveFamiliarArtistFeedback(h.conversationStore.db, { personId: 'a', sourceTurnId: 'feedback-turn',
    userText: '我不喜欢一直放不熟悉的歌手，可以偶尔穿插，频率少一点', mode: 'familiar_first' });
  const first = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 1 }, context('known-first'));
  assert.equal(first.candidates[0].sourceSongId, 'known-1', '熟悉歌手优先排在候选窗口头部');
  assert.deepEqual(first.offer.candidates.map(item => item.songId).sort(), ['known-1', 'known-2', 'unknown'],
    '节奏只改顺序，不排除任何候选');
  // 连续放了 3 首熟悉歌手之后，窗口头部轮到一个陌生歌手。
  plays = [1, 2, 3].map(index => ({ song_id: `prior-${index}`, source: 'qq', artist: '熟悉歌手', ts: Date.now() - index * 1000 }));
  const fourth = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 1 },
    { ...context('novel-fourth'), reason: 'auto_continue' });
  assert.equal(fourth.offer.candidates[0].songId, 'unknown');
  // 明确点名歌手时节奏不参与。
  const requested = await h.service.select({ mode: 'artist', artist: '新歌手', delivery: 'recommend_only', count: 1 }, context('explicit-artist'));
  assert.equal(requested.candidates[0].sourceSongId, 'unknown');
});

test('artist exclusion filters the offer window and is rechecked against the canonical recording', async t => {
  const candidates = [
    { song_id: 'zhou', title: '歌 A', artist: '周深', source: 'qq' },
    { song_id: 'other', title: '歌 B', artist: '另一位歌手', source: 'qq' },
  ];
  const h = fixture(t, { userCandidates: candidates, continuationCandidates: candidates });
  const request = { mode: 'discovery', delivery: 'replace_now', count: 1,
    constraints: { excludedArtists: ['周深'] } };
  const offered = await h.service.execute(request, context('artist-round'));
  assert.equal(offered.ok, true);
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.deepEqual(offered.offer.candidates.map(item => item.songId), ['other'], '被排除的歌手不进候选窗口');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, '候选 offer 不改播放器');

  h.service.programCommitService.resolveTrack = async () => ({ ...candidates[0], ok: true, url: '/zhou.mp3' });
  const rejected = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('artist-round'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'MUSIC_NOT_COMMITTED');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, 'canonical 身份不符时不提交');

  h.service.programCommitService.resolveTrack = async () => ({ ...candidates[1], ok: true, url: '/other.mp3' });
  const accepted = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('artist-round'));
  assert.equal(accepted.ok, true);
  assert.equal(h.playbackRuntime.snapshot().currentSongId, 'other');
});

test('the offer window keeps a two-item remainder for read-only program resolution', async t => {
  const h = fixture(t);
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, context('window-remainder'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(offered.candidates.length, 2);
  assert.equal(offered.fallbackCandidates.length, 2, '读侧（今日节目/预热池）仍能拿到窗口余量');
  const head = new Set(offered.candidates.map(item => item.sourceSongId));
  assert.ok(offered.fallbackCandidates.every(item => !head.has(item.sourceSongId)));
  const program = h.service.candidateProgram(offered, offered.context);
  assert.equal(program.mode, 'curated', '读侧的只读候选程序保持 curated 语义');
  assert.equal(program.metadata.fallbackCandidates.length, 2);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
});

test('exact selection never carries a curated backup', async t => {
  const h = fixture(t);
  const selected = await h.service.select(exact(1), context('exact-no-backup'));
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.fallbackCandidates, []);
});

test('an exact commit ends the turn with a reviewed line naming the canonical track', async t => {
  const h = fixture(t);
  const played = await h.service.execute(exact(1), context('exact-terminal'));
  assert.equal(played.code, 'MUSIC_COMMITTED');
  assert.equal(played.terminal, true);
  assert.match(played.userMessage, /《歌1》/u);
  assert.doesNotMatch(played.userMessage, /响起|正在播|在放/u);
  const recommended = await h.service.execute(exact(2, 'recommend_only'), context('exact-recommend'));
  assert.equal(recommended.code, 'MUSIC_RECOMMENDED');
  assert.notEqual(recommended.terminal, true);
});

test('a music request in another room switches immediately only when its delivery requests playback', async t => {
  const h = fixture(t);
  await h.service.execute(exact(1), context('first'));
  const other = requestId => ({ sessionId: 'other', virtualPersonId: 'b', requestId });
  await h.service.execute(exact(2, 'recommend_only'), other('recommend'));
  assert.equal(h.playbackRuntime.snapshot().activeListeningSessionId, 'room');
  await h.service.execute(exact(2, 'append'), other('enqueue'));
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '1');
  await h.service.execute(exact(3, 'replace_now'), other('listen-now'));
  assert.equal(h.playbackRuntime.snapshot().activeListeningSessionId, 'other');
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '3');
  assert.equal(h.playbackRuntime.snapshot().pendingSwitch, null);
});

test('a legacy final track continues through selection and commit; turning continuation off then stops generation', async t => {
  const h = fixture(t);
  const radio = new RadioRequestService({ musicService: h.service, playbackRuntime: h.playbackRuntime,
    conversationStore: h.conversationStore, getMusicSelectionAgent: () => agentRunnerStub(h.service) });
  const tasks = [];
  h.playbackRuntime.effectSink = effect => {
    if (effect.type === 'REQUEST_CONTINUATION') tasks.push(radio.handleContinue({
      sessionId: effect.listeningSessionId, outputGeneration: effect.outputGeneration,
      requestId: `runtime-continuation:${effect.boundaryKey}`,
    }));
  };
  await h.playbackRuntime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'legacy', delivery: 'replace_now', listeningSessionId: 'room',
    tracks: [{ songId: '1', programId: 'legacy', requestId: 'legacy', title: '歌1', artist: '歌手', source: 'qq', url: '/1.mp3', intro: { text: '' } }] });
  const identity = () => {
    const state = h.playbackRuntime.snapshot();
    return { runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration,
      songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId };
  };
  await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: 'started-legacy', ...identity() });
  await new Promise(resolve => setImmediate(resolve));
  // 单曲队列激活即提前续选；一次补足 3 首，余量回到提前量之上，再自然播完。
  assert.equal(tasks.length, 1, '激活队尾即提前续选');
  assert.equal((await tasks[0]).ok, true);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '2', '3', '4']);
  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'ended-legacy', natural: true, ...identity() });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '2');
  assert.equal(h.playbackRuntime.snapshot().phase, 'loading');
  assert.equal(tasks.length, 1, '补进的 3 首把余量抬回阈值之上，不再每次换歌都续选');
  await h.playbackRuntime.submit({ type: 'RADIO_MODE_CHANGED', eventId: 'off', enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.playbackRuntime.snapshot().pendingContinuation, null);
  // radio 关闭后把队列剩余曲目自然播完，runtime 诚实耗尽且不再发起新任务。
  for (let guard = 0; guard < 10; guard += 1) {
    if (h.playbackRuntime.snapshot().phase === 'exhausted') break;
    await h.playbackRuntime.submit({ type: 'TRACK_INTRO_READY', eventId: `intro-${guard}`, text: '', ...identity() });
    await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: `started-${guard}`, ...identity() });
    await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: `ended-${guard}`, natural: true, ...identity() });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(h.playbackRuntime.snapshot().phase, 'exhausted');
  assert.equal(tasks.length, 1, 'radio 关闭后不再发起新的续选');
});

test('auto-continue lets already-played library tracks return but never repeats a pending occurrence', async t => {
  const h = fixture(t);
  let candidateContext = null;
  h.service.getCandidates = async input => {
    candidateContext = input;
    return library;
  };
  await h.service.execute(exact(1), context('cycle-1'));
  await h.service.execute(exact(2, 'append'), context('cycle-2'));
  await h.service.execute(exact(3, 'append'), context('cycle-3'));
  await h.service.execute(exact(4, 'append'), context('cycle-4'));
  // 播到队列最后一首：歌1~歌3 已播完，待播区间只剩当前这一首。
  await playCurrentThrough(h, 'cycle-1');
  await playCurrentThrough(h, 'cycle-2');
  await playCurrentThrough(h, 'cycle-3');
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '4');

  const selection = await h.service.select({ mode: 'discovery', delivery: 'append', count: 3 }, {
    ...context('cycle-next'),
    reason: 'auto_continue',
  });
  assert.equal(selection.ok, true);
  assert.deepEqual(candidateContext, {
    reason: 'auto_continue',
    sessionId: 'room',
    virtualPersonId: 'a',
  });
  assert.deepEqual(selection.candidates.map(candidate => candidate.sourceSongId), ['1', '2', '3'],
    '已播过的老歌可以回锅');
  assert.equal(selection.candidates.some(candidate => candidate.sourceSongId === '4'), false,
    '当前/待播那一首不得被重新追加');
});

test('a single-track artist pool never gains a duplicate pending occurrence', async t => {
  const only = [{ song_id: 'only', title: '遇见', artist: '孙燕姿', source: 'qq' }];
  const h = fixture(t, { continuationCandidates: only, userCandidates: only });
  const offered = await h.service.execute({ mode: 'artist', artist: '孙燕姿', delivery: 'replace_now', count: 1 }, context('only-1'));
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('only-1'));
  assert.equal(committed.ok, true, committed.code);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['only']);
  const selection = await h.service.select({ mode: 'discovery', delivery: 'append', count: 3 }, {
    ...context('only-next'), reason: 'auto_continue',
  });
  assert.equal(selection.ok, false, '只有一件待播项可用时如实失败，而不是重复追加');
  assert.equal(selection.code, 'NO_MATCHING_CANDIDATES');
});

test('an explicit artist request searches the provider catalog when the local pool is short', async t => {
  const local = [{ song_id: 'local', title: '遇见', artist: '孙燕姿', source: 'qq' }];
  const calls = [];
  const h = fixture(t, { userCandidates: local, continuationCandidates: local,
    searchArtistCatalog: async (artist, options) => {
      calls.push({ artist, options });
      return [
        { song_id: 'cat-1', title: '我不难过', artist: '孙燕姿', source: 'qq:search' },
        { song_id: 'cat-2', title: '我不爱', artist: '孙燕姿', source: 'qq:search' },
        { song_id: 'cat-3', title: '我怀念的', artist: '孙燕姿', source: 'qq:search' },
        { song_id: 'other', title: '别人的歌', artist: '别的歌手', source: 'qq:search' },
      ];
    } });
  const selection = await h.service.select({ mode: 'artist', artist: '孙燕姿', delivery: 'recommend_only', count: 3 },
    context('catalog'));
  assert.equal(selection.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].artist, '孙燕姿');
  assert.ok(calls[0].options.limit > 0);
  assert.deepEqual(selection.candidates.map(candidate => candidate.sourceSongId), ['local', 'cat-1', 'cat-2']);
  assert.equal(selection.candidates.some(candidate => candidate.sourceSongId === 'other'), false,
    '目录里别的歌手不得混入明确点名歌手的请求');
});

test('a sufficient local pool never triggers an artist catalog search', async t => {
  let calls = 0;
  const h = fixture(t, { searchArtistCatalog: async () => { calls += 1; return []; } });
  const selection = await h.service.select({ mode: 'artist', artist: '歌手', delivery: 'recommend_only', count: 2 },
    context('no-catalog'));
  assert.equal(selection.ok, true);
  assert.equal(selection.candidates.length, 2);
  assert.equal(calls, 0, '本地池够用时不多花一次供应商搜索');
});

test('an artist request the catalog cannot extend reports the shortfall instead of substituting', async t => {
  const local = [{ song_id: 'local', title: '遇见', artist: '孙燕姿', source: 'qq' }];
  const h = fixture(t, { userCandidates: local, continuationCandidates: local,
    searchArtistCatalog: async () => { throw new Error('artist search unavailable'); } });
  const offered = await h.service.execute({ mode: 'artist', artist: '孙燕姿', delivery: 'replace_now', count: 3 },
    context('short-artist'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.deepEqual(offered.offer.candidates.map(item => item.songId), ['local'], '查不到就只给本地这一首');
  const result = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('short-artist'));
  assert.equal(result.ok, true, result.code);
  assert.equal(result.requestedCount, 1);
  assert.equal(result.selectedCount, 1);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['local']);
});

test('a soft artist preference reorders candidates without filtering or relaxing constraints', async t => {
  const candidates = [
    { song_id: 'b1', title: '别人的歌一', artist: '别的歌手', source: 'qq' },
    { song_id: 'b2', title: '别人的歌二', artist: '别的歌手', source: 'qq' },
    { song_id: 'a1', title: '孙燕姿的歌', artist: '孙燕姿', source: 'qq' },
  ];
  const h = fixture(t, { userCandidates: candidates, getRecentPlays: () => [] });
  const preferred = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 2,
    preferredArtists: ['孙燕姿'] }, context('soft-preference'));
  assert.equal(preferred.ok, true);
  assert.deepEqual(preferred.candidates.map(candidate => candidate.sourceSongId), ['a1', 'b1'],
    '偏好只把这位歌手提到同 tier 的前面');
  const all = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 3,
    preferredArtists: ['孙燕姿'] }, context('soft-preference-all'));
  assert.deepEqual(all.candidates.map(candidate => candidate.sourceSongId).sort(), ['a1', 'b1', 'b2'],
    '偏好不是过滤：其他歌手仍然可选');
  const constrained = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 1,
    preferredArtists: ['孙燕姿'], constraints: { excludedArtists: ['孙燕姿'] } }, context('soft-preference-hard'));
  assert.equal(constrained.ok, true);
  assert.equal(constrained.candidates[0].sourceSongId, 'b1', '偏好不放宽硬约束');
});

test('a candidate-supply failure before commit leaves the round free for a corrected request', async t => {
  const h = fixture(t);
  h.service.getCandidates = async () => { throw new Error('candidate lookup failed'); };
  await assert.rejects(h.service.execute({ mode: 'discovery', delivery: 'replace_now' }, context('recover')), /candidate lookup failed/);
  assert.equal(h.service.musicActionStatus({ requestId: 'recover' }), null, '取候选失败不占用本轮音乐动作');
  h.service.getCandidates = async () => library;
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now' }, context('recover'));
  const recovered = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('recover'));
  assert.equal(recovered.ok, true, recovered.code);
  assert.equal(h.service.musicActionStatus({ requestId: 'recover' }), 'committed');
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '1');
});

test('a failure after submission remains unconfirmed and cannot repeat playback effects', async t => {
  const h = fixture(t);
  const commit = h.service.programCommitService.commit.bind(h.service.programCommitService);
  let submissions = 0;
  h.service.programCommitService.commit = async (...args) => {
    submissions += 1;
    await commit(...args);
    throw new Error('response lost after commit');
  };
  await assert.rejects(h.service.execute(exact(1), context('uncertain')), /response lost/);
  const result = await h.service.execute(exact(2), context('uncertain'));
  assert.equal(result.code, 'MUSIC_ACTION_UNCONFIRMED');
  assert.equal(submissions, 1);
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '1');
});

test('one group round combines canonical proposals once, with no speech until the actual transition', async t => {
  const h = fixture(t);
  const groupAction = { ownerId: 'c', recommendations: [] };
  await h.service.execute(exact(1), { ...context('a1'), roundId: 'round', groupAction });
  await h.service.execute(exact(2), { ...context('b1'), virtualPersonId: 'b', roundId: 'round', groupAction });
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  const proposal = await h.service.execute(exact(4), { ...context('b2'), virtualPersonId: 'b', roundId: 'round-proposal',
    groupAction: { ownerId: 'c', recommendations: [] } });
  assert.equal(proposal.code, 'MUSIC_RECOMMENDED');
  // 推荐者只需要说推了哪首、为什么；不要让它去解释谁来提交、谁来排歌。
  assert.match(proposal.message, /已记下你的推荐/u);
  assert.match(proposal.message, /不要解释由谁来排/u);
  const result = await h.service.execute(exact(3), { ...context('c1'), virtualPersonId: 'c', roundId: 'round', groupAction });
  assert.equal(result.ok, true);
  assert.equal(result.userMessage, '好，a 推荐的《歌1》、b 推荐的《歌2》和我挑的《歌3》都安排上了。');
  assert.deepEqual(result.recommendedTitles, ['歌1', '歌2']);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '2', '3']);
  // 提交人 c 负责全部三首的串词；a、b 的推荐另记 recommendedBy。
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.virtualPersonId), ['c', 'c', 'c']);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.recommendedBy), ['a', 'b', null]);
  assert.equal(h.playbackRuntime.snapshot().phase, 'loading');
  assert.equal(h.effects[0].type, 'PREPARE_TRACK_NARRATION');
  assert.equal(h.tts.length, 0);
  const replay = await h.service.execute(exact(4), { ...context('c1'), virtualPersonId: 'c', roundId: 'round', groupAction });
  assert.equal(replay.replayed, true);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 3);
});

test('负责人把同伴已推荐的歌也写进自己的 exact 目标时，推荐人归属不被覆盖、不重复入队', async t => {
  const h = fixture(t);
  const groupAction = { ownerId: 'c', recommendations: [] };
  await h.service.execute(exact(2), { ...context('b1'), virtualPersonId: 'b', roundId: 'round', groupAction });
  const both = { mode: 'exact', delivery: 'replace_now', count: 2,
    targets: [{ songId: '2', source: 'qq', title: '歌2', artist: '歌手' }, { songId: '3', source: 'qq', title: '歌3', artist: '歌手' }] };
  const result = await h.service.execute(both, { ...context('c1'), virtualPersonId: 'c', roundId: 'round', groupAction });
  assert.equal(result.ok, true);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['2', '3']);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.recommendedBy), ['b', null]);
  assert.equal(result.userMessage, '好，b 推荐的《歌2》和我挑的《歌3》都安排上了。');
});

test('非负责人提交开放式选歌：登记为推荐，不动播放器与收据；重复不叠加；负责人提交时合并并记推荐人', async t => {
  const h = fixture(t);
  const groupAction = { ownerId: 'c', recommendations: [] };
  const asB = { ...context('b1'), virtualPersonId: 'b', roundId: 'round', groupAction };
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, asB);
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  const registered = await h.service.commitSelection({ offerId: offered.offerId, indexes: [2] }, asB);
  assert.equal(registered.ok, true);
  assert.equal(registered.code, 'MUSIC_RECOMMENDED');
  assert.equal(registered.delivery, 'recommend_only');
  assert.notEqual(registered.terminal, true);
  assert.match(registered.message, /已记下你的推荐/u);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.deepEqual(h.commands, []);
  assert.equal(h.service.musicActionStatus({ roundId: 'round' }), null, '登记推荐不占用本轮音乐动作收据');
  const picked = offered.offer.candidates[1];
  assert.equal(groupAction.recommendations.length, 1);
  assert.equal(groupAction.recommendations[0].personId, 'b');
  assert.deepEqual(groupAction.recommendations[0].tracks.map(track => [track.title, track.artist]), [[picked.title, picked.artist]]);

  // 同一轮重复登记同一首：不叠加。
  const again = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, { ...asB, requestId: 'b2' });
  const index = again.offer.candidates.findIndex(item => item.songId === picked.songId) + 1;
  assert.ok(index > 0);
  await h.service.commitSelection({ offerId: again.offerId, indexes: [index] }, { ...asB, requestId: 'b2' });
  assert.equal(groupAction.recommendations.length, 1);
  assert.equal(groupAction.recommendations[0].tracks.length, 1);

  const owner = await h.service.execute(exact(3), { ...context('c1'), virtualPersonId: 'c', roundId: 'round', groupAction });
  assert.equal(owner.ok, true);
  const queue = h.playbackRuntime.snapshot().queue;
  assert.ok(queue.some(track => track.songId === picked.songId && track.recommendedBy === 'b'));
  assert.ok(queue.some(track => track.songId === '3' && track.recommendedBy == null));
});

test('非负责人的播放 mutation 仍然返回 MUSIC_OWNER_REQUIRED', async t => {
  const h = fixture(t);
  const groupAction = { ownerId: 'c', recommendations: [] };
  const result = await h.service.mutate({ ...context('b-skip'), virtualPersonId: 'b', roundId: 'round', groupAction },
    async () => ({ ok: true }));
  assert.equal(result.code, 'MUSIC_OWNER_REQUIRED');
});

test('background warm-pool preparation creates no chat/playback and no longer bypasses the candidate offer', async t => {
  const h = fixture(t);
  const request = normalizeMusicSelection({ mode: 'discovery', delivery: 'append', count: 1, constraints: { excludeVersions: ['live'] } });
  let demand = { request, context: h.service.context(context('background')) };
  const pool = new WarmPoolService({ select: (...args) => h.service.select(...args), getActiveDemand: () => demand, disabled: false });
  t.after(() => pool.shutdown()); h.service.pool = pool;
  assert.equal((await pool.refresh()).ok, true);
  assert.equal(h.conversationStore.listTurns('room').length, 0);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.equal(h.tts.length, 0);
  assert.equal(pool.reserve(request, { ...demand.context, sessionId: 'other' }), null);
  // 准备集合不再直接提交：播放只能经由候选 offer + commit_music_selection。
  const offered = await h.service.execute({ ...request, delivery: 'replace_now' }, context('live'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.equal(h.tts.length, 0);
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [3] }, context('live'));
  assert.equal(committed.ok, true, committed.code);
  assert.equal(h.playbackRuntime.snapshot().queue[0].songId, '3');
  assert.equal(h.playbackRuntime.snapshot().queue[0].narration.context.origin, 'live',
    '预热池不再让提交冒充“已准备”');
  assert.equal(h.playbackRuntime.snapshot().queue[0].narration.context.reason, 'user_request');
  demand = null;
  assert.equal((await pool.refresh()).skipped, 'no-active-demand');
});

test('hard constraints fail closed; a recommendation reference cannot cross rooms', async t => {
  const h = fixture(t);
  const blocked = await h.service.execute({ ...exact(4), constraints: { excludeVersions: ['live'] } }, context('no-live'));
  assert.equal(blocked.ok, false); assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  const offered = await h.service.execute(exact(2, 'recommend_only'), context('offer'));
  assert.equal(offered.ok, true); assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  await assert.rejects(h.service.execute({ mode: 'exact', delivery: 'replace_now', reference: { selectionId: offered.selectionId, indexes: [1] } },
    { sessionId: 'other', virtualPersonId: 'b', requestId: 'bad-ref' }), /引用/);
  const selected = await h.service.execute({ mode: 'exact', delivery: 'replace_now', reference: { selectionId: offered.selectionId, indexes: [1] } }, context('ref'));
  assert.equal(selected.tracks[0].songId, '2');
});

test('an explicit selection turns its artist into a soft preference, not a hard follow-up constraint', async t => {
  const h = fixture(t);
  await h.service.execute({ mode: 'exact', delivery: 'replace_now', targets: [{ title: '歌1' }] }, context('title-only'));
  const next = continuationSelection(h.playbackRuntime.snapshot().listeningPlan.request);
  assert.equal(next.mode, 'discovery');
  assert.equal(next.artist, '');
  assert.deepEqual(next.preferredArtists, ['歌手']);
  assert.equal(next.targets.length, 0);
});

test('continuation anchors on the track that actually played as a soft preference', () => {
  const request = normalizeMusicSelection({ mode: 'exact', delivery: 'replace_now', count: 2,
    targets: [{ title: '歌1', artist: '第一个歌手' }, { title: '歌2', artist: '第二个歌手' }] });
  const anchored = continuationSelection(request, { previousTrack: { artist: '第二个歌手' } });
  assert.equal(anchored.mode, 'discovery');
  assert.equal(anchored.artist, '');
  assert.deepEqual(anchored.preferredArtists, ['第二个歌手']);
  assert.equal(anchored.targets.length, 0);
  assert.deepEqual(continuationSelection(request).preferredArtists, ['第一个歌手']);
});

test('a finished exact set continues with a soft preference while keeping user constraints', async t => {
  const continuationCandidates = [{ song_id: '9', title: '库内歌', artist: '别的艺人', source: 'qq' }];
  const h = fixture(t, { continuationCandidates, userCandidates: [] });
  const radio = new RadioRequestService({ musicService: h.service, playbackRuntime: h.playbackRuntime,
    conversationStore: h.conversationStore, getMusicSelectionAgent: () => agentRunnerStub(h.service) });
  const constraints = { excludeVersions: ['live'], excludedSongIds: ['3'] };
  const committed = await h.service.execute({ ...exact(1), constraints }, context('anchor-exact'));
  assert.equal(committed.ok, true);
  assert.equal(h.playbackRuntime.snapshot().listeningPlan.request.targets[0].artist, '歌手');

  const state = h.playbackRuntime.snapshot();
  const ended = await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'anchor-ended', natural: true,
    runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, songId: state.currentSongId,
    programId: state.txn.programId, correlationId: state.txn.correlationId });
  assert.equal(ended.state.phase, 'exhausted');
  const boundary = ended.state.pendingContinuation;

  const continued = await radio.handleContinue({ sessionId: 'room', outputGeneration: ended.state.outputGeneration,
    requestId: `runtime-continuation:${boundary.boundaryKey}` });
  assert.equal(continued.ok, true, continued.code);
  assert.equal(continued.tracks[0].songId, '9');
  assert.equal(continued.tracks[0].artist, '别的艺人', '软偏好不阻止其他歌手进入续播');
  const plan = h.playbackRuntime.snapshot().listeningPlan.request;
  assert.equal(plan.mode, 'discovery');
  assert.equal(plan.artist, '');
  assert.deepEqual(plan.preferredArtists, ['歌手']);
  assert.deepEqual(plan.constraints.excludeVersions, constraints.excludeVersions);
  assert.deepEqual(plan.constraints.excludedSongIds, [...constraints.excludedSongIds].sort());
  assert.equal(plan.targets.length, 0);
  assert.equal(h.playbackRuntime.snapshot().queue.some(track => track.songId === '1'), true);

  // 显式用户请求仍然 fail-closed，不会被静默降级或替歌。
  const explicit = await radio.handleNext({ sessionId: 'room', requestId: 'anchor-user-next' });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.code, 'NO_MATCHING_CANDIDATES');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 2);
});

test('a concurrent revision bump does not drop the listener music request', async t => {
  const h = fixture(t);
  await h.service.execute(exact(1), context('race-first'));
  const commit = h.service.programCommitService.commit.bind(h.service.programCommitService);
  let injected = false;
  h.service.programCommitService.commit = async (program, options) => {
    if (!injected) {
      injected = true;
      // Something else (an auto-continue batch) appended to this room between the
      // caller's snapshot and the submission.
      await h.playbackRuntime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'auto-append', delivery: 'append',
        listeningSessionId: 'room', tracks: [{ songId: '9', programId: 'auto', requestId: 'auto',
          title: '歌9', artist: '歌手', source: 'qq', url: '/9.mp3' }] });
    }
    return commit(program, options);
  };
  const result = await h.service.execute(exact(2, 'append'), context('race-second'));
  assert.equal(result.ok, true);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['1', '9', '2']);
});

test('a stale in-progress action receipt cannot permanently block a retry', async t => {
  const h = fixture(t);
  h.service.initialize();
  const insert = h.conversationStore.db.prepare('INSERT INTO music_action_receipts VALUES (?, ?, ?, ?, NULL, ?)');
  insert.run('abandoned:music', 'room', 'abandoned', 'running', Date.now() - 10 * 60_000);
  const retried = await h.service.execute(exact(1), context('abandoned'));
  assert.equal(retried.ok, true);

  insert.run('live:music', 'room', 'live', 'running', Date.now());
  const blocked = await h.service.execute(exact(2), context('live'));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'MUSIC_ACTION_IN_PROGRESS');
});

test('curated freshness ranks unheard tracks ahead of recently played ones', async t => {
  const h = fixture(t);
  const now = Date.now();
  const songs = [1, 2, 3, 4].map(id => ({ song_id: String(id), title: `歌${id}`, artist: `歌手${id}`, source: 'qq', album: '录音室' }));
  h.service.getCandidates = async () => songs;
  // 歌1 三小时前刚播过（冷却期内）；歌2 十天前播过一次；歌3、歌4 没播过。
  h.service.getRecentPlays = () => [
    { ts: now - 3 * 3_600_000, song_id: '1', source: 'qq' },
    { ts: now - 10 * 86_400_000, song_id: '2', source: 'qq' },
  ];
  const selection = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 4 }, context('fresh'));
  assert.equal(selection.ok, true);
  assert.deepEqual(selection.candidates.map(item => item.orderedTarget.songId), ['3', '4', '2', '1']);
  // 没有实播历史时保持来源顺序，不凭空重排。
  const quiet = fixture(t);
  quiet.service.getCandidates = async () => songs;
  quiet.service.getRecentPlays = () => [];
  const untouched = await quiet.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 4 }, context('quiet'));
  assert.deepEqual(untouched.candidates.map(item => item.orderedTarget.songId), ['1', '2', '3', '4']);
});

test('the curated window keeps one artist to a modest share so lesser-heard voices enter', async t => {
  const h = fixture(t);
  const now = Date.now();
  const songs = [
    ...[1, 2, 3, 4].map(id => ({ song_id: `a${id}`, title: `A歌${id}`, artist: '大红歌手', source: 'qq', album: '录音室' })),
    ...[1, 2, 3].map(id => ({ song_id: `b${id}`, title: `B歌${id}`, artist: `小众歌手${id}`, source: 'qq', album: '录音室' })),
  ];
  h.service.getCandidates = async () => songs;
  // 至少一条无关实播让新鲜度参与；来源顺序本身是大红歌手霸榜的。
  h.service.getRecentPlays = () => [{ ts: now - 86_400_000, song_id: 'zzz', source: 'qq' }];
  const selection = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 7 }, context('dispersion'));
  const artists = selection.candidates.map(item => item.orderedTarget.artist);
  assert.equal(artists.filter(name => name === '大红歌手').length, 4, '不丢弃任何候选');
  assert.ok(artists.slice(0, 6).filter(name => name === '大红歌手').length <= 3, '窗口头部同一歌手不超过份额');
  assert.equal(artists[6], '大红歌手', '超份额候选排在窗口之后而不是被删除');
});

test('exact requests and user targets bypass freshness entirely', async t => {
  const h = fixture(t);
  const now = Date.now();
  h.service.getRecentPlays = () => [{ ts: now - 1_000, song_id: '1', source: 'qq' }];
  await h.service.execute(exact(1), context('exact-fresh'));
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '1');
});

test('music selection context surfaces the taste schema and drops it after revoke', async t => {
  const { MemoryService } = await import('../memory/MemoryService.js');
  const { revokeMemory } = await import('../memory/memoryProvenance.js');
  const dir = mkdtempSync(join(tmpdir(), 'lunara-taste-ctx-'));
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  const mem = new MemoryService('radiohost:a');
  await mem.initialize();
  mem.addMemory({ namespace: 'radiohost:a', type: 'semantic', source: 'agent_reflection',
    content: '用户长期偏爱 R&B', tags: 'taste-schema', confidence: 0.7, importance: 8,
    evidence: JSON.stringify({ writeKey: 'taste-schema:radiohost:a', revision: 1 }) });
  const h = fixture(t, { getMemoryService: () => mem });
  t.after(() => mem.shutdown());
  const ctx = h.service.context({ sessionId: 'room', virtualPersonId: 'a', requestId: 'ctx-schema' });
  const schemaRow = ctx.memories.find(row => String(row.tags).includes('taste-schema'));
  assert.ok(schemaRow, '图式行进入选歌上下文');
  revokeMemory(mem.store, schemaRow.id);
  const after = h.service.context({ sessionId: 'room', virtualPersonId: 'a', requestId: 'ctx-schema-2' });
  assert.ok(!after.memories.some(row => String(row.tags).includes('taste-schema')), '撤销后不再注入');
});

// ===== add-taste-probe-signals：claim 信号重排 + 克制版探查 =====

const rnbTags = songId => (String(songId) === '3' ? { genres: ['rnb'] } : { genres: ['pop'], language: 'zh' });

async function tasteFixture(t, { claims = [], userCandidates = null, getTags = rnbTags, tagStore = null,
  getFamiliarArtists = undefined } = {}) {
  const { MemoryService } = await import('../memory/MemoryService.js');
  process.env.LUNARA_DB_PATH = join(tmpdir(), `lunara-taste-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const mem = new MemoryService('radiohost:a');
  await mem.initialize();
  for (const claim of claims) {
    mem.addMemory({ namespace: mem.namespace, type: 'semantic', source: 'agent_reflection',
      content: `claim ${claim.key} ${claim.polarity || 'positive'}`,
      tags: `reflection-insight,claim:${claim.key}`, confidence: claim.confidence ?? 0.4, importance: 5,
      evidence: JSON.stringify({ eventKeys: ['e1'], claim: { key: claim.key, polarity: claim.polarity || 'positive' },
        occurrences: claim.occurrences ?? 3 }) });
  }
  const h = fixture(t, { getTags, getMemoryService: () => mem, userCandidates, tagStore, getFamiliarArtists });
  h.service.getRecentPlays = () => [];
  h.service.initialize();
  t.after(() => mem.shutdown());
  return { h, mem };
}
const discovery = (count = 4) => ({ mode: 'discovery', delivery: 'recommend_only', count });
const ordered = selection => selection.candidates.map(item => item.orderedTarget.songId);
const probeRows = h => h.conversationStore.db.prepare('SELECT * FROM music_probes').all();

test('positive claim reorders within the same freshness tier', async t => {
  const { h } = await tasteFixture(t, { claims: [{ key: 'music.genre.rnb', confidence: 0.7 }] });
  const selection = await h.service.select(discovery(4), context('taste-promote'));
  assert.deepEqual(ordered(selection), ['3', '1', '2', '4'], '匹配 rnb claim 的歌 3 提到同层最前');
  assert.equal(probeRows(h).length, 0, '高置信度 claim 不触发探查');
});

test('cooldown dominates taste bias', async t => {
  const { h } = await tasteFixture(t, { claims: [{ key: 'music.genre.rnb', confidence: 0.7 }] });
  const now = Date.now();
  h.service.getRecentPlays = () => [{ ts: now - 3_600_000, song_id: '3', source: 'qq' }];
  const selection = await h.service.select(discovery(4), context('taste-cooldown'));
  assert.deepEqual(ordered(selection), ['1', '2', '4', '3'], '冷却中的歌 3 不会被口味捞回前排');
});

test('negative claim demotes without excluding', async t => {
  const reordered = [library[2], library[0], library[1], library[3]];
  const { h } = await tasteFixture(t, {
    claims: [{ key: 'music.genre.rnb', polarity: 'negative', confidence: 0.7 }],
    userCandidates: reordered });
  const selection = await h.service.select(discovery(4), context('taste-demote'));
  const result = ordered(selection);
  assert.equal(result[0], '1', '负向 claim 命中的歌 2 退到同层之后');
  assert.ok(result.includes('2'), '负向 claim 不排除候选');
});

test('probe pins a mid-band claim candidate and respects the frequency gate', async t => {
  const { h } = await tasteFixture(t, { claims: [{ key: 'music.genre.rnb', confidence: 0.4 }] });
  const first = await h.service.select(discovery(4), context('probe-1'));
  assert.equal(ordered(first)[0], '3', '探查候选钉到窗口头部');
  const rows = probeRows(h);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].song_id, '3');
  assert.equal(rows[0].claim_key, 'music.genre.rnb');
  // 频率闸：6 小时内不再探查（此时候选池也只剩 3 首，双重拦截）
  await h.service.select(discovery(4), context('probe-2'));
  assert.equal(probeRows(h).length, 1, '频控期内不重复探查');
});

test('exact requests never probe', async t => {
  const { h } = await tasteFixture(t, { claims: [{ key: 'music.genre.rnb', confidence: 0.4 }] });
  await h.service.execute(exact(1), context('probe-exact'));
  assert.equal(probeRows(h).length, 0, '点播路径零探查行为');
});

test('probe kill switch disables pinning and recording', async t => {
  process.env.MUSIC_PROBE_DISABLED = '1';
  try {
    const { h } = await tasteFixture(t, { claims: [{ key: 'music.genre.rnb', confidence: 0.4 }] });
    const selection = await h.service.select(discovery(4), context('probe-off'));
    assert.equal(ordered(selection)[0], '3', '排序偏置仍在（独立开关）');
    assert.equal(probeRows(h).length, 0, '探查被关闭');
  } finally {
    delete process.env.MUSIC_PROBE_DISABLED;
  }
});

// ---- 预热批次（prepared）：受限 preparation 任务挂起 → 边界零模型调用采用 ----

const runtimeGeneration = h => h.playbackRuntime.snapshot().outputGeneration;

/** 真实 runtime 需要先有一次激活；此后 append 的续播批次才会落进本会话队列。 */
async function activateSession(h, songId = '4', sessionId = 'room', personId = 'a') {
  const result = await h.service.execute(exact(songId), { sessionId, virtualPersonId: personId, requestId: `activate-${sessionId}` });
  assert.equal(result.ok, true, result.code);
  assert.equal(h.playbackRuntime.snapshot().activeListeningSessionId, sessionId);
  return result;
}

/**
 * 用真实两步工具契约模拟受限 preparation 任务：select_music 出候选（offer），
 * commit_music_selection 在 resolveOnly + preparedFor 下只挂起序号。
 */
let holdBatchSeq = 0;
async function holdBatch(h, { request = normalizeMusicSelection({ mode: 'discovery', delivery: 'append', count: 2 }),
  sessionId = 'room', personId = 'a', outputGeneration = null, boundaryKey = null, indexes = null } = {}) {
  const generation = outputGeneration ?? runtimeGeneration(h);
  const preparedFor = { listeningSessionId: sessionId, outputGeneration: generation, boundaryKey };
  const task = { request, reason: 'auto_continue', sessionId, outputGeneration: generation,
    isCurrent: () => true, mode: 'preparation', resolveOnly: true, preparedFor };
  // 同一轮任务：两个工具共享同一个 requestId（就是生产运行器 toolContext 的口径）；
  // 同一 fixture 里多次挂起用不同任务 id，避免撞上同一轮的幂等收据。
  const requestId = `prep-task-${++holdBatchSeq}`;
  const offered = await h.service.execute({}, { sessionId, virtualPersonId: personId, requestId,
    outputGeneration: generation, musicTaskRequest: task });
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED', JSON.stringify(offered).slice(0, 200));
  const chosen = indexes || offered.offer.candidates.map(candidate => candidate.index).slice(0, 2);
  const held = await h.service.commitSelection({ offerId: offered.offerId, indexes: chosen },
    { sessionId, virtualPersonId: personId, requestId, outputGeneration: generation, musicTaskRequest: task });
  assert.equal(held.code, 'MUSIC_CANDIDATES_SELECTED', JSON.stringify(held).slice(0, 200));
  assert.equal(held.prepared, true, 'preparation 任务挂起而不是消费 offer');
  const saved = h.service.savePreparedBatch({ offerId: offered.offerId, indexes: held.indexes, sessionId, personId });
  assert.equal(saved.ok, true, saved.code);
  return { offered, held, saved, request, generation, chosen };
}

const adoptPrepared = (h, request, { sessionId = 'room', personId = 'a', outputGeneration = null, boundaryKey = null } = {}) => {
  const generation = outputGeneration ?? runtimeGeneration(h);
  return h.service.consumePrepared({ request, sessionId, virtualPersonId: personId,
    requestId: `runtime-continuation:${boundaryKey || 'b'}`, outputGeneration: generation, boundaryKey,
    preparedAccept: { listeningSessionId: sessionId, outputGeneration: generation, boundaryKey, planRequest: request } });
};

test('a held preparation batch is adopted at the boundary with canonical resolution and no playback during preparation', async t => {
  const h = fixture(t);
  await activateSession(h);
  const before = h.playbackRuntime.snapshot();
  const commandsBefore = h.commands.length;
  const { offered, saved } = await holdBatch(h);

  assert.deepEqual(h.playbackRuntime.snapshot(), before, '预热绝不触碰播放器');
  assert.equal(h.commands.length, commandsBefore, '预热不产生任何播放命令');
  assert.equal(h.service.offers.get(offered.offerId).status, 'prepared');
  assert.deepEqual(h.service.offers.get(offered.offerId).preparedFor,
    { listeningSessionId: 'room', outputGeneration: before.outputGeneration, boundaryKey: null });
  assert.equal(h.service.preparedStats().prepared, 1);

  const resolved = [];
  const resolveTrack = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    resolved.push(options?.candidate?.sourceSongId ?? null);
    return resolveTrack(query, options);
  };
  const adopted = await adoptPrepared(h, offered.request);
  assert.equal(adopted.matched, true);
  assert.equal(adopted.ok, true, adopted.result?.code);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4', '1', '2'],
    '当前歌继续播，预热批次追加在后面');
  assert.deepEqual(resolved, saved.indexes.map(index => offered.offer.candidates[index - 1].songId),
    '采用时逐首重新做 canonical 解析，只解析被选中的序号');
  assert.equal(h.playbackRuntime.snapshot().queue[1].narration.context.origin, 'live');
  assert.equal(h.service.preparedStats().consumed, 1);
  // 单次使用：同一批次不会再被采用。
  const again = await adoptPrepared(h, offered.request);
  assert.equal(again.matched, false);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 3);
});

test('a prepared ref that no longer resolves fails closed without substitution or playback', async t => {
  const h = fixture(t);
  await activateSession(h);
  h.service.getCandidates = async () => [{ song_id: 'ghost', title: '幽灵歌', artist: '歌手', source: 'qq:library' }];
  const { offered } = await holdBatch(h, { indexes: [1] });
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4'], '挂起阶段零播放副作用');
  const resolved = [];
  h.service.programCommitService.resolveTrack = async () => { resolved.push('attempt'); return { ok: false }; };

  const adopted = await adoptPrepared(h, offered.request);
  assert.equal(adopted.matched, true, '命中的批次必须被采用过，而不是假装没有');
  assert.equal(adopted.ok, false);
  assert.equal(adopted.failClosed, true);
  assert.equal(resolved.length, 2, '选中的同一身份最多解析两次，不换序号、不替歌');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4'], '解析失败不产生任何播放');
  assert.equal(h.service.preparedStats().failed, 1);
  // 批次已作废：下一次边界没有可用批次，交给调用方回落实时选歌。
  assert.equal((await adoptPrepared(h, offered.request)).matched, false);
});

test('stale prepared batches are never adopted and are discarded: boundary, generation, membership and queue changes', async t => {
  const h = fixture(t);
  await activateSession(h);
  const boundary = await holdBatch(h, { boundaryKey: 'b-1', indexes: [1] });

  assert.equal((await adoptPrepared(h, boundary.offered.request, { boundaryKey: 'b-2' })).matched, false, '另一个边界不能用这批');
  assert.equal(h.service.prepared.get(boundary.saved.preparedId).status, 'failed', '失配批次立即作废，不再留在待采用里');
  assert.equal(h.service.prepared.listReady({ sessionId: 'room', personId: 'a' }).length, 0);

  const generation = await holdBatch(h, { indexes: [1] });
  assert.equal((await adoptPrepared(h, generation.offered.request, { outputGeneration: runtimeGeneration(h) + 1 })).matched,
    false, '输出代次变化不能采用');
  assert.equal(h.service.prepared.get(generation.saved.preparedId).status, 'failed');
  assert.ok(h.service.preparedStats().mismatch >= 2);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4']);

  // 成员变化（revision 变化）使批次作废。
  const membership = await holdBatch(h, { indexes: [1] });
  h.conversationStore.removeMember('room', 'b');
  assert.equal((await adoptPrepared(h, membership.offered.request)).matched, false);
  assert.equal(h.service.prepared.get(membership.saved.preparedId).status, 'failed');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4']);

  // 队列变化：批次的歌已经被排进队列时不再采用，避免重复排歌。
  const h2 = fixture(t);
  await activateSession(h2);
  const second = await holdBatch(h2, { indexes: [1] });
  const committed = await h2.service.execute(exact(1), context('queue-change'));
  assert.equal(committed.ok, true);
  assert.deepEqual(h2.playbackRuntime.snapshot().queue.map(track => track.songId), ['1']);
  assert.equal((await adoptPrepared(h2, second.offered.request)).matched, false);
  assert.equal(h2.service.prepared.get(second.saved.preparedId).status, 'failed');
  assert.deepEqual(h2.playbackRuntime.snapshot().queue.map(track => track.songId), ['1'], '不重复排歌');
});

test('a canonical resolution failure carries a per-source reason while the user copy stays generic', async t => {
  const h = fixture(t);
  h.service.programCommitService.resolveTrack = async () => ({ ok: false, error: 'all-sources-failed' });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, context('reason'));

  const failed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 2] }, context('reason'));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'MUSIC_NOT_COMMITTED');
  assert.equal(failed.reason, 'resolution failed (qq)', '按来源给出可核对的非敏感原因');
  assert.match(failed.message, /当前无法播放，队列没有变化。/, '模型/用户可见的文案保持通用，不含端点或凭据');
  assert.equal(/https?:/.test(JSON.stringify(failed)), false, '失败结果不含 URL');
  assert.equal(h.service.musicActionStatus({ requestId: 'reason' }), 'failed', '无副作用失败允许同轮修正');
  // 失败原因随工具 outcome 进入 facts/modelContext（见 MusicSelectionAgent.test.js 的端到端用例）。
});

test('expired and invalidated prepared batches are discarded and counted', async t => {
  let now = Date.now();
  const h = fixture(t, { now: () => now });
  await activateSession(h);
  const { request } = await holdBatch(h);
  now += 31 * 60_000; // 超过默认预热 TTL（30 分钟）
  const expired = await adoptPrepared(h, request);
  assert.equal(expired.matched, false);
  assert.ok(h.service.preparedStats().expired >= 1);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4']);

  const h2 = fixture(t);
  await activateSession(h2);
  const second = await holdBatch(h2);
  assert.equal(h2.service.invalidatePrepared(), 1);
  assert.equal(h2.service.preparedStats().invalidated, 1);
  assert.equal((await adoptPrepared(h2, second.offered.request)).matched, false);
  assert.deepEqual(h2.playbackRuntime.snapshot().queue.map(track => track.songId), ['4']);
});

test('prepared adoption enforces session/person ownership and the music-owner rule', async t => {
  const h = fixture(t);
  // 'other' 会话里另一位伙伴准备的批次不能被 'room' 采用。
  const foreign = await holdBatch(h, { sessionId: 'other', personId: 'b', indexes: [1] });
  assert.equal((await adoptPrepared(h, foreign.offered.request, { sessionId: 'room', personId: 'a' })).matched, false);
  assert.equal(h.playbackRuntime.listeningSnapshot('room').queue.length, 0);

  const h2 = fixture(t);
  await activateSession(h2);
  const held = await holdBatch(h2);
  const ownerBlocked = await h2.service.consumePrepared({
    request: held.offered.request, sessionId: 'room', virtualPersonId: 'a', outputGeneration: held.generation,
    boundaryKey: null, groupAction: { ownerId: 'c', recommendations: [] },
    preparedAccept: { listeningSessionId: 'room', outputGeneration: held.generation, boundaryKey: null, planRequest: held.offered.request },
  });
  assert.equal(ownerBlocked.matched, true);
  assert.equal(ownerBlocked.ok, false);
  assert.equal(ownerBlocked.result.code, 'MUSIC_OWNER_REQUIRED');
  assert.deepEqual(h2.playbackRuntime.snapshot().queue.map(track => track.songId), ['4'],
    '非音乐负责人不能借预热批次提交');

  // 归档/删除后的会话不能再采用任何预热批次。
  const h3 = fixture(t);
  await activateSession(h3);
  const archived = await holdBatch(h3);
  h3.conversationStore.updateRoom('room', { archived: true });
  const blocked = await h3.service.consumePrepared({ request: archived.offered.request, sessionId: 'room',
    virtualPersonId: 'a', outputGeneration: archived.generation, boundaryKey: null,
    preparedAccept: { listeningSessionId: 'room', outputGeneration: archived.generation, boundaryKey: null,
      planRequest: archived.offered.request } });
  assert.equal(blocked.matched, false);
  assert.deepEqual(h3.playbackRuntime.snapshot().queue.map(track => track.songId), ['4']);
});

test('recommend_only prepared batches never play, and an unheld offer cannot be saved as prepared', async t => {
  const h = fixture(t);
  // 普通 offer 没有挂起凭据：不允许直接落成预热批次。
  const plain = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 2 }, context('plain-offer'));
  assert.equal(h.service.savePreparedBatch({ offerId: plain.offerId, indexes: [1], sessionId: 'room', personId: 'a' }).code,
    'PREPARATION_NOT_HELD');

  const request = normalizeMusicSelection({ mode: 'discovery', delivery: 'recommend_only', count: 1 });
  const { offered, generation } = await holdBatch(h, { request, indexes: [1] });
  // 采用侧：只推荐不播放的实时请求不采用预热批次。
  const refused = await h.service.consumePrepared({ request, sessionId: 'room', virtualPersonId: 'a', outputGeneration: generation,
    boundaryKey: null, preparedAccept: { listeningSessionId: 'room', outputGeneration: generation, boundaryKey: null, planRequest: request } });
  assert.equal(refused.matched, false);
  assert.equal(refused.reason, 'recommend-only');
  // 提交侧：就算直接采用，delivery=recommend_only 仍然只推荐、不播放。
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] },
    { sessionId: 'room', virtualPersonId: 'a', requestId: 'ro-adopt', outputGeneration: generation,
      preparedAccept: { listeningSessionId: 'room', outputGeneration: generation, boundaryKey: null, planRequest: request } });
  assert.equal(committed.code, 'MUSIC_RECOMMENDED');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.deepEqual(h.commands, []);
});

test('pool.invalidate() discards unadopted batches and the status snapshot stays JSON-compatible', async t => {
  const h = fixture(t);
  await activateSession(h);
  const pool = new WarmPoolService({ disabled: true });
  t.after(() => pool.shutdown());
  h.service.pool = pool; // 自动接线：统计 + 失效
  const { request } = await holdBatch(h);
  const snapshot = pool.getStatusSnapshot();
  assert.equal(snapshot.stats.prepared.prepared, 1);
  assert.equal(snapshot.stats.prepared.consumed, 0);
  assert.equal(JSON.parse(JSON.stringify(snapshot)).stats.prepared.prepared, 1);
  pool.invalidate();
  assert.equal((await adoptPrepared(h, request)).matched, false);
  assert.equal(h.service.preparedStats().invalidated, 1);
  assert.equal(pool.getStatusSnapshot().stats.prepared.invalidated, 1);
  assert.equal(h.service.prepared.listReady({ sessionId: 'room' }).length, 0, '作废后没有待采用批次');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4']);
});

test('an offer larger than one exact request is still pre-resolved and never fails select_music', async t => {
  const many = Array.from({ length: 14 }, (_, index) => ({ song_id: String(100 + index), title: `多${index}`, artist: `歌手${index}`, source: 'qq' }));
  const h = fixture(t, { preResolveConcurrency: 3, userCandidates: many });
  const calls = [];
  h.service.programCommitService.resolveTrack = async (_query, options) => { calls.push(options.candidate.sourceSongId); return { ok: false }; };
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('pre-resolve-large'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.ok(offered.offer.candidates.length > 10, `offer 只有 ${offered.offer.candidates.length} 首，测不到分块`);
  await drain(); await drain();
  assert.equal(new Set(calls).size, offered.offer.candidates.length);
});

test('a pre-resolution setup error is contained and select_music still returns its offer', async t => {
  const h = fixture(t, { preResolveConcurrency: 2 });
  h.service._targetSelection = () => { throw new TypeError('boom'); };
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 1 }, context('pre-resolve-throw'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
});

// —— skip-known-unplayable-candidates ——
const notPlayable = { ok: false, error: 'canonical-resource-unavailable', code: 'not-playable' };
/** 指定 songId 返回给定失败，其余照常解析；记录每次真正请求音乐源的 songId。 */
function failSongs(h, failures) {
  const calls = [];
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    const id = options.candidate.sourceSongId;
    calls.push(id);
    return failures[id] ? { ...failures[id] } : resolve(query, options);
  };
  return calls;
}
const offeredIds = offered => offered.offer.candidates.map(candidate => candidate.songId);

test('unplayable new QQ songs do not block healthy previously played Netease continuation', async t => {
  const healthy = { song_id: 'ncm-old', title: '健康已播', artist: '歌手', source: 'ncm' };
  const lowEnergy = { song_id: 'ncm-low', title: '不符能量', artist: '歌手', source: 'ncm' };
  const h = fixture(t, { continuationCandidates: [healthy, lowEnergy],
    getTags: id => ({ genre: 'R&B', has_vocal: true, energy: id === 'ncm-low' ? 0.1 : 0.6 }) });
  await h.service.execute({ mode: 'exact', delivery: 'replace_now', count: 1,
    targets: [{ songId: healthy.song_id, source: 'ncm', title: healthy.title, artist: healthy.artist }] }, context('recovery-seed'));
  await h.service.execute(exact(1, 'append'), context('recovery-current'));
  await h.service.execute(exact(2, 'append'), context('recovery-upcoming'));
  await h.playbackRuntime.submit({ type: 'RADIO_MODE_CHANGED', eventId: 'recovery-radio', enabled: true });
  await playCurrentThrough(h, 'recovery-seed');
  h.service.getCandidates = async () => [...library, healthy, lowEnergy];
  for (const id of ['3', '4']) h.service._unplayable.mark('qq', id);
  const request = { mode: 'constrained', delivery: 'append', count: 3,
    constraints: { tags: { genre: 'R&B', has_vocal: true, minEnergy: 0.4 } } };
  const before = h.playbackRuntime.snapshot();
  const requestId = `runtime-continuation:${before.pendingContinuation.boundaryKey}`;
  const result = await h.service.select(request, { ...context(requestId), reason: 'auto_continue' });
  assert.equal(result.ok, true, result.code);
  assert.deepEqual(result.offer.candidates.map(row => [row.source, row.songId]), [['ncm', healthy.song_id]]);
  assert.deepEqual(h.playbackRuntime.snapshot(), before, 'selection alone does not switch or append playback');
  const committed = await h.service.commitSelection({ offerId: result.offerId, indexes: [1] },
    { ...context(requestId), reason: 'auto_continue' });
  assert.equal(committed.ok, true, `${committed.code}: ${committed.reason}`);
  const after = h.playbackRuntime.snapshot();
  assert.equal(after.queue.at(-1).source, 'ncm');
  assert.equal(after.queue.at(-1).songId, healthy.song_id);
  assert.equal(after.currentSongId, before.currentSongId, 'look-ahead recovery only appends, never cuts the current track');
  h.service.getSourcePolicy = () => ({ mode: 'single', primarySource: 'qq', sources: ['qq'] });
  assert.equal((await h.service.select(request, { ...context('recovery-single'), reason: 'auto_continue' })).code,
    'NO_MATCHING_CANDIDATES', 'single-source boundary is never bypassed');
});

test('a confirmed source auth incident diverts open continuation, not exact selections', async t => {
  const healthy = { song_id: 'ncm-new', title: '健康新曲', artist: '歌手', source: 'ncm' };
  const h = fixture(t, { continuationCandidates: [healthy] });
  h.service.getCandidates = async () => [...library, healthy];
  h.service.getSourceFailures = () => [{ source: 'qq', code: 'requires-auth' }];
  const request = { mode: 'discovery', delivery: 'append', count: 3 };
  const next = await h.service.select(request, { ...context('auth-fallback'), reason: 'auto_continue' });
  assert.deepEqual(next.offer.candidates.map(row => row.source), ['ncm']);
  const exactResult = await h.service.select(exact(1), context('auth-exact'));
  assert.equal(exactResult.candidates[0].evidence.source, 'qq', 'exact target is not silently replaced');
  h.service.getSourceFailures = () => [];
  const recovered = await h.service.select(request, { ...context('auth-recovered'), reason: 'auto_continue' });
  assert.ok(recovered.offer.candidates.some(row => row.source === 'qq'));
});

test('playable new candidates still take priority over recycling healthy old songs', async t => {
  const h = fixture(t);
  await h.service.execute(exact(1), context('new-first-1'));
  await h.service.execute(exact(2, 'append'), context('new-first-2'));
  await playCurrentThrough(h, 'new-first-1');
  const result = await h.service.select({ mode: 'discovery', delivery: 'append', count: 3 },
    { ...context('new-first-next'), reason: 'auto_continue' });
  assert.deepEqual(result.offer.candidates.map(row => row.songId).sort(), ['3', '4']);
});

test('拿不到音源的歌进入冷却：下一次开放式选歌不再给出，冷却过期后照常回来（不是「不喜欢」）', async t => {
  let clock = 1_000_000;
  const h = fixture(t, { now: () => clock });
  failSongs(h, { 1: notPlayable });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('cool-1'));
  assert.ok(offeredIds(offered).includes('1'));
  const failed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [offered.offer.candidates.findIndex(c => c.songId === '1') + 1] }, context('cool-1'));
  assert.equal(failed.code, 'MUSIC_NOT_COMMITTED');
  const next = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('cool-2'));
  assert.deepEqual(offeredIds(next).sort(), ['2', '3', '4'], '同一 (provider, songId) 冷却期内不再进候选');
  clock += 3 * 60 * 60 * 1000;
  const later = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('cool-3'));
  assert.deepEqual(offeredIds(later).sort(), ['1', '2', '3', '4'], '冷却只是暂时的，没有变成口味排除');
});

test('登录成功清除该源的冷却：同一首立刻回到开放式选歌，别的源不受影响', async t => {
  const h = fixture(t);
  failSongs(h, { 1: notPlayable });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('login-1'));
  await h.service.commitSelection({ offerId: offered.offerId, indexes: [offered.offer.candidates.findIndex(c => c.songId === '1') + 1] }, context('login-1'));
  assert.equal(h.service.clearUnplayableForProvider('ncm'), 0, '别的源登录不清 qq 的记录');
  assert.ok(!offeredIds(await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('login-2'))).includes('1'));
  assert.equal(h.service.clearUnplayableForProvider('qq'), 1);
  assert.ok(offeredIds(await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('login-3'))).includes('1'));
});

test('超时、源不可用等临时故障不进入冷却', async t => {
  const h = fixture(t);
  failSongs(h, { 1: { ...notPlayable, code: 'timeout' }, 2: { ...notPlayable, code: 'unavailable' } });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, context('transient-1'));
  const pick = ['1', '2'].map(id => offered.offer.candidates.findIndex(c => c.songId === id) + 1);
  await h.service.commitSelection({ offerId: offered.offerId, indexes: pick }, context('transient-1'));
  const next = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('transient-2'));
  assert.deepEqual(offeredIds(next).sort(), ['1', '2', '3', '4']);
});

test('后台预解析确认放不了：写入冷却，提交时同一序号直接退回、不再请求音乐源，offer 仍可用', async t => {
  const h = fixture(t, { preResolveConcurrency: 4 });
  const calls = failSongs(h, { 2: notPlayable });
  const input = context('pre-unplayable');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 2 }, input);
  await drain();
  const index = id => offered.offer.candidates.findIndex(c => c.songId === id) + 1;
  const before = calls.length;
  const rejected = await h.service.commitSelection({ offerId: offered.offerId, indexes: [index('2'), index('3')] }, input);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'SELECTION_INDEXES_UNPLAYABLE');
  assert.deepEqual(rejected.unplayableIndexes, [index('2')]);
  assert.match(rejected.message, new RegExp(`${index('2')}`));
  assert.equal(calls.length, before, '已知放不了的不再请求音乐源');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.equal(rejected.terminal, undefined);
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [index('3'), index('4')] }, input);
  assert.equal(committed.ok, true, committed.code);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['3', '4']);
});

test('同一 offer 重交已失败的序号被提前拒绝；换序号不受次数限制', async t => {
  const h = fixture(t);
  const calls = failSongs(h, { 1: notPlayable });
  const input = context('resubmit');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, input);
  const index = id => offered.offer.candidates.findIndex(c => c.songId === id) + 1;
  const failed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [index('1')] }, input);
  assert.equal(failed.code, 'MUSIC_NOT_COMMITTED');
  const before = calls.length;
  const rejected = await h.service.commitSelection({ offerId: offered.offerId, indexes: [index('1'), index('3')] }, input);
  assert.equal(rejected.code, 'SELECTION_INDEXES_UNPLAYABLE');
  assert.equal(calls.length, before, '拒绝发生在任何解析之前');
  const accepted = await h.service.commitSelection({ offerId: offered.offerId, indexes: [index('3')] }, input);
  assert.equal(accepted.ok, true, accepted.code);
  assert.equal(h.playbackRuntime.snapshot().currentSongId, '3');
});

test('用户点名的歌即使在冷却期内也照常解析，失败如实报、不替歌', async t => {
  const h = fixture(t);
  const calls = failSongs(h, { 1: notPlayable });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('exact-cool-1'));
  await h.service.commitSelection({ offerId: offered.offerId, indexes: [offered.offer.candidates.findIndex(c => c.songId === '1') + 1] }, context('exact-cool-1'));
  const before = calls.length;
  const exactResult = await h.service.execute(exact(1), context('exact-cool-2'));
  assert.ok(calls.length > before, '点名的歌仍然真的去解析');
  assert.equal(exactResult.ok, false);
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
});

test('提交时等到的后台预解析若确认放不了，直接按失败处理、不再二次请求', async t => {
  const h = fixture(t, { preResolveConcurrency: 4 });
  const calls = [];
  const gates = new Map();
  h.service.programCommitService.resolveTrack = (_query, options) => {
    const id = options.candidate.sourceSongId;
    calls.push(id);
    return new Promise(done => gates.set(id, () => done(id === '2' ? { ...notPlayable }
      : { ...library.find(row => row.song_id === id), ok: true, url: `/audio/${id}.mp3` })));
  };
  const input = context('pending-unplayable');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, input);
  await drain();
  const index = offered.offer.candidates.findIndex(c => c.songId === '2') + 1;
  const committing = h.service.commitSelection({ offerId: offered.offerId, indexes: [index] }, input);
  await drain();
  for (const open of gates.values()) open();
  const result = await committing;
  assert.equal(result.code, 'MUSIC_NOT_COMMITTED');
  assert.equal(calls.filter(id => id === '2').length, 1);
  assert.deepEqual(result.failedItems.map(item => item.reason), ['canonical-resource-unavailable']);
});

test('退回时列出整组候选里所有已知放不了的序号，模型一次就能避开', async t => {
  const h = fixture(t, { preResolveConcurrency: 4 });
  failSongs(h, { 1: notPlayable, 2: notPlayable, 4: notPlayable });
  const input = context('known-all');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, input);
  await drain();
  const index = id => offered.offer.candidates.findIndex(c => c.songId === id) + 1;
  const rejected = await h.service.commitSelection({ offerId: offered.offerId, indexes: [index('2')] }, input);
  assert.equal(rejected.code, 'SELECTION_INDEXES_UNPLAYABLE');
  assert.deepEqual(rejected.unplayableIndexes, [index('2')], '点名本次选中的');
  const known = ['1', '2', '4'].map(index).sort((a, b) => a - b);
  assert.deepEqual(rejected.knownUnplayableIndexes, known, '整组里已知放不了的全部列出');
  assert.match(rejected.message, new RegExp(known.join('、')));
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [index('3')] }, input);
  assert.equal(committed.ok, true, committed.code);
});

// ===== add-ambient-music-recommendation：ambient 推荐与确认入队 =====

const receiptsOf = h => h.conversationStore.db.prepare('SELECT COUNT(*) AS count FROM music_action_receipts').get().count;
const ambientInput = requestId => ({ sessionId: 'room', virtualPersonId: 'a', requestId, roundId: requestId });

test('ambient 推荐：一首明确目标经 canonical 与可播放解析后登记引用，不碰播放器也不写收据', async t => {
  const h = fixture(t);
  const before = h.playbackRuntime.snapshot().version;
  const result = await h.service.recommendTrack({ title: '歌2', artist: '歌手' }, ambientInput('wake-1'));
  assert.equal(result.ok, true, result.code);
  assert.equal(result.track.songId, '2');
  assert.equal(result.track.source, 'qq');
  assert.match(result.selectionId, /^selection:/);
  assert.equal(h.playbackRuntime.snapshot().version, before, 'runtime 版本不变');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
  assert.equal(h.commands.length, 0);
  assert.equal(receiptsOf(h), 0, '推荐不是播放动作，不写音乐动作收据');
  const row = h.conversationStore.db.prepare('SELECT conversation_id, person_id FROM music_selections WHERE selection_id = ?')
    .get(result.selectionId);
  assert.deepEqual({ ...row }, { conversation_id: 'room', person_id: 'a' });
});

test('ambient 推荐：找不到或放不了时可纠正地失败，不换成别的歌', async t => {
  const h = fixture(t);
  const missing = await h.service.recommendTrack({ title: '不存在的歌', artist: '谁' }, ambientInput('wake-missing'));
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'RECOMMENDATION_UNRESOLVED');
  assert.equal(missing.track, undefined);
  h.service.initialize();
  assert.equal(h.conversationStore.db.prepare('SELECT COUNT(*) AS count FROM music_selections').get().count, 0);
});

test('ambient 推荐：服从当前一起听计划的硬条件', async t => {
  const h = fixture(t);
  const committed = await h.service.execute({ ...exact(1), constraints: { excludeVersions: ['live'] } }, context('plan'));
  assert.equal(committed.ok, true, committed.code);
  const live = await h.service.recommendTrack({ title: '歌4', artist: '歌手' }, ambientInput('wake-live'));
  assert.equal(live.ok, false);
  assert.equal(live.code, 'RECOMMENDATION_UNRESOLVED');
});

test('ambient 推荐：已在队列、近期放过或你说过不喜欢的歌都被排除', async t => {
  const dislikes = [{ id: 7, namespace: 'radiohost:a', type: 'semantic', source: 'user_explicit_feedback', tags: 'person-relationship,music-feedback,song:3',
    evidence: JSON.stringify({ songId: '3', source: 'qq', sentiment: 'dislike', originSessionId: 'room', ownerId: 'a' }) }];
  const memory = { store: null, searchMemory: (_query, options = {}) => (String(options.tags || '').startsWith('song:')
    ? dislikes.filter(row => row.tags.split(',').includes(options.tags)) : []) };
  const h = fixture(t, { getMemoryService: () => memory,
    getRecentPlays: () => [{ song_id: '2', source: 'qq', ts: Date.now() - 60_000 }] });
  await h.service.execute(exact(1), context('queued'));
  const queued = await h.service.recommendTrack({ title: '歌1', artist: '歌手' }, ambientInput('wake-q'));
  assert.deepEqual([queued.ok, queued.code, queued.reason], [false, 'RECOMMENDATION_EXCLUDED', 'queued']);
  const recent = await h.service.recommendTrack({ title: '歌2', artist: '歌手' }, ambientInput('wake-r'));
  assert.deepEqual([recent.ok, recent.code, recent.reason], [false, 'RECOMMENDATION_EXCLUDED', 'recent']);
  const disliked = await h.service.recommendTrack({ title: '歌3', artist: '歌手' }, ambientInput('wake-d'));
  assert.deepEqual([disliked.ok, disliked.code, disliked.reason], [false, 'RECOMMENDATION_EXCLUDED', 'disliked']);
});

test('确认推荐：按存储的引用重新解析，after_current 提交，不改写一起听计划', async t => {
  const h = fixture(t);
  await h.service.execute({ ...exact(1), constraints: { excludeVersions: ['live'] } }, context('plan'));
  const planBefore = h.playbackRuntime.snapshot().listeningPlan;
  const offered = await h.service.recommendTrack({ title: '歌2', artist: '歌手' }, ambientInput('wake-accept'));
  const accepted = await h.service.acceptRecommendation({ sessionId: 'room', turnId: 'presence:wake-accept',
    selectionId: offered.selectionId, recommenderId: 'a', committerId: 'a' });
  assert.equal(accepted.ok, true, accepted.code);
  assert.equal(accepted.code, 'MUSIC_COMMITTED');
  assert.equal(accepted.delivery, 'after_current');
  const state = h.playbackRuntime.snapshot();
  assert.deepEqual(state.queue.map(track => track.songId), ['1', '2'], '排在当前这首之后');
  assert.equal(state.currentSongId, '1', '不打断当前歌');
  assert.deepEqual(state.listeningPlan, planBefore, '接受推荐不改写续播计划');
  const again = await h.service.acceptRecommendation({ sessionId: 'room', turnId: 'presence:wake-accept',
    selectionId: offered.selectionId, recommenderId: 'a', committerId: 'a' });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true, '同一推荐的重复确认重放原结果');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 2, '不重复入队');
});

test('确认推荐：群聊由当前负责人提交，并记下推荐人', async t => {
  const h = fixture(t);
  await h.service.execute(exact(1), context('plan'));
  const offered = await h.service.recommendTrack({ title: '歌2', artist: '歌手' },
    { sessionId: 'room', virtualPersonId: 'b', requestId: 'wake-b', roundId: 'wake-b' });
  const accepted = await h.service.acceptRecommendation({ sessionId: 'room', turnId: 'presence:wake-b',
    selectionId: offered.selectionId, recommenderId: 'b', committerId: 'a' });
  assert.equal(accepted.ok, true, accepted.code);
  const track = h.playbackRuntime.snapshot().queue.find(item => item.songId === '2');
  assert.equal(track.virtualPersonId, 'a');
  assert.equal(track.recommendedBy, 'b');
});

test('确认推荐：引用失效时可纠正地失败，队列不变', async t => {
  const h = fixture(t);
  const result = await h.service.acceptRecommendation({ sessionId: 'room', turnId: 'presence:gone',
    selectionId: 'selection:missing', recommenderId: 'a', committerId: 'a' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RECOMMENDATION_UNRESOLVED');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0);
});

test('聊天里用推荐引用点播：不改写一起听计划，推荐人另记', async t => {
  const h = fixture(t);
  await h.service.execute({ ...exact(1), constraints: { excludeVersions: ['live'] } }, context('plan'));
  const planBefore = h.playbackRuntime.snapshot().listeningPlan;
  const offered = await h.service.recommendTrack({ title: '歌2', artist: '歌手' },
    { sessionId: 'room', virtualPersonId: 'b', requestId: 'wake-chat', roundId: 'wake-chat' });
  const result = await h.service.execute({ mode: 'exact', delivery: 'after_current', count: 1,
    reference: { selectionId: offered.selectionId, indexes: [1] } },
  { ...context('chat-accept'), acceptingRecommendation: { turnId: 'presence:wake-chat', selectionId: offered.selectionId,
    recommendedBy: 'b' } });
  assert.equal(result.ok, true, result.code);
  const state = h.playbackRuntime.snapshot();
  assert.deepEqual(state.listeningPlan, planBefore);
  assert.equal(state.queue.find(item => item.songId === '2').recommendedBy, 'b');
});

// ---- 候选窗口按专辑分散（disperse-candidate-window-by-album）----

/** 三张各 20 首的专辑：候选池大于窗口（默认 40），分散才会真正改变模型看得见的那一屏。 */
const albumRows = (perAlbum = 20) => [
  ['甲', '甲的第一张', 'a'], ['乙', '乙的专辑', 'b'], ['丙', '丙的小样', 'c'],
].flatMap(([artist, album, prefix]) => Array.from({ length: perAlbum }, (_, index) => ({
  song_id: `${prefix}${index + 1}`, title: `${artist}${index + 1}`, artist, album, source: 'qq',
})));
const windowIds = offered => offered.offer.candidates.map(item => item.songId);
const withWindowEnv = async (env, run) => {
  const keys = Object.keys(env);
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try { return await run(); } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
};

test('候选窗口按专辑逐轮分散，不再把一张专辑排在最前', async t => {
  const h = fixture(t, { userCandidates: albumRows() });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('album-disperse'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED', JSON.stringify(offered).slice(0, 200));
  assert.equal(offered.offer.candidates.length, 40, '窗口仍取满 40 条');
  assert.deepEqual(windowIds(offered).slice(0, 6), ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'],
    '每轮每专辑两首，窗口头几首在不同专辑之间轮换');
});

test('队列里已经占住三首的同专辑不会在下一轮窗口打头', async t => {
  const rows = albumRows();
  const h = fixture(t, { userCandidates: rows, continuationCandidates: rows });
  const seeded = await h.service.execute({ mode: 'exact', delivery: 'append', count: 3,
    targets: rows.slice(0, 3).map(row => ({ songId: row.song_id, source: 'qq', title: row.title, artist: row.artist })) },
  context('album-seed'));
  assert.equal(seeded.ok, true, seeded.code);
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('album-saturated'));
  const window = windowIds(offered);
  assert.deepEqual(window.slice(0, 4), ['b1', 'b2', 'c1', 'c2'], '已饱和的专辑整张退到其他专辑之后');
  assert.ok(window.includes('a4'), '同专辑仍在窗口里，只是排在后面');
  assert.ok(window.indexOf('a4') >= 4, '已饱和的专辑从第二轮才进场，不进窗口头部');
});

test('只有一张专辑时窗口照常排满且保持原顺序', async t => {
  const rows = albumRows().filter(row => row.album === '甲的第一张');
  const h = fixture(t, { userCandidates: rows });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('album-single'));
  assert.deepEqual(windowIds(offered), rows.map(row => row.song_id));
});

test('MUSIC_WINDOW_MAX_PER_ALBUM=0 时窗口回到改动前的顺序', async t => {
  const rows = albumRows();
  const h = fixture(t, { userCandidates: rows });
  const window = await withWindowEnv({ MUSIC_WINDOW_MAX_PER_ALBUM: '0' }, async () => {
    const offered = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('album-off'));
    return windowIds(offered);
  });
  // 关掉专辑分散后窗口就是排序结果本身：打分之后的单歌手封顶（每人 3 首）照常生效，只重排不删。
  const ids = prefix => Array.from({ length: 20 }, (_, index) => `${prefix}${index + 1}`);
  const capped = [...ids('a').slice(0, 3), ...ids('b').slice(0, 3), ...ids('c').slice(0, 3),
    ...ids('a').slice(3), ...ids('b').slice(3), ...ids('c').slice(3)];
  assert.deepEqual(window, capped.slice(0, 40));
});

test('歌单模式保持歌单原始顺序，不参与专辑分散', async t => {
  const rows = albumRows();
  const h = fixture(t, { userCandidates: rows });
  h.service.getPlaylistTracks = async () => ({ ok: true, data: { matches: [{ tracks: rows }] } });
  const offered = await h.service.execute({ mode: 'playlist', delivery: 'append', count: 3,
    playlist: { source: 'qq', playlistId: 'p1' } }, context('album-playlist'));
  assert.deepEqual(windowIds(offered).slice(0, 3), ['a1', 'a2', 'a3'], '歌单按歌单自己的顺序');
});

test('exact 目标保持声明顺序，不参与专辑分散', async t => {
  const rows = albumRows();
  const h = fixture(t, { userCandidates: rows, continuationCandidates: rows });
  const selected = await h.service.select({ mode: 'exact', delivery: 'append', count: 3,
    targets: [rows[0], rows[20], rows[1]].map(row => ({ songId: row.song_id, source: 'qq', title: row.title, artist: row.artist })) },
  context('album-exact'));
  assert.deepEqual(selected.candidates.map(item => item.orderedTarget.songId), ['a1', 'b1', 'a2']);
});

// ---- 整专连播（add-album-sequencing）----

/** 一张 50 首的专辑：够跨越候选窗口（默认 40），用来核对专辑顺序不被分散或新鲜度重排。 */
const albumTracksOf = (prefix = 't', count = 50) => Array.from({ length: count }, (_, index) => ({
  song_id: `${prefix}${index + 1}`, title: `${prefix}${index + 1}`, artist: '专辑歌手', album: '整专', source: 'ncm',
}));
const albumRequest = (count = 3, albumId = 'alb1') => ({ mode: 'album', delivery: 'append', count,
  album: { source: 'ncm', albumId } });

test('album 模式按专辑原始顺序取曲目，不参与分散与新鲜度重排', async t => {
  const rows = albumTracksOf();
  const h = fixture(t, { albums: { 'ncm:alb1': rows }, continuationCandidates: rows });
  const offered = await h.service.execute(albumRequest(3), context('album-order'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED', JSON.stringify(offered).slice(0, 200));
  assert.deepEqual(offered.offer.candidates.map(item => item.songId).slice(0, 5), ['t1', 't2', 't3', 't4', 't5'],
    '专辑自己的顺序就是权威顺序');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, '候选不改播放器');
});

test('专辑续播保持 album 模式，剔除已排的歌并接着往下取', async t => {
  const rows = albumTracksOf();
  const h = fixture(t, { albums: { 'ncm:alb1': rows }, continuationCandidates: rows });
  await activateSession(h);
  const offered = await h.service.execute(albumRequest(3), context('album-start'));
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 2, 3] }, context('album-start'));
  assert.equal(committed.ok, true, committed.code);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), ['4', 't1', 't2', 't3']);
  const plan = h.playbackRuntime.snapshot().listeningPlan;
  assert.equal(plan.request.mode, 'album');
  assert.deepEqual(plan.request.album, { source: 'ncm', albumId: 'alb1' });

  const next = continuationSelection(plan.request, { previousTrack: { artist: '专辑歌手' } });
  assert.equal(next.mode, 'album');
  assert.deepEqual(next.album, { source: 'ncm', albumId: 'alb1' });
  assert.deepEqual(next.preferredArtists, [], '整专续播不退回上一首歌手当软锚点');
  const offeredAgain = await h.service.execute({}, { ...context('album-continue'),
    musicTaskRequest: { request: next, reason: 'auto_continue', sessionId: 'room' } });
  assert.deepEqual(offeredAgain.offer.candidates.map(item => item.songId).slice(0, 3), ['t4', 't5', 't6']);
});

test('专辑放完就结束，不绕回第一首', async t => {
  const rows = albumTracksOf('x', 2);
  const h = fixture(t, { albums: { 'ncm:alb1': rows }, continuationCandidates: rows });
  await activateSession(h);
  const offered = await h.service.execute(albumRequest(2), context('album-short'));
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1, 2] }, context('album-short'));
  assert.equal(committed.ok, true, committed.code);
  const plan = h.playbackRuntime.snapshot().listeningPlan;
  const next = continuationSelection(plan.request, { previousTrack: { artist: '专辑歌手' } });
  const again = await h.service.select(next, { ...context('album-end'), reason: 'auto_continue' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'NO_MATCHING_CANDIDATES');
  assert.equal(again.candidates.length, 0, '专辑里没有未排的歌，不会绕回第一首');
});

test('专辑读不到时 fail closed，不换版本也不跨源', async t => {
  const rows = albumTracksOf('y', 5);
  const h = fixture(t, { albums: { 'ncm:other': rows }, continuationCandidates: rows });
  const failed = await h.service.execute(albumRequest(3), context('album-missing'));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'ALBUM_UNAVAILABLE');
  assert.equal(h.playbackRuntime.snapshot().queue.length, 0, '队列没有变化');
  assert.deepEqual(failed.candidates, []);
});

// ---- 推荐决策账本（ground-music-selection-in-taste 1.2–1.4）----
const decisionRows = h => h.conversationStore.db.prepare(`SELECT path, offer_id, candidate_index, window_size, provider, song_id,
  features_json, queue_item_id, output_generation, program_id, outcome FROM music_recommendation_decisions ORDER BY id`).all();
const attachLedger = h => h.service.attachOutcomeLedger();
const startCurrent = async (h, label) => {
  const state = h.playbackRuntime.snapshot();
  const identity = { runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, songId: state.currentSongId,
    programId: state.txn?.programId, correlationId: state.txn?.correlationId };
  await h.playbackRuntime.submit({ type: 'TRACK_INTRO_READY', eventId: `intro-${label}`, text: '', ...identity });
  await h.playbackRuntime.submit({ type: 'TRACK_STARTED', eventId: `started-${label}`, ...identity, runtimeVersion: h.playbackRuntime.snapshot().version });
};

test('decision ledger: auto-continue commits write one row per adopted index with its occurrence, outcomes backfill', async t => {
  const h = fixture(t);
  attachLedger(h);
  const radio = new RadioRequestService({ musicService: h.service, playbackRuntime: h.playbackRuntime,
    conversationStore: h.conversationStore, getMusicSelectionAgent: () => agentRunnerStub(h.service) });
  const tasks = [];
  h.playbackRuntime.effectSink = effect => {
    if (effect.type === 'REQUEST_CONTINUATION') tasks.push(radio.handleContinue({
      sessionId: effect.listeningSessionId, outputGeneration: effect.outputGeneration,
      requestId: `runtime-continuation:${effect.boundaryKey}` }));
  };
  await h.playbackRuntime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'legacy', delivery: 'replace_now', listeningSessionId: 'room',
    tracks: [{ songId: '1', programId: 'legacy', requestId: 'legacy', title: '歌1', artist: '歌手', source: 'qq', url: '/1.mp3', intro: { text: '' } }] });
  await startCurrent(h, 'legacy');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await tasks[0]).ok, true);
  const queue = h.playbackRuntime.snapshot().queue;
  const rows = decisionRows(h);
  assert.deepEqual(rows.map(row => [row.path, row.candidate_index, row.provider, row.song_id]),
    [['auto_continue', 1, 'qq', '2'], ['auto_continue', 2, 'qq', '3'], ['auto_continue', 3, 'qq', '4']]);
  assert.deepEqual(rows.map(row => row.queue_item_id), queue.slice(1).map(track => track.queueItemId), '每行带自己的 queue occurrence');
  assert.ok(rows.every(row => row.program_id && row.output_generation === h.playbackRuntime.snapshot().outputGeneration));
  assert.ok(rows.every(row => row.window_size >= 3 && row.offer_id));
  assert.equal(JSON.parse(rows[0].features_json).mode, 'discovery');

  await playCurrentThrough(h, 'legacy-end'); // legacy 不是推荐，账本不变
  await playCurrentThrough(h, 'two');        // 2 听完
  await startCurrent(h, 'three');
  const state = h.playbackRuntime.snapshot();
  await h.playbackRuntime.submit({ type: 'NEXT_REQUESTED', eventId: 'skip-three', runtimeVersion: state.version, songId: state.currentSongId });
  assert.deepEqual(decisionRows(h).slice(0, 3).map(row => [row.song_id, row.outcome]), [['2', 'completed'], ['3', 'skipped'], ['4', null]],
    '后续续选写入的新行不影响前三行');
});

test('decision ledger: a failed commit writes nothing; recommend_only writes rows without an occurrence', async t => {
  const h = fixture(t, { userCandidates: [{ song_id: 'zz', title: '解析不了', artist: '无名', source: 'qq:library' }, ...candidatesOf(2)] });
  const failedOffer = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 1 }, context('ledger-fail'));
  const zz = failedOffer.offer.candidates.find(candidate => candidate.songId === 'zz').index;
  const failed = await h.service.commitSelection({ offerId: failedOffer.offerId, indexes: [zz] }, context('ledger-fail'));
  assert.equal(failed.ok, false);
  assert.deepEqual(decisionRows(h), [], '失败提交不留痕');

  const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 1 }, context('ledger-rec'));
  const two = offered.offer.candidates.find(candidate => candidate.songId === '2').index;
  const recommended = await h.service.commitSelection({ offerId: offered.offerId, indexes: [two] }, context('ledger-rec'));
  assert.equal(recommended.code, 'MUSIC_RECOMMENDED');
  assert.deepEqual(decisionRows(h).map(row => [row.path, row.song_id, row.queue_item_id, row.program_id]),
    [['recommend_only', '2', null, null]]);
});

test('decision ledger: switching listening source marks superseded, then completing after switching back wins', async t => {
  const h = fixture(t, { userCandidates: candidatesOf(2, 3) });
  attachLedger(h);
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('ledger-switch'));
  const two = offered.offer.candidates.find(candidate => candidate.songId === '2').index;
  assert.equal((await h.service.commitSelection({ offerId: offered.offerId, indexes: [two] }, context('ledger-switch'))).ok, true);
  assert.equal(decisionRows(h)[0].path, 'chat');
  await startCurrent(h, 'switch-two');
  await h.playbackRuntime.submit({ type: 'LISTENING_SESSION_SWITCH_REQUESTED', eventId: 'away', listeningSessionId: 'other' });
  assert.equal(decisionRows(h)[0].outcome, 'superseded', '切换来源不算跳过');
  await h.playbackRuntime.submit({ type: 'LISTENING_SESSION_SWITCH_REQUESTED', eventId: 'back', listeningSessionId: 'room' });
  const resumed = h.playbackRuntime.snapshot();
  assert.equal(resumed.queue[resumed.currentIndex].queueItemId, decisionRows(h)[0].queue_item_id, '切回后仍是同一个 occurrence');
  if (resumed.phase !== 'playing') await startCurrent(h, 'switch-two-resume');
  const state = h.playbackRuntime.snapshot();
  await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'ended-two', natural: true, runtimeVersion: state.version,
    listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration, songId: state.currentSongId,
    programId: state.txn?.programId, correlationId: state.txn?.correlationId });
  assert.equal(decisionRows(h)[0].outcome, 'completed', '最终结果覆盖 superseded');
});

test('decision ledger: another occurrence of the same song never credits the recommended one; stale ended is ignored', async t => {
  const h = fixture(t, { userCandidates: candidatesOf(2) });
  attachLedger(h);
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, context('dup-rec'));
  assert.equal((await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('dup-rec'))).ok, true);
  const [row] = decisionRows(h);
  const first = h.playbackRuntime.snapshot();
  assert.ok(first.queue.some(track => track.queueItemId === row.queue_item_id));
  // 同一首歌被点播成新的 occurrence（不是推荐，不写账本），推荐那一首还没开始出声。
  assert.equal((await h.service.execute(exact(2), context('dup-exact'))).ok, true);
  const second = h.playbackRuntime.snapshot();
  assert.notEqual(second.queue[second.currentIndex].queueItemId, row.queue_item_id);
  // 迟到的 ended 带着推荐那一首的旧 correlation：runtime 拒绝，账本不变。
  const late = await h.playbackRuntime.submit({ type: 'TRACK_ENDED', eventId: 'late-ended', natural: true,
    runtimeVersion: second.version, listeningSessionId: 'room', outputGeneration: first.outputGeneration,
    songId: '2', programId: first.txn.programId, correlationId: first.txn.correlationId });
  assert.equal(late.accepted, false);
  await playCurrentThrough(h, 'dup-exact');
  assert.deepEqual(decisionRows(h).map(item => item.outcome), [null], '点播 occurrence 听完不会记到推荐行上');
});

// ---- ground-music-selection-in-taste 2.2：2000 首规模的 select() 耗时 ----
test('local library scale: select() over 2000 tagged tracks stays within 150ms of the old 1000-row pool', async t => {
  const { SongTagStore } = await import('../songtags/songTagStore.js');
  const dir = mkdtempSync(join(tmpdir(), 'lunara-scale-tags-'));
  const tagStore = new SongTagStore({ dbPath: join(dir, 'tags.db'), getRecordingStore: () => null });
  tagStore.initialize();
  t.after(() => { tagStore.close(); rmSync(dir, { recursive: true, force: true }); });
  const genres = ['rnb', 'pop', 'rock', 'jazz', 'folk'];
  const rows = Array.from({ length: 2000 }, (_, index) => ({ song_id: `s${index}`, title: `歌${index}`,
    artist: `歌手${index % 120}`, album: `专辑${index % 300}`, source: 'qq:library' }));
  tagStore.db.transaction(() => {
    for (const [index, row] of rows.entries()) {
      if (index % 2) continue; // 一半有标签，一半未标注
      tagStore.upsert({ provider: 'qq', song_id: row.song_id, title: row.title, artist: row.artist,
        genre: genres[index % genres.length], language: 'zh', mood: 'calm', tempo: 'mid', confidence: 0.8 });
    }
  })();
  const { h } = await tasteFixture(t, { tagStore, userCandidates: rows,
    claims: [{ key: 'music.genre.rnb', confidence: 0.6 }, { key: 'music.genre.rock', polarity: 'negative', confidence: 0.7 }] });
  const now = Date.now();
  const plays = Array.from({ length: 300 }, (_, index) => ({ ts: now - index * 3_600_000, song_id: `s${index * 5}`, source: 'qq' }));
  h.service.getRecentPlays = () => plays;
  const measure = async (pool, label) => {
    h.service.getCandidates = async () => pool;
    const samples = [];
    for (let run = 0; run < 7; run++) {
      const started = performance.now();
      const selection = await h.service.select(discovery(4), context(`${label}-${run}`));
      samples.push(performance.now() - started);
      assert.ok(selection.candidates.length > 0);
    }
    return samples.sort((a, b) => a - b)[3];
  };
  // 标签按 provider 批量预取：一次选歌里不再逐首查库（改动前约为 候选数 ×（1 + 口味信号数））。
  let reads = 0;
  const original = tagStore.getTags.bind(tagStore);
  tagStore.getTags = (...args) => { reads += 1; return original(...args); };
  h.service.getCandidates = async () => rows;
  await h.service.select(discovery(4), context('count'));
  tagStore.getTags = original;
  assert.equal(reads, 0, '全部候选的标签都来自批量预取');
  await measure(rows.slice(0, 200), 'warmup');
  const before = await measure(rows.slice(0, 1000), 'pool-1000');
  const after = await measure(rows, 'pool-2000');
  t.diagnostic(`select() median: 1000 rows ${before.toFixed(1)}ms, 2000 rows ${after.toFixed(1)}ms`);
  assert.ok(after - before <= 150, `2000 首比 1000 首多花 ${(after - before).toFixed(1)}ms，超过 150ms 预算`);
});

// ── 选歌简报与候选特征（ground-music-selection-in-taste 第 3 组）──
async function briefFixture(t, { memories = [], fixtureOptions = {}, history = null } = {}) {
  const { MemoryService } = await import('../memory/MemoryService.js');
  process.env.LUNARA_DB_PATH = join(tmpdir(), `lunara-brief-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const mem = new MemoryService('radiohost:a');
  await mem.initialize();
  for (const memory of memories) mem.addMemory({ namespace: mem.namespace, importance: 7, confidence: 0.7, ...memory });
  const h = fixture(t, { getMemoryService: () => mem, now: () => new Date(2026, 9, 23, 22, 0).getTime(), ...fixtureOptions });
  h.service.getRecentPlays = () => [];
  h.service.getListeningHistory = () => history || { plays: [], songStats: [] };
  h.events = [];
  h.service.trace = event => h.events.push(event);
  h.service.initialize();
  t.after(() => mem.shutdown());
  return { h, mem };
}
const feedbackMemory = (content, policy = {}, extra = {}) => ({ type: 'semantic', source: 'user_explicit_feedback', content,
  tags: 'person-relationship,music-feedback', evidence: JSON.stringify({ quote: content, policy }), ...extra });

test('brief privacy: group chats drop one-to-one feedback; revoked and expired feedback never appear（3.2）', async t => {
  const { h } = await briefFixture(t, { memories: [
    feedbackMemory('公开反馈：喜欢慢歌'),
    feedbackMemory('私下反馈：只告诉你我喜欢某歌手', { disclosure: 'private' }),
    feedbackMemory('撤回的反馈：喜欢摇滚', {}, { tags: 'person-relationship,music-feedback,revoked' }),
    feedbackMemory('过期的反馈：今晚想听爵士', { until: Date.now() - 60_000 }),
  ] });
  h.registry.update('a', { personaDocument: '# a\n\n## 我喜欢的音乐\n偏好 city pop\n' });
  const group = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, context('brief-group'));
  assert.match(group.brief, /公开反馈：喜欢慢歌/);
  for (const hidden of ['私下反馈', '撤回的反馈', '过期的反馈']) assert.equal(group.brief.includes(hidden), false, hidden);
  assert.match(group.brief, /【伙伴自己的审美（这是伙伴自己的审美，不是用户口味）】\n偏好 city pop/);

  h.conversationStore.createRoom({ sessionId: 'solo', memberIds: ['a'] });
  const solo = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 2 },
    { sessionId: 'solo', virtualPersonId: 'a', requestId: 'brief-solo' });
  assert.match(solo.brief, /私下反馈：只告诉你我喜欢某歌手/, '一对一聊天里仍可用');

  const traced = h.events.filter(event => event.event === 'music-selection-brief');
  assert.equal(traced.length, 2);
  assert.deepEqual(Object.keys(traced[0]).sort(), ['event', 'length', 'offerId', 'personId', 'requestId', 'sections', 'sessionId', 'truncated']);
  assert.equal(traced[0].sections.feedback, 1);
  assert.equal(traced[0].length, group.brief.length);
  const leaked = JSON.stringify(h.events);
  for (const text of ['公开反馈', 'city pop', '私下反馈']) assert.equal(leaked.includes(text), false, `trace 不含 ${text}`);
  const offerRows = JSON.stringify(h.conversationStore.db.prepare('SELECT * FROM music_selection_offers').all());
  assert.equal(offerRows.includes('公开反馈') || offerRows.includes('city pop'), false, 'offer 存储不含简报正文');
});

test('offer features ride the offer: aligned per index, untagged is null, ledger keeps only a flat snapshot（3.4）', async t => {
  const tagged = { language: 'zh', genre: 'rnb', mood: 'calm', tempo: 'slow', energy: 0.3, year: 2019, has_vocal: 1, themes: ['夜晚'] };
  const { h } = await briefFixture(t, { fixtureOptions: { getTags: songId => (songId === '1' ? tagged : null) } });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 2 }, context('features'));
  assert.equal(offered.offer.features.length, offered.offer.candidates.length);
  const position = songId => offered.offer.candidates.findIndex(candidate => candidate.songId === songId);
  assert.deepEqual(offered.offer.features[position('1')].tags, { language: 'zh', genres: ['rnb'], mood: 'calm', tempo: 'slow',
    energy: 0.3, year: 2019, hasVocal: true, themes: ['夜晚'] });
  assert.equal(offered.offer.features[position('2')].tags, null, '未标注明确为 null');
  assert.equal(offered.offer.features[position('2')].origin, 'library');
  const stored = h.service.offers.get(offered.offerId);
  assert.deepEqual(stored.features, offered.offer.features, '特征随 offer 落库');

  const one = offered.offer.candidates[position('1')].index;
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [one] }, context('features'));
  assert.equal(committed.code, 'MUSIC_RECOMMENDED');
  const snapshot = JSON.parse(decisionRows(h)[0].features_json);
  assert.deepEqual(snapshot.tags, ['zh', 'rnb', 'calm', 'slow', 'vocal']);
  assert.deepEqual(snapshot.freshness, { plays14d: 0 });
  assert.equal(snapshot.origin, 'library');
});

test('exact selections carry no brief and no features（3.6）', async t => {
  const { h } = await briefFixture(t, { memories: [feedbackMemory('公开反馈：喜欢慢歌')] });
  const exactSelection = await h.service.select(exact(1, 'recommend_only'), context('brief-exact'));
  assert.equal(exactSelection.brief, undefined);
  assert.equal(exactSelection.offer, undefined);
  assert.equal(h.events.some(event => event.event === 'music-selection-brief'), false);
});

test('chat and auto-continue offers carry the same brief from the same function（3.7）', async t => {
  const { h } = await briefFixture(t, { memories: [feedbackMemory('公开反馈：喜欢慢歌')],
    history: { plays: [{ ts: new Date(2026, 9, 23, 21, 0).getTime(), title: '歌1', artist: '歌手', outcome: 'completed' }],
      songStats: [{ songQuery: '歌1 — 歌手', outcome: 'completed', count: 3, lastSeenAt: new Date(2026, 9, 22).getTime() }] } });
  const request = { mode: 'discovery', delivery: 'append', count: 2, softPreferences: '安静一点' };
  const chat = await h.service.execute(request, context('brief-chat'));
  const auto = await h.service.execute({}, { ...context('brief-auto'), reason: 'auto_continue',
    musicTaskRequest: { request, reason: 'auto_continue', sessionId: 'room' } });
  assert.equal(chat.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(auto.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.ok(chat.brief.length > 0);
  assert.equal(auto.brief, chat.brief, '同角色同会话同条件：简报逐字一致');
  assert.match(chat.brief, /近 30 天常听完的歌手：歌手（3 次）/);
  assert.match(chat.brief, /软偏好：安静一点/);
  const traced = h.events.filter(event => event.event === 'music-selection-brief');
  assert.deepEqual(traced[0].sections, traced[1].sections);
});

// ---- ground-music-selection-in-taste 4：窗口变大 ----
/** 150 首、各自不同歌手与专辑：池子大于 120，分散后窗口仍能取满。 */
const wideRows = (count = 150) => Array.from({ length: count }, (_, index) => ({ song_id: `w${index + 1}`,
  title: `宽曲${index + 1}号`, artist: `宽歌手${index + 1}`, album: `宽专辑${index + 1}`, source: 'qq' }));

test('window size reads MUSIC_OFFER_WINDOW: default 40, clamped to 20–60; still at most 10 indexes（4.1）', () => {
  assert.equal(offerWindowSize({}), 40);
  assert.equal(offerWindowSize({ MUSIC_OFFER_WINDOW: '30' }), 30);
  assert.equal(offerWindowSize({ MUSIC_OFFER_WINDOW: '5' }), 20);
  assert.equal(offerWindowSize({ MUSIC_OFFER_WINDOW: '99' }), 60);
  assert.equal(offerWindowSize({ MUSIC_OFFER_WINDOW: 'abc' }), 40);
  assert.equal(normalizeOfferIndexes(Array.from({ length: 11 }, (_, index) => index + 1), 60), null, '一次最多 10 个序号');
  assert.deepEqual(normalizeOfferIndexes([35, 60], 60), [35, 60]);
});

test('default offer shows 40 candidates drawn from a 120-track ranked pool（4.1）', async t => {
  const rows = wideRows();
  const h = fixture(t, { userCandidates: rows });
  const events = [];
  h.service.trace = event => events.push(event);
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('wide-default'));
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.equal(offered.offer.candidates.length, 40);
  const dispersion = events.find(event => event.event === 'music-selection-album-dispersion');
  assert.equal(dispersion.albumCount, 120, '排序后保留 120 首进入分散');
  assert.equal(dispersion.outsideWindow, 80);
  const narrow = await withWindowEnv({ MUSIC_OFFER_WINDOW: '20' },
    () => h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('wide-narrow')));
  assert.equal(narrow.offer.candidates.length, 20, '回滚到 20 首窗口');
});

test('pre-resolution covers only the window head; picking #35 resolves normally and commits（4.2）', async t => {
  const rows = wideRows();
  const h = fixture(t, { userCandidates: rows, continuationCandidates: rows, preResolveConcurrency: 4 });
  const calls = [];
  const resolve = h.service.programCommitService.resolveTrack;
  h.service.programCommitService.resolveTrack = async (query, options) => {
    calls.push({ id: options.candidate.sourceSongId, preResolve: Boolean(options.preResolve) });
    return resolve(query, options);
  };
  const input = context('wide-commit');
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'replace_now', count: 1 }, input);
  await drain(); await drain();
  const head = offered.offer.candidates.slice(0, 20).map(candidate => candidate.songId);
  assert.deepEqual(calls.filter(call => call.preResolve).map(call => call.id).sort(), [...head].sort(),
    '只预解析窗口前 20 首');
  const target = offered.offer.candidates[34].songId;
  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [35] }, input);
  assert.equal(committed.ok, true, committed.code);
  assert.deepEqual(calls.filter(call => call.id === target).map(call => call.preResolve), [false], '第 35 首走常规解析');
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId), [target]);
});

test('MUSIC_PRE_RESOLVE_HEAD=0 turns pre-resolution off without breaking the offer（4.2）', async t => {
  const h = fixture(t, { userCandidates: wideRows(), preResolveConcurrency: 4 });
  const calls = [];
  h.service.programCommitService.resolveTrack = async (_query, options) => { calls.push(options.candidate.sourceSongId); return { ok: false }; };
  const offered = await withWindowEnv({ MUSIC_PRE_RESOLVE_HEAD: '0' },
    () => h.service.execute({ mode: 'discovery', delivery: 'append', count: 3 }, context('wide-no-pre')));
  await drain();
  assert.equal(offered.code, 'MUSIC_CANDIDATES_OFFERED');
  assert.deepEqual(calls, []);
});

test('a prepared batch can hold indexes beyond 20 and is adopted at the boundary（4.3）', async t => {
  const rows = wideRows();
  const h = fixture(t, { continuationCandidates: rows });
  await activateSession(h);
  const { offered, saved } = await holdBatch(h, { indexes: [35, 36] });
  assert.equal(offered.offer.candidates.length, 40);
  assert.deepEqual(saved.indexes, [35, 36]);
  const adopted = await adoptPrepared(h, offered.request);
  assert.equal(adopted.matched, true);
  assert.equal(adopted.ok, true, adopted.result?.code);
  assert.deepEqual(h.playbackRuntime.snapshot().queue.map(track => track.songId),
    ['4', offered.offer.candidates[34].songId, offered.offer.candidates[35].songId]);
});

// ---- 综合打分与 24 小时冷却（ground-music-selection-in-taste 6.x）----
const HOUR_MS = 3_600_000;
const scoredSongs = (ids, extra = () => ({})) => ids.map(id => ({ song_id: String(id), title: `歌${id}`, artist: `歌手${id}`,
  source: 'qq', album: '录音室', ...extra(id) }));
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};

test('冷却窗口是 24 小时：23 小时前放过的垫底、25 小时前的回到打分；推荐排除同口径，环境变量仍可覆盖（6.1a）', async t => {
  const now = Date.now();
  const h = fixture(t, { userCandidates: scoredSongs([1, 2, 3, 4]) });
  h.service.getRecentPlays = since => [
    { ts: now - 23 * HOUR_MS, song_id: '1', source: 'qq' },
    { ts: now - 25 * HOUR_MS, song_id: '2', source: 'qq' },
  ].filter(row => row.ts >= since);
  const selection = await h.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 4 }, context('cooldown-24h'));
  assert.deepEqual(ordered(selection), ['3', '4', '2', '1']);
  const features = selection.offer.features;
  const at = songId => features[selection.offer.candidates.findIndex(item => item.songId === songId)];
  assert.deepEqual(at('1').scoreParts, { cooldown: 1 }, '冷却组没有分数');
  assert.equal(at('1').score, null);
  assert.ok(at('2').score > 0, '25 小时前放过的已经出冷却，参与打分');

  const exclusionContext = { listening: {}, entity: { memoryNamespace: 'radiohost:a' } };
  const exclusion = songId => h.service._recommendationExclusion({ source: 'qq', songId }, exclusionContext);
  assert.equal(exclusion('1'), 'recent');
  assert.equal(exclusion('2'), null, '主动推荐的「近期放过」也是 24 小时');
  await withEnv({ MUSIC_FRESHNESS_COOLDOWN_MS: String(2 * HOUR_MS) }, async () => {
    assert.equal(exclusion('1'), null, 'MUSIC_FRESHNESS_COOLDOWN_MS 覆盖仍生效');
  });
});

test('打分让强口味超过只放过一次的旧歌；MUSIC_SCORING_DISABLED=1 回到分层排序（6.2 / 6.3）', async t => {
  const { h } = await tasteFixture(t, { claims: [{ key: 'music.genre.rnb', confidence: 0.7 }] });
  const now = Date.now();
  h.service.getRecentPlays = () => [{ ts: now - 8 * 86_400_000, song_id: '3', source: 'qq' }];
  const scored = await h.service.select(discovery(4), context('scored'));
  assert.equal(ordered(scored)[0], '3', '8 天前放过一次 + 口味命中排到最前');
  await withEnv({ MUSIC_SCORING_DISABLED: '1' }, async () => {
    const legacy = await h.service.select(discovery(4), context('legacy'));
    assert.deepEqual(ordered(legacy), ['1', '2', '4', '3'], '分层排序：放过的歌整体排在没放过的之后');
    assert.equal(legacy.offer.features.some(feature => 'score' in feature), false, '关闭时不带分数');
  });
});

test('分数随 offer 进入候选特征与决策账本；技术失败不算歌手跳过（6.2 / 6.3）', async t => {
  const { h } = await briefFixture(t, { fixtureOptions: { userCandidates: scoredSongs([1, 2, 3]) } });
  const at = h.service.now();
  h.service.getListeningHistory = () => ({ plays: [], songStats: [], observations: [
    ...[1, 2, 3, 4].map(i => ({ songQuery: `歌1 — 歌手1`, outcome: 'technical_failure', at: at - i * HOUR_MS })),
    ...[1, 2, 3].map(i => ({ songQuery: `歌2 — 歌手2`, outcome: 'skipped', at: at - i * HOUR_MS })),
  ] });
  const offered = await h.service.execute({ mode: 'discovery', delivery: 'recommend_only', count: 3 }, context('score-ledger'));
  assert.deepEqual(offered.offer.candidates.map(item => item.songId), ['1', '3', '2'], '被频繁跳过的歌手退后');
  const feature = songId => offered.offer.features[offered.offer.candidates.findIndex(item => item.songId === songId)];
  assert.equal(feature('1').scoreParts.artistSkip, 0, '技术失败不形成跳过惩罚');
  assert.equal(feature('2').scoreParts.artistSkip, -0.8);
  assert.equal(typeof feature('1').score, 'number');

  const committed = await h.service.commitSelection({ offerId: offered.offerId, indexes: [1] }, context('score-ledger'));
  assert.equal(committed.code, 'MUSIC_RECOMMENDED');
  const snapshot = JSON.parse(decisionRows(h)[0].features_json);
  assert.equal(snapshot.score, feature('1').score);
  assert.deepEqual(snapshot.scoreParts, feature('1').scoreParts);
});

test('熟悉度节奏开启时试探仍会钉住并记录，其余窗口按节奏排；频率闸不变（6.5）', async t => {
  const rows = [
    { song_id: 'n1', title: '新一', artist: '新歌手一', source: 'qq' },
    { song_id: 'n2', title: '新二', artist: '新歌手二', source: 'qq' },
    { song_id: 'f1', title: '熟一', artist: '熟悉歌手', source: 'qq' },
    { song_id: 'f2', title: '熟二', artist: '熟悉歌手', source: 'qq' },
    { song_id: 'p', title: '探', artist: '探索歌手', source: 'qq' },
  ];
  const { h } = await tasteFixture(t, { claims: [{ key: 'music.genre.rnb', confidence: 0.4 }], userCandidates: rows,
    getTags: songId => (songId === 'p' ? { genres: ['rnb'] } : { genres: ['pop'] }), getFamiliarArtists: () => ['熟悉歌手'] });
  saveFamiliarArtistFeedback(h.conversationStore.db, { personId: 'a', sourceTurnId: 'cadence-probe',
    userText: '我不喜欢一直放不熟悉的歌手，可以偶尔穿插，频率少一点', mode: 'familiar_first' });
  const first = await h.service.select(discovery(5), context('cadence-probe-1'));
  const ids = ordered(first);
  assert.equal(ids[0], 'p', '节奏开启时试探仍钉在窗口头部');
  assert.deepEqual(ids.slice(1, 3), ['f1', 'f2'], '试探之后按熟悉度节奏排');
  assert.deepEqual([...ids].sort(), ['f1', 'f2', 'n1', 'n2', 'p'], '节奏与试探都只重排');
  assert.equal(probeRows(h).length, 1);
  assert.equal(probeRows(h)[0].song_id, 'p');
  await h.service.select(discovery(5), context('cadence-probe-2'));
  assert.equal(probeRows(h).length, 1, '频率闸不变');
});

test('歌手模式只在该歌手的歌之间打分重排；小曲库全部在冷却时照常循环、最早放过的在前（6.6）', async t => {
  const now = Date.now();
  const rows = [
    { song_id: 'a1', title: 'A一', artist: '甲', source: 'qq' },
    { song_id: 'b1', title: 'B一', artist: '乙', source: 'qq' },
    { song_id: 'a2', title: 'A二', artist: '甲', source: 'qq' },
  ];
  const h = fixture(t, { userCandidates: rows });
  h.service.getRecentPlays = () => [{ ts: now - HOUR_MS, song_id: 'a1', source: 'qq' }];
  const artist = await h.service.select({ mode: 'artist', artist: '甲', delivery: 'recommend_only', count: 2 }, context('artist-scored'));
  assert.deepEqual(ordered(artist), ['a2', 'a1'], '只有点名歌手的歌，冷却的退后');

  const small = fixture(t, { userCandidates: scoredSongs([1, 2, 3]) });
  small.service.getRecentPlays = () => [
    { ts: now - 1 * HOUR_MS, song_id: '1', source: 'qq' },
    { ts: now - 5 * HOUR_MS, song_id: '2', source: 'qq' },
    { ts: now - 3 * HOUR_MS, song_id: '3', source: 'qq' },
  ];
  const cycled = await small.service.select({ mode: 'discovery', delivery: 'recommend_only', count: 3 }, context('small-cycle'));
  assert.deepEqual(ordered(cycled), ['2', '3', '1']);
});
