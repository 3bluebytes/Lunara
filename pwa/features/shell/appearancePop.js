// 「外观」浮层：内容与交互只有一份，时间线顶栏和舞台版式（月色 / 素色）的听歌列页眉各放一个触发按钮。
//
// 浮层本体在 index.html 里只有一个（#appearance-pop），由这里的控制器独占。谁来当触发器都只是调用
// open() / toggle()，换布局时由 sync() 统一收起，省得两处各写一份「打开、定位、关掉」的代码，
// 留下没有按钮的孤儿面板。这里只做选择与画选项：选中的结果交给主题 / 材质 / 跟色各自的控制器，
// 本模块不持有偏好，也不碰播放。
import { escapeHtml } from '../chat/chatMarkup.js';

export const MATERIAL_CHOICES = Object.freeze([
  Object.freeze({ id: 'flat', label: '实底' }),
  Object.freeze({ id: 'glass', label: '玻璃' }),
]);

export const BASE_CHOICES = Object.freeze([
  Object.freeze({ id: 'paper', label: '纸白' }),
  Object.freeze({ id: 'indigo', label: '靛蓝' }),
]);

// 跟色只有月色与夜场两个主题读（见 visuals/artworkThemeController.js 的 ARTWORK_THEMES）。
const ARTWORK_THEMES = Object.freeze(['moonlight', 'nocturne']);

/**
 * 「外观」浮层：主题一组，再加当前主题自己那几个快切（夜场材质 / 素色底色 / 跟色开关），
 * 最后一行去设置页看其余外观选项。额外分组只在对应主题出现，别的主题里没有无效操作。
 */
export function appearanceMarkup({ themes = [], theme = '', material = 'flat', base = 'paper', artwork = null } = {}) {
  const radio = (attr, id, label, checked, swatch = false) => `<button type="button" class="appearance-option" role="radio" ${attr}="${escapeHtml(id)}" aria-checked="${checked}" tabindex="${checked ? 0 : -1}">`
    + `${swatch ? '<span class="appearance-swatch" aria-hidden="true"></span>' : ''}<span>${escapeHtml(label)}</span></button>`;
  const group = (capId, cap, options) => `<p class="appearance-cap" id="${capId}">${escapeHtml(cap)}</p>`
    + `<div class="appearance-group" role="radiogroup" aria-labelledby="${capId}">${options}</div>`;
  const themeGroup = group('appearance-theme-cap', '主题',
    themes.map(item => radio('data-look-theme', item.id, item.name, item.id === theme, true)).join(''));
  const materialGroup = theme === 'nocturne'
    ? group('appearance-material-cap', '材质', MATERIAL_CHOICES.map(item => radio('data-look-material', item.id, item.label, item.id === material)).join(''))
    : '';
  const baseGroup = theme === 'modernist'
    ? group('appearance-base-cap', '底色', BASE_CHOICES.map(item => radio('data-look-base', item.id, item.label, item.id === base)).join(''))
    : '';
  // 跟色是开 / 关，不是三选一：用带 aria-pressed 的按钮，和设置页那个开关是同一份状态。
  const artworkGroup = artwork !== null && ARTWORK_THEMES.includes(theme)
    ? `<p class="appearance-cap" id="appearance-artwork-cap">封面跟色</p><div class="appearance-group">`
      + `<button type="button" class="appearance-option" data-look-artwork aria-pressed="${artwork === true}">随歌曲封面变色</button></div>`
    : '';
  return `${themeGroup}${materialGroup}${baseGroup}${artworkGroup}<button type="button" class="appearance-more" data-look-settings>更多外观设置</button>`;
}

/**
 * 浮层控制器。宿主只需要把触发按钮的点击转成 toggle()，并在主题 / 布局变化时调用 sync()。
 * - anchor：浮层贴着触发按钮定位（舞台版式的页眉）；否则沿用 CSS 里的固定定位（时间线顶栏）。
 * - refocus：关闭后把焦点还给触发按钮。宿主重绘过按钮，所以要现取，不能记住旧节点。
 * - beforeOpen：打开前收起宿主自己的其他浮层（顶栏的「全部」）。
 */
