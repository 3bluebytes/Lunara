/**
 * 托盘菜单与文案的纯函数：不接触 Electron API，可在 node:test 里直接跑。
 * 播放事实由渲染层推送，这里只做「缺字段时的安全降级 + 文案 + 可用状态」。
 */

/** 曲名上限：菜单栏是公共横向空间，超长会挤掉别的应用。 */
export const TRAY_TITLE_LIMIT = 24;
/** 歌词跑马灯的窗宽：一屏能读完的长度，超出就滚动，而不是被省略号截断。 */
export const TRAY_LYRIC_WINDOW = 16;

const text = input => (typeof input === 'string' ? input.trim() : '');

/**
 * 把渲染层推来的状态收敛成安全形状。缺字段一律当「没有内容」，
 * 绝不根据猜测补出一个正在播放的状态。
 */
export function normalizeTrayState(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const title = text(value.title);
  const artist = text(value.artist);
  // 菜单栏可以显示曲名或当前歌词行；歌词缺失时永远回落到曲名（绝不显示占位文案）。
  const subtitle = text(value.subtitle);
  const textMode = value.textMode === 'lyrics' ? 'lyrics' : 'title';
  // 扫色需要「这一句唱到哪」：进度 0..1 与这句的时间跨度（毫秒）。缺一个就整行全亮。
  // 注意 Number(null) === 0：缺进度必须是 null（不扫色），不能被当成「0%」。
  const reportedProgress = value.subtitleProgress;
  const subtitleProgress = reportedProgress == null || reportedProgress === ''
    ? null
    : (Number.isFinite(Number(reportedProgress)) ? Math.min(1, Math.max(0, Number(reportedProgress))) : null);
  const reportedSpan = Number(value.subtitleSpanMs);
  const subtitleSpanMs = Number.isFinite(reportedSpan) && reportedSpan > 0 ? reportedSpan : null;
  const hasTrack = Boolean(title);
  return Object.freeze({
    title,
    artist,
    subtitle,
    textMode,
    subtitleProgress,
    subtitleSpanMs,
    hasTrack,
    // 播放态只在有内容时才成立：没有曲目却显示「正在播放」会让托盘撒谎。
    playing: hasTrack && value.playing === true,
    canPlayPause: hasTrack,
    canPrevious: hasTrack && value.canPrevious === true,
  });
}

function clip(text, limit) {
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

/**
 * 菜单栏文字方案：
 *   · empty  没有内容 → 只留图标；
 *   · static 曲名（截断）——曲名要稳定，不滚；
 *   · scroll 歌词行——**一律滚动**，不拿长度当开关（短句也要有动效）；
 *     窗宽取 `min(窗宽上限, 整行 + 两个全角空格的间隔)`，这样短句仍然是
 *     「整句可见地滑过 + 短暂空白」的循环，而不是半屏空格里飘几个字。
 * 歌词模式下一旦当前没有歌词行（前奏、纯音乐、还没走到第一句），回落到曲名。
 */
export function trayTitlePlan(raw, { limit = TRAY_TITLE_LIMIT, lyricWindow = TRAY_LYRIC_WINDOW } = {}) {
  const state = normalizeTrayState(raw);
  if (!state.hasTrack) return Object.freeze({ kind: 'empty', text: '' });
  const lyric = state.textMode === 'lyrics' ? state.subtitle : '';
  if (!lyric) return Object.freeze({ kind: 'static', text: clip(state.title, limit) });
  const window = Math.min(lyricWindow, [...lyric].length + 2);
  return Object.freeze({ kind: 'scroll', text: lyric, window });
}

/**
 * 跑马灯的一帧：在「歌词行 + 两个全角空格」的循环上取固定宽度的窗口。
 * 帧宽恒定（这是关键：菜单栏项一变宽，旁边的图标就会被推来推去）。
 * 按码位切分，避免把 emoji 之类的代理对切成半截。
 */
export function trayScrollFrame(text, offset, { window = TRAY_LYRIC_WINDOW } = {}) {
  const chars = [...`${text}\u3000\u3000`];
  const width = Math.max(1, window);
  const start = ((Math.trunc(offset) % chars.length) + chars.length) % chars.length;
  let frame = '';
  for (let index = 0; index < width; index += 1) frame += chars[(start + index) % chars.length];
  return frame;
}

/** 静态文字（等同滚动方案的第 0 帧）；没有内容时为空串。 */
export function trayTitleText(raw, options = {}) {
  const plan = trayTitlePlan(raw, options);
  if (plan.kind === 'empty') return '';
  if (plan.kind === 'static') return plan.text;
  return trayScrollFrame(plan.text, 0, { window: plan.window });
}

/** 悬停提示：Windows 上这是唯一的文字通道，macOS 上用于完整信息。 */
export function trayTooltip(raw) {
  const state = normalizeTrayState(raw);
  if (!state.hasTrack) return 'Lunara · 未在播放';
  const detail = state.artist ? `${state.title} — ${state.artist}` : state.title;
  return `Lunara · ${state.playing ? '正在播放' : '已暂停'}：${detail}`;
}

/**
 * 菜单内容签名。菜单里只有曲名/艺人、播放/暂停、上一首可用性这些字段；
 * 歌词行与扫色进度只影响菜单栏文字/图像，不进菜单。渲染层的状态推送很频繁
 * （歌词每前进约 1% 就过线一次），而 macOS 上每次 setContextMenu 都会换掉
 * 菜单后端——若菜单正开着，旧菜单所有项的点击都会失联（能弹出但点了没反应）。
 * 托盘据此跳过不影响菜单内容的推送，绝不重建。
 */
export function trayMenuSignature(raw) {
  const state = normalizeTrayState(raw);
  return JSON.stringify([state.title, state.artist, state.playing, state.canPrevious]);
}

/**
 * 托盘菜单模板。顺序固定：当前曲目（不可点）→ 播放/暂停、上一首、下一首 →
 * 显示窗口、退出。「下一首」与播放条上的按钮一致，始终可点（库里还有歌时它就该能切）。
 */
export function buildTrayMenuTemplate(raw, actions = {}) {
  const state = normalizeTrayState(raw);
  const nowPlaying = state.hasTrack
    ? (state.artist ? `${state.title} — ${state.artist}` : state.title)
    : '未在播放';
  const item = (label, enabled, handler) => ({
    label,
    enabled: Boolean(enabled),
    click: () => { handler?.(); },
  });
  return [
    { label: nowPlaying, enabled: false },
    { type: 'separator' },
    item(state.playing ? '暂停' : '播放', state.canPlayPause, actions.toggle),
    item('上一首', state.canPrevious, actions.previous),
    item('下一首', true, actions.next),
    { type: 'separator' },
    item('显示 Lunara', true, actions.show),
    item('退出', true, actions.quit),
  ];
}
