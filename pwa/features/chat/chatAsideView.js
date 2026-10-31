// 聊天条「听」态的右栏：最近一张推荐卡片的镜像（时间线布局，≥961px 才显示，见 timeline.css）。
//
// 卡片本体仍在消息里，由 chatController.bindRecommendation 绑定、提交和改写文案；这里只照着它显示，
// 「放这首」的点击转给原按钮，提交路径只有一条。推荐 ≠ 播放：放这首只是排到这首之后。
// 右栏结构只建一次，之后只改文字和属性，播报结果的 role="status" 节点不会被换掉。

const text = (root, selector) => (root.querySelector?.(selector)?.textContent || '').trim();

/** 从消息里的 .chat-recommendation 读出要显示的内容；没有卡片时返回 null。 */
export function readRecommendation(card) {
  if (!card) return null;
  const button = card.querySelector?.('.chat-recommendation-accept') || null;
  return {
    state: card.dataset?.state || 'expired',
    title: text(card, '.chat-recommendation-title'),
    artist: text(card, '.chat-recommendation-artist'),
    note: text(card, '.chat-recommendation-note'),
    action: button ? {
      turnId: button.dataset?.recommendationTurn || '',
      label: (button.textContent || '').trim(),
      ariaLabel: button.getAttribute?.('aria-label') || '',
      disabled: button.getAttribute?.('aria-disabled') === 'true',
      busy: button.getAttribute?.('aria-busy') === 'true',
    } : null,
  };
}

const SKELETON = '<div class="chat-aside-card"><span class="chat-aside-song"><span class="chat-aside-title"></span><span class="chat-aside-artist"></span></span>'
  + '<button type="button" class="chat-aside-accept">放这首</button></div>'
  + '<p class="chat-aside-note" role="status" aria-live="polite"></p>';

export function createChatAsideView({ documentLike = document, onError = () => {} } = {}) {
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let parts = null;
  let current = null;

  function originalButton(turnId) {
    const buttons = $('#chat-list')?.querySelectorAll?.('[data-recommendation-turn]') || [];
    return [...buttons].find(button => button.dataset?.recommendationTurn === turnId) || null;
  }

  function sync() {
    const aside = $('#chat-aside');
    const list = $('#chat-list');
    if (!aside || !list || !parts) return;
    const cards = list.querySelectorAll?.('.chat-recommendation') || [];
    current = readRecommendation(cards[cards.length - 1] || null);
    aside.hidden = !current;
    if (!current) return;
    aside.dataset.state = current.state;
    parts.title.textContent = current.title;
    parts.artist.textContent = current.artist;
    parts.artist.hidden = !current.artist;
    if (parts.note.textContent !== current.note) parts.note.textContent = current.note;
    const { button } = parts;
    button.hidden = !current.action;
    if (!current.action) return;
    button.textContent = current.action.label || '放这首';
    button.setAttribute('aria-label', current.action.ariaLabel);
    button.setAttribute('aria-disabled', String(current.action.disabled));
    button.setAttribute('aria-busy', String(current.action.busy));
  }

  function onAccept() {
    const turnId = current?.action?.turnId;
    if (turnId) originalButton(turnId)?.click?.();
  }

  function init() {
    const aside = $('#chat-aside');
    const list = $('#chat-list');
    if (!aside || !list) return api;
    aside.innerHTML = SKELETON;
    parts = {
      title: aside.querySelector('.chat-aside-title'),
      artist: aside.querySelector('.chat-aside-artist'),
      button: aside.querySelector('.chat-aside-accept'),
      note: aside.querySelector('.chat-aside-note'),
    };
    const click = () => { try { onAccept(); } catch (error) { onError(error); } };
    parts.button.addEventListener('click', click);
    cleanups.push(() => parts.button.removeEventListener('click', click));
    // 原卡片的状态（安排中、已排、过期）都写在消息 DOM 上：观察消息列表即可跟上，不另起状态。
    const Observer = documentLike.defaultView?.MutationObserver;
    if (Observer) {
      const observer = new Observer(() => { try { sync(); } catch (error) { onError(error); } });
      observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-state', 'aria-disabled', 'aria-busy', 'aria-label'] });
      cleanups.push(() => observer.disconnect());
    }
    sync();
    return api;
  }

  const api = Object.freeze({
    init,
    sync,
    destroy: () => cleanups.splice(0).forEach(fn => fn()),
  });
  return api;
}
