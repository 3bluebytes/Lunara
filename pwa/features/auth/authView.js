export function qrStatusCopy(source, code, time = '') {
  const prefix = time ? `[${time}] ` : '';
  if (code === 803) return `${prefix}登录成功！`;
  if (code === 802) return `${prefix}已扫码，请在手机上确认`;
  if (code === 801) return `${prefix}等待扫码中…`;
  if (code === 800) return `${prefix}二维码已失效`;
  return `${prefix}${source === 'qq' ? 'QQ 音乐' : '网易云'}登录检查失败`;
}

export function initAuthView({
  controller,
  documentLike = globalThis.document,
  confirmImpl = globalThis.confirm,
  scheduleInterval = globalThis.setInterval.bind(globalThis),
  cancelInterval = globalThis.clearInterval.bind(globalThis),
  schedule = globalThis.setTimeout.bind(globalThis),
  onError = () => {},
} = {}) {
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let activeSource = 'ncm';
  let qrTimer = null;
  let qrRun = 0;
  let qrOpener = null;

  function listen(element, type, listener) {
    element?.addEventListener(type, listener);
    if (element) cleanups.push(() => element.removeEventListener(type, listener));
  }

  function sourceIcon(source) {
    return source === 'qq'
      ? '<svg viewBox="0 0 40 40" width="12" height="12" fill="currentColor"><path d="M20 4a16 16 0 1 0 0 32 16 16 0 0 0 0-32zm1.5 6c3.3 0 6 2.7 6 6v3c0 3.3-2.7 6-6 6s-6-2.7-6-6v-3c0-3.3 2.7-6 6-6zM12 28c.8-1 2-1.7 3.3-1.7H26c1.3 0 2.5.7 3.3 1.7"/></svg>'
      : '<svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor"><path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 6.5C3 12 5.2 10 8 10s5 2 5 4.5v.5H3v-.5Z"/></svg>';
  }

  function renderSource(source, profile) {
    const account = $(`#sb-account-${source}`);
    if (!account) return;
    const loggedIn = Boolean(profile?.loggedIn);
    account.classList.toggle('logged-in', loggedIn);
    account.querySelector('.sb-acc-name').textContent = loggedIn ? (profile.nickname || '已登录') : '未登录';
    account.querySelector('.sb-acc-hint').textContent = loggedIn
      ? (profile.vipType ? `VIP · ${source === 'qq' ? 'QQ 音乐' : '网易云'}` : `${source === 'qq' ? 'QQ 音乐' : '网易云'}已登录`)
      : (source === 'qq' ? 'QQ 音乐' : '网易云');
    account.querySelector('.sb-acc-logout').style.display = loggedIn ? '' : 'none';
    const avatar = account.querySelector('.sb-acc-avatar');
    avatar.innerHTML = loggedIn && profile.avatarUrl
      ? `<img src="${String(profile.avatarUrl).replaceAll('"', '&quot;')}" referrerpolicy="no-referrer" alt="" />`
      : sourceIcon(source);
  }

  const unsubscribe = controller.subscribe(sources => {
    renderSource('ncm', sources.ncm);
    renderSource('qq', sources.qq);
    const count = ['ncm', 'qq'].filter(id => sources[id]?.loggedIn).length;
    const label = $('#source-menu-label');
    if (label) label.textContent = count ? `音乐账号已登录 · ${count}` : '音乐源 · 未登录';
    const sourceButton = $('#source-menu-open');
    sourceButton?.setAttribute?.('data-connected', String(count > 0));
  });

  function stopQrPolling() {
    qrRun += 1;
    if (qrTimer != null) cancelInterval(qrTimer);
    qrTimer = null;
  }

  function closeOverlay() {
    stopQrPolling();
    $('#qr-overlay').style.display = 'none';
    $('#qr-img').src = '';
    const opener = qrOpener?.isConnected === false && qrOpener.dataset?.sourceLogin
      ? documentLike.querySelector(`[data-source-login="${qrOpener.dataset.sourceLogin}"]`) : qrOpener;
    opener?.focus?.({ preventScroll: true });
    qrOpener = null;
  }

  async function logoutSource(source) {
    if (!confirmImpl?.(`确认退出${source === 'qq' ? 'QQ 音乐' : '网易云'}账号？`)) return false;
    await controller.logout(source);
    return true;
  }

  async function openSource(source) {
    if ($('#qr-overlay').style.display !== 'flex') qrOpener = documentLike.activeElement;
    stopQrPolling();
    const run = qrRun;
    activeSource = source;
    $('#qr-title').textContent = source === 'qq' ? '登录 QQ 音乐' : '登录网易云音乐';
    $('#cookie-input').placeholder = source === 'qq'
      ? 'uin=你的QQ号; qm_keyst=xxx; qqmusic_key=yyy'
      : 'MUSIC_U=xxx; __csrf=yyy';
    const overlay = $('#qr-overlay');
    overlay.style.display = 'flex';
    $('#qr-close')?.focus?.({ preventScroll: true });
    const image = $('#qr-img');
    const hint = $('#qr-hint');
    const refresh = $('#qr-refresh');
    $('#qr-section').style.display = '';
    $('#cookie-section').open = false;
    $('#cookie-input').value = '';
    $('#cookie-hint').textContent = '';
    refresh.style.display = 'none';
    hint.textContent = '正在生成二维码…';
    image.src = '';
    try {
      const qr = await controller.createQr(source);
      if (run !== qrRun) return;
      image.src = qr.qrimg;
      hint.textContent = source === 'qq' ? '请使用 QQ App 扫码并确认' : '请使用网易云音乐 App 扫码';
      let elapsed = 0;
      let checking = false;
      qrTimer = scheduleInterval(async () => {
        if (checking || run !== qrRun) return;
        elapsed += 2000;
        if (elapsed > 180_000) {
          stopQrPolling();
          hint.textContent = '二维码已过期，请刷新后重试';
          refresh.style.display = '';
          return;
        }
        checking = true;
        try {
          const result = await controller.checkQr(source, qr.key);
          if (run !== qrRun) return;
          const time = new Date().toLocaleTimeString();
          if (result.code === 803) {
            stopQrPolling();
            hint.textContent = qrStatusCopy(source, result.code, time);
            const completedRun = qrRun;
            await controller.refresh();
            if (completedRun !== qrRun) return;
            schedule(() => { if (completedRun === qrRun) closeOverlay(); }, 800);
          } else if (result.code === 801 || result.code === 802) {
            hint.textContent = qrStatusCopy(source, result.code, time);
          } else {
            stopQrPolling();
            hint.textContent = result.error || result.message || qrStatusCopy(source, result.code, time);
            refresh.style.display = '';
          }
        } catch (error) {
          if (run !== qrRun) return;
          stopQrPolling();
          hint.textContent = error.message;
          refresh.style.display = '';
          onError(error);
        } finally {
          checking = false;
        }
      }, 2000);
    } catch (error) {
      if (run !== qrRun) return;
      hint.textContent = error.message;
      refresh.style.display = '';
    }
  }

  documentLike.querySelectorAll('[data-source].sb-account-btn').forEach(button => {
    listen(button, 'click', () => void openSource(button.dataset.source));
  });
  listen($('#qr-close'), 'click', closeOverlay);
  listen($('#qr-refresh'), 'click', () => void openSource(activeSource));
  listen($('#cookie-btn'), 'click', async () => {
    const cookie = $('#cookie-input').value.trim();
    if (!cookie) return;
    const hint = $('#cookie-hint');
    const source = activeSource, run = qrRun;
    hint.textContent = '验证中…';
    try {
      const result = await controller.loginWithCookie(source, cookie);
      if (run !== qrRun) return;
      stopQrPolling();
      hint.textContent = `${source === 'qq' ? 'QQ' : '网易云'}登录成功！(${result.nickname || result.userId || '?'})`;
      const completedRun = qrRun;
      schedule(() => { if (completedRun === qrRun) closeOverlay(); }, 800);
    } catch (error) {
      if (run !== qrRun) return;
      hint.textContent = `登录失败：${error.message}`;
    }
  });
  listen($('#cookie-input'), 'keydown', event => {
    if (event.key === 'Enter') $('#cookie-btn').click();
  });
  documentLike.querySelectorAll('.sb-acc-logout').forEach(button => {
    listen(button, 'click', async () => {
      const source = button.dataset.source;
      try { await logoutSource(source); } catch (error) { onError(error); }
    });
  });

  listen(documentLike, 'keydown', event => {
    if ($('#qr-overlay').style.display !== 'flex') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      closeOverlay();
    } else if (event.key === 'Tab') {
      const focusable = [...$('#qr-overlay').querySelectorAll('button:not([disabled]), input, summary')]
        .filter(node => node.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && documentLike.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && documentLike.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });

  void controller.refresh().catch(onError);
  return Object.freeze({
    openSource,
    logoutSource,
    refresh: () => controller.refresh(),
    destroy() {
      closeOverlay();
      unsubscribe();
      cleanups.splice(0).forEach(cleanup => cleanup());
    },
  });
}
