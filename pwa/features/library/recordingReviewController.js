const ROOT = '/api/library/recordings';
const PAGE_SIZE = 50;

/** Local catalog review only. No playback, account, model or remote-provider dependency. */
export function createRecordingReviewController({ apiClient, requestIdFactory = () => globalThis.crypto.randomUUID() } = {}) {
  let view = null, isOpen = false, loading = false, busy = false, disposed = false, generation = 0, page = 0;
  let selected = new Set(), pending = null, notice = '', error = '', stale = false, readFailed = false;
  const listeners = new Set();
  const rows = () => view?.proposals.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) || [];
  const locked = () => busy || loading || readFailed || stale || Boolean(pending);
  const emit = (kind = 'render') => { for (const listener of listeners) listener(getSnapshot(), kind); };
  function getSnapshot() {
    return { view, open: isOpen, loading, busy, page, rows: rows(), selected: [...selected], notice, error,
      stale, readFailed, uncertain: Boolean(pending) && !busy, locked: locked(),
      pages: Math.max(1, Math.ceil((view?.proposals.length || 0) / PAGE_SIZE)) };
  }
  async function refresh({ keepSelection = true } = {}) {
    if (disposed || busy || loading || !isOpen) return;
    const ticket = ++generation;
    loading = true;
    emit();
    try {
      const result = await apiClient.get(ROOT);
      if (disposed || ticket !== generation) return;
      if (!result || result.ok === false || !Array.isArray(result.proposals) || !Array.isArray(result.recordings)) throw new Error('invalid review');
      const previous = view;
      view = result;
      page = Math.min(page, Math.max(0, Math.ceil(view.proposals.length / PAGE_SIZE) - 1));
      selected = new Set(rows().filter(row => keepSelection && previous ? selected.has(row.id) : true).map(row => row.id));
      pending = null; stale = false; readFailed = false; error = '';
    } catch {
      if (disposed || ticket !== generation) return;
      readFailed = true;
      error = '暂时没能读取本地曲库，请刷新后重试。';
    } finally {
      if (!disposed && ticket === generation) { loading = false; emit(); }
    }
  }
  async function mutate(action) {
    if (disposed || busy || loading) return;
    pending = action; busy = true; error = ''; notice = '';
    emit();
    try {
      const result = await apiClient.post(ROOT + '/' + action.path, action.body);
      if (disposed) return;
      if (!result || result.ok === false) throw new Error('review rejected');
      notice = action.path === 'confirm' ? `已对齐 ${result.confirmed} 组歌曲，随时可以撤销。` : action.success;
      pending = null; busy = false;
      await refresh({ keepSelection: false });
    } catch (failure) {
      if (disposed) return;
      if ([400, 404, 409].includes(failure?.status)) {
        pending = null; stale = true;
        error = '歌曲或对齐关系已变化，请刷新后再操作。';
      } else {
        error = '保存结果暂未确认。可重试原操作，或刷新核对；当前选择已保留。';
      }
    } finally {
      busy = false;
      if (!disposed) emit();
    }
  }
  const allowed = () => isOpen && view && !locked();
  return {
    getSnapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async open() { if (disposed) return; isOpen = true; await refresh(); },
    close() { isOpen = false; emit(); },
    refresh,
    select(id, checked) {
      if (!allowed() || !rows().some(row => row.id === id)) return;
      checked ? selected.add(id) : selected.delete(id); emit('selection');
    },
    selectAll(checked) { if (allowed()) { selected = new Set(checked ? rows().map(row => row.id) : []); emit('selection'); } },
    setPage(next) {
      if (!allowed() || !Number.isInteger(next) || next < 0 || next >= getSnapshot().pages) return;
      page = next; selected = new Set(rows().map(row => row.id)); emit();
    },
    async confirm() {
      if (!allowed() || !selected.size || selected.size > PAGE_SIZE) return;
      await mutate({ path: 'confirm', body: { requestId: requestIdFactory(), revision: view.revision, proposalIds: [...selected] } });
    },
    async retry() { if (pending && !busy) await mutate(pending); },
    async dismiss() {
      if (allowed()) await mutate({ path: 'dismiss', body: {}, success: '已关闭整理提示。你仍可随时主动整理。' });
    },
    async split(recordingId) {
      if (!allowed()) return;
      const group = view.recordings.find(item => item.recordingId === recordingId);
      if (group) await mutate({ path: 'split', body: { recordingId, revision: group.revision }, success: '已拆开，原有标签保留。' });
    },
    async undo() {
      if (allowed() && view.latestBatchId) await mutate({ path: 'split', body: { batchId: view.latestBatchId },
        success: '已撤销，来源已分开，标签保留。' });
    },
    async handleServerEvent(message) {
      if (message?.type === 'library-updated' && isOpen && !pending) await refresh();
    },
    destroy() { disposed = true; ++generation; listeners.clear(); },
  };
}
