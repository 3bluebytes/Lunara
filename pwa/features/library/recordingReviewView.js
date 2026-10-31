import { escapeHtml as esc } from '../chat/chatMarkup.js';
import { createRecordingReviewController } from './recordingReviewController.js';

const duration = seconds => seconds > 0 && Number.isFinite(seconds)
  ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : '时长未知';

/** Approved B: a manually opened, non-modal, wide side panel, never a sidebar list. */
export function createRecordingReviewView({ apiClient, documentLike = globalThis.document, onOpen = () => {}, beforeToggle = () => true } = {}) {
  const host = documentLike.querySelector('#recording-review-panel');
  const launcher = documentLike.querySelector('#recording-review-open');
  if (!host || !launcher) return { handleServerEvent() {}, destroy() {} };
  const controller = createRecordingReviewController({ apiClient });
  const memberCopy = member => `<span class="recording-review__source-name">${esc(member.sourceName)}</span>
    <span>${esc(member.album || '专辑未知')}</span><small>${duration(member.duration)}</small>`;
  const merged = group => `<details class="recording-review__merged">
    <summary><span><strong>${esc(group.members[0]?.title || '已对齐歌曲')}</strong>
      <small>${esc(group.members[0]?.artist)} · ${esc(group.members.map(member => member.sourceName).join(' / '))}</small></span>
      <span class="recording-review__merged-mark">已合并</span></summary>
    <div class="recording-review__members">${group.members.map(member => `<div>${memberCopy(member)}</div>`).join('')}</div>
    <button type="button" class="recording-review__link" data-review-split="${esc(group.recordingId)}"
      data-review-focus="split-${esc(group.recordingId)}">不是同一首，拆开</button></details>`;

  function updateSelection(state) {
    const button = host.querySelector('[data-review-confirm]');
    if (button) { button.textContent = `对齐所选 · ${state.selected.length} 组`; button.disabled = state.locked || !state.selected.length; }
    for (const input of host.querySelectorAll('[data-review-select]')) input.checked = state.selected.includes(input.dataset.reviewSelect);
  }
  function render(state, kind) {
    launcher.setAttribute('aria-expanded', String(state.open));
    launcher.classList.toggle('active', state.open);
    host.hidden = !state.open;
    if (!state.open) return;
    if (kind === 'selection') { updateSelection(state); return; }
    // Only restore a control that actually held focus inside this panel. A background
    // refresh must not drag someone back from chat or from the existing player.
    const focused = host.contains(documentLike.activeElement) ? documentLike.activeElement?.dataset.reviewFocus : null;
    const scroll = host.querySelector('.recording-review__body')?.scrollTop || 0;
    const { view, rows, locked } = state;
    const sources = [...new Map(rows.flatMap(row => row.members).map(member => [member.provider, member.sourceName])).entries()];
    const candidates = rows.map(row => `<label class="recording-review__row">
      <span class="recording-review__song"><input type="checkbox" data-review-select="${esc(row.id)}"
        data-review-focus="${esc(row.id)}" aria-label="${esc('确认同一首：' + row.title + ' · ' + row.artist)}"
        ${state.selected.includes(row.id) ? 'checked' : ''}>
        <span><strong>${esc(row.title)}</strong><small>${esc(row.artist)}</small></span></span>
      <span class="recording-review__sources" style="--review-sources:${sources.length}">${sources.map(([provider]) => {
        const member = row.members.find(item => item.provider === provider);
        return `<span class="recording-review__source">${member ? memberCopy(member) : '<small>此组无该来源</small>'}</span>`;
      }).join('')}</span></label>`).join('');
    host.innerHTML = `<header class="recording-review__header">
      <div><h2 id="recording-review-title" tabindex="-1" data-review-focus="title">歌曲整理</h2>
        <p>不用离开聊天，确认后就收起。</p></div>
      <button type="button" class="recording-review__link" data-review-close data-review-focus="close" aria-label="收起歌曲整理">收起</button>
    </header>
    <div class="recording-review__body" tabindex="0" aria-label="待确认与已对齐的歌曲" data-review-focus="body">
      ${state.loading ? '<p role="status">正在读取本地曲库…</p>' : ''}
      ${view ? `<div class="recording-review__toolbar"><div><h3>${view.proposalCount} 组歌曲待确认</h3>
        <p>根据歌名、歌手和专辑找到的相似歌曲，尚未合并。</p></div>
        <button type="button" class="recording-review__confirm" data-review-confirm data-review-focus="confirm"
          ${locked || !state.selected.length ? 'disabled' : ''}>对齐所选 · ${state.selected.length} 组</button></div>
      ${view.showPrompt ? `<p class="recording-review__prompt">不急着整理也没关系。
        <button type="button" class="recording-review__link" data-review-dismiss data-review-focus="dismiss" ${locked ? 'disabled' : ''}>不用了，关闭提示</button></p>` : ''}
      ${view.truncated ? '<p>当前只检查前 5000 条本地曲库记录，其余未扫描。</p>' : ''}
      ${view.proposalCount > view.proposals.length ? `<p>本次仅展示前 ${view.proposals.length} 组建议；完成后可刷新继续。</p>` : ''}
      <fieldset ${locked ? 'disabled' : ''}><legend class="sr-only">这些是同一首歌吗？</legend>
        ${rows.length ? `<div class="recording-review__selection">
          <button type="button" class="recording-review__link" data-review-all data-review-focus="all">全选本页</button>
          <button type="button" class="recording-review__link" data-review-clear data-review-focus="clear">清空选择</button><small>每次最多 50 组</small></div>
        <div class="recording-review__columns" aria-hidden="true"><span>歌曲</span>
          <span class="recording-review__sources" style="--review-sources:${sources.length}">${sources.map(([, name]) => `<span>${esc(name)}</span>`).join('')}</span></div>
        ${candidates}` : `<p class="recording-review__empty">${view.trackCount ? '没有需要确认的重复歌曲。不同版本不会自动合并。' : '本地曲库还没有歌曲。同步音乐来源后，可在这里整理。'}</p>`}
        ${state.pages > 1 ? `<div class="recording-review__pages">
          <button type="button" class="recording-review__link" data-review-page="${state.page - 1}" data-review-focus="previous" ${state.page === 0 ? 'disabled' : ''}>上一页</button>
          <span>第 ${state.page + 1} / ${state.pages} 页</span>
          <button type="button" class="recording-review__link" data-review-page="${state.page + 1}" data-review-focus="next" ${state.page + 1 === state.pages ? 'disabled' : ''}>下一页</button></div>` : ''}
        <p class="recording-review__help">只整理本地记录，不修改远端歌单，也不会切歌。确认后随时可以撤销。</p>
        ${view.recordings.length ? `<h3 class="recording-review__section-title">已对齐的歌曲</h3>${view.recordings.map(merged).join('')}` : ''}
        ${view.recordingCount > view.recordings.length ? `<p>已对齐的歌曲仅展示前 ${view.recordings.length} 组。</p>` : ''}
      </fieldset>` : ''}
    </div>
    <footer class="recording-review__footer">
      <div class="recording-review__status" role="status" aria-live="polite">
        ${state.notice ? `<p>${esc(state.notice)}</p>` : ''}
        ${state.error ? `<p>${esc(state.error)}</p>` : ''}${state.busy ? '<p>正在保存…</p>' : ''}
      </div>
      <div class="recording-review__footer-actions">
        ${state.uncertain ? '<button type="button" class="recording-review__link" data-review-retry data-review-focus="retry">重试原操作</button>' : ''}
        ${view?.latestBatchId ? `<button type="button" class="recording-review__link" data-review-undo data-review-focus="undo" ${locked ? 'disabled' : ''}>撤销上次对齐</button>` : ''}
        <button type="button" class="recording-review__link" data-review-refresh data-review-focus="refresh" ${state.loading || state.busy ? 'disabled' : ''}>${state.readFailed || state.stale || state.uncertain ? '刷新核对' : '刷新曲库'}</button>
      </div>
    </footer>`;
    host.querySelector('.recording-review__body').scrollTop = scroll;
    if (focused) {
      const target = [...host.querySelectorAll('[data-review-focus]')].find(node => node.dataset.reviewFocus === focused);
      (target && !target.disabled ? target : host.querySelector('#recording-review-title'))?.focus({ preventScroll: true });
    }
  }

  function close() {
    const restore = host.contains(documentLike.activeElement);
    controller.close();
    if (restore) {
      const visible = element => element?.getClientRects().length && !element.closest('[inert]');
      const target = [launcher, documentLike.querySelector('#room-menu')].find(visible);
      target?.focus({ preventScroll: true });
    }
  }
  function toggle() {
    const action = beforeToggle();
    if (action === false) return;
    if (controller.getSnapshot().open) {
      if (action === 'open') return; // 主题图标从窄轨展开时不反向关闭已打开的工作区。
      return close();
    }
    onOpen();
    void controller.open();
    host.querySelector('#recording-review-title')?.focus({ preventScroll: true });
  }
  function click(event) {
    const button = event.target.closest('button');
    if (!button || !host.contains(button)) return;
    if (button.hasAttribute('data-review-close')) return close();
    if (button.hasAttribute('data-review-refresh')) return void controller.refresh();
    if (button.hasAttribute('data-review-confirm')) return void controller.confirm();
    if (button.hasAttribute('data-review-dismiss')) return void controller.dismiss();
    if (button.hasAttribute('data-review-undo')) return void controller.undo();
    if (button.hasAttribute('data-review-retry')) return void controller.retry();
    if (button.hasAttribute('data-review-all')) return controller.selectAll(true);
    if (button.hasAttribute('data-review-clear')) return controller.selectAll(false);
    if (button.hasAttribute('data-review-split')) return void controller.split(button.dataset.reviewSplit);
    if (button.hasAttribute('data-review-page')) return controller.setPage(Number(button.dataset.reviewPage));
  }
  function change(event) {
    if (event.target.hasAttribute('data-review-select')) controller.select(event.target.dataset.reviewSelect, event.target.checked);
  }
  function keydown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  }
  const unsubscribe = controller.subscribe(render);
  launcher.addEventListener('click', toggle);
  host.addEventListener('click', click);
  host.addEventListener('change', change);
  host.addEventListener('keydown', keydown);
  render(controller.getSnapshot());
  return { handleServerEvent: controller.handleServerEvent, destroy() {
    unsubscribe(); controller.destroy();
    launcher.removeEventListener('click', toggle);
    host.removeEventListener('click', click); host.removeEventListener('change', change); host.removeEventListener('keydown', keydown);
  } };
}
