// sourceMenu.js — 左下角唯一的「音乐源」入口与它的浮窗。
//
// 为什么集中成一个入口：账号区同时并排两个源时，加第三个源就要再挤一行；而
// 「哪个源能用、为什么不能用」需要一行解释，行内塞不下。集中之后账号区是一个
// 按钮，状态在小浮窗里说清楚（登录态来自 authController，临时故障来自设置快照
// 的 stateText —— 原因码不直接抛给用户）。
//
// 边界：只读快照与展示，不写播放、不改设置。登录/退出仍由既有 authView 负责，
// 本模块只负责浮窗的开合、状态文案与键盘收起。

const SOURCE_ORDER = ['ncm', 'qq'];

export function initSourceMenu({
  documentLike = globalThis.document,
  settingsController = null,
  onOpen = () => {},
} = {}) {
  const launcher = documentLike.querySelector('#source-menu-open');
  const menu = documentLike.querySelector('#source-menu');
  const label = documentLike.querySelector('#source-menu-label');
  if (!launcher || !menu) return { refresh() {}, destroy() {} };
  let open = false;
  let stateTexts = new Map();
  let unsubscribe = null;

  function applyStateTexts() {
    for (const source of SOURCE_ORDER) {
      const row = documentLike.querySelector(`#sb-account-${source}`);
      if (!row) continue;
      let node = row.querySelector('.sb-src-state');
      const text = stateTexts.get(source) || '';
      // 有故障说明时隐藏那行纯源名，否则会出现「QQ 音乐 / QQ 音乐需要会员」两行重复。
      row.classList.toggle('has-src-state', Boolean(text));
      if (!text) {
        node?.remove();
        continue;
      }
      if (!node) {
        node = documentLike.createElement('span');
        node.className = 'sb-src-state';
        row.appendChild(node);
      }
      node.textContent = text;
    }
    // 入口本身只表达「有几个源在等你处理」，不显示数量：有故障时加一个状态点。
    const hasTrouble = SOURCE_ORDER.some(source => stateTexts.get(source));
    launcher.classList.toggle('needs-attention', hasTrouble);
    if (label) label.textContent = '音乐源';
  }

  function applySnapshot(snapshot) {
    const sources = snapshot?.options?.source || [];
    stateTexts = new Map(sources
      .filter(source => source && source.ready !== false && source.stateText)
      .map(source => [source.id, String(source.stateText)]));
    applyStateTexts();
  }

  function setOpen(next) {
    open = Boolean(next);
    menu.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    launcher.classList.toggle('open', open);
    if (!open) return;
    onOpen();
    applyStateTexts();
  }

  function close({ restoreFocus = false } = {}) {
    if (!open) return;
    setOpen(false);
    if (restoreFocus) launcher.focus({ preventScroll: true });
  }

  function click(event) {
    if (launcher.contains(event.target)) {
      event.preventDefault();
      setOpen(!open);
      return;
    }
    // 点浮窗里的登录/退出按钮后收起：动作已经切到二维码或已登出，浮窗留在屏幕上只会挡住结果。
    const action = event.target.closest?.('.sb-account-btn, .sb-acc-logout');
    if (action && menu.contains(action)) close();
  }

  function clickOutside(event) {
    if (!open || menu.contains(event.target) || launcher.contains(event.target)) return;
    close();
  }

  function keydown(event) {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    close({ restoreFocus: true });
  }

  launcher.addEventListener('click', click);
  menu.addEventListener('click', click);
  documentLike.addEventListener('click', clickOutside);
  documentLike.addEventListener('keydown', keydown);

  if (settingsController?.subscribe) {
    unsubscribe = settingsController.subscribe(applySnapshot);
    applySnapshot(settingsController.getSnapshot());
  }

  return {
    refresh() {
      if (settingsController?.getSnapshot) applySnapshot(settingsController.getSnapshot());
    },
    close,
    destroy() {
      launcher.removeEventListener('click', click);
      menu.removeEventListener('click', click);
      documentLike.removeEventListener('click', clickOutside);
      documentLike.removeEventListener('keydown', keydown);
      unsubscribe?.();
    },
  };
}
