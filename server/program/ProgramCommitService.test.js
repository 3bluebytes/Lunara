import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgramCommitService } from './ProgramCommitService.js';
import { ProgramMode, createCandidateProgram } from './programTypes.js';

function candidateProgram({ mode = ProgramMode.CURATED, requestedCount = 2 } = {}) {
  return createCandidateProgram({
    requestId: `rq-${mode}`,
    mode,
    requestedCount,
    genericSegments: [{ type: 'opening', content: '我找一下。' }],
    constraints: { scenes: ['学习'], hasVocal: false, maxEnergy: 0.4 },
    candidates: [
      { candidateId: 'c1', query: '候选一', genericReason: '安静器乐' },
      { candidateId: 'c2', query: '候选二', genericReason: '低能量' },
    ].slice(0, requestedCount),
  });
}

function playable(query, overrides = {}) {
  const suffix = query.replace(/\s+/g, '-');
  return {
    ok: true,
    song_id: `song-${suffix}`,
    title: `标题-${query}`,
    artist: `艺人-${query}`,
    url: `https://audio.test/${suffix}.mp3`,
    source: 'qq',
    duration: 180,
    ...overrides,
  };
}

test('all candidates resolve in parallel into a full frozen ResolvedProgram', async () => {
  const started = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new ProgramCommitService({
    resolveTrack: async query => {
      started.push(query);
      await gate;
      return playable(query);
    },
    resolutionBudgetMs: 1_000,
  });

  const pending = service.resolveProgram(candidateProgram());
  await Promise.resolve();
  assert.deepEqual(started, ['候选一', '候选二']);
  release();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.status, 'full');
  assert.deepEqual(result.resolvedProgram.tracks.map(track => track.candidateId), ['c1', 'c2']);
  assert.equal(Object.isFrozen(result.resolvedProgram), true);
});

test('curated first-track failure may use a playable constraint-proven substitute in the same position', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async query => query === '候选一'
      ? { ok: false, error: 'unplayable' }
      : playable(query),
    findSubstitutes: async ({ candidate }) => candidate.candidateId === 'c1'
      ? [{ candidateId: 'sub-c1', query: '替代一', evidence: { scenes: ['学习'], energy: 0.2 } }]
      : [],
    validateSubstitute: ({ substitute }) => ({
      ok: substitute.evidence.energy <= 0.4,
      evidence: { constraintMatch: true },
    }),
  });

  const result = await service.resolveProgram(candidateProgram());
  assert.equal(result.status, 'full');
  assert.deepEqual(result.resolvedProgram.tracks.map(track => track.title), ['标题-替代一', '标题-候选二']);
  assert.deepEqual(result.resolvedProgram.tracks[0].substitutedFrom, {
    candidateId: 'c1',
    query: '候选一',
  });
  assert.deepEqual(result.resolvedProgram.tracks[0].evidence.constraintMatch, true);
});

test('curated mode commits fewer tracks when replacement has no constraint evidence', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async query => query === '候选一' ? { ok: false } : playable(query),
    findSubstitutes: async () => [{ candidateId: 'random', query: '随机高能人声' }],
    // No validateSubstitute: safe default must reject an unproven random item.
  });

  const result = await service.resolveProgram(candidateProgram());
  assert.equal(result.ok, true);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.resolvedProgram.tracks.map(track => track.title), ['标题-候选二']);
  assert.match(result.message, /1 首/);
  assert.equal(result.resolvedProgram.failures[0].reason, 'no-constraint-compatible-substitute');
});

test('total curated failure is explicit and produces no committed program', async () => {
  const service = new ProgramCommitService({ resolveTrack: async () => ({ ok: false }) });
  const result = await service.resolveProgram(candidateProgram());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.resolvedProgram.tracks.length, 0);
  assert.match(result.message, /没找到符合条件且可播放的歌曲/);
});

