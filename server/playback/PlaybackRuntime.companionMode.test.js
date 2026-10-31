import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPlaybackRuntimeState,
  hydratePlaybackRuntimeState,
  reducePlayback,
} from './PlaybackRuntime.js';
import {
  PlaybackCommandType,
  PlaybackEffectType,
  PlaybackEventType,
  PlaybackPhase,
} from './playbackRuntimeTypes.js';
import {
  AUTOMATIC_NARRATION_MIN_INTERVAL_MS,
  COMPANION_MODE_IDS,
  DEFAULT_COMPANION_MODE_ID,
  occurrencePositionAutoEligible,
  resolveCompanionModePolicy,
} from './companionModes.js';

function narrationContextTrack(songId, overrides = {}) {
  return {
    songId,
    programId: overrides.programId || 'program-a',
    requestId: overrides.requestId || 'request-a',
    title: overrides.title || `Title ${songId}`,
    artist: overrides.artist || `Artist ${songId}`,
    url: overrides.url || `/${songId}.mp3`,
    duration: overrides.duration || 200,
    intro: { text: `Narration ${songId}`, context: { transition: 'next' } },
  };
}

function commit(state, tracks, overrides = {}) {
  return reducePlayback(state, {
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: overrides.eventId || `commit-${state.version}`,
    delivery: overrides.delivery || 'replace_now',
    source: overrides.source || 'user',
    tracks,
  }, { nowMs: overrides.nowMs ?? 1_000 });
}

function startCurrent(result, prefix, nowMs) {
  const state = result.state ?? result;
  const started = reducePlayback(state, {
    type: PlaybackEventType.TRACK_STARTED,
    eventId: `${prefix}-started`, runtimeVersion: state.version,
    songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
    queueItemId: state.txn.queueItemId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, positionSeconds: 0,
  }, { nowMs });
  assert.equal(started.accepted, true, started.reason);
  assert.equal(started.state.phase, PlaybackPhase.PLAYING);
  return started.state;
}

function requestNext(state, prefix, nowMs) {
  const next = reducePlayback(state, {
    type: PlaybackEventType.NEXT_REQUESTED,
    eventId: `${prefix}-next`, runtimeVersion: state.version, songId: state.currentSongId,
  }, { nowMs });
  assert.equal(next.accepted, true, next.reason);
  return next;
}

function modeChange(state, { modeId, requestId, expectedRevision, nowMs = 5_000 }) {
  return reducePlayback(state, {
    type: PlaybackEventType.COMPANION_MODE_CHANGED,
    eventId: `companion-mode:${state.activeListeningSessionId}:${requestId}`,
    listeningSessionId: state.activeListeningSessionId,
    modeId: modeId === undefined ? null : modeId,
    requestId,
    ...(expectedRevision != null ? { expectedRevision } : {}),
  }, { nowMs });
}

function windowOpen(state, prefix, nowMs, positionSeconds = 1.5) {
  return reducePlayback(state, {
    type: PlaybackEventType.NARRATION_WINDOW_OPENED,
    eventId: `${prefix}-window`, runtimeVersion: state.version,
    queueItemId: state.txn.queueItemId, songId: state.txn.songId, programId: state.txn.programId,
    correlationId: state.txn.correlationId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
    positionSeconds, durationSeconds: 200,
  }, { nowMs });
}

/** 完成当前 occurrence 的串词准备（TRACK_NARRATION_READY 后台事实）。 */
function readyNarration(state, prefix, nowMs) {
  const track = state.queue[state.currentIndex];
  const ready = reducePlayback(state, {
    type: PlaybackEventType.TRACK_NARRATION_READY,
    eventId: `${prefix}-narration-ready`, queueItemId: track.queueItemId,
    songId: track.songId, programId: track.programId,
    generationRevision: track.narration.generationRevision,
    listeningSessionId: state.activeListeningSessionId,
    text: `这是 ${track.artist} 的《${track.title}》。值得一听。`, ttsUrl: `/${prefix}-tts.mp3`,
    previousSongId: state.lastOutputTrack?.songId || null,
  }, { nowMs });
  assert.equal(ready.accepted, true, ready.reason);
  return ready.state;
}

/** 当前 occurrence 的自动开口事实：交付开始 + audible。 */
function speakCurrent(state, prefix, startedAtMs) {
  const started = reducePlayback(state, {
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: `${prefix}-delivery-started`, runtimeVersion: state.version,
    queueItemId: state.txn.queueItemId, songId: state.txn.songId,
    programId: state.txn.programId, correlationId: state.txn.correlationId,
    listeningSessionId: state.activeListeningSessionId, outputGeneration: state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: startedAtMs });
  assert.equal(started.accepted, true, started.reason);
  const audible = reducePlayback(started.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    eventId: `${prefix}-delivery-audible`, runtimeVersion: started.state.version,
    queueItemId: started.state.txn.queueItemId, songId: started.state.txn.songId,
    programId: started.state.txn.programId, correlationId: started.state.txn.correlationId,
    listeningSessionId: started.state.activeListeningSessionId, outputGeneration: started.state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: startedAtMs + 100 });
  assert.equal(audible.state.txn.narrationDelivery, 'speaking');
  return audible.state;
}

// ---- 策略定义 ----

