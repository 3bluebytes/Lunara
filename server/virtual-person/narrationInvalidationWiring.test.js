import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MemoryService } from '../memory/MemoryService.js';
import { createVirtualPersonRuntimeComposition } from './createVirtualPersonRuntimeComposition.js';

process.chdir(mkdtempSync(resolve(tmpdir(), 'lunara-narration-stale-wiring-')));

test('a saved memory invalidates prepared narrations and the candidate pool for that conversation', async t => {
  const staleCalls = [], poolCalls = [];
  const memory = new MemoryService('station');
  await memory.initialize();
  t.after(() => { memory.shutdown(); rmSync(process.cwd(), { recursive: true, force: true }); });
  const composition = createVirtualPersonRuntimeComposition({
    chat: async () => ({ message: { role: 'assistant', content: 'ok' } }),
    synthesize: async () => null,
    publish() {},
    queueService: { snapshot: () => ({}), publishSnapshot() {} },
    playbackRuntime: { snapshot: () => ({ version: 1 }),
      invalidatePreparedNarrations: sessionId => { staleCalls.push(sessionId); return Promise.resolve({ accepted: true }); } },
    getMusicService: () => ({ execute: async () => ({ ok: true }), pool: { invalidate: () => poolCalls.push('pool') } }),
    getMemoryService: () => memory,
    logger: { error() {}, warn() {} },
  });
  composition.registry.initialize();
  composition.registry.createRadiohost({ id: 'night', displayName: '夜航', voiceProfileId: 'warm' });
  const context = { sessionId: 'conversation:room', virtualPersonId: 'night', userTurnId: 'turn-9',
    userText: '介绍歌的时候不要每首都以关照听众收尾，全部内容都是介绍歌是被允许的' };
  const outcome = await composition.toolRegistry.execute('remember_person_fact', {
    content: '介绍歌时不要每首都以关照听众收尾，允许自然停在歌本身。',
    sourceQuote: '不要每首都以关照听众收尾', kind: 'expression',
  }, context);
  assert.equal(outcome.ok, true, outcome.modelContext || 'memory write should succeed');
  await new Promise(resolveTick => setImmediate(resolveTick));
  assert.deepEqual(poolCalls, ['pool']);
  assert.deepEqual(staleCalls, ['conversation:room']);
  // 普通关系事实同样刷新候选池，但不重备串词。
  await composition.toolRegistry.execute('remember_person_fact', {
    content: '用户叫小月亮', sourceQuote: '我叫小月亮',
  }, { ...context, userTurnId: 'turn-10', userText: '我叫小月亮' });
  await new Promise(resolveTick => setImmediate(resolveTick));
  assert.deepEqual(poolCalls, ['pool', 'pool']);
  assert.deepEqual(staleCalls, ['conversation:room']);
});
