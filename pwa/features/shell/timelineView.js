// 听歌时间线（只在 data-layout="timeline" 时显示）：已放在左、当前封面居中、待播在右，
// 一条横线贯穿，播放头下面是此刻的本机时间。宽屏（≥1200px）同一份标记由 timeline.css 竖排：
// 已放在上、待播在下，时刻在竖线左边；歌名（已放）和歌手（待播）只在竖排时显示。
// 已放输出队列里的全部已放项：横排由 CSS 只露最近几首。竖排时整列听歌面板就是一条可以往回拖的
// 时间线：已放、竖线、封面、待播一起移动（滚轮 / 触控板原生滚动，鼠标按住拖动带惯性，拖过头有
// 回弹）。默认停在「现在」（露出最近两首已放）；新放完一首时整条时间线平滑上移一格；往回翻过之后
// 出现「回到正在播放」。滚动只是看，不改播放。
//
// 数据只读两处：store 里的 runtime state（队列、当前项、phase）和播放条进度滑块上
// 已有的 aria-valuenow / aria-valuemax（媒体进度由 playbackView 写入）。这里不持有
// 播放状态，也不新建游标；唯一的命令是点两次已放或待播的歌，走现有 selectQueueItem
// （CARD_SELECTED：光标移到那首，队列不变），且只在正在看的聊天就是正在听的聊天时才可点。
// 串词仍由 runtime 按 occurrence 判定：说过的不再说，没放过的第一次播放照常有。
import { escapeHtml } from '../chat/chatMarkup.js';
import { wallTime } from '../../visuals/cikePresentation.js';
import { deriveTimelineStops } from './timelineModel.js';

// 已放最多输出这么多（超长队列也不把几百个节点塞进 DOM）；更早的从播放列表里找。
export const TIMELINE_PAST_LIMIT = 120;
const DRAG_THRESHOLD_PX = 4;
// 与 timeline.css 的宽屏块同一断点：只有竖排时整列可拖。
const VERTICAL_QUERY = '(min-width: 1200px)';
// 「现在」的位置：当前封面上方露出几首已放。
const NOW_PAST_ROWS = 2;
const RUBBER_PX = 90;
// 拖动起点落在这些区域时不接管（输入、可选的旁白 / 歌词文字仍能用鼠标选中复制）。
const NO_DRAG = 'input, textarea, select, [contenteditable="true"], .listening-narration, .cike-lyrics';
const ARM_TIMEOUT_MS = 4000;

const ORDINALS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
// 「第十首」「第二十三首」：标签用中文数字，和设计稿一致；过百就直接用阿拉伯数字。
export function chineseOrdinal(n) {
  if (!Number.isInteger(n) || n < 1) return '';
  if (n <= 10) return ORDINALS[n];
  if (n < 20) return `十${ORDINALS[n - 10]}`;
  if (n < 100) return `${ORDINALS[Math.floor(n / 10)]}十${ORDINALS[n % 10]}`;
  return String(n);
}

const pad = n => String(n).padStart(2, '0');
const artworkOf = item => item?.pic_url || item?.artwork || '';
const initialOf = item => Array.from(String(item?.title || '?').trim() || '?')[0];

function tile(item) {
  const src = artworkOf(item);
  // 没有封面就用歌名首字方块，底色是中性暖灰，不猜颜色。
  return src
    ? `<span class="timeline-tile"><img src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" /></span>`
    : `<span class="timeline-tile timeline-tile-initial" aria-hidden="true">${escapeHtml(initialOf(item))}</span>`;
}

