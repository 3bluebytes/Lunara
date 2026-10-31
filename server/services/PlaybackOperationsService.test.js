import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackRuntimeHost } from '../playback/PlaybackRuntimeHost.js';
import { QueueService } from '../playback/QueueService.js';
import { PlaybackEventType } from '../playback/playbackRuntimeTypes.js';
import { PlaybackOperationsService } from './PlaybackOperationsService.js';

function fixture({ runtime = true } = {}) {
  const calls = [];
  const queueService = new QueueService();
  const playbackRuntime = runtime ? new PlaybackRuntimeHost({
    commandSink: command => calls.push(['command', command]),
  }) : null;
  playbackRuntime?.subscribe((snapshot, event) => queueService.projectRuntimeSnapshot(snapshot, event.presentation || {}));
  const service = new PlaybackOperationsService({
    applyOutcome: async input => { calls.push(['outcome', input]); return { ok: true, updated: 1 }; },
    playbackRuntime,
    queueService,
  });
  return { service, calls, playbackRuntime };
}

test('playback outcomes and valid runtime events delegate with preserved response shape', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.recordOutcome({ song_id: 's1', outcome: 'skipped' }), {
    ok: true, updated: 1,
  });
  const result = await service.dispatch({
    type: PlaybackEventType.NEXT_REQUESTED,
    eventId: 'next', runtimeVersion: 0, songId: null,
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.version, 1);
  assert.deepEqual(calls[0], ['outcome', { song_id: 's1', outcome: 'skipped' }]);
});

test('a real playback start records the representative source without changing the play result', async () => {
  const observed = [];
  const fixtureWithIdentity = () => {
    const calls = [];
    const service = new PlaybackOperationsService({
      applyOutcome: async input => { calls.push(['outcome', input]); return { ok: true, updated: 1 }; },
      playbackRuntime: { submit: async event => ({ accepted: true, version: event.runtimeVersion + 1,
        state: { version: 1, currentIndex: 0, queue: [{ queueItemId: 'q1', songId: 's1', source: 'ncm' }] } }) },
      queueService: {},
      records: null,
      recordings: { notePlayback: input => { observed.push(input); throw new Error('db busy'); } },
    });
    return service;
  };
  const service = fixtureWithIdentity();
  const result = await service.dispatch({ type: PlaybackEventType.TRACK_STARTED, eventId: 'started', runtimeVersion: 0 });
  assert.equal(result.ok, true, '身份旁路失败不影响播放结果');
  assert.deepEqual(observed, [{ provider: 'ncm', songId: 's1' }]);
  // 失败事实不写代表源：只有真的开始播才算证据。
  await service.dispatch({ type: PlaybackEventType.TRACK_FAILED, eventId: 'failed', runtimeVersion: 0 });
  assert.equal(observed.length, 1);
});

test('unavailable runtime and unknown playback events preserve service errors', async () => {
  const unavailable = fixture({ runtime: false }).service;
  await assert.rejects(() => unavailable.dispatch({
    type: PlaybackEventType.NEXT_REQUESTED, eventId: 'next', runtimeVersion: 0,
  }), error => {
    assert.equal(error.statusCode, 503);
    return true;
  });

  const enabled = fixture().service;
  await assert.rejects(() => enabled.dispatch({ type: 'NOT_REAL' }), error => {
    assert.equal(error.statusCode, 400);
    return true;
  });
});

