import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_NARRATION_POLICY,
  PlaybackEventType,
  PlaybackPhase,
  isPlaybackRuntimeSnapshot,
  normalizeOrderedTarget,
  normalizeRuntimeTrack,
  validatePlaybackEvent,
  publicRuntimeState,
  wireRuntimeState,
} from './playbackRuntimeTypes.js';
import { createPlaybackRuntimeState, hydratePlaybackRuntimeState } from './PlaybackRuntime.js';

function track(overrides = {}) {
  return {
    songId: 'song-1', programId: 'program-1', requestId: 'request-1',
    title: '街灯晚餐', artist: '卫兰', url: '/street.mp3',
    intro: { text: '第一首，卫兰的《街灯晚餐》。', url: '/street-tts.mp3' },
    ...overrides,
  };
}

test('runtime track and ordered target schemas normalize immutable identities', () => {
  const normalizedTrack = normalizeRuntimeTrack(track());
  const target = normalizeOrderedTarget({ title: '少女的祈祷', artist: '杨千嬅', provider: 'ncm' });

  assert.equal(normalizedTrack.songId, 'song-1');
  assert.equal(normalizedTrack.narration.ttsUrl, '/street-tts.mp3');
  assert.match(normalizedTrack.queueItemId, /^queue:[a-f0-9]{32}$/);
  assert.equal(target.exact, true);
  assert.equal(Object.isFrozen(normalizedTrack), true);
  assert.equal(Object.isFrozen(normalizedTrack.narration), true);
  assert.equal(Object.isFrozen(target), true);
  assert.throws(() => { normalizedTrack.title = 'mutated'; }, TypeError);
});

test('event schema requires ids, versions, and committed tracks', () => {
  assert.deepEqual(validatePlaybackEvent({ type: PlaybackEventType.NEXT_REQUESTED, eventId: 'next-1' }), {
    ok: false, error: 'client playback event requires runtimeVersion',
  });
  assert.equal(validatePlaybackEvent({
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'commit-1', delivery: 'replace_now', tracks: [track()],
  }).ok, true);
  assert.deepEqual(validatePlaybackEvent({
    type: PlaybackEventType.PROGRAM_COMMITTED,
    eventId: 'auto-without-boundary', delivery: 'append', source: 'auto_continue', tracks: [track()],
  }), {
    ok: false, error: 'auto continuation commit requires continuationBoundaryKey',
  });
  assert.equal(validatePlaybackEvent({ type: 'UNKNOWN', eventId: 'bad' }).ok, false);
});

test('narration delivery schema requires complete activation identity', () => {
  const missingIdentity = validatePlaybackEvent({
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'narration-started', runtimeVersion: 3, queueItemId: 'queue:one',
  });
  assert.deepEqual(missingIdentity, {
    ok: false, error: 'narration delivery event requires activation identity',
  });
  assert.equal(validatePlaybackEvent({
    type: PlaybackEventType.NARRATION_DELIVERY_STARTED,
    eventId: 'narration-started-full', runtimeVersion: 3, queueItemId: 'queue:one',
    correlationId: 'runtime-one', listeningSessionId: 'conversation:one', outputGeneration: 2,
    positionSeconds: 1, durationSeconds: 120,
  }).ok, true);
  assert.equal(validatePlaybackEvent({
    type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'ready',
    queueItemId: 'queue:one', generationRevision: 1,
  }).ok, false);
});

