// personMemory.lifeNotes.test.js — 反思记下的近况跨聊天注入（add-person-life-notes）。
//
// Run: node --test server/virtual-person/personMemory.lifeNotes.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryService } from '../memory/MemoryService.js';
import { MemorySource, MemoryType } from '../memory/types.js';
import { LIFE_NOTE_TAG } from '../memory/reflectionInsights.js';
import { LIFE_NOTE_LIMIT, retrievePersonMemories } from './personMemory.js';

async function withMemory(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-life-notes-'));
  const previous = process.env.LUNARA_DB_PATH;
  process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
  const namespace = 'radiohost:a';
  const memory = new MemoryService(namespace);
  await memory.initialize();
  let clock = 1_000;
  const write = (content, evidence = {}, extra = {}) => memory.store.insert({
    createdAt: ++clock, updatedAt: clock, lastAccessedAt: clock,
    namespace, type: MemoryType.SEMANTIC, source: MemorySource.AGENT_REFLECTION, content, summary: '近况',
    tags: `${LIFE_NOTE_TAG},life-upcoming`, confidence: 0.4, importance: 5,
    evidence: JSON.stringify({ schema: 2, sessions: ['c1'], originSessionId: 'c1', policy: { disclosure: 'normal' }, ...evidence }),
    ...extra,
  });
  const life = (input = {}) => retrievePersonMemories(memory, null, { namespace, virtualPersonId: 'a', sessionId: 'c2',
    query: '在吗', ...input }).filter(row => row.kind === 'life');
  try {
    await run({ write, life });
  } finally {
    await memory.shutdown();
    if (previous === undefined) delete process.env.LUNARA_DB_PATH;
    else process.env.LUNARA_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('近况在别的一对一聊天和群聊里都出现，带日期', async () => {
  await withMemory(async ({ write, life }) => {
    write('对方下周三去马德里出差', { dueDate: '2026-10-07', mentionedAt: 1_000 });
    const [note] = life();
    assert.equal(note.content, '对方下周三去马德里出差');
    assert.equal(note.dueDate, '2026-10-07');
    assert.equal(note.mentionedAt, 1_000);
    assert.deepEqual(life({ isGroup: true }).map(row => row.content), ['对方下周三去马德里出差']);
  });
});

test('过期、限定在别的聊天的近况不出现；最多注入最新的几条', async () => {
  await withMemory(async ({ write, life }) => {
    write('过期的', {}, { expiresAt: Date.now() - 1000 });
    write('只在 c1 说的', { policy: { disclosure: 'normal', onlyConversationId: 'c1', until: Date.now() + 60_000 } });
    assert.deepEqual(life(), []);
    for (let i = 0; i <= LIFE_NOTE_LIMIT; i += 1) write(`第${i}件事`);
    const injected = life().map(row => row.content);
    assert.equal(injected.length, LIFE_NOTE_LIMIT);
    assert.ok(!injected.includes('第0件事'));
  });
});