test('companion mode policies expose three bounded presets and cadence math', () => {
  assert.deepEqual([...COMPANION_MODE_IDS], ['music_only', 'occasional', 'conversational']);
  const musicOnly = resolveCompanionModePolicy('music_only');
  const occasional = resolveCompanionModePolicy('occasional');
  const conversational = resolveCompanionModePolicy('conversational');
  assert.equal(musicOnly.automaticNarration, false);
  assert.equal(occasional.automaticNarration, true);
  assert.equal(conversational.automaticNarration, true);
  // 偶尔介绍：第 1、4、7… 个 occurrence 才有资格。
  for (const position of [1, 4, 7, 10]) {
    assert.equal(occurrencePositionAutoEligible(occasional, position), true, `position ${position}`);
  }
  for (const position of [2, 3, 5, 6, 8]) {
    assert.equal(occurrencePositionAutoEligible(occasional, position), false, `position ${position}`);
  }
  assert.equal(occurrencePositionAutoEligible(conversational, 3), true);
  assert.equal(occurrencePositionAutoEligible(musicOnly, 1), false);
  assert.equal(resolveCompanionModePolicy('party'), null);
  assert.ok(AUTOMATIC_NARRATION_MIN_INTERVAL_MS >= 120_000);
});

// ---- 默认 ----

test('fresh, missing, null and schema v2 snapshots all normalize to the conversational default', () => {
  const fresh = createPlaybackRuntimeState();
  assert.equal(fresh.companionModeId, DEFAULT_COMPANION_MODE_ID);
  assert.equal(fresh.companionModeId, 'conversational');
  assert.equal(fresh.modeSource, 'default');

  const missing = hydratePlaybackRuntimeState({ ...createPlaybackRuntimeState(), companionModeId: undefined });
  assert.equal(missing.companionModeId, 'conversational', 'a missing field is no longer a fourth policy');
  assert.equal(missing.modeSource, 'default');

  const nulled = hydratePlaybackRuntimeState({ ...createPlaybackRuntimeState(), companionModeId: null, modeSource: 'legacy' });
  assert.equal(nulled.companionModeId, 'conversational', 'an explicit null snapshot normalizes to the default');
  assert.equal(nulled.modeSource, 'default');

  const schemaV2 = hydratePlaybackRuntimeState({ schemaVersion: 2, version: 3, queue: [] });
  assert.equal(schemaV2.companionModeId, 'conversational', 'schema v2 snapshots are normalized too');
  assert.equal(schemaV2.modeSource, 'default');

  const persisted = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(fresh)));
  assert.equal(persisted.companionModeId, 'conversational');
  assert.equal(persisted.modeSource, 'default');
});

test('recovered unset sessions use the default cadence and keep the 120s interval', () => {
  const tracks = [narrationContextTrack('one'), narrationContextTrack('two')];
  const recovered = hydratePlaybackRuntimeState({ ...createPlaybackRuntimeState(), companionModeId: null });
  assert.equal(recovered.companionModeId, 'conversational');
  const committed = commit(recovered, tracks);
  // 多聊一点每个 occurrence 都有资格：当前准备 + 紧邻下一首预测准备。
  assert.equal(committed.effects.filter(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION).length, 2);
  let state = startCurrent(committed, 'default-1', 2_000);
  state = readyNarration(state, 'default-1', 2_500);
  state = speakCurrent(windowOpen(state, 'default-1', 3_500).state, 'default-1', 3_600);
  assert.equal(state.lastAutomaticNarrationAtMs, 3_700);
  // 恢复的旧会话不再绕过冷却：间隔内的下一首自动串词被跳过而非补讲。
  const next = requestNext(state, 'default-2', 4_000);
  const playing = startCurrent(next, 'default-2', 4_500);
  assert.equal(playing.txn.narrationAutoEligible, true);
  const blocked = windowOpen(playing, 'default-2', 6_000);
  assert.equal(blocked.state.txn.narrationDelivery, 'skipped');
  assert.ok(blocked.state.diagnostics.some(entry => entry.type === 'track-narration-skipped'
    && entry.reason === 'auto-interval-missed'));
});

test('valid saved modes and their counting survive hydration unchanged', () => {
  const tracks = [narrationContextTrack('one')];
  for (const modeId of ['music_only', 'occasional']) {
    let state = createPlaybackRuntimeState();
    state = modeChange(state, { modeId, requestId: `preserve-${modeId}` }).state;
    state = startCurrent(commit(state, tracks), `preserve-${modeId}`, 2_000);
    state = { ...state, lastAutomaticNarrationAtMs: 1_500 };
    const hydrated = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(state)));
    assert.equal(hydrated.companionModeId, modeId, `${modeId} stays selected`);
    assert.equal(hydrated.modeSource, 'explicit');
    assert.equal(hydrated.modeRevision, state.modeRevision);
    assert.equal(hydrated.modeEpoch, state.modeEpoch);
    assert.equal(hydrated.modeActivationCount, state.modeActivationCount);
    assert.equal(hydrated.modeCountedOccurrences.length, state.modeCountedOccurrences.length);
    assert.equal(hydrated.lastAutomaticNarrationAtMs, 1_500);
  }
});

test('suspended sessions without a saved mode also normalize to the default', () => {
  let state = createPlaybackRuntimeState();
  state = reducePlayback(state, {
    type: PlaybackEventType.LISTENING_SESSION_CREATED,
    eventId: 'suspended-default-create', listeningSessionId: 'conversation:other',
  }).state;
  const snapshot = JSON.parse(JSON.stringify(state));
  delete snapshot.suspendedSessions['conversation:other'].companionModeId;
  delete snapshot.suspendedSessions['conversation:other'].modeSource;
  const hydrated = hydratePlaybackRuntimeState(snapshot);
  const suspended = hydrated.suspendedSessions['conversation:other'];
  assert.equal(suspended.companionModeId, 'conversational');
  assert.equal(suspended.modeSource, 'default');
  assert.equal(hydrated.companionModeId, 'conversational');
});

