// AmbientPresence 群聊一拍（add-companion-heartbeat D9；add-companion-expression-and-reception D1/D3）：
// 出声者先；心里有事的人（意图打分）文字跟，最多 1 位、同分按轮换；可以点名接话（A→B→A），每拍 ≤3 句。
// 真实 ConversationStore + PresentationService；runtime 换成按角色脚本决定说不说的替身。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { PresentationService } from '../virtual-person/PresentationService.js';
import { createAmbientPresence, revealDelayMs } from './AmbientPresence.js';

const MEMBERS = ['lunara', 'xiaoman', 'yehang', 'chenwu'];
const people = Object.fromEntries(MEMBERS.map(id => [id, { id, displayName: id, voiceProfileId: `voice-${id}` }]));
const tick = (over = {}) => Object.freeze({ id: 'ambient:room:lunara:1000', sessionId: 'room', personId: 'lunara',
  followerIds: Object.freeze(['xiaoman', 'yehang', 'chenwu']), reason: 'heartbeat', firedAtMs: 1000, modeRevision: 1,
  sinceLastWake: { completed: 0, skipped: 0 }, policy: { hint: '' }, signal: new AbortController().signal, ...over });

function harness({ script = {}, canSpeakAloud = () => true, isWakeCurrent = () => true, isVoiceHolder = () => true,
  onTurn = () => {}, activity = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-ambient-group-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  store.createRoom({ sessionId: 'room', memberIds: MEMBERS, hostId: 'lunara' });
  const published = [], synthesized = [], asked = [];
  const events = [];
  const runtime = {
    conversationStore: store,
    ...(activity ? { emitActivity: event => events.push(['activity', event.personId, event.state, event.correlationId]) } : {}),
    async handleAmbientTurn(input) {
      asked.push({ personId: input.personId, wake: input.wake, floor: input.floor, visibleBefore: store.listTurns('room', { visibleOnly: true }).length });
      onTurn(input);
      const raw = (Array.isArray(script[input.personId]) ? script[input.personId].shift() : script[input.personId]) || 'speak';
      const decide = typeof raw === 'object' ? 'speak' : raw;
      if (decide === 'quiet') return { action: 'quiet' };
      if (decide !== 'speak') return { action: 'silent', reason: decide };
      // 点名：和 presence_respond 一样只经 floor 登记，入账成功后才生效。
      if (raw.invite) assert.equal(input.floor.invite(raw.invite).ok, true, `${input.personId} → ${raw.invite}`);
      if (raw.then) return { action: 'silent', reason: raw.then };
      const turn = store.recordPresenceTurn({ sessionId: 'room', personId: input.personId,
        triggerKey: input.wake.id, kind: 'ambient', text: `${input.personId} 说了一句。` });
      const delivery = await input.deliver({ turn, entity: people[input.personId], isCurrent: input.isCurrent });
      return { action: 'speak', turn, entity: people[input.personId], delivery };
    },
  };
  const onWake = createAmbientPresence({
    runtime,
    presentationService: new PresentationService({
      synthesize: async ({ text, voiceProfileId }) => { synthesized.push({ text, voiceProfileId }); return { url: '/tts/a.mp3', source: 'tts' }; },
    }),
    queueService: { publishSnapshot: payload => { published.push(payload); events.push(['publish', payload.message.virtualPersonId]); } },
    sleep: async ms => { events.push(['sleep', ms]); },
    canSpeakAloud, isWakeCurrent, isVoiceHolder, logger: { warn() {} },
  });
  return { onWake, store, published, synthesized, asked, events,
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const due = (...ids) => ids.map((personId, index) => ({ noteId: `note:f${index}`, personId, about: '那首翻唱' }));

test('出声者先说并可能配语音；心里有事的跟话者只出文字', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.onWake(tick({ followups: due('xiaoman') })), { outcome: 'spoken', reason: 'delivered', lines: 2 });
    assert.deepEqual(h.asked.map(item => item.personId), ['lunara', 'xiaoman']);
    assert.deepEqual(h.synthesized.map(item => item.voiceProfileId), ['voice-lunara'], '只有出声者配语音');
    assert.equal(h.published.length, 2);
    assert.equal(h.published[1].overlayNarrations, undefined, '跟话不配语音');
    assert.equal(h.published[1].message.say, 'xiaoman 说了一句。');
    assert.ok(h.store.getSession('room').unreadAt, '跟话标未读');
    // 每人各用自己的唤醒 id 入账：幂等互不冲突，跟话的人知道自己是跟着说的。
    const [holder, follower] = h.asked.map(item => item.wake);
    assert.equal(holder.id, 'ambient:room:lunara:1000');
    assert.equal(follower.id, 'ambient:room:lunara:1000:xiaoman');
    assert.equal(follower.personId, 'xiaoman');
    assert.equal(follower.role, 'follower');
    assert.equal(holder.role, 'holder');
    assert.equal(follower.signal, holder.signal);
    assert.equal(h.asked[1].visibleBefore, 1, '后面的人能看到前面刚入账的话');
    assert.deepEqual(follower.followups.map(item => item.personId), ['xiaoman'], '跟话的人也拿到这一拍的 followup');
  } finally { h.close(); }
});

