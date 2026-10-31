import { escapeHtml } from '../chat/chatMarkup.js';

export function relativeTime(milliseconds, now = Date.now()) {
  if (!milliseconds) return '—';
  const minutes = Math.floor(Math.max(0, now - milliseconds) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function initTasteView({
  controller,
  documentLike = globalThis.document,
  scheduleInterval = globalThis.setInterval.bind(globalThis),
  cancelInterval = globalThis.clearInterval.bind(globalThis),
  refreshIntervalMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let intervalId = null;

  function listen(element, type, listener) {
    element?.addEventListener(type, listener);
    if (element) cleanups.push(() => element.removeEventListener(type, listener));
  }

  function close() {
    $('#sb-taste-popover')?.classList.remove('visible');
  }

  function bindClose(popover) {
    popover.querySelector('#sb-taste-popover-close')?.addEventListener('click', event => {
      event.stopPropagation();
      close();
    });
  }

  async function refresh() {
    const wrapper = $('#sb-taste-status');
    if (!wrapper) return null;
    try {
      const result = await controller.status();
      if (!result.lastFinishedAt) {
        wrapper.style.display = 'none';
        return result;
      }
      wrapper.style.display = '';
      $('#sb-taste-time').textContent = `${relativeTime(result.lastFinishedAt, now())}${result.running ? ' · 整理中' : ''}`;
      wrapper.title = result.lastSummary || '';
      return result;
    } catch {
      wrapper.style.display = 'none';
      return null;
    }
  }

  async function open() {
    const popover = $('#sb-taste-popover');
    if (!popover) return;
    popover.classList.add('visible');
    popover.innerHTML = '<button class="sb-taste-popover-close" id="sb-taste-popover-close" aria-label="close">✕</button><div style="opacity:.6">加载中…</div>';
    bindClose(popover);
    try {
      const result = await controller.history(3);
      const closeButton = '<button class="sb-taste-popover-close" id="sb-taste-popover-close" aria-label="close">✕</button>';
      popover.innerHTML = !result.log?.length
        ? `${closeButton}<div style="opacity:.6">没有记录</div>`
        : closeButton + result.log.map(row => `
          <div class="sb-taste-popover-row">
            <div class="sb-taste-popover-when">${relativeTime(row.finished_at || row.started_at, now())} · ${escapeHtml(row.status)}${row.dry_run ? ' · dryRun' : ''}</div>
            <div class="sb-taste-popover-text">${escapeHtml(row.summary || row.error || '(无摘要)')}</div>
          </div>`).join('');
      bindClose(popover);
    } catch {
      popover.innerHTML = '<button class="sb-taste-popover-close" id="sb-taste-popover-close" aria-label="close">✕</button><div style="opacity:.6">加载失败</div>';
      bindClose(popover);
    }
  }

  listen($('#sb-taste-status'), 'click', event => {
    if (event.target.closest('#sb-taste-popover')) return;
    event.stopPropagation();
    const popover = $('#sb-taste-popover');
    if (popover?.classList.contains('visible')) close();
    else void open();
  });
  listen(documentLike, 'click', event => {
    if (!event.target.closest('#sb-taste-status')) close();
  });
  listen(documentLike, 'keydown', event => {
    if (event.key === 'Escape') close();
  });

  void refresh();
  intervalId = scheduleInterval(refresh, refreshIntervalMs);
  return Object.freeze({
    refresh,
    open,
    close,
    destroy() {
      if (intervalId != null) cancelInterval(intervalId);
      intervalId = null;
      cleanups.splice(0).forEach(cleanup => cleanup());
    },
  });
}
