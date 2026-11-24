// AmbientPresence：心跳 onWake → runtime.handleAmbientTurn → 共享交付（文字/语音门控、未读）
// → 心跳认识的结果形状（add-companion-heartbeat 3.7）。
// 真实 ConversationStore + PresentationService；runtime 换成只负责入账并调用 deliver 的替身。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { PresentationService } from '../virtual-person/PresentationService.js';
import { createAmbientPresence } from './AmbientPresence.js';

const LINE = '加班到这么晚，累坏了吧。';
const wake = { id: 'ambient:room:lunara:1', sessionId: 'room', personId: 'lunara', reason: 'heartbeat', firedAtMs: 1,
  sinceLastWake: { completed: 0, skipped: 0 }, policy: { hint: '' }, signal: new AbortController().signal };
const person = { id: 'lunara', displayName: 'Lunara', voiceProfileId: 'voice-l' };

function harness({ decide = 'speak', canSpeakAloud = () => true, current = () => true, userSpokeBeforeDelivery = false,
  extra = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-ambient-presence-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
  const published = [], synthesized = [], received = [];
  const runtime = {
    conversationStore: store,
    async handleAmbientTurn(input) {
      received.push(input);
      if (decide === 'throw') throw new Error('boom');
      if (decide === 'quiet') return { action: 'quiet' };
      if (decide !== 'speak') return { action: 'silent', reason: decide };
      const turn = store.recordPresenceTurn({ sessionId: input.sessionId, personId: input.personId,
        triggerKey: input.wake.id, kind: 'ambient', text: LINE, extra });
      const current = () => !userSpokeBeforeDelivery && input.isCurrent();
      const delivery = await input.deliver({ turn, entity: person, isCurrent: current });
      return { action: 'speak', turn, entity: person, delivery };
    },
  };
  const onWake = createAmbientPresence({
    runtime,
    presentationService: new PresentationService({
      synthesize: async ({ text, voiceProfileId }) => { synthesized.push({ text, voiceProfileId }); return { url: '/tts/a.mp3', source: 'tts' }; },
    }),
    queueService: { publishSnapshot: payload => published.push(payload) },
    canSpeakAloud, isWakeCurrent: current, logger: { warn() {} },
  });
  return { onWake, store, published, synthesized, received,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('开口：入账的那一行进聊天气泡并配语音，标未读；心跳拿到 spoken', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.onWake(wake), { outcome: 'spoken', reason: 'delivered', lines: 1 });
    const [turn] = h.store.listTurns('room', { visibleOnly: true });
    const [payload] = h.published;
    assert.equal(payload.conversationId, 'room');
    assert.equal(payload.message.say, LINE);
    assert.equal(payload.message.presentation, 'presence');
    assert.equal(payload.message.sourceTurnId, turn.turnId);
    assert.equal(payload.overlayNarrations[0].sourceTurnId, turn.turnId);
    assert.deepEqual(h.synthesized, [{ text: LINE, voiceProfileId: 'voice-l' }]);
    assert.ok(h.store.getSession('room').unreadAt);
    assert.equal(h.received[0].wake.id, wake.id);
    assert.equal(h.received[0].wake.signal, wake.signal);
    assert.equal(h.received[0].personId, 'lunara');
  } finally { h.close(); }
});

test('语音门控关闭或交付前用户开口：只出文字，不合成', async () => {
  for (const options of [{ canSpeakAloud: () => false }, { userSpokeBeforeDelivery: true }]) {
    const h = harness(options);
    try {
      assert.deepEqual(await h.onWake(wake), { outcome: 'text-only', reason: 'delivered', lines: 1 });
      assert.equal(h.published.length, 1);
      assert.equal(h.published[0].overlayNarrations, undefined);
      assert.deepEqual(h.synthesized, []);
    } finally { h.close(); }
  }
});

test('听歌来源或陪伴模式变了就不算当前：按这次唤醒判断，isCurrent 透传给运行时', async () => {
  let snapshot = { activeListeningSessionId: 'room', modeRevision: 3 };
  const seen = [];
  const h = harness({ current: w => { seen.push(w); return snapshot.activeListeningSessionId === w.sessionId
    && snapshot.modeRevision === w.modeRevision; } });
  try {
    await h.onWake({ ...wake, modeRevision: 3 });
    assert.equal(h.received[0].isCurrent(), true);
    snapshot = { ...snapshot, modeRevision: 4 };
    assert.equal(h.received[0].isCurrent(), false, '模式 revision 变了');
    snapshot = { activeListeningSessionId: 'other', modeRevision: 3 };
    assert.equal(h.received[0].isCurrent(), false, '换了听歌来源');
    assert.equal(seen[0].id, wake.id);
  } finally { h.close(); }
});

