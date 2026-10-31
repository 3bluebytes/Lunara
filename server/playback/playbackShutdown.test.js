import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaybackRuntimeComposition } from './createPlaybackRuntimeComposition.js';
import { PlaybackRuntimeHost } from './PlaybackRuntimeHost.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const track = id => ({ songId: id, programId: 'p', requestId: 'r', title: id, artist: 'Fixture', source: 'qq',
  url: '/fixture.mp3', duration: 180, intro: { text: 'Fixture', context: { fixture: true } } });

test('stop aborts preparation, clears timers/queue and discards late results across restart', async () => {
  const pending = [], timers = new Map(), published = [], saved = new Map();
  let sequence = 0;
  const runtime = createPlaybackRuntimeComposition({
    prefs: { getPref: key => saved.get(key), setPref: (key, value) => saved.set(key, value) },
    queueService: { projectRuntimeSnapshot() {} }, publish: message => published.push(message),
    maxPreparationConcurrency: 1,
    schedule: callback => { const id = ++sequence; timers.set(id, callback); return id; },
    cancelSchedule: id => timers.delete(id),
    prepareTrackNarration: (_effect, { signal }) => new Promise(resolve => pending.push({ signal, resolve })),
  });
  await runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'commit', delivery: 'replace_now', source: 'user',
    tracks: [track('one'), track('two')] });
  await settle();
  let state = runtime.snapshot();
  await runtime.submit({ type: 'TRACK_STARTED', eventId: 'started', runtimeVersion: state.version,
    songId: 'one', programId: 'p', correlationId: state.txn.correlationId });
  assert.equal(pending.length, 1);
  assert.ok(timers.size > 0);
  await runtime.stop();
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(timers.size, 0);
  const stopped = runtime.snapshot();
  const before = published.length;
  assert.equal((await runtime.submit({ type: 'RESET_REQUESTED', eventId: 'after-stop', runtimeVersion: stopped.version })).accepted, false);
  await runtime.startRecovery();
  await settle();
  assert.equal(pending.length, 2, 'restart recovers fresh work while obsolete provider ignores abort');
  const restarted = runtime.snapshot();
  const afterRestart = published.length;
  pending[0].resolve({ text: 'STALE', ttsUrl: '/stale.wav' });
  await settle();
  assert.deepEqual(runtime.snapshot(), restarted);
  assert.equal(published.length, afterRestart);
  pending[1].resolve({ text: 'Fresh', ttsUrl: '/fresh.wav' });
  await settle();
  assert.equal(runtime.snapshot().queue[0].narration.text, 'Fresh');
  assert.ok(published.length >= before);
  await runtime.stop();
});

test('stop aborts continuation and never accepts its delayed outcome', async () => {
  let signal, release;
  const runtime = createPlaybackRuntimeComposition({
    prefs: { getPref: () => null, setPref() {} }, queueService: { projectRuntimeSnapshot() {} }, publish() {},
    schedule: () => 0, cancelSchedule() {},
    getRadioRequestService: () => ({ handleContinue: input => {
      signal = input.signal; return new Promise(resolve => { release = resolve; });
    } }),
  });
  await runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'commit', delivery: 'replace_now', source: 'user',
    tracks: [{ ...track('one'), intro: null }] });
  await settle();
  // 单曲队列激活即提前发起续选：in-flight 请求从一开始就存在，stop 必须能中断它。
  assert.equal(signal != null && !signal.aborted, true);
  let state = runtime.snapshot();
  await runtime.submit({ type: 'TRACK_STARTED', eventId: 'started', runtimeVersion: state.version,
    songId: 'one', programId: 'p', correlationId: state.txn.correlationId });
  await settle();
  state = runtime.snapshot();
  const ended = await runtime.submit({ type: 'TRACK_ENDED', eventId: 'ended', runtimeVersion: state.version,
    songId: 'one', programId: 'p', correlationId: state.txn.correlationId, natural: true, deliveredDuration: 180 });
  assert.equal(ended.accepted, true, ended.reason);
  assert.equal(ended.effects.some(effect => effect.type === 'REQUEST_CONTINUATION'), false,
    '预取边界已挂起，耗尽不重复发起请求');
  await settle();
  await runtime.stop();
  assert.equal(signal.aborted, true);
  const stopped = runtime.snapshot();
  release({ ok: false, code: 'late-failure' }); await settle();
  assert.deepEqual(runtime.snapshot(), stopped);
});

test('host rejects pre-stop queued events even after a restart', async () => {
  const runtime = new PlaybackRuntimeHost();
  const submitted = runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'queued', delivery: 'replace_now',
    source: 'user', tracks: [track('one')] });
  await runtime.stop();
  await runtime.startRecovery();
  assert.equal((await submitted).accepted, false);
  assert.equal(runtime.snapshot().queue.length, 0);
});
