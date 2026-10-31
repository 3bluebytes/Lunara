import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueService } from '../playback/QueueService.js';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { ProgramCommitService } from './ProgramCommitService.js';
import { ProgramMode, createCandidateProgram } from './programTypes.js';

function candidate(mode = ProgramMode.CURATED, count = 2) {
  return createCandidateProgram({ requestId: `commit-${mode}`, mode, requestedCount: count,
    genericSegments: [{ type: 'opening', content: '未核实的旧口播' }],
    candidates: [{ candidateId: 'c1', query: '旧候选' }, { candidateId: 'c2', query: '可播曲目' }].slice(0, count) });
}
const playable = query => ({ ok: true, song_id: query, title: query, artist: '艺人', url: `/audio/${query}.mp3`, source: 'qq' });
function fixture(options = {}) {
  const events = [], effects = [];
  const queue = new QueueService({ publish: event => events.push(event) });
  const runtime = new PlaybackRuntimeHost({ effectSink: effect => effects.push(effect) });
  runtime.subscribe((snapshot, event) => queue.projectRuntimeSnapshot(snapshot, event.presentation || {}));
  const service = new ProgramCommitService({ playbackRuntime: runtime, resolveTrack: async query => playable(query), ...options });
  return { queue, runtime, service, events, effects };
}

test('canonical replacements commit together; only the activated song requests narration', async () => {
  const h = fixture({ resolveTrack: async query => query === '旧候选' ? { ok: false } : playable(query),
    findSubstitutes: async () => [{ candidateId: 'replacement', query: '真实替代' }], validateSubstitute: () => true });
  const result = await h.service.commit(candidate(), { musicAction: { delivery: 'replace_now' },
    virtualPersonId: 'a', voiceProfileId: 'voice-a', listeningSessionId: 'one',
    narrationContext: { origin: 'prepared', reason: 'user_request' } });
  assert.equal(result.ok, true);
  assert.deepEqual(h.queue.snapshot().queue.map(track => track.song_id), ['真实替代', '可播曲目']);
  assert.equal(h.runtime.snapshot().phase, 'loading');
  assert.equal(h.events.some(event => event.message || event.overlayNarrations?.length), false);
  assert.equal(result.committedProgram.narrationItems.length, 0);
  assert.equal(h.runtime.snapshot().queue[0].narration.status, 'preparing');
  assert.equal(h.runtime.snapshot().queue[0].narration.ttsUrl, null);
  assert.doesNotMatch(JSON.stringify(h.events), /未核实的旧口播/);
});

test('exact resolution failure changes neither queue nor chat and returns factual failure', async () => {
  const h = fixture({ resolveTrack: async () => ({ ok: false, error: 'provider unavailable' }) });
  const before = h.runtime.snapshot();
  const result = await h.service.commit(candidate(ProgramMode.EXPLICIT, 1));
  assert.equal(result.ok, false);
  assert.equal(result.committedProgram, null);
  assert.deepEqual(h.runtime.snapshot(), before);
  assert.equal(h.events.length, 0);
});

test('partial recommendation reports actual count and recommend-only leaves playback untouched', async () => {
  const h = fixture({ resolveTrack: async query => query === '旧候选' ? { ok: false } : playable(query) });
  const before = h.runtime.snapshot();
  const result = await h.service.commit(candidate(), { musicAction: { delivery: 'recommend_only' } });
  assert.equal(result.status, 'partial');
  assert.equal(result.queueResult.offered, 1);
  assert.deepEqual(result.committedProgram.tracks.map(track => track.songId), ['可播曲目']);
  assert.deepEqual(h.runtime.snapshot(), before);
  assert.equal(h.events.length, 0);
});

test('unknown hard-constraint evidence rejects a playable candidate before mutation', async () => {
  const h = fixture({ validateResolvedTrack: () => ({ ok: false, evidence: { requestedLanguage: '粤语' } }) });
  const result = await h.service.commit(candidate(ProgramMode.CURATED, 1));
  assert.equal(result.ok, false);
  assert.equal(h.queue.snapshot().queue.length, 0);
  assert.equal(h.events.length, 0);
});

test('membership cancellation while resolving cannot commit a late program', async () => {
  let current = true;
  const h = fixture({ resolveTrack: async query => { current = false; return playable(query); } });
  await assert.rejects(h.service.commit(candidate(ProgramMode.CURATED, 1), { isCurrent: () => current }), /no longer current/);
  assert.equal(h.runtime.snapshot().queue.length, 0);
});