test('hydration backfills a missing txn mode revision without touching media identity', () => {
  const tracks = [narrationContextTrack('one')];
  const state = startCurrent(commit(createPlaybackRuntimeState(), tracks), 'txn-migrate', 2_000);
  const snapshot = JSON.parse(JSON.stringify(state));
  delete snapshot.txn.modeRevision;
  // 挂起会话同样回填：用同一份会话事实构造一个旧挂起快照。
  const suspendedCopy = JSON.parse(JSON.stringify(state));
  delete suspendedCopy.txn.modeRevision;
  snapshot.suspendedSessions['conversation:legacy'] = suspendedCopy;
  const hydrated = hydratePlaybackRuntimeState(snapshot);
  for (const session of [hydrated, hydrated.suspendedSessions['conversation:legacy']]) {
    assert.equal(session.txn.modeRevision, session.modeRevision);
    assert.equal(session.companionModeId, 'conversational');
    assert.equal(session.modeSource, 'default');
    assert.equal(session.modeActivationCount, state.modeActivationCount);
    assert.equal(session.lastAutomaticNarrationAtMs, state.lastAutomaticNarrationAtMs);
    assert.equal(session.txn.correlationId, state.txn.correlationId);
    assert.equal(session.txn.queueItemId, state.txn.queueItemId);
    assert.equal(session.txn.songId, state.txn.songId);
  }
  // 不补讲、不重写：串词交付与准备状态原样保留。
  assert.equal(hydrated.txn.narrationDelivery, state.txn.narrationDelivery);
  assert.equal(hydrated.queue[0].narration.status, state.queue[0].narration.status);
  assert.equal(hydrated.queue[0].narration.generationRevision, state.queue[0].narration.generationRevision);
});

// ---- 三预设的自动资格 ----

test('explicitly saved occasional prepares only the 1st, 4th, 7th accepted occurrences', () => {
  const tracks = [1, 2, 3, 4].map(index => narrationContextTrack(`song-${index}`));
  // 真正的 occasional 断言必须显式选择该模式，不靠旧默认值。
  const committed = commit(createPlaybackRuntimeState({ companionModeId: 'occasional' }), tracks);
  // 第 1 个：有资格 → 当前准备 + 紧邻下一首（第 2 个）预测不合格 → 不准备。
  assert.equal(committed.effects.filter(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION).length, 1);
  assert.equal(committed.effects[0].queueItemId, committed.state.queue[0].queueItemId);

  let state = startCurrent(committed, 'occ-1', 2_000);
  assert.equal(state.modeActivationCount, 1);
  // 第 2、3 个 occurrence：激活时不为自己准备、不解析资产（为第 4 个的预备除外）。
  for (const [index, nowMs] of [[2, 120_000], [3, 240_000]]) {
    const next = requestNext(state, `occ-${index}`, nowMs);
    const activatedId = next.state.txn.queueItemId;
    const ownEffects = next.effects.filter(effect =>
      effect.queueItemId === activatedId
      && (effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
        || effect.type === PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET));
    assert.deepEqual(ownEffects, [], `occurrence ${index} starts no narration work of its own`);
    state = startCurrent(next, `occ-${index}`, nowMs + 1_000);
  }
  assert.equal(state.modeActivationCount, 3);
  // 第 4 个：恢复资格。
  const fourth = requestNext(state, 'occ-4', 360_000);
  assert.equal(fourth.state.modeActivationCount, 3, 'counting waits for accepted media');
  state = startCurrent(fourth, 'occ-4', 361_000);
  assert.equal(state.modeActivationCount, 4);
});

test('music_only starts no automatic narration preparation or asset resolution', () => {
  const tracks = [narrationContextTrack('one'), narrationContextTrack('two')];
  let state = createPlaybackRuntimeState();
  state = modeChange(state, { modeId: 'music_only', requestId: 'mode-1' }).state;
  const committed = commit(state, tracks);
  assert.deepEqual(committed.effects.filter(effect =>
    effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
    || effect.type === PlaybackEffectType.RESOLVE_TRACK_NARRATION_ASSET), []);
  const playing = startCurrent(committed, 'music-only', 2_000);
  const opened = windowOpen(playing, 'music-only', 3_500);
  assert.equal(opened.state.txn.narrationDelivery, 'skipped');
  assert.deepEqual(opened.commands.map(command => command.type), []);
  assert.ok(opened.state.diagnostics.some(entry => entry.type === 'track-narration-skipped'
    && entry.reason === 'mode-ineligible'));
});

test('conversational grants every new occurrence and music keeps starting', () => {
  const tracks = [1, 2, 3].map(index => narrationContextTrack(`song-${index}`));
  let state = createPlaybackRuntimeState();
  state = modeChange(state, { modeId: 'conversational', requestId: 'mode-1' }).state;
  let result = commit(state, tracks);
  assert.ok(result.effects.some(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
    && effect.queueItemId === result.state.queue[0].queueItemId));
  assert.ok(result.effects.some(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
    && effect.queueItemId === result.state.queue[1].queueItemId), 'the next occurrence is prepared ahead');
  state = startCurrent(result, 'conv-1', 2_000);
  const second = requestNext(state, 'conv-2', 3_000);
  assert.ok(second.effects.some(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
    && effect.queueItemId === second.state.queue[2].queueItemId));
});

// ---- 计数与重连 ----

