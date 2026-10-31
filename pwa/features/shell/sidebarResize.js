// sidebarResize.js — 桌面宽度下拖动侧栏右缘调整宽度（所有舞台主题共用）。
//
// 只写一个 CSS 变量 --sidebar-user-width（写在根元素上），stage.css 在桌面媒体查询里
// 用它算 --room-sidebar-width，并按视口封顶，保证两条主列不被挤到横向溢出。
// 这里不碰播放、聊天或导航状态；宽度只记在本机（localStorage）。
//
// 操作：拖动把手；把手聚焦时 ←/→ 每次 16px，Home/End 到最小/最大；双击回到主题默认并清掉记忆。
import { STORAGE_KEYS } from '../../core/storageKeys.js';

export const SIDEBAR_WIDTH = Object.freeze({ min: 200, max: 320, fallback: 220, step: 16 });
const VARIABLE = '--sidebar-user-width';
const DESKTOP = '(min-width: 961px)';

export function clampSidebarWidth(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, number));
}

export function createSidebarResize({
  handle,
  root = globalThis.document?.documentElement,
  storage = globalThis.localStorage,
  windowLike = globalThis.window,
  onError = () => {},
} = {}) {
  const cleanups = [];
  let width = null;
  let drag = null;

  const desktop = () => windowLike?.matchMedia?.(DESKTOP)?.matches !== false;
  const shown = () => width ?? SIDEBAR_WIDTH.fallback;

  function syncAria() {
    handle?.setAttribute?.('aria-valuenow', String(shown()));
    handle?.setAttribute?.('aria-valuetext', `${shown()} 像素`);
  }

  function save() {
    try {
      if (width == null) storage?.removeItem?.(STORAGE_KEYS.sidebarWidth);
      else storage?.setItem?.(STORAGE_KEYS.sidebarWidth, String(width));
    } catch (error) { onError(error); }
  }

  function set(next, { persist = true } = {}) {
    const clamped = clampSidebarWidth(next);
    if (clamped == null) return shown();
    width = clamped;
    root?.style?.setProperty?.(VARIABLE, `${clamped}px`);
    syncAria();
    if (persist) save();
    return clamped;
  }

  function reset() {
    width = null;
    root?.style?.removeProperty?.(VARIABLE);
    syncAria();
    save();
  }

  function listen(target, type, fn) {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  }

  function measured() {
    const box = handle?.parentElement?.getBoundingClientRect?.();
    return box?.width > 0 ? box.width : shown();
  }

  function onPointerDown(event) {
    if (!desktop() || (event.button != null && event.button !== 0)) return;
    event.preventDefault?.();
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: measured() };
    handle.setPointerCapture?.(event.pointerId);
    root?.classList?.add?.('sidebar-resizing');
  }
  function onPointerMove(event) {
    if (!drag || (drag.pointerId != null && event.pointerId !== drag.pointerId)) return;
    set(drag.startWidth + (event.clientX - drag.startX), { persist: false });
  }
  function endDrag(event) {
    if (!drag) return;
    handle.releasePointerCapture?.(event?.pointerId ?? drag.pointerId);
    drag = null;
    root?.classList?.remove?.('sidebar-resizing');
    save();
  }
  function onKeyDown(event) {
    if (!desktop()) return;
    const step = { ArrowLeft: -SIDEBAR_WIDTH.step, ArrowRight: SIDEBAR_WIDTH.step }[event.key];
    let next = null;
    if (step) next = shown() + step;
    else if (event.key === 'Home') next = SIDEBAR_WIDTH.min;
    else if (event.key === 'End') next = SIDEBAR_WIDTH.max;
    if (next == null) return;
    event.preventDefault?.();
    set(next);
  }

  function init() {
    if (!handle) return api;
    handle.setAttribute?.('aria-valuemin', String(SIDEBAR_WIDTH.min));
    handle.setAttribute?.('aria-valuemax', String(SIDEBAR_WIDTH.max));
    let stored = null;
    try { stored = storage?.getItem?.(STORAGE_KEYS.sidebarWidth); } catch (error) { onError(error); }
    if (stored != null && clampSidebarWidth(stored) != null) set(stored, { persist: false });
    else syncAria();
    listen(handle, 'pointerdown', onPointerDown);
    listen(handle, 'pointermove', onPointerMove);
    listen(handle, 'pointerup', endDrag);
    listen(handle, 'pointercancel', endDrag);
    listen(handle, 'keydown', onKeyDown);
    listen(handle, 'dblclick', reset);
    return api;
  }

  function destroy() {
    while (cleanups.length) cleanups.pop()();
    root?.classList?.remove?.('sidebar-resizing');
    drag = null;
  }

  const api = { init, destroy, set, reset, width: () => width };
  return api;
}