export function createTimelineView({ store, controller, runtimeClient, documentLike = document, now = () => Date.now(), onError = () => {} } = {}) {
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let armed = null;
  let armTimer = null;
  let rendered = '';
  let ticker = null;
  let pastKey = '';
  let pastSeen = null;
  let drag = null;
  let glide = null;
  let swallowClick = false;
  // 是否跟着「现在」：用户往回翻（拖、滚轮）后为 false，回到现在附近或点「回到正在播放」后为 true。
  let follow = true;
  let autoScrolling = false;
  let autoScrollTimer = null;
  let scrollFrame = null;
  let resizeObserver = null;

  const isTimeline = () => documentLike.documentElement?.dataset?.layout === 'timeline';
  const runtime = () => store.getState().runtimeState || null;
  const canJump = () => {
    const rt = runtime();
    const focused = controller.snapshot()?.sessionId;
    return Boolean(rt?.activeListeningSessionId) && focused === rt.activeListeningSessionId;
  };

  function disarm() {
    armed = null;
    if (armTimer) clearTimeout(armTimer);
    armTimer = null;
  }

  function stopsNow() {
    const rt = runtime();
    return deriveTimelineStops({
      queue: rt?.queue, currentIndex: rt?.currentIndex, positionSeconds: progress().current, now: now(),
    });
  }

  /** 媒体进度：读播放条滑块；没有就退回 runtime 的位置。 */
  function progress() {
    const bar = $('#progress-bar');
    const current = Number(bar?.getAttribute?.('aria-valuenow'));
    const total = Number(bar?.getAttribute?.('aria-valuemax'));
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) return { current, total };
    const rt = runtime();
    const item = rt?.queue?.[rt?.currentIndex];
    return { current: Number(rt?.positionSeconds) || 0, total: Number(item?.durationSeconds ?? item?.duration) || 0 };
  }

  const isArmed = item => armed != null && armed === String(item.queueItemId);
  // 待确认只在这首自身上提示：封面描边 + 播放符号，歌名位置（竖排可见时）临时换成提示。
  // 不另起浮层，免得盖住相邻的歌或「已放」标题。
  const ARMED_COPY = '再点一次播放';

  /** 可点时包成按钮（点两次才执行）；不可点时原样展示。 */
  function stopMarkup(className, item, body, label) {
    const title = escapeHtml(item.title || '未知歌曲');
    const id = item.queueItemId ? escapeHtml(String(item.queueItemId)) : '';
    const stop = id ? ` data-stop="${id}"` : '';
    if (!label || !id) return `<li class="timeline-stop ${className}"${stop} title="${title}">${body}</li>`;
    return `<li class="timeline-stop ${className}"${stop}><button type="button" class="timeline-jump" data-timeline-jump="${id}" aria-label="${label}"${isArmed(item) ? ' data-armed="true"' : ''}>${body}</button></li>`;
  }

  function pastMarkup(played, jumpable) {
    const shown = played.slice(-TIMELINE_PAST_LIMIT);
    const items = shown.map(({ item, order }) => {
      const title = escapeHtml(item.title || '未知歌曲');
      const armedNow = jumpable && isArmed(item);
      const body = `${tile(item)}<span class="timeline-order">${pad(order)}</span>`
        + `<span class="timeline-title">${armedNow ? ARMED_COPY : title}</span>`;
      const label = !jumpable ? '' : armedNow ? `再点一次，回到《${title}》；队列不变` : `已放第 ${order} 首《${title}》，点两次回到这首`;
      return stopMarkup('is-past', item, body, label);
    }).join('');
    return `<p class="timeline-cap">已放 · ${pad(played.length)}</p><ol class="timeline-stops" aria-label="已放">${items}</ol>`;
  }

  function nextMarkup(upcoming, jumpable) {
    // 竖排必须保留队尾：回听早先的歌后，原来的后续项仍可拖到。
    // 横排由 timeline.css 只露前四首，宽窄切换不需要再等 runtime 广播。
    const items = upcoming.map(({ item, at }) => {
      const title = escapeHtml(item.title || '未知歌曲');
      const armedNow = jumpable && isArmed(item);
      const body = `${tile(item)}<strong>${armedNow ? ARMED_COPY : title}</strong>`
        + (item.artist ? `<span class="timeline-artist">${escapeHtml(item.artist)}</span>` : '')
        + `<span class="timeline-at">${at != null ? `约 ${wallTime(at)}` : '稍后'}</span>`;
      const label = !jumpable ? '' : armedNow ? `再点一次，跳到《${title}》；队列不变` : `待播《${title}》，点两次跳到这首`;
      return stopMarkup('is-next', item, body, label);
    }).join('');
    return upcoming.length
      ? `<ol class="timeline-stops" aria-label="待播">${items}</ol>`
      : '<p class="timeline-empty">下一首还在路上</p>';
  }

  function paintRail() {
    const rail = $('#timeline-rail');
    if (!rail || rail.hidden) return;
    const { current, total } = progress();
    const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
    rail.style?.setProperty?.('--timeline-p', `${(ratio * 100).toFixed(2)}%`);
    const at = new Date(now());
    const hm = rail.querySelector?.('[data-timeline-hm]');
    const ss = rail.querySelector?.('[data-timeline-ss]');
    if (hm) hm.textContent = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
    if (ss) ss.textContent = pad(at.getSeconds());
  }

  function render() {
    const nodes = ['#timeline-cap', '#timeline-past', '#timeline-next', '#timeline-rail'].map($);
    const [cap, past, next, rail] = nodes;
    const { played, current, upcoming } = stopsNow();
    const active = isTimeline() && Boolean(current);
    for (const node of nodes) if (node) node.hidden = !active;
    if (!active) {
      rendered = '';
      pastKey = '';
      pastSeen = null;
      disarm();
      return;
    }
    const rt = runtime();
    const order = current.index + 1;
    const capText = `正在播放 · 第${chineseOrdinal(order)}首${rt?.phase === 'paused' ? ' · 已暂停' : ''}`;
    const jumpable = canJump();
    const html = [capText, pastMarkup(played, jumpable), nextMarkup(upcoming, jumpable)];
    const key = html.join('\u0000');
    if (key !== rendered) {
      const focusedJump = documentLike.activeElement?.dataset?.timelineJump;
      if (cap) cap.textContent = capText;
      if (past && html[1] !== pastKey) paintPast(past, html[1], played);
      if (next) next.innerHTML = html[2];
      rendered = key;
      if (focusedJump) {
        const selector = `[data-timeline-jump="${CSS.escape(focusedJump)}"]`;
        (past?.querySelector?.(selector) || next?.querySelector?.(selector))?.focus?.();
      }
    }
    paintRail();
    paintReturn();
  }

  const reducedMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const isVertical = () => isTimeline() && Boolean(globalThis.matchMedia?.(VERTICAL_QUERY)?.matches);
  const panelNode = () => $('#listening-panel');
  const scrollable = node => typeof node?.scrollTop === 'number' && node.scrollHeight - node.clientHeight > 1;

  /** 「现在」对应的滚动位置：倒数第 NOW_PAST_ROWS 首已放贴着面板顶部；已放不够就是 0。 */
  function nowTop(panel) {
    const stops = panel?.querySelectorAll?.('#timeline-past .timeline-stop');
    if (!stops || stops.length <= NOW_PAST_ROWS || typeof panel.getBoundingClientRect !== 'function') return 0;
    const target = stops[stops.length - NOW_PAST_ROWS];
    const offset = target.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
    // 内容不够高时停不到锚点：以能滚到的最底为准，否则一开场就会被判成「往回翻过」。
    const max = Math.max(0, (panel.scrollHeight || 0) - (panel.clientHeight || 0));
    return Math.min(max, Math.max(0, Math.round(offset - 6)));
  }

  /** 程序滚动：smooth 时打上标记，期间的 scroll 事件不算用户往回翻。 */
  function scrollPanel(panel, top, smooth) {
    stopGlide();
    if (!smooth || reducedMotion() || typeof panel.scrollTo !== 'function') {
      panel.scrollTop = top;
      return;
    }
    autoScrolling = true;
    clearTimeout(autoScrollTimer);
    autoScrollTimer = setTimeout(() => { autoScrolling = false; }, 900);
    panel.scrollTo({ top, behavior: 'smooth' });
  }

  function returnToNow({ smooth = true } = {}) {
    const panel = panelNode();
    follow = true;
    paintReturn();
    if (panel && isVertical()) scrollPanel(panel, nowTop(panel), smooth);
  }

  function paintReturn() {
    const button = $('#timeline-return');
    const panel = panelNode();
    const away = isVertical() && !follow && Boolean(panel) && Math.abs(panel.scrollTop - nowTop(panel)) > 40;
    if (button && button.hidden === away) button.hidden = !away;
    if (panel?.dataset) {
      const above = isVertical() && panel.scrollTop > 4;
      if ((panel.dataset.timelineAbove === 'true') !== above) panel.dataset.timelineAbove = String(above);
      const draggable = isVertical() && scrollable(panel);
      if ((panel.dataset.timelineDraggable === 'true') !== draggable) panel.dataset.timelineDraggable = String(draggable);
    }
  }

  function onPanelScroll() {
    if (scrollFrame || typeof requestAnimationFrame !== 'function') return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = null;
      const panel = panelNode();
      if (!panel || !isVertical()) return;
      // 只有用户自己滚的时候才改跟随：停在现在附近就重新跟上，否则算往回翻。
      if (!autoScrolling && !drag && !glide) follow = Math.abs(panel.scrollTop - nowTop(panel)) < 12;
      paintReturn();
    });
  }

  /**
   * 换已放列表。竖排时：跟着现在就先停在原位置，再平滑滚到新的「现在」（整条时间线上移一格，
   * 新放完的那首淡入）；用户正往回翻就按已放区变高的量补偿，画面不跳。第一次画直接停在现在。
   */
  function paintPast(past, markup, played) {
    const panel = isVertical() ? panelNode() : null;
    const first = pastSeen == null;
    const beforeTop = panel?.scrollTop ?? 0;
    const beforeNow = panel ? nowTop(panel) : 0;
    stopGlide();
    past.innerHTML = markup;
    pastKey = markup;
    const ids = played.map(stop => String(stop.item.queueItemId ?? ''));
    const fresh = first ? [] : ids.filter(id => id && !pastSeen.has(id));
    pastSeen = new Set(ids);
    for (const id of fresh) past.querySelector?.(`[data-stop="${CSS.escape(id)}"]`)?.classList?.add('is-entering');
    if (!panel || typeof panel.scrollTop !== 'number') return;
    const now = nowTop(panel);
    if (first) {
      follow = true;
      panel.scrollTop = now;
    } else if (follow) {
      panel.scrollTop = beforeTop;
      scrollPanel(panel, now, fresh.length > 0);
    } else {
      panel.scrollTop = beforeTop + (now - beforeNow);
    }
    paintReturn();
  }

  function stopGlide() {
    if (glide) cancelAnimationFrame(glide);
    glide = null;
  }

  function setPull(panel, px) {
    panel.style?.setProperty?.('--timeline-pull', `${px.toFixed(1)}px`);
  }

  // 鼠标按住整列上下拖：超过几像素才算拖，拖过就吞掉这次点击（不会误触「点两次跳回」）；
  // 拖过头有阻尼，松手回弹；正常松手按最后的速度滑一小段，停在现在附近就吸回现在。
  // 触控和触控板走原生滚动，不经过这里。
  function onPanelPointerDown(event) {
    const panel = panelNode();
    if (event.pointerType !== 'mouse' || event.button !== 0 || !isVertical() || !scrollable(panel)) return;
    if (event.target?.closest?.(NO_DRAG)) return;
    stopGlide();
    drag = { panel, id: event.pointerId, y: event.clientY, top: panel.scrollTop, moved: false, lastY: event.clientY, lastT: event.timeStamp, v: 0, pull: 0 };
  }

  function onPanelPointerMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const { panel } = drag;
    const dy = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      drag.moved = true;
      follow = false;
      panel.classList.add('is-dragging');
      panel.classList.remove('is-settling');
      panel.setPointerCapture?.(event.pointerId);
      documentLike.defaultView?.getSelection?.()?.removeAllRanges?.();
    }
    const dt = Math.max(1, event.timeStamp - drag.lastT);
    drag.v = 0.8 * ((event.clientY - drag.lastY) / dt) + 0.2 * drag.v;
    drag.lastY = event.clientY;
    drag.lastT = event.timeStamp;
    const want = drag.top - dy;
    const max = panel.scrollHeight - panel.clientHeight;
    const clamped = Math.min(max, Math.max(0, want));
    panel.scrollTop = clamped;
    const over = want - clamped;
    drag.pull = over ? -Math.sign(over) * RUBBER_PX * (1 - Math.exp(-Math.abs(over) / 220)) : 0;
    panel.classList.toggle('is-pulling', drag.pull !== 0);
    setPull(panel, drag.pull);
  }

  function onPanelPointerUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const { panel, moved, pull } = drag;
    // 停住再松手（超过 100ms 没动）不滑；否则按最后的速度滑一小段。
    let v = event.timeStamp - drag.lastT > 100 ? 0 : Math.max(-2.5, Math.min(2.5, -drag.v));
    drag = null;
    if (!moved) return;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
    panel.classList.remove('is-dragging');
    if (pull) {
      // 回弹：把阻尼位移过渡回 0。
      panel.classList.remove('is-pulling');
      panel.classList.add('is-settling');
      setPull(panel, 0);
      setTimeout(() => panel.classList.remove('is-settling'), 520);
      v = 0;
    }
    const settle = () => {
      glide = null;
      const now = nowTop(panel);
      if (Math.abs(panel.scrollTop - now) < 28) returnToNow();
      else paintReturn();
    };
    if (reducedMotion() || Math.abs(v) < 0.05 || typeof requestAnimationFrame !== 'function') { settle(); return; }
    let last = performance.now();
    const step = t => {
      const dt = Math.min(32, t - last);
      last = t;
      const from = panel.scrollTop;
      panel.scrollTop = from + v * dt;
      v *= Math.pow(0.94, dt / 16);
      // 速度衰减完或已经顶到头 / 到底（位置不再变）就停。
      if (Math.abs(v) < 0.02 || panel.scrollTop === from) settle(); else glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  }

  function onStopClick(event) {
    if (swallowClick) { swallowClick = false; return; }
    const button = event.target?.closest?.('[data-timeline-jump]');
    if (!button || !canJump()) return;
    const id = button.dataset.timelineJump;
    if (armed !== id) {
      disarm();
      armed = id;
      armTimer = setTimeout(() => { disarm(); render(); }, ARM_TIMEOUT_MS);
      render();
      return;
    }
    disarm();
    render();
    return runtimeClient()?.selectQueueItem?.(id);
  }

  function on(target, type, fn) {
    if (!target) return;
    const wrapped = event => {
      try { return Promise.resolve(fn(event)).catch(onError); } catch (error) { onError(error); return undefined; }
    };
    target.addEventListener(type, wrapped);
    cleanups.push(() => target.removeEventListener(type, wrapped));
  }

  function init() {
    for (const side of ['#timeline-past', '#timeline-next']) {
      on($(side), 'click', onStopClick);
      on($(side), 'keydown', event => { if (event.key === 'Escape' && armed) { disarm(); render(); } });
    }
    const panel = panelNode();
    on(panel, 'pointerdown', onPanelPointerDown);
    on(panel, 'pointermove', onPanelPointerMove);
    on(panel, 'pointerup', onPanelPointerUp);
    on(panel, 'pointercancel', onPanelPointerUp);
    on(panel, 'selectstart', event => { if (drag) event.preventDefault?.(); });
    on(panel, 'scroll', onPanelScroll);
    on($('#timeline-past'), 'animationend', event => event.target?.classList?.remove?.('is-entering'));
    on($('#timeline-return'), 'click', () => returnToNow());
    // 宽窄切换、「听 / 聊」切换会改已放区上方的排法：跟着现在时重新对齐。
    if (panel && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => { if (follow && !drag && !glide && isVertical()) returnToNow({ smooth: false }); else paintReturn(); });
      resizeObserver.observe(panel);
    }
    cleanups.push(store.subscribe?.((next, previous) => { if (next.runtimeState !== previous?.runtimeState) render(); }) || (() => {}));
    cleanups.push(controller.subscribe?.(() => render()) || (() => {}));
    // 每秒重算一次：待播时刻依赖媒体进度与本机时间（切歌瞬间进度条可能还停在上一首、暂停时时刻要往后推），
    // 文本没变时 render 不碰 DOM。
    ticker = setInterval(() => { if (isTimeline()) render(); }, 1000);
    render();
    return api;
  }

  function destroy() {
    disarm();
    stopGlide();
    clearTimeout(autoScrollTimer);
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    resizeObserver?.disconnect();
    if (ticker) clearInterval(ticker);
    ticker = null;
    while (cleanups.length) cleanups.pop()?.();
  }

  const api = Object.freeze({ init, render, sync: render, destroy });
  return api;
}
