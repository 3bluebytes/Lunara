import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const dir = mkdtempSync(join(tmpdir(), 'r6a-age-'));
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import(`${ROOT}/memory/MemoryService.js`);
const { ReflectionAgent } = await import(`${ROOT}/station/ReflectionAgent.js`);
const { recentReflectionInsights } = await import(`${ROOT}/memory/reflectionInsights.js`);

test('持续被合并强化的 claim 洞察按最后一次合并算新近，创建满 7 天后仍注入', async () => {
  const ns = 'person:a';
  const memory = new MemoryService(ns);
  await memory.initialize();
  try {
    const DAY = 86_400_000;
    const claim = { key: 'music.genre.jazz', polarity: 'positive', text: '喜欢爵士', scope: 'relationship' };
    const r = memory.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: '用户反复说喜欢爵士',
      tags: 'reflection-insight,reflection-short,claim:music.genre.jazz', confidence: 0.3, expiresAt: Date.now() + DAY,
      evidence: JSON.stringify({ eventKeys: ['turn:old'], claim, policy: { disclosure: 'normal' } }) });
    memory.store.db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(Date.now() - 8 * DAY, r.id);
    const agent = new ReflectionAgent({ disabled: true, logger: { warn() {} } });
    const target = memory.store.getById(r.id);
    // 今天又一次说喜欢爵士：_findMergeTarget 不看 createdAt，按 claim 并进这条
    assert.equal(agent._findMergeTarget(memory, ns, { claim, observation: '又说喜欢爵士' }, { disclosure: 'normal' })?.id, r.id);
    agent._mergeIntoInsight(memory, target, { claim, observation: '又说喜欢爵士', evidence: [] },
      [{ eventKey: 'turn:new', sessionId: 's', createdAt: Date.now(), kind: 'turn', data: { userTurnId: 'unew', userText: '我喜欢爵士' } }], 'a');
    const injected = recentReflectionInsights(memory, ns);
    assert.equal(injected.length, 1, '刚被新证据强化、仍未过期的洞察应继续注入');
  } finally { await memory.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
