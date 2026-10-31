import { escapeHtml } from '../chat/chatMarkup.js';
import { relativeTime } from '../taste/tasteView.js';

export function initMemoryView({
  controller,
  documentLike = globalThis.document,
  schedule = globalThis.setTimeout.bind(globalThis),
  cancelSchedule = globalThis.clearTimeout.bind(globalThis),
  onToast = () => {},
} = {}) {
  const $ = selector => documentLike.querySelector(selector);
  const cleanups = [];
  let active = false;
  let destroyed = false;
  let loadingPromise = null;
  let filter = '';
  let freshIds = new Set();
  let freshTimer = null;

  function listen(element, type, listener) {
    element?.addEventListener(type, listener);
    if (element) cleanups.push(() => element.removeEventListener(type, listener));
  }

  function render() {
    const list = $('#mem-list');
    if (!list || destroyed) return;
    let memories = controller.getSnapshot().memories;
    if (filter) {
      const query = filter.toLowerCase();
      memories = memories.filter(memory =>
        String(memory.content || '').toLowerCase().includes(query)
        || String(memory.tags || '').toLowerCase().includes(query));
    }
    const candidates = controller.getSnapshot().candidates.filter(item => !filter || item.content.toLowerCase().includes(filter.toLowerCase()));
    const evidence = row => {
      let value = row.evidence || {};
      if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = {}; } }
      return value;
    };
    list.innerHTML = memories.map(memory => {
      const fresh = freshIds.has(memory.id) ? ' fresh' : '';
      const basis = evidence(memory);
      const label = basis.inferred || String(memory.tags).includes('shared-hypothesis') ? '共享观察 · 尚非定论' : '你明确告诉大家的';
      const quotes = basis.quote || (basis.originalEvidence || []).map(item => item.quote).filter(Boolean).join('；') || memory.summary || '你在记忆面板中保存的内容';
      return `<article class="mem-card${fresh}" data-memory="${escapeHtml(memory.id)}">
        <p class="mem-card-text">${escapeHtml(memory.content)}</p>
        <div class="mem-card-foot"><span>${label}</span><span class="mem-card-when">${escapeHtml(relativeTime(memory.createdAt))}</span></div>
        <details><summary>查看依据或修正</summary><p>${escapeHtml(quotes)}</p>
          <label>正确的记忆<textarea>${escapeHtml(memory.content)}</textarea></label>
          <button class="quiet-button" data-memory-correct>保存修正</button>
        </details><button class="quiet-button" data-memory-forget>忘记这条</button>
      </article>`;
    }).join('');
    if (candidates.length) list.innerHTML += `<h3 class="memory-pending-title">待核对</h3><p class="memory-note">这些还不会作为共享偏好使用。</p>` + candidates.map(item => `<article class="mem-card" data-candidate="${escapeHtml(item.id)}"><p>${escapeHtml(item.content)}</p>
      <details><summary>${item.status === 'unverified' ? '旧记录，尚未核验' : '看看是从哪里想到的'}</summary>${(item.evidence || []).map(source => `<p>${escapeHtml(source.quote)}</p>`).join('') || '<p>缺少可核验的原始依据。</p>'}</details>
      <button class="quiet-button" data-candidate-forget>撤回这个观察</button></article>`).join('');
    if (!memories.length && !candidates.length) list.innerHTML = `<div class="mem-empty">${filter ? '没有匹配的记忆' : '还没有共享记忆。可以先告诉大家一件事。'}</div>`;
    if (freshTimer != null) cancelSchedule(freshTimer);
    freshTimer = schedule(() => { freshIds.clear(); freshTimer = null; }, 2000);
  }

  const unsubscribe = controller.subscribe(snapshot => {
    $('#mem-stats').textContent = `共享记忆 ${snapshot.total} 条`;
    render();
  });

  function load() {
    if (destroyed) return Promise.resolve();
    if (loadingPromise) return loadingPromise;
    $('#mem-status').textContent = '正在加载共享记忆…';
    $('#mem-retry').hidden = true;
    $('#mem-list').setAttribute('aria-busy', 'true');
    loadingPromise = (async () => {
      try {
        await controller.load();
        if (destroyed) return;
        render();
        $('#mem-status').textContent = '';
      } catch {
        if (destroyed) return;
        $('#mem-status').textContent = '记忆加载失败，请重试。';
        $('#mem-retry').hidden = false;
      } finally {
        if (!destroyed) $('#mem-list').setAttribute('aria-busy', 'false');
        loadingPromise = null;
      }
    })();
    return loadingPromise;
  }

  function setActive(value) {
    if (destroyed || active === Boolean(value)) return loadingPromise || Promise.resolve();
    active = Boolean(value);
    return active ? load() : Promise.resolve();
  }

  listen($('#mem-retry'), 'click', load);
  listen($('#mem-add'), 'click', async () => {
    const input = $('#mem-input');
    const tags = $('#mem-tags');
    const button = $('#mem-add');
    if (!input.value.trim()) return;
    button.disabled = true;
    button.textContent = '写入…';
    try {
      await controller.add(input.value, tags.value.trim() || undefined);
      input.value = '';
      tags.value = '';
      onToast('success', '记忆已写入', '之后每位伙伴都能参考这条记忆');
      await load();
    } catch {
      onToast('error', '记忆未能保存', '输入已保留，请稍后重试。');
    } finally {
      button.disabled = false;
      button.textContent = '记下';
    }
  });
  listen($('#mem-list'), 'click', async event => {
    const button = event.target.closest('[data-memory-correct], [data-memory-forget], [data-candidate-forget]');
    if (!button) return;
    button.disabled = true;
    try {
      const row = button.closest('[data-memory], [data-candidate]');
      if (row.dataset.candidate) await controller.dismissCandidate(row.dataset.candidate);
      else if (button.hasAttribute('data-memory-forget')) await controller.forget(row.dataset.memory);
      else await controller.correct(row.dataset.memory, row.querySelector('textarea').value);
      await load();
    } catch { onToast('error', '记忆修改失败', '内容未更改，请稍后重试。'); }
    finally { button.disabled = false; }
  });
  listen($('#mem-input'), 'keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      $('#mem-add').click();
    }
  });
  listen($('#mem-search'), 'input', event => {
    filter = event.currentTarget.value.trim();
    render();
  });
  listen($('#mem-consolidate'), 'click', async () => {
    const button = $('#mem-consolidate');
    if (button.disabled) return;
    button.disabled = true;
    button.classList.add('running');
    button.querySelector('span').textContent = '整理中…';
    try {
      const result = await controller.consolidate();
      onToast('success', '整理完成', `提升 ${result.promoted || 0} · 合并 ${result.merged || 0} · 剪枝 ${result.pruned || 0}`);
      await load();
    } catch {
      onToast('error', '整理失败', '请稍后重试，现有记忆不会因此清空。');
    } finally {
      button.disabled = false;
      button.classList.remove('running');
      button.querySelector('span').textContent = '整理';
    }
  });

  function handleServerEvent(message) {
    if (message?.type !== 'STATION_MEMORY_UPDATED' || !active || destroyed) return false;
    freshIds = new Set(message.payload?.memoryIds || []);
    void load();
    return true;
  }

  return Object.freeze({
    setActive,
    load,
    render,
    handleServerEvent,
    destroy() {
      active = false;
      destroyed = true;
      unsubscribe();
      if (freshTimer != null) cancelSchedule(freshTimer);
      cleanups.splice(0).forEach(cleanup => cleanup());
    },
  });
}
