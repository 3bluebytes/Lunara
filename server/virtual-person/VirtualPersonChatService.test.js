import assert from 'node:assert/strict';
import test from 'node:test';
import { VirtualPersonChatService } from './VirtualPersonChatService.js';

function presentation({ speak = true } = {}) {
  return {
    displayText: '我记得你刚才说今天很累。',
    spokenText: speak ? '我记得你刚才说今天很累。' : '',
    speak,
    virtualPersonId: 'lunara',
    voiceProfileId: 'warm',
    mood: 'gentle',
    sourceTurnId: 'turn-2',
    correlationId: 'request-2',
  };
}

test('compatibility adapter delivers one approved envelope and publishes the current PWA shape', async () => {
  const delivered = [];
  const published = [];
  const service = new VirtualPersonChatService({
    runtime: {
      async handleTurn(input) {
        assert.equal(input.sessionId, 'listener-1');
        assert.equal(input.userText, '你还记得吗？');
        return {
          ok: true,
          requestId: 'request-2',
          sessionId: 'listener-1',
          virtualPersonId: 'lunara',
          presentation: presentation(),
        };
      },
    },
    presentationService: {
      async deliver(envelope) {
        delivered.push(envelope);
        return { envelope, audio: { url: '/tts/reply.mp3', source: 'test' } };
      },
    },
    queueService: { publishSnapshot(payload) { published.push(payload); } },
  });

  const response = await service.handleChat({
    message: '你还记得吗？', sessionId: 'listener-1', requestId: 'request-2',
  });

  assert.equal(delivered.length, 1);
  assert.equal(published.length, 1);
  assert.equal(published[0].sessionId, 'listener-1');
  assert.equal(published[0].message.say, '我记得你刚才说今天很累。');
  assert.equal(published[0].overlayNarrations[0].text, '我记得你刚才说今天很累。');
  assert.equal(response.narration, 1);
  assert.equal(response.tracks, 0);
});

test('safe failure remains visible but is never synthesized', async () => {
  let synthesized = false;
  const published = [];
  const service = new VirtualPersonChatService({
    runtime: {
      async handleTurn() {
        return {
          ok: false,
          code: 'VIRTUAL_PERSON_TURN_FAILED',
          errorId: 'err-safe',
          requestId: 'request-1',
          sessionId: 'conversation:primary',
          virtualPersonId: 'lunara',
          presentation: presentation({ speak: false }),
        };
      },
    },
    presentationService: {
      async deliver(envelope) {
        synthesized = true;
        assert.equal(envelope.speak, false);
        return { envelope, audio: null };
      },
    },
    queueService: { publishSnapshot(payload) { published.push(payload); } },
  });

  const response = await service.handleChat({ message: '你好' });
  assert.equal(synthesized, true);
  assert.equal(published[0].overlayNarrations, undefined);
  assert.equal(response.narration, 0);
  assert.equal(response.ok, false);
});

test('an HTTP retry cannot present or synthesize the same committed turn twice', async () => {
  let claimed = false;
  let deliveries = 0;
  let publications = 0;
  const response = {
    ok: true,
    requestId: 'same-request',
    sessionId: 'conversation:primary',
    virtualPersonId: 'lunara',
    presentation: presentation(),
  };
  const service = new VirtualPersonChatService({
    runtime: {
      handleTurn: async () => response,
      claimPresentation() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      completePresentation() {},
    },
    presentationService: {
      async deliver(envelope) {
        deliveries += 1;
        return { envelope, audio: { url: '/tts/once.mp3' } };
      },
    },
    queueService: { publishSnapshot() { publications += 1; } },
  });

  const first = await service.handleChat({ message: '你好', requestId: 'same-request' });
  const replay = await service.handleChat({ message: '你好', requestId: 'same-request' });
  assert.equal(first.narration, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.narration, 0);
  assert.equal(deliveries, 1);
  assert.equal(publications, 1);
});

