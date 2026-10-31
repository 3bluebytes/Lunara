import { applyQuoteToDraft } from './chatQuote.js';

export function createChatInputView({
  compose = null,
  input,
  sendButton,
  hint = null,
  hintText = null,
  mentionMenu = null,
  onSubmit,
  onCancel = () => {},
  onWarmAudio = () => {},
} = {}) {
  if (!input || !sendButton || typeof onSubmit !== 'function') {
    throw new TypeError('chat input view dependencies are required');
  }
  const cleanups = [];
  let initialized = false;
  let locked = false;
  let pending = false;
  const lockSources = new Set();
  let composing = false;
  let mentionCandidates = [];
  let mentionMenuEl = mentionMenu;
  let mentionItems = [];
  let mentionIndex = -1;
  let mentionRange = null;
  let mentionOpen = false;

  function listen(element, type, listener) {
    element.addEventListener(type, listener);
    cleanups.push(() => element.removeEventListener(type, listener));
  }

  /**
   * 输入条随内容增高：单行起步，长草稿折行长高，超过 CSS max-height 后内部滚动。
   * 只依赖 style 与 scrollHeight，测试替身缺少这两个字段时静默无操作。
   */
  function syncSize() {
    const style = input?.style;
    if (!style || typeof input.scrollHeight !== 'number') return;
    style.height = 'auto';
    const measured = input.scrollHeight;
    style.height = measured > 0 ? `${measured}px` : '';
  }

  /** 插入提示让外层（草稿保存、提及菜单）知道内容变了，不依赖具体事件实现。 */
  function notifyInput() {
    const doc = input?.ownerDocument || compose?.ownerDocument || null;
    const EventCtor = doc?.defaultView?.Event || globalThis.Event;
    input.dispatchEvent?.(new EventCtor('input', { bubbles: true }));
  }

  /**
   * 「引用」（add-chat-message-quote）：把一条消息的引用块写到草稿顶部，原有草稿留在下面。
   * 引用只是可编辑文本，不另存引用状态；锁定态（媒体交付中）不写入。
   */
  function insertQuote(quoteText = '') {
    if (locked) return false;
    const next = applyQuoteToDraft(input.value, quoteText);
    if (next === input.value) return false;
    input.value = next;
    syncSize();
    input.focus?.();
    const caret = next.length;
    input.setSelectionRange?.(caret, caret);
    notifyInput();
    return true;
  }

  function submit() {
    if (locked) return;
    closeMentions();
    const value = input.value;
    input.value = '';
    syncSize();
    onWarmAudio();
    void onSubmit(value);
  }

  function setLocked(nextLocked, message = '', { source = 'media' } = {}) {
    const wasLocked = locked;
    if (nextLocked) lockSources.add(source); else lockSources.delete(source);
    locked = lockSources.size > 0;
    const changed = wasLocked !== locked;
    compose?.classList?.toggle('locked', locked);
    input.disabled = locked;
    sendButton.disabled = locked;
    if (message && hintText) hintText.textContent = message;
    hint?.classList?.toggle('visible', locked || pending);
    if (changed && !locked) input.focus?.();
  }

  function setPending(nextPending, message = '') {
    pending = Boolean(nextPending);
    compose?.classList?.toggle('pending', pending);
    sendButton.classList?.toggle('stop', pending);
    sendButton.setAttribute?.('aria-label', pending ? '停止回复' : '发送');
    sendButton.title = pending ? '停止这轮回复；已安排的歌曲不会撤回' : '发送消息';
    if (message && hintText) hintText.textContent = message;
    hint?.classList?.toggle('visible', locked || pending);
  }

  function mentionDocument() {
    return input?.ownerDocument || compose?.ownerDocument || null;
  }

  function ensureMentionMenu() {
    if (mentionMenuEl || !compose) return mentionMenuEl;
    const doc = mentionDocument();
    if (!doc?.createElement || typeof compose.appendChild !== 'function') return null;
    mentionMenuEl = doc.createElement('div');
    mentionMenuEl.className = 'compose-suggest';
    mentionMenuEl.id = 'compose-suggest';
    mentionMenuEl.setAttribute('role', 'listbox');
    mentionMenuEl.setAttribute('aria-label', '提及伙伴');
    mentionMenuEl.hidden = true;
    compose.appendChild(mentionMenuEl);
    return mentionMenuEl;
  }

  function closeMentions() {
    mentionOpen = false;
    mentionRange = null;
    mentionIndex = -1;
    mentionItems = [];
    if (mentionMenuEl) mentionMenuEl.hidden = true;
    input?.setAttribute?.('aria-expanded', 'false');
  }

  function renderMentions() {
    const menu = ensureMentionMenu();
    if (!menu) return;
    const doc = menu.ownerDocument || mentionDocument();
    menu.textContent = '';
    mentionItems.forEach((candidate, index) => {
      const button = doc.createElement('button');
      button.type = 'button';
      button.id = `compose-mention-${index}`;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(index === mentionIndex));
      button.dataset.mention = candidate.id;
      if (candidate.color) button.style.setProperty?.('--person-color', candidate.color);
      const dot = doc.createElement('span');
      dot.className = 'identity-dot';
      dot.setAttribute('aria-hidden', 'true');
      button.appendChild(dot);
      const label = doc.createElement('span');
      label.textContent = `@${candidate.name}`;
      button.appendChild(label);
      button.addEventListener('mousedown', event => event.preventDefault?.());
      button.addEventListener('click', event => { event.preventDefault?.(); insertMention(index); });
      menu.appendChild(button);
    });
    menu.hidden = false;
    input?.setAttribute?.('aria-expanded', 'true');
    input?.setAttribute?.('aria-controls', 'compose-suggest');
    input?.setAttribute?.('aria-activedescendant', mentionItems.length ? `compose-mention-${mentionIndex}` : '');
  }

  function updateMentions() {
    if (locked || composing || !mentionCandidates.length) { closeMentions(); return; }
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const match = before.match(/(?:^|\s)@([^\s@]*)$/u);
    if (!match) { closeMentions(); return; }
    const query = match[1].toLocaleLowerCase();
    const items = mentionCandidates.filter(candidate => {
      const name = String(candidate.name || '').toLocaleLowerCase();
      return !query || name.includes(query) || String(candidate.id || '').toLocaleLowerCase().includes(query);
    }).slice(0, 6);
    if (!items.length) { closeMentions(); return; }
    mentionRange = { start: caret - match[1].length - 1, end: caret };
    mentionItems = items;
    mentionIndex = Math.max(0, Math.min(mentionIndex, items.length - 1));
    mentionOpen = true;
    renderMentions();
  }

  function insertMention(index = mentionIndex) {
    const candidate = mentionItems[index];
    if (!candidate || !mentionRange) return;
    const mention = `@${candidate.name} `;
    input.value = input.value.slice(0, mentionRange.start) + mention + input.value.slice(mentionRange.end);
    const caret = mentionRange.start + mention.length;
    closeMentions();
    input.focus?.();
    input.setSelectionRange?.(caret, caret);
    syncSize();
    notifyInput();
  }

  function moveMention(delta) {
    if (!mentionOpen || !mentionItems.length) return;
    mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
    renderMentions();
  }

  function buttonAction() {
    if (locked) return;
    if (pending) { onCancel(); return; }
    submit();
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    listen(sendButton, 'click', buttonAction);
    listen(input, 'compositionstart', () => { composing = true; closeMentions(); });
    listen(input, 'compositionend', () => { composing = false; syncSize(); updateMentions(); });
    listen(input, 'input', () => { syncSize(); updateMentions(); });
    listen(input, 'blur', () => { setTimeout(() => closeMentions(), 0); });
    listen(input, 'keydown', event => {
      if (mentionOpen && !composing && !event.isComposing) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveMention(event.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          insertMention();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeMentions();
          return;
        }
      }
      if (event.key !== 'Enter' || event.shiftKey || composing || event.isComposing || locked) return;
      event.preventDefault();
      submit();
    });
    input.setAttribute?.('aria-autocomplete', 'list');
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    cleanups.splice(0).forEach(cleanup => cleanup());
  }

  function setMentionCandidates(list = []) {
    mentionCandidates = (Array.isArray(list) ? list : [])
      .map(item => ({ id: String(item?.id || ''), name: String(item?.name || '').trim(), color: item?.color || '' }))
      .filter(item => item.id && item.name).slice(0, 12);
    if (!mentionCandidates.length) closeMentions();
    else if (mentionOpen) updateMentions();
  }

  const api = Object.freeze({ init, destroy, setLocked, setPending, setMentionCandidates, syncSize, insertQuote, isLocked: () => locked });
  return api;
}
