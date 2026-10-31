// createLlmRuntimeWiring.js — 模型运行时的观测量接线：能力探测 + 用量账本。
//
// 组合根行数守卫（server/index.js < 750 行）：两件事共用同一个 llm 观测钩子、
// 同一个预算守卫注入点，所以在组合根里只出现一次引用。
//   - capabilityProbe：保存后后台探测 / 首次使用惰性补探测 / 越权事实负缓存；
//   - usageLedger：每次尝试落账（只记数值与分类）、日内上限守卫（fail closed）、
//     /api/llm/usage 与 /api/health 的查询来源；
//   - onModelEvent：交给会话记录接线复用（setLlmObserver 只有一个宿主）。

import { createCapabilityProbeWiring } from './createCapabilityProbeWiring.js';
import { createLlmUsageLedger } from '../llmUsageLedger.js';
import { setLlmBudgetGuard } from '../llm.js';

export function createLlmRuntimeWiring({ logger = console, capabilityProbe = null, usage = null } = {}) {
  const probe = capabilityProbe || createCapabilityProbeWiring({ logger });
  const ledger = usage || createLlmUsageLedger({ logger });
  // 日内上限守卫注入传输层：真正 fetch 之前判断，超限显式拒绝且不升级重试。
  setLlmBudgetGuard(verdict => ledger.guard(verdict));

  return Object.freeze({
    capabilityProbe: probe,
    usageLedger: ledger,
    onModelEvent(event) {
      probe.maybeLazyProbe(event);
      ledger.observe(event);
    },
  });
}

export default createLlmRuntimeWiring;