test('counting survives reconnect and re-attach without double counts', () => {
  const tracks = [narrationContextTrack('one'), narrationContextTrack('two')];
  let state = startCurrent(commit(createPlaybackRuntimeState(), tracks), 'reconnect-1', 2_000);
  assert.equal(state.modeActivationCount, 1);
  // 重连：客户端重新确认同一 occurrence（TRACK_REATTACHED），不重复计数。
  const reattached = reducePlayback(state, {
    type: PlaybackEventType.TRACK_REATTACHED,
    eventId: 'reconnect-reattach', runtimeVersion: state.version,
    songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
    queueItemId: state.txn.queueItemId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, positionSeconds: 10,
  }, { nowMs: 12_000 });
  assert.equal(reattached.accepted, true, reattached.reason);
  assert.equal(reattached.state.modeActivationCount, 1);

  // 暂停/恢复不计数。
  const paused = reducePlayback(reattached.state, {
    type: PlaybackEventType.PAUSE_REQUESTED,
    eventId: 'reconnect-pause', runtimeVersion: reattached.state.version,
    songId: reattached.state.currentSongId, positionSeconds: 12,
  }, { nowMs: 15_000 });
  const resumed = reducePlayback(paused.state, {
    type: PlaybackEventType.RESUME_REQUESTED,
    eventId: 'reconnect-resume', runtimeVersion: paused.state.version,
    songId: paused.state.currentSongId,
  }, { nowMs: 20_000 });
  assert.equal(resumed.state.modeActivationCount, 1);
});

test('seek and duplicate media facts do not increase the count', () => {
  const tracks = [narrationContextTrack('one')];
  let state = startCurrent(commit(createPlaybackRuntimeState(), tracks), 'seek-1', 2_000);
  const reported = reducePlayback(state, {
    type: PlaybackEventType.POSITION_REPORTED,
    eventId: 'seek-report', runtimeVersion: state.version,
    songId: state.currentSongId, programId: state.txn.programId, correlationId: state.txn.correlationId,
    queueItemId: state.txn.queueItemId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, positionSeconds: 90,
  }, { nowMs: 90_000 });
  assert.equal(reported.state.modeActivationCount, 1);
});

// ---- 模式修改的 revision / 幂等 / 竞态 ----

test('duplicate mode requests and same-mode re-saves keep revision and counting', () => {
  const tracks = [narrationContextTrack('one')];
  let state = startCurrent(commit(createPlaybackRuntimeState(), tracks), 'dup-1', 2_000);
  const pickDefault = modeChange(state, { modeId: 'conversational', requestId: 'dup-req-0' });
  assert.equal(pickDefault.accepted, true, pickDefault.reason);
  assert.equal(pickDefault.state.modeRevision, 0, 'picking the current default only records the source');
  assert.equal(pickDefault.state.modeSource, 'explicit');

  const first = modeChange(state, { modeId: 'occasional', requestId: 'dup-req-1' });
  assert.equal(first.accepted, true, first.reason);
  assert.equal(first.state.modeRevision, 1);
  assert.equal(first.state.modeEpoch, 1);

  const duplicate = modeChange(first.state, { modeId: 'occasional', requestId: 'dup-req-1' });
  assert.equal(duplicate.accepted, false, 'duplicate requestId is deduped by event id');
  assert.equal(duplicate.reason, 'duplicate event');

  const resave = modeChange(first.state, { modeId: 'occasional', requestId: 'dup-req-2' });
  assert.equal(resave.accepted, true, resave.reason);
  assert.equal(resave.state.modeRevision, 1, 'same effective mode does not bump revision');
  assert.equal(resave.state.modeEpoch, 1, 'same effective mode does not rebuild the epoch');
  assert.equal(resave.state.modeActivationCount, first.state.modeActivationCount);
});

test('stale mode revisions are rejected with recoverable state', () => {
  const state = createPlaybackRuntimeState();
  const stale = modeChange(state, { modeId: 'music_only', requestId: 'stale-1', expectedRevision: 7 });
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'stale mode revision');
  assert.equal(stale.state.companionModeId, 'conversational');
  const fresh = modeChange(state, { modeId: 'music_only', requestId: 'stale-2', expectedRevision: 0 });
  assert.equal(fresh.accepted, true, fresh.reason);
  assert.equal(fresh.state.companionModeId, 'music_only');
});

test('clearing an explicit override returns to the conversational default without touching counting', () => {
  const tracks = [narrationContextTrack('one')];
  let state = startCurrent(commit(createPlaybackRuntimeState(), tracks), 'clear-1', 2_000);
  state = { ...state, lastAutomaticNarrationAtMs: 1_800 };
  state = modeChange(state, { modeId: 'music_only', requestId: 'clear-mode-1' }).state;
  assert.equal(state.modeSource, 'explicit');
  const cleared = modeChange(state, { modeId: null, requestId: 'clear-mode-2' });
  assert.equal(cleared.accepted, true, cleared.reason);
  assert.equal(cleared.state.companionModeId, 'conversational');
  assert.equal(cleared.state.modeSource, 'default');
  // 清除后没有第二次 epoch 重建：计数保持在切换时重建后的状态。
  assert.equal(cleared.state.modeRevision, 2);
  // 清除覆盖不洗掉自动开口时间：120 秒间隔继续有效。
  assert.equal(cleared.state.lastAutomaticNarrationAtMs, 1_800);

  // 默认会话没有覆盖可清：幂等返回，绝不回落到 null/legacy 策略。
  const defaultState = createPlaybackRuntimeState();
  const noop = modeChange(defaultState, { modeId: null, requestId: 'clear-noop' });
  assert.equal(noop.accepted, true, noop.reason);
  assert.equal(noop.state.modeRevision, 0);
  assert.equal(noop.state.companionModeId, 'conversational');
  assert.equal(noop.state.modeSource, 'default');
});

