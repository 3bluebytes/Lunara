// todaySplit.js — 帐本页「列表 | 编辑器」之间的可拖动分隔线（桌面 ≥961px）。
//
// 只写一个 CSS 变量 --today-list-width（写在 #today-panel 上），today.css / stage.css
// 的栏模板用 min(var, calc(100% - 编辑器保底宽)) 消费它：编辑器永远不会被挤没。
// 宽度只记在本机（localStorage）；拖动中不写，松手才写。双击恢复主题默认。
// 渲染会整体替换面板 innerHTML，所以把手在事件时用 closest() 现查，
// 并用 MutationObserver 在重渲染后把 aria 值同步到新把手上。
import { STORAGE_KEYS } from '../../core/storageKeys.js';

export const TODAY_SPLIT = Object.freeze({ min: 280, max: 640, step: 16, editorMin: 420 });
const VARIABLE = '--today-list-width';
const DESKTOP = '(min-width: 961px)';

export function clampTodayListWidth(value, containerWidth = 0) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  const ceiling = containerWidth > 0
    ? Math.min(TODAY_SPLIT.max, containerWidth - TODAY_SPLIT.editorMin)
    : TODAY_SPLIT.max;
  const high = Math.max(TODAY_SPLIT.min, ceiling);
  return Math.min(high, Math.max(TODAY_SPLIT.min, number));
}

export function createTodaySplit({
  panel,
  getHandle = () => null,
  storage = globalThis.localStorage,
  windowLike = globalThis.window,
  onError = () => {},
} = {}) {
  const cleanups = [];
  let width = null;
  let drag = null;
  let observer = null;

  const desktop = () => windowLike?.matchMedia?.(DESKTOP)?.matches !== false;
  const handle = () => getHandle?.() || null;
  // 还没拖过时以列表列的真实宽度为起点（主题默认由 CSS 的 minmax 决定，JS 不猜）。
  function measuredListWidth() {
    const box = handle()?.closest?.('.today-workspace-body')?.querySelector?.('.today-notes-sidebar')?.getBoundingClientRect?.();
    return box?.width > 0 ? box.width : 0;
  }
  const shown = () => width ?? Math.round(measuredListWidth());

  function syncAria() {
    const node = handle();
    if (!node) return;
    if (width != null) {
      node.setAttribute?.('aria-valuenow', String(width));
      node.setAttribute?.('aria-valuetext', `列表 ${width} 像素`);
    } else {
      node.removeAttribute?.('aria-valuenow');
      node.removeAttribute?.('aria-valuetext');
    }
  }

  function save() {
    try {
      if (width == null) storage?.removeItem?.(STORAGE_KEYS.todayListWidth);
      else storage?.setItem?.(STORAGE_KEYS.todayListWidth, String(width));
    } catch (error) { onError(error); }
  }

  function set(next, { persist = true, containerWidth = 0 } = {}) {
    const clamped = clampTodayListWidth(next, containerWidth);
    if (clamped == null) return width;
    width = clamped;
    panel?.style?.setProperty?.(VARIABLE, `${clamped}px`);
    syncAria();
    if (persist) save();
    return clamped;
  }

  function reset() {
    width = null;
    panel?.style?.removeProperty?.(VARIABLE);
    syncAria();
    save();
  }

  function listen(target, type, fn) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  }

  const fromSplit = event => Boolean(event.target?.closest?.('.today-split'));
  function measured() {
    const box = handle()?.closest?.('.today-workspace-body')?.getBoundingClientRect?.();
    return box?.width > 0 ? box.width : 0;
  }

  function onPointerDown(event) {
    if (!fromSplit(event) || !desktop() || (event.button != null && event.button !== 0)) return;
    event.preventDefault?.();
    const startWidth = width ?? (Math.round(measuredListWidth()) || TODAY_SPLIT.min);
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth };
    event.target.setPointerCapture?.(event.pointerId);
    panel?.ownerDocument?.documentElement?.classList?.add?.('today-splitting');
  }
  function onPointerMove(event) {
    if (!drag || (drag.pointerId != null && event.pointerId !== drag.pointerId)) return;
    set(drag.startWidth + (event.clientX - drag.startX), { persist: false, containerWidth: measured() });
  }
  function endDrag(event) {
    if (!drag) return;
    handle()?.releasePointerCapture?.(event?.pointerId ?? drag.pointerId);
    drag = null;
    panel?.ownerDocument?.documentElement?.classList?.remove?.('today-splitting');
    save();
  }
  function onKeyDown(event) {
    if (!fromSplit(event) || !desktop()) return;
    const step = { ArrowLeft: -TODAY_SPLIT.step, ArrowRight: TODAY_SPLIT.step }[event.key];
    let next = null;
    if (step) next = shown() + step;
    else if (event.key === 'Home') next = TODAY_SPLIT.min;
    else if (event.key === 'End') next = TODAY_SPLIT.max;
    if (next == null) return;
    event.preventDefault?.();
    set(next, { containerWidth: measured() });
  }

  function init() {
    if (!panel) return api;
    let stored = null;
    try { stored = storage?.getItem?.(STORAGE_KEYS.todayListWidth); } catch (error) { onError(error); }
    if (stored != null && clampTodayListWidth(stored) != null) set(stored, { persist: false });
    listen(panel, 'pointerdown', onPointerDown);
    listen(panel, 'pointermove', onPointerMove);
    listen(panel, 'pointerup', endDrag);
    listen(panel, 'pointercancel', endDrag);
    listen(panel, 'keydown', onKeyDown);
    listen(panel, 'dblclick', event => { if (fromSplit(event)) reset(); });
    if (typeof windowLike?.MutationObserver === 'function') {
      observer = new windowLike.MutationObserver(() => syncAria());
      observer.observe(panel, { childList: true });
      cleanups.push(() => observer?.disconnect?.());
    }
    return api;
  }

  function destroy() {
    while (cleanups.length) cleanups.pop()();
    observer = null;
    drag = null;
    panel?.ownerDocument?.documentElement?.classList?.remove?.('today-splitting');
  }

  const api = { init, destroy, set, reset, width: () => width };
  return api;
}