test('explicit mode never asks for or accepts a different-song substitute', async () => {
  let substituteCalls = 0;
  const service = new ProgramCommitService({
    resolveTrack: async () => ({ ok: false, error: 'not-found' }),
    findSubstitutes: async () => { substituteCalls += 1; return [{ candidateId: 'other', query: '别的歌' }]; },
    validateSubstitute: () => ({ ok: true }),
  });

  const result = await service.resolveProgram(candidateProgram({ mode: ProgramMode.EXPLICIT, requestedCount: 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(substituteCalls, 0);
  assert.match(result.message, /候选一/);
  assert.match(result.message, /无法播放/);
});

test('explicit mode rejects a playable search result that does not match the requested title or artist', async () => {
  const program = createCandidateProgram({
    requestId: 'rq-explicit-match',
    mode: ProgramMode.EXPLICIT,
    requestedCount: 1,
    candidates: [{ candidateId: 'c1', query: '陈绮贞 旅行的意义' }],
  });
  const service = new ProgramCommitService({
    resolveTrack: async () => playable('wrong', {
      title: '晴天', artist: '周杰伦', song_id: 'wrong-song',
    }),
  });

  const result = await service.resolveProgram(program);
  assert.equal(result.ok, false);
  assert.equal(result.resolvedProgram.failures[0].reason, 'explicit-match-failed');
});

test('explicit mode accepts the same requested title and artist from a fallback source', async () => {
  const program = createCandidateProgram({
    requestId: 'rq-explicit-fallback',
    mode: ProgramMode.EXPLICIT,
    requestedCount: 1,
    candidates: [{ candidateId: 'c1', query: '陈绮贞 旅行的意义' }],
  });
  const service = new ProgramCommitService({
    resolveTrack: async () => playable('fallback', {
      title: '旅行的意义', artist: '陈绮贞', song_id: 'fallback-song', source: 'ncm',
    }),
  });

  const result = await service.resolveProgram(program);
  assert.equal(result.ok, true);
  assert.equal(result.resolvedProgram.tracks[0].source, 'ncm');
  assert.equal(result.resolvedProgram.tracks[0].substitutedFrom, null);
});

test('ordered explicit resolution commits the playable targets in order and reports the rest without substitutes', async () => {
  const program = createCandidateProgram({
    requestId: 'rq-ordered-exact',
    mode: ProgramMode.EXPLICIT,
    requestedCount: 2,
    candidates: [
      { candidateId: 'c1', query: '卫兰 — 街灯晚餐', orderedTarget: { title: '街灯晚餐', artist: '卫兰' } },
      { candidateId: 'c2', query: '杨千嬅 — 少女的祈祷', orderedTarget: { title: '少女的祈祷', artist: '杨千嬅' } },
    ],
  });
  const service = new ProgramCommitService({
    resolveTrack: async query => query.includes('街灯晚餐')
      ? { ok: true, song_id: 'street', title: '街灯晚餐', artist: '卫兰', url: '/street.mp3', source: 'ncm' }
      : { ok: false, error: 'not found' },
  });

  const result = await service.resolveProgram(program);
  assert.equal(result.ok, true, '有能放的就提交能放的');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.resolvedProgram.tracks.map(track => track.songId), ['street']);
  assert.equal(result.resolvedProgram.tracks[0].substitutedFrom, null, '点名模式不找替补');
  assert.equal(result.resolvedProgram.failures[0].query, '杨千嬅 — 少女的祈祷');
  assert.match(result.message, /确认了 1 首.*原计划 2 首.*没有用别的歌顶替/);
});

test('explicit resolution with no playable target still fails and leaves the queue unchanged', async () => {
  const program = createCandidateProgram({
    requestId: 'rq-exact-none', mode: ProgramMode.EXPLICIT, requestedCount: 2,
    candidates: [
      { candidateId: 'c1', query: '卫兰 — 街灯晚餐', orderedTarget: { title: '街灯晚餐', artist: '卫兰' } },
      { candidateId: 'c2', query: '杨千嬅 — 少女的祈祷', orderedTarget: { title: '少女的祈祷', artist: '杨千嬅' } },
    ],
  });
  const service = new ProgramCommitService({ resolveTrack: async () => ({ ok: false, error: 'not found' }) });
  const result = await service.resolveProgram(program);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /队列没有变化/);
});

test('resolution retries are bounded and can recover before the attempt budget is exhausted', async () => {
  const attempts = new Map();
  const service = new ProgramCommitService({
    attemptsPerCandidate: 2,
    resolveTrack: async query => {
      const count = (attempts.get(query) || 0) + 1;
      attempts.set(query, count);
      return count === 1 ? { ok: false, error: 'temporary' } : playable(query);
    },
  });

  const result = await service.resolveProgram(candidateProgram());
  assert.equal(result.status, 'full');
  assert.equal(attempts.get('候选一'), 2);
  assert.equal(attempts.get('候选二'), 2);
});

test('resolution wall-clock timeout returns promptly and records budget exhaustion', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async () => new Promise(() => {}),
    resolutionBudgetMs: 10,
    attemptsPerCandidate: 3,
  });
  const startedAt = Date.now();
  const result = await service.resolveProgram(candidateProgram());

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.resolvedProgram.resolution.budgetExhausted, true);
  assert.equal(result.resolvedProgram.failures.every(failure => failure.reason === 'resolution-budget-exhausted'), true);
  assert.ok(Date.now() - startedAt < 500);
});

