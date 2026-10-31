/**
 * 菜单栏歌词扫色的纯几何与配色。
 *
 * 为什么需要这一层：macOS 菜单栏的 `tray.setTitle` 是系统单色文字，改不了「一部分
 * 染色」。要做到「唱到哪染到哪」，只能把文字渲染成图片。于是这里把「进度 → 裁剪宽度 /
 * 整行左移量」和「深浅色菜单栏用哪两种颜色」独立出来，可以脱离 Electron 测。
 */

/** 固定窗口（pt）：宽度定死，进度到达右缘后整行左移，而不是继续变宽。 */
export const LYRIC_WINDOW = Object.freeze({ width: 200, height: 22, font: 13 });

/** 进度点距右缘留的余量（pt）：贴死边缘看起来像被裁掉。 */
export const LYRIC_EDGE_PADDING = 22;

/**
 * 扫色位置：
 *   · `clipRight` —— 已经唱过的宽度（染色区右边界），单位与 textWidth 一致；
 *   · `shift`     —— 整行左移量：进度撞到右缘后，文字连同染色区一起向左挪，
 *                    让进度点停在距右缘 edgePadding 的位置（「左边右边一起向左移动」）；
 *   · `sungRatio` —— 唱过的比例，测试与调试用。
 * 三个值都由「行内相对进度」推导，不依赖任何 Electron 状态。
 */
export function computeLyricFrame({ textWidth = 0, windowWidth = 0, progress = 1, edgePadding = LYRIC_EDGE_PADDING } = {}) {
  const width = Math.max(0, Number(textWidth) || 0);
  const window = Math.max(1, Number(windowWidth) || 1);
  const ratio = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 1));
  const padding = Math.min(Math.max(0, Number(edgePadding) || 0), window - 1);
  const sungX = width * ratio;
  const shift = Math.max(0, sungX - (window - padding));
  const clipRight = Math.min(window, Math.max(0, sungX - shift));
  return Object.freeze({
    shift: Math.round(shift),
    clipRight: Math.round(clipRight),
    sungRatio: ratio,
  });
}

/**
 * 由「上报时的进度 + 时间跨度 + 锚点时刻」推当前进度：
 * 主进程按帧插值，渲染层不必每 100ms 上报一次。进度只增不减、到 1 停住，
 * 换句由调用方重置锚点（立刻从 0 重新开始）。
 */
export function interpolateProgress({ progress, spanMs, anchorAt, now } = {}) {
  if (!Number.isFinite(progress)) return null;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return Math.min(1, Math.max(0, progress));
  const elapsed = Math.max(0, Number(now) - Number(anchorAt));
  return Math.min(1, Math.max(0, progress + elapsed / spanMs));
}

/**
 * 菜单栏明暗两套配色：已唱用全亮、未唱用同色的低透明度。
 * 不用第二种色相——菜单栏是系统区域，色相容易和旁边的图标打架，也会在
 * 明暗切换时失去对比度。
 */
export function lyricPalette(useDarkBar) {
  return useDarkBar
    ? Object.freeze({ bright: '#ffffff', dim: 'rgba(255,255,255,0.40)' })
    : Object.freeze({ bright: '#17171a', dim: 'rgba(23,23,26,0.38)' });
}
