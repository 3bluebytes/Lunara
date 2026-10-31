/**
 * 播放器传输的键盘入口：只回答「这次按键要不要动作、动作是哪一个」。
 *
 * 动作本身（播放/暂停）由播放器视图注入，因为键盘和播放条按钮必须走同一份行为：
 * 这些判断复写第二份必然与按钮分叉。
 *
 * 关于让路：这里**只**给文本输入让路。按钮、链接、歌曲卡、推拉门把手都不让——
 * 鼠标点过的元素会保留焦点，如果让它们拥有空格，空格就退化成「再点一次刚才那个
 * 按钮」（想暂停却把会话收起、想暂停却又点了一次歌卡）。按钮的标准激活键仍是
 * Enter，所以键盘用户不会因此无法操作。
 */

/** 文本输入：空格与方向键在这里属于编辑，播放器完全让路。 */
const TEXT_ENTRY_SELECTOR = [
  'input', 'textarea', 'select', '[role="textbox"]',
  '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
].join(', ');

function matches(target, selector) {
  return typeof target?.closest === 'function' && Boolean(target.closest(selector));
}

/** isContentEditable 覆盖嵌套在可编辑容器里的子元素；选择器覆盖显式声明的容器。 */
function isTextEntry(target) {
  return target?.isContentEditable === true || matches(target, TEXT_ENTRY_SELECTOR);
}

function isSpaceKey(event) {
  return event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar';
}

/**
 * 按键 → 动作名（当前只有 `'toggle'`），不适用时返回 null。
 * 依赖的字段全都取自 KeyboardEvent，可在测试里用普通对象替身。
 */
export function resolveTransportShortcut(event) {
  if (!event || event.defaultPrevented === true) return null;
  // IME 组字中的按键属于输入法；keyCode 229 是没有 isComposing 的浏览器的旧信号。
  if (event.isComposing === true || event.keyCode === 229) return null;
  // 系统组合键（复制/切换标签页/菜单加速键）不属于播放器。
  if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return null;
  // 按住不放不允许连发播放动作：暂停/恢复必须是单次意图。
  if (event.repeat === true) return null;
  // `Shift + Space` 留给可滚动阅读区（向上翻页），因此只认裸空格。
  if (event.shiftKey === true) return null;
  if (!isSpaceKey(event)) return null;
  if (isTextEntry(event.target)) return null;
  return 'toggle';
}

/**
 * 在 document 上挂 keydown 监听并返回清理函数。
 * `isEnabled` 为假时整批让路（例如播放条被整页工作台隐藏）：不消费、不拦默认行为。
 * 只有真正被消费的按键才 `preventDefault()`——这里正是靠它阻止「再点一次刚才
 * 那个按钮」，而不是靠退出焦点。
 *
 * 另一个副作用也要处理：鼠标点过的元素保留焦点，而**按下任意键**会让浏览器把输入
 * 模态切回键盘，:focus-visible 随之把那个元素框出来（听歌区那个金框就是这么来的）。
 * 空格属于播放器，不该在页面上留下这种「键盘焦点」痕迹，所以消费空格时把指针焦点
 * 摘掉；键盘 Tab 过来的焦点不受影响，焦点环照常出现。
 */
export function installTransportShortcuts({ documentLike = globalThis.document, handlers = {}, isEnabled } = {}) {
  if (typeof documentLike?.addEventListener !== 'function') return () => {};
  let pointerFocused = null;
  const rememberPointerFocus = event => { pointerFocused = event?.target || null; };
  documentLike.addEventListener('pointerdown', rememberPointerFocus, true);
  const dropPointerFocus = () => {
    const active = documentLike.activeElement;
    const same = Boolean(active) && (active === pointerFocused || active.contains?.(pointerFocused) === true);
    pointerFocused = null;
    if (!same || isTextEntry(active)) return;
    active.blur?.();
  };
  const listener = event => {
    if (typeof isEnabled === 'function' && !isEnabled()) return;
    const action = resolveTransportShortcut(event);
    if (!action) return;
    const handler = handlers[action];
    if (typeof handler !== 'function') return;
    event.preventDefault?.();
    dropPointerFocus();
    handler(event);
  };
  documentLike.addEventListener('keydown', listener);
  return () => {
    documentLike.removeEventListener?.('keydown', listener);
    documentLike.removeEventListener?.('pointerdown', rememberPointerFocus, true);
  };
}
