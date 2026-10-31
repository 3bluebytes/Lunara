// 时间线布局的顶栏（只在 data-layout="timeline" 时显示）。
//
// 左侧先是「全部」，竖线隔开后是最近三个聊天标签：下划线 = 正在看，香槟点 = 正在听。点标签只调用 browse（即
// conversationController.select），不切歌。右侧去处把点击转给侧栏里原有的
// #nav-* 按钮，复用同一个 handler。「全部」把原侧栏当浮层打开：列表、搜索、
// 行内菜单、撤销条都是侧栏自己的，这里只管显隐、焦点和 Esc。「外观」只是一个触发按钮：浮层内容、
// 定位和关闭都由 appearancePop.js 独占（舞台版式的页眉用的是同一个浮层），这里只负责画按钮和收起
// 自己的「全部」浮层。
import { escapeHtml } from '../chat/chatMarkup.js';
import { deriveTopBarTabs } from './timelineModel.js';

export const TOP_BAR_DESTINATIONS = Object.freeze([
  Object.freeze({ id: 'today', label: '帐本', nav: '#nav-today' }),
  Object.freeze({ id: 'people', label: '人物', nav: '#nav-people' }),
  Object.freeze({ id: 'settings', label: '设置', nav: '#nav-settings' }),
]);

export const OVERLAY_CLASS = 'top-bar-all-open';

