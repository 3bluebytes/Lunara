// createCapabilityProbeWiring.js — 能力探测的自动化接线（design §1，任务 1.5/1.5b/1.6/1.6a）。
//
// 三条自动路径，全部数 token 级、有界、不阻塞任何交互：
//   1. 保存模型后：后台为尚无档案的模型探测一次（每次保存最多 N 个，避免大模型列表风暴）；
//   2. 首次使用的惰性补探测：某模型第一次被真正调用且没有档案时后台补一次（每进程每模型一次）；
//   3. 运行时负缓存：传输层尝试关闭思考被拒/被无视 → 把 canDisable 事实并进档案（不覆盖用户声明）。
// 结论写入注册表（source 'probe'/'observed'），设置页展示探测时间；用户显式声明优先。

import { setCapabilityObserver } from '../llm.js';
import { probeModelCapability } from '../llmProbe.js';
import { getModelCapability, resolveProviderEndpoint, saveModelCapability } from '../llmProviders.js';

const MAX_AUTO_PROBES_PER_SAVE = 3;

export function createCapabilityProbeWiring({
  logger = console,
  probe = probeModelCapability,
  record = saveModelCapability,
  readCapability = getModelCapability,
  resolveEndpoint = resolveProviderEndpoint,
  maxPerSave = MAX_AUTO_PROBES_PER_SAVE,
} = {}) {
  const pending = new Map();   // providerId::model → Promise（并发去重）
  const lazyAttempted = new Set(); // 惰性补探测：每进程每模型一次

  const keyOf = ({ providerId, model }) => `${providerId}::${model}`;

  async function probeAndStore({ providerId, model, force = false } = {}) {
    const key = keyOf({ providerId, model });
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const existing = await readCapability({ providerId, model });
      if (!force && existing?.source === 'user') return { ok: true, skipped: 'user-declared', capability: existing };
      const endpoint = await resolveEndpoint({ providerId, model });
      if (!endpoint) return { ok: false, error: 'provider 不可用或没有可探测的模型' };
      const { capability, probedAt, observations } = await probe({ endpoint });
      // overwrite:false：自动结论一律不覆盖用户显式声明——即使探测在用户声明之前开始、
      // 之后才提交（注册表按字段合并，未确认字段也不会被抹掉）。手动触发同样遵守。
      const saved = await record({ providerId, model, capability, source: 'probe', probedAt, overwrite: false });
      return { ok: true, capability: saved, observations, probedAt };
    })().finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  /** 保存模型后调用（fire-and-forget）：只探测尚无档案的模型，单次有界。 */
  function scheduleAfterSave({ providerId, models = [] } = {}) {
    const unique = [...new Set((Array.isArray(models) ? models : []).map(model => String(model || '').trim()).filter(Boolean))];
    void (async () => {
      let budget = Math.max(0, Number(maxPerSave) || 0);
      for (const model of unique) {
        if (budget <= 0) break;
        try {
          const existing = await readCapability({ providerId, model });
          if (existing) continue; // 已有档案（含用户声明）不重复探测
          budget -= 1;
          const result = await probeAndStore({ providerId, model });
          if (!result.ok) logger?.warn?.(`[llm-probe] auto probe skipped for ${model}: ${result.error}`);
        } catch (error) {
          logger?.warn?.(`[llm-probe] auto probe failed for ${model}: ${error?.message || error}`);
        }
      }
    })().catch(() => {});
  }

  /**
   * 首次使用的惰性补探测：从模型观测事件进入（phase=start 且有 providerId）。
   * 「是否已有档案」以**注册表里的持久记录**为准，不看事件里的 capabilitySource：
   * 过渡桥（DeepSeek 命名）会给未知模型一个非 unknown 的来源标记，若据此跳过，
   * 这类网关永远不会被真正探测（E2E 实测踩到）。
   */
  function maybeLazyProbe(event) {
    if (event?.phase !== 'start' || !event.providerId || !event.model) return;
    const key = keyOf({ providerId: event.providerId, model: event.model });
    if (lazyAttempted.has(key) || pending.has(key)) return;
    lazyAttempted.add(key);
    void (async () => {
      const existing = await readCapability({ providerId: event.providerId, model: event.model });
      if (existing) return; // 已有档案（含用户声明）：不打扰
      const result = await probeAndStore({ providerId: event.providerId, model: event.model });
      if (!result.ok && result.error) logger?.warn?.(`[llm-probe] lazy probe skipped: ${result.error}`);
    })().catch(error => logger?.warn?.(`[llm-probe] lazy probe failed: ${error?.message || error}`));
  }

  /** 运行时能力事实（负缓存）：并入档案；saveModelCapability 的 overwrite:false 不接受用户声明的覆盖。 */
  function applyObservedFact(fact = {}) {
    if (!fact.providerId || !fact.model || !fact.thinking) return;
    void (async () => {
      try {
        await record({
          providerId: fact.providerId,
          model: fact.model,
          capability: { family: fact.family || 'unknown', thinking: { ...fact.thinking } },
          source: 'observed', overwrite: false,
        });
      } catch (error) {
        logger?.warn?.(`[llm-probe] observed fact ignored: ${error?.message || error}`);
      }
    })().catch(() => {});
  }

  // 负缓存事实直接挂进传输层（与 createSessionTraceWiring 挂 llmObserver 同一模式）。
  setCapabilityObserver(applyObservedFact);

  return Object.freeze({
    probeNow: ({ providerId, model, force = true } = {}) => probeAndStore({ providerId, model, force }),
    scheduleAfterSave,
    maybeLazyProbe,
    applyObservedFact,
  });
}
