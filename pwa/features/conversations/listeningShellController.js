const NOOP = () => {};
const KEYBOARD_MIN_PX = 150;

export function formatListeningMoment(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return {
    time,
    date: `${date.getMonth() + 1}月${date.getDate()}日 ${weekdays[date.getDay()]} · 把这一刻留给音乐`,
  };
}

export function createListeningShellController({
  appElement,
  documentLike = globalThis.document,
  windowLike = globalThis.window,
  beforePresentationChange = NOOP,
  now = () => new Date(),
} = {}) {
  if (!appElement) throw new TypeError('listening shell app element is required');
  const cleanups = [];
  let initialized = false;
  let mobilePane = 'listen';
  let previousPane = 'listen';
  let focusMode = false;
  let focusBeforeMode = null;
  let chatFocusEnabled = false;
  let clockTimer = null;
  let playerObserver = null;

  const $ = selector => documentLike.querySelector(selector);
  const narrow = () => Boolean(windowLike?.matchMedia?.('(max-width: 960px)').matches);
  const bind = (element, type, listener) => {
    if (!element) return;
    element.addEventListener(type, listener);
    cleanups.push(() => element.removeEventListener(type, listener));
  };

  function syncVisualViewport() {
    const viewport = windowLike?.visualViewport;
    const height = Number(viewport?.height || windowLike?.innerHeight);
    if (!Number.isFinite(height) || height <= 0 || !appElement.style?.setProperty) return;
    appElement.style.setProperty('--shell-viewport-height', `${Math.round(height)}px`);
    appElement.style.setProperty('--shell-viewport-offset', `${Math.round(Number(viewport?.offsetTop) || 0)}px`);
    // 可视区比窗口矮出一大截才算软键盘弹出（地址栏伸缩只差几十像素）；窄屏据此收起播放条和分页切换。
    const covered = Number(windowLike?.innerHeight) - height;
    appElement.classList?.toggle?.('keyboard-open', Boolean(viewport) && covered > KEYBOARD_MIN_PX);
  }

  function syncClock() {
    const moment = formatListeningMoment(now());
    const clock = $('#listening-clock');
    const date = $('#listening-date');
    if (clock) clock.textContent = moment.time;
    if (date) date.textContent = moment.date;
  }

  /**
   * 天气角标：环境事件的纯展示反馈。未设置位置或天气不可用时隐藏，
   * 不残留上一个城市的数据。此元素不参与任何播放交互。
   */
  function syncEnvironment(environment) {
    const badge = $('#listening-weather');
    if (!badge) return;
    const data = environment && typeof environment === 'object' ? environment : null;
    if (!data?.available || !data.cityName) {
      badge.hidden = true;
      badge.textContent = '';
      return;
    }
    const parts = [data.cityName, data.summaryZh].filter(Boolean);
    if (Number.isFinite(data.tempC)) parts.push(`${Math.round(data.tempC)}°`);
    badge.textContent = parts.join(' · ');
    badge.hidden = false;
  }

  /**
   * 播放栏实际占位高度：面板底部预留空间跟随播放栏真实高度，
   * 而不是按 --studio-player-height 最小值猜——推荐语、恢复提示、状态行
   * 变高时队列最后一首不再被播放栏压住拖不出来。
   */
  function syncPlayerReserve() {
    const player = $('.persistent-player');
    if (!player || !appElement.style?.setProperty) return;
    const height = Math.round(player.getBoundingClientRect().height);
    if (Number.isFinite(height) && height > 0) {
      appElement.style.setProperty('--player-actual-height', `${height}px`);
    }
  }

  /**
   * 聊天聚焦态（≥961px 的纯表现层模式）：听歌列收成封面条、聊天列变阅读列。
   * 只切 class，不触碰播放；专注聆听或窄屏时自动失效，不持久化。
   */
  function chatFocusActive() {
    return chatFocusEnabled && !focusMode && !narrow();
  }

  // 同一个按钮是门框的真实子节点：常规态归聊天门，展开态归聆听门。
  // 原内容面板继续负责裁切/滚动，外壳负责凸部与整块层叠；不再测量全局列缝。
  function syncHandleOwner() {
    const toggle = $('#chat-focus-toggle');
    const owner = $(chatFocusActive() ? '#listening-door' : '#chat-door');
    if (!toggle || !owner || toggle.parentElement === owner) return;
    const focused = documentLike.activeElement === toggle;
    owner.appendChild(toggle);
    if (focused) toggle.focus({ preventScroll: true });
  }
  function render() {
    appElement.classList.toggle('mobile-listen-pane', mobilePane === 'listen');
    appElement.classList.toggle('mobile-chat-pane', mobilePane === 'chat');
    appElement.classList.toggle('focus-mode', focusMode);
    appElement.classList.toggle('chat-focus', chatFocusActive());
    syncHandleOwner();
    const chatToggle = $('#chat-focus-toggle');
    chatToggle?.setAttribute('aria-pressed', String(chatFocusActive()));
    chatToggle?.setAttribute('aria-label', chatFocusActive() ? '展开听歌列' : '收起听歌列，进入聊天聚焦');
    // 时间线布局里把手带文字（参考稿「展开看全部」/「收起 ESC」）；其余布局由样式隐藏。
    const chatToggleLabel = $('#chat-focus-label');
    if (chatToggleLabel) chatToggleLabel.textContent = chatFocusActive() ? '收起　ESC' : '展开看全部';
    const switcher = $('#mobile-pane-switch');
    if (switcher) switcher.hidden = !narrow() || focusMode;
    const listenButton = $('#mobile-pane-listen');
    const chatButton = $('#mobile-pane-chat');
    listenButton?.setAttribute('aria-pressed', String(mobilePane === 'listen'));
    chatButton?.setAttribute('aria-pressed', String(mobilePane === 'chat'));
    const enter = $('#focus-mode-enter');
    if (enter) enter.hidden = focusMode;
    const actions = $('#focus-mode-actions');
    if (actions) actions.hidden = !focusMode;
  }

  function setMobilePane(nextPane) {
    if (nextPane !== 'listen' && nextPane !== 'chat') return false;
    if (focusMode) return false;
    if (mobilePane === nextPane) return true;
    beforePresentationChange();
    mobilePane = nextPane;
    render();
    return true;
  }

  function enterFocusMode() {
    if (focusMode) return;
    beforePresentationChange();
    focusBeforeMode = documentLike.activeElement || null;
    previousPane = mobilePane;
    focusMode = true;
    mobilePane = 'listen';
    // 专注聆听接管全屏：聊天聚焦态自动失效，退出后也不残留。
    chatFocusEnabled = false;
    render();
    $('#focus-mode-chat')?.focus?.();
  }

  /**
   * 进入/退出聊天聚焦态。只在桌面宽度且不在专注聆听时生效。
   * restoreFocus：从封面条按钮退出时把焦点送回把手；把手自身切换时焦点已在。
   */
  function setChatFocus(next, { restoreFocus = false } = {}) {
    if (next === chatFocusEnabled) return chatFocusActive();
    if (next && (focusMode || narrow())) return false;
    beforePresentationChange();
    chatFocusEnabled = Boolean(next);
    render();
    if (!chatFocusEnabled && restoreFocus) $('#chat-focus-toggle')?.focus?.();
    return chatFocusActive();
  }

  function exitFocusMode({ showChat = false } = {}) {
    if (!focusMode) return;
    beforePresentationChange();
    focusMode = false;
    mobilePane = showChat ? 'chat' : previousPane;
    render();
    const target = focusBeforeMode;
    focusBeforeMode = null;
    if (target?.isConnected && typeof target.focus === 'function') target.focus();
    else $('#focus-mode-enter')?.focus?.();
  }

  // Native details owns only disclosure, never mixer values or playback state.
  function closeMixer({ restoreFocus = false } = {}) {
    const details = $('#player-mixer-details');
    if (!narrow() || !details?.open) return false;
    details.open = false;
    if (restoreFocus) $('#mixer-summary')?.focus?.();
    return true;
  }

  function syncMixerLayout() {
    const details = $('#player-mixer-details');
    if (!details) return;
    const focusedInside = details.contains?.(documentLike.activeElement);
    details.open = !narrow();
    if (narrow() && focusedInside) $('#mixer-summary')?.focus?.();
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (closeMixer({ restoreFocus: true })) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }
    if (queuePopOpen()) {
      event.preventDefault?.();
      event.stopPropagation?.();
      setQueuePop(false);
      return;
    }
    if (!focusMode) {
      collapseChatFocusOnEscape(event);
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    exitFocusMode();
  }

  /**
   * 聊天聚焦态里按 Esc 回到听歌：只在输入框为空、且没有别的弹层先处理 Esc 时。
   * 草稿非空时 Esc 不吞字也不收起——用户可能只是想取消输入法。
   */
  function collapseChatFocusOnEscape(event) {
    if (!chatFocusActive() || event.defaultPrevented) return;
    if (documentLike.querySelector?.('dialog[open]')) return;
    const draft = $('#compose-input');
    if (String(draft?.value ?? '').trim()) return;
    event.preventDefault?.();
    setChatFocus(false, { restoreFocus: true });
  }

  /**
   * 队列弹层（参考稿底部「待播 + ☰」）：内容仍由会话视图投影（#sb-queue），
   * 这里只管开合与焦点语义；点外部、Esc、再点一次都会收起。
   */
  function queuePopOpen() {
    const pop = $('#queue-pop');
    return Boolean(pop && !pop.hidden);
  }

  function setQueuePop(next) {
    const pop = $('#queue-pop');
    const toggle = $('#queue-toggle');
    if (!pop) return;
    pop.hidden = !next;
    toggle?.setAttribute?.('aria-expanded', String(Boolean(next)));
  }

  function onDocumentPointerDown(event) {
    const details = $('#player-mixer-details');
    if (details && !details.contains?.(event.target)) {
      closeMixer({ restoreFocus: Boolean(details.contains?.(documentLike.activeElement)) });
    }
    if (!queuePopOpen()) return;
    const pop = $('#queue-pop');
    const toggle = $('#queue-toggle');
    if (pop?.contains?.(event.target) || toggle?.contains?.(event.target)) return;
    setQueuePop(false);
  }

  function init() {
    if (initialized) return api;
    initialized = true;
    bind($('#mobile-pane-listen'), 'click', () => setMobilePane('listen'));
    bind($('#mobile-pane-chat'), 'click', () => setMobilePane('chat'));
    bind($('#focus-mode-enter'), 'click', enterFocusMode);
    bind($('#focus-mode-chat'), 'click', () => exitFocusMode({ showChat: true }));
    bind($('#chat-focus-toggle'), 'click', () => setChatFocus(!chatFocusEnabled));
    bind($('#chat-focus-exit'), 'click', () => setChatFocus(false, { restoreFocus: true }));
    bind($('#queue-toggle'), 'click', () => setQueuePop(!queuePopOpen()));
    bind(documentLike, 'keydown', onKeyDown);
    bind(documentLike, 'pointerdown', onDocumentPointerDown);
    bind($('#player-mixer-details'), 'focusout', event => {
      if (event.relatedTarget && !$('#player-mixer-details')?.contains?.(event.relatedTarget)) closeMixer();
    });
    const media = windowLike?.matchMedia?.('(max-width: 960px)');
    const onBreakpoint = () => { syncMixerLayout(); render(); };
    media?.addEventListener?.('change', onBreakpoint);
    if (media) cleanups.push(() => media.removeEventListener?.('change', onBreakpoint));
    syncMixerLayout();
    syncVisualViewport();
    syncPlayerReserve();
    if (typeof windowLike?.ResizeObserver === 'function') {
      const player = $('.persistent-player');
      if (player) {
        playerObserver = new windowLike.ResizeObserver(syncPlayerReserve);
        playerObserver.observe(player);
        cleanups.push(() => playerObserver?.disconnect?.());
      }
    }
    syncClock();
    if (typeof windowLike?.setInterval === 'function') clockTimer = windowLike.setInterval(syncClock, 30_000);
    const visualViewport = windowLike?.visualViewport;
    for (const type of ['resize', 'scroll']) {
      visualViewport?.addEventListener?.(type, syncVisualViewport);
      if (visualViewport) cleanups.push(() => visualViewport.removeEventListener?.(type, syncVisualViewport));
    }
    for (const type of ['resize', 'orientationchange']) {
      windowLike?.addEventListener?.(type, syncVisualViewport);
      if (windowLike?.addEventListener) cleanups.push(() => windowLike.removeEventListener?.(type, syncVisualViewport));
    }
    render();
    return api;
  }

  function destroy() {
    if (!initialized) return;
    initialized = false;
    cleanups.splice(0).forEach(cleanup => cleanup());
    if (clockTimer != null && typeof windowLike?.clearInterval === 'function') windowLike.clearInterval(clockTimer);
    clockTimer = null;
    appElement.style?.removeProperty?.('--shell-viewport-height');
    appElement.style?.removeProperty?.('--shell-viewport-offset');
    appElement.style?.removeProperty?.('--player-actual-height');
  }

  const api = Object.freeze({
    init,
    destroy,
    render,
    setMobilePane,
    setChatFocus,
    enterFocusMode,
    exitFocusMode,
    syncEnvironment,
    getSnapshot: () => Object.freeze({ mobilePane, focusMode, previousPane, chatFocusEnabled, chatFocusActive: chatFocusActive() }),
  });
  return api;
}
