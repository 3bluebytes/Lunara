// recommendationWeights.js — 推荐来源配额的**纯计算**。
//
// 这里只回答三个问题，不碰播放、不碰候选内容：
//   1. 用户没配置时每源该占多少（均分）
//   2. 用户配置过、后来新接了一个源时，怎么给新源一份而不悄悄重置用户的比例
//   3. 某个源此刻兑现不了时，剩下的源怎么按相对比例接住它的份额
//
// 为什么不在播放路径用它：`add-recommendation-source-weights` D7。提交与解析必须
// 只由 canonical 身份、硬约束与可用性决定；读取偏好会让同样输入给出不同源。
//
// 为什么要显式配置而不是按收听推导：按收听推导是反馈回路（听得多的源拿更多推荐
// → 听得更多），用户看不见也改不动。默认均分 + 显式滑块是唯一可解释的方案。

import { providerRegistry } from './providerRegistry.js';

const EPSILON = 1e-9;

/** 只含可播源：目录源（仅跳转）不占播放配额。 */
export function playableSourceIds(registry = providerRegistry) {
  return registry.list().filter(source => source.playable).map(source => source.id);
}

/** 均分；空列表返回空对象（不是除零）。 */
export function equalWeights(ids = []) {
  const list = [...new Set(ids.map(id => String(id ?? '').trim()).filter(Boolean))];
  if (!list.length) return {};
  const share = 1 / list.length;
  return Object.fromEntries(list.map(id => [id, share]));
}

// 只要求「非负有限数」：保存的是相对关系，按总和归一即可（0.7/0.3 与 7/3 等价），
// 这样界面将来换成百分比也不必迁移。全 0 或非法由调用方退回均分。
function isShare(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

/**
 * 把用户保存的权重收敛成「只含这些源、和为 1」的目标份额。
 *
 * - 有保存值的源按保存值，并按总和缩放到 1（用户只要相对关系，不要求正好加满）。
 * - **完全没有保存值的源（新接入的）先拿均分那一份**，其余源按原有相对比例
 *   分摊剩下的额度 —— 既不让新源摸到 0%（那看起来像坏了），也不静默重置用户
 *   已经调过的比例。
 * - 保存值全是 0 或全非法时退回均分：一份 0/0 的配置没有可解释的含义。
 */
export function mergeWeights(saved, ids = []) {
  const list = [...new Set(ids.map(id => String(id ?? '').trim()).filter(Boolean))];
  if (!list.length) return {};
  const source = saved && typeof saved === 'object' ? saved : {};
  const known = list.filter(id => isShare(source[id]));
  const missing = list.filter(id => !known.includes(id));
  if (!known.length) return equalWeights(list);

  const savedSum = known.reduce((sum, id) => sum + Number(source[id]), 0);
  if (savedSum <= EPSILON) return equalWeights(list);

  const reserve = missing.length ? missing.length / list.length : 0;
  const rest = 1 - reserve;
  const weights = Object.fromEntries(known.map(id => [id, (Number(source[id]) / savedSum) * rest]));
  for (const id of missing) weights[id] = 1 / list.length;
  return weights;
}

/**
 * 目标份额 → 当前能兑现的有效份额。
 *
 * `availableIds` 之外的源份额按其余源的**相对权重**重新归一，因此候选总量不缩水。
 * 可兑现集合为空时返回空对象：调用方必须如实报告「这次没有可用源」，不能编一份
 * 均分出来假装还有配额。
 */
export function effectiveWeights(targets, availableIds = []) {
  const available = [...new Set(availableIds.map(id => String(id ?? '').trim()).filter(Boolean))]
    .filter(id => Object.prototype.hasOwnProperty.call(targets || {}, id));
  if (!available.length) return {};
  const total = available.reduce((sum, id) => sum + Number(targets[id] || 0), 0);
  if (total <= EPSILON) return equalWeights(available);
  return Object.fromEntries(available.map(id => [id, Number(targets[id]) / total]));
}

/**
 * 最大余额法：把份额换成整数配额，总数恰好等于 `total`。
 * 曲目不够时由调用方决定「如实补不足」，这里只负责不硬凑、不超发。
 */
export function allocateQuotas(targets, total) {
  const want = Math.max(0, Math.floor(Number(total) || 0));
  const entries = Object.entries(targets || {})
    .map(([id, share]) => [id, Math.max(0, Number(share) || 0)])
    .filter(([, share]) => share > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length || want === 0) return {};
  const sum = entries.reduce((acc, [, share]) => acc + share, 0);
  const quotas = {};
  let assigned = 0;
  for (const [id, share] of entries) {
    const exact = (share / sum) * want;
    const base = Math.floor(exact + EPSILON);
    quotas[id] = base;
    assigned += base;
  }
  // 余数按小数部分从大到小补，平手时按 id 稳定排序，保证同样输入同样结果。
  const remainders = entries
    .map(([id, share], index) => [id, (share / sum) * want - Math.floor((share / sum) * want + EPSILON), index])
    .sort((a, b) => b[1] - a[1] || a[2] - b[2]);
  let left = want - assigned;
  for (let i = 0; remainders.length && left > 0; i = (i + 1) % remainders.length) {
    quotas[remainders[i][0]] += 1;
    left -= 1;
  }
  return quotas;
}

/**
 * 一次算清「目标 / 可兑现 / 整数配额」，供候选供给与设置页共用同一份结论。
 * @param {{saved?: object, playableIds?: string[], availableIds?: string[], total?: number}} options
 */
export function resolveRecommendationWeights({ saved = null, playableIds = playableSourceIds(),
  availableIds = playableIds, total = 0 } = {}) {
  const targets = mergeWeights(saved, playableIds);
  const effective = effectiveWeights(targets, availableIds);
  return { targets, effective, quotas: allocateQuotas(effective, total) };
}