test('placeholder-only narration is never treated as speakable narration', () => {
  const placeholder = normalizeRuntimeTrack({ ...track(), intro: { url: '/street-tts.mp3' } });
  assert.equal(placeholder.narration.status, 'absent');
  assert.equal(placeholder.narration.ttsUrl, null);
  assert.equal(placeholder.narration.assetStatus, 'missing');
  assert.equal(placeholder.narration.context?.origin, 'live');

  const real = normalizeRuntimeTrack({ songId: 'song-2', programId: 'program-1', requestId: 'request-1',
    title: '如诗般宁静', artist: '广桥真纪子', url: '/quiet.mp3',
    narration: { status: 'absent', text: '接下来是广桥真纪子的《如诗般宁静》。', context: { origin: 'prepared' } } });
  assert.equal(real.narration.status, 'absent');
  assert.equal(real.narration.context.origin, 'prepared');

  // Legacy asset reference with a real intro text stays reusable as-is.
  const legacyText = normalizeRuntimeTrack({ ...track(), intro: { text: '第一首，卫兰的《街灯晚餐》。', url: '/street-tts.mp3' } });
  assert.equal(legacyText.narration.status, 'ready');
  assert.equal(legacyText.narration.ttsUrl, '/street-tts.mp3');

  const voiced = normalizeRuntimeTrack({ songId: 'song-3', programId: 'program-1', requestId: 'request-1',
    title: '街灯晚餐', artist: '卫兰', url: '/street.mp3',
    narration: { status: 'ready', assetStatus: 'ready',
      text: '接下来是卫兰的《街灯晚餐》。这首作品收录在《街灯晚餐》里，可以安静听下去。', ttsUrl: '/street-tts.mp3' } });
  assert.equal(voiced.narration.status, 'ready');
  assert.equal(voiced.narration.ttsUrl, '/street-tts.mp3');
  assert.equal(voiced.narration.assetStatus, 'ready');

  const declaredPlaceholder = normalizeRuntimeTrack({ songId: 'song-4', programId: 'program-1', requestId: 'request-1',
    title: '街灯晚餐', artist: '卫兰', url: '/street.mp3',
    narration: { status: 'ready', assetStatus: 'ready', text: '接下来是卫兰的《街灯晚餐》。', ttsUrl: '/street-tts.mp3',
      previousSongId: 'song-previous' } });
  // A declared narration state is authoritative: the bounded one-sentence
  // fallback must survive persistence and restart.
  assert.equal(declaredPlaceholder.narration.status, 'ready');
  assert.equal(declaredPlaceholder.narration.ttsUrl, '/street-tts.mp3');
  assert.equal(declaredPlaceholder.narration.previousSongId, 'song-previous');
});

test('慢合成预算：默认开口窗口三十秒合成、六十秒开口，旧默认二十秒在恢复时升级', () => {
  assert.equal(DEFAULT_NARRATION_POLICY.maxStartOffsetMs, 60_000);
  const base = createPlaybackRuntimeState();
  const legacy = hydratePlaybackRuntimeState({ ...base,
    narrationPolicy: { ...base.narrationPolicy, maxStartOffsetMs: 20_000 } });
  assert.equal(legacy.narrationPolicy.maxStartOffsetMs, 60_000, '历史默认 20 秒升级为 60 秒');
  const customized = hydratePlaybackRuntimeState({ ...base,
    narrationPolicy: { ...base.narrationPolicy, maxStartOffsetMs: 15_000 } });
  assert.equal(customized.narrationPolicy.maxStartOffsetMs, 15_000, '显式自定义窗口保留');
  const wide = hydratePlaybackRuntimeState({ ...base,
    narrationPolicy: { ...base.narrationPolicy, maxStartOffsetMs: 200_000 } });
  assert.equal(wide.narrationPolicy.maxStartOffsetMs, 200_000, '更大的显式窗口保留');
});

test('没有音频的已接受正文恢复为 ready 正文与独立的资产失败状态', () => {
  const text = '接下来是周杰伦的《晴天》。可以安静听下去。';
  const base = { songId: 'song-9', programId: 'p', requestId: 'r', title: '晴天', artist: '周杰伦', url: '/s.mp3' };
  const normalized = normalizeRuntimeTrack({ ...base,
    narration: { status: 'ready', assetStatus: 'failed', text,
      spokenText: `{叹气}${text}`, performance: { emotion: 'sad' },
      synthesisReason: 'timeout', synthesisElapsedMs: 30_000 } });
  assert.equal(normalized.narration.status, 'ready', '正文仍可用');
  assert.equal(normalized.narration.assetStatus, 'failed', '资产失败独立记录');
  assert.equal(normalized.narration.ttsUrl, null);
  assert.equal(normalized.narration.text, text);
  assert.equal(normalized.narration.spokenText, `{叹气}${text}`);
  assert.deepEqual(normalized.narration.performance, { emotion: 'sad', pace: null, intensity: null, direction: null });
  assert.equal(normalized.narration.synthesisReason, 'timeout');
  assert.equal(normalized.narration.synthesisElapsedMs, 30_000);
  const raw = normalizeRuntimeTrack({ ...base,
    narration: { status: 'ready', assetStatus: 'failed', text, synthesisReason: 'sk-secret provider exploded' } });
  assert.equal(raw.narration.synthesisReason, null, '封闭原因之外一律丢弃');
  assert.equal(raw.narration.synthesisElapsedMs, null);
});