test('a failed presentation publish releases the lease so a retry can deliver', async () => {
  let state = 'pending';
  let publications = 0;
  const response = {
    ok: true,
    requestId: 'retry-presentation',
    sessionId: 'conversation:primary',
    virtualPersonId: 'lunara',
    presentation: presentation(),
  };
  const service = new VirtualPersonChatService({
    runtime: {
      handleTurn: async () => response,
      claimPresentation() {
        if (state !== 'pending') return false;
        state = 'delivering';
        return true;
      },
      completePresentation() { state = 'delivered'; },
      releasePresentation() { state = 'pending'; },
    },
    presentationService: {
      async deliver(envelope) { return { envelope, audio: null }; },
    },
    queueService: {
      publishSnapshot() {
        publications += 1;
        if (publications === 1) throw new Error('temporary websocket failure');
      },
    },
  });

  await assert.rejects(() => service.handleChat({ message: '你好' }), /temporary websocket failure/);
  assert.equal(state, 'pending');
  const retried = await service.handleChat({ message: '你好' });
  assert.equal(retried.ok, true);
  assert.equal(state, 'delivered');
  assert.equal(publications, 2);
});

test('an early-committed group response is published before the round ends and never twice', async () => {
  const published = [];
  const claimed = new Set();
  const item = (id, personId, text) => ({ ok: true, requestId: id, sessionId: 'room', virtualPersonId: personId,
    sourceTurnId: `turn-${id}`, displayText: text,
    presentation: { ...presentation(), displayText: text, spokenText: text, virtualPersonId: personId, sourceTurnId: `turn-${id}` } });
  const first = { ...item('r1:a', 'lunara', '这个让 Mio 来。'),
    hostSuggestion: { toPersonId: 'mio', reasonKind: 'listener_request', evidenceRefs: ['turn:u1'], status: 'pending' } };
  const second = { ...item('floor:r1:mio', 'mio', '现场版更松。'),
    groupFloor: { role: 'invited', fromPersonId: 'lunara', replyToTurnId: 'turn-r1:a', declined: false } };
  let publishedBeforeSecond = null;
  const service = new VirtualPersonChatService({
    runtime: {
      async handleTurn(input) {
        input.onResponseCommitted(first, { roundId: 'r1' });
        await new Promise(resolve => setTimeout(resolve, 5));
        publishedBeforeSecond = published.length;
        return { ...first, requestId: 'r1', roundId: 'r1', responses: [first, second], partial: false,
          floor: { fromPersonId: 'lunara', toPersonId: 'mio', status: 'answered' } };
      },
      claimPresentation: id => (claimed.has(id) ? false : (claimed.add(id), true)),
      completePresentation() {},
      isPresentationCurrent: () => true,
    },
    presentationService: { async deliver(envelope) { return { envelope, audio: { url: `/tts/${envelope.sourceTurnId}.mp3` } }; } },
    queueService: { publishSnapshot(payload) { published.push(payload); } },
  });

  const response = await service.handleChat({ message: '来点歌', sessionId: 'room', requestId: 'r1' });
  assert.equal(publishedBeforeSecond, 1);
  assert.equal(published.length, 2);
  assert.equal(published[0].message.say, '这个让 Mio 来。');
  assert.equal(published[1].message.say, '现场版更松。');
  assert.deepEqual(published[1].message.groupFloor, second.groupFloor);
  assert.deepEqual(published[0].message.hostSuggestion, first.hostSuggestion, '实时交付也带主持建议');
  assert.equal(published[1].message.hostSuggestion, undefined);
  assert.equal(published[1].messages, undefined);
  assert.equal(response.narration, 2);
  assert.equal(response.replayed, undefined);
  assert.deepEqual(response.floor, { fromPersonId: 'lunara', toPersonId: 'mio', status: 'answered' });
});

