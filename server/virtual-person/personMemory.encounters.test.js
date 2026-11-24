// personMemory.encounters.test.js — 跨聊天摘录的范围（scope-cross-chat-excerpts）。
//
// Run: node --test server/virtual-person/personMemory.encounters.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from './ConversationStore.js';
import { retrievePersonMemories } from './personMemory.js';

function withStore(run, { now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-encounters-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db'), ...(now ? { now } : {}) }).initialize();
  let requestNumber = 0;
  const say = (sessionId, userText, personId = 'lunara') => {
    const requestId = `r${++requestNumber}`;
    // 与运行时一致：先开一轮（全体成员观察用户消息），再由答话的角色开请求。
    const round = store.beginRound({ sessionId, roundId: requestId, userText, responsePlan: [personId] });
    const { turn } = store.beginRequest({ sessionId, requestId, virtualPersonId: personId, userText, userTurnId: round.userTurnId });
    store.completeRequest({ requestId, virtualPersonId: personId, message: { content: '嗯。' } });
    return turn.turnId;
  };
  const excerpts = (sessionId, memberIds = ['lunara'], personId = 'lunara') => retrievePersonMemories(null, store, {
    namespace: `person:${personId}`, virtualPersonId: personId, sessionId, query: '', memberIds, isGroup: memberIds.length > 1 })
    .filter(row => row.kind === 'encounter').map(row => row.content).join('\n');
  return Promise.resolve(run({ store, say, excerpts })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test('一对一说的话进别的一对一，也进群聊：带不带出来由伙伴自己拿捏', async () => {
  await withStore(({ store, say, excerpts }) => {
    store.createRoom({ sessionId: 'c1', memberIds: ['lunara'] });
    store.createRoom({ sessionId: 'g1', memberIds: ['lunara', 'night'] });
    store.createRoom({ sessionId: 'g2', memberIds: ['lunara', 'night'] });
    say('c1', '我下周去马德里出差');
    say('g1', '这周末一起去露营吧');
    assert.match(excerpts('c2'), /马德里出差[\s\S]*露营/);
    const group = excerpts('g2', ['lunara', 'night']);
    assert.match(group, /马德里出差[\s\S]*露营/);
  });
});

test('同一毫秒里不同聊天说的话按实际先后排，不按各聊天自己的序号排', async () => {
  // 每个聊天的 sequence 各自从 1 计数，跨聊天不可比；时间戳打平时要按真实写入先后。
  await withStore(({ store, say, excerpts }) => {
    store.createRoom({ sessionId: 'c1', memberIds: ['lunara'] });
    store.createRoom({ sessionId: 'c3', memberIds: ['lunara'] });
    say('c1', '先随便聊一句');
    say('c1', '我下周去马德里出差');
    say('c3', '这周末一起去露营吧');
    assert.match(excerpts('c2'), /随便聊一句[\s\S]*马德里出差[\s\S]*露营/);
  }, { now: () => 1_700_000_000_000 });
});

test('反思判为敏感的来源照常进别的聊天，但标成比较私人的事', async () => {
  await withStore(({ store, say, excerpts }) => {
    store.createRoom({ sessionId: 'c1', memberIds: ['lunara'] });
    const turnId = say('c1', '下周三我要去医院复查');
    say('c1', '我最近在学吉他');
    assert.match(excerpts('c2'), /医院复查/);
    assert.equal(store.notes.acceptOpenLoop({ personId: 'lunara', sessionId: 'c1', batchTag: 'b', text: '复查',
      sourceTurnIds: [turnId], sensitive: true }), true);
    const after = excerpts('c2');
    assert.match(after, /医院复查[^\n]*比较私人的事/);
    assert.match(after, /学吉他/);
    assert.equal(store.canReadTurn('lunara', store.getTurn(turnId)), true);
  });
});

test('聊得很多的聊天不把别的聊天刚提的事挤掉；只有一个其他聊天时仍带满 8 条', async () => {
  await withStore(({ store, say, excerpts }) => {
    store.createRoom({ sessionId: 'c1', memberIds: ['lunara'] });
    store.createRoom({ sessionId: 'c3', memberIds: ['lunara'] });
    say('c1', '我下周去马德里出差');
    for (let i = 0; i < 20; i += 1) say('c3', `闲聊第${i}句`);
    const text = excerpts('c2');
    assert.match(text, /马德里出差/);
    assert.equal(text.split('\n').length, 8);
    assert.match(text, /闲聊第19句/);
    const onlyC3 = excerpts('c1');
    assert.equal(onlyC3.split('\n').length, 8);
    assert.ok(onlyC3.split('\n').every(line => /闲聊|嗯/.test(line)));
  });
});

test('后来才被拉进那个聊天的成员没经历过拉人之前的话：它的摘录里没有，当时在场的伙伴照常记得', async () => {
  await withStore(({ store, say, excerpts }) => {
    store.createRoom({ sessionId: 'c1', memberIds: ['lunara'] });
    say('c1', '我在偷偷准备跳槽');
    store.addMember('c1', 'night');
    say('c1', '周末一起去露营吧');
    assert.match(excerpts('g2', ['lunara', 'night']), /跳槽[\s\S]*露营/);
    const late = excerpts('g2', ['lunara', 'night'], 'night');
    assert.doesNotMatch(late, /跳槽/);
    assert.match(late, /露营/);
  });
});

test('跨聊天摘录不带串词：串词是放歌时的独白，不是交流；也不占每个聊天的名额', async () => {
  await withStore(({ store, say, excerpts }) => {
    store.createRoom({ sessionId: 'old', memberIds: ['lunara'], hostId: 'lunara' });
    store.createRoom({ sessionId: 'now', memberIds: ['lunara'], hostId: 'lunara' });
    say('old', '我想一个人去世界各地走走');
    for (let index = 0; index < 12; index += 1) {
      store.recordTrackIntro({ sessionId: 'old', personId: 'lunara', correlationId: `c${index}`, queueItemId: `q${index}`,
        text: `第 ${index} 首，不急，让它自己慢慢走。`, track: { songId: String(index), title: `歌${index}`, artist: '某人', source: 'qq' } });
    }
    const text = excerpts('now');
    assert.doesNotMatch(text, /慢慢走/u);
    assert.match(text, /世界各地走走/u, '串词再多也不把聊天里说过的话挤掉');
    assert.equal(store.recentEncounters('lunara', { excludeSessionId: 'now', perSession: 8 })
      .filter(turn => turn.message?.presentation === 'track_intro').length, 8, '不传选项时存储层行为不变');
  });
});