test('没人心里有事：只问出声者，不再「问一圈都安静」', async () => {
  const h = harness({ script: { lunara: 'quiet' } });
  try {
    assert.deepEqual(await h.onWake(tick()), { outcome: 'quiet', reason: 'quiet', lines: 0 });
    assert.deepEqual(h.asked.map(item => item.personId), ['lunara']);
  } finally { h.close(); }
  const one = harness({ script: { lunara: 'quiet' } });
  try {
    assert.deepEqual(await one.onWake(tick({ followups: due('yehang', 'chenwu') })), { outcome: 'text-only', reason: 'delivered', lines: 1 });
    assert.deepEqual(one.asked.map(item => item.personId), ['lunara', 'yehang'], '跟话最多 1 位');
  } finally { one.close(); }
});

test('被提到的人有意图：她上次开口之后有人叫了她的名字', async () => {
  const h = harness({ script: { lunara: 'quiet', chenwu: 'speak' } });
  try {
    h.store.recordPresenceTurn({ sessionId: 'room', personId: 'lunara', triggerKey: 'earlier', kind: 'ambient', text: 'chenwu 你也喜欢这版吧？' });
    await h.onWake(tick());
    assert.deepEqual(h.asked.map(item => item.personId), ['lunara', 'chenwu']);
  } finally { h.close(); }
});

test('同分按轮换：上一拍跟过话的人排到最后', async () => {
  const h = harness({ script: { lunara: 'quiet' } });
  try {
    await h.onWake(tick({ followups: due('xiaoman', 'chenwu') }));
    await h.onWake(tick({ id: 'ambient:room:lunara:2000', firedAtMs: 2000, followups: due('xiaoman', 'chenwu') }));
    assert.deepEqual(h.asked.map(item => item.personId), ['lunara', 'xiaoman', 'lunara', 'chenwu']);
  } finally { h.close(); }
});

test('A→B→A：出声者点名一位，被点名的人点回，之后停止；被点名的人不占跟话名额', async () => {
  const h = harness({ script: { lunara: [{ invite: 'yehang' }, 'speak'], yehang: { invite: 'lunara' } } });
  try {
    assert.deepEqual(await h.onWake(tick({ followups: due('xiaoman') })), { outcome: 'spoken', reason: 'delivered', lines: 3 });
    assert.deepEqual(h.asked.map(item => [item.personId, item.wake.role]),
      [['lunara', 'holder'], ['yehang', 'invited'], ['lunara', 'returned']], '第三句后到上限，跟话的人这拍不再问');
    const [, invited, back] = h.asked.map(item => item.wake);
    assert.equal(invited.id, 'ambient:room:lunara:1000:yehang');
    assert.equal(invited.invitedBy.personId, 'lunara');
    assert.equal(back.id, 'ambient:room:lunara:1000:lunara:r');
    assert.deepEqual(h.synthesized.map(item => item.voiceProfileId), ['voice-lunara'], '回传那句只出文字');
    assert.deepEqual(h.asked[2].floor.targets, [], 'A→B→A 后不能再点名');
  } finally { h.close(); }
});

