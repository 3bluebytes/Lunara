// ConversationStore.forkForget.test.js — 忘记原话时分叉副本一起撤回（harden-memory-selection-and-forget）。
//
// Run: node --test server/virtual-person/ConversationStore.forkForget.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from './ConversationStore.js';

test('忘掉原话后，分叉聊天里复制的同一句也一起撤回', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-fork-forget-'));
  const store = new ConversationStore({ dbPath: join(dir, 'state.db') }).initialize();
  try {
    store.createRoom({ sessionId: 's', memberIds: ['a'] });
    const { turn } = store.beginRequest({ sessionId: 's', requestId: 'rq1', virtualPersonId: 'a', userText: '记住我养的猫叫团子' });
    store.completeRequest({ requestId: 'rq1', virtualPersonId: 'a', message: { content: '记住了' } });
    store.observeTurns(['a'], [turn.turnId]);
    const { turn: later } = store.beginRequest({ sessionId: 's', requestId: 'rq2', virtualPersonId: 'a', userText: '换个话题' });
    store.completeRequest({ requestId: 'rq2', virtualPersonId: 'a', message: { content: '好' } });
    const { room: fork } = store.forkFromTurn('s', later.turnId);
    // 分叉的分叉：在第一个分叉里再说一句，从这句处再分叉，用户原话的副本再被复制一次。
    const { turn: inFork } = store.beginRequest({ sessionId: fork.sessionId, requestId: 'rq3', virtualPersonId: 'a', userText: '再聊聊' });
    store.completeRequest({ requestId: 'rq3', virtualPersonId: 'a', message: { content: '嗯' } });
    store.forkFromTurn(fork.sessionId, inFork.turnId);
    assert.equal(store.searchObservedTurns('a', { keywords: ['团子'] }).length, 3, '原话与两份副本');
    // forget_person_memory 对记忆 evidence.sourceTurnId（原回合）调 revokeObservation
    store.revokeObservation('a', turn.turnId);
    const hits = store.searchObservedTurns('a', { keywords: ['团子', '记住了'] }).map(t => [t.sessionId, t.visibleText]);
    assert.deepEqual(hits, [], '被忘掉的原话和回应不应从任何分叉副本里被翻出来');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
