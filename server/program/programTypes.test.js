import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProgramMode,
  ProgramStage,
  createCandidateProgram,
  createCommittedProgram,
  createResolvedProgram,
} from './programTypes.js';

function candidate() {
  return createCandidateProgram({
    requestId: 'rq-program-1',
    mode: ProgramMode.CURATED,
    requestedCount: 2,
    genericSegments: [{ type: 'opening', content: '我找两首不打扰你的。' }],
    constraints: { scenes: ['学习'], maxEnergy: 0.4 },
    candidates: [
      { candidateId: 'candidate-1', query: '久石让 人生旋转木马', genericReason: '低能量器乐' },
      { candidateId: 'candidate-2', query: '李闰珉 雨的印记', genericReason: '安静钢琴' },
    ],
  });
}

function resolved() {
  return createResolvedProgram(candidate(), {
    tracks: [
      {
        candidateId: 'candidate-1',
        songId: 'song-1',
        title: 'Merry-Go-Round of Life',
        artist: '久石让',
        url: 'https://audio.test/song-1.mp3',
        source: 'qq',
        duration: 313,
        evidence: { playable: true },
      },
      {
        candidateId: 'candidate-2',
        songId: 'song-2',
        title: '雨的印记',
        artist: '李闰珉',
        url: 'https://audio.test/song-2.mp3',
        source: 'qq',
        duration: 260,
        evidence: { playable: true },
      },
    ],
    failures: [],
    resolution: { elapsedMs: 24, budgetExhausted: false },
  });
}

test('CandidateProgram validates required fields and is deeply frozen', () => {
  const program = candidate();
  assert.equal(program.stage, ProgramStage.CANDIDATE);
  assert.equal(program.requestId, 'rq-program-1');
  assert.equal(Object.isFrozen(program), true);
  assert.equal(Object.isFrozen(program.constraints), true);
  assert.equal(Object.isFrozen(program.constraints.scenes), true);
  assert.equal(Object.isFrozen(program.candidates[0]), true);
  assert.throws(() => { program.constraints.maxEnergy = 1; }, TypeError);

  assert.throws(() => createCandidateProgram({ mode: 'curated', requestedCount: 1, candidates: [] }), /requestId/);
  assert.throws(() => createCandidateProgram({ requestId: 'rq', mode: 'random', requestedCount: 1, candidates: [] }), /mode/);
  assert.throws(() => createCandidateProgram({ requestId: 'rq', mode: 'curated', requestedCount: 0, candidates: [] }), /requestedCount/);
  assert.throws(() => createCandidateProgram({
    requestId: 'rq', mode: 'curated', requestedCount: 1, candidates: [{ candidateId: 'c1' }],
  }), /query/);
});

test('ResolvedProgram can only be constructed from CandidateProgram and requires canonical playable fields', () => {
  const program = resolved();
  assert.equal(program.stage, ProgramStage.RESOLVED);
  assert.equal(program.requestId, 'rq-program-1');
  assert.equal(program.tracks.length, 2);
  assert.equal(Object.isFrozen(program.tracks[0].evidence), true);
  assert.throws(() => createResolvedProgram({ stage: ProgramStage.COMMITTED }, { tracks: [] }), /CandidateProgram/);
  assert.throws(() => createResolvedProgram(candidate(), {
    tracks: [{ candidateId: 'c1', songId: 's1', title: 'Song', artist: 'Artist', source: 'qq', url: '' }],
  }), /url/);
});

test('CommittedProgram preserves resolved order, is deeply frozen, and rejects invalid transitions', () => {
  const resolvedProgram = resolved();
  const committed = createCommittedProgram(resolvedProgram, {
    programId: 'program-1',
    text: '两首都准备好了。',
    segments: [{ type: 'opening', content: '两首都准备好了。' }],
    narrationItems: [{ kind: 'narration', text: '第一首，开始。' }],
    committedAt: 1_700_000_000_000,
  });

  assert.equal(committed.stage, ProgramStage.COMMITTED);
  assert.deepEqual(committed.tracks.map(track => track.songId), ['song-1', 'song-2']);
  assert.equal(Object.isFrozen(committed.narrationItems[0]), true);
  assert.throws(() => { committed.tracks.reverse(); }, TypeError);
  assert.throws(() => createCommittedProgram(candidate(), { programId: 'bad' }), /ResolvedProgram/);
  assert.throws(() => createCommittedProgram(
    createResolvedProgram(candidate(), { tracks: [], failures: [] }),
    { programId: 'empty' },
  ), /at least one resolved track/);
});