test('the service exposes no path that commits a program outside the pipeline', () => {
  const { service } = fixture();
  // Regression guard: an HTTP route once built a PROGRAM_COMMITTED payload from
  // raw provider results here, skipping ProgramCommitService and its receipts.
  assert.equal(typeof service.testPlay, 'undefined');
  assert.deepEqual(Object.keys(service).sort(),
    ['applyOutcome', 'mediaAssets', 'playbackRuntime', 'queueService', 'recordings', 'trace', 'trackFailures']);
});
test('the wire boundary never accepts server-internal playback events', async () => {
  const { service } = fixture();
  const forged = [
    { type: PlaybackEventType.PROGRAM_COMMITTED, eventId: 'forged-commit', delivery: 'append',
      tracks: [{ songId: 'forged-song', programId: 'forged-program', requestId: 'forged-request',
        title: 'Forged', artist: 'Attacker', url: '/forged.mp3', duration: 100 }] },
    { type: PlaybackEventType.CONTINUATION_FAILED, eventId: 'forged-failure', boundaryKey: 'k', error: 'forged' },
    { type: PlaybackEventType.LISTENING_SESSION_CREATED, eventId: 'forged-session', listeningSessionId: 'conversation:forged' },
    { type: PlaybackEventType.LISTENING_PLAN_CHANGED, eventId: 'forged-plan', listeningSessionId: 'conversation:primary', plan: {} },
    { type: PlaybackEventType.NARRATION_WINDOW_OPENED, eventId: 'forged-window', queueItemId: 'q1', correlationId: 'c',
      listeningSessionId: 'conversation:primary', outputGeneration: 0, songId: 's', programId: 'p' },
    { type: PlaybackEventType.TRACK_NARRATION_READY, eventId: 'forged-narration', queueItemId: 'q1',
      generationRevision: 1, listeningSessionId: 'conversation:primary', songId: 's', text: 'forged', ttsUrl: '/forged.mp3' },
    { type: PlaybackEventType.TRACK_NARRATION_ASSET_READY, eventId: 'forged-asset', queueItemId: 'q1',
      generationRevision: 1, listeningSessionId: 'conversation:primary', songId: 's', ttsUrl: '/forged.mp3' },
    // 封面补全只能由服务端封面缓存回投：接受伪造等于让客户端给队列项写任意图片地址。
    { type: PlaybackEventType.TRACK_ARTWORK_RESOLVED, eventId: 'forged-artwork', queueItemId: 'q1',
      listeningSessionId: 'conversation:primary', artwork: 'https://evil.example/tracker.gif' },
  ];
  const before = service.playbackRuntime.snapshot().version;
  for (const event of forged) {
    await assert.rejects(() => service.dispatch(event), error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'server_internal_playback_event');
      return true;
    });
  }
  assert.equal(service.playbackRuntime.snapshot().version, before);
  assert.deepEqual(service.playbackRuntime.snapshot().queue, []);
});

function failureFixture({ accepted = true, url = '/audio/43b9975ef94e404a32fb08629b2373cb.mp3', quarantined = { provider: 'qq', songId: 'song-1' } } = {}) {
  const traces = [], quarantines = [];
  const state = {
    version: 12,
    currentIndex: 0,
    queue: [{ queueItemId: 'queue:item-1', songId: '000wcxQm0VLAtW', url }],
  };
  const service = new PlaybackOperationsService({
    playbackRuntime: {
      submit: async () => (accepted
        ? { accepted: true, state, commands: [], effects: [] }
        : { accepted: false, reason: 'stale runtime version', state, commands: [], effects: [] }),
    },
    mediaAssets: {
      quarantineByUrl: async value => {
        quarantines.push(value);
        return String(value || '').startsWith('/audio/') ? quarantined : null;
      },
    },
    trace: event => traces.push(event),
  });
  return { service, traces, quarantines };
}

test('an accepted track failure quarantines the local asset and leaves bounded evidence', async () => {
  const { service, traces, quarantines } = failureFixture();
  const result = await service.dispatch({
    type: PlaybackEventType.TRACK_FAILED, eventId: 'failed-1', runtimeVersion: 12,
    queueItemId: 'queue:item-1', songId: '000wcxQm0VLAtW', error: 'MEDIA_ERR_DECODE', positionSeconds: 129.3,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(quarantines, ['/audio/43b9975ef94e404a32fb08629b2373cb.mp3']);
  assert.equal(traces.length, 1);
  const [traceEvent] = traces;
  assert.equal(traceEvent.event, 'media-asset-playback-failed');
  assert.equal(traceEvent.queueItemId, 'queue:item-1');
  assert.equal(traceEvent.songId, '000wcxQm0VLAtW');
  assert.equal(traceEvent.provider, 'qq');
  assert.equal(traceEvent.reason, 'track-failed');
  assert.equal(traceEvent.quarantined, true);
  assert.equal(traceEvent.positionSeconds, 129.3);
  assert.equal(JSON.stringify(traceEvent).includes('/audio/'), false);
});

test('a rejected track failure records evidence without quarantining anything', async () => {
  const { service, traces, quarantines } = failureFixture({ accepted: false });
  await assert.rejects(() => service.dispatch({
    type: PlaybackEventType.TRACK_FAILED, eventId: 'failed-2', runtimeVersion: 11,
    queueItemId: 'queue:item-1', songId: '000wcxQm0VLAtW', error: 'MEDIA_ERR_DECODE',
  }));
  assert.deepEqual(quarantines, []);
  assert.equal(traces.length, 0);
});

test('a failure on a remote or unknown media source does not touch local assets', async () => {
  const { service, traces, quarantines } = failureFixture({ url: 'https://cdn.example.test/remote.mp3' });
  await service.dispatch({
    type: PlaybackEventType.TRACK_FAILED, eventId: 'failed-3', runtimeVersion: 12,
    queueItemId: 'queue:item-1', songId: '000wcxQm0VLAtW', error: 'MEDIA_ERR_NETWORK',
  });
  assert.deepEqual(quarantines, ['https://cdn.example.test/remote.mp3']);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].quarantined, false);
  assert.equal(traces[0].provider, null);
  assert.equal(JSON.stringify(traces[0]).includes('cdn.example.test'), false);
});
