// tooltip.js — 一个全局提示气泡，用 `data-tip` 属性声明文案。
//
// 为什么不用原生 `title`：原生提示只在鼠标悬停时出现、样式不可控、键盘用户看不到，
// 而设置页里被解释的恰恰是「单源/多源」「推荐比例」「陪伴开关」这类必须看懂才敢改的项。
// 这里只做一件事：把 `data-tip` 的元素在**悬停 或 聚焦**时解释一遍，离开就收起。
//
// 边界：
//   * 不拦截点击、不改元素的可访问名称；键盘聚焦时用 aria-describedby 指向同一个气泡，
//     读屏软件读到的与眼睛看到的是同一句话。
//   * 不漏到别的页面：气泡挂在 body 上，滚动/窗口尺寸变化/按下 Esc 立即收起，
//     位置永远是相对元素矩形现算的，不做跨帧缓存的旧坐标。

const DEFAULT_DELAY_MS = 260;
const DEFAULT_OFFSET = 10;
const DEFAULT_MARGIN = 8;

export function createTooltipLayer({
  documentLike = globalThis.document,
  delayMs = DEFAULT_DELAY_MS,
  offset = DEFAULT_OFFSET,
  margin = DEFAULT_MARGIN,
} = {}) {
  if (!documentLike) throw new TypeError('documentLike is required');
  const doc = documentLike;
  const view = doc.defaultView || globalThis;
  const bubbleId = 'ui-tip-bubble';
  let bubble = null;
  let anchor = null;
  // 被接管 aria-describedby 的那个元素与它原本的取值：收起时必须原样还回去。
  let described = null;
  let showTimer = null;
  let hideTimer = null;

  function ensureBubble() {
    if (bubble?.isConnected) return bubble;
    bubble = doc.createElement('div');
    bubble.className = 'ui-tip';
    bubble.id = bubbleId;
    bubble.setAttribute('role', 'tooltip');
    bubble.hidden = true;
    (doc.body || doc.documentElement).appendChild(bubble);
    return bubble;
  }

  function tipOf(element) {
    return String(element?.dataset?.tip || '').trim();
  }

  function anchorOf(target) {
    const element = target?.closest?.('[data-tip]') || null;
    return element && tipOf(element) ? element : null;
  }

  function clearTimer(name) {
    if (name === 'show' && showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (name === 'hide' && hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function place(element) {
    const node = ensureBubble();
    const rect = element.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0, bottom: 0 };
    const width = node.offsetWidth || 0;
    const height = node.offsetHeight || 0;
    const viewportWidth = view?.innerWidth || rect.right || width;
    const viewportHeight = view?.innerHeight || rect.bottom || height;
    const centered = rect.left + rect.width / 2 - width / 2;
    const maxLeft = Math.max(margin, viewportWidth - width - margin);
    const left = Math.min(Math.max(margin, centered), maxLeft);
    // 优先放在元素上方；上方放不下就翻到下方，仍然不出视口。
    const above = rect.top - height - offset;
    const top = above >= margin
      ? above
      : Math.min(rect.bottom + offset, Math.max(margin, viewportHeight - height - margin));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
  }

  function show(element) {
    clearTimer('show');
    clearTimer('hide');
    const text = tipOf(element);
    if (!text) return;
    anchor = element;
    const node = ensureBubble();
    node.textContent = text;
    node.hidden = false;
    place(element);
    node.classList?.add?.('is-visible');
    element.setAttribute?.('data-tip-open', 'true');
    // 键盘聚焦时让读屏软件念同一句解释；鼠标悬停不改可访问名称，避免重复播报。
    describeFocused(element);
  }

  /**
   * 只补一个 id，不覆盖元素原本的 `aria-describedby`：
   * 那些描述（例如开关的「当前是开还是关」）来自页面，比提示更重要。
   */
  function describeFocused(element) {
    const focused = doc.activeElement;
    if (!focused?.setAttribute) return;
    if (!(focused === element || element.contains?.(focused))) return;
    const previous = typeof focused.getAttribute === 'function'
      ? focused.getAttribute('aria-describedby')
      : undefined;
    if (previous && previous.split(/\s+/).includes(bubbleId)) return;
    described = { node: focused, previous: previous ?? null };
    focused.setAttribute('aria-describedby', previous ? `${previous} ${bubbleId}` : bubbleId);
  }

  function undescribe() {
    const target = described;
    described = null;
    if (!target) return;
    if (target.previous == null) target.node.removeAttribute?.('aria-describedby');
    else target.node.setAttribute?.('aria-describedby', target.previous);
  }

  function hide() {
    clearTimer('show');
    clearTimer('hide');
    if (anchor) anchor.removeAttribute?.('data-tip-open');
    anchor = null;
    undescribe();
    if (bubble && !bubble.hidden) {
      bubble.classList?.remove?.('is-visible');
      bubble.hidden = true;
    }
  }

  function scheduleShow(element) {
    clearTimer('hide');
    if (anchor === element && bubble && !bubble.hidden) return;
    hide();
    clearTimer('show');
    showTimer = setTimeout(() => show(element), delayMs);
  }

  function scheduleHide(element) {
    clearTimer('show');
    if (anchor !== element) return;
    clearTimer('hide');
    hideTimer = setTimeout(hide, 60);
  }

  const onPointerOver = event => {
    const element = anchorOf(event.target);
    if (!element) return;
    if (element === anchor) return;
    scheduleShow(element);
  };

  const onPointerOut = event => {
    const element = anchorOf(event.target);
    if (!element) return;
    // 在同一元素的子节点之间移动不算离开。
    if (event.relatedTarget && element.contains?.(event.relatedTarget)) return;
    scheduleHide(element);
  };

  const onFocusIn = event => {
    const element = anchorOf(event.target);
    if (element) show(element);
  };

  const onFocusOut = event => {
    const element = anchorOf(event.target);
    if (element && element === anchor) hide();
  };

  const onKeyDown = event => { if (event.key === 'Escape') hide(); };
  const onViewportChange = () => hide();

  function init() {
    if (typeof doc.addEventListener !== 'function') return api;
    doc.addEventListener('pointerover', onPointerOver);
    doc.addEventListener('pointerout', onPointerOut);
    doc.addEventListener('focusin', onFocusIn);
    doc.addEventListener('focusout', onFocusOut);
    doc.addEventListener('keydown', onKeyDown);
    view?.addEventListener?.('scroll', onViewportChange, true);
    view?.addEventListener?.('resize', onViewportChange);
    return api;
  }

  function destroy() {
    hide();
    clearTimer('show');
    clearTimer('hide');
    doc.removeEventListener?.('pointerover', onPointerOver);
    doc.removeEventListener?.('pointerout', onPointerOut);
    doc.removeEventListener?.('focusin', onFocusIn);
    doc.removeEventListener?.('focusout', onFocusOut);
    doc.removeEventListener?.('keydown', onKeyDown);
    view?.removeEventListener?.('scroll', onViewportChange, true);
    view?.removeEventListener?.('resize', onViewportChange);
    bubble?.remove?.();
    bubble = null;
  }

  const api = Object.freeze({ init, destroy, hide });
  return api;
}
