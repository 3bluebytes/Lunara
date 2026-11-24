import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
process.env.LUNARA_DB_PATH = join(mkdtempSync(join(tmpdir(), 'lunara-merge-expiry-')), 'memory.db');
const { MemoryService } = await import(`${ROOT}/memory/MemoryService.js`);
const { ReflectionAgent } = await import(`${ROOT}/station/ReflectionAgent.js`);

test('披露期限已过的旧洞察不再接收新证据；期限未到的照常合并', async () => {
  const memory = new MemoryService('person:a');
  await memory.initialize();
  const H = 3600e3;
  const start = Date.now();
  const claim = { key: 'music.genre.jazz', polarity: 'positive' };
  const old = memory.addMemory({ namespace: 'person:a', type: 'semantic', source: 'agent_reflection', content: '这次聊天里用户想听爵士',
    tags: 'reflection-insight,reflection-short,claim:music.genre.jazz', confidence: 0.3, importance: 5, expiresAt: start + 7 * 24 * H,
    evidence: JSON.stringify({ eventKeys: ['e1'], claim, policy: { disclosure: 'normal', onlyConversationId: 'S1', until: start + 24 * H } }) });
  const agent = Object.create(ReflectionAgent.prototype);
  const target = at => {
    agent.now = () => at;
    const rows = [{ eventKey: 'e2', sessionId: 'S1', createdAt: at, kind: 'turn', data: { userTurnId: 't2', userText: '今天想听爵士' } }];
    return agent._findMergeTarget(memory, 'person:a', { observation: '用户又想听爵士', evidence: ['e2'], claim },
      { ...agent._batchPolicy(rows), until: start + 24 * H })?.id ?? null;
  };
  try {
    assert.equal(target(start + H), old.id);
    assert.equal(target(start + 30 * H), null);
  } finally { await memory.shutdown(); }
});
