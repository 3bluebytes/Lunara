import assert from 'node:assert/strict';
import test from 'node:test';

import { PlaybackRuntimeHost } from '../../../server/playback/PlaybackRuntimeHost.js';
import { createPlaybackRuntimeState } from '../../../server/playback/PlaybackRuntime.js';
import { reduceServerMessage, createAppState } from '../../core/appState.js';
import { createConversationController } from './conversationController.js';
import { createNarrationCoordinator } from '../playback/narrationCoordinator.js';
import { createPlaybackRuntimeClient } from '../playback/playbackRuntimeClient.js';
import { createRuntimePlaybackCallbacks } from '../../runtimePlaybackCallbacks.js';

class FakeAudio {
  constructor() {
    this.src = '';
    this.paused = true;
    this.ended = false;
    this.duration = 30;
    this.currentTime = 1;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  pause() { this.paused = true; }
  async play() { this.paused = false; this.ended = false; }
  emit(type) {
    if (type === 'ended') this.ended = true;
    for (const listener of this.listeners.get(type) || []) listener({ type, currentTarget: this });
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('runtime track starts without releasing the conversation turn; narration waits for onAfterSend', async t => {
  const store = createAppState({ sessionId: 'conversation:primary' });
  const narration = new FakeAudio();
  const music = new FakeAudio();
  const narrator = createNarrationCoordinator({ audio: narration, locationHref: 'http://localhost/' }).init();
  let activeTurnId = null;
  let resolveChat;
  const room = { sessionId: 'conversation:primary', title: 'Lunara', memberIds: ['lunara'], activeVirtualPersonId: 'lunara' };
  const conversationsApi = {
    get: async path => path === '/api/conversations?archived=true'
      ? { conversations: [room] }
      : { sessionId: room.sessionId, turns: [] },
    chat: () => new Promise(resolve => { resolveChat = resolve; }),
  };
  const conversation = createConversationController({
    store,
    apiClient: conversationsApi,
    onBeforeSend: ({ requestId }) => { activeTurnId = narrator.beginForegroundTurn(requestId); },
    onAfterSend: ({ requestId }) => {
      if (activeTurnId === requestId) {
        narrator.endForegroundTurn(requestId);
        activeTurnId = null;
      }
    },
  });
  await conversation.refresh();
  const chatPromise = conversation.send('给我放一首歌');
  await settle();
  assert.ok(activeTurnId);

  let client;
  const host = new PlaybackRuntimeHost({
    commandSink: command => client.execute(command),
    initialState: createPlaybackRuntimeState({ narrationPolicy: {
      settlingDelayMs: 0, maxStartOffsetMs: 20_000, minRemainingMs: 15_000,
    } }),
  });
  host.subscribe(state => reduceServerMessage(store, { type: 'runtime-state', state }));
  const presentedTracks = [];
  const clientCallbacks = createRuntimePlaybackCallbacks({
    playbackView: { callbacks: {
      onTrack: item => presentedTracks.push(item),
      onNarration() {},
      onStatus() {},
      onChanged() {},
    } },
    narrationAudio: narration,
    musicAudio: music,
  });
  client = createPlaybackRuntimeClient({
    store,
    narrationAudio: narration,
    musicAudio: music,
    narrationCoordinator: narrator,
    locationHref: 'http://localhost/',
    apiClient: { post: (_path, event) => host.submit(event) },
    callbacks: clientCallbacks,
  }).init();
  t.after(() => { client.destroy(); narrator.destroy(); });

  await host.submit({
    type: 'PROGRAM_COMMITTED', eventId: 'chat-turn-program', delivery: 'replace_now', source: 'user',
    tracks: [{
      songId: 'next-song', programId: 'program', requestId: 'request', title: '下一首', artist: '歌手',
      url: '/next-song.mp3', duration: 30,
      narration: { status: 'preparing', assetStatus: 'missing', generationRevision: 1,
        text: '接下来是歌手的《下一首》。', context: {} },
    }],
  });

  assert.equal(music.src, '/next-song.mp3');
  assert.equal(music.paused, false);
  assert.equal(presentedTracks.length, 1);
  assert.deepEqual(narrator.getSnapshot().foregroundTurns, [activeTurnId]);
  music.emit('playing');
  await settle();
  const activation = host.snapshot();
  const narrationReady = await host.submit({
    type: 'TRACK_NARRATION_READY', eventId: 'chat-turn-voice-ready',
    queueItemId: activation.txn.queueItemId,
    generationRevision: activation.txn.narrationGenerationRevision,
    listeningSessionId: activation.activeListeningSessionId,
    outputGeneration: activation.outputGeneration,
    text: '接下来是歌手的《下一首》。', ttsUrl: '/next-song-tts.mp3',
  });
  await settle();
  assert.equal(narrationReady.accepted, true);
  assert.equal(narration.src, '', 'runtime narration stays queued behind the foreground turn');
  assert.equal(narrator.getSnapshot().queued[0]?.lane, 'runtime');
  assert.deepEqual(narrator.getSnapshot().foregroundTurns, [activeTurnId]);

  resolveChat({ ok: true });
  await chatPromise;
  for (let attempt = 0; attempt < 8 && narration.src !== '/next-song-tts.mp3'; attempt += 1) await settle();
  assert.equal(activeTurnId, null, 'conversation onAfterSend releases the foreground lane');
  assert.deepEqual(narrator.getSnapshot().foregroundTurns, []);
  assert.equal(narration.src, '/next-song-tts.mp3');
});
