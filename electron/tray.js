/**
 * 桌面托盘：macOS 菜单栏 / Windows 托盘。
 *
 * 只做展示与转发——播放状态由渲染层推送（`setState`），命令回到渲染层注入的动作，
 * 主进程不推断播放事实、也不碰媒体元素。
 *
 * macOS 菜单栏有两条文字路径：
 *   · 图像路径（卡拉OK扫色）：把「已唱全亮 / 未唱变暗」的一行字渲染成图片塞进菜单栏。
 *     菜单栏的 `setTitle` 是单色系统文字，改不了「一部分染色」，所以只能画成图。
 *   · 文本路径（曲名，或没有渲染器时的歌词兜底）：`setTitle` + 定宽跑马灯。
 */
import {
  TRAY_LYRIC_WINDOW,
  buildTrayMenuTemplate,
  normalizeTrayState,
  trayMenuSignature,
  trayScrollFrame,
  trayTitlePlan,
  trayTooltip,
} from './trayModel.js';
import {
  LYRIC_EDGE_PADDING, computeLyricFrame, interpolateProgress, lyricPalette,
} from './trayLyricFrame.js';

/** 文本兜底的跑马灯步进（约 9 字/秒）。 */
export const SCROLL_INTERVAL_MS = 110;
/** 扫色刷新节奏：12fps 足够顺滑，实测整机 CPU 4–6%。 */
export const LYRIC_TICK_MS = 80;