test('multi-beat radio reply seals duck lease when trailing beat is silent or fails synthesis', async () => {
  // 1) Trailing beat has no speakable content (e.g. spoken="{叹气}", say="……"):
  //    beat 0 immediately emits isLastBeat=true, holdDuckLease=false, and final snapshot has beatProgress.done=true.
  const silentTailPublished = [];
  const silentTailService = new VirtualPersonChatService({
    runtime: {
      isPresentationCurrent: () => true,
      async handleTurn() {
        return {
          ok: true,
          requestId: 'req-silent-tail',
          sessionId: 'room-beats',
          roundId: 'round-silent-tail',
          virtualPersonId: 'lunara',
          presentation: {
            displayText: '第一句能开口。\n\n……',
            spokenText: '第一句能开口。',
            speak: true,
            virtualPersonId: 'lunara',
            voiceProfileId: 'v1',
            sourceTurnId: 'turn-silent-tail',
            correlationId: 'req-silent-tail',
            expiresAt: Date.now() + 60_000,
            beats: [
              { index: 0, say: '第一句能开口。', pauseAfterMs: 500 },
              { index: 1, say: '……', spoken: '{叹气}', pauseAfterMs: 0 },
            ],
          },
        };
      },
    },
    presentationService: {
      async synthesize() { return { url: '/tts/b0.mp3', hash: 'b0', durationMs: 500 }; },
      async deliver(envelope) { return { envelope, audio: null }; },
    },
    queueService: { publishSnapshot: payload => silentTailPublished.push(payload) },
  });

  await silentTailService.handleChat({ sessionId: 'room-beats', requestId: 'req-silent-tail', message: '继续' });
  assert.equal(silentTailPublished.length, 2);
  assert.equal(silentTailPublished[0].overlayNarrations[0].isLastBeat, true);
  assert.equal(silentTailPublished[0].overlayNarrations[0].holdDuckLease, false);
  assert.deepEqual(silentTailPublished[1].message.beatProgress, { deliveredCount: 2, totalCount: 2, done: true });
  assert.equal(silentTailPublished[1].overlayNarrations, undefined);

  // 2) Trailing speakable beat fails synthesis at runtime (returns null):
  //    beat 0 had holdDuckLease=true, and final snapshot still emits beatProgress.done=true so client seals turn duck lease.
  const failedTailPublished = [];
  let callIndex = 0;
  const failedTailService = new VirtualPersonChatService({
    runtime: {
      isPresentationCurrent: () => true,
      async handleTurn() {
        return {
          ok: true,
          requestId: 'req-fail-tail',
          sessionId: 'room-beats',
          roundId: 'round-fail-tail',
          virtualPersonId: 'lunara',
          presentation: {
            displayText: '第一句正常。\n\n第二句失败。',
            spokenText: '第一句正常。 第二句失败。',
            speak: true,
            virtualPersonId: 'lunara',
            voiceProfileId: 'v1',
            sourceTurnId: 'turn-fail-tail',
            correlationId: 'req-fail-tail',
            expiresAt: Date.now() + 60_000,
            beats: [
              { index: 0, say: '第一句正常。', pauseAfterMs: 500 },
              { index: 1, say: '第二句失败。', pauseAfterMs: 0 },
            ],
          },
        };
      },
    },
    presentationService: {
      async synthesize() {
        callIndex += 1;
        return callIndex === 1 ? { url: '/tts/f0.mp3', hash: 'f0', durationMs: 500 } : null;
      },
      async deliver(envelope) { return { envelope, audio: null }; },
    },
    queueService: { publishSnapshot: payload => failedTailPublished.push(payload) },
  });

  await failedTailService.handleChat({ sessionId: 'room-beats', requestId: 'req-fail-tail', message: '继续' });
  assert.equal(failedTailPublished.length, 2);
  assert.equal(failedTailPublished[0].overlayNarrations[0].holdDuckLease, true);
  assert.equal(failedTailPublished[1].overlayNarrations, undefined);
  assert.deepEqual(failedTailPublished[1].message.beatProgress, { deliveredCount: 2, totalCount: 2, done: true });
});