test('安静、沉默与失败映射成心跳的结果形状，什么都不发布', async () => {
  for (const [decide, expected] of [
    ['quiet', { outcome: 'quiet', reason: 'quiet', lines: 0 }],
    ['stale', { outcome: 'silent', reason: 'stale', lines: 0 }],
    ['interrupted', { outcome: 'silent', reason: 'interrupted', lines: 0 }],
    ['throw', { outcome: 'silent', reason: 'error', lines: 0 }],
  ]) {
    const h = harness({ decide });
    try {
      assert.deepEqual(await h.onWake(wake), expected, decide);
      assert.equal(h.published.length, 0);
    } finally { h.close(); }
  }
});

test('带推荐的一句：实时下发的消息带推荐卡片（不含内部 selection），确认凭 turnId', async () => {
  const h = harness({ extra: { musicRecommendation: { selectionId: 'selection:x', provider: 'qq', songId: '42', title: '晚风',
    artist: '陈婧霏', recommendedBy: 'lunara', status: 'pending', expiresAt: 99 } } });
  try {
    await h.onWake(wake);
    const [payload] = h.published;
    assert.deepEqual(payload.message.musicRecommendation, { provider: 'qq', songId: '42', title: '晚风', artist: '陈婧霏',
      recommendedBy: 'lunara', status: 'pending', expiresAt: 99 });
    assert.ok(payload.message.turnId);
  } finally { h.close(); }
});

