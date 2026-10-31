import {
  ProgramMode,
  createCommittedProgram,
  createResolvedProgram,
  isCandidateProgram,
} from './programTypes.js';
import { createHash } from 'node:crypto';
import { PlaybackEventType } from '../playback/playbackRuntimeTypes.js';
import { sourceAllowed } from '../music/sourcePolicy.js';
import { providerRegistry } from '../music/providerRegistry.js';
import { describeSourceFailure, dominantSourceFailure, isSourceFailureCode, SOURCE_FAILURE } from '../music/sourceFailure.js';
import { isConfirmedUnplayable } from './unplayableTrackMemory.js';

const BUDGET_EXHAUSTED = Symbol('resolution-budget-exhausted');
const PERMANENT_RESOLUTION_REASONS = new Set(['canonical-provider-invalid', 'canonical-identity-invalid',
  'canonical-reference-mismatch', 'canonical-provider-mismatch', 'explicit-match-failed',
  'constraint-validation-failed', 'invalid-resolved-track', 'not-found', 'permission-denied', 'source-mode-restricted']);
// Runtime rejections caused by a revision the caller could not have known when it took
// its snapshot. They are retried once against the live revision instead of failing the turn.
const STALE_REVISION_REASONS = new Set(['stale listening queue version', 'stale output generation']);

/**
 * 推荐人：候选证据里的成员，且由调用方担保是本轮的推荐成员（recommenderIds），并且不是提交人。
 * 没有担保就不写归属，宁可少说也不把来源记错。
 */
function recommenderOf(track, options) {
  const personId = track.evidence?.virtualPersonId || null;
  const allowed = Array.isArray(options.recommenderIds) ? options.recommenderIds : [];
  return personId && personId !== options.virtualPersonId && allowed.includes(personId) ? personId : null;
}

function requiredFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`ProgramCommitService requires ${name}()`);
  return value;
}

function raceWithin(promise, remainingMs, signal) {
  if (remainingMs <= 0) return Promise.reject(BUDGET_EXHAUSTED);
  signal?.throwIfAborted();
  let timer, onAbort;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(BUDGET_EXHAUSTED), remainingMs);
  });
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, timeout, aborted]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  });
}

function normalizeConstraintVerdict(value) {
  if (value === true) return { ok: true, evidence: {} };
  if (!value || value === false) return { ok: false, evidence: {} };
  return { ok: value.ok === true, evidence: value.evidence || {} };
}

function playable(result) {
  const songId = result?.song_id ?? result?.songId;
  return !!(
    result?.ok &&
    songId != null && String(songId).trim() &&
    String(result.title || '').trim() &&
    String(result.artist || '').trim() &&
    String(result.url || '').trim() &&
    String(result.source || '').trim()
  );
}

