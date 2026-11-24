// narrationContext.memory.test.js — 串词取记忆先过滤再截取（harden-memory-forks-and-schedules）。
//
// Run: node --test server/program/narrationContext.memory.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'r5a-narr-'));
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import('../memory/MemoryService.js');
const { retrieveExpressionPreferences, retrieveSongMemories } = await import('./narrationContext.js');

test('较早的表达纠正与歌曲记忆不被后来的上百条记忆挤出串词', async () => {
  const ns = 'person:a';
  const memory = new MemoryService(ns);
  await memory.initialize();
  try {
    let t = Date.now() - 1_000_000;
    const add = (content, tags) => {
      const r = memory.addMemory({ namespace: ns, type: 'semantic', source: 'user_explicit_feedback', content, tags,
        evidence: JSON.stringify({ writeKey: `k${t}`, policy: { disclosure: 'normal' } }) });
      memory.store.db.prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?').run(t, t, r.id);
      t += 1000;
    };
    add('串词结尾别总叫我宝贝', ['expression-preference']);
    add('用户很喜欢陈绮贞的《旅行的意义》', ['person-relationship']);
    for (let i = 0; i < 100; i += 1) add(`用户的第 ${i} 件小事`, ['person-relationship']);
    for (let i = 0; i < 50; i += 1) add(`被撤回的第 ${i} 件事`, ['person-relationship', 'revoked']);
    const prefs = retrieveExpressionPreferences(memory, { namespace: ns, sessionId: 's' });
    const song = retrieveSongMemories(memory, { namespace: ns, sessionId: 's', track: { title: '旅行的意义', artist: '陈绮贞' } });
    assert.equal(prefs.length, 1, '用户的表达纠正仍生效，应进入串词');
    assert.equal(song.length, 1);
  } finally { await memory.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
