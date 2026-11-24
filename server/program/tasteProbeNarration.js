// tasteProbeNarration.js — 探查（probe）的串词如实披露（add-taste-probe-signals）
//
// 当前歌是近期 probe 时，串词素材里带上主题。披露是"主持人在试水"的一句话说明，
// 不是偏好陈述；探查记录本身是运营数据，不进偏好事实。

/** 'music.genre.rnb' → 'rnb'（给串词的人类可读主题）。 */
export function probeTopic(claimKey) {
  const parts = String(claimKey || '').split('.');
  return parts.length > 2 ? parts.slice(2).join(' ') : '';
}