test('silent multi-beat presence turn publishes beats, beatProgress and missing voice metadata without TTS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-ambient-beats-silent-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara', interactionMode: 'roleplay' });
  const published = [], synthesized = [];
  const beats = [
    { index: 0, action: '垂眼看了看桌角', say: '刚才说到一半就没声了。', pauseAfterMs: 650 },
    { index: 1, say: '忙完了再跟我说。', pauseAfterMs: 0 },
  ];
  const onWake = createAmbientPresence({
    runtime: {
      conversationStore: store,
      async handleAmbientTurn(input) {
        const turn = store.recordPresenceTurn({
          sessionId: input.sessionId,
          personId: input.personId,
          triggerKey: input.wake.id,
          kind: 'ambient',
          text: '（垂眼看了看桌角）\n刚才说到一半就没声了。\n\n忙完了再跟我说。',
          extra: { beats },
        });
        const delivery = await input.deliver({ turn, entity: person, isCurrent: input.isCurrent });
        return { action: 'speak', turn, entity: person, delivery };
      },
    },
    presentationService: new PresentationService({
      synthesize: async input => { synthesized.push(input); return { url: '/tts/never.mp3' }; },
    }),
    queueService: { publishSnapshot: payload => published.push(payload) },
    canSpeakAloud: () => false,
    isWakeCurrent: () => true,
    logger: { warn() {} },
  });
  try {
    const res = await onWake({ ...wake, id: 'app_open:room:100', reason: 'app_open' });
    assert.deepEqual(res, { outcome: 'text-only', reason: 'delivered', lines: 1 });
    assert.equal(synthesized.length, 0);
    assert.equal(published.length, 1);
    const [payload] = published;
    assert.equal(payload.overlayNarrations, undefined);
    assert.equal(payload.message.beats.length, 2);
    assert.deepEqual(payload.message.beatProgress, { deliveredCount: 2, totalCount: 2, done: true });
    assert.deepEqual(payload.message.voice, {
      canSynthesize: true,
      status: 'missing',
      url: null,
      audioUrl: null,
      durationMs: null,
      beats: [
        { index: 0, canSynthesize: true, status: 'missing', audioUrl: null, durationMs: null },
        { index: 1, canSynthesize: true, status: 'missing', audioUrl: null, durationMs: null },
      ],
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('voiced multi-beat presence turn synthesizes each beat with performance and emits turn ducking lease overlays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-ambient-beats-voiced-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
  const published = [], synthesized = [];
  const beats = [
    { index: 0, say: '这首刚起调就蛮亮。', voice: { pace: 'slow', direction: '声音放轻' }, pauseAfterMs: 700 },
    { index: 1, say: '你正好能歇一口气。', pauseAfterMs: 0 },
  ];
  const onWake = createAmbientPresence({
    runtime: {
      conversationStore: store,
      async handleAmbientTurn(input) {
        const turn = store.recordPresenceTurn({
          sessionId: input.sessionId,
          personId: input.personId,
          triggerKey: input.wake.id,
          kind: 'ambient',
          text: '这首刚起调就蛮亮。\n\n你正好能歇一口气。',
          extra: { beats },
        });
        const delivery = await input.deliver({ turn, entity: person, isCurrent: input.isCurrent });
        return { action: 'speak', turn, entity: person, delivery };
      },
    },
    presentationService: new PresentationService({
      synthesize: async input => {
        synthesized.push(input);
        const n = synthesized.length;
        return { url: `/tts/beat${n}.mp3`, hash: `beat${n}`, durationMs: 1200, source: 'tts' };
      },
    }),
    queueService: { publishSnapshot: payload => published.push(payload) },
    canSpeakAloud: () => true,
    isWakeCurrent: () => true,
    logger: { warn() {} },
  });
  try {
    const res = await onWake(wake);
    assert.deepEqual(res, { outcome: 'spoken', reason: 'delivered', lines: 1 });
    assert.equal(synthesized.length, 2);
    assert.deepEqual(synthesized[0].performance, { pace: 'slow', direction: '声音放轻' });
    assert.equal(synthesized[1].performance, undefined);
    const [payload] = published;
    assert.equal(payload.overlayNarrations.length, 2);
    assert.equal(payload.overlayNarrations[0].turnDuckLeaseId, payload.message.turnId);
    assert.equal(payload.overlayNarrations[0].holdDuckLease, true);
    assert.equal(payload.overlayNarrations[0].delayBeforeMs, 0);
    assert.equal(payload.overlayNarrations[1].holdDuckLease, false);
    assert.equal(payload.overlayNarrations[1].delayBeforeMs, 700);
    assert.equal(payload.message.voice.status, 'ready');
    assert.equal(payload.message.voice.audioUrl, '/tts/beat1.mp3');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('multi-beat presence turn recomputes overlay lease when trailing beat is silent or fails synthesis', async () => {
  for (const mode of ['trailing-silent', 'trailing-synth-null']) {
    const dir = mkdtempSync(join(tmpdir(), `lunara-ambient-beats-${mode}-`));
    const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
    store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
    const published = [];
    const beats = mode === 'trailing-silent'
      ? [
        { index: 0, say: '这一句能念出来。', pauseAfterMs: 500 },
        { index: 1, say: '……', spoken: '{叹气}', pauseAfterMs: 0 },
      ]
      : [
        { index: 0, say: '第一句成功了。', pauseAfterMs: 500 },
        { index: 1, say: '第二句合成失败。', pauseAfterMs: 0 },
      ];
    let synthIdx = 0;
    const onWake = createAmbientPresence({
      runtime: {
        conversationStore: store,
        async handleAmbientTurn(input) {
          const turn = store.recordPresenceTurn({
            sessionId: input.sessionId,
            personId: input.personId,
            triggerKey: `${input.wake.id}:${mode}`,
            kind: 'ambient',
            text: beats.map(b => b.say).join('\n\n'),
            extra: { beats },
          });
          const delivery = await input.deliver({ turn, entity: person, isCurrent: input.isCurrent });
          return { action: 'speak', turn, entity: person, delivery };
        },
      },
      presentationService: new PresentationService({
        synthesize: async () => {
          synthIdx += 1;
          if (mode === 'trailing-synth-null' && synthIdx === 2) return null;
          return { url: `/tts/${mode}_${synthIdx}.mp3`, hash: `${mode}_${synthIdx}`, durationMs: 800, source: 'tts' };
        },
      }),
      queueService: { publishSnapshot: payload => published.push(payload) },
      canSpeakAloud: () => true,
      isWakeCurrent: () => true,
      logger: { warn() {} },
    });
    try {
      const res = await onWake({ ...wake, id: `ambient:${mode}` });
      assert.deepEqual(res, { outcome: 'spoken', reason: 'delivered', lines: 1 });
      const [payload] = published;
      assert.equal(payload.overlayNarrations.length, 1);
      assert.equal(payload.overlayNarrations[0].beatCount, 1);
      assert.equal(payload.overlayNarrations[0].isLastBeat, true);
      assert.equal(payload.overlayNarrations[0].holdDuckLease, false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
