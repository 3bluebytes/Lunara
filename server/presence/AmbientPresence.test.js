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