export function createDesktopTray({
  Tray,
  Menu,
  nativeImage,
  platform = process.platform,
  icons = {},
  actions = {},
  showTitleText = true,
  intervalMs = SCROLL_INTERVAL_MS,
  lyricTickMs = LYRIC_TICK_MS,
  schedule = (callback, ms) => setInterval(callback, ms),
  cancelSchedule = handle => clearInterval(handle),
  /** 两色歌词的离屏渲染器（见 lyricCanvas.js）；为空时歌词回落到文本跑马灯。 */
  lyricCanvas = null,
  /** 只在 macOS 有意义：决定菜单栏用深色还是浅色配色。 */
  nativeTheme = null,
  now = () => Date.now(),
  /** 诊断钩子：每画一帧回报图像尺寸与状态项边界（LUNARA_TRAY_DEBUG=1 时才接）。 */
  onFrame = null,
  onWarn = message => console.warn(message),
} = {}) {
  const iconPath = platform === 'darwin' ? icons.macTemplate : icons.windows;
  const image = iconPath ? nativeImage.createFromPath(iconPath) : null;
  if (!image || image.isEmpty?.() !== false) {
    // 图标缺失不该让应用起不来：托盘是可选外壳。
    onWarn(`[tray] icon unavailable: ${iconPath}`);
    return null;
  }

  const tray = new Tray(image);
  const isMac = platform === 'darwin';
  let state = normalizeTrayState(null);
  // 上次真正写进托盘的菜单签名；null 表示还没建过菜单。
  let builtMenuSignature = null;

  // 文本路径的跑马灯状态
  let scrollTimer = null;
  let scrollOffset = 0;
  let scrollText = null;
  // 图像路径的扫色状态
  let lyricTimer = null;
  let lyricAnchor = null;
  let lyricLine = null;
  let lyricLastKey = '';
  let lyricRendering = false;
  // 是否处于「图像模式」：只有从图像切回文本时才需要清掉 setImage，避免每次重绘都闪
  let imageActive = false;

  const darkBar = () => nativeTheme?.shouldUseDarkColors !== false;

  function stopScroll() {
    if (scrollTimer == null) return;
    cancelSchedule(scrollTimer);
    scrollTimer = null;
  }

  function stopLyric() {
    if (lyricTimer == null) return;
    cancelSchedule(lyricTimer);
    lyricTimer = null;
  }

  function writeTitle(text) {
    if (!isMac) return;
    const value = showTitleText ? text : '';
    if (typeof tray.getTitle === 'function' && tray.getTitle() === value) return;
    tray.setTitle(value);
  }

  /**
   * 离开「歌词图像」路径时必须**换回模板图**，不能塞一张空图：
   * 菜单栏项既没有图像也没有标题文字时会整个不可见（用户看到的就是「图标消失」）。
   */
  function restoreIcon() {
    if (!imageActive) return;
    imageActive = false;
    try {
      if (typeof tray.setImage === 'function') tray.setImage(image);
    } catch { /* 恢复失败不影响播放，下一次重绘会再试 */ }
  }

  // ---- 文本路径（曲名；没有渲染器时的歌词兜底） ----

  function paintTextTitle() {
    stopScroll();
    const plan = trayTitlePlan(state);
    if (plan.kind === 'empty' || !showTitleText) { scrollText = null; writeTitle(''); return; }
    if (plan.kind === 'static') { scrollText = null; writeTitle(plan.text); return; }
    const window = plan.window;
    scrollText = plan.text;
    scrollOffset = 0;
    writeTitle(trayScrollFrame(plan.text, 0, { window }));
    if (!state.playing) return;
    scrollTimer = schedule(() => {
      scrollOffset += 1;
      try {
        writeTitle(trayScrollFrame(plan.text, scrollOffset, { window }));
      } catch {
        stopScroll();
      }
    }, intervalMs);
    scrollTimer?.unref?.();
  }

  // ---- 图像路径（卡拉OK扫色） ----

  function currentProgress() {
    if (!lyricAnchor) return null;
    const value = interpolateProgress({ ...lyricAnchor, now: now() });
    return Number.isFinite(value) ? value : null;
  }

  function reanchor() {
    const text = state.subtitle || '';
    const reported = state.subtitleProgress;
    const lineChanged = lyricLine !== text;
    if (lineChanged) {
      // 换句立刻切：进度归位、左移归零（旧图的 key 也要清掉）
      lyricLine = text;
      lyricLastKey = '';
      // 没有上报进度时不能假装「已经唱完」：留 null，绘制端按「整窗全亮、不扫色」处理。
      lyricAnchor = reported == null
        ? { progress: null, spanMs: null, anchorAt: now() }
        : { progress: reported, spanMs: state.subtitleSpanMs, anchorAt: now() };
      return;
    }
    if (reported == null) return; // 没有新进度：保留锚点继续插值
    // 只前进不后退：迟到/重复上报不能让染色回缩
    const current = currentProgress();
    const next = Math.min(1, Math.max(current ?? 0, reported));
    lyricAnchor = { progress: next, spanMs: state.subtitleSpanMs, anchorAt: now() };
  }

  async function paintLyricFrame() {
    if (!lyricCanvas || lyricRendering || !isMac) return;
    const text = state.subtitle || '';
    if (!text) return;
    lyricRendering = true;
    try {
      const progress = currentProgress();
      const textWidth = (await lyricCanvas.measure(text)) || 1;
      // 不知道这一句的时间跨度时不是「唱完了」，而是「没法扫」：整窗全亮、不左移。
      // 扫色窗口 = 整窗宽减去左侧图标位
      const windowWidth = lyricCanvas.textWidthPx || lyricCanvas.widthPx;
      const frame = progress == null
        ? Object.freeze({ shift: 0, clipRight: windowWidth, sungRatio: 1 })
        : computeLyricFrame({
          textWidth,
          windowWidth,
          progress,
          edgePadding: Math.round(LYRIC_EDGE_PADDING * (windowWidth / 200)),
        });
      const palette = lyricPalette(darkBar());
      const key = `${text}|${frame.shift}|${frame.clipRight}|${palette.bright}`;
      if (key === lyricLastKey) return;
      const rendered = await lyricCanvas.render({
        text, shift: frame.shift, clipRight: frame.clipRight, palette,
      });
      if (!rendered) return;
      lyricLastKey = key;
      imageActive = true;
      tray.setImage(rendered);
      writeTitle('');
      onFrame?.({
        imageSize: rendered.getSize?.() ?? null,
        scaleFactors: rendered.getScaleFactors?.() ?? null,
        bounds: tray.getBounds?.() ?? null,
      });
    } finally {
      lyricRendering = false;
    }
  }

  function startLyricTicker() {
    stopLyric();
    if (!state.playing) return;
    if (currentProgress() == null) return; // 不知道时间跨度：不扫色，停在整行全亮
    lyricTimer = schedule(() => {
      void paintLyricFrame();
      const progress = currentProgress();
      if (progress != null && progress >= 1) stopLyric(); // 唱完这一句就停，等下一句
    }, lyricTickMs);
    lyricTimer?.unref?.();
  }

  const apply = next => {
    state = normalizeTrayState(next);
    tray.setToolTip(trayTooltip(state));
    // 菜单只在内容变化时重建：歌词行/扫色进度随播放频繁推送，但不进菜单。
    // macOS 上 setContextMenu 会换掉菜单后端，若菜单正开着，旧菜单的所有
    // 点击都会失联（表现为「菜单能弹出但点了没有任何反应」）。
    const menuSignature = trayMenuSignature(state);
    if (menuSignature !== builtMenuSignature) {
      builtMenuSignature = menuSignature;
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(state, actions)));
    }
    if (!isMac) return;

    if (!showTitleText) { stopScroll(); stopLyric(); restoreIcon(); writeTitle(''); return; }

    const plan = trayTitlePlan(state);
    const useImage = plan.kind === 'scroll' && Boolean(lyricCanvas);
    if (useImage) {
      stopScroll();
      // 不要先清空图像：状态推送很频繁，清一下会让菜单栏项闪一下空白。
      reanchor();
      void paintLyricFrame();
      startLyricTicker();
      return;
    }

    stopLyric();
    restoreIcon();
    // 同一行还在跑马灯：保留进度，不要被状态推送重置回第一帧
    if (scrollTimer != null && plan.kind === 'scroll' && plan.text === scrollText && state.playing) return;
    paintTextTitle();
  };

  // 菜单栏明暗切换：配色变了要重画一帧
  nativeTheme?.on?.('updated', () => {
    if (!isMac || !lyricCanvas) return;
    lyricLastKey = '';
    void paintLyricFrame();
  });

  apply(null);

  return Object.freeze({
    tray,
    setState: apply,
    state: () => state,
    repaintLyric: () => { lyricLastKey = ''; return paintLyricFrame(); },
    /** 诊断用：当前菜单栏走的是图像（扫色）还是文本路径。 */
    hasImage: () => imageActive,
    destroy: () => {
      stopScroll();
      stopLyric();
      try { tray.destroy(); } catch { /* 退出路径上失败无需处理 */ }
    },
  });
}

export { TRAY_LYRIC_WINDOW };
