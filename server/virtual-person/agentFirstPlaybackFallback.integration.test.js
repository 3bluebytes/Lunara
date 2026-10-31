import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVirtualPersonRuntimeComposition } from './createVirtualPersonRuntimeComposition.js';
import { MusicSelectionService } from '../program/MusicSelectionService.js';

test('failed AgentLoop resumes a paused track once through the production music receipt and control tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-agent-fallback-'));
  const events = [];
  let modelCalls = 0;
  const state = { version: 8, outputGeneration: 2, activeListeningSessionId: 'room',
    currentSongId: 'song-a', currentIndex: 0, phase: 'paused', queue: [{ songId: 'song-a', queueItemId: 'item-a' }] };
  const playbackRuntime = {
    snapshot: () => state,
    listeningSnapshot: sessionId => ({ ...state, active: sessionId === state.activeListeningSessionId,
      listeningSessionId: sessionId, runtimeVersion: state.version }),
    async submit(event) {
      events.push(event);
      state.phase = 'playing';
      state.version++;
      return { accepted: true, commands: [{ type: 'RESUME_TRACK' }], effects: [] };
    },
  };
  let musicService;
  const composition = createVirtualPersonRuntimeComposition({
    dbPath: join(dir, 'state.db'),
    chat: async () => { modelCalls++; return { message: { role: 'assistant', content: '' } }; },
    synthesize: async () => null,
    publish() {},
    queueService: { snapshot: () => ({}), publishSnapshot() {} },
    playbackRuntime,
    getMusicService: () => musicService,
    logger: { error() {}, warn() {} },
  });
  musicService = new MusicSelectionService({
    conversationStore: composition.conversationStore,
    playbackRuntime,
  });
  composition.runtime.initialize();
  try {
    const response = await composition.runtime.handleTurn({ sessionId: 'room', requestId: 'resume-1',
      userText: '继续播放', speak: false });
    assert.equal(modelCalls, 2, 'the normal agent and its bounded empty retry run before fallback');
    assert.equal(response.ok, true);
    assert.equal(response.displayText, '好，继续播放。');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'RESUME_REQUESTED');
    assert.equal(composition.conversationStore.db.prepare(
      'SELECT status FROM music_action_receipts WHERE request_id = ?').get('resume-1')?.status, 'committed');
    assert.equal(state.phase, 'playing');
    const replay = await composition.runtime.handleTurn({ sessionId: 'room', requestId: 'resume-1',
      userText: '继续播放', speak: false });
    assert.equal(replay.displayText, response.displayText);
    assert.equal(events.length, 1);
  } finally {
    composition.conversationStore.close();
    composition.registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
