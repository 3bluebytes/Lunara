import { providerRegistry } from './providerRegistry.js';

// 权重不属于资源解析策略。旧配置保持多源；单源是明确的来源边界。
export function normalizeSourcePolicy(saved = {}) {
  const primarySource = providerRegistry.isPlayable(saved?.primarySource) ? saved.primarySource : 'qq';
  const mode = saved?.playbackSourceMode === 'single' ? 'single' : 'multi';
  return { mode, primarySource, sources: mode === 'single' ? [primarySource] : [...providerRegistry.orderFor(primarySource)] };
}

export function readSourcePolicy(state) {
  try { return normalizeSourcePolicy(JSON.parse(state.getPref('settings') || '{}')); }
  catch { return normalizeSourcePolicy(); }
}

export function sourceAllowed(policy, source) {
  const id = String(source || '').split(':')[0];
  return !policy || (providerRegistry.isPlayable(id) && policy.sources.includes(id));
}