function normalizeIdentity(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)|（[^）]*）|\[[^\]]*\]|【[^】]*】/g, '')
    .replace(/[\s\-–—_:：·,，.。/\\《》"']/g, '');
}

function matchesExplicitRequest(query, result) {
  const requested = normalizeIdentity(query);
  const title = normalizeIdentity(result?.title);
  const artist = normalizeIdentity(result?.artist);
  if (!requested || !title) return false;

  const titleMatches = requested.includes(title) || title.includes(requested);
  if (!titleMatches) return false;
  // A title-only request has no residual identity to validate. If the request
  // also names an artist, the resolved artist must account for that residual.
  const residual = requested.includes(title) ? requested.replace(title, '') : '';
  if (residual.length < 2) return true;
  return !!artist && (artist.includes(residual) || residual.includes(artist));
}

function toResolvedTrack(result, candidate, { substitute = null, constraintEvidence = null } = {}) {
  return {
    // Keep the original candidate id so output order and narration slots remain aligned.
    candidateId: candidate.candidateId,
    songId: String(result.song_id ?? result.songId),
    title: String(result.title).trim(),
    artist: String(result.artist).trim(),
    url: String(result.url).trim(),
    source: String(result.source).trim(),
    duration: Number(result.duration) || 0,
    album: String(result.album || ''),
    artwork: String(result.pic_url || result.artwork || ''),
    lyric: result.lyric || { lrc: '', tlyric: '' },
    substitutedFrom: substitute ? {
      candidateId: candidate.candidateId,
      query: candidate.query,
    } : null,
    evidence: {
      ...(candidate.evidence && typeof candidate.evidence === 'object' ? candidate.evidence : {}),
      ...(substitute?.evidence && typeof substitute.evidence === 'object' ? substitute.evidence : {}),
      ...(constraintEvidence && typeof constraintEvidence === 'object' ? constraintEvidence : {}),
      ...(result.sourcePreference?.reason === 'preferred-resource-unavailable' ? {
        sourcePreference: { preferredProvider: result.sourcePreference.preferredProvider,
          preferredSongId: result.sourcePreference.preferredSongId, reason: 'preferred-resource-unavailable' },
      } : {}),
      resolver: {
        query: substitute?.query || candidate.query,
        source: result.source,
        playable: true,
      },
    },
  };
}

/**
 * 失败原因 → 一句用户能行动的话，例如「QQ 音乐需要会员才能听这首歌」。
 * 只接受封闭枚举：原始异常、URL、凭据与内部错误 ID 永远不进这句文案。
 */
function failureReason(failure) {
  if (!failure?.code) return '';
  const source = failure.source ? providerRegistry.displayName(failure.source) : '';
  return describeSourceFailure(failure.code, { source });
}

/** 多个源都失败时选一句最有信息量的：主源优先，全部 not-found 才说找不到。 */
function pickFailureReason(detail = []) {
  const rows = (Array.isArray(detail) ? detail : []).filter(row => isSourceFailureCode(row?.code));
  if (!rows.length) return null;
  const code = dominantSourceFailure(rows);
  const source = rows.find(row => row.code === code)?.source || '';
  return { code, source };
}

function resultMessage(program, status, count, failure = null) {
  if (status === 'full') return '';
  if (status === 'partial') {
    // 点名的歌也一样：能放的先排上，放不了的不顶替（2026-10-20 用户确认「成功多少是多少」）。
    return program.mode === ProgramMode.EXPLICIT
      ? `这次确认了 ${count} 首可播放歌曲（原计划 ${program.requestedCount} 首）；其余的当前无法播放，没有用别的歌顶替。`
      : `这次确认了 ${count} 首可播放歌曲（原计划 ${program.requestedCount} 首）。`;
  }
  const reason = failureReason(failure);
  if (program.mode === ProgramMode.EXPLICIT) {
    const named = program.candidates.map(candidate => `「${candidate.query}」`).join('、') || '这首歌';
    return reason
      ? `${named}当前无法播放（${reason}），队列没有变化。`
      : `${named}当前无法播放，队列没有变化。`;
  }
  return reason
    ? `这次没放成：${reason}，队列没有变化。`
    : '这次没找到符合条件且可播放的歌曲，队列没有变化。';
}

/**
 * Resolves an immutable CandidateProgram into an immutable ResolvedProgram.
 * Queue mutation and user-visible song commitments intentionally happen later.
 */
export class ProgramCommitService {
  constructor({
    resolveTrack,
    findSubstitutes = async () => [],
    validateSubstitute = null,
    attemptsPerCandidate = 2,
    maxSubstitutesPerCandidate = 3,
    resolutionBudgetMs = 12_000,
    now = Date.now,
    trace = null,
    playbackRuntime = null,
    programIdFactory = null,
    onTrackCommitted = null,
    validateResolvedTrack = null,
    getSourcePolicy = () => null,
  } = {}) {
    this.getSourcePolicy = getSourcePolicy;
    this.resolveTrack = requiredFunction(resolveTrack, 'resolveTrack');
    this.findSubstitutes = requiredFunction(findSubstitutes, 'findSubstitutes');
    this.validateSubstitute = typeof validateSubstitute === 'function'
      ? validateSubstitute
      : () => ({ ok: false, evidence: { reason: 'constraint-evidence-required' } });
    this.attemptsPerCandidate = Math.min(2, Math.max(1, Number.parseInt(attemptsPerCandidate, 10) || 2));
    this.maxSubstitutesPerCandidate = Math.max(1, Number.parseInt(maxSubstitutesPerCandidate, 10) || 3);
    this.resolutionBudgetMs = Math.max(1, Number(resolutionBudgetMs) || 12_000);
    this.now = typeof now === 'function' ? now : Date.now;
    this.trace = typeof trace === 'function' ? trace : () => {};
    this.playbackRuntime = playbackRuntime;
    this.programIdFactory = typeof programIdFactory === 'function'
      ? programIdFactory
      : requestId => `program_${createHash('sha256').update(String(requestId)).digest('hex').slice(0, 32)}`;
    this.onTrackCommitted = typeof onTrackCommitted === 'function' ? onTrackCommitted : null;
    this.validateResolvedTrack = typeof validateResolvedTrack === 'function'
      ? validateResolvedTrack
      : () => ({ ok: true, evidence: {} });
  }

  async commit(candidateProgram, options = {}) {
    options.signal?.throwIfAborted();
    if (!this.playbackRuntime || typeof this.playbackRuntime.submit !== 'function') {
      throw new Error('ProgramCommitService.commit requires playbackRuntime.submit()');
    }
    const startedAt = this.now();
    const resolution = await this.resolveProgram(candidateProgram, options);
    options.signal?.throwIfAborted();
    if (options.isCurrent && !options.isCurrent()) throw new Error('music request is no longer current');
    const timings = () => ({ resolutionMs: resolution.resolvedProgram.resolution.elapsedMs || 0, commitMs: Math.max(0, this.now() - startedAt) });
    if (!resolution.ok) return { ...resolution, committedProgram: null, queueResult: null, timings: timings() };

    if (resolution.resolvedProgram.tracks.some(track => !sourceAllowed(this.getSourcePolicy(), track.source))) {
      return { ok: false, status: 'commit-rejected', message: '播放源设置已改变，请按当前模式重新选歌。',
        resolvedProgram: resolution.resolvedProgram, committedProgram: null, queueResult: null, timings: timings() };
    }
    const programId = this.programIdFactory(candidateProgram.requestId);
    const committedProgram = createCommittedProgram(resolution.resolvedProgram, { programId, committedAt: this.now() });
    const delivery = options.musicAction?.delivery || 'append';
    if (delivery === 'recommend_only') return { ...resolution, committedProgram,
      queueResult: { ok: true, offered: committedProgram.tracks.length, delivery }, timings: timings() };

    const continuationPrefix = 'runtime-continuation:';
    const continuationBoundaryKey = committedProgram.requestId.startsWith(continuationPrefix)
      ? committedProgram.requestId.slice(continuationPrefix.length) : null;
    const submitProgram = expected => this.playbackRuntime.submit({
      type: PlaybackEventType.PROGRAM_COMMITTED, eventId: `program:${programId}`, delivery,
      source: options.narrationContext?.reason === 'auto_continue' ? 'auto_continue' : 'user',
      continuationBoundaryKey, listeningSessionId: options.listeningSessionId,
      expectedQueueVersion: expected.queueVersion, outputGeneration: expected.outputGeneration,
      guard: () => (!options.isCurrent || options.isCurrent())
        && committedProgram.tracks.every(track => sourceAllowed(this.getSourcePolicy(), track.source)),
      signal: options.signal, listeningPlan: options.listeningPlan,
      tracks: committedProgram.tracks.map((track, trackIndex) => ({
        ...track, programId, requestId: committedProgram.requestId,
        // 提交人就是这首的负责人与串词人；别的成员推荐的歌另记 recommendedBy，不再借用负责人字段。
        virtualPersonId: options.virtualPersonId || track.evidence?.virtualPersonId,
        recommendedBy: recommenderOf(track, options),
        voiceProfileId: options.voiceProfileId, conversationId: options.listeningSessionId,
        // No model or TTS call at selection time. Each actual transition prepares narration independently.
        narration: options.trackNarrations?.[trackIndex]
          || { status: 'absent', assetStatus: 'missing', generationRevision: 0,
            text: `接下来是${track.artist}的《${track.title}》。`, ttsUrl: null, contentHash: null,
            voiceProfileId: options.voiceProfileId || null,
            context: options.narrationContext || { origin: 'live', reason: 'user_request', mode: candidateProgram.mode } },
      })),
      presentation: { conversationId: options.listeningSessionId, sessionId: options.listeningSessionId, delivery },
    });
    let runtimeResult = await submitProgram({ queueVersion: options.expectedQueueVersion, outputGeneration: options.outputGeneration });
    // A concurrent revision bump (auto-continue finishing a batch, another room editing)
    // must not silently drop a request the listener already made. The runtime guard stays,
    // so we only re-read the live revision and resubmit the same program once. Rejected
    // events are never recorded, so the stable event id cannot double-commit.
    if (!runtimeResult.accepted && STALE_REVISION_REASONS.has(runtimeResult.reason)) {
      const live = typeof this.playbackRuntime.listeningSnapshot === 'function' && options.listeningSessionId
        ? this.playbackRuntime.listeningSnapshot(options.listeningSessionId) : null;
      if (live && (live.queueVersion !== options.expectedQueueVersion || live.outputGeneration !== options.outputGeneration)) {
        this.trace({ event: 'program-commit-retry', requestId: candidateProgram.requestId, reason: runtimeResult.reason });
        runtimeResult = await submitProgram({ queueVersion: live.queueVersion, outputGeneration: live.outputGeneration });
      }
    }
    const queueResult = { ok: runtimeResult.accepted, runtimeVersion: runtimeResult.state.version,
      snapshot: runtimeResult.state, ...(runtimeResult.accepted ? {} : { error: runtimeResult.reason || 'runtime rejected committed program' }) };
    if (!queueResult.ok) return { ok: false, status: 'commit-failed', message: '提交被拒绝：播放状态已经变化，本轮没有提交任何歌曲。',
      resolvedProgram: resolution.resolvedProgram, committedProgram, queueResult, timings: timings() };
    for (const track of committedProgram.tracks) {
      try { await this.onTrackCommitted?.(track, committedProgram); } catch { /* catalog audit is best-effort */ }
    }
    this.trace({ event: 'program-commit-done', requestId: candidateProgram.requestId, programId,
      status: resolution.status, committedCount: committedProgram.tracks.length, ...timings() });
    return { ...resolution, committedProgram, queueResult, timings: timings() };
  }

  async resolveProgram(candidateProgram, options = {}) {
    options.signal?.throwIfAborted();
    if (!isCandidateProgram(candidateProgram)) {
      throw new TypeError('resolveProgram requires a CandidateProgram');
    }
    const startedAt = this.now();
    const deadline = startedAt + this.resolutionBudgetMs;
    const stats = { attempts: 0, substitutions: 0, budgetExhausted: false };

    this.trace({
      event: 'program-resolution-start',
      requestId: candidateProgram.requestId,
      candidateCount: candidateProgram.candidates.length,
    });

    const originalResults = await Promise.all(candidateProgram.candidates.map(candidate =>
      this._resolveCandidate(candidate, deadline, stats, { ...options, requestId: candidateProgram.requestId,
        mode: candidateProgram.mode, candidateProgram }),
    ));

    options.signal?.throwIfAborted();
    const tracks = [];
    const failures = [];
    const failureDetail = [];
    const usedSongIds = new Set();
    for (let index = 0; index < candidateProgram.candidates.length; index++) {
      options.signal?.throwIfAborted();
      const candidate = candidateProgram.candidates[index];
      let resolved = originalResults[index];
      if (resolved.ok && usedSongIds.has(resolved.track.songId)) {
        resolved = { ok: false, reason: 'duplicate-track', error: 'duplicate canonical song id' };
      }

      if (!resolved.ok && candidateProgram.mode === ProgramMode.CURATED && !stats.budgetExhausted) {
        resolved = await this._resolveSubstitute({
          candidateProgram,
          candidate,
          deadline,
          stats,
          usedSongIds,
          originalFailure: resolved,
          signal: options.signal,
        });
      }

      if (resolved.ok) {
        tracks.push(resolved.track);
        usedSongIds.add(resolved.track.songId);
      } else {
        failures.push({
          candidateId: candidate.candidateId,
          query: candidate.query,
          reason: resolved.reason || 'resolution-failed',
          error: resolved.reason || 'resolution-failed',
          attempts: resolved.attempts || 0,
        });
        // 公开形状保持不变；原因码单独收集，只用于生成那句用户可见文案。
        if (resolved.detail?.length) failureDetail.push(...resolved.detail);
        else if (isSourceFailureCode(resolved.code)) failureDetail.push({ code: resolved.code });
      }
    }

    const requestedCount = candidateProgram.requestedCount;
    // 有一首能放就提交能放的（点名模式也一样，只是不找替补）；一首都没有才算失败。
    const status = tracks.length === 0 ? 'failed' : tracks.length >= requestedCount ? 'full' : 'partial';
    const elapsedMs = Math.max(0, this.now() - startedAt);
    const resolvedProgram = createResolvedProgram(candidateProgram, {
      tracks: tracks.slice(0, requestedCount),
      failures,
      resolution: {
        candidateCount: candidateProgram.candidates.length,
        resolvedCount: Math.min(tracks.length, requestedCount),
        attempts: stats.attempts,
        substitutions: stats.substitutions,
        elapsedMs,
        budgetMs: this.resolutionBudgetMs,
        budgetExhausted: stats.budgetExhausted,
      },
      resolvedAt: this.now(),
    });
    const result = Object.freeze({
      ok: status !== 'failed',
      status,
      message: status === 'failed' && failures.some(failure => failure.reason === 'source-mode-restricted')
        ? '当前播放来源不包含这首歌，请在设置中切换来源或多源播放；队列没有变化。'
        : resultMessage(candidateProgram, status, resolvedProgram.tracks.length,
          status === 'failed' ? pickFailureReason(failureDetail) : null),
      resolvedProgram,
    });

    this.trace({
      event: stats.budgetExhausted ? 'resolution-budget-exhausted' : 'program-resolution-done',
      requestId: candidateProgram.requestId,
      status,
      candidateCount: candidateProgram.candidates.length,
      resolvedCount: resolvedProgram.tracks.length,
      elapsedMs,
    });
    return result;
  }

  // Cache hits enter the same validation path as provider results; no stored verdict is trusted.
  async _validatedResult(result, candidate, deadline, trackOptions) {
    if (!playable(result)) return { ok: false, reason: 'invalid-resolved-track' };
    if (!sourceAllowed(this.getSourcePolicy(), result.source)) return { ok: false, reason: 'source-mode-restricted' };
    if (candidate.sourceSongId && String(result.song_id ?? result.songId) !== String(candidate.sourceSongId)) {
      return { ok: false, reason: 'canonical-reference-mismatch' };
    }
    if (candidate.evidence?.source && candidate.evidence.source !== result.source) {
      return { ok: false, reason: 'canonical-provider-mismatch' };
    }
    if (trackOptions.mode === ProgramMode.EXPLICIT && !matchesExplicitRequest(candidate.query, result)) {
      return { ok: false, reason: 'explicit-match-failed' };
    }
    const track = toResolvedTrack(result, trackOptions.originalCandidate || candidate, {
      substitute: trackOptions.substitute || null,
      constraintEvidence: trackOptions.constraintEvidence || null,
    });
    let constraint;
    try {
      constraint = await raceWithin(Promise.resolve(this.validateResolvedTrack(track, {
        candidate, candidateProgram: trackOptions.candidateProgram,
      })), deadline - this.now(), trackOptions.signal);
    } catch (error) {
      trackOptions.signal?.throwIfAborted();
      if (error === BUDGET_EXHAUSTED) throw error;
      return { ok: false, reason: 'constraint-validation-failed' };
    }
    if (constraint === false || constraint?.ok === false) return { ok: false, reason: 'constraint-validation-failed' };
    return { ok: true, track: constraint?.evidence && Object.keys(constraint.evidence).length
      ? { ...track, evidence: { ...track.evidence, constraintValidation: constraint.evidence } } : track };
  }

  async _resolveCandidate(candidate, deadline, stats, trackOptions = {}) {
    const identity = { requestId: trackOptions.requestId, candidateId: candidate.candidateId,
      provider: candidate.evidence?.source || null, songId: candidate.sourceSongId || null };
    if (candidate.evidence?.source && !sourceAllowed(this.getSourcePolicy(), candidate.evidence.source)) {
      return { ok: false, reason: 'source-mode-restricted', attempts: 0 };
    }
    let cached = trackOptions.resolutionCache?.get(candidate);
    const pending = cached ? null : trackOptions.resolutionCache?.pending?.(candidate);
    if (pending) {
      // 后台预解析（选歌时已发起）：在本次预算内等它落定；失败或超时就照常解析。
      cached = await raceWithin(pending, deadline - this.now(), trackOptions.signal).catch(error => {
        trackOptions.signal?.throwIfAborted();
        if (error !== BUDGET_EXHAUSTED) throw error;
        return null;
      });
    }
    // 已确认拿不到音源（含刚等到的后台预解析）：直接按失败处理，不再请求供应商。
    if (!cached && trackOptions.resolutionCache?.knownUnplayable?.(candidate)) {
      this.trace({ event: 'program-resolution-known-unplayable', ...identity });
      return { ok: false, reason: 'canonical-resource-unavailable', attempts: 0, code: SOURCE_FAILURE.NOT_PLAYABLE };
    }
    let lastReason = 'resolution-failed';
    let lastCode = null;
    let lastDetail = null;
    for (let attempt = 1; attempt <= this.attemptsPerCandidate; attempt++) {
      trackOptions.signal?.throwIfAborted();
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        stats.budgetExhausted = true;
        return { ok: false, reason: 'resolution-budget-exhausted', attempts: attempt - 1 };
      }
      try {
        if (!cached) stats.attempts += 1;
        const result = cached || await raceWithin(
          Promise.resolve(this.resolveTrack(candidate.query, {
            requestId: trackOptions.requestId, candidate, attempt, signal: trackOptions.signal,
          })), remainingMs, trackOptions.signal,
        );
        trackOptions.signal?.throwIfAborted();
        if (result?.ok) {
          const validated = await this._validatedResult(result, candidate, deadline, trackOptions);
          trackOptions.signal?.throwIfAborted();
          if (validated.ok) {
            if (cached) this.trace({ event: 'program-resolution-reused', ...identity, reason: 'validated-cache-hit' });
            else trackOptions.resolutionCache?.set(candidate, result);
          }
          return { ...validated, attempts: cached ? 0 : attempt };
        }
        // Only stable resolver categories can mark a failure as permanent.
        lastReason = result?.error === 'canonical-resource-unavailable' ? result.error : 'resolution-failed';
        // 逐源明细只用来选一句用户能行动的话（哪个源、为什么），不进入公开的
        // failures 形状，也不带任何原始异常文本。
        lastDetail = Array.isArray(result?.failures) ? result.failures : null;
        if (isSourceFailureCode(result?.code)) lastCode = result.code;
        if (isConfirmedUnplayable(result)) trackOptions.resolutionCache?.markUnplayable?.(candidate);
        if (PERMANENT_RESOLUTION_REASONS.has(result?.error)) {
          return { ok: false, reason: result.error, attempts: attempt, code: lastCode, detail: lastDetail };
        }
      } catch (error) {
        trackOptions.signal?.throwIfAborted();
        lastReason = 'resolution-failed';
        if (PERMANENT_RESOLUTION_REASONS.has(error?.code)) {
          return { ok: false, reason: error.code, attempts: attempt };
        }
        if (error === BUDGET_EXHAUSTED) {
          stats.budgetExhausted = true;
          return { ok: false, reason: 'resolution-budget-exhausted', attempts: attempt };
        }
      }
      if (attempt < this.attemptsPerCandidate && deadline > this.now()) {
        this.trace({ event: 'program-resolution-retry', ...identity, reason: lastReason, attempt: attempt + 1 });
      }
    }
    return { ok: false, reason: lastReason, attempts: this.attemptsPerCandidate, code: lastCode, detail: lastDetail };
  }

  async _resolveSubstitute({ candidateProgram, candidate, deadline, stats, usedSongIds, originalFailure, signal }) {
    signal?.throwIfAborted();
    const remainingMs = deadline - this.now();
    if (remainingMs <= 0) {
      stats.budgetExhausted = true;
      return { ...originalFailure, reason: 'resolution-budget-exhausted' };
    }

    let substitutes;
    try {
      substitutes = await raceWithin(Promise.resolve(this.findSubstitutes({
        candidateProgram,
        candidate,
        constraints: candidateProgram.constraints,
        excludedSongIds: [...usedSongIds],
        remainingMs,
        signal,
      })), remainingMs, signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error === BUDGET_EXHAUSTED) {
        stats.budgetExhausted = true;
        return { ...originalFailure, reason: 'resolution-budget-exhausted' };
      }
      return { ...originalFailure, reason: 'substitute-search-failed', error: 'substitute-search-failed' };
    }

    const list = (Array.isArray(substitutes) ? substitutes : substitutes ? [substitutes] : [])
      .slice(0, this.maxSubstitutesPerCandidate);
    let hadConstraintMatch = false;
    for (const substitute of list) {
      signal?.throwIfAborted();
      if (!substitute?.query) continue;
      let verdict;
      try {
        verdict = normalizeConstraintVerdict(await this.validateSubstitute({
          substitute,
          originalCandidate: candidate,
          constraints: candidateProgram.constraints,
          candidateProgram,
        }));
      } catch {
        verdict = { ok: false, evidence: {} };
      }
      signal?.throwIfAborted();
      if (!verdict.ok) continue;
      hadConstraintMatch = true;

      const resolved = await this._resolveCandidate(substitute, deadline, stats, {
        requestId: candidateProgram.requestId,
        mode: candidateProgram.mode,
        candidateProgram,
        originalCandidate: candidate,
        substitute,
        constraintEvidence: verdict.evidence,
        signal,
      });
      if (!resolved.ok) {
        if (resolved.reason === 'resolution-budget-exhausted') return resolved;
        continue;
      }
      if (usedSongIds.has(resolved.track.songId)) continue;
      stats.substitutions += 1;
      return resolved;
    }

    return {
      ...originalFailure,
      reason: hadConstraintMatch ? 'substitute-resolution-failed' : 'no-constraint-compatible-substitute',
    };
  }
}
