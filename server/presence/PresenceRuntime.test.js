// PresenceRuntime：生成 → 共享会话队列内重验并入账 → 交付（文字/语音门控）→ 未读。
// 真实 ConversationStore（临时库）+ 真实 SessionTurnQueue + 真实 PresentationService。
// Run: node --test server/presence/PresenceRuntime.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { PresentationService } from '../virtual-person/PresentationService.js';
import { SessionTurnQueue } from '../virtual-person/SessionTurnQueue.js';
import { PresenceRuntime } from './PresenceRuntime.js';

const LINE = '这首听完，房间好像安静了一点。';
const moment = (key = 'room/lunara/track_completed/q1:c1') => ({ kind: 'track_completed', sessionId: 'room', personId: 'lunara',
  triggerKey: key, evidence: { track: { provider: 'qq', songId: 's1', title: '晴天', artist: '周杰伦', queueItemId: 'q1' },
    consecutiveCompletions: 2 } });

function harness({ utterance, canSpeakAloud = () => true, synthesize, person = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-presence-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  store.createRoom({ sessionId: 'room', memberIds: ['lunara'], hostId: 'lunara' });
  const published = [], synthesized = [], tasks = [], traces = [];
  const queue = new SessionTurnQueue();
  const presentationService = new PresentationService({
    synthesize: synthesize || (async ({ text, voiceProfileId }) => { synthesized.push({ text, voiceProfileId }); return { url: '/tts/p.mp3', source: 'tts' }; }),
  });
  const runtime = new PresenceRuntime({
    conversationStore: store,
    registry: { get: id => (id === 'lunara' ? { id, displayName: 'Lunara', voiceProfileId: 'voice-l', personaDocument: '温柔', ...person } : null) },
    utterance: utterance || { generate: async task => { tasks.push(task); return { action: 'speak', text: LINE, evidenceRefs: ['moment', 'track'] }; } },
    presentationService,
    queueService: { publishSnapshot: payload => published.push(payload) },
    runExclusive: (sessionId, work) => queue.run(sessionId, work),
    canSpeakAloud, timeZone: 'Asia/Shanghai', now: () => Date.UTC(2026, 9, 19, 12, 0),
    trace: (sessionId, event) => traces.push({ sessionId, ...event }), logger: { warn() {} },
  });
  return { runtime, store, queue, published, synthesized, tasks, traces,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('speak: one ledger turn, chat bubble + overlay voice with the same turn id, unread marked', async () => {
  const h = harness();
  try {
    const result = await h.runtime.speak(moment());
    assert.equal(result.outcome, 'spoken');
    const [turn] = h.store.listTurns('room', { visibleOnly: true });
    assert.equal(turn.turnId, result.turnId);
    assert.equal(turn.visibleText, LINE);
    assert.deepEqual(turn.message.presence.sourceRefs, ['moment', 'track']);
    assert.equal(h.published.length, 1);
    const [payload] = h.published;
    assert.equal(payload.conversationId, 'room');
    assert.equal(payload.message.say, LINE);
    assert.equal(payload.message.presentation, 'presence');
    assert.equal(payload.message.sourceTurnId, turn.turnId);
    assert.equal(payload.overlayNarrations[0].sourceTurnId, turn.turnId);
    assert.equal(payload.overlayNarrations[0].voiceProfileId, 'voice-l');
    assert.deepEqual(h.synthesized, [{ text: LINE, voiceProfileId: 'voice-l' }]);
    assert.ok(h.store.getSession('room').unreadAt);
    assert.equal(h.tasks[0].evidence.find(item => item.ref === 'day_part').fact, '现在是当地的晚上。');
    assert.equal(JSON.stringify(h.traces).includes(LINE), false, 'trace 不落正文');
  } finally { h.close(); }
});

test('voice gate closed → text only: bubble published, nothing synthesized', async () => {
  const h = harness({ canSpeakAloud: () => false });
  try {
    assert.equal((await h.runtime.speak(moment())).outcome, 'text-only');
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].overlayNarrations, undefined);
    assert.equal(h.synthesized.length, 0);
  } finally { h.close(); }
});

test('silence / failure writes nothing and publishes nothing', async () => {
  for (const generate of [async () => ({ action: 'silence', reason: 'model-silence' }), async () => { throw new Error('x'); }]) {
    const h = harness({ utterance: { generate } });
    try {
      assert.equal((await h.runtime.speak(moment())).outcome, 'silent');
      assert.equal(h.store.listTurns('room').length, 0);
      assert.equal(h.published.length, 0);
      assert.equal(h.store.getSession('room').unreadAt, null);
    } finally { h.close(); }
  }
});

test('the user speaking during generation drops the line before it is committed', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness({ utterance: { generate: (task, { signal }) => new Promise(resolve => {
    started();
    signal.addEventListener('abort', () => resolve({ action: 'silence', reason: 'aborted' }), { once: true });
  }) } });
  try {
    const pending = h.runtime.speak(moment());
    await ready;
    assert.equal(h.runtime.interrupt('room'), true);
    assert.equal((await pending).outcome, 'silent');
    assert.equal(h.store.listTurns('room').length, 0);
    assert.equal(h.published.length, 0);
  } finally { h.close(); }
});

