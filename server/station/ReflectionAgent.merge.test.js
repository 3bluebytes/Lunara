// ReflectionAgent.merge.test.js — 合并目标不选被墓碑遮住的旧洞察（harden-memory-forks-and-schedules）。
//
// Run: node --test server/station/ReflectionAgent.merge.test.js

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'r5a-merge-'));
process.env.LUNARA_DB_PATH = join(dir, 'memory.db');
const { MemoryService } = await import('../memory/MemoryService.js');
const { isMemoryRevoked, revokeMemory } = await import('../memory/memoryProvenance.js');
const { ReflectionAgent } = await import('./ReflectionAgent.js');
const { retrievePersonMemories } = await import('../virtual-person/personMemory.js');

test('忘掉同一句里的显式事实后，同 claim 的新反思另起一条，不并进被墓碑遮住的旧洞察', async () => {
  const ns = 'person:a';
  const memory = new MemoryService(ns);
  await memory.initialize();
  try {
    const now = Date.now();
    // T1：用户说"记住我叫小王，我最近很爱听后摇"→ 显式事实 X + 反思洞察 I（claim music.genre.postrock）
    const x = memory.addMemory({ namespace: ns, type: 'semantic', source: 'user_explicit_feedback', content: '用户叫小王',
      tags: ['person-relationship'], evidence: JSON.stringify({ writeKey: 'wk-x', sourceTurnId: 'T1', policy: { disclosure: 'normal' } }) });
    const i = memory.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: '用户最近很爱听后摇',
      confidence: 0.3, tags: 'reflection-insight,reflection-short,claim:music.genre.postrock', expiresAt: now + 86_400_000,
      evidence: JSON.stringify({ eventKeys: ['turn:A1'], sourceTurnIds: ['T1'], claim: { key: 'music.genre.postrock', polarity: 'positive' },
        policy: { disclosure: 'normal' } }) });
    // 用户只要求忘掉"叫小王"
    revokeMemory(memory.store, x.id);
    assert.equal(isMemoryRevoked(memory.store, memory.store.getById(i.id)), true, '同来源反思随之失效（设计如此）');
    // 之后几天用户在别的回合 T2 又说爱听后摇：新批次同 claim
    const agent = new ReflectionAgent({ disabled: true });
    const target = agent._findMergeTarget(memory, ns, { claim: { key: 'music.genre.postrock', polarity: 'positive' }, observation: '又提到爱听后摇' },
      { disclosure: 'normal' });
    assert.equal(target, null, '新回合 T2 的后摇观察另起一条洞察，不被已失效的旧洞察吞掉');
    const live = memory.addMemory({ namespace: ns, type: 'semantic', source: 'agent_reflection', content: '用户又说爱听后摇',
      confidence: 0.3, tags: 'reflection-insight,reflection-short,claim:music.genre.postrock', expiresAt: now + 86_400_000,
      evidence: JSON.stringify({ eventKeys: ['turn:A2'], sourceTurnIds: ['T2'], claim: { key: 'music.genre.postrock', polarity: 'positive' },
        policy: { disclosure: 'normal' } }) });
    const reflections = retrievePersonMemories(memory, null, { namespace: ns, virtualPersonId: 'a', sessionId: 's', query: '' })
      .filter(row => row.kind === 'reflection');
    assert.deepEqual(reflections.map(row => row.id), [live.id], '新洞察照常注入');
    assert.equal(agent._findMergeTarget(memory, ns, { claim: { key: 'music.genre.postrock', polarity: 'positive' } },
      { disclosure: 'normal' })?.id, live.id, '之后的同 claim 证据并进新的这一条');
  } finally { await memory.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
