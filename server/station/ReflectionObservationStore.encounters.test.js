// ReflectionObservationStore.encounters.test.js — 旁听补录不收被编辑掉的消息（harden-memory-selection-and-forget）。
//
// Run: node --test server/station/ReflectionObservationStore.encounters.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from '../virtual-person/ConversationStore.js';
import { ReflectionObservationStore } from './ReflectionObservationStore.js';

test('群聊里旁听的伙伴：消息在补录扫描前被编辑，被改写掉的原话不进她的反思', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-encounter-edit-'));
  const dbPath = join(dir, 'state.db');
  const store = new ConversationStore({ dbPath }).initialize();
  const journal = new ReflectionObservationStore({ dbPath }).initialize();
  try {
    store.createRoom({ sessionId: 'g', memberIds: ['a', 'b'] });
    const { turn } = store.beginRequest({ sessionId: 'g', requestId: 'rq1', virtualPersonId: 'a', userText: '我其实在偷偷准备辞职' });
    store.completeRequest({ requestId: 'rq1', virtualPersonId: 'a', message: { content: '好的' } });
    store.observeTurns(['a', 'b'], [turn.turnId]);
    store.rewindFromTurn('g', turn.turnId); // 用户马上编辑掉这句
    journal.recoverCommittedTurns();        // 30 秒一次的 sweep
    const leaked = journal.db.prepare("SELECT person_id, data_json FROM reflection_observations").all()
      .filter(row => JSON.parse(row.data_json).userTurnId === turn.turnId);
    assert.deepEqual(leaked, [], '被编辑掉的消息不应进入任何伙伴的反思');
  } finally {
    journal.close?.(); store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
