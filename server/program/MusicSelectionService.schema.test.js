// MusicSelectionService.schema.test.js — 选歌上下文里的口味图式与聊天注入同一道来源门槛。
//
// Run: node --test server/program/MusicSelectionService.schema.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQLiteMemoryStore } from '../memory/MemoryStore.js';
import { MemoryService } from '../memory/MemoryService.js';
import { revokeMemory } from '../memory/memoryProvenance.js';
import { MusicSelectionService } from './MusicSelectionService.js';

test('来源被忘掉的口味图式不进选歌上下文', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-selection-schema-'));
  const ns = 'person:lunara';
  const service = new MemoryService(ns);
  service.store = new SQLiteMemoryStore({ dbPath: join(dir, 'memory.db') }).initialize();
  t.after(() => { service.store.close(); rmSync(dir, { recursive: true, force: true }); });
  const fact = service.addMemory({ namespace: ns, type: 'semantic', source: 'user_explicit_feedback', content: '用户失眠吃药时只听周杰伦',
    tags: ['person-relationship'], evidence: JSON.stringify({ schema: 2, writeKey: 'k1', sourceTurnId: 'T1', policy: { disclosure: 'normal' } }) });
  service.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: '- 用户失眠吃药时只听周杰伦', tags: 'taste-schema',
    evidence: JSON.stringify({ schema: 2, writeKey: `taste-schema:${ns}`, scope: 'widest-audience', contributorIds: [fact.id] }) });
  const fake = {
    conversationStore: { getSession: () => ({ sessionId: 'g', memberIds: ['lunara', 'b'], membershipRevision: 1 }), db: service.store.db },
    registry: { get: () => ({ id: 'lunara', memoryNamespace: ns, status: 'active' }) },
    getMemoryService: () => service, isSharedMemoryActive: () => true, now: () => Date.now(),
    getLibraryRevision: () => 0, playbackRuntime: { listeningSnapshot: () => ({}) },
  };
  const schemaIn = () => MusicSelectionService.prototype.context.call(fake, { sessionId: 'g', virtualPersonId: 'lunara' })
    .memories.filter(row => /taste-schema/.test(row.tags)).length;
  assert.equal(schemaIn(), 1, '来源有效时图式在');
  revokeMemory(service.store, fact.id);
  assert.equal(schemaIn(), 0);
});

test('较早的显式口味不被后来的反思与已撤回的行挤出选歌上下文', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-selection-explicit-'));
  const ns = 'person:lunara';
  const service = new MemoryService(ns);
  service.store = new SQLiteMemoryStore({ dbPath: join(dir, 'memory.db') }).initialize();
  t.after(() => { service.store.close(); rmSync(dir, { recursive: true, force: true }); });
  let at = Date.now() - 1_000_000;
  const add = input => {
    const row = service.addMemory({ namespace: ns, type: 'semantic', ...input });
    service.store.db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(at, at, row.id);
    at += 1000;
    return row;
  };
  const fact = add({ source: 'user_explicit_feedback', content: '用户喜欢 R&B', tags: ['person-relationship'],
    evidence: JSON.stringify({ writeKey: 'k-rnb', sourceTurnId: 'T0', policy: { disclosure: 'normal' } }) });
  for (let i = 0; i < 40; i += 1) {
    add({ source: 'agent_reflection', content: `最近的观察 ${i}`, tags: 'reflection-insight', expiresAt: Date.now() + 86_400_000,
      evidence: JSON.stringify({ policy: { disclosure: 'normal' } }) });
  }
  const fake = {
    conversationStore: { getSession: () => ({ sessionId: 'c', memberIds: ['lunara'], membershipRevision: 1 }), db: service.store.db },
    registry: { get: () => ({ id: 'lunara', memoryNamespace: ns, status: 'active' }) },
    getMemoryService: () => service, isSharedMemoryActive: () => true, now: () => Date.now(),
    getLibraryRevision: () => 0, playbackRuntime: { listeningSnapshot: () => ({}) },
  };
  const memories = MusicSelectionService.prototype.context.call(fake, { sessionId: 'c', virtualPersonId: 'lunara' }).memories;
  assert.ok(memories.some(row => row.id === fact.id), '用户亲口说的口味仍在');
  assert.ok(memories.length <= 8);
});