test('mode changes for another listening session apply to that session only', () => {
  let state = createPlaybackRuntimeState();
  state = reducePlayback(state, {
    type: PlaybackEventType.LISTENING_SESSION_CREATED,
    eventId: 'bg-create', listeningSessionId: 'conversation:background',
  }).state;
  const changed = reducePlayback(state, {
    type: PlaybackEventType.COMPANION_MODE_CHANGED,
    eventId: 'companion-mode:conversation:background:bg-1',
    listeningSessionId: 'conversation:background',
    modeId: 'music_only', requestId: 'bg-1',
  });
  assert.equal(changed.accepted, true, changed.reason);
  assert.equal(changed.state.companionModeId, 'conversational', 'active session untouched');
  const background = changed.state.suspendedSessions['conversation:background'];
  assert.equal(background.companionModeId, 'music_only');
  assert.equal(background.modeSource, 'explicit');
});

// ---- 最小自动间隔 ----

test('rapid skipping within the automatic interval skips without catch-up narration', () => {
  const tracks = [1, 2, 3, 4].map(index => narrationContextTrack(`interval-${index}`));
  let state = startCurrent(commit(createPlaybackRuntimeState({ companionModeId: 'conversational' }), tracks),
    'interval-1', 2_000);
  state = readyNarration(state, 'interval-1', 2_500);
  // 第 1 首自动开口（audible 事实）。
  const queued = windowOpen(state, 'interval-1', 3_500);
  assert.deepEqual(queued.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK_NARRATION]);
  const audible = reducePlayback(queued.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'interval-1-delivery-started', runtimeVersion: queued.state.version,
    queueItemId: queued.state.txn.queueItemId, songId: queued.state.txn.songId,
    programId: queued.state.txn.programId, correlationId: queued.state.txn.correlationId,
    listeningSessionId: queued.state.activeListeningSessionId, outputGeneration: queued.state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: 3_600 });
  const audibleFact = reducePlayback(audible.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    eventId: 'interval-1-delivery-audible', runtimeVersion: audible.state.version,
    queueItemId: audible.state.txn.queueItemId, songId: audible.state.txn.songId,
    programId: audible.state.txn.programId, correlationId: audible.state.txn.correlationId,
    listeningSessionId: audible.state.activeListeningSessionId, outputGeneration: audible.state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: 3_700 });
  assert.equal(audibleFact.state.txn.narrationDelivery, 'speaking');
  assert.equal(audibleFact.state.lastAutomaticNarrationAtMs, 3_700);

  // 快进到下一首：在 120 秒间隔内，虽有节奏资格，也不能自动开口，且不积债。
  const next = requestNext(audibleFact.state, 'interval-2', 4_000);
  const secondPlaying = startCurrent(next, 'interval-2', 4_500);
  assert.equal(secondPlaying.txn.narrationAutoEligible, true);
  const blocked = windowOpen(secondPlaying, 'interval-2', 6_000);
  assert.equal(blocked.state.txn.narrationDelivery, 'skipped', 'automatic speech is skipped inside the interval');
  assert.ok(blocked.state.diagnostics.some(entry => entry.type === 'track-narration-skipped'
    && entry.reason === 'auto-interval-missed'));
  assert.deepEqual(blocked.commands.map(command => command.type), []);
});

test('a waitable interval re-arms the window instead of skipping', () => {
  const tracks = [narrationContextTrack('wait-1'), narrationContextTrack('wait-2')];
  let state = startCurrent(commit(createPlaybackRuntimeState({
    companionModeId: 'conversational',
    narrationPolicy: { settlingDelayMs: 1_000, maxStartOffsetMs: 200_000, minRemainingMs: 1_000 },
  }), tracks), 'wait-1', 2_000);
  state = readyNarration(state, 'wait-1', 2_400);
  const queued = windowOpen(state, 'wait-1', 3_500);
  const deliveryStarted = reducePlayback(queued.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'wait-1-delivery-started', runtimeVersion: queued.state.version,
    queueItemId: queued.state.txn.queueItemId, songId: queued.state.txn.songId,
    programId: queued.state.txn.programId, correlationId: queued.state.txn.correlationId,
    listeningSessionId: queued.state.activeListeningSessionId, outputGeneration: queued.state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: 3_600 });
  const audible = reducePlayback(deliveryStarted.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    eventId: 'wait-1-delivery-audible', runtimeVersion: deliveryStarted.state.version,
    queueItemId: deliveryStarted.state.txn.queueItemId, songId: deliveryStarted.state.txn.songId,
    programId: deliveryStarted.state.txn.programId, correlationId: deliveryStarted.state.txn.correlationId,
    listeningSessionId: deliveryStarted.state.activeListeningSessionId, outputGeneration: deliveryStarted.state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: 3_700 });
  const next = requestNext(audible.state, 'wait-2', 4_000);
  const playing = startCurrent(next, 'wait-2', 4_500);
  // 距上次开口 4 秒，间隔 120 秒，但启动窗口 60 秒内还来得及 → 等待而不是跳过。
  const waiting = windowOpen(playing, 'wait-2', 5_500);
  assert.equal(waiting.state.txn.narrationDelivery, 'waiting');
  assert.deepEqual(waiting.effects.map(effect => effect.type), [PlaybackEffectType.SCHEDULE_NARRATION_WINDOW]);
  assert.ok(waiting.effects[0].delayMs > 100_000);
});

// ---- 显式请求绕过频率 ----