test('a re-attach confirmation carries a version and a real media position', () => {
  const identity = {
    queueItemId: 'queue:one', songId: 'song-1', programId: 'program-1', correlationId: 'runtime-one',
    listeningSessionId: 'conversation:one', outputGeneration: 2,
  };
  assert.deepEqual(validatePlaybackEvent({ type: PlaybackEventType.TRACK_REATTACHED,
    eventId: 'reattach-1', ...identity, positionSeconds: 12.5 }), {
    ok: false, error: 'client playback event requires runtimeVersion',
  });
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.TRACK_REATTACHED,
    eventId: 'reattach-2', runtimeVersion: 4, ...identity, positionSeconds: 12.5 }).ok, true);
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.TRACK_REATTACHED,
    eventId: 'reattach-3', runtimeVersion: 4, ...identity }).ok, false);
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.TRACK_REATTACHED,
    eventId: 'reattach-4', runtimeVersion: 4, ...identity, positionSeconds: -1 }).ok, false);
});

test('a pause may carry the position the client actually holds, but never a bogus one', () => {
  const identity = { eventId: 'pause-1', runtimeVersion: 2, songId: 'song-1' };
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.PAUSE_REQUESTED, ...identity }).ok, true);
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.PAUSE_REQUESTED, ...identity,
    positionSeconds: 37.5 }).ok, true);
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.PAUSE_REQUESTED, ...identity,
    positionSeconds: -0.5 }).ok, false);
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.PAUSE_REQUESTED, ...identity,
    positionSeconds: '37' }).ok, false);
  assert.equal(validatePlaybackEvent({ type: PlaybackEventType.PAUSE_REQUESTED, ...identity,
    positionSeconds: Number.NaN }).ok, false);
});

test('fresh runtime snapshot is valid, immutable, and has an explicit phase', () => {
  const state = createPlaybackRuntimeState({ companionModeId: null });
  assert.equal(state.phase, PlaybackPhase.IDLE);
  assert.equal(isPlaybackRuntimeSnapshot(state), true);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state.queue), true);
});

test('recommendedBy 随队列项保留；旧队列项没有这个字段时按无推荐人处理，负责人原样保留', () => {
  const recommended = normalizeRuntimeTrack({ ...track(), virtualPersonId: 'host', recommendedBy: 'member' });
  assert.equal(recommended.virtualPersonId, 'host');
  assert.equal(recommended.recommendedBy, 'member');
  // 持久化后恢复走同一个归一化：字段不丢。
  assert.equal(normalizeRuntimeTrack(JSON.parse(JSON.stringify(recommended))).recommendedBy, 'member');
  const legacy = normalizeRuntimeTrack({ ...track(), virtualPersonId: 'member' });
  assert.equal(legacy.recommendedBy, null);
  assert.equal(legacy.virtualPersonId, 'member');
});

test('publicRuntimeState：没说出口的串词不出 runtime，被挂起的聊天也一样', () => {
  const unspoken = { queueItemId: 'q1', title: '歌', narration: { status: 'ready', text: '还没说的话', spokenText: '还没说的话{笑}', spoken: false, ttsUrl: '/tts/1.mp3', performance: { emotion: 'calm' } } };
  const said = { queueItemId: 'q2', title: '歌', narration: { status: 'ready', text: '说过的话', spoken: true, ttsUrl: '/tts/2.mp3' } };
  const state = { version: 1, queue: [unspoken, said], suspendedSessions: { other: { phase: 'paused', queue: [unspoken] }, empty: { phase: 'idle' } } };
  const visible = publicRuntimeState(state);
  assert.doesNotMatch(JSON.stringify(visible), /还没说的话/u);
  assert.equal(visible.queue[1].narration.text, '说过的话', '说出口之后已经入账');
  assert.equal(visible.queue[0].title, '歌', '别的字段不动');
  assert.equal(visible.suspendedSessions.empty.phase, 'idle');
  assert.equal(state.queue[0].narration.text, '还没说的话', '不改 runtime 自己的状态');
  assert.equal(publicRuntimeState(null), null);
});