test('default retry resolves only the failed item once and retains concurrent successes in order', async () => {
  const calls = [], traces = [], submissions = [];
  const program = createCandidateProgram({ requestId: 'local-retry', mode: 'explicit', requestedCount: 6,
    candidates: Array.from({ length: 6 }, (_, i) => ({ candidateId: `c${i}`, query: `A — T${i}`,
      sourceSongId: String(i), evidence: { source: 'qq' } })) });
  const service = new ProgramCommitService({ trace: event => traces.push(event),
    playbackRuntime: { submit: async event => { submissions.push(event); return { accepted: true, state: { version: 1 } }; } },
    resolveTrack: async (_query, { candidate, attempt }) => {
      calls.push(candidate.sourceSongId);
      if (candidate.sourceSongId === '5' && attempt === 1) throw new Error('https://secret.test?cookie=private');
      return playable('x', { song_id: candidate.sourceSongId, title: `T${candidate.sourceSongId}`, artist: 'A' });
    } });
  const result = await service.commit(program);
  assert.equal(result.ok, true);
  assert.equal(submissions.length, 1, '恢复后整批只原子提交一次');
  assert.deepEqual(submissions[0].tracks.map(track => track.songId), ['0', '1', '2', '3', '4', '5']);
  assert.deepEqual(calls, ['0', '1', '2', '3', '4', '5', '5']);
  assert.deepEqual(result.resolvedProgram.tracks.map(track => track.songId), ['0', '1', '2', '3', '4', '5']);
  assert.equal(traces.filter(event => event.event === 'program-resolution-retry').length, 1);
  assert.doesNotMatch(JSON.stringify(traces), /secret|cookie|private|https:/);
});

test('identity and constraint failures are not retried, and persistent errors stay classified', async () => {
  for (const kind of ['song', 'provider', 'constraint', 'temporary', 'resource']) {
    let calls = 0;
    const service = new ProgramCommitService({ attemptsPerCandidate: 99,
      resolveTrack: async () => {
        calls++;
        if (kind === 'temporary') throw new Error('https://secret.test?token=private');
        if (kind === 'resource') return { ok: false, error: 'canonical-resource-unavailable' };
        return playable('x', { song_id: kind === 'song' ? 'other' : 'locked', title: 'T', artist: 'A',
          source: kind === 'provider' ? 'ncm' : 'qq' });
      }, validateResolvedTrack: () => ({ ok: kind !== 'constraint' }) });
    const program = createCandidateProgram({ requestId: kind, mode: 'explicit', requestedCount: 1,
      candidates: [{ candidateId: 'c', query: 'A — T', sourceSongId: 'locked', evidence: { source: 'qq' } }] });
    const result = await service.resolveProgram(program);
    assert.equal(calls, ['temporary', 'resource'].includes(kind) ? 2 : 1, kind);
    assert.equal(result.ok, false);
    if (kind === 'resource') assert.equal(result.resolvedProgram.failures[0].reason, 'canonical-resource-unavailable');
    assert.doesNotMatch(JSON.stringify(result), /secret|token=|private|https:/);
  }
});

test('cached resources recheck canonical identity and the validation deadline without provider calls', async () => {
  const program = createCandidateProgram({ requestId: 'cached-identity', mode: 'explicit', requestedCount: 1,
    candidates: [{ candidateId: 'c', query: 'A — T', sourceSongId: 'locked', evidence: { source: 'qq' } }] });
  let calls = 0, validations = 0;
  const service = new ProgramCommitService({ resolveTrack: async () => { calls++; throw new Error('unexpected provider call'); },
    validateResolvedTrack: () => { validations++; return { ok: true }; } });
  for (const [override, reason] of [[{ song_id: 'wrong' }, 'canonical-reference-mismatch'],
    [{ source: 'ncm' }, 'canonical-provider-mismatch'], [{ title: 'Other' }, 'explicit-match-failed']]) {
    const result = await service.resolveProgram(program, { resolutionCache: {
      get: () => playable('x', { song_id: 'locked', title: 'T', artist: 'A', ...override }),
    } });
    assert.equal(result.ok, false);
    assert.equal(result.resolvedProgram.failures[0].reason, reason);
  }
  assert.equal(calls, 0);
  assert.equal(validations, 0, '身份失败不能先接受旧约束判定');
  service.resolutionBudgetMs = 5;
  service.validateResolvedTrack = async () => new Promise(() => {});
  const expired = await service.resolveProgram(program, { resolutionCache: {
    get: () => playable('x', { song_id: 'locked', title: 'T', artist: 'A' }),
  } });
  assert.equal(expired.resolvedProgram.failures[0].reason, 'resolution-budget-exhausted');
});

