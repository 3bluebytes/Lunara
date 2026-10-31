import assert from 'node:assert/strict';
import test from 'node:test';

import { registerOperationsRoutes } from './operationsRoutes.js';
import { PlaybackOperationsService } from '../../services/PlaybackOperationsService.js';
import { PlaybackRuntimeHost } from '../../playback/PlaybackRuntimeHost.js';
import { PlaybackEventType } from '../../playback/playbackRuntimeTypes.js';
import { createAppState } from '../../../pwa/core/appState.js';
import { createPlaybackRuntimeClient } from '../../../pwa/features/playback/playbackRuntimeClient.js';
import { deriveConversationPresentation } from '../../../pwa/features/conversations/conversationPresentation.js';

function fakeApp() {
  const routes = new Map();
  return {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
    routes,
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function createHarness({ submitted = [] } = {}) {
  const host = new PlaybackRuntimeHost({});
  const runtime = {
    snapshot: () => host.snapshot(),
    listeningSnapshot: id => host.listeningSnapshot(id),
    submit: async event => {
      submitted.push(event);
      return host.submit(event);
    },
  };
  const app = fakeApp();
  registerOperationsRoutes(app, {
    playbackRuntime: runtime,
    playbackOperationsService: new PlaybackOperationsService({ playbackRuntime: runtime }),
  });
  return { app, runtime };
}

const PATCH_PATH = 'PATCH /api/listening-sessions/:id/companion-mode';

function assertFullRuntime(snapshot, sessionId) {
  assert.ok(snapshot, 'the response must include a complete runtime, not only a scoped snapshot');
  assert.equal(snapshot.activeListeningSessionId, sessionId);
  assert.ok(Number.isInteger(snapshot.version));
  assert.ok(snapshot.suspendedSessions);
}

test('real mode route and PWA client preserve active source without a later broadcast', async () => {
  const { app, runtime } = createHarness();
  await runtime.submit({ type: 'PROGRAM_COMMITTED', eventId: 'source-fixture',
    delivery: 'replace_now', source: 'user', tracks: [{ songId: 'fixture-song',
      programId: 'fixture-program', requestId: 'fixture-request', title: 'Fixture', artist: 'Fixture',
      url: '/fixture.wav', duration: 200 }] });
  await runtime.submit({ type: 'LISTENING_SESSION_CREATED', eventId: 'create-b', listeningSessionId: 'conversation:b' });
  const initial = runtime.snapshot();
  const store = createAppState({ runtimeState: initial });
  const observed = [];
  store.subscribe(state => observed.push(state.runtimeState));
  const client = createPlaybackRuntimeClient({
    store, narrationAudio: { addEventListener() {}, async play() {} }, musicAudio: {},
    apiClient: {
      async post() { throw new Error('mode changes must not post playback controls'); },
      async patch(path, body) {
        assert.equal(path, '/api/listening-sessions/conversation%3Aprimary/companion-mode');
        const res = response();
        await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' }, body }, res);
        assert.equal(res.statusCode, 200);
        return res.payload;
      },
    },
  });
  await client.setCompanionMode('conversational');
  assert.equal(observed.length, 1);
  for (const state of observed) {
    assert.equal(state.activeListeningSessionId, initial.activeListeningSessionId);
    assert.equal(state.outputGeneration, initial.outputGeneration);
    assert.equal(state.positionSeconds, initial.positionSeconds);
    // Mode changes legitimately invalidate unstarted narration artifacts, but
    // must preserve the actual queue occurrences and media transaction.
    const mediaQueue = queue => queue.map(({ narration, ...item }) => item);
    assert.deepEqual(mediaQueue(state.queue), mediaQueue(initial.queue));
    assert.equal(state.phase, initial.phase);
    for (const key of ['correlationId', 'queueItemId', 'programId', 'songId', 'phase', 'activatedAtMs', 'startedAtMs']) {
      assert.equal(state.txn[key], initial.txn[key], `media transaction ${key}`);
    }
    assert.deepEqual(state.suspendedSessions, initial.suspendedSessions);
    const room = { sessionId: 'conversation:primary', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' };
    const view = deriveConversationPresentation({ rooms: [room], focusedRoom: room, runtime: state });
    assert.equal(view.listeningRoom, room);
    assert.ok(view.focusedListeningTrack);
    assert.equal(view.sourceMismatch, false);
  }
  assert.equal(store.getState().runtimeState.companionModeId, 'conversational');
});

test('saving a suspended session returns its local mode and the actual global source separately', async () => {
  const { app, runtime } = createHarness();
  await runtime.submit({ type: 'LISTENING_SESSION_CREATED', eventId: 'background-b', listeningSessionId: 'conversation:b' });
  const initial = runtime.snapshot();
  const res = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:b' },
    body: { modeId: 'conversational', requestId: 'background-mode' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.snapshot.active, false);
  assert.equal(res.payload.snapshot.listeningSessionId, 'conversation:b');
  assert.equal(res.payload.snapshot.companionModeId, 'conversational');
  assertFullRuntime(res.payload.runtime, initial.activeListeningSessionId);
  assert.equal(res.payload.runtime.companionModeId, initial.companionModeId);
  assert.equal(res.payload.runtime.suspendedSessions['conversation:b'].companionModeId, 'conversational');
});

test('companion mode route applies a validated change and returns the authoritative snapshot', async () => {
  const { app } = createHarness();
  const res = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' },
    body: { modeId: 'music_only', requestId: 'route-1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.snapshot.companionModeId, 'music_only');
  assert.equal(res.payload.snapshot.modeSource, 'explicit');
  assertFullRuntime(res.payload.runtime, 'conversation:primary');
  assert.equal(res.payload.runtime.companionModeId, 'music_only');
});

test('duplicate requests return the same result without resetting counting', async () => {
  const { app } = createHarness();
  const first = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' },
    body: { modeId: 'conversational', requestId: 'route-dup' } }, first);
  assert.equal(first.statusCode, 200);
  const duplicate = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' },
    body: { modeId: 'conversational', requestId: 'route-dup' } }, duplicate);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.payload.ok, true);
  assert.equal(duplicate.payload.idempotent, true);
  assertFullRuntime(duplicate.payload.runtime, 'conversation:primary');
  assert.equal(duplicate.payload.snapshot.modeRevision, first.payload.snapshot.modeRevision);
});