export function createAppearancePopover({
  documentLike = globalThis.document,
  appearance,
  getRoot = () => documentLike?.querySelector?.('#appearance-pop'),
  beforeOpen = () => {},
  onOpenChange = () => {},
  onSettings = () => {},
  onError = () => {},
} = {}) {
  let opened = false;
  let anchored = false;
  let openedLayout = null;
  let refocus = null;
  let initialized = false;
  const cleanups = [];
  const anchorCleanups = [];

  const pop = () => getRoot();

  const guard = fn => event => {
    try { return fn(event); } catch (error) { onError(error); return undefined; }
  };

  function render() {
    const node = pop();
    if (!node || !appearance) return;
    node.innerHTML = appearanceMarkup({
      themes: appearance.themes(),
      theme: appearance.theme(),
      material: appearance.material?.() ?? 'flat',
      base: appearance.base?.() ?? 'paper',
      artwork: appearance.artwork ? appearance.artwork() : null,
    });
    // 色点背景走 CSSOM，不写内联 style 属性（与设置页的主题选项一致）。
    for (const option of node.querySelectorAll?.('[data-look-theme]') || []) {
      const swatch = appearance.themes().find(item => item.id === option.dataset.lookTheme)?.swatch;
      if (swatch) option.querySelector?.('.appearance-swatch')?.style?.setProperty?.('--theme-swatch', swatch);
    }
  }

  /** 贴按钮定位：左上角取按钮下沿，右边对齐按钮右沿，视口内收边。 */
  function place() {
    const node = pop();
    const trigger = documentLike?.querySelector?.('#appearance-quick');
    const rect = trigger?.getBoundingClientRect?.();
    if (!node?.style?.setProperty || !rect) return;
    const viewport = documentLike?.defaultView || {};
    const viewportWidth = Number(viewport.innerWidth) || Math.round(rect.right) + 8;
    const viewportHeight = Number(viewport.innerHeight) || 0;
    const height = Number(node.offsetHeight) || 0;
    const right = Math.max(8, Math.round(viewportWidth - rect.right));
    const top = Math.max(8, Math.round(rect.bottom + 8));
    node.style.setProperty('--appearance-top', `${viewportHeight && height ? Math.min(top, Math.round(viewportHeight - height - 8)) : top}px`);
    node.style.setProperty('--appearance-right', `${right}px`);
  }

  function clearPlacement() {
    const style = pop()?.style;
    style?.removeProperty?.('--appearance-top');
    style?.removeProperty?.('--appearance-right');
  }

  // 浮层贴着按钮，页面或列表一滚就得跟着走；不再跟随就收起，别留一个悬空的面板。
  function listenAnchor() {
    const view = documentLike?.defaultView;
    const onMove = () => { if (opened && anchored) place(); };
    documentLike?.addEventListener?.('scroll', onMove, true);
    view?.addEventListener?.('resize', onMove);
    anchorCleanups.push(() => {
      documentLike?.removeEventListener?.('scroll', onMove, true);
      view?.removeEventListener?.('resize', onMove);
    });
  }

  function openPopover({ anchor = false, returnFocus = null } = {}) {
    const node = pop();
    if (!node || !appearance) return;
    beforeOpen();
    opened = true;
    anchored = anchor;
    refocus = returnFocus;
    openedLayout = documentLike?.documentElement?.dataset?.layout || null;
    render();
    node.hidden = false;
    if (anchored) { place(); listenAnchor(); }
    onOpenChange();
    node.querySelector?.('[aria-checked="true"]')?.focus?.();
  }

  function closePopover({ restoreFocus = true } = {}) {
    if (!opened) return;
    opened = false;
    const node = pop();
    if (node) node.hidden = true;
    anchorCleanups.splice(0).forEach(fn => fn());
    if (anchored) clearPlacement();
    anchored = false;
    onOpenChange();
    if (restoreFocus) refocus?.();
    refocus = null;
  }

  function toggle(options = {}) {
    if (opened) closePopover();
    else openPopover(options);
  }

  /** 选项点击：主题 / 材质 / 底色 / 跟色各交给自己的控制器；换主题后重画（分组只在对应主题出现）。 */
  function onClick(event) {
    const target = event.target;
    const themeOption = target?.closest?.('[data-look-theme]');
    const materialOption = target?.closest?.('[data-look-material]');
    const baseOption = target?.closest?.('[data-look-base]');
    const artworkOption = target?.closest?.('[data-look-artwork]');
    let key = null;
    if (themeOption) {
      appearance.setTheme(themeOption.dataset.lookTheme);
      key = `[data-look-theme="${themeOption.dataset.lookTheme}"]`;
    } else if (materialOption) {
      appearance.setMaterial?.(materialOption.dataset.lookMaterial);
      key = `[data-look-material="${materialOption.dataset.lookMaterial}"]`;
    } else if (baseOption) {
      appearance.setBase?.(baseOption.dataset.lookBase);
      key = `[data-look-base="${baseOption.dataset.lookBase}"]`;
    } else if (artworkOption) {
      appearance.setArtwork?.(appearance.artwork?.() !== true);
      key = '[data-look-artwork]';
    } else if (target?.closest?.('[data-look-settings]')) {
      closePopover({ restoreFocus: false });
      onSettings();
      return;
    } else return;
    if (!opened) return; // 换到别的布局：宿主已经 sync 收起浮层。
    render();
    if (anchored) place();
    pop()?.querySelector?.(key)?.focus?.();
  }

  /**
   * 方向键只移动焦点，回车 / 空格（按钮本身的点击）才选中：换到别的布局会收起浮层，
   * 不能让「往旁边看一眼」就把人带出去。Esc 只关浮层，不往下传给别的面板。
   */
  function onKeyDown(event) {
    if (!opened) return;
    if (event.key === 'Escape') {
      event.preventDefault?.();
      closePopover();
      return;
    }
    const option = event.target?.closest?.('[role="radio"]');
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!option || !step) return;
    event.preventDefault?.();
    const group = [...(option.parentElement?.querySelectorAll?.('[role="radio"]') || [])];
    const next = group[(group.indexOf(option) + step + group.length) % group.length];
    for (const item of group) item.tabIndex = item === next ? 0 : -1;
    next?.focus?.();
  }

  function onDocumentClick(event) {
    if (!opened) return;
    const target = event.target;
    // 顶栏点击会重绘按钮，事件冒泡到这里时 target 已脱离文档：不算「点在外面」。
    if (!target?.isConnected) return;
    if (target.closest?.('#appearance-pop, #appearance-quick, #top-bar')) return;
    closePopover({ restoreFocus: false });
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    const listen = (target, type, fn, options) => {
      if (!target) return;
      const wrapped = guard(fn);
      target.addEventListener(type, wrapped, options);
      cleanups.push(() => target.removeEventListener(type, wrapped, options));
    };
    listen(documentLike, 'click', onDocumentClick);
    listen(documentLike, 'keydown', onKeyDown);
    listen(pop(), 'click', onClick);
    return api;
  }

  const api = Object.freeze({
    init,
    open: openPopover,
    close: closePopover,
    toggle,
    isOpen: () => opened,
    /** 主题 / 布局变化后调用：布局没变就重画选项，变了就收起（触发器已经随布局消失）。 */
    sync() {
      if (!opened) return;
      const layout = documentLike?.documentElement?.dataset?.layout || null;
      if (layout !== openedLayout) { closePopover({ restoreFocus: false }); return; }
      render();
      if (anchored) place();
    },
    destroy: () => {
      closePopover({ restoreFocus: false });
      initialized = false;
      cleanups.splice(0).forEach(fn => fn());
    },
  });
  return api;
}
