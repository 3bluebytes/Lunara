// ConversationStore.forkPrivacy.test.js — 分叉副本与离群成员不绕过反思与敏感标签（harden-memory-forks-and-schedules）。
//
// Run: node --test server/virtual-person/ConversationStore.forkPrivacy.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from './ConversationStore.js';
import { ReflectionObservationStore } from '../station/ReflectionObservationStore.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'r5a-fork-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  store.createRoom({ sessionId: 's1', memberIds: ['lunara'] });
  const say = (sid, rid, text) => {
    const { turn } = store.beginRequest({ sessionId: sid, requestId: rid, virtualPersonId: 'lunara', userText: text });
    store.completeRequest({ requestId: rid, virtualPersonId: 'lunara', message: { content: '嗯嗯' } });
    return turn;
  };
  return { dir, store, say };
}

test('分叉副本不被当成新的旁听事件再次导入反思', () => {
  const { dir, store, say } = setup();
  try {
    say('s1', 'rq1', '我超级喜欢爵士乐');
    const later = say('s1', 'rq2', '换个话题');
    const journal = new ReflectionObservationStore({ db: store.db }).initialize();
    journal.recoverCommittedTurns();
    const before = store.db.prepare('SELECT event_key, session_id FROM reflection_observations').all();
    store.forkFromTurn('s1', later.turnId);
    journal.recoverCommittedTurns();
    const after = store.db.prepare("SELECT event_key, session_id, data_json FROM reflection_observations").all();
    const jazz = after.filter(row => JSON.parse(row.data_json).userText?.includes('爵士'));
    assert.equal(jazz.length, 1, '同一句原话只应作为一条反思观察');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('反思判为敏感后，早先分叉出的副本作为跨聊天摘录出现时也带着敏感标签', () => {
  const { dir, store, say } = setup();
  try {
    const secret = say('s1', 'rq1', '我最近查出来抑郁症，在吃药');
    const later = say('s1', 'rq2', '放首歌吧');
    store.forkFromTurn('s1', later.turnId);           // 反思还没跑（5 分钟空闲窗口内）就分叉
    store.markSensitiveSources(['lunara'], [secret.turnId]); // 反思随后把原话判为敏感
    store.createRoom({ sessionId: 's3', memberIds: ['lunara'] });
    // 摘录照常带出原话，敏感与否交给标签与伙伴分寸；副本不能因为分叉而丢掉标签
    const copies = store.recentEncounters('lunara', { excludeSessionId: 's3', perSession: 8 })
      .filter(turn => turn.visibleText.includes('抑郁'));
    assert.ok(copies.length >= 1);
    assert.deepEqual(copies.filter(turn => !turn.policy?.sensitive), [], '分叉副本也带敏感标签');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('群里说的敏感话：反思前离群的成员也被标敏感，他的一对一摘录里带着标签', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5a-left-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  try {
    store.createRoom({ sessionId: 'g', memberIds: ['lunara', 'b'] });
    store.beginRound({ sessionId: 'g', roundId: 'r1', userText: '我爸最近住院了，心里很乱', responsePlan: [] });
    const secret = store.listTurns('g', { limit: 10 }).find(t => t.role === 'user');
    store.removeMember('g', 'b');
    // companionNotes.acceptOpenLoop：readers = 当前成员
    store.markSensitiveSources(store.getSession('g').memberIds, [secret.turnId]);
    store.createRoom({ sessionId: 'b1', memberIds: ['b'] });
    const seen = store.recentEncounters('b', { excludeSessionId: 'b1', perSession: 8 });
    assert.ok(seen.length >= 1);
    assert.deepEqual(seen.filter(t => !t.policy?.sensitive), [], '离群成员看到的那句也带敏感标签');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('分叉后邀请进来的伙伴读不到原聊天里私密话的回应；副本沿用原回合的时间', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-fork-lineage-'));
  let clock = Date.parse('2026-10-01T15:00:00.000Z');
  const store = new ConversationStore({ dbPath: join(dir, 'state.db'), now: () => clock }).initialize();
  try {
    store.createRoom({ sessionId: 'c1', memberIds: ['lunara'] });
    store.beginRequest({ sessionId: 'c1', requestId: 'p1', virtualPersonId: 'lunara', userText: '我其实在准备辞职，别告诉别人' });
    store.completeRequest({ requestId: 'p1', virtualPersonId: 'lunara', message: { content: '嗯，准备辞职是大事，慢慢来。' } });
    const { turn: later } = store.beginRequest({ sessionId: 'c1', requestId: 'p2', virtualPersonId: 'lunara', userText: '放首歌吧' });
    store.completeRequest({ requestId: 'p2', virtualPersonId: 'lunara', message: { content: '好。' } });
    const original = store.listTurns('c1', { limit: 10 });
    clock += 11 * 3600 * 1000;
    const { room } = store.forkFromTurn('c1', later.turnId);
    store.addMember(room.sessionId, 'night');
    const copies = store.listTurns(room.sessionId, { limit: 10 });
    assert.deepEqual(copies.map(turn => turn.createdAt), original.slice(0, copies.length).map(turn => turn.createdAt));
    const readable = copies.filter(turn => store.canReadTurn('night', turn, { isGroup: true })).map(turn => turn.visibleText);
    assert.deepEqual(readable, [], '私密话与它的回应都不给新成员');
    assert.equal(copies.filter(turn => store.canReadTurn('lunara', turn, { isGroup: false })).length, 2, '原来的伙伴在一对一里照常读到');
    store.saveSummary({ sessionId: room.sessionId, personId: 'night', fromSequence: 1, toSequence: 2, content: '私密' });
    assert.deepEqual(store.listSummaries(room.sessionId, { limit: 1, personId: 'night', isGroup: true }), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