test('stale revisions are rejected with a recoverable snapshot', async () => {
  const { app } = createHarness();
  const res = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' },
    body: { modeId: 'music_only', requestId: 'route-stale', expectedRevision: 9 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.code, 'stale_mode_revision');
  assert.equal(res.payload.snapshot.companionModeId, 'conversational');
  assertFullRuntime(res.payload.runtime, 'conversation:primary');
});

test('a nullable PATCH clears the override back to the conversational default', async () => {
  const { app } = createHarness();
  const selected = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' },
    body: { modeId: 'music_only', requestId: 'route-clear-1' } }, selected);
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.payload.snapshot.companionModeId, 'music_only');

  for (const body of [{ requestId: 'route-clear-2' }, { modeId: null, requestId: 'route-clear-3' }]) {
    const cleared = response();
    await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' }, body }, cleared);
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.payload.ok, true);
    assert.equal(cleared.payload.snapshot.companionModeId, 'conversational');
    assert.equal(cleared.payload.snapshot.modeSource, 'default');
    assertFullRuntime(cleared.payload.runtime, 'conversation:primary');
    assert.equal(cleared.payload.runtime.companionModeId, 'conversational');
  }
});

test('invalid input and unknown sessions fail closed', async () => {
  const { app } = createHarness();
  const unknown = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:none' },
    body: { modeId: 'occasional', requestId: 'route-unknown' } }, unknown);
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.payload.code, 'listening_session_not_found');

  const badMode = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' },
    body: { modeId: 'party', requestId: 'route-bad' } }, badMode);
  assert.equal(badMode.statusCode, 400);
  assert.equal(badMode.payload.code, 'unknown_companion_mode');

  const noRequest = response();
  await app.routes.get(PATCH_PATH)({ params: { id: 'conversation:primary' },
    body: { modeId: 'occasional' } }, noRequest);
  assert.equal(noRequest.statusCode, 400);
  assert.equal(noRequest.payload.code, 'request_id_required');
});

test('the generic pb-event wire refuses forged companion mode changes', async () => {
  const { app } = createHarness();
  const res = response();
  await app.routes.get('POST /api/pb-event')({ body: {
    type: PlaybackEventType.COMPANION_MODE_CHANGED,
    eventId: 'forge-1', listeningSessionId: 'conversation:primary',
    modeId: 'music_only', requestId: 'forge',
  } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'pb-event type is server-internal: COMPANION_MODE_CHANGED');
});