test('an explicit current-track narration request bypasses the cadence in music_only', () => {
  const tracks = [narrationContextTrack('one')];
  let state = createPlaybackRuntimeState();
  state = modeChange(state, { modeId: 'music_only', requestId: 'explicit-mode-1' }).state;
  state = startCurrent(commit(state, tracks), 'explicit-1', 2_000);
  state = windowOpen(state, 'explicit-1', 3_500).state;
  assert.equal(state.txn.narrationDelivery, 'skipped');
  const requested = reducePlayback(state, {
    type: PlaybackEventType.NARRATION_REQUESTED,
    eventId: 'explicit-request', runtimeVersion: state.version,
    queueItemId: state.txn.queueItemId, songId: state.txn.songId, programId: state.txn.programId,
    correlationId: state.txn.correlationId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  }, { nowMs: 30_000 });
  assert.equal(requested.accepted, true, requested.reason);
  assert.equal(requested.state.txn.narrationUserRequested, true);
  assert.ok(requested.effects.some(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION));
  // 准备完成后，显式串词按放宽窗口排队；其 audible 事实不占用自动间隔。
  const ready = reducePlayback(requested.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY,
    eventId: 'explicit-ready', queueItemId: state.txn.queueItemId, songId: state.txn.songId,
    programId: state.txn.programId, generationRevision: requested.state.queue[0].narration.generationRevision,
    listeningSessionId: state.activeListeningSessionId,
    text: '这首是 Artist one 的《Title one》，值得一听。', ttsUrl: '/explicit-one.mp3',
  }, { nowMs: 31_000 });
  assert.equal(ready.state.txn.narrationDelivery, 'queued', 'background completion re-opens the requested delivery');
  assert.deepEqual(ready.commands.map(command => command.type), [PlaybackCommandType.PLAY_TRACK_NARRATION]);
  const queuedCommand = reducePlayback(ready.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'explicit-delivery-started', runtimeVersion: ready.state.version,
    queueItemId: state.txn.queueItemId, songId: state.txn.songId, programId: state.txn.programId,
    correlationId: state.txn.correlationId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, positionSeconds: 30, durationSeconds: 200,
  }, { nowMs: 32_000 });
  const audible = reducePlayback(queuedCommand.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    eventId: 'explicit-delivery-audible', runtimeVersion: queuedCommand.state.version,
    queueItemId: state.txn.queueItemId, songId: state.txn.songId, programId: state.txn.programId,
    correlationId: state.txn.correlationId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, positionSeconds: 30, durationSeconds: 200,
  }, { nowMs: 32_500 });
  assert.equal(audible.state.txn.narrationDelivery, 'speaking');
  assert.equal(audible.state.lastAutomaticNarrationAtMs, null, 'requested speech does not consume the automatic interval');
});

// ---- 模式切换的失效与取消 ----

test('switching to music_only during preparation discards the late result', () => {
  const tracks = [narrationContextTrack('one')];
  const committed = commit(createPlaybackRuntimeState({ companionModeId: 'conversational' }), tracks);
  const preparing = committed.state.queue[0].narration;
  assert.equal(preparing.status, 'preparing');
  const switched = modeChange(committed.state, { modeId: 'music_only', requestId: 'late-mode-1' });
  assert.equal(switched.accepted, true, switched.reason);
  assert.equal(switched.state.queue[0].narration.status, 'absent', 'unstarted preparation is invalidated');
  const late = reducePlayback(switched.state, {
    type: PlaybackEventType.TRACK_NARRATION_READY,
    eventId: 'late-ready', queueItemId: committed.state.queue[0].queueItemId,
    songId: 'one', programId: 'program-a',
    generationRevision: preparing.generationRevision,
    listeningSessionId: switched.state.activeListeningSessionId,
    text: '迟到的串词结果。', ttsUrl: '/late.mp3',
  }, { nowMs: 6_000 });
  assert.equal(late.accepted, false);
  assert.equal(late.reason, 'narration generation no longer active');
});

test('switching to music_only while speaking issues a bounded cancel and keeps the song', () => {
  const tracks = [narrationContextTrack('one')];
  let state = startCurrent(commit(createPlaybackRuntimeState({ companionModeId: 'conversational' }), tracks),
    'cancel-1', 2_000);
  state = readyNarration(state, 'cancel-1', 2_500);
  const queued = windowOpen(state, 'cancel-1', 3_500);
  const started = reducePlayback(queued.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'cancel-delivery-started', runtimeVersion: queued.state.version,
    queueItemId: queued.state.txn.queueItemId, songId: queued.state.txn.songId,
    programId: queued.state.txn.programId, correlationId: queued.state.txn.correlationId,
    listeningSessionId: queued.state.activeListeningSessionId, outputGeneration: queued.state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: 3_600 });
  const audible = reducePlayback(started.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    eventId: 'cancel-delivery-audible', runtimeVersion: started.state.version,
    queueItemId: started.state.txn.queueItemId, songId: started.state.txn.songId,
    programId: started.state.txn.programId, correlationId: started.state.txn.correlationId,
    listeningSessionId: started.state.activeListeningSessionId, outputGeneration: started.state.outputGeneration,
    positionSeconds: 1.5, durationSeconds: 200,
  }, { nowMs: 3_700 });
  assert.equal(audible.state.txn.narrationDelivery, 'speaking');

  const switched = modeChange(audible.state, { modeId: 'music_only', requestId: 'cancel-mode-1' });
  assert.equal(switched.accepted, true, switched.reason);
  assert.deepEqual(switched.commands.map(command => command.type), [PlaybackCommandType.CANCEL_TRACK_NARRATION]);
  assert.equal(switched.commands[0].queueItemId, audible.state.txn.queueItemId);
  assert.equal(switched.state.txn.narrationDelivery, 'skipped');
  assert.equal(switched.state.phase, PlaybackPhase.PLAYING, 'the song keeps playing');
  assert.equal(switched.state.currentSongId, 'one');

  // 迟到的 FINISHED 不能再操作新状态之外的东西。
  const lateFinish = reducePlayback(switched.state, {
    type: PlaybackEventType.NARRATION_DELIVERY_FINISHED,
    eventId: 'cancel-late-finish', runtimeVersion: switched.state.version,
    queueItemId: switched.state.txn.queueItemId, songId: switched.state.txn.songId,
    programId: switched.state.txn.programId, correlationId: switched.state.txn.correlationId,
    listeningSessionId: switched.state.activeListeningSessionId, outputGeneration: switched.state.outputGeneration,
  }, { nowMs: 8_000 });
  assert.equal(lateFinish.state.txn.narrationDelivery, 'skipped', 'late completion only ends its own audio task');
});

