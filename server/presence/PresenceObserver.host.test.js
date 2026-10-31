import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { createPlaybackRuntimeState } from '../playback/PlaybackRuntime.js';
import { PlaybackEventType as P } from '../playback/playbackRuntimeTypes.js';
import { PresenceObserver } from './PresenceObserver.js';

const NOON = Date.UTC(2026, 9, 18, 4, 0); // 12:00 Asia/Shanghai
const track = (songId, artist) => ({ songId, programId: 'p', requestId: 'r', title: `T${songId}`, artist,
  url: `/${songId}.mp3`, duration: 200, source: 'qq', virtualPersonId: 'lunara' });

for (const modeId of ['occasional', 'conversational']) test(`against the real host: ${modeId} session_open and skips are observed read-only`, async () => {
  let nowMs = NOON;
  // 偶尔介绍仍覆盖无串词边界；新的多聊一点默认逐首准备，不制造无串词边界观察。
  const host = new PlaybackRuntimeHost({ now: () => nowMs,
    ...(modeId === 'occasional' ? { initialState: createPlaybackRuntimeState({ companionModeId: modeId }) } : {}),
  });
  assert.equal(host.snapshot().companionModeId, modeId);
  const traces = [];
  const observer = new PresenceObserver({ now: () => nowMs, timeZone: 'Asia/Shanghai',
    trace: (sessionId, event) => traces.push({ sessionId, ...event }), logger: { warn: () => {} } });
  observer.attach(host);
  const submit = event => host.submit(event).then(result => { assert.equal(result.accepted, true, `${event.type}: ${result.reason}`); return result; });
  const start = () => { const s = host.snapshot(); return submit({ type: P.TRACK_STARTED, eventId: `start-${s.version}`,
    runtimeVersion: s.version, songId: s.currentSongId, programId: s.txn.programId, correlationId: s.txn.correlationId,
    queueItemId: s.txn.queueItemId, listeningSessionId: s.activeListeningSessionId, outputGeneration: s.outputGeneration, positionSeconds: 0 }); };
  const next = () => { const s = host.snapshot(); return submit({ type: P.NEXT_REQUESTED, eventId: `next-${s.version}`,
    runtimeVersion: s.version, songId: s.currentSongId }); };

  await submit({ type: P.PROGRAM_COMMITTED, eventId: 'commit', delivery: 'replace_now', source: 'user',
    tracks: [track('a', '同一人'), track('b', '同一人'), track('c', '别人'), track('d', '别人'), track('e', '第三人')] });
  await start();
  // 刚开播 5 秒就跳：连续两次跳过。
  nowMs += 5_000; await next(); await start();
  nowMs += 5_000; await next(); await start();
  const decisions = traces.filter(t => t.type === 'presence_decision');
  assert.deepEqual(decisions.map(d => [d.momentKind, d.decision, d.reason]), [
    ['session_open', 'speak', 'eligible'],
    // 影子开口刷新了人声间隔：之后 120 秒内的时刻都先被 too-soon 拦下。
    ['track_skipped', 'silence', 'too-soon'],
    ...(modeId === 'occasional' ? [['boundary_without_intro', 'silence', 'too-soon']] : []),
    ['track_skipped', 'silence', 'too-soon'],
    ...(modeId === 'occasional' ? [['boundary_without_intro', 'silence', 'too-soon']] : []),
  ]);
  assert.equal(observer.entry(host.snapshot().activeListeningSessionId).consecutiveSkips, 2);
  assert.ok(decisions.every(d => d.shadow === true));
});