test('wireRuntimeState：仅保留当前与下一首歌词、清空未说出口串词并保留挂起会话元数据与无 lyric 键形态', () => {
  const unspoken = (id, withLyric = true) => ({
    queueItemId: `q-${id}`,
    songId: `song-${id}`,
    title: `歌 ${id}`,
    artist: `歌手 ${id}`,
    ...(withLyric ? { lyric: `[00:01] 歌词 ${id}` } : {}),
    narration: { status: 'ready', text: `还没说 ${id}`, spokenText: `还没说 ${id}{笑}`, about: '备忘', spoken: false, ttsUrl: `/tts/${id}.mp3`, performance: { emotion: 'calm' } },
  });
  const spoken = id => ({
    queueItemId: `q-${id}`,
    songId: `song-${id}`,
    title: `歌 ${id}`,
    artist: `歌手 ${id}`,
    lyric: `[00:01] 歌词 ${id}`,
    narration: { status: 'ready', text: `已说过 ${id}`, about: '秘密备忘', spoken: true, ttsUrl: `/tts/${id}.mp3` },
  });
  const state = {
    version: 5,
    currentIndex: 1,
    queue: [spoken('0'), unspoken('1'), unspoken('2'), unspoken('3'), unspoken('4', false)],
    suspendedSessions: {
      other: {
        phase: 'paused',
        currentIndex: 0,
        currentSongId: 'song-s0',
        positionSeconds: 42,
        listeningPlan: { request: { mode: 'discovery' } },
        companionModeId: 'conversational',
        lastOutputTrack: { songId: 'song-s0', title: '歌 s0', artist: '歌手 s0' },
        queue: [unspoken('s0'), unspoken('s1', false)],
      },
      empty: { phase: 'idle' },
    },
  };

  const wired = wireRuntimeState(state);
  assert.equal(wireRuntimeState(null), null);
  assert.equal(wired.queue[0].lyric, null, '已播曲目清空歌词');
  assert.equal(wired.queue[1].lyric, '[00:01] 歌词 1', '当前曲保留歌词');
  assert.equal(wired.queue[2].lyric, '[00:01] 歌词 2', '下一首保留歌词');
  assert.equal(wired.queue[3].lyric, null, '更后待播清空歌词');
  assert.equal(Object.hasOwn(wired.queue[4], 'lyric'), false, '原本没有 lyric 键时不新增 lyric: null');

  assert.equal(wired.queue[0].narration.text, '已说过 0', '已说出口保留正文');
  assert.equal(Object.hasOwn(wired.queue[0].narration, 'about'), false, '备忘始终剥离');
  assert.equal(Object.hasOwn(wired.queue[1].narration, 'text'), false, '未说出口剥离正文');

  const suspended = wired.suspendedSessions.other;
  assert.equal(suspended.phase, 'paused');
  assert.equal(suspended.currentIndex, 0);
  assert.equal(suspended.currentSongId, 'song-s0');
  assert.equal(suspended.positionSeconds, 42);
  assert.deepEqual(suspended.listeningPlan, { request: { mode: 'discovery' } });
  assert.equal(suspended.companionModeId, 'conversational');
  assert.deepEqual(suspended.lastOutputTrack, { songId: 'song-s0', title: '歌 s0', artist: '歌手 s0' });
  assert.equal(suspended.queue[0].queueItemId, 'q-s0');
  assert.equal(suspended.queue[0].songId, 'song-s0');
  assert.equal(suspended.queue[0].title, '歌 s0');
  assert.equal(suspended.queue[0].artist, '歌手 s0');
  assert.equal(suspended.queue[0].lyric, null, '挂起会话全部曲目清空歌词');
  assert.equal(Object.hasOwn(suspended.queue[0].narration, 'text'), false);
  assert.equal(Object.hasOwn(suspended.queue[1], 'lyric'), false, '挂起会话原本无 lyric 键时不新增');
  assert.equal(wired.suspendedSessions.empty.phase, 'idle');

  // currentIndex < 0 时仅保留第 0 首的歌词
  const idleWired = wireRuntimeState({
    currentIndex: -1,
    queue: [unspoken('a'), unspoken('b')],
  });
  assert.equal(idleWired.queue[0].lyric, '[00:01] 歌词 a');
  assert.equal(idleWired.queue[1].lyric, null);

  // publicRuntimeState 保持原样继续保留所有曲目的 lyric
  const pub = publicRuntimeState(state);
  assert.equal(pub.queue[0].lyric, '[00:01] 歌词 0');
  assert.equal(pub.queue[3].lyric, '[00:01] 歌词 3');
  assert.equal(pub.suspendedSessions.other.queue[0].lyric, '[00:01] 歌词 s0');
});