test('life revocation cancels an audible introduction and ignores late completion', () => {
  let state = startCurrent(commit(createPlaybackRuntimeState({ companionModeId: 'conversational' }),
    [narrationContextTrack('private')]), 'life-private', 2_000);
  state = readyNarration(state, 'life-private', 2_500);
  const queued = windowOpen(state, 'life-private', 3_500);
  const identity = current => ({ runtimeVersion: current.version,
    queueItemId: current.txn.queueItemId, songId: current.txn.songId,
    programId: current.txn.programId, correlationId: current.txn.correlationId,
    listeningSessionId: current.activeListeningSessionId, outputGeneration: current.outputGeneration });
  const started = reducePlayback(queued.state, { type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'life-delivery-started', ...identity(queued.state), positionSeconds: 1.5, durationSeconds: 200 }, { nowMs: 3_600 });
  const audible = reducePlayback(started.state, { type: PlaybackEventType.NARRATION_DELIVERY_AUDIBLE,
    eventId: 'life-delivery-audible', ...identity(started.state), positionSeconds: 1.5, durationSeconds: 200 }, { nowMs: 3_700 });
  assert.equal(audible.state.txn.narrationDelivery, 'speaking');
  const revoked = reducePlayback(audible.state, { type: PlaybackEventType.NARRATION_CONTEXT_STALE_REQUESTED,
    eventId: 'life-revoked-speaking', listeningSessionId: audible.state.activeListeningSessionId,
    includeCurrent: true });
  assert.deepEqual(revoked.commands.map(command => command.type), [PlaybackCommandType.CANCEL_TRACK_NARRATION]);
  assert.equal(revoked.state.txn.narrationDelivery, 'skipped');
  assert.equal(revoked.state.phase, PlaybackPhase.PLAYING);
  const late = reducePlayback(revoked.state, { type: PlaybackEventType.NARRATION_DELIVERY_FINISHED,
    eventId: 'life-late-finished', ...identity(revoked.state) });
  assert.equal(late.state.txn.narrationDelivery, 'skipped');
});

test('switching modes keeps user-requested narration and an audible one finishes naturally', () => {
  const tracks = [narrationContextTrack('one')];
  let state = startCurrent(commit(createPlaybackRuntimeState({ companionModeId: 'conversational' }), tracks),
    'natural-1', 2_000);
  const requested = reducePlayback(state, {
    type: PlaybackEventType.NARRATION_REQUESTED,
    eventId: 'natural-request', runtimeVersion: state.version,
    queueItemId: state.txn.queueItemId, songId: state.txn.songId, programId: state.txn.programId,
    correlationId: state.txn.correlationId, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration,
  }, { nowMs: 3_000 });
  const switched = modeChange(requested.state, { modeId: 'occasional', requestId: 'natural-mode-1' });
  assert.equal(switched.accepted, true, switched.reason);
  assert.deepEqual(switched.commands.map(command => command.type), [],
    'a requested introduction is not cancelled by a mode change');
  assert.equal(switched.state.txn.narrationUserRequested, true);
});

test('mode changes carry modeRevision on narration effects and re-prepare under the new policy', () => {
  const tracks = [narrationContextTrack('one'), narrationContextTrack('two')];
  const committed = commit(createPlaybackRuntimeState({ companionModeId: 'conversational' }), tracks);
  assert.equal(committed.effects[0].modeRevision, 0);
  const switched = modeChange(committed.state, { modeId: 'conversational', requestId: 'rev-mode-1' });
  // 选中当前已生效的模式只记录来源：策略没变，不跨 revision、不重新准备串词。
  assert.equal(switched.state.modeRevision, 0);
  assert.equal(switched.state.modeSource, 'explicit');
  assert.equal(switched.effects.some(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION), false);
  const toOccasional = modeChange(committed.state, { modeId: 'occasional', requestId: 'rev-mode-2' });
  assert.equal(toOccasional.state.modeRevision, 1);
  // epoch 重建后，upcoming occurrence 重新按新策略预测（occasional 第 1 个 → 有资格）。
  assert.ok(toOccasional.effects.some(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION
    && effect.modeRevision === 1), 're-preparation carries the new mode revision');
});

