// reactionConfirm.js — 喜欢 / 不喜欢的确认弹层。
//
// 只做「需要提醒一次」的两种动作，普通收藏不经过这里：
//   1. 这首歌已经在云端歌单里，用户又点了喜欢 —— 先解释一次，再点才真的取消云端收藏。
//   2. 不喜欢 —— 会移出当前播放列表并跳过，属于当场生效、无法撤回的动作。
//
// 为什么不用 toast 代替：这两个动作会改远端歌单或当前队列，不是「知会一句」，
// 需要用户明确点一下；而且弹层自己有焦点收敛与 Esc 取消，键盘用户也能拒绝。
//
// 边界：
//   * 只有调用方确认「云端确实有这首」时才会走到 unlike 分支，文案不替服务端下判断。
//   * 没有弹层元素时返回 false（不替用户做不可逆决定），绝不静默放行。

export const REACTION_CONFIRM_COPY = Object.freeze({
  unlikeAdopted: Object.freeze({
    title: '云端歌单里已有这首',
    copy: '这首歌本来就在你的云端收藏里，Lunara 是读了云端才把心形点亮的。再点一次会取消云端收藏。',
    confirmLabel: '取消云端收藏',
    cancelLabel: '保留',
  }),
  unlikeSynced: Object.freeze({
    title: '取消云端收藏',
    copy: '这首歌已经在你的云端歌单里。确认后会从「我喜欢的音乐」里移出，并且不会再被当成喜欢。',
    confirmLabel: '取消云端收藏',
    cancelLabel: '保留',
  }),
  dislike: Object.freeze({
    title: '不喜欢这首歌',
    copy: '会把它移出当前播放列表并跳过，不修改云端歌单。',
    confirmLabel: '移出并跳过',
    cancelLabel: '取消',
  }),
});

/** 弹层文案：`adopted` 是从云端采纳的喜欢，不是用户在 Lunara 里点的。 */
export function reactionConfirmCopy({ kind = 'unlike', adopted = false } = {}) {
  if (kind === 'dislike') return REACTION_CONFIRM_COPY.dislike;
  return adopted ? REACTION_CONFIRM_COPY.unlikeAdopted : REACTION_CONFIRM_COPY.unlikeSynced;
}

/** 弹层里那一行曲目身份：只写歌名与艺人，不夹带来源猜测。 */
export function reactionTrackLine(track = null) {
  const title = String(track?.title || '').trim();
  if (!title) return '';
  const artist = String(track?.artist || '').trim();
  return artist ? `《${title}》 · ${artist}` : `《${title}》`;
}

export function createReactionConfirm({ documentLike = globalThis.document } = {}) {
  if (!documentLike?.querySelector) throw new TypeError('documentLike is required');
  const doc = documentLike;
  const dialog = () => doc.querySelector('#reaction-confirm') || null;
  const pick = selector => doc.querySelector(selector) || null;
  let settle = null;

  function finish(value) {
    const resolve = settle;
    settle = null;
    resolve?.(value === true);
  }

  function close() {
    const node = dialog();
    if (!node || node.open === false) return;
    if (typeof node.close === 'function') node.close();
    else node.removeAttribute?.('open');
  }

  function confirm({ kind = 'unlike', adopted = false, track = null } = {}) {
    const node = dialog();
    const ok = pick('#reaction-confirm-ok');
    const cancel = pick('#reaction-confirm-cancel');
    // 没有弹层就没有确认能力：宁可什么都不做，也不擅自取消云端收藏或跳过歌曲。
    if (!node || !ok) return Promise.resolve(false);
    const copy = reactionConfirmCopy({ kind, adopted });
    const title = pick('#reaction-confirm-title');
    const copyNode = pick('#reaction-confirm-copy');
    const trackNode = pick('#reaction-confirm-track');
    if (title) title.textContent = copy.title;
    if (copyNode) copyNode.textContent = copy.copy;
    if (trackNode) trackNode.textContent = reactionTrackLine(track);
    ok.textContent = copy.confirmLabel;
    if (cancel) cancel.textContent = copy.cancelLabel;
    node.dataset.reactionConfirmKind = kind;
    // 上一次还没收尾（连点两次、或调用方中途放弃）：先按「取消」结清，避免悬空的 Promise。
    finish(false);
    if (typeof node.showModal === 'function') node.showModal();
    else node.setAttribute?.('open', '');
    ok.focus?.({ preventScroll: true });
    return new Promise(resolve => { settle = resolve; });
  }

  const onOk = () => { finish(true); close(); };
  const onCancel = () => { finish(false); close(); };
  // Esc、点 ✕、外部 close()：一律按「取消」结清。
  const onClose = () => finish(false);

  function init() {
    const node = dialog();
    if (!node) return api;
    pick('#reaction-confirm-ok')?.addEventListener?.('click', onOk);
    pick('#reaction-confirm-cancel')?.addEventListener?.('click', onCancel);
    node.querySelector?.('[data-close-dialog]')?.addEventListener?.('click', onCancel);
    node.addEventListener?.('cancel', event => { event?.preventDefault?.(); onCancel(); });
    node.addEventListener?.('close', onClose);
    return api;
  }

  function destroy() {
    finish(false);
    const node = dialog();
    if (!node) return;
    pick('#reaction-confirm-ok')?.removeEventListener?.('click', onOk);
    pick('#reaction-confirm-cancel')?.removeEventListener?.('click', onCancel);
    node.querySelector?.('[data-close-dialog]')?.removeEventListener?.('click', onCancel);
    node.removeEventListener?.('close', onClose);
  }

  const api = Object.freeze({ init, confirm, destroy, isOpen: () => Boolean(dialog()?.open) });
  return api;
}
