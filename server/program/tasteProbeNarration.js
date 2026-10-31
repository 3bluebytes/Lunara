// tasteProbeNarration.js — 探查（probe）的串词如实披露（add-taste-probe-signals）
//
// 包装串词上下文装配器：当前歌是近期 probe 时附加 tasteProbe 提示。披露是"主持人
// 在试水"的一句话说明，不是偏好陈述；探查记录本身是运营数据，不进偏好事实。

/** 'music.genre.rnb' → 'rnb'（给串词的人类可读主题）。 */
export function probeTopic(claimKey) {
  const parts = String(claimKey || '').split('.');
  return parts.length > 2 ? parts.slice(2).join(' ') : '';
}

export function withTasteProbeHint(provider, lookup) {
  return async effect => {
    const context = await provider(effect);
    const probe = lookup?.(effect) || null;
    if (!probe?.claim_key) return context;
    return { ...context, tasteProbe: { claimKey: probe.claim_key, topic: probeTopic(probe.claim_key) } };
  };
}