test('mode state survives restart via hydration', () => {
  const tracks = [narrationContextTrack('one'), narrationContextTrack('two')];
  let state = startCurrent(commit(createPlaybackRuntimeState(), tracks), 'restart-1', 2_000);
  state = modeChange(state, { modeId: 'occasional', requestId: 'restart-mode-1' }).state;
  state = startCurrent(requestNext(state, 'restart-2', 3_000), 'restart-2', 4_000);
  assert.equal(state.modeActivationCount, 1, 'counting restarted with the epoch');

  const hydrated = hydratePlaybackRuntimeState(JSON.parse(JSON.stringify(state)));
  assert.equal(hydrated.companionModeId, 'occasional');
  assert.equal(hydrated.modeRevision, 1);
  assert.equal(hydrated.modeActivationCount, 1);
  // epoch 重建时播种了“当前 occurrence 不补讲”的记录，随后第二个 occurrence 被计数。
  assert.equal(hydrated.modeCountedOccurrences.length, 2);
});

for (const assetOnly of [false, true]) {
test(`background ${assetOnly ? 'asset' : 'draft'} ready must schedule the remaining automatic interval before speaking`, () => {
  let state = startCurrent(commit(createPlaybackRuntimeState({ companionModeId: 'conversational' }),
    [narrationContextTrack('gap')], { nowMs: 999_000 }), 'gap', 1_000_000);
  state = { ...state, lastAutomaticNarrationAtMs: 885_000 };
  if (assetOnly) {
    state = structuredClone(state);
    state.queue[0].narration.status = 'ready';
    state.queue[0].narration.assetStatus = 'resolving';
    state.queue[0].narration.text = '这是这首歌曲的一段介绍。';
  }
  const track = state.queue[0];
  const ready = reducePlayback(state, { type: assetOnly ? PlaybackEventType.TRACK_NARRATION_ASSET_READY : PlaybackEventType.TRACK_NARRATION_READY,
    eventId: 'gap-ready', queueItemId: track.queueItemId, songId: track.songId, programId: track.programId,
    generationRevision: track.narration.generationRevision, listeningSessionId: state.activeListeningSessionId,
    text: '这是这首歌曲的一段介绍。', ttsUrl: '/gap.mp3' }, { nowMs: 1_002_000 });
  assert.equal(ready.accepted, true);
  assert.equal(ready.commands.some(c => c.type === PlaybackCommandType.PLAY_TRACK_NARRATION), false);
  assert.ok(ready.effects.some(e => e.type === PlaybackEffectType.SCHEDULE_NARRATION_WINDOW && e.delayMs === 3000));
  const opened = windowOpen(ready.state, 'gap-allowed', 1_005_000, 5);
  assert.ok(opened.commands.some(c => c.type === PlaybackCommandType.PLAY_TRACK_NARRATION));
});

}

test('a mode change for a suspended session does not strand its next narration in preparing', () => {
  const song = id => ({ ...narrationContextTrack(id), programId: `program-${id}`, requestId: `request-${id}` });
  const send = (state, type, values = {}, nowMs = 10_000) => reducePlayback(state,
    { type, eventId: `suspended-mode-${type}-${state.version}`, ...values }, { nowMs });
  const identity = state => ({ runtimeVersion: state.version, listeningSessionId: state.activeListeningSessionId,
    outputGeneration: state.outputGeneration, songId: state.currentSongId, programId: state.txn?.programId,
    correlationId: state.txn?.correlationId, queueItemId: state.txn?.queueItemId, positionSeconds: 0 });
  const play = (state, id, ids) => {
    const committed = send(state, PlaybackEventType.PROGRAM_COMMITTED,
      { listeningSessionId: id, delivery: 'replace_now', tracks: ids.map(song) });
    assert.equal(committed.accepted, true, committed.reason);
    return send(committed.state, PlaybackEventType.TRACK_STARTED, identity(committed.state)).state;
  };
  let state = play(createPlaybackRuntimeState({ companionModeId: 'conversational' }), 'conversation:a', ['a-1', 'a-2']);
  state = play(state, 'conversation:b', ['b-1']);
  // 先切到只听歌：A 的串词全部作废成 absent；再切回多聊：这次没有可作废的，
  // 走到「为下一首准备串词」——后台会话的 effects 会被丢弃。
  const quiet = send(state, PlaybackEventType.COMPANION_MODE_CHANGED,
    { listeningSessionId: 'conversation:a', modeId: 'music_only', requestId: 'suspended-mode-1' });
  assert.equal(quiet.accepted, true, quiet.reason);
  const changed = send(quiet.state, PlaybackEventType.COMPANION_MODE_CHANGED,
    { listeningSessionId: 'conversation:a', modeId: 'conversational', requestId: 'suspended-mode-2' });
  assert.equal(changed.accepted, true, changed.reason);
  const suspended = changed.state.suspendedSessions['conversation:a'];
  assert.equal(suspended.companionModeId, 'conversational');
  assert.equal(suspended.queue.some(item => item.narration?.status === 'preparing'), false,
    '后台编辑丢弃 effects：不能留下没有 worker 的 preparing');
  const back = send(changed.state, PlaybackEventType.LISTENING_SESSION_SWITCH_REQUESTED,
    { listeningSessionId: 'conversation:a' });
  assert.equal(back.accepted, true, back.reason);
  // 切回后凡是 preparing 的串词，都必须有本次下发的准备 effect 托底。
  const preparing = back.state.queue.filter(item => item.narration?.status === 'preparing').map(item => item.queueItemId);
  const prepared = back.effects.filter(effect => effect.type === PlaybackEffectType.PREPARE_TRACK_NARRATION)
    .map(effect => effect.queueItemId);
  assert.ok(preparing.length > 0, '切回后要为当前与下一首重新准备');
  assert.deepEqual(prepared.sort(), preparing.sort());
});