test('retry shares the original deadline and stops when cancelled', async () => {
  let clock = 0, calls = 0;
  const service = new ProgramCommitService({ now: () => clock, resolutionBudgetMs: 10,
    resolveTrack: async () => { calls++; clock = 11; return { ok: false }; } });
  const result = await service.resolveProgram(candidateProgram({ mode: 'explicit', requestedCount: 1 }));
  assert.equal(calls, 1);
  assert.equal(result.resolvedProgram.resolution.budgetExhausted, true);
  const controller = new AbortController();
  service.resolveTrack = async () => { controller.abort(); return { ok: false }; };
  clock = 0;
  await assert.rejects(service.resolveProgram(candidateProgram(), { signal: controller.signal }), { name: 'AbortError' });
});

test('a failed recommendation names the reason and the source instead of guessing', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async () => ({ ok: false, error: 'all-sources-failed', code: 'requires-member',
      failures: [{ source: 'qq', code: 'requires-member' }, { source: 'ncm', code: 'not-found' }] }),
    attemptsPerCandidate: 1,
    resolutionBudgetMs: 500,
  });
  const result = await service.resolveProgram(candidateProgram({ requestedCount: 2 }));
  assert.equal(result.status, 'failed');
  assert.match(result.message, /QQ 音乐需要会员才能听这首歌/);
  assert.match(result.message, /队列没有变化/);
  // 公开形状不变：失败项仍是原字段，不掺入原因明细。
  assert.deepEqual(Object.keys(result.resolvedProgram.failures[0]).sort(),
    ['attempts', 'candidateId', 'error', 'query', 'reason']);
});

test('an explicit request keeps its own wording and only adds the reason', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async () => ({ ok: false, error: 'all-sources-failed', code: 'requires-auth',
      failures: [{ source: 'ncm', code: 'requires-auth' }] }),
    attemptsPerCandidate: 1,
    resolutionBudgetMs: 500,
  });
  const result = await service.resolveProgram(candidateProgram({ mode: ProgramMode.EXPLICIT, requestedCount: 1 }));
  assert.match(result.message, /^「候选一」当前无法播放（/);
  assert.match(result.message, /网易云音乐需要登录|需要在网易云音乐登录/);
});

test('a raw resolver string never reaches the user copy', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async () => ({ ok: false, error: 'all-sources-failed',
      code: 'cookie=SECRET boom 500', failures: [{ source: 'qq', code: 'cookie=SECRET boom 500' }] }),
    attemptsPerCandidate: 1,
    resolutionBudgetMs: 500,
  });
  const result = await service.resolveProgram(candidateProgram({ requestedCount: 1 }));
  // 不认识的字符串不猜：退回通用文案，且原文一个字都不进用户可见消息。
  assert.doesNotMatch(result.message, /SECRET|boom|cookie/);
  assert.equal(result.message, '这次没找到符合条件且可播放的歌曲，队列没有变化。');
});

test('a classified internal failure still gets an actionable sentence', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async () => ({ ok: false, error: 'all-sources-failed', code: 'internal',
      failures: [{ source: 'qq', code: 'internal' }] }),
    attemptsPerCandidate: 1,
    resolutionBudgetMs: 500,
  });
  const result = await service.resolveProgram(candidateProgram({ requestedCount: 1 }));
  assert.match(result.message, /这次没放成：暂时没能拿到这首歌/);
});

test('without a reason code the previous copy is unchanged', async () => {
  const service = new ProgramCommitService({
    resolveTrack: async () => ({ ok: false, error: 'resolution-failed' }),
    attemptsPerCandidate: 1,
    resolutionBudgetMs: 500,
  });
  const result = await service.resolveProgram(candidateProgram({ requestedCount: 1 }));
  assert.equal(result.message, '这次没找到符合条件且可播放的歌曲，队列没有变化。');
});
