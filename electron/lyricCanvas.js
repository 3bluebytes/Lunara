/**
 * 把「两色扫色歌词」渲染成 NativeImage，供 macOS 菜单栏使用。
 *
 * 为什么要有离屏窗口：菜单栏的 `tray.setTitle` 是单色系统文字，做不到「唱到哪染到哪」。
 * 这里用一个隐藏的离屏窗口 + canvas 画好两色文字，再截图交给 `tray.setImage`。
 * 实测：200×22pt @2x、约 12fps 时整机 CPU 4–6%，只在「歌词模式 + 播放中」才跑。
 */

// 画布的**像素尺寸**是设备像素，**显示尺寸**必须写回点——用内联 style 而不是样式表：
// 之前靠 CSS 规则缩放，替换静默没生效，画布 400×44 塞进 200×22pt 的窗口，只露出左上角，
// 于是菜单栏里的字被放大并裁掉。
/** 页面模板（导出便于测试：画布的像素尺寸与显示尺寸必须分开给）。 */
export const lyricCanvasHtml = ({ widthPx, heightPx, widthPt, heightPt, icon }) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>
<canvas id="lyric" width="${widthPx}" height="${heightPx}"
  style="display:block;width:${widthPt}px;height:${heightPt}px"></canvas>
<script>
  const canvas = document.getElementById('lyric');
  const ctx = canvas.getContext('2d');
  let font = '600 26px -apple-system, "PingFang SC", sans-serif';
  window.LunaraLyric = {
    setFont(next) { font = next; },
    measure(text) { ctx.font = font; return ctx.measureText(text).width; },
    draw({ text, shift = 0, clipRight = 0, palette, baseline = ${heightPx / 2}, textX = 0 }) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // 左侧品牌标记：月牙 + 珍珠（与托盘模板图同一个形状，按当前配色上色）
      const icon = ${JSON.stringify(icon)};
      ctx.save();
      ctx.fillStyle = palette.bright;
      ctx.beginPath();
      ctx.arc(icon.cx, icon.cy, icon.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(icon.cx + icon.r * 0.62, icon.cy - icon.r * 0.20, icon.r * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.beginPath();
      ctx.arc(icon.cx + icon.r * 0.55, icon.cy + icon.r * 0.62, icon.r * 0.30, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      // 文字区整体裁在图标右侧：左移（shift > 0）时文字不能滑到月亮上
      ctx.save();
      ctx.beginPath();
      ctx.rect(textX, 0, canvas.width - textX, canvas.height);
      ctx.clip();
      // 未唱：整行低透明度
      ctx.fillStyle = palette.dim;
      ctx.fillText(text, textX - shift, baseline);
      // 已唱：同样的字，再裁到进度点为止，画成全亮
      if (clipRight > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(textX, 0, clipRight, canvas.height);
        ctx.clip();
        ctx.fillStyle = palette.bright;
        ctx.fillText(text, textX - shift, baseline);
        ctx.restore();
      }
      ctx.restore();
    },
  };
</script>`;

export function createLyricCanvas({
  BrowserWindow,
  nativeImage,
  dpr = 2,
  widthPt = 200,
  heightPt = 22,
  fontPt = 13,
  onWarn = message => console.warn(message),
} = {}) {
  if (typeof BrowserWindow !== 'function' || typeof nativeImage?.createFromBuffer !== 'function') return null;
  const widthPx = Math.round(widthPt * dpr);
  const heightPx = Math.round(heightPt * dpr);
  const fontPx = Math.round(fontPt * dpr);
  // 左侧图标占位（pt）：图标位 + 与文字之间的间隙，文字区宽度 = 窗口宽 - 这段
  const iconPt = 13;
  const iconGapPt = 7;
  const iconPx = Math.round(iconPt * dpr);
  const textX = Math.round((iconPt + iconGapPt) * dpr);
  const icon = { cx: Math.round(iconPx / 2) + 1, cy: Math.round(heightPx / 2), r: Math.round(iconPx / 2) - 1 };
  /** 扫色可用宽度（px）：不含左侧图标位。 */
  const textWidthPx = widthPx - textX;
  let win = null;
  let ready = null;
  let broken = false;

  function ensure() {
    if (broken) return null;
    if (ready) return ready;
    ready = (async () => {
      try {
        win = new BrowserWindow({
          show: false,
          // 窗口尺寸是**点**，画布是设备像素：菜单栏项最终按 widthPt 显示，
          // 之前把窗口也设成 400pt，状态栏项就有 400pt 宽，macOS 会把它挤掉。
          width: widthPt,
          height: heightPt,
          transparent: true,
          frame: false,
          hasShadow: false,
          skipTaskbar: true,
          // 离屏：不占屏幕、不被遮挡节流；渲染由我们按帧驱动。
          webPreferences: { offscreen: true, backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
        });
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(lyricCanvasHtml({ widthPx, heightPx, widthPt, heightPt, icon }))}`);
        await win.webContents.executeJavaScript(`LunaraLyric.setFont('600 ${fontPx}px -apple-system, "PingFang SC", sans-serif')`);
        // 自检：画布显示尺寸必须等于窗口点数，否则整张图会被裁成左上角。
        const rect = await win.webContents.executeJavaScript(
          `(() => { const r = document.getElementById('lyric').getBoundingClientRect();
            return [Math.round(r.width), Math.round(r.height)]; })()`);
        if (rect?.[0] !== widthPt || rect?.[1] !== heightPt) {
          onWarn(`[tray] lyric canvas clipped (${rect?.join('x')} in ${widthPt}x${heightPt}pt) — forcing inline size`);
          await win.webContents.executeJavaScript(
            `(() => { const c = document.getElementById('lyric');
              c.style.width = '${widthPt}px'; c.style.height = '${heightPt}px'; })()`);
        }
        // 预热：离屏窗口的首帧截图可能早于第一次绘制，会拿到「尺寸正常但全透明」的图。
        // 菜单栏项一旦吃到这张图就整条看不见了，所以先画一帧再丢掉一次截图。
        await win.webContents.executeJavaScript(`LunaraLyric.draw({ text: ' ', shift: 0, clipRight: 0,
          palette: { bright: '#ffffff', dim: 'rgba(255,255,255,0.4)' }, textX: ${textX} })`);
        await win.webContents.capturePage().catch(() => null);
        return win;
      } catch (error) {
        broken = true;
        onWarn(`[tray] lyric canvas unavailable: ${error?.message}`);
        try { win?.destroy(); } catch { /* 忽略 */ }
        win = null;
        return null;
      }
    })();
    return ready;
  }

  const measured = new Map();

  return Object.freeze({
    widthPx,
    heightPx,
    /** 文字区（不含左侧图标位）的宽度：扫色与左移都按这个宽度算。 */
    textWidthPx,
    textX,
    async measure(text) {
      const key = String(text);
      if (measured.has(key)) return measured.get(key);
      const target = await ensure();
      if (!target) return 0;
      try {
        const width = await target.webContents.executeJavaScript(`LunaraLyric.measure(${JSON.stringify(key)})`);
        const value = Number(width) || 0;
        if (measured.size > 64) measured.clear();
        measured.set(key, value);
        return value;
      } catch { return 0; }
    },
    async render({ text, shift = 0, clipRight = 0, palette, baseline }) {
      const target = await ensure();
      if (!target) return null;
      const payload = JSON.stringify({ text, shift, clipRight, palette, textX, ...(baseline ? { baseline } : {}) });
      try {
        await target.webContents.executeJavaScript(`LunaraLyric.draw(${payload})`);
        const captured = await target.webContents.capturePage();
        if (!captured || captured.isEmpty?.()) return null;
        // capturePage 给的是**设备像素**（例如 800×88）。直接塞给 tray.setImage 会被
        // 当成 800pt 宽的状态栏项——占满半个菜单栏，macOS 干脆把它挤掉，看起来就像
        // 「图标闪一下没了」。按 dpr 声明缩放，菜单栏才会按 200×22pt 画。
        if (typeof nativeImage?.createFromBuffer === 'function' && dpr !== 1) {
          const scaled = nativeImage.createFromBuffer(captured.toPNG(), { scaleFactor: dpr });
          if (!scaled?.isEmpty?.()) return scaled;
        }
        return captured;
      } catch (error) {
        onWarn(`[tray] lyric frame failed: ${error?.message}`);
        return null;
      }
    },
    /** 诊断：页面内部的真实度量（排查尺寸/坐标系不一致用）。 */
    async debugMetrics() {
      const target = await ensure();
      if (!target) return null;
      try {
        return await target.webContents.executeJavaScript(`JSON.stringify({
          dpr: window.devicePixelRatio,
          inner: [window.innerWidth, window.innerHeight],
          canvasAttr: [document.getElementById('lyric').width, document.getElementById('lyric').height],
          canvasRect: (() => { const r = document.getElementById('lyric').getBoundingClientRect();
            return [Math.round(r.width), Math.round(r.height)]; })(),
          font: (() => { const g = document.getElementById('lyric').getContext('2d'); return g.font; })(),
          charWidth: (() => { const g = document.getElementById('lyric').getContext('2d'); return g.measureText('国').width; })(),
        })`).then(JSON.parse);
      } catch { return null; }
    },
    destroy() {
      try { win?.destroy(); } catch { /* 退出路径上失败无需处理 */ }
      win = null;
      ready = null;
      measured.clear();
    },
  });
}
