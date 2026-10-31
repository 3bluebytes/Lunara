import { repeatFrequency } from '../../core/lifeRecurrence.js';
import { wallTime } from '../../visuals/cikePresentation.js';
import { createEntryDrafts, entryRequestId } from './entryDrafts.js';
import { filterTaskEntries, taskCounts, entryOccurrence, rescheduleEntry } from './taskWorkspace.js';
// 今日生活手记与日程工作台（柔和夜色书写台）
// 只承载手记：随笔/日记书写、待办清单、时间安排、纪念日。
// 作息在设置 → 常规管理；场景默认仅保留数据/API 兼容，帐本不加载它们。
// 默认本地私有，显式授权才进入模型上下文；浏览与切换操作严格保证不切歌。

// 待办与历史"安排"（event）合并为同一勾选清单：新建只提供三种类型，event 统一按待办显示。
const TYPE_OPTIONS = { note: '随笔', todo: '待办', important_date: '重要日子' };
const ENTRY_TYPE_LABELS = { ...TYPE_OPTIONS, event: '待办' };
const WEEKDAYS = [['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 0]];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/gu, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function localToday() {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = (dateStr || localToday()).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return date.toISOString().slice(0, 10);
}

function parseDateMeta(dateStr) {
  const safeStr = dateStr || localToday();
  const [y, m, d] = safeStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = localToday();
  const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekDayName = weekDays[date.getDay()] || '';
  const isToday = safeStr === today;
  const isTomorrow = safeStr === shiftDate(today, 1);
  const isYesterday = safeStr === shiftDate(today, -1);
  const relLabel = isToday ? '今天' : (isTomorrow ? '明天' : (isYesterday ? '昨天' : null));
  return { year: y, month: m, day: d, monthDay: `${m}月${d}日`, weekDayName, relLabel, isToday };
}

export function createTodayView({
  apiClient,
  documentLike = globalThis.document,
  getPeople = () => [],
  showToast = () => {},
  onError = () => {},
} = {}) {
  if (!apiClient?.get || !apiClient?.post) throw new TypeError('today view requires an api client');
  const $ = selector => documentLike.querySelector(selector);
  let data = { entries: [] };
  let selectedDate = localToday();
  let selectedView = 'all'; // 'all' | 'today' | 'note' | 'todo' | 'important_date'
  let selectedEntryId = null; // null 表示新建草稿，string 表示当前正在编辑查看的条目
  let loading = false;
  let loadRevision = 0;
  let quickAddDraft = '';
  let editingInput = false, composing = false, resetListScroll = false;
  let taskFilter = 'open', search = '', sort = 'date-asc', detailOpen = false;
  let deleteConfirm = null, loadErrors = {}, mutationRevision = 0;
  const mutationLocks = new Set();
  const drafts = createEntryDrafts({ request: (...args) => apiClient.request(...args),
    fetchLatest: async id => (await apiClient.get('/api/life/entries')).entries?.find(entry => entry.id === id) || null,
    isBlocked: key => mutationLocks.has(key),
    onSaved(saved, oldKey) {
      mutationRevision++; loadRevision++; loading = false;
      data.entries = [...data.entries.filter(entry => entry.id !== saved.id), saved];
      if (editorKey() === oldKey) selectedEntryId = saved.id;
    }, onChange: () => { if (!editingInput && !composing) render(); else updateSaveStatus(); } });
  let renderedEditor = null;
  const editorKey = () => selectedEntryId || `new:${selectedDate}`;
  const editorFields = { 'entry-title': 'title', 'entry-content': 'content', 'entry-type': 'type',
    'entry-date': 'localDate', 'entry-end-date': 'endDate', 'entry-start': 'startTime', 'entry-end': 'endTime',
    'entry-repeat': 'repeatFrequency', 'entry-companion': 'useForCompanionship', 'entry-note': 'companionNote',
    'entry-note-uses-title': 'noteUsesTitle', 'entry-scene': 'sceneTag' };

  function recordEditorInput(event) {
    const field = event.target;
    if (field?.name === 'task-search') { search = field.value; resetListScroll = true; if (!composing) render(); return; }
    if (field?.name === 'task-sort') { sort = field.value; resetListScroll = true; render(); return; }
    if (field?.name === 'quick-todo') {
      quickAddDraft = field.value;
      return;
    }
    if (!renderedEditor || (!editorFields[field?.name] && field?.name !== 'entry-persons' && field?.name !== 'entry-weekday')) return;
    const previous = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
    const changes = {};
    if (field.name === 'entry-weekday') {
      const days = new Set(previous.repeatWeekdays || []);
      if(field.checked) days.add(Number(field.value)); else days.delete(Number(field.value));
      changes.repeatWeekdays = [...days];
    } else if (field.name === 'entry-persons') {
      const ids = new Set(previous.allowedPersonIds || []);
      if (field.checked) ids.add(field.value); else ids.delete(field.value);
      changes.allowedPersonIds = [...ids];
    } else changes[editorFields[field.name]] = field.type === 'checkbox' ? field.checked : field.value;
    editingInput = true;
    drafts.update(renderedEditor.key, renderedEditor.entry, changes);
    editingInput = false;
    if (['entry-repeat', 'entry-type'].includes(field.name)) render();
  }

  const saveLabels = { saved: '已保存', dirty: '有未保存的修改', saving: '正在保存…', authorization: '授权变更需点保存', error: '保存失败，内容已保留', conflict: '版本冲突，草稿已保留', deleted: '此条目已在别处删除，草稿仍保留' };
  function updateSaveStatus() {
    const status = $('#today-panel')?.querySelector('.today-save-indicator');
    const draft = drafts.get(editorKey());
    if (status && draft) { status.textContent = saveLabels[draft.status]; status.dataset.state = draft.status; }
  }

  async function saveEntry(editingId, payload) {
    const key = renderedEditor.key;
    drafts.update(key, renderedEditor.entry, payload);
    return drafts.save(key, { manual: true });
  }

  const people = () => getPeople().filter(person => !person.archivedAt && person.status !== 'archived');
  const personName = id => people().find(person => person.id === id)?.displayName || (id === 'lunara' ? 'Lunara' : '伙伴');

  let quickAddInFlight = false, quickBatch = null;
  async function quickAddTodos(rawText) {
    if (quickAddInFlight) return;
    const text = String(rawText ?? '');
    if (!quickBatch) quickAddDraft = text;
    if (!quickBatch) {
      const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (!lines.length) return;
      quickBatch = { date: selectedDate, source: text, rows: lines.map(title => ({ title, clientRequestId: entryRequestId() })) };
    }
    const batch = quickBatch;
    quickAddInFlight = true; render();
    try {
      while (batch.rows.length) {
        const row = batch.rows[0];
        const result = await apiClient.request('/api/life/entries', { method: 'POST', body: {
          ...row, type: 'todo', content: null, localDate: batch.date, startTime: null, endTime: null,
          yearlyRepeat: false, useForCompanionship: false, companionNote: null, noteUsesTitle: false,
          allowedPersonIds: [], sceneTag: null,
        } });
        if (result?.ok === false || !result?.entry?.id) throw new Error('保存未确认');
        mutationRevision++; loadRevision++; loading = false;
        data.entries = [...data.entries.filter(entry => entry.id !== result.entry.id), result.entry];
        batch.rows.shift();
      }
      if (quickAddDraft === batch.source) quickAddDraft = '';
      quickBatch = null;
    } catch {
      // Never infer success from a title: same-named tasks have distinct identities.
      if (quickAddDraft === batch.source) { quickAddDraft = batch.rows.map(row => row.title).join('\n'); batch.source = quickAddDraft; }
      showToast('error', '部分待办没有保存', `失败内容保留，重试仍归属 ${batch.date}。`, { curated: true });
    } finally { quickAddInFlight = false; render(); }
  }

  async function load() {
    const revision = ++loadRevision, writeRevision = mutationRevision, date = selectedDate;
    loading = true; render();
    // 手记页只消费条目，不加载作息或场景默认。
    const results = await Promise.allSettled([apiClient.get('/api/life/entries')]);
    if (revision !== loadRevision || writeRevision !== mutationRevision || date !== selectedDate) return;
    const [entries] = results;
    if (entries.status === 'fulfilled' && entries.value?.ok !== false) {
      data.entries = entries.value.entries || []; delete loadErrors.entries;
    } else loadErrors.entries = true;
    loading = false; render();
  }

  function panelHasContent() {
    return Boolean(documentLike.querySelector('#today-panel')?.innerHTML?.trim());
  }

  function readForm(root) {
    const value = name => root.querySelector(`[name="${name}"]`)?.value?.trim() || '';
    const checked = name => root.querySelector(`[name="${name}"]`)?.checked === true;
    return { value, checked };
  }

  function filterEntries() {
    return filterTaskEntries(data.entries, { view: selectedView, filter: taskFilter, search, sort,
      today: localToday(), selectedDate });
  }

  async function mutateEntry(id, action, body = {}) {
    const entry = data.entries.find(item => item.id === id);
    if (!entry || mutationLocks.has(id) || drafts.isSaving(id)) return;
    mutationLocks.add(id); render();
    try {
      const result = await apiClient.request(`/api/life/entries/${encodeURIComponent(id)}${action === 'done' ? '/done' : action === 'revoke' ? '/revoke-companionship' : ''}`, {
        method: action === 'delete' ? 'DELETE' : action === 'reschedule' ? 'PATCH' : 'POST',
        body: { ...body, expectedRevision: entry.revision },
      });
      if (result?.ok === false) throw new Error('保存未确认');
      mutationRevision++; loadRevision++; loading = false;
      if (action === 'delete') {
        data.entries = data.entries.filter(item => item.id !== id); drafts.discard(id); deleteConfirm = null;
        if (selectedEntryId === id) { selectedEntryId = null; detailOpen = false; }
      } else if (result?.entry) {
        data.entries = data.entries.map(item => item.id === id ? result.entry : item);
        drafts.acceptExternal(id, result.entry, { revoked: action === 'revoke' });
      }
      render();
    } catch (error) {
      if (error.status === 409) await drafts.conflict(id, entry);
      else showToast('error', '没有保存', '内容保持原样，请检查连接后重试。', { curated: true });
    } finally { mutationLocks.delete(id); drafts.schedule(id); render(); }
  }
  // ---- 渲染备忘录列表卡片 ----
  function renderNotesList() {
    const entries = filterEntries();
    const overdue = entry => (entry.type === 'todo' || entry.type === 'event') && !entry.done
      && repeatFrequency(entry) === 'none' && entryOccurrence(entry, localToday())?.end < localToday();

    if (!entries.length) {
      return `
        <li class="today-empty-item">
          <div class="today-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor"><path d="m16 3 5 5-12 12H4v-5L16 3Z"/></svg></div>
          <p class="today-empty-title">${search ? '没有找到匹配内容' : selectedView === 'todo' ? (taskFilter === 'completed' ? '还没有已归档的待办' : '这个待办视图暂时没有事项') : '暂无相关手记'}</p>
          <p class="today-empty-sub">点击上方“＋ 新建”记录一段随笔或待办</p>
        </li>${selectedDate === localToday() ? `<li class="today-now" data-now-line><time>${wallTime()}</time><em>此刻</em><span></span></li>` : ''}`;
    }

    let lastGroup = null;
    let nowInserted = false;
    const clock = wallTime();
    const nowLine = `<li class="today-now" data-now-line><time>${clock}</time><em>此刻</em><span></span></li>`;
    const rows = entries.map(entry => {
      const date = entry.occurrenceDate || entry.localDate;
      const group = date < selectedDate ? '此前' : date > selectedDate ? '往后' : entry.startTime ? '今天' : '没定时间';
      const heading = group !== lastGroup ? `<li class="today-timeline-heading">${group === '今天' && selectedDate !== localToday() ? '所选日' : group}</li>` : '';
      lastGroup = group;
      const insertNow = !nowInserted && selectedDate === localToday() && sort === 'date-asc'
        && (date > selectedDate || (date === selectedDate && (!entry.startTime || entry.startTime >= clock)));
      if (insertNow) nowInserted = true;
      const isSelected = entry.id === selectedEntryId;
      const typeLabel = ENTRY_TYPE_LABELS[entry.type] || entry.type;
      const snippet = entry.content ? entry.content.slice(0, 70).replace(/\n+/g, ' ') : (entry.companionNote || '');

      return `${heading}${insertNow ? nowLine : ''}
        <li class="today-entry type-${entry.type}${entry.done ? ' done' : ''}${overdue(entry) ? ' overdue' : ''}${isSelected ? ' is-selected' : ''}${entry.startTime ? '' : ' is-untimed'}"
            data-id="${esc(entry.id)}" data-occurrence-date="${esc(entry.occurrenceDate || '')}" data-occurrence-key="${esc(entry.occurrenceKey || entry.id)}" data-revision="${entry.revision}">
          <div class="today-entry-main">
            <time class="today-timeline-time">${esc(entry.startTime || '')}</time>
            ${entry.type === 'todo' || entry.type === 'event' ? `
              <label class="today-entry-checkbox-wrap">
                <input type="checkbox" data-action="toggle-done" ${entry.done ? 'checked' : ''} ${mutationLocks.has(entry.id) || drafts.isSaving(entry.id) ? 'disabled' : ''} aria-label="${entry.done ? '恢复' : '完成'} ${esc(entry.occurrenceDate || entry.localDate)}：${esc(entry.title)}" />
                <span class="today-custom-check" aria-hidden="true"></span>
              </label>` : `<span class="today-entry-dot type-${entry.type}" aria-hidden="true"></span>`}
            <button type="button" class="today-entry-content today-entry-select" data-action="select-entry" data-id="${esc(entry.id)}" aria-pressed="${isSelected}">
              <div class="today-entry-title-row">
                <span class="today-entry-title">${esc(entry.title || '无标题手记')}</span>
                ${entry.useForCompanionship ? '<span class="today-entry-scope" title="备注会发送给当前配置的模型">♪ 伴听参考</span>' : ''}
              </div>
              ${snippet ? `<p class="today-entry-snippet">${esc(snippet)}</p>` : ''}
              <div class="today-entry-meta">
                <span class="today-meta-pill type-${entry.type}">${esc(typeLabel)}</span>
                <span class="today-date-badge">${esc(entry.occurrenceDate || entry.localDate)}</span>
                ${entry.startTime ? `<span class="today-time-badge">${esc(entry.startTime)}${entry.endTime ? ` - ${esc(entry.endTime)}` : ''}</span>` : ''}
                ${repeatFrequency(entry) !== 'none' ? `<span class="today-repeat-badge">${({daily:'每天',weekly:'每周',yearly:'每年'})[repeatFrequency(entry)]}重复</span>` : ''}
                ${overdue(entry) ? '<span class="today-overdue-badge">已逾期</span>' : ''}
                ${entry.sceneTag ? `<span class="today-scene-badge"># ${esc(entry.sceneTag)}</span>` : ''}
              </div>
            </button>
          </div>
          <!-- 不用 inline stopPropagation：删除/撤回靠面板级事件委托，掐断冒泡会让按钮永远失灵。 -->
          <div class="today-entry-actions">
            ${entry.useForCompanionship ? `<button type="button" data-action="revoke" class="today-action-btn quiet-button" title="撤回分享给模型的授权">撤回</button>` : ''}
            ${repeatFrequency(entry) === 'none' && (entry.type === 'todo' || entry.type === 'event') ? `<span class="today-entry-reschedule"><button type="button" data-action="move-today" class="today-action-btn">今天</button><button type="button" data-action="move-tomorrow" class="today-action-btn">明天</button></span>` : ''}
            ${deleteConfirm === entry.id ? `<span class="today-delete-confirm">${repeatFrequency(entry) !== 'none' ? '删除整个系列？' : '确认删除？'}<button type="button" data-action="delete-confirm">删除</button><button type="button" data-action="delete-cancel">取消</button></span>` : '<button type="button" data-action="delete" class="today-action-btn quiet-button delete-btn" title="删除此条目">删除</button>'}
          </div>
        </li>`;
    }).join('');
    return rows + (!nowInserted && selectedDate === localToday() && sort === 'date-asc' ? nowLine : '');
  }

  // ---- 渲染中央编辑书写区（Apple Notes 体验）----
  function renderEditorPane() {
    if (!selectedEntryId && !detailOpen && !drafts.get(editorKey())) {
      renderedEditor = null;
      return '<section class="today-editor-empty"><h2>把今天的事情安排好</h2><p>从左侧打开一条手记，或快速添加待办。随笔、重要日子也可以单独记录。</p><button type="button" class="today-btn-primary" data-action="new-entry">＋ 新建手记</button></section>';
    }
    const stored = selectedEntryId ? data.entries.find(e => e.id === selectedEntryId) : null;
    const draft = drafts.get(editorKey());
    const current = draft?.entry || stored;
    const isNew = !stored;
    const meta = parseDateMeta(selectedDate);

    const rawType = current ? current.type : (selectedView === 'todo' ? 'todo' : 'note');
    const entryType = rawType === 'event' ? 'todo' : rawType;
    const entryTitle = current ? current.title : '';
    const entryContent = current ? (current.content || '') : '';
    const entryDate = current ? current.localDate : selectedDate;
    const entryStart = current?.startTime || '';
    const entryEnd = current?.endTime || '';
    const frequency = repeatFrequency(current || {});
    const repeatDays = current?.repeatWeekdays || [];
    const entryYearly = frequency === 'yearly';
    const entryCompanion = current?.useForCompanionship === true;
    const entryNote = current?.companionNote || '';
    const entryNoteUsesTitle = current?.noteUsesTitle === true;
    const entryScene = current?.sceneTag || '';
    const entryPersons = current?.allowedPersonIds || [];
    renderedEditor = { key: editorKey(), entry: current || { type: entryType, title: entryTitle, content: entryContent,
      localDate: entryDate, startTime: entryStart, endTime: entryEnd, yearlyRepeat: entryYearly, repeatFrequency: frequency, repeatWeekdays: repeatDays,
      useForCompanionship: entryCompanion, companionNote: entryNote, noteUsesTitle: entryNoteUsesTitle,
      sceneTag: entryScene, allowedPersonIds: entryPersons, revision: 0 } };

    return `
      <section class="today-editor-card ${entryType === 'todo' ? 'is-task-editor' : ''}" data-editing-id="${esc(current?.id || '')}">
        <!-- 顶部轻量状态条：日期与操作（单日工作/休息覆盖入口已收起，API 与数据保留） -->
        <div class="today-editor-topbar">
          <div class="today-editor-date-pill">
            <span class="today-top-date">${meta.monthDay} · ${meta.weekDayName}</span>
          </div>
          <div class="today-editor-status">
            <span class="today-save-indicator today-save-feedback" data-state="${draft?.status || 'saved'}" role="status" aria-live="polite">${draft ? ({ saved: '已保存', dirty: '有未保存的修改', saving: '正在保存…', authorization: '授权变更需点保存', error: '保存失败，内容已保留', conflict: '版本冲突，草稿已保留', deleted: '此条目已在别处删除，草稿仍保留' }[draft.status]) : isNew ? '新建手记草稿' : `版本 ${current.revision} · 已保存`}</span>
          </div>
        </div>

        <button type="button" class="today-back-to-list" data-action="back-to-list">‹ 返回列表</button>
        ${draft?.status === 'error' ? `<p class="today-save-recovery" role="alert">${esc(draft.error || '连接恢复后可重试。')}<button type="button" data-action="retry-save">重试保存</button></p>` : ''}
        ${draft?.status === 'conflict' ? `<div class="today-conflict today-conflict-panel"><p>最新保存版本：${esc(draft.conflict?.title || '无法读取，请重试加载')}</p><p>${esc(draft.conflict?.localDate || '')}${draft.conflict?.endDate ? ` 至 ${esc(draft.conflict.endDate)}` : ''} · ${esc(draft.conflict?.startTime || '无时间')} · ${draft.conflict?.useForCompanionship ? '已授权陪伴' : '私有'} · 版本 ${esc(draft.conflict?.revision || '')}</p><pre>${esc(draft.conflict?.content || '')}</pre>${draft.conflict ? '<button type="button" data-action="use-server">载入保存版本</button><button type="button" data-action="overwrite-save">用当前草稿保存</button>' : '<button type="button" data-action="retry-conflict">重试核对</button>'}</div>` : ''}
        <!-- 沉浸编辑核心表单 -->
        <div class="today-editor-surface">
          <!-- 标题输入：无框标题（正文级字号，写作优先） -->
          <div class="today-field-title-wrap">
            <input name="entry-title" class="today-input-seamless-title" value="${esc(entryTitle)}" placeholder="给这篇随笔或待办起个标题..." maxlength="120" aria-label="条目标题" />
          </div>

          <!-- 正文随笔：无框大文本区 -->
          <div class="today-field-content-wrap">
            <textarea aria-label="正文" name="entry-content" class="today-textarea-seamless-body" placeholder="${entryType === 'todo' ? '补充说明（可选）' : '写下生活感悟或随笔细节…'}">${esc(entryContent)}</textarea>
          </div>

          <!-- 备忘属性与伴听辅助卡片 -->
          <div class="today-editor-attributes">
            <div class="today-attrs-row">
              <label class="today-attr-item">
                <span class="today-attr-label">类型</span>
                <select name="entry-type" class="today-select-clean">
                  ${Object.entries(TYPE_OPTIONS).map(([value, label]) => `
                    <option value="${value}" ${entryType === value ? 'selected' : ''}>${label}</option>
                  `).join('')}
                </select>
              </label>

              <label class="today-attr-item">
                <span class="today-attr-label">归属日期</span>
                <input name="entry-date" type="date" value="${esc(entryDate)}" class="today-input-clean" />
              </label>

              <label class="today-attr-item">
                <span class="today-attr-label">结束日期（可选）</span><input name="entry-end-date" type="date" value="${esc(current?.endDate || '')}" aria-label="结束日期" /><span class="today-attr-label">时段（可选）</span>
                <div class="today-time-range-group">
                  <input aria-label="开始时间" name="entry-start" type="time" value="${esc(entryStart)}" class="today-input-clean" />
                  <span>至</span>
                  <input aria-label="结束时间" name="entry-end" type="time" value="${esc(entryEnd)}" class="today-input-clean" />
                </div>
              </label>

              ${entryType !== 'note' ? `<label class="today-attr-item"><span class="today-attr-label">重复</span><select name="entry-repeat" aria-label="重复频率">${Object.entries({none:'不重复',...(entryType === 'todo' ? {daily:'每天',weekly:'每周'} : {}),yearly:'每年'}).map(([key,label]) => `<option value="${key}" ${frequency === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}
              ${entryType === 'todo' && frequency === 'weekly' ? `<fieldset class="today-repeat-weekdays"><legend>每周哪些天</legend>${WEEKDAYS.map(([label,day]) => `<label><input type="checkbox" name="entry-weekday" value="${day}" ${repeatDays.includes(day) ? 'checked' : ''} />周${label}</label>`).join('')}</fieldset>` : ''}
              ${frequency !== 'none' ? '<p class="today-hint today-repeat-help">编辑会修改整个重复系列；勾选完成只影响列表标出的那一天。重复待办暂不支持跨日结束日期。</p>' : ''}
            </div>

            <!-- 伙伴陪伴与选歌授权 -->
            <details class="today-companion-box" data-detail="authorization"><summary>${entryCompanion ? '已授权伙伴参考 · 管理授权' : '私有记录 · 陪伴与选歌授权（可选）'}</summary>${current?.id && entryCompanion ? `<button type="button" data-action="revoke" data-id="${esc(current.id)}" class="today-action-btn">立即撤回授权</button>` : ''}
              <label class="today-companion-toggle">
                <input type="checkbox" name="entry-companion" ${entryCompanion ? 'checked' : ''} />
                <div class="today-toggle-text">
                  <strong>♪ 用于陪伴与选歌</strong>
                  <span>允许 Lunara 及音乐伙伴参考本篇手记的氛围与备注为你挑选配乐（备注会发送给当前配置的模型）</span>
                </div>
              </label>
              <div class="today-companion-details">
                <div class="today-grid-cols-2">
                  <label class="today-field">
                    <span class="today-field-label">选歌音乐偏好备注</span>
                    <input name="entry-note" value="${esc(entryNote)}" placeholder="例如：想听安静木吉他、需要提神的爵士" />
                  </label>
                  <label class="today-field">
                    <span class="today-field-label">场景标签</span>
                    <input name="entry-scene" value="${esc(entryScene)}" placeholder="如：专注写代码、散步、深夜微醺" />
                  </label>
                </div>
                <label class="today-checkbox-pill">
                  <input type="checkbox" name="entry-note-uses-title" ${entryNoteUsesTitle ? 'checked' : ''} />
                  <span>没有单独备注时，直接使用标题与正文摘要作为音乐灵感</span>
                </label>
                <fieldset class="today-people">
                  <legend>允许哪些伙伴感知</legend>
                  <div class="today-people-chips">
                    ${people().map(person => `
                      <label class="today-person-chip">
                        <input type="checkbox" name="entry-persons" value="${esc(person.id)}" ${entryPersons.includes(person.id) ? 'checked' : ''} />
                        <span class="today-chip-text">${esc(person.displayName || personName(person.id))}</span>
                      </label>`).join('') || '<span class="today-hint">请先创建一位伙伴</span>'}
                  </div>
                </fieldset>
              </div>
            </details>
          </div>

          <!-- 底部动作条 -->
          <div class="today-editor-actions">
            <div class="today-editor-actions-left">
              ${current?.id ? `
                <button type="button" class="today-btn-sub" data-action="new-entry">＋ 另起新篇</button>
                <button type="button" class="today-action-btn quiet-button delete-btn" data-action="delete" data-id="${esc(current.id)}">删除手记</button>${deleteConfirm === current.id ? `<span class="today-delete-confirm">确认删除？<button type="button" data-action="delete-confirm" data-id="${esc(current.id)}">确认删除</button><button type="button" data-action="delete-cancel">取消</button></span>` : ''}
              ` : ''}
            </div>
            <div class="today-editor-actions-right">
              <button type="button" class="today-btn-primary" data-action="add-entry" data-id="${esc(current?.id || '')}" data-revision="${current?.revision || 0}">
                ${isNew ? '确认添加到手记' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      </section>`;
  }

  // ---- 整体工作台主渲染 ----
  function render() {
    const panel = $('#today-panel');
    if (!panel) return;
    const focused = documentLike.activeElement;
    const focusName = focused?.getAttribute?.('name');
    const selection = typeof focused?.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    const focusedEntryId = focused?.dataset?.id;
    const editorScroll = panel.querySelector?.('.today-notes-editor-pane')?.scrollTop || 0;
    const listScroll = panel.querySelector?.('.today-notes-list')?.scrollTop || 0;
    const openDetails = [...(panel.querySelectorAll?.('details[data-detail][open]') || [])].map(node => node.dataset.detail);

    const meta = parseDateMeta(selectedDate);

    panel.innerHTML = `
      <header class="today-header today-workspace-header shell-page-head">
        <div class="today-header-info shell-page-copy">
          <h1 class="today-workspace-title shell-page-title">${meta.monthDay} <small>${meta.weekDayName}</small></h1>
          <p class="today-workspace-sub shell-page-sub">${meta.isToday ? '今天，' : '这一天，'}把生活的节拍留在这里。生活手记与日程，默认只有你能看见。</p>
        </div>
        <div class="today-header-actions shell-page-actions">
          <button type="button" class="today-btn-primary today-btn-new-note" data-action="new-entry">＋ 新建手记</button>
          <button type="button" class="today-quiet-btn" data-action="back-to-chat">返回聊天</button>
        </div>
      </header>

      ${loading ? '<p role="status" class="today-loading-bar">正在加载生活手记…</p>' : ''}

      <div class="today-workspace-body ${detailOpen ? 'is-detail-open' : ''}">
        <!-- 左侧栏：分类视图与手记卡片列表 -->
        <aside class="today-notes-sidebar">
          <nav class="today-filter-tabs" aria-label="手记类型筛选">
            <button type="button" class="today-filter-tab ${selectedView === 'all' ? 'is-active' : ''}" data-action="switch-view" data-view="all">全部 <span>${data.entries.length}</span></button>
            <button type="button" class="today-filter-tab ${selectedView === 'today' ? 'is-active' : ''}" data-action="switch-view" data-view="today">所选日</button>
            <button type="button" class="today-filter-tab ${selectedView === 'note' ? 'is-active' : ''}" data-action="switch-view" data-view="note">随笔 <span>${data.entries.filter(entry => entry.type === 'note').length}</span></button>
            <button type="button" class="today-filter-tab ${selectedView === 'todo' ? 'is-active' : ''}" data-action="switch-view" data-view="todo">待办 <span>${taskCounts(data.entries, localToday(), selectedDate).open}</span></button>
            <button type="button" class="today-filter-tab ${selectedView === 'important_date' ? 'is-active' : ''}" data-action="switch-view" data-view="important_date">日子 <span>${data.entries.filter(entry => entry.type === 'important_date').length}</span></button>
          </nav>

          <div class="today-search-sort today-list-tools"><input class="today-search-field" name="task-search" type="search" placeholder="搜索标题、正文或场景" aria-label="搜索手记" value="${esc(search)}" /><select name="task-sort" aria-label="日期排序"><option value="date-asc" ${sort === 'date-asc' ? 'selected' : ''}>日期从早到晚</option><option value="date-desc" ${sort === 'date-desc' ? 'selected' : ''}>日期从晚到早</option></select></div>
          ${selectedView === 'todo' ? `<nav class="today-task-filters" aria-label="待办状态">${Object.entries({ open: '未完成', today: '今天', overdue: '逾期', week: '未来七天', completed: '已归档' }).map(([key, label]) => `<button type="button" data-action="task-filter" data-filter="${key}" aria-pressed="${taskFilter === key}" class="today-task-filter ${taskFilter === key ? 'is-active' : ''}">${label} <span>${taskCounts(data.entries, localToday(), selectedDate)[key]}</span></button>`).join('')}</nav>` : ''}
          ${selectedView === 'todo' && taskFilter === 'completed' ? '<p class="today-hint">已归档显示全部完成记录；恢复只影响标出的那一次。打开详情会编辑整个系列。</p>' : ''}
          ${search || (selectedView === 'todo' && taskFilter !== 'open') ? '<button type="button" data-action="clear-filters">清除筛选</button>' : ''}
          ${loadErrors.entries ? '<p class="today-load-error today-error-banner" role="alert">条目加载失败，现有内容已保留。<button type="button" data-action="retry-load">重试</button></p>' : ''}
          <div class="today-date-strip">
            <div class="today-strip-nav">
              <button type="button" class="today-icon-btn" data-action="prev-date" title="前一天">‹</button>
              <span class="today-strip-date-text">${meta.monthDay} · ${meta.weekDayName}</span>
              ${!meta.isToday ? '<button type="button" class="today-pill-btn today-micro-btn" data-action="today-date">今天</button>' : ''}
              <button type="button" class="today-icon-btn" data-action="next-date" title="后一天">›</button>
            </div>
            <label class="today-strip-picker-wrap" title="选择日期查看">
              <span class="today-picker-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"><path d="M7 3v4m10-4v4M4 9h16M4 5h16v16H4z"/></svg></span>
              <input name="day-date" data-action="change-date" type="date" value="${esc(selectedDate)}" aria-label="查看日期" />
            </label>
          </div>

          <div class="today-quick-add"><p class="today-quick-add-date">添加到 ${esc(quickBatch?.date || selectedDate)}${quickBatch ? ` · 待重试 ${quickBatch.rows.length} 条` : ' · 换行可一次多条'}</p>
            <textarea name="quick-todo" data-action="quick-add" rows="1"
              placeholder="＋ 添加待办，回车确认"
              aria-label="快速添加待办，一行一条，回车确认">${esc(quickAddDraft)}</textarea>
            <button type="button" class="today-action-btn today-quick-add-btn" data-action="quick-add-submit"
              title="把输入框里的每一行添加为待办" ${quickAddInFlight ? 'disabled' : ''}>${quickAddInFlight ? '正在添加…' : quickBatch ? '重试未保存项' : '添加'}</button>
            ${quickBatch && !quickAddInFlight ? '<p class="today-hint">重试使用上次提交的内容和日期；新输入会保留，完成重试后可继续添加。若需纠正失败内容，可结束重试。响应丢失的条目可能已经保存，请先核对列表。</p><button type="button" data-action="abandon-batch" class="today-quiet-btn">结束重试，编辑为新批次</button>' : ''}
          </div>

          <ul class="today-entries today-notes-list">
            ${renderNotesList()}
          </ul>
        </aside>

        <!-- 列表与编辑器之间的分隔线：拖动分配两栏宽度（宽度记在本机，双击恢复默认）。 -->
        <div class="today-split" role="separator" aria-orientation="vertical" tabindex="0"
          aria-label="调整列表与编辑器的宽度" title="拖动调整宽度，双击恢复默认"
          aria-valuemin="280" aria-valuemax="640"></div>

        <!-- 中央主栏：沉浸式书写与手记编辑 -->
        <section class="today-notes-editor-pane" aria-label="手记编辑">
          ${renderEditorPane()}
        </section>
      </div>`;

    for (const key of openDetails) panel.querySelector?.(`details[data-detail="${key}"]`)?.setAttribute?.('open', '');
    if (focusName && /^[a-z0-9-]+$/.test(focusName)) {
      const field = panel.querySelector?.(`[name="${focusName}"]`);
      field?.focus?.({ preventScroll: true });
      if (selection) field?.setSelectionRange?.(...selection);
    }
    const editorPane = panel.querySelector?.('.today-notes-editor-pane');
    const list = panel.querySelector?.('.today-notes-list');
    if (editorPane) editorPane.scrollTop = editorScroll;
    if (list) list.scrollTop = resetListScroll ? 0 : listScroll;
    resetListScroll = false;
    if (!focusName && focusedEntryId) {
      const selectionTarget = panel.querySelector?.(`[data-action="select-entry"][data-id="${focusedEntryId}"]`)
        || panel.querySelector?.('[data-action="select-entry"]') || panel.querySelector?.('[data-action="new-entry"]');
      selectionTarget?.focus?.({ preventScroll: true });
    }
  }

  function handleEvent(event) {
    const target = event.target?.closest?.('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    if (event.type === 'keydown') {
      // 中文输入法选词的回车不触发添加。
      if (action === 'quick-add' && event.key === 'Enter' && !event.shiftKey
        && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault?.();
        return void quickAddTodos(target.value);
      }
      return;
    }
    const changeOnly = ['change-date', 'segment-count', 'toggle-done'].includes(action);
    if ((changeOnly && event.type !== 'change') || (!changeOnly && event.type !== 'click')) return;

    if (action === 'abandon-batch' && !quickAddInFlight) { quickBatch = null; render(); return; }
    if (action === 'retry-load') return void load();
    if (action === 'task-filter') { taskFilter = target.dataset.filter; resetListScroll = true; render(); return; }
    if (action === 'clear-filters') { search = ''; taskFilter = 'open'; resetListScroll = true; render(); return; }
    if (action === 'back-to-list') {
      detailOpen = false; render();
      $('#today-panel')?.querySelector?.(`[data-action="select-entry"][data-id="${selectedEntryId}"]`)?.focus?.(); return;
    }
    if (action === 'retry-save') return void drafts.save(editorKey(), { manual: true });
    if (action === 'use-server') return drafts.useServer(editorKey());
    if (action === 'overwrite-save') return void drafts.save(editorKey(), { manual: true, overwrite: true });
    if (action === 'retry-conflict') return void drafts.conflict(editorKey(), renderedEditor.entry);
    if (action === 'delete-cancel') { deleteConfirm = null; render(); return; }
    if (action === 'quick-add-submit') {
      const box = $('#today-panel')?.querySelector?.('[name="quick-todo"]');
      return void quickAddTodos(box?.value ?? '');
    }

    if (action === 'change-date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target.value)) return;
      selectedDate = target.value;
      return void load();
    }
    if (action === 'prev-date') {
      selectedDate = shiftDate(selectedDate, -1);
      return void load();
    }
    if (action === 'next-date') {
      selectedDate = shiftDate(selectedDate, 1);
      return void load();
    }
    if (action === 'today-date') {
      selectedDate = localToday();
      return void load();
    }
    if (action === 'switch-view') {
      selectedView = target.dataset.view || 'all'; resetListScroll = true;
      render();
      return;
    }
    if (action === 'select-entry') {
      const entryId = target.dataset.id;
      if (entryId) {
        selectedEntryId = entryId; detailOpen = true;
        render();
        $('#today-panel')?.querySelector?.('[name="entry-title"]')?.focus?.({ preventScroll: true });
      }
      return;
    }
    if (action === 'new-entry') {
      selectedEntryId = null; detailOpen = true;
      render();
      const titleInput = $('#today-panel')?.querySelector?.('[name="entry-title"]');
      titleInput?.focus?.();
      return;
    }
    const panel = $('#today-panel');
    const { value, checked } = readForm(panel);
    const entry = target.closest?.('.today-entry');

    if (action === 'add-entry') {
      if (!renderedEditor) return;
      const useCompanion = checked('entry-companion');
      const persons = [...panel.querySelectorAll('[name="entry-persons"]:checked')].map(input => input.value);
      if (useCompanion && !persons.length) {
        showToast('error', '还差一步', '开启“用于陪伴与选歌”至少选择一位伙伴。', { curated: true });
        return;
      }

      const editingId = target.dataset.id || selectedEntryId;
      const payload = {
        type: value('entry-type') || 'note',
        title: value('entry-title'),
        content: value('entry-content') || null,
        localDate: value('entry-date') || selectedDate,
        startTime: value('entry-start') || null,
        endTime: value('entry-end') || null, endDate: value('entry-end-date') || null,
        repeatFrequency: value('entry-repeat') || 'none',
        repeatWeekdays: [...panel.querySelectorAll('[name="entry-weekday"]:checked')].map(node => Number(node.value)),
        yearlyRepeat: value('entry-repeat') === 'yearly',
        useForCompanionship: useCompanion,
        companionNote: value('entry-note') || null,
        noteUsesTitle: checked('entry-note-uses-title'),
        allowedPersonIds: persons,
        sceneTag: value('entry-scene') || null,
      };

      return void saveEntry(editingId, payload);
    }

    const targetId = entry?.dataset?.id || target.dataset.id || selectedEntryId;
    if (action === 'toggle-done' && targetId) return void mutateEntry(targetId, 'done', { done: target.checked, ...(entry?.dataset?.occurrenceDate ? { occurrenceDate: entry.dataset.occurrenceDate } : {}) });
    if (action === 'move-today' || action === 'move-tomorrow') {
      const current = data.entries.find(item => item.id === targetId);
      const changes = current && rescheduleEntry(current, shiftDate(localToday(), action === 'move-tomorrow' ? 1 : 0));
      if (changes) return void mutateEntry(targetId, 'reschedule', changes);
      return;
    }
    if (action === 'revoke' && targetId) return void mutateEntry(targetId, 'revoke');
    if (action === 'delete' && targetId) { deleteConfirm = targetId; render(); return; }
    if (action === 'delete-confirm' && targetId) return void mutateEntry(targetId, 'delete');

    return undefined;
  }

  function init() {
    const panel = $('#today-panel');
    const clockTimer = setInterval(() => { if (panel && !panel.hidden && !composing) render(); }, 60000);
    clockTimer.unref?.();
    documentLike.defaultView?.addEventListener?.('beforeunload', event => {
      if (drafts.hasPending() || quickAddDraft || quickBatch) { event.preventDefault(); event.returnValue = ''; }
    });
    panel?.addEventListener?.('compositionstart', () => { composing = true; });
    panel?.addEventListener?.('compositionend', event => { composing = false; recordEditorInput(event); });
    panel?.addEventListener?.('input', recordEditorInput);
    panel?.addEventListener?.('change', recordEditorInput);
    panel?.addEventListener?.('click', handleEvent);
    panel?.addEventListener?.('change', handleEvent);
    panel?.addEventListener?.('keydown', handleEvent);
    return api;
  }

  const api = Object.freeze({ init, load, render });
  return api;
}

export default createTodayView;