test('a running user turn holds the queue; interrupt while waiting means no commit', async () => {
  const h = harness();
  try {
    let releaseUser;
    const userTurn = h.queue.run('room', () => new Promise(resolve => { releaseUser = resolve; }));
    await new Promise(resolve => setImmediate(resolve));
    const pending = h.runtime.speak(moment());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.store.listTurns('room').length, 0, '用户回合进行中不入账');
    h.runtime.interrupt('room');
    releaseUser();
    await userTurn;
    assert.equal((await pending).reason, 'interrupted');
    assert.equal(h.store.listTurns('room').length, 0);
  } finally { h.close(); }
});

test('stale moment (listening session changed) and replayed trigger never commit twice', async () => {
  const h = harness();
  try {
    assert.equal((await h.runtime.speak(moment(), { isCurrent: () => false })).reason, 'stale');
    assert.equal(h.store.listTurns('room').length, 0);
    assert.equal((await h.runtime.speak(moment())).outcome, 'spoken');
    assert.equal((await h.runtime.speak(moment())).reason, 'stale', '同一触发重放：已入账，不再交付');
    assert.equal(h.store.listTurns('room').length, 1);
    assert.equal(h.published.length, 1);
  } finally { h.close(); }
});

test('a non-member or deleted room never gets a line', async () => {
  const h = harness();
  try {
    assert.equal((await h.runtime.speak({ ...moment(), personId: 'stranger' })).reason, 'no-speaker');
    h.store.deleteRoom('room');
    assert.equal((await h.runtime.speak(moment('k2'))).reason, 'no-speaker');
    assert.equal(h.published.length, 0);
  } finally { h.close(); }
});

test('no hook means no model call: a bare boundary with nothing to say stays silent', async () => {
  const h = harness();
  try {
    const bare = { kind: 'boundary_without_intro', sessionId: 'room', personId: 'lunara', triggerKey: 'room/lunara/b/q2:c1',
      evidence: { track: { provider: 'qq', songId: 's2', title: '黑色幽默', artist: '周杰伦', queueItemId: 'q2', requestId: null } } };
    const result = await h.runtime.speak(bare);
    assert.deepEqual([result.outcome, result.reason], ['silent', 'no-hook']);
    assert.equal(h.tasks.length, 0, '模型调用次数为 0');
    assert.equal(h.store.listTurns('room').length, 0);
  } finally { h.close(); }
});

test('she knows why the song is playing: the queuing exchange reaches the brief, and sources trace back to the ledger', async () => {
  const h = harness({
    person: { metadata: { presence: { temperament: 'quiet', style: '话少，偶尔冷幽默' } } },
    utterance: { generate: async task => { h.tasks.push(task); return { action: 'speak', text: '照你说的，先来首不吵的。', evidenceRefs: ['pick_reason', 'track'] }; } },
  });
  try {
    h.store.beginRequest({ sessionId: 'room', requestId: 'req-7', virtualPersonId: 'lunara', userText: '下午有点困，来点别太吵的' });
    h.store.completeRequest({ requestId: 'req-7', virtualPersonId: 'lunara', message: { role: 'assistant', content: '好，挑了几首松一点的。' } });
    const boundary = { kind: 'boundary_without_intro', sessionId: 'room', personId: 'lunara', triggerKey: 'room/lunara/b/q2:c9',
      evidence: { track: { provider: 'qq', songId: 's2', title: '黑色幽默', artist: '周杰伦', queueItemId: 'q2', requestId: 'req-7',
        origin: 'her_pick_for_request' } } };
    const policy = { id: 'quiet', hooks: 'strong', hint: '你话不多：没有真想说的就不说，开口也很短。' };
    const result = await h.runtime.speak(boundary, { policy });
    assert.equal(result.outcome, 'spoken');
    const [task] = h.tasks;
    assert.equal(task.evidence.find(item => item.ref === 'pick_reason').listenerSaid, '下午有点困，来点别太吵的');
    assert.deepEqual(task.yourWay, { hint: policy.hint, style: '话少，偶尔冷幽默' });
    const turn = h.store.listTurns('room', { visibleOnly: true }).find(item => item.message.presentation === 'presence');
    assert.deepEqual(turn.message.presence.sourceRefs, ['pick:req-7', 'track']);
    assert.equal(JSON.stringify(h.traces).includes('下午有点困'), false, 'trace 不落聊天原文');
  } finally { h.close(); }
});
