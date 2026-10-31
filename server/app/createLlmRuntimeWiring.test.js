// createLlmRuntimeWiring.test.js — 运行时观测量接线：观测事件复用同一钩子 + 守卫注入。

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlmRuntimeWiring } from './createLlmRuntimeWiring.js';
import { setLlmBudgetGuard } from '../llm.js';

test('onModelEvent 同时喂给能力探测与用量账本；守卫注入后按日内上限拒绝', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lunara-llm-runtime-'));
  const lazyProbes = [];
  const wiring = createLlmRuntimeWiring({
    logger: { warn() {} },
    capabilityProbe: {
      maybeLazyProbe(event) { lazyProbes.push(event.model); },
      scheduleAfterSave() {}, probeNow: async () => ({ ok: true }), applyObservedFact() {},
    },
    usage: {
      guard: verdict => ({ ok: false, code: 'LLM_BUDGET_EXHAUSTED', taskId: verdict.taskId, cap: 10, used: 99 }),
      observe: () => {}, lastRejection: () => null, summary: () => ({}), close() {},
    },
  });
  t.after(() => { setLlmBudgetGuard(null); wiring.usageLedger.close(); rmSync(dir, { recursive: true, force: true }); });

  wiring.onModelEvent({ phase: 'start', providerId: 'p', model: 'm1' });
  wiring.onModelEvent({ phase: 'attempt', providerId: 'p', model: 'm1', taskId: 'song_tag', outcome: 'ok' });
  assert.deepEqual(lazyProbes, ['m1', 'm1'], '两个消费方看到同一事件流（去重由各自负责）');

  // 守卫确实装进了传输层：llm.js 的 budgetGuard 是模块级单例。
  const { chat } = await import('../llm.js');
  const llm = (await import('../llm.js')).createLlm({
    fetchImpl: async () => { throw new Error('must not fetch'); },
    resolveEndpoint: async () => ({ baseUrl: 'http://gw/v1', model: 'm', api: 'openai-completions' }),
  });
  await assert.rejects(() => llm.chat([{ role: 'user', content: 'x' }], null, { taskId: 'song_tag' }),
    error => error?.code === 'LLM_BUDGET_EXHAUSTED' && error?.cap === 10);
  void chat;
});
