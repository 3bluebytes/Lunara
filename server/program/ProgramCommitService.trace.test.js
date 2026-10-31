import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueService } from '../playback/QueueService.js';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { ProgramCommitService } from './ProgramCommitService.js';
import { ProgramMode, createCandidateProgram } from './programTypes.js';

function candidate(requestId = 'rq-trace') {
  return createCandidateProgram({
    requestId,
    mode: ProgramMode.CURATED,
    requestedCount: 1,
    candidates: [{ candidateId: 'c1', query: 'A One' }],
  });
}

test('successful trace correlates request, canonical resolution, and committed program id', async () => {
  const traces = [];
  const service = new ProgramCommitService({
    resolveTrack: async () => ({
      ok: true, song_id: 'song-1', title: 'One', artist: 'A', url: '/one.mp3', source: 'qq',
    }),
    queueService: new QueueService(),
    playbackRuntime: new PlaybackRuntimeHost(),
    programIdFactory: () => 'program-trace',
    trace: event => traces.push(event),
  });

  const result = await service.commit(candidate());
  assert.equal(result.ok, true);
  assert.deepEqual(traces.map(event => event.event), [
    'program-resolution-start',
    'program-resolution-done',
    'program-commit-done',
  ]);
  assert.equal(traces.every(event => event.requestId === 'rq-trace'), true);
  assert.equal(traces.at(-1).programId, 'program-trace');
  assert.equal(traces.at(-1).committedCount, 1);
  assert.equal(Number.isFinite(traces.at(-1).resolutionMs), true);
  assert.equal(Number.isFinite(traces.at(-1).commitMs), true);
});

test('budget exhaustion emits a diagnostic terminal event with zero resolved tracks', async () => {
  const traces = [];
  const service = new ProgramCommitService({
    resolveTrack: async () => new Promise(() => {}),
    resolutionBudgetMs: 5,
    trace: event => traces.push(event),
  });

  const result = await service.resolveProgram(candidate('rq-budget'));
  assert.equal(result.ok, false);
  assert.equal(traces.at(-1).event, 'resolution-budget-exhausted');
  assert.equal(traces.at(-1).requestId, 'rq-budget');
  assert.equal(traces.at(-1).resolvedCount, 0);
  assert.equal(Number.isFinite(traces.at(-1).elapsedMs), true);
});