function revisionRuntime({ queueVersion = 5, rejectReason = null } = {}) {
  const submissions = [];
  return {
    submissions,
    snapshot: () => ({ version: 1 }),
    listeningSnapshot: () => ({ queueVersion, outputGeneration: 0 }),
    async submit(event) {
      submissions.push(event);
      if (event.expectedQueueVersion !== queueVersion) {
        return { accepted: false, reason: 'stale listening queue version', state: { version: 1 }, commands: [], effects: [] };
      }
      if (rejectReason) return { accepted: false, reason: rejectReason, state: { version: 1 }, commands: [], effects: [] };
      return { accepted: true, reason: null, state: { version: 2 }, commands: [], effects: [] };
    },
  };
}

test('a stale queue revision is retried once on the live revision instead of dropping the request', async () => {
  const playbackRuntime = revisionRuntime();
  const h = fixture({ playbackRuntime });
  const result = await h.service.commit(candidate(ProgramMode.CURATED, 1), { listeningSessionId: 'room',
    expectedQueueVersion: 4, outputGeneration: 0 });
  assert.equal(result.ok, true);
  assert.equal(playbackRuntime.submissions.length, 2);
  assert.equal(playbackRuntime.submissions[0].eventId, playbackRuntime.submissions[1].eventId);
  assert.equal(playbackRuntime.submissions[1].expectedQueueVersion, 5);
});

test('a rejection that is not about a stale revision is never retried', async () => {
  const playbackRuntime = revisionRuntime({ rejectReason: 'duplicate event' });
  const h = fixture({ playbackRuntime });
  const result = await h.service.commit(candidate(ProgramMode.CURATED, 1), { listeningSessionId: 'room',
    expectedQueueVersion: 5, outputGeneration: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'commit-failed');
  assert.equal(playbackRuntime.submissions.length, 1);
});

test('the music-action delivery reaches the runtime', async () => {
  const submitted = [];
  const service = new ProgramCommitService({
    resolveTrack: async query => ({ ok: true, songId: 'song-2', title: 'T', artist: 'A', source: 'qq', url: '/a.mp3', duration: 100, query }),
    playbackRuntime: { submit: async event => { submitted.push(event); return { accepted: true, state: { version: 1 } }; } },
  });
  const candidateProgram = createCandidateProgram({ requestId: 'rq-delivery-2', mode: 'curated', requestedCount: 1,
    genericSegments: [], constraints: {}, candidates: [{ candidateId: 'c1', query: 'T A' }] });
  await service.commit(candidateProgram, { listeningSessionId: 'conversation:x',
    musicAction: { delivery: 'after_current' }, virtualPersonId: 'lunara' });
  assert.equal(submitted[0].delivery, 'after_current');
});

test('no delivery anywhere still defaults to append', async () => {
  const submitted = [];
  const service = new ProgramCommitService({
    resolveTrack: async query => ({ ok: true, songId: 'song-3', title: 'T', artist: 'A', source: 'qq', url: '/a.mp3', duration: 100, query }),
    playbackRuntime: { submit: async event => { submitted.push(event); return { accepted: true, state: { version: 1 } }; } },
  });
  const candidateProgram = createCandidateProgram({ requestId: 'rq-delivery-3', mode: 'curated', requestedCount: 1,
    genericSegments: [], constraints: {}, candidates: [{ candidateId: 'c1', query: 'T A' }] });
  await service.commit(candidateProgram, { listeningSessionId: 'conversation:x', virtualPersonId: 'lunara' });
  assert.equal(submitted[0].delivery, 'append');
});

function recommendedProgram() {
  return createCandidateProgram({ requestId: 'commit-recommended', mode: ProgramMode.CURATED, requestedCount: 3,
    candidates: [
      { candidateId: 'c1', query: '主持人的歌', evidence: { source: 'qq', virtualPersonId: 'host' } },
      { candidateId: 'c2', query: '成员推荐', evidence: { source: 'qq', virtualPersonId: 'member' } },
      { candidateId: 'c3', query: '外人的歌', evidence: { source: 'qq', virtualPersonId: 'stranger' } },
    ] });
}

test('提交人是串词人；本轮成员的推荐另记 recommendedBy，自己或未担保的人为 null', async () => {
  const h = fixture();
  const result = await h.service.commit(recommendedProgram(), { musicAction: { delivery: 'replace_now' },
    virtualPersonId: 'host', voiceProfileId: 'voice-host', listeningSessionId: 'room',
    recommenderIds: ['member'] });
  assert.equal(result.ok, true);
  const queue = h.runtime.snapshot().queue;
  assert.deepEqual(queue.map(track => track.virtualPersonId), ['host', 'host', 'host']);
  assert.deepEqual(queue.map(track => track.recommendedBy), [null, 'member', null]);
});

test('没有调用方担保的推荐人时不写归属', async () => {
  const h = fixture();
  await h.service.commit(recommendedProgram(), { musicAction: { delivery: 'replace_now' },
    virtualPersonId: 'host', listeningSessionId: 'room' });
  assert.deepEqual(h.runtime.snapshot().queue.map(track => track.recommendedBy), [null, null, null]);
});