test('邀请者这句没入账：邀请作废，被点名的人不跑', async () => {
  const h = harness({ script: { lunara: { invite: 'yehang', then: 'stale' } } });
  try {
    assert.deepEqual(await h.onWake(tick()), { outcome: 'silent', reason: 'stale', lines: 0 });
    assert.deepEqual(h.asked.map(item => item.personId), ['lunara']);
  } finally { h.close(); }
});

test('你开口、换听歌来源、改陪伴模式或心跳撤销：整拍结束，后面的人不再跑', async () => {
  // 回合里用户开口：账本里出现比这一拍更晚的用户回合。
  const listener = harness({ script: { lunara: 'speak' } });
  try {
    const original = listener.store.lastUserTurnAt.bind(listener.store);
    listener.store.lastUserTurnAt = sid => (listener.asked.length ? 1500 : original(sid));
    assert.deepEqual(await listener.onWake(tick()), { outcome: 'spoken', reason: 'delivered', lines: 1 });
    assert.deepEqual(listener.asked.map(item => item.personId), ['lunara']);
  } finally { listener.close(); }
  for (const reason of ['interrupted', 'turn-busy', 'stale']) {
    const h = harness({ script: { lunara: reason } });
    try {
      assert.deepEqual(await h.onWake(tick()), { outcome: 'silent', reason, lines: 0 });
      assert.equal(h.asked.length, 1, reason);
    } finally { h.close(); }
  }
  let current = true;
  const moved = harness({ isWakeCurrent: () => current, onTurn: () => { current = false; } });
  try {
    const result = await moved.onWake(tick());
    assert.equal(result.lines, 1);
    assert.deepEqual(moved.asked.map(item => item.personId), ['lunara']);
  } finally { moved.close(); }
  const controller = new AbortController();
  const aborted = harness({ onTurn: () => controller.abort() });
  try {
    await aborted.onWake(tick({ signal: controller.signal }));
    assert.deepEqual(aborted.asked.map(item => item.personId), ['lunara']);
  } finally { aborted.close(); }
});

test('一拍进行中主持人被改：出声者这句只出文字，不丢弃', async () => {
  const h = harness({ isVoiceHolder: () => false, script: { xiaoman: 'quiet', yehang: 'quiet' } });
  try {
    assert.deepEqual(await h.onWake(tick()), { outcome: 'text-only', reason: 'delivered', lines: 1 });
    assert.equal(h.published.length, 1);
    assert.deepEqual(h.synthesized, []);
  } finally { h.close(); }
});

test('单聊没有跟话的人：和原来一样只跑一轮', async () => {
  const h = harness();
  try {
    assert.deepEqual(await h.onWake(tick({ followerIds: Object.freeze([]) })), { outcome: 'spoken', reason: 'delivered', lines: 1 });
    assert.deepEqual(h.asked.map(item => item.personId), ['lunara']);
    assert.equal(h.asked[0].wake.id, 'ambient:room:lunara:1000');
  } finally { h.close(); }
});

test('正在输入：只出文字的那句先 composing、等 1–3 秒再揭示、最后 idle；出声的那句不延迟', async () => {
  const h = harness({ activity: true });
  try {
    await h.onWake(tick({ followups: due('xiaoman') }));
    const wakeId = 'ambient:room:lunara:1000:xiaoman';
    assert.deepEqual(h.events, [
      ['publish', 'lunara'],
      ['activity', 'xiaoman', 'composing', wakeId],
      ['sleep', revealDelayMs('xiaoman 说了一句。')],
      ['publish', 'xiaoman'],
      ['activity', 'xiaoman', 'idle', wakeId],
    ]);
  } finally { h.close(); }
  assert.equal(revealDelayMs(''), 1000);
  assert.equal(revealDelayMs('长'.repeat(200)), 3000);
});