// 轨道点：一像素圆环 + 香槟点（与「正在听」的点同一个颜色 token）。
const ORBIT_MARK = '<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><circle cx="16" cy="16" r="10" fill="none" stroke="currentColor" stroke-width="1.3"/><circle class="top-bar-mark-dot" cx="23.1" cy="8.9" r="3"/></svg>';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function createTopBarView({ controller, store, browse, appearance = null, documentLike = document, onError = () => {} } = {}) {
  const $ = selector => documentLike.querySelector(selector);
  const body = () => documentLike.body;
  const cleanups = [];
  let overlayOpen = false;
  let returnFocus = null;
  let restoreExpanded = null;
  let rendered = '';

  const on = (target, type, fn) => {
    if (!target) return;
    const wrapped = event => {
      try { return Promise.resolve(fn(event)).catch(onError); } catch (error) { onError(error); return undefined; }
    };
    target.addEventListener(type, wrapped);
    cleanups.push(() => target.removeEventListener(type, wrapped));
  };
  const isTimeline = () => documentLike.documentElement?.dataset?.layout === 'timeline';
  const sidebar = () => $('#conversation-sidebar');

  /** 当前页面以侧栏导航按钮的 aria-current 为准：导航状态只有 conversationView 一处。 */
  function currentPage() {
    const match = TOP_BAR_DESTINATIONS.find(item => $(item.nav)?.getAttribute?.('aria-current') === 'page');
    return match ? match.id : 'rooms';
  }

  function markup() {
    const snapshot = controller.snapshot();
    const rooms = snapshot.rooms || [];
    const listeningId = store.getState().runtimeState?.activeListeningSessionId || null;
    const page = currentPage();
    const tabs = deriveTopBarTabs({ rooms, focusedId: snapshot.sessionId, listeningId });
    const tab = item => {
      const label = escapeHtml(controller.roomName(item.room));
      return `<button type="button" class="top-bar-tab" data-top-room="${escapeHtml(item.sessionId)}" aria-current="${item.viewing && page === 'rooms' ? 'page' : 'false'}"${item.listening ? ' data-listening="true"' : ''}>`
        + `${item.listening ? '<span class="top-bar-dot" aria-hidden="true"></span>' : ''}<span class="top-bar-tab-label">${label}</span>`
        + `${item.listening ? '<span class="sr-only">，正在听</span>' : ''}</button>`;
    };
    const focused = rooms.find(room => room.sessionId === snapshot.sessionId);
    const focusedListening = Boolean(focused) && focused.sessionId === listeningId;
    return `<span class="top-bar-mark">${ORBIT_MARK}<span class="sr-only">Lunara</span></span>`
      + `<nav class="top-bar-tabs" aria-label="聊天">`
      + `<button type="button" class="top-bar-all" data-top-all aria-haspopup="dialog" aria-expanded="${overlayOpen}" aria-controls="conversation-sidebar">全部</button>`
      + `<span class="top-bar-sep" aria-hidden="true"></span>${tabs.map(tab).join('')}</nav>`
      + `<span class="top-bar-current">${focusedListening ? '<span class="top-bar-dot" aria-hidden="true"></span>' : ''}<span class="top-bar-tab-label">${focused ? escapeHtml(controller.roomName(focused)) : 'Lunara'}</span>${focusedListening ? '<span class="sr-only">，正在听</span>' : ''}</span>`
      + `<nav class="top-bar-dest" aria-label="去处">${TOP_BAR_DESTINATIONS.map(item => `${item.id === 'settings' ? lookButton() : ''}<button type="button" class="top-bar-dest-item" data-top-dest="${item.id}" aria-current="${page === item.id ? 'page' : 'false'}"${item.id === 'people' ? ` aria-haspopup="dialog" aria-expanded="${overlayOpen && page === 'people'}" aria-controls="conversation-sidebar"` : ''}>${item.label}</button>`).join('')}</nav>`
      + `<button type="button" class="top-bar-menu" data-top-all aria-haspopup="dialog" aria-expanded="${overlayOpen}" aria-controls="conversation-sidebar" aria-label="菜单：去处与全部聊天"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 8h16M4 16h16"/></svg></button>`;
  }

  function lookButton() {
    if (!appearance) return '';
    return `<button type="button" class="top-bar-dest-item top-bar-look" data-top-look aria-haspopup="dialog" aria-expanded="${appearance.isOpen()}" aria-controls="appearance-pop">外观</button>`;
  }

  function render() {
    const bar = $('#top-bar');
    if (!bar) return;
    const active = isTimeline();
    bar.hidden = !active;
    const personSwitch = $('#person-detail-switch');
    if (personSwitch) {
      personSwitch.hidden = !active;
      personSwitch.setAttribute('aria-expanded', String(overlayOpen && currentPage() === 'people'));
    }
    if (!active) {
      if (overlayOpen) closeOverlay({ restoreFocus: false });
      // 「外观」浮层不在这里收：它归 appearancePop 所有，换版式时由它自己的 sync() 收起，
      // 舞台版式也要用同一个浮层，这里关会把别人的面板一起关掉。
      rendered = '';
      return;
    }
    const html = markup();
    if (html === rendered) return;
    // 重绘会换掉按钮节点：记住焦点所在的标签/去处，画完放回同一个位置。
    const focusedKey = documentLike.activeElement?.closest?.('#top-bar') ? focusKey(documentLike.activeElement) : null;
    bar.innerHTML = html;
    rendered = html;
    if (focusedKey) bar.querySelector?.(focusedKey)?.focus?.();
  }

  function focusKey(element) {
    if (element.dataset?.topRoom) return `[data-top-room="${element.dataset.topRoom}"]`;
    if (element.dataset?.topDest) return `[data-top-dest="${element.dataset.topDest}"]`;
    if (element.dataset?.topLook != null) return '[data-top-look]';
    if (element.classList?.contains?.('top-bar-menu')) return '.top-bar-menu';
    if (element.classList?.contains?.('top-bar-all')) return '.top-bar-all';
    return null;
  }

  function openOverlay(trigger) {
    if (!isTimeline()) return;
    const panel = sidebar();
    if (!panel) return;
    appearance?.close?.({ restoreFocus: false });
    // 「全部」看的是聊天：从人物列表进来时先回到聊天列表（人物是侧栏里的另一种列表，不是工作页）。
    if (trigger?.classList?.contains?.('top-bar-all') && currentPage() === 'people') $('#nav-conversations')?.click?.();
    overlayOpen = true;
    returnFocus = trigger || null;
    // 浮层要显示完整列表；侧栏原来的展开/收起状态只是暂借，关闭时还原。
    restoreExpanded = panel.classList.contains('expanded');
    panel.classList.add('expanded');
    panel.inert = false;
    body().classList.add(OVERLAY_CLASS);
    rendered = '';
    render();
    const target = currentPage() === 'people' ? panel.querySelector?.('#people-list button') || $('#people-list-create') : $('#room-search');
    (target || panel.querySelector?.(FOCUSABLE))?.focus?.();
  }

  function closeOverlay({ restoreFocus = true } = {}) {
    if (!overlayOpen) return;
    overlayOpen = false;
    body().classList.remove(OVERLAY_CLASS);
    const panel = sidebar();
    if (panel && restoreExpanded != null) panel.classList.toggle('expanded', restoreExpanded);
    restoreExpanded = null;
    rendered = '';
    render();
    if (restoreFocus) {
      const key = returnFocus ? focusKey(returnFocus) : '.top-bar-all';
      const target = key ? $('#top-bar')?.querySelector?.(key) : returnFocus;
      (target || returnFocus || $('#top-bar')?.querySelector?.('.top-bar-all'))?.focus?.();
    }
    returnFocus = null;
  }

  function toggleOverlay(trigger) {
    if (overlayOpen) closeOverlay();
    else openOverlay(trigger);
  }

  function onBarClick(event) {
    const room = event.target?.closest?.('[data-top-room]');
    if (room) {
      closeOverlay({ restoreFocus: false });
      return browse(room.dataset.topRoom);
    }
    const all = event.target?.closest?.('[data-top-all]');
    if (all) return toggleOverlay(all);
    const look = event.target?.closest?.('[data-top-look]');
    // 关闭后按现取的节点还焦点：重绘会换掉这个按钮节点。
    if (look) return appearance.toggle({ returnFocus: () => $('#top-bar')?.querySelector?.('[data-top-look]')?.focus?.() });
    const dest = event.target?.closest?.('[data-top-dest]');
    if (dest) {
      const item = TOP_BAR_DESTINATIONS.find(entry => entry.id === dest.dataset.topDest);
      // 已在人物页时只开关列表，不能再触发旧导航把资料重置成第一位。
      if (item?.id === 'people' && currentPage() === 'people') return toggleOverlay(dest);
      closeOverlay({ restoreFocus: false });
      $(item?.nav)?.click?.();
      rendered = '';
      render();
      // 自动展开的第一位资料不是人物列表的替代入口；页面打开后仍显示所有伙伴与新增入口。
      if (item?.id === 'people') openOverlay(dest);
    }
    return undefined;
  }

  function trapFocus(event) {
    const panel = sidebar();
    const items = [...(panel?.querySelectorAll?.(FOCUSABLE) || [])].filter(item => item.offsetParent !== null || item === documentLike.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items.at(-1);
    const inside = panel.contains?.(documentLike.activeElement);
    if (event.shiftKey && (documentLike.activeElement === first || !inside)) { event.preventDefault(); last.focus?.(); }
    else if (!event.shiftKey && (documentLike.activeElement === last || !inside)) { event.preventDefault(); first.focus?.(); }
  }

  function onKeyDown(event) {
    // 「外观」浮层的 Esc 由 appearancePop 自己处理（它可能挂在别的版式上）。
    // 人物详情是非模态页面，不该吞掉列表的 Esc；创建/删除等真正的上层面板仍优先。
    if (!overlayOpen || documentLike.querySelector?.('dialog[open]:not(#person-detail)')) return;
    if (event.key === 'Tab') return trapFocus(event);
    if (event.key !== 'Escape') return;
    // 行内「更多」菜单、对话框各自处理 Esc；只有浮层是最上层时才关浮层。
    if (!$('#room-row-menu')?.hidden) return;
    event.preventDefault();
    closeOverlay();
  }

  function onDocumentClick(event) {
    const target = event.target;
    // 顶栏点击会重绘按钮，事件冒泡到这里时 target 已脱离文档：不算「点在外面」。
    if (!target?.isConnected) return;
    if (!overlayOpen) return;
    if (target.closest?.('#conversation-sidebar, #top-bar, #room-row-menu, #person-detail-switch, dialog:not(#person-detail)')) return;
    closeOverlay({ restoreFocus: false });
  }

  function init() {
    on($('#top-bar'), 'click', onBarClick);
    on($('#person-detail-switch'), 'click', () => {
      if (!isTimeline()) return;
      if (currentPage() !== 'people') $('#nav-people')?.click?.();
      toggleOverlay($('#person-detail-switch'));
    });
    on($('#people-list-create'), 'click', () => closeOverlay({ restoreFocus: false }));
    on(documentLike, 'keydown', onKeyDown);
    on(documentLike, 'click', onDocumentClick);
    // 在浮层里点开一个聊天或一位伙伴：打开由侧栏自己的处理器完成，这里只收起浮层。
    on($('#room-list'), 'click', event => {
      if (overlayOpen && event.target?.closest?.('[data-room]')) closeOverlay({ restoreFocus: false });
    });
    on($('#people-list'), 'click', event => {
      if (overlayOpen && event.target?.closest?.('[data-person]')) {
        closeOverlay({ restoreFocus: false });
        if ($('#person-detail')?.open) $('#person-detail-name')?.focus?.();
      }
    });
    cleanups.push(controller.subscribe(render));
    cleanups.push(store.subscribe((next, previous) => {
      if (next.runtimeState?.activeListeningSessionId !== previous.runtimeState?.activeListeningSessionId) render();
    }));
    // 导航页由侧栏按钮的 aria-current 表达；其他入口（返回聊天等）改它时同步下划线。
    const Observer = documentLike.defaultView?.MutationObserver;
    if (Observer) {
      const observer = new Observer(() => render());
      for (const item of [...TOP_BAR_DESTINATIONS.map(entry => entry.nav), '#nav-conversations']) {
        const node = $(item);
        if (node) observer.observe(node, { attributes: true, attributeFilter: ['aria-current'] });
      }
      cleanups.push(() => observer.disconnect());
    }
    render();
    return api;
  }

  const api = Object.freeze({
    init,
    render,
    /** 主题 / 布局变化后调用：切出 timeline 时收起浮层并隐藏顶栏。 */
    sync: () => { rendered = ''; render(); },
    openOverlay,
    closeOverlay,
    isOverlayOpen: () => overlayOpen,
    isAppearanceOpen: () => Boolean(appearance?.isOpen?.()),
    destroy: () => cleanups.splice(0).forEach(fn => fn()),
  });
  return api;
}
