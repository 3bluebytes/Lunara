// 月色专属的桌面侧栏表现。只持有展开习惯，不拥有导航、会话或播放状态。
// navigate: null = 交还共享导航；false = 只收起，不重复切页；true = 展开后执行原导航。
const BUTTONS = {
  rooms: '#nav-conversations', today: '#nav-today', people: '#nav-people',
  settings: '#nav-settings', recordings: '#recording-review-open', account: '#nav-account',
};
// 底栏设置和窄轨设置是同一导航意图；歌曲整理的 ARIA 留给它自己的工作区。
const ARIA_BUTTONS = [...Object.entries(BUTTONS).filter(([id]) => id !== 'recordings').map(([, selector]) => selector), '#sb-settings-open'];

export function createMoonlightSidebar({ documentLike = document, windowLike = documentLike.defaultView } = {}) {
  const root = documentLike.documentElement;
  const panel = documentLike.querySelector('.conversation-sidebar');
  const viewport = windowLike?.matchMedia?.('(min-width: 961px)');
  let theme = null, expanded = false, lastIcon = 'rooms', previousExpanded = true;
  const desktop = () => theme === 'moonlight' && root.dataset.layout === 'stage' && viewport?.matches !== false;

  function clearAria() {
    for (const selector of ARIA_BUTTONS) {
      const button = documentLike.querySelector(selector);
      button?.removeAttribute('aria-expanded');
      button?.removeAttribute('aria-controls');
    }
  }
  function sync() {
    if (theme !== 'moonlight') return;
    root.dataset.moonlightSidebar = expanded ? 'expanded' : 'collapsed';
    panel?.classList.toggle('expanded', !desktop() || expanded);
    if (!desktop()) { clearAria(); return; }
    for (const selector of ARIA_BUTTONS) {
      const button = documentLike.querySelector(selector);
      button?.setAttribute('aria-expanded', String(expanded));
      button?.setAttribute('aria-controls', 'conversation-sidebar');
    }
  }
  function setTheme(next) {
    if (next === theme) return;
    if (theme === 'moonlight') {
      panel?.classList.toggle('expanded', previousExpanded);
      delete root.dataset.moonlightSidebar;
      clearAria();
    }
    theme = next;
    if (theme === 'moonlight') {
      previousExpanded = Boolean(panel?.classList.contains('expanded'));
      expanded = false;
      lastIcon = 'rooms';
      sync();
    }
  }
  function returnFocus() {
    const active = documentLike.activeElement;
    if (!panel?.contains(active) || active?.closest('.shell-nav-item')) return;
    documentLike.querySelector(BUTTONS[lastIcon] || BUTTONS.rooms)?.focus?.({ preventScroll: true });
  }
  function navigate(icon) {
    if (!desktop()) return null;
    const collapse = expanded && lastIcon === icon;
    lastIcon = icon;
    expanded = !collapse;
    sync();
    if (collapse) returnFocus();
    return !collapse;
  }
  function collapse({ explicit = false } = {}) {
    if (!desktop()) return false;
    // 选会话、打开人物详情等自动收起请求不干扰桌面侧栏；只有明确收起才执行。
    if (explicit) { expanded = false; sync(); returnFocus(); }
    return true;
  }
  function init() {
    setTheme(root.dataset.theme);
    viewport?.addEventListener?.('change', sync);
    return api;
  }
  function destroy() {
    viewport?.removeEventListener?.('change', sync);
    setTheme(null);
  }
  const api = { init, destroy, setTheme, navigate, collapse, isDesktop: desktop };
  return api;
}
