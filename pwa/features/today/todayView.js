import { repeatFrequency, entryOccursOn, isRecurringTask } from '../../core/lifeRecurrence.js';
import { wallTime, colorFor } from '../../visuals/cikePresentation.js';
import { createEntryDrafts, entryRequestId, deriveTitleFromContent, MAX_ENTRY_CONTENT_LENGTH } from './entryDrafts.js';
import { filterTaskEntries, taskCounts, entryOccurrence, rescheduleEntry, shiftLocalDate, entryRecencyMs, recencyBucketLabel, isTask } from './taskWorkspace.js';

// 手帐工作台（Scheme B · 同页拾光 · Co-Page Journal）
// Apple 备忘录式的安静秩序 × 黑胶票根与页边同页批注；
// 默认仅自己可见，碎片抽屉严格只读播歌与聊天原话，绝不切歌或自动发言。

const TYPE_OPTIONS = Object.freeze({ note: '随笔', todo: '待办', important_date: '重要日子' });
const MOOD_PRESETS = Object.freeze(['平静', '温柔', '微醺', '疲惫', '欣喜', '怀旧']);
const WEEKDAYS = Object.freeze([['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 0]]);
const WEEK_DOW_LABELS = Object.freeze(['日', '一', '二', '三', '四', '五', '六']);
const LAYOUT_ORDER = Object.freeze(['blank', 'dotgrid', 'playbill']);
const LAYOUT_LABELS = Object.freeze({ blank: '素笺', dotgrid: '点阵', playbill: '刊页' });

const ICONS = Object.freeze({
  search: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.3"/><path d="M13 13l4 4"/></svg>',
  compose: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.8 4.2l4 4L7.2 16.8H3.2v-4l8.6-8.6z"/><path d="M10.2 5.8l4 4"/></svg>',
  back: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5"/></svg>',
  checklist: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="6.2" r="1.4"/><circle cx="5" cy="13.8" r="1.4"/><path d="M9 6.2h7.5M9 13.8h7.5"/></svg>',
  clip: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M13.5 6.8l-5.7 5.7a2.1 2.1 0 003 3l6.2-6.2a3.5 3.5 0 00-5-5L5.3 11a4.8 4.8 0 006.8 6.8l4.9-4.9"/></svg>',
  partner: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="7.5" r="2.8"/><path d="M3.5 16a4.8 4.8 0 019 0"/><path d="M14.5 9.5v4M12.5 11.5h4"/></svg>',
  dice: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="13" height="13" rx="2.5"/><circle cx="7.5" cy="7.5" r="0.9" fill="currentColor"/><circle cx="12.5" cy="12.5" r="0.9" fill="currentColor"/><circle cx="12.5" cy="7.5" r="0.9" fill="currentColor"/><circle cx="7.5" cy="12.5" r="0.9" fill="currentColor"/></svg>',
  more: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="10" r="1" fill="currentColor"/><circle cx="10" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/></svg>',
  pin: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 3.5l4 4-2.2 2.2.7 3.8-4.5-4.5-3.8-.7L9 6 7 4l5.5-.5zM6.5 13.5L3 17"/></svg>',
  close: '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>',
  check: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>',
  disc: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><circle cx="10" cy="10" r="2.2"/></svg>',
  heart: '<svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 16.8l-1.2-1.1C4.4 11.7 2 9.4 2 6.5A4.1 4.1 0 016.2 2.5c1.5 0 2.9.8 3.8 2 .9-1.2 2.3-2 3.8-2A4.1 4.1 0 0118 6.5c0 2.9-2.4 5.2-6.8 9.2L10 16.8z"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 6h11M8 6V4h4v2M6.5 6l.7 10h5.6l.7-10"/></svg>',
});

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/gu, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA');

function localToday() {
  return DATE_FORMATTER.format(new Date());
}

function localDateFromMs(ms) {
  return Number.isFinite(ms) && ms > 0 ? DATE_FORMATTER.format(new Date(ms)) : '';
}

function shiftDate(dateStr, deltaDays) {
  return shiftLocalDate(dateStr || localToday(), deltaDays);
}

function parseDateMeta(dateStr) {
  const safeStr = dateStr || localToday();
  const [y, m, d] = safeStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const weekDays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return {
    year: y,
    month: m,
    day: d,
    monthDay: `${m}月${d}日`,
    weekDayName: weekDays[date.getDay()] || '',
    isToday: safeStr === localToday(),
  };
}

function formatTagsString(tags) {
  return Array.isArray(tags) ? tags.filter(Boolean).join(', ') : '';
}

function parseTagsString(value) {
  return [...new Set(String(value || '').split(/[,，\s]+/u).map(item => item.trim()).filter(Boolean))].slice(0, 8);
}

function inlineMarkdownHtml(text) {
  return esc(text)
    .replace(/`([^`]+)`/gu, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
}

export function renderMarkdownPreview(content) {
  const raw = String(content || '');
  if (!raw.trim()) return '<p class="today-empty-sub">暂无正文内容</p>';
  const lines = raw.split(/\r?\n/u);
  return lines.map((line, idx) => {
    const check = line.match(/^\s*-\s*\[( |x|X)\]\s*(.*)$/u);
    if (check) {
      const checked = check[1].toLowerCase() === 'x';
      return `<label class="today-inline-check${checked ? ' is-checked' : ''}"><input type="checkbox" ${checked ? 'checked' : ''} data-action="toggle-inline-check" data-line="${idx}" /><span>${inlineMarkdownHtml(check[2])}</span></label>`;
    }
    const h3 = line.match(/^###\s+(.+)$/u);
    if (h3) return `<h3>${inlineMarkdownHtml(h3[1])}</h3>`;
    const h2 = line.match(/^##\s+(.+)$/u);
    if (h2) return `<h2>${inlineMarkdownHtml(h2[1])}</h2>`;
    const h1 = line.match(/^#\s+(.+)$/u);
    if (h1) return `<h1>${inlineMarkdownHtml(h1[1])}</h1>`;
    const quote = line.match(/^>\s*(.+)$/u);
    if (quote) return `<blockquote>${inlineMarkdownHtml(quote[1])}</blockquote>`;
    const bullet = line.match(/^\s*[-*]\s+(.+)$/u);
    if (bullet) return `<p>• ${inlineMarkdownHtml(bullet[1])}</p>`;
    if (!line.trim()) return '<p></p>';
    return `<p>${inlineMarkdownHtml(line)}</p>`;
  }).join('');
}

export function toggleChecklistLine(content, lineIndex) {
  const lines = String(content || '').split(/\r?\n/u);
  if (lineIndex < 0 || lineIndex >= lines.length) return content;
  lines[lineIndex] = lines[lineIndex].replace(/^(\s*-\s*\[)( |x|X)(\]\s*)/u, (_, p, mark, s) =>
    `${p}${mark.toLowerCase() === 'x' ? ' ' : 'x'}${s}`);
  return lines.join('\n');
}

export function normalizeShareScope(entry = {}) {
  const raw = String(entry?.shareScope || '').trim();
  if (raw === 'summary' || raw === 'title_summary') return 'summary';
  if (raw === 'note' || raw === 'note_only') return 'note';
  return entry?.noteUsesTitle ? 'summary' : 'note';
}

export function computeLocalCompanionshipPreview(entry = {}) {
  const authorized = Boolean(entry.useForCompanionship) && Array.isArray(entry.allowedPersonIds) && entry.allowedPersonIds.length > 0;
  if (!authorized) return '仅自己可见；选一位伙伴即可同页写字与留批注。';
  const scope = normalizeShareScope(entry);
  const note = String(entry.companionNote || '').trim();
  const title = String(entry.title || '').trim() || (entry.type === 'note' ? deriveTitleFromContent(entry.content, entry) : '');
  const snippet = String(entry.content || '').replace(/\s+/gu, ' ').trim().slice(0, 60);
  const tracks = Array.isArray(entry.attachedTracks) && entry.attachedTracks.length
    ? entry.attachedTracks
    : (entry.attachedTrack?.title ? [entry.attachedTrack] : []);
  const trackText = tracks.length ? `（配乐：${tracks.map(t => t.title).join('、')}）` : '';
  if (scope === 'summary') {
    const core = [title, snippet].filter(Boolean).join(' — ');
    return core ? `同页伙伴会看到：${core}${trackText}${note ? `（备注：${note}）` : ''}` : `同页共享已开启${trackText || '，伙伴可结合这页留批注'}`;
  }
  return note ? `伙伴只会看到你的选歌备注：${note}${trackText}` : `伙伴不会看到正文${trackText}，可补充一句选歌备注。`;
}

function trackKey(track) {
  if (!track) return '';
  return track.songId ? `${track.provider || 'unknown'}:${track.songId}` : `${track.title || ''}::${track.artist || ''}`;
}

function quoteKey(quote) {
  if (!quote) return '';
  return quote.turnId ? `turn:${quote.turnId}` : `${quote.speaker || ''}::${quote.time || ''}::${quote.text || ''}`;
}

function effectiveTracksOf(entry = {}) {
  if (Array.isArray(entry.attachedTracks) && entry.attachedTracks.length) return entry.attachedTracks;
  return entry.attachedTrack?.title ? [entry.attachedTrack] : [];
}

function shortRowTime(entry, todayStr) {
  const ms = entryRecencyMs(entry, entry.occurrenceDate || entry.localDate || todayStr);
  const dateStr = localDateFromMs(ms) || entry.occurrenceDate || entry.localDate || todayStr;
  if (dateStr === todayStr && Number.isFinite(ms) && ms > 0) {
    const dt = new Date(ms);
    return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(dateStr)) return `${dateStr.slice(5, 7)}/${dateStr.slice(8, 10)}`;
  return dateStr;
}

export function createTodayView({
  apiClient,
  documentLike = globalThis.document,
  getPeople = () => [],
  getNowPlaying = () => null,
  onTalkAboutEntry = null,
  showToast = () => {},
  onError = () => {},
  scheduleInterval = globalThis.setInterval.bind(globalThis),
  undoTimeoutMs = 5000,
  autosaveDelayMs = 1800,
} = {}) {
  if (!apiClient?.get || !apiClient?.post) throw new TypeError('today view requires an api client');
  const $ = selector => documentLike.querySelector(selector);
  const SUPPORTS_FIELD_SIZING = Boolean(
    documentLike?.defaultView?.CSS?.supports?.('field-sizing', 'content')
    ?? globalThis.CSS?.supports?.('field-sizing', 'content'),
  );

  let data = { entries: [] };
  let dayMusic = [];
  let dayQuotes = [];
  let openLoops = [];
  let selectedDate = localToday();
  let lastWallDate = localToday();
  let selectedView = 'all';
  let taskFilter = 'open';
  let search = '';
  let sort = 'updated-desc';
  let selectedEntryId = null;
  let detailOpen = false;
  let inspectorTab = null; // null | 'fragments' | 'partner'
  let popover = null;      // null | 'more'
  let moreAdvancedOpen = false;
  let replyingAnnId = null;
  let annotationBusy = false;
  let annotationError = '';
  let loading = false;
  let loadRevision = 0;
  let mutationRevision = 0;
  let deleteConfirm = null;
  let loadErrors = {};
  let editingInput = false;
  let composing = false;
  let resetListScroll = false;
  let pendingDelete = null;
  let pendingDirtyField = '';
  let lastTitleLen = 0;
  let lastBodyLen = 0;
  let previewCache = { key: '', text: '' };
  let previewTimer = null;
  let previewRevision = 0;
  const resizeRafs = new Map();
  const mutationLocks = new Set();
  let lastSavedMeta = null;
  let lastPlayingKey = '';
  let sheetCursor = null;

  function contentLinesOf(content) {
    const raw = String(content ?? '');
    return raw === '' ? [] : raw.split(/\r?\n/u);
  }

  function rememberSheetCursor(target) {
    if (!target) return;
    if (target.name === 'entry-title') {
      sheetCursor = { zone: 'title' };
      return;
    }
    if (target.name === 'entry-check-item' && target.dataset?.checkId) {
      sheetCursor = { zone: 'check', checkId: target.dataset.checkId };
      return;
    }
    if (target.name === 'entry-content' || target.name === 'entry-content-seg') {
      const val = String(target.value ?? '');
      sheetCursor = {
        zone: 'prose',
        segStart: Number(target.dataset?.segStart ?? 0),
        segEnd: Number(target.dataset?.segEnd ?? contentLinesOf(val).length),
        selectionStart: typeof target.selectionStart === 'number' ? target.selectionStart : val.length,
      };
    }
  }

  function collectBlocksByBoundary(entry, totalLines) {
    const clampLine = val => (Number.isInteger(val) && val >= 0 ? Math.min(val, totalLines) : totalLines);
    const byLine = new Map();
    const push = block => {
      const list = byLine.get(block.afterLine) || [];
      list.push(block);
      byLine.set(block.afterLine, list);
    };
    (entry.checklist || []).forEach((item, idx) => push({
      kind: 'check',
      item,
      idx,
      afterLine: clampLine(item.afterLine),
      order: Number.isFinite(item.order) ? Number(item.order) : idx,
    }));
    effectiveTracksOf(entry).forEach((item, idx) => push({
      kind: 'track',
      item,
      idx,
      afterLine: clampLine(item.afterLine),
      order: Number.isFinite(item.order) ? Number(item.order) : 1000 + idx,
    }));
    (entry.attachedQuotes || []).forEach((item, idx) => push({
      kind: 'quote',
      item,
      idx,
      afterLine: clampLine(item.afterLine),
      order: Number.isFinite(item.order) ? Number(item.order) : 2000 + idx,
    }));
    for (const list of byLine.values()) list.sort((a, b) => a.order - b.order);
    const bounds = [...byLine.keys()].sort((a, b) => a - b);
    return { byLine, bounds };
  }

  function resolveCursorInsertion(current, { afterCheckId = null } = {}) {
    const lines = contentLinesOf(current.content);
    const { byLine } = collectBlocksByBoundary(current, lines.length);
    const orderAfter = (lineIdx, prevOrder) => {
      const group = byLine.get(lineIdx) || [];
      if (!Number.isFinite(prevOrder)) {
        return group.length ? group[group.length - 1].order + 1 : 1;
      }
      const next = group.find(b => b.order > prevOrder);
      return next ? (prevOrder + next.order) / 2 : prevOrder + 1;
    };
    const identityShift = list => list;

    const targetCheckId = afterCheckId || (sheetCursor?.zone === 'check' ? sheetCursor.checkId : '');
    if (targetCheckId) {
      const chkIdx = (current.checklist || []).findIndex(c => c.id === targetCheckId);
      if (chkIdx >= 0) {
        const chk = current.checklist[chkIdx];
        const lineIdx = Number.isInteger(chk.afterLine) && chk.afterLine >= 0 ? Math.min(chk.afterLine, lines.length) : lines.length;
        const baseOrder = Number.isFinite(chk.order) ? Number(chk.order) : chkIdx;
        return { content: String(current.content || ''), afterLine: lineIdx, order: orderAfter(lineIdx, baseOrder), shiftList: identityShift };
      }
    }

    if (sheetCursor?.zone === 'title') {
      return { content: String(current.content || ''), afterLine: 0, order: orderAfter(0, null), shiftList: identityShift };
    }

    if (sheetCursor?.zone === 'block' && Number.isInteger(sheetCursor.afterLine)) {
      const lineIdx = Math.min(sheetCursor.afterLine, lines.length);
      return { content: String(current.content || ''), afterLine: lineIdx, order: orderAfter(lineIdx, sheetCursor.order), shiftList: identityShift };
    }

    if (sheetCursor?.zone === 'prose') {
      const segStart = Math.max(0, Math.min(sheetCursor.segStart || 0, lines.length));
      const segEnd = Math.max(segStart, Math.min(sheetCursor.segEnd ?? lines.length, lines.length));
      const segText = lines.slice(segStart, segEnd).join('\n');
      const pos = Math.max(0, Math.min(sheetCursor.selectionStart ?? segText.length, segText.length));
      const headText = segText.slice(0, pos).replace(/\r?\n$/u, '');
      const tailText = segText.slice(pos).replace(/^\r?\n/u, '');
      const headLines = headText === '' ? [] : headText.split(/\r?\n/u);
      const tailLines = tailText === '' ? [] : tailText.split(/\r?\n/u);
      const nextLines = [...lines.slice(0, segStart), ...headLines, ...tailLines, ...lines.slice(segEnd)];
      const afterLine = segStart + headLines.length;
      const oldSpan = segEnd - segStart;
      const delta = (headLines.length + tailLines.length) - oldSpan;
      const shiftList = list => (Array.isArray(list) ? list.map(item => {
        const oldLine = Number.isInteger(item.afterLine) && item.afterLine >= 0 ? Math.min(item.afterLine, lines.length) : lines.length;
        if (oldLine <= segStart) return item;
        return { ...item, afterLine: Math.max(afterLine + tailLines.length, oldLine + delta) };
      }) : []);
      const shiftedCurrent = shiftList(byLine.get(afterLine)?.map(b => b.item) || []);
      void shiftedCurrent;
      return {
        content: nextLines.join('\n'),
        afterLine,
        order: orderAfter(afterLine, null),
        shiftList,
      };
    }

    const fallbackLine = lines.length === 0 ? 0 : lines.length;
    return { content: String(current.content || ''), afterLine: fallbackLine, order: orderAfter(fallbackLine, null), shiftList: identityShift };
  }

  const playingKeyOf = track => (track?.songId ? `${track.provider || ''}:${track.songId}:${track.title || ''}` : '');

  function isEditorTextFocused() {
    const panel = $('#today-panel');
    const active = documentLike?.activeElement;
    if (!panel || !active) return false;
    const inEditor = typeof active.closest === 'function'
      ? Boolean(active.closest('.today-notes-editor-pane') || active.closest('.today-spread') || active.closest('.today-editor-card'))
      : false;
    if (!inEditor) return false;
    const tag = String(active.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  const drafts = createEntryDrafts({
    request: (...args) => apiClient.request(...args),
    fetchLatest: async id => (await apiClient.get('/api/life/entries')).entries?.find(entry => entry.id === id) || null,
    delay: autosaveDelayMs,
    isBlocked: key => mutationLocks.has(key),
    onSaved(saved, oldKey) {
      mutationRevision++;
      loadRevision++;
      loading = false;
      data.entries = [...data.entries.filter(entry => entry.id !== saved.id), saved];
      lastSavedMeta = { saved, isNew: oldKey !== saved.id };
      if (editorKey() === oldKey) selectedEntryId = saved.id;
      if (renderedEditor?.key === oldKey) {
        renderedEditor.key = saved.id;
        renderedEditor.entry = drafts.get(saved.id)?.entry || saved;
      }
    },
    onChange(record) {
      const focused = isEditorTextFocused();
      if (!editingInput && !composing && !focused) render();
      else {
        updateSheetMetrics(record, { dirtyField: pendingDirtyField });
        if (record?.status === 'saved' && focused) {
          const meta = lastSavedMeta;
          lastSavedMeta = null;
          if (meta?.saved) syncEntryInListInPlace(meta.saved, { isNew: meta.isNew });
          else renderListInPlace();
        }
      }
    },
  });

  let renderedEditor = null;
  const editorKey = () => selectedEntryId || `new:${selectedDate}`;
  const people = () => getPeople().filter(person => !person.archivedAt && person.status !== 'archived');
  const personName = id => people().find(person => person.id === id)?.displayName || (id === 'lunara' ? 'Lunara' : '伙伴');

  const saveLabels = {
    saved: '已自动保存',
    dirty: '有未保存的修改',
    saving: '正在保存…',
    authorization: '共享变更待确认',
    error: '未保存，请重试',
    conflict: '发现新版本冲突，草稿已保留',
    deleted: '此页已在别处删除，草稿仍保留',
  };

  const editorFields = {
    'entry-title': 'title',
    'entry-content': 'content',
    'entry-type': 'type',
    'entry-date': 'localDate',
    'entry-end-date': 'endDate',
    'entry-start': 'startTime',
    'entry-end': 'endTime',
    'entry-repeat': 'repeatFrequency',
    'entry-companion': 'useForCompanionship',
    'entry-note': 'companionNote',
    'entry-note-uses-title': 'noteUsesTitle',
    'entry-scene': 'sceneTag',
  };

  function applyTextareaResize(node, minHeight, mayShrink = false) {
    if (SUPPORTS_FIELD_SIZING || !node?.style || typeof node.scrollHeight !== 'number') return;
    const client = Number(node.clientHeight || 0);
    if (!mayShrink && client > 0 && node.scrollHeight <= client) return;
    if (mayShrink && node.style.height && node.style.height !== 'auto') node.style.height = 'auto';
    const afterClient = Number(node.clientHeight || 0);
    if (node.scrollHeight > Math.max(afterClient, minHeight)) {
      node.style.height = `${node.scrollHeight + 2}px`;
    } else if (mayShrink && node.style.height && node.style.height !== 'auto') {
      node.style.height = 'auto';
    }
  }

  function scheduleTextareaResize(node, minHeight) {
    if (SUPPORTS_FIELD_SIZING || !node?.style || typeof node.scrollHeight !== 'number') return;
    const raf = documentLike.defaultView?.requestAnimationFrame;
    if (typeof raf !== 'function') {
      applyTextareaResize(node, minHeight, false);
      return;
    }
    const key = node.name || node.id || 'textarea';
    const prev = resizeRafs.get(key);
    if (prev && typeof documentLike.defaultView?.cancelAnimationFrame === 'function') {
      documentLike.defaultView.cancelAnimationFrame(prev);
    }
    const id = raf(() => {
      resizeRafs.delete(key);
      applyTextareaResize(node, minHeight, false);
    });
    resizeRafs.set(key, id);
  }

  function autoResizeTextarea(node, minHeight) {
    if (SUPPORTS_FIELD_SIZING) return;
    applyTextareaResize(node, minHeight, true);
  }

  function requestPreviewSync(entry) {
    clearTimeout(previewTimer);
    if (!entry?.useForCompanionship || !entry?.allowedPersonIds?.length) {
      previewCache = { key: '', text: '' };
      return;
    }
    const scope = normalizeShareScope(entry);
    const reqKey = JSON.stringify({
      t: entry.title || '',
      c: String(entry.content || '').slice(0, 120),
      u: Boolean(entry.useForCompanionship),
      s: scope,
      n: entry.companionNote || '',
      p: entry.allowedPersonIds || [],
    });
    const rev = ++previewRevision;
    previewTimer = setTimeout(async () => {
      try {
        const res = await apiClient.post('/api/life/entries/preview-context', {
          type: entry.type || 'note',
          title: entry.title || '',
          content: entry.content || '',
          useForCompanionship: Boolean(entry.useForCompanionship),
          shareScope: scope,
          noteUsesTitle: Boolean(entry.noteUsesTitle),
          companionNote: entry.companionNote || null,
          allowedPersonIds: entry.allowedPersonIds || [],
        });
        if (rev !== previewRevision || !res?.preview) return;
        previewCache = { key: reqKey, text: res.preview };
        const previewNode = $('#today-panel')?.querySelector?.('[data-partner-preview-text]');
        if (previewNode) previewNode.textContent = res.preview;
      } catch {
        // 离线保留本地即时预览
      }
    }, 400);
    previewTimer.unref?.();
  }

  function currentPreviewText(entry) {
    const reqKey = JSON.stringify({
      t: entry.title || '',
      c: String(entry.content || '').slice(0, 120),
      u: Boolean(entry.useForCompanionship),
      s: normalizeShareScope(entry),
      n: entry.companionNote || '',
      p: entry.allowedPersonIds || [],
    });
    if (previewCache.key === reqKey && previewCache.text) return previewCache.text;
    return computeLocalCompanionshipPreview(entry);
  }

  function renderEditorBannerHtml(draft) {
    if (draft?.status === 'error') {
      return `<div class="today-error-banner"><span>${esc(draft.error || '暂时没有保存，内容仍保留在这里。')}</span><button type="button" class="today-quiet-btn" data-action="retry-save">重试保存</button></div>`;
    }
    if (draft?.status === 'conflict') {
      return `<div class="today-error-banner"><span>该记录已在别处更新（保留了你的本地草稿）。</span><div class="today-error-actions"><button type="button" class="today-quiet-btn" data-action="overwrite-save">以当前草稿覆盖</button><button type="button" class="today-quiet-btn" data-action="use-server">采用服务器版本</button></div></div>`;
    }
    if (draft?.status === 'deleted') {
      return `<div class="today-error-banner"><span>此记录已被删除，你的本地文字仍保留。</span><button type="button" class="today-quiet-btn" data-action="save-as-new">存为新记录</button></div>`;
    }
    return '';
  }

  function updateSaveStatus(draft = drafts.get(editorKey())) {
    const panel = $('#today-panel');
    const status = panel?.querySelector?.('.today-save-indicator');
    const saveBtn = panel?.querySelector?.('[data-action="add-entry"]');
    const deleteBtn = panel?.querySelector?.('[data-action="soft-delete"]');
    const revokeBtn = panel?.querySelector?.('[data-action="revoke"]');
    const currentId = draft?.entry?.id || selectedEntryId || '';
    const isBlank = !currentId;
    const state = draft?.status || 'saved';
    if (status) {
      const nextStatusText = isBlank && (!draft || (state === 'saved' && !draft.dirty))
        ? '新纸页'
        : saveLabels[state] || saveLabels.saved;
      if (status.textContent !== nextStatusText) status.textContent = nextStatusText;
      if (status.dataset && status.dataset.state !== state) status.dataset.state = state;
    }
    if (saveBtn) {
      const nextRevision = String(draft?.entry?.revision ?? 0);
      const nextHidden = !(state === 'authorization' || state === 'error' || state === 'conflict');
      const nextSaveText = state === 'authorization' ? '确认共享' : '保存';
      if (saveBtn.dataset) {
        if (saveBtn.dataset.saveState !== state) saveBtn.dataset.saveState = state;
        if (currentId && saveBtn.dataset.id !== currentId) saveBtn.dataset.id = currentId;
        if (saveBtn.dataset.revision !== nextRevision) saveBtn.dataset.revision = nextRevision;
      }
      if (saveBtn.hidden !== nextHidden) saveBtn.hidden = nextHidden;
      if (saveBtn.textContent !== nextSaveText) saveBtn.textContent = nextSaveText;
    }
    if (deleteBtn) {
      if (deleteBtn.hidden !== isBlank) deleteBtn.hidden = isBlank;
      if (currentId && deleteBtn.dataset && deleteBtn.dataset.id !== currentId) deleteBtn.dataset.id = currentId;
    }
    if (revokeBtn) {
      const nextRevokeHidden = isBlank || !draft?.entry?.useForCompanionship;
      if (revokeBtn.hidden !== nextRevokeHidden) revokeBtn.hidden = nextRevokeHidden;
    }
  }

  function updateSheetMetrics(record, { dirtyField = '' } = {}) {
    updateSaveStatus(record);
    const panel = $('#today-panel');
    if (!panel || !record?.entry) return;
    const bannerSlot = panel.querySelector?.('[data-editor-banner-slot]');
    if (bannerSlot) {
      const nextBanner = renderEditorBannerHtml(record);
      if (bannerSlot.innerHTML !== nextBanner) bannerSlot.innerHTML = nextBanner;
    }
    const count = String(record.entry.content || '').length;
    const wordNode = panel.querySelector?.('[data-word-count]');
    if (wordNode) {
      const countText = `${count} / ${MAX_ENTRY_CONTENT_LENGTH} 字`;
      if (wordNode.textContent !== countText) wordNode.textContent = countText;
      wordNode.closest?.('.today-word-count-row')?.classList?.toggle('is-over', count > MAX_ENTRY_CONTENT_LENGTH);
    }
    if (record.entry.useForCompanionship && record.entry.allowedPersonIds?.length) {
      const previewNode = panel.querySelector?.('[data-partner-preview-text]');
      if (previewNode) {
        const nextPreview = currentPreviewText(record.entry);
        if (previewNode.textContent !== nextPreview) previewNode.textContent = nextPreview;
        if (dirtyField) requestPreviewSync(record.entry);
      }
    }
  }

  function renderListInPlace() {
    const panel = $('#today-panel');
    const listNode = panel?.querySelector?.('.today-notes-list');
    const countNode = panel?.querySelector?.('.today-spine-count');
    if (!listNode) return render();
    const filtered = filterEntries();
    listNode.innerHTML = renderNotesList(filtered);
    if (countNode) countNode.textContent = `${filtered.length} 篇`;
    return undefined;
  }

  function syncEntryInListInPlace(saved, { isNew = false } = {}) {
    if (!saved?.id || isNew || sort !== 'updated-desc') {
      return renderListInPlace();
    }
    const panel = $('#today-panel');
    const listNode = panel?.querySelector?.('.today-notes-list');
    if (!listNode || !listNode.children) return renderListInPlace();
    const children = [...listNode.children];
    const rowIdx = children.findIndex(node => node?.dataset?.id === saved.id);
    if (rowIdx === -1) return renderListInPlace();

    const row = children[rowIdx];
    const todayStr = localToday();
    const summary = entryListSummary(saved, todayStr);
    const titleEl = row.querySelector?.('.today-entry-title');
    const timeEl = row.querySelector?.('.today-entry-time');
    const snipEl = row.querySelector?.('.today-entry-snippet');
    if (!titleEl || !timeEl) return renderListInPlace();
    if (titleEl.textContent !== summary.rawTitle) titleEl.textContent = summary.rawTitle;
    if (timeEl.textContent !== summary.rowTime) timeEl.textContent = summary.rowTime;
    if (snipEl) {
      if (snipEl.textContent !== summary.snippet) snipEl.textContent = summary.snippet;
      const nextHidden = !summary.snippet;
      if (snipEl.hidden !== nextHidden) snipEl.hidden = nextHidden;
    }
    const nextRevision = String(saved.revision);
    if (row.dataset && row.dataset.revision !== nextRevision) row.dataset.revision = nextRevision;

    const prevEntry = children.slice(0, rowIdx).reverse().find(node => node?.dataset?.id);
    const prevRecord = prevEntry ? data.entries.find(item => item.id === prevEntry.dataset.id) : null;
    if (!prevRecord || Boolean(prevRecord.pinned) !== Boolean(saved.pinned)) {
      return undefined;
    }
    if (typeof listNode.insertBefore !== 'function') return renderListInPlace();

    const isCompletedView = selectedView === 'completed' || (selectedView === 'todo' && taskFilter === 'completed');
    const targetGroup = isCompletedView ? '已完成记录' : recencyBucketLabel(saved, todayStr);

    let currentHeadingIdx = -1;
    for (let i = rowIdx - 1; i >= 0; i -= 1) {
      if (children[i]?.classList?.contains?.('today-timeline-heading')) {
        currentHeadingIdx = i;
        break;
      }
    }
    const currentHeading = currentHeadingIdx >= 0 ? children[currentHeadingIdx] : null;
    if (!currentHeading || typeof currentHeading.textContent !== 'string') return renderListInPlace();

    if (currentHeading.textContent !== targetGroup) {
      let groupRowCount = 0;
      for (let i = currentHeadingIdx + 1; i < children.length; i += 1) {
        const node = children[i];
        if (node?.classList?.contains?.('today-timeline-heading')) break;
        if (node?.dataset?.id) groupRowCount += 1;
      }
      if (groupRowCount <= 1) return renderListInPlace();
    }

    const targetHeadingIdx = children.findIndex(
      node => node?.classList?.contains?.('today-timeline-heading') && node.textContent === targetGroup,
    );
    const targetHeading = targetHeadingIdx >= 0 ? children[targetHeadingIdx] : null;
    if (!targetHeading || !('nextSibling' in targetHeading)) return renderListInPlace();

    const refNode = targetHeading.nextSibling || null;
    if (refNode !== row && targetHeading.nextElementSibling !== row) {
      listNode.insertBefore(row, refNode);
    }
    return undefined;
  }

  function recordEditorInput(event) {
    const field = event.target;
    if (composing || event.isComposing) {
      if (field?.name === 'task-search') search = field.value;
      return;
    }
    if (field?.name === 'task-search') {
      search = field.value;
      resetListScroll = true;
      renderListInPlace();
      return;
    }
    if (field?.name === 'task-sort') {
      sort = field.value;
      resetListScroll = true;
      render();
      return;
    }
    if (!renderedEditor) return;

    if (field?.name === 'entry-check-item') {
      const checkId = field.dataset?.checkId;
      if (!checkId) return;
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const list = Array.isArray(current.checklist) ? [...current.checklist] : [];
      const nextList = list.map(item => (item.id === checkId ? { ...item, text: field.value } : item));
      editingInput = true;
      pendingDirtyField = 'checklist';
      try {
        drafts.update(renderedEditor.key, renderedEditor.entry, { checklist: nextList });
      } finally {
        pendingDirtyField = '';
        editingInput = false;
      }
      return;
    }

    const isKnown = Boolean(editorFields[field?.name])
      || ['entry-content-seg', 'entry-persons', 'entry-weekday', 'entry-tags', 'entry-share-scope'].includes(field?.name);
    if (!isKnown) return;

    const previous = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
    const changes = {};
    if (field.name === 'entry-content' || field.name === 'entry-content-seg') {
      const panel = $('#today-panel');
      const paperCol = panel?.querySelector?.('.today-paper-col');
      const children = paperCol?.children ? [...paperCol.children] : [];
      if (children.some(node => node?.classList?.contains?.('today-sheet-body') || node?.name === 'entry-content' || node?.name === 'entry-content-seg')) {
        let cumLines = 0;
        const allLines = [];
        const boundaryMap = new Map();
        for (const child of children) {
          const isBody = child?.name === 'entry-content' || child?.name === 'entry-content-seg' || child?.classList?.contains?.('today-sheet-body');
          if (isBody) {
            const segLines = contentLinesOf(child.value);
            const nextStart = String(cumLines);
            if (child.dataset && child.dataset.segStart !== nextStart) child.dataset.segStart = nextStart;
            allLines.push(...segLines);
            cumLines += segLines.length;
            const nextEnd = String(cumLines);
            if (child.dataset && child.dataset.segEnd !== nextEnd) child.dataset.segEnd = nextEnd;
          } else if (child?.dataset?.afterLine !== undefined) {
            const oldLine = Number(child.dataset.afterLine);
            boundaryMap.set(oldLine, cumLines);
            const nextAfter = String(cumLines);
            if (child.dataset.afterLine !== nextAfter) child.dataset.afterLine = nextAfter;
          }
        }
        changes.content = allLines.join('\n');
        const remapList = list => (Array.isArray(list) ? list.map(item => {
          if (!Number.isInteger(item.afterLine) || !boundaryMap.has(item.afterLine)) return item;
          const mapped = boundaryMap.get(item.afterLine);
          return mapped === item.afterLine ? item : { ...item, afterLine: mapped };
        }) : list);
        if (boundaryMap.size) {
          if (Array.isArray(previous.checklist) && previous.checklist.length) changes.checklist = remapList(previous.checklist);
          const prevTracks = effectiveTracksOf(previous);
          if (prevTracks.length) {
            const mappedTracks = remapList(prevTracks);
            changes.attachedTracks = mappedTracks;
            changes.attachedTrack = mappedTracks[0] || null;
          }
          if (Array.isArray(previous.attachedQuotes) && previous.attachedQuotes.length) {
            changes.attachedQuotes = remapList(previous.attachedQuotes);
          }
        }
      } else {
        changes.content = field.value;
      }
      rememberSheetCursor(field);
    } else if (field.name === 'entry-weekday') {
      const days = new Set(previous.repeatWeekdays || []);
      if (field.checked) days.add(Number(field.value));
      else days.delete(Number(field.value));
      changes.repeatWeekdays = [...days];
    } else if (field.name === 'entry-persons') {
      const ids = new Set(previous.allowedPersonIds || []);
      if (field.checked) ids.add(field.value);
      else ids.delete(field.value);
      changes.allowedPersonIds = [...ids];
      changes.useForCompanionship = ids.size > 0;
    } else if (field.name === 'entry-tags') {
      changes.tags = parseTagsString(field.value);
    } else if (field.name === 'entry-share-scope') {
      changes.shareScope = field.value === 'summary' || field.value === 'title_summary' ? 'summary' : 'note';
      changes.noteUsesTitle = changes.shareScope === 'summary';
    } else if (field.name === 'entry-note-uses-title') {
      changes.noteUsesTitle = Boolean(field.checked);
      changes.shareScope = changes.noteUsesTitle ? 'summary' : 'note';
    } else {
      changes[editorFields[field.name]] = field.type === 'checkbox' ? field.checked : field.value;
    }

    const requiresRerender = ['entry-repeat', 'entry-type', 'entry-companion', 'entry-persons', 'entry-share-scope', 'entry-note-uses-title'].includes(field.name);
    editingInput = !requiresRerender;
    pendingDirtyField = field.name;
    try {
      drafts.update(renderedEditor.key, renderedEditor.entry, changes);
    } finally {
      pendingDirtyField = '';
      editingInput = false;
    }
    if (requiresRerender) render();
    else if (!SUPPORTS_FIELD_SIZING && (field.name === 'entry-title' || field.name === 'entry-content' || field.name === 'entry-content-seg')) {
      scheduleTextareaResize(field, field.name === 'entry-title' ? 36 : 30);
    }
  }

  async function saveEntry(_editingId, payload) {
    const key = renderedEditor.key;
    drafts.update(key, renderedEditor.entry, payload);
    return drafts.save(key, { manual: true });
  }

  async function loadAuxiliaryForDate(dateStr) {
    try {
      const [musicRes, quotesRes, loopsRes] = await Promise.allSettled([
        apiClient.get(`/api/life/day-music?date=${encodeURIComponent(dateStr)}`),
        apiClient.get(`/api/life/day-quotes?date=${encodeURIComponent(dateStr)}`),
        apiClient.get('/api/life/open-loops'),
      ]);
      if (musicRes.status === 'fulfilled' && Array.isArray(musicRes.value?.tracks)) {
        dayMusic = musicRes.value.tracks;
      }
      if (quotesRes.status === 'fulfilled' && Array.isArray(quotesRes.value?.quotes)) {
        dayQuotes = quotesRes.value.quotes;
      }
      if (loopsRes.status === 'fulfilled' && Array.isArray(loopsRes.value?.openLoops)) {
        openLoops = loopsRes.value.openLoops;
      }
    } catch {
      // 辅助回望抽屉降级不影响主手帐编辑与列表
    }
  }

  async function load() {
    const revision = ++loadRevision;
    const writeRevision = mutationRevision;
    const date = selectedDate;
    loading = true;
    render();
    const results = await Promise.allSettled([apiClient.get('/api/life/entries')]);
    if (revision !== loadRevision || writeRevision !== mutationRevision || date !== selectedDate) return;
    const [entries] = results;
    if (entries.status === 'fulfilled' && entries.value?.ok !== false) {
      data.entries = entries.value.entries || [];
      delete loadErrors.entries;
      await loadAuxiliaryForDate(date);
    } else {
      loadErrors.entries = true;
    }
    loading = false;
    render();
  }

  function panelHasContent() {
    return Boolean(documentLike.querySelector('#today-panel')?.innerHTML?.trim());
  }

  function readForm(root) {
    const value = name => root?.querySelector?.(`[name="${name}"]`)?.value?.trim() || '';
    const checked = name => root?.querySelector?.(`[name="${name}"]`)?.checked === true;
    return { value, checked };
  }

  function filterEntries() {
    const list = filterTaskEntries(data.entries, {
      view: selectedView,
      filter: taskFilter,
      search,
      sort,
      today: localToday(),
      selectedDate,
    });
    if (!pendingDelete?.entry) return list;
    return list.filter(entry => entry.id !== pendingDelete.entry.id);
  }

  async function mutateEntry(id, action, body = {}) {
    const entry = data.entries.find(item => item.id === id);
    if (!entry || mutationLocks.has(id) || drafts.isSaving(id)) return;
    mutationLocks.add(id);
    render();
    try {
      const suffix = action === 'done' ? '/done' : action === 'revoke' ? '/revoke-companionship' : '';
      const result = await apiClient.request(`/api/life/entries/${encodeURIComponent(id)}${suffix}`, {
        method: action === 'delete' ? 'DELETE' : action === 'reschedule' ? 'PATCH' : 'POST',
        body: { ...body, expectedRevision: entry.revision },
      });
      if (result?.ok === false) throw new Error('保存未确认');
      mutationRevision++;
      loadRevision++;
      loading = false;
      if (action === 'delete') {
        data.entries = data.entries.filter(item => item.id !== id);
        drafts.discard(id);
        deleteConfirm = null;
        if (selectedEntryId === id) { selectedEntryId = null; detailOpen = false; }
      } else if (result?.entry) {
        data.entries = data.entries.map(item => item.id === id ? result.entry : item);
        drafts.acceptExternal(id, result.entry, { revoked: action === 'revoke' });
      }
      render();
    } catch (error) {
      if (error.status === 409) await drafts.conflict(id, entry);
      else showToast('error', '没有保存', '内容保持原样，请检查连接后重试。', { curated: true });
    } finally {
      mutationLocks.delete(id);
      drafts.schedule(id);
      render();
    }
  }

  async function commitPendingDelete({ keepalive = false } = {}) {
    const pending = pendingDelete;
    if (!pending) return;
    pendingDelete = null;
    clearTimeout(pending.timer);
    const { entry } = pending;
    try {
      await apiClient.request(`/api/life/entries/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        body: { expectedRevision: entry.revision },
        keepalive,
      });
      mutationRevision++;
      loadRevision++;
      data.entries = data.entries.filter(item => item.id !== entry.id);
      drafts.discard(entry.id);
    } catch {
      if (!data.entries.some(item => item.id === entry.id)) data.entries = [...data.entries, entry];
      showToast('error', '没能删除', '条目的删除未能确认，已恢复到列表。', { curated: true });
    }
    render();
  }

  async function startSoftDelete(entryId) {
    const idx = data.entries.findIndex(item => item.id === entryId);
    if (idx === -1) return;
    if (pendingDelete) await commitPendingDelete();
    const target = data.entries[idx];
    let revokedEntry = target;
    if (target.useForCompanionship) {
      try {
        const res = await apiClient.request(`/api/life/entries/${encodeURIComponent(target.id)}/revoke-companionship`, {
          method: 'POST',
          body: { expectedRevision: target.revision },
        });
        if (res?.entry) {
          revokedEntry = res.entry;
          data.entries = data.entries.map(item => item.id === target.id ? res.entry : item);
          drafts.acceptExternal(target.id, res.entry, { revoked: true });
        }
      } catch {
        showToast('error', '未能撤回分享', '请稍后再试删除，确保隐私权限准确。', { curated: true });
        return;
      }
    }
    if (selectedEntryId === target.id) {
      selectedEntryId = null;
      detailOpen = false;
    }
    popover = null;
    const timer = setTimeout(() => { void commitPendingDelete(); }, undoTimeoutMs);
    timer.unref?.();
    pendingDelete = { entry: revokedEntry, timer, index: idx };
    render();
  }

  function undoPendingDelete() {
    if (!pendingDelete) return;
    clearTimeout(pendingDelete.timer);
    const restored = pendingDelete.entry;
    pendingDelete = null;
    if (!data.entries.some(item => item.id === restored.id)) {
      data.entries = [restored, ...data.entries];
    }
    selectedEntryId = restored.id;
    detailOpen = true;
    render();
  }

  function toggleFragmentTrack(track) {
    if (!track?.title || !renderedEditor) return;
    const key = renderedEditor.key;
    const current = drafts.get(key)?.entry || renderedEditor.entry;
    const existingList = [...effectiveTracksOf(current)];
    const targetId = trackKey(track);
    const idx = existingList.findIndex(item => trackKey(item) === targetId);
    if (idx >= 0) {
      existingList.splice(idx, 1);
      drafts.update(key, renderedEditor.entry, {
        attachedTracks: existingList,
        attachedTrack: existingList[0] || null,
      });
    } else {
      const ins = resolveCursorInsertion(current);
      const list = [...ins.shiftList(existingList)];
      list.push({
        provider: track.provider || 'qq',
        songId: String(track.songId || ''),
        title: String(track.title),
        artist: String(track.artist || ''),
        album: String(track.album || ''),
        playedAt: track.playedAt || '',
        attachedAt: track.attachedAt || wallTime() || localToday(),
        ...(track.liked === true ? { liked: true } : {}),
        afterLine: ins.afterLine,
        order: ins.order,
      });
      sheetCursor = { zone: 'block', afterLine: ins.afterLine, order: ins.order };
      drafts.update(key, renderedEditor.entry, {
        content: ins.content,
        checklist: ins.shiftList(current.checklist || []),
        attachedQuotes: ins.shiftList(current.attachedQuotes || []),
        attachedTracks: list,
        attachedTrack: list[0] || null,
      });
    }
    render();
  }

  function toggleFragmentQuote(quote) {
    if (!quote?.text || !renderedEditor) return;
    const key = renderedEditor.key;
    const current = drafts.get(key)?.entry || renderedEditor.entry;
    const existingList = Array.isArray(current.attachedQuotes) ? [...current.attachedQuotes] : [];
    const qKey = quoteKey(quote);
    const idx = existingList.findIndex(item => quoteKey(item) === qKey);
    if (idx >= 0) {
      existingList.splice(idx, 1);
      drafts.update(key, renderedEditor.entry, { attachedQuotes: existingList });
    } else {
      const ins = resolveCursorInsertion(current);
      const list = [...ins.shiftList(existingList)];
      list.push({
        ...(quote.turnId ? { turnId: String(quote.turnId) } : {}),
        speaker: String(quote.speaker || '伙伴'),
        ...(quote.personId ? { personId: String(quote.personId) } : {}),
        time: String(quote.time || ''),
        text: String(quote.text),
        afterLine: ins.afterLine,
        order: ins.order,
      });
      sheetCursor = { zone: 'block', afterLine: ins.afterLine, order: ins.order };
      const shiftedTracks = ins.shiftList(effectiveTracksOf(current));
      drafts.update(key, renderedEditor.entry, {
        content: ins.content,
        checklist: ins.shiftList(current.checklist || []),
        attachedTracks: shiftedTracks,
        attachedTrack: shiftedTracks[0] || null,
        attachedQuotes: list,
      });
    }
    render();
  }

  function realTrackPool() {
    const seen = new Set();
    const pool = [];
    const playing = getNowPlaying?.();
    if (playing?.songId && playing?.title) {
      const k = trackKey(playing);
      seen.add(k);
      pool.push({ ...playing, playedAt: '此刻在播', _source: 'now' });
    }
    for (const track of dayMusic) {
      const k = trackKey(track);
      if (!track?.title || seen.has(k)) continue;
      seen.add(k);
      pool.push({ ...track, _source: 'history' });
    }
    return pool;
  }

  function composeTodayCollage() {
    if (!renderedEditor) return;
    const tracks = realTrackPool().slice(0, 3).map(track => ({
      provider: track.provider || 'qq',
      songId: String(track.songId || ''),
      title: String(track.title),
      artist: String(track.artist || ''),
      album: String(track.album || ''),
      playedAt: track.playedAt || '',
      attachedAt: wallTime() || localToday(),
      ...(track.liked === true ? { liked: true } : {}),
    }));
    const quotes = dayQuotes.slice(0, 2).map(q => ({
      ...(q.turnId ? { turnId: String(q.turnId) } : {}),
      speaker: String(q.speaker || '伙伴'),
      ...(q.personId ? { personId: String(q.personId) } : {}),
      time: String(q.time || ''),
      text: String(q.text),
    }));
    if (!tracks.length && !quotes.length) return;
    drafts.update(renderedEditor.key, renderedEditor.entry, {
      attachedTracks: tracks,
      attachedTrack: tracks[0] || null,
      attachedQuotes: quotes,
    });
    render();
  }

  async function requestPartnerAnnotation() {
    if (!renderedEditor || annotationBusy) return;
    const key = renderedEditor.key;
    const current = drafts.get(key)?.entry || renderedEditor.entry;
    const targetPersonId = current.allowedPersonIds?.[0] || people()[0]?.id || 'lunara';
    annotationError = '';

    // 必须有真实可落库内容才能生成批注；若当前有待保存修改，先存库再请求批注
    const draft = drafts.get(key);
    const tracks = effectiveTracksOf(current);
    const hasSomething = Boolean(
      String(current.title || '').trim()
      || String(current.content || '').trim()
      || tracks.length
      || current.attachedQuotes?.length
      || current.checklist?.some(c => String(c.text || '').trim()),
    );
    if (!hasSomething) {
      annotationError = '先写下几句内容，或贴入今天听过的歌与原话，再请伙伴留批注。';
      render();
      return;
    }

    let entryForAnn = current;
    if (!entryForAnn.id || draft?.dirty) {
      if (draft?.status === 'authorization') {
        const synced = await drafts.save(key, { manual: true });
        if (!synced) {
          annotationError = '请先确认共享设置或保存内容，再请求伙伴批注。';
          render();
          return;
        }
      } else {
        const savedOk = await drafts.save(key, { manual: true });
        if (!savedOk) {
          annotationError = '当前草稿尚未成功保存，无法生成批注。';
          render();
          return;
        }
      }
      entryForAnn = drafts.get(editorKey())?.entry || data.entries.find(e => e.id === selectedEntryId) || entryForAnn;
    }
    if (!entryForAnn?.id) return;

    annotationBusy = true;
    render();
    try {
      const res = await apiClient.post(`/api/life/entries/${encodeURIComponent(entryForAnn.id)}/annotations`, {
        personId: targetPersonId,
        expectedRevision: entryForAnn.revision,
      });
      if (res?.ok && res?.entry) {
        data.entries = data.entries.map(item => item.id === res.entry.id ? res.entry : item);
        drafts.acceptExternal(res.entry.id, res.entry);
        renderedEditor.entry = drafts.get(res.entry.id)?.entry || res.entry;
        annotationError = '';
      } else {
        annotationError = res?.error || '暂时无法生成伙伴批注，稍后再试。';
      }
    } catch (error) {
      if (error?.status === 503 || error?.body?.code === 'annotation_llm_unavailable') {
        annotationError = '当前未配置可用模型，暂时无法生成伙伴批注；手帐记录与同页共享不受影响。';
      } else if (error?.status === 409) {
        annotationError = '这页刚刚有更新，请刷新或重试点一次批注。';
      } else {
        annotationError = error?.body?.error || '暂时没有连上伙伴，手帐文字已保留。';
      }
    } finally {
      annotationBusy = false;
      render();
    }
  }

  async function adoptOpenLoop(noteId) {
    const loop = openLoops.find(item => item.noteId === noteId);
    if (!loop) return;
    const date = loop.dueDate || selectedDate;
    try {
      const created = await apiClient.request('/api/life/entries', {
        method: 'POST',
        body: {
          clientRequestId: entryRequestId(),
          type: 'todo',
          title: loop.text,
          content: `与 ${loop.partnerName || '伙伴'} 在对话里约定的事`,
          localDate: date,
          yearlyRepeat: false,
          useForCompanionship: false,
          noteUsesTitle: false,
          allowedPersonIds: [],
        },
      });
      if (created?.entry?.id) {
        data.entries = [...data.entries.filter(item => item.id !== created.entry.id), created.entry];
        selectedEntryId = created.entry.id;
        detailOpen = true;
      }
      await apiClient.post(`/api/life/open-loops/${encodeURIComponent(noteId)}/settle`, {});
      openLoops = openLoops.filter(item => item.noteId !== noteId);
      mutationRevision++;
      loadRevision++;
      render();
    } catch {
      showToast('error', '没能收进待办', '请检查连接后重试。', { curated: true });
    }
  }

  function setSelectedDate(nextDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(nextDate || '')) return;
    selectedDate = nextDate;
    resetListScroll = true;
    render();
    void loadAuxiliaryForDate(nextDate);
  }

  function entryListSummary(entry, todayStr = localToday()) {
    const tracks = effectiveTracksOf(entry);
    const rawTitle = String(entry.title || '').trim()
      || deriveTitleFromContent(entry.content, { checklist: entry.checklist, attachedTracks: tracks, attachedQuotes: entry.attachedQuotes })
      || '新纸页';
    const rawSnippet = String(entry.content || '').slice(0, 240).replace(/\s+/gu, ' ').trim().slice(0, 120);
    const snippet = (rawSnippet && rawSnippet !== rawTitle ? rawSnippet : '')
      || (tracks[0]?.title ? `配乐：${tracks[0].title}` : '')
      || String(entry.attachedQuotes?.[0]?.text || '').slice(0, 120)
      || (Array.isArray(entry.checklist) && entry.checklist.length ? `${entry.checklist.length} 项清单` : '');
    const rowTime = shortRowTime(entry, todayStr);
    return { rawTitle, snippet, rowTime, tracks };
  }

  function renderNotesList(entries = filterEntries()) {
    const overdue = entry => (entry.type === 'todo' || entry.type === 'event') && !entry.done
      && repeatFrequency(entry) === 'none' && entryOccurrence(entry, localToday())?.end < localToday();
    const isCompletedView = selectedView === 'completed' || (selectedView === 'todo' && taskFilter === 'completed');

    if (!entries.length) {
      return `
        <li class="today-empty-item">
          <p class="today-empty-title">${search ? '没有找到匹配内容' : isCompletedView ? '还没有已完成的待办' : '还没有记下任何纸页'}</p>
          ${search ? '<button type="button" class="today-quiet-btn" data-action="clear-filters">清除搜索</button>' : '<p class="today-empty-sub">点击右上角新建，或在右侧纸页直接落笔</p>'}
        </li>`;
    }

    const todayStr = localToday();
    let lastGroup = null;
    return entries.map(entry => {
      const group = isCompletedView ? '已完成记录' : recencyBucketLabel(entry, todayStr);
      const heading = group !== lastGroup ? `<li class="today-timeline-heading">${esc(group)}</li>` : '';
      lastGroup = group;

      const isSelected = entry.id === selectedEntryId;
      const busy = mutationLocks.has(entry.id);
      const isOverdue = overdue(entry);
      const annotations = Array.isArray(entry.annotations) ? entry.annotations : [];
      const { rawTitle, snippet, rowTime, tracks } = entryListSummary(entry, todayStr);
      const attachmentBadge = tracks.length
        ? ICONS.disc
        : (annotations.length || entry.useForCompanionship ? '<span class="today-partner-mini-dot"></span>' : '');

      return `${heading}
        <li class="today-entry type-${esc(entry.type)}${entry.done ? ' done' : ''}${isOverdue ? ' overdue' : ''}${isSelected ? ' is-selected' : ''}"
            data-id="${esc(entry.id)}" data-occurrence-date="${esc(entry.occurrenceDate || '')}" data-occurrence-key="${esc(entry.occurrenceKey || entry.id)}" data-revision="${entry.revision}">
          <div class="today-entry-row">
            ${isTask(entry) ? `
              <label class="today-entry-checkbox-wrap">
                <input type="checkbox" data-action="toggle-done" ${entry.done ? 'checked' : ''} ${busy ? 'disabled' : ''} aria-label="${entry.done ? '恢复' : '完成'} ${esc(entry.occurrenceDate || entry.localDate)}：${esc(rawTitle)}" />
                <span class="today-custom-check" aria-hidden="true"></span>
              </label>` : ''}
            <button type="button" class="today-entry-select" data-action="select-entry" data-id="${esc(entry.id)}" aria-pressed="${isSelected}">
              <div class="today-entry-main-col">
                <div class="today-entry-title-row">
                  <span class="today-entry-title">${esc(rawTitle)}</span>
                  ${isOverdue ? '<span class="today-overdue-badge">已逾期</span>' : ''}
                </div>
                <div class="today-entry-sub">
                  <span class="today-entry-time tabular">${esc(rowTime)}</span>
                  <span class="today-entry-snippet"${snippet ? '' : ' hidden'}>${esc(snippet)}</span>
                </div>
              </div>
              ${attachmentBadge ? `<span class="today-entry-badge" aria-hidden="true">${attachmentBadge}</span>` : ''}
            </button>
          </div>
        </li>`;
    }).join('');
  }

  function renderCheckItemsHtml(items, afterLine) {
    if (!items.length) return '';
    return `
      <div class="today-checklist" data-after-line="${afterLine}" aria-label="轻待办清单">
        ${items.map(({ item }) => `
          <div class="today-check-row${item.done ? ' is-done' : ''}" data-check-id="${esc(item.id)}">
            <button type="button" class="today-check-circle" data-action="toggle-check" data-check-id="${esc(item.id)}" aria-label="${item.done ? '取消完成' : '标记完成'}">
              ${item.done ? ICONS.check : ''}
            </button>
            <input type="text" class="today-check-input" name="entry-check-item" data-check-id="${esc(item.id)}" value="${esc(item.text || '')}" placeholder="待办事项" aria-label="待办内容" />
            <button type="button" class="today-check-del" data-action="remove-check" data-check-id="${esc(item.id)}" aria-label="移除待办">${ICONS.close}</button>
          </div>`).join('')}
      </div>`;
  }

  function renderFragmentRunHtml(fragBlocks, afterLine) {
    if (!fragBlocks.length) return '';
    const runs = [];
    for (const block of fragBlocks) {
      const last = runs[runs.length - 1];
      if (block.kind === 'track' && last?.kind === 'tracks') last.items.push(block);
      else if (block.kind === 'track') runs.push({ kind: 'tracks', items: [block] });
      else runs.push({ kind: 'quote', block });
    }
    return `
      <div class="today-fragments-b" data-after-line="${afterLine}" aria-label="听歌票根与原话便签">
        ${runs.map(run => (run.kind === 'tracks' ? `
          <div class="today-stub-grid">
            ${run.items.map(({ item: track, idx }) => `
              <div class="today-vinyl-stub" data-track-idx="${idx}">
                <div class="today-vinyl-art">${ICONS.disc}</div>
                <div class="today-vinyl-meta">
                  <div class="today-vinyl-title">${esc(track.title)}</div>
                  <div class="today-vinyl-artist">${esc(track.artist || '未知歌手')}</div>
                </div>
                <div class="today-vinyl-perf">
                  <span>${esc(track.playedAt || track.attachedAt || '')}</span>
                  ${track.liked ? `<span class="today-vinyl-heart">${ICONS.heart}</span>` : ''}
                  <button type="button" class="today-frag-remove" data-action="remove-track" data-track-idx="${idx}" aria-label="摘下票根">${ICONS.close}</button>
                </div>
              </div>`).join('')}
          </div>` : `
          <div class="today-verbatim-slip" data-quote-idx="${run.block.idx}">
            <div class="today-slip-head">
              <span class="today-slip-who"><span class="today-partner-mini-dot"></span><span>${esc(run.block.item.speaker || '伙伴')}${run.block.item.time ? ` · ${esc(run.block.item.time)}` : ''} 原话</span></span>
              <button type="button" class="today-frag-remove" data-action="remove-quote" data-quote-idx="${run.block.idx}" aria-label="摘下原话">${ICONS.close}</button>
            </div>
            <div class="today-slip-text">${esc(run.block.item.text)}</div>
          </div>`)).join('')}
      </div>`;
  }

  function renderBoundaryBlocksHtml(blocks, afterLine) {
    const chunks = [];
    for (const block of blocks) {
      const prev = chunks[chunks.length - 1];
      const groupKind = block.kind === 'check' ? 'check' : 'frag';
      if (prev?.groupKind === groupKind) prev.items.push(block);
      else chunks.push({ groupKind, items: [block] });
    }
    return chunks.map(chunk => (chunk.groupKind === 'check'
      ? renderCheckItemsHtml(chunk.items, afterLine)
      : renderFragmentRunHtml(chunk.items, afterLine))).join('');
  }

  function renderPaperFlowHtml(entry) {
    const rawContent = String(entry.content || '');
    const lines = contentLinesOf(rawContent);
    const { byLine, bounds } = collectBlocksByBoundary(entry, lines.length);
    if (!bounds.length) {
      return `<textarea id="today-entry-content" name="entry-content" data-seg-index="0" data-seg-start="0" data-seg-end="${lines.length}" class="today-sheet-body is-tail" rows="1" placeholder="写下此刻的念头、雨声，或从右上角贴入今天听过的歌与对话…" aria-label="正文内容">${esc(rawContent)}</textarea>`;
    }
    const parts = [];
    for (let i = 0; i < bounds.length; i += 1) {
      const prev = i === 0 ? 0 : bounds[i - 1];
      const curr = bounds[i];
      if (curr > prev) {
        parts.push(`<textarea name="entry-content-seg" data-seg-index="${i}" data-seg-start="${prev}" data-seg-end="${curr}" class="today-sheet-body" rows="1" aria-label="正文段落">${esc(lines.slice(prev, curr).join('\n'))}</textarea>`);
      }
      parts.push(renderBoundaryBlocksHtml(byLine.get(curr) || [], curr));
    }
    const lastBound = bounds[bounds.length - 1];
    parts.push(`<textarea id="today-entry-content" name="entry-content" data-seg-index="${bounds.length}" data-seg-start="${lastBound}" data-seg-end="${lines.length}" class="today-sheet-body is-tail" rows="1" placeholder="继续写点什么…" aria-label="正文内容">${esc(lines.slice(lastBound).join('\n'))}</textarea>`);
    return parts.join('');
  }

  function renderMarginRailHtml(entry) {
    const annotations = Array.isArray(entry.annotations) ? entry.annotations : [];
    if (!annotations.length) return '<aside class="today-margin-rail" aria-hidden="true"></aside>';
    return `
      <aside class="today-margin-rail" aria-label="页边伙伴批注">
        ${annotations.map(ann => `
          <article class="today-margin-card" data-ann-id="${esc(ann.id)}">
            <div class="today-margin-head">
              <span class="today-margin-who"><span class="today-partner-mini-dot" style="--partner-color:${colorFor(ann.personId || 'lunara')}"></span><span>${esc(ann.personName || personName(ann.personId))}${ann.time ? ` · ${esc(ann.time)}` : ''}</span></span>
              <button type="button" class="today-frag-remove" data-action="remove-ann" data-ann-id="${esc(ann.id)}" aria-label="撤下批注">${ICONS.close}</button>
            </div>
            ${ann.anchor ? `<div class="today-margin-anchor">「${esc(ann.anchor)}」</div>` : ''}
            <div class="today-margin-body">${esc(ann.text)}</div>
            ${ann.reply ? `<div class="today-postscript-reply">你：${esc(ann.reply)}</div>` : ''}
            ${replyingAnnId === ann.id ? `
              <div class="today-reply-box">
                <input type="text" class="today-reply-input" name="ann-reply-input" data-ann-id="${esc(ann.id)}" value="${esc(ann.reply || '')}" placeholder="在页边回一句…" aria-label="回复页边批注" />
                <button type="button" class="today-pill-btn is-on" data-action="submit-ann-reply" data-ann-id="${esc(ann.id)}">留在这</button>
              </div>` : `
              <div class="today-margin-actions">
                <button type="button" class="today-inline-link" data-action="start-ann-reply" data-ann-id="${esc(ann.id)}">${ann.reply ? '修改回复' : '在页边回一句'}</button>
              </div>`}
          </article>`).join('')}
      </aside>`;
  }

  function renderFragmentsTrackRowsHtml(entry) {
    const attachedTrackKeys = new Set(effectiveTracksOf(entry).map(trackKey));
    const tracks = realTrackPool();
    return tracks.length ? tracks.map((t, idx) => {
      const on = attachedTrackKeys.has(trackKey(t));
      return `
        <div class="today-pop-row">
          <div class="today-pop-row-text">
            <div class="today-pop-row-main">${esc(t.title)}${t.artist ? ` · ${esc(t.artist)}` : ''}</div>
            <div class="today-pop-row-sub">${esc(t.playedAt || '')}${t.liked ? ' · 已喜欢' : ''}</div>
          </div>
          <button type="button" class="today-pill-btn${on ? ' is-on' : ''}" data-action="toggle-frag-track" data-frag-index="${idx}">${on ? '已贴入' : '贴入'}</button>
        </div>`;
    }).join('') : '<p class="today-empty-sub">今天还没有在播或听歌记录。</p>';
  }

  function renderInspectorDrawerHtml(entry) {
    if (inspectorTab === 'fragments') {
      const attachedQuoteKeys = new Set((entry.attachedQuotes || []).map(quoteKey));
      const tracks = realTrackPool();
      return `
        <aside class="today-inspector-drawer" role="region" aria-label="今日真实碎片">
          <div class="today-pop-head">
            <span class="today-pop-title">贴入今日真实记录</span>
            <button type="button" class="today-frag-remove" data-action="close-inspector" aria-label="关闭抽屉">${ICONS.close}</button>
          </div>
          <p class="today-pop-desc">只取已发生的听歌与对话，原话一字不改，不切歌。</p>
          <div class="today-pop-sec-label" data-frag-track-heading>今日听过的歌（${tracks.length}）</div>
          <div class="today-pop-list" data-frag-track-list>
            ${renderFragmentsTrackRowsHtml(entry)}
          </div>
          <div class="today-pop-sec-label">今日聊天原话（${dayQuotes.length}）</div>
          <div class="today-pop-list">
            ${dayQuotes.length ? dayQuotes.map((q, idx) => {
              const on = attachedQuoteKeys.has(quoteKey(q));
              return `
                <div class="today-pop-row">
                  <div class="today-pop-row-text">
                    <div class="today-pop-row-quote">「${esc(q.text)}」</div>
                    <div class="today-pop-row-sub">${esc(q.speaker)}${q.time ? ` · ${esc(q.time)}` : ''}</div>
                  </div>
                  <button type="button" class="today-pill-btn${on ? ' is-on' : ''}" data-action="toggle-frag-quote" data-frag-index="${idx}">${on ? '已贴入' : '贴入'}</button>
                </div>`;
            }).join('') : '<p class="today-empty-sub">今天还没有可贴入的对话原话。</p>'}
          </div>
          ${openLoops.length ? `
            <div class="today-pop-sec-label">伙伴记着（${openLoops.length}）</div>
            <div class="today-pop-list">
              ${openLoops.map(loop => `
                <div class="today-pop-row">
                  <div class="today-pop-row-text">
                    <div class="today-pop-row-quote">${esc(loop.text)}</div>
                    <div class="today-pop-row-sub">${esc(loop.partnerName || '伙伴')}${loop.dueDate ? ` · ${esc(loop.dueDate)}` : ''}</div>
                  </div>
                  <button type="button" class="today-pill-btn" data-action="adopt-open-loop" data-note-id="${esc(loop.noteId)}">收进待办</button>
                </div>`).join('')}
            </div>` : ''}
        </aside>`;
    }

    if (inspectorTab === 'partner') {
      const list = people();
      const selected = new Set(entry.allowedPersonIds || []);
      const scope = normalizeShareScope(entry);
      const draft = drafts.get(editorKey());
      return `
        <aside class="today-inspector-drawer" role="region" aria-label="同页伙伴">
          <div class="today-pop-head">
            <span class="today-pop-title">同页伙伴</span>
            <button type="button" class="today-frag-remove" data-action="close-inspector" aria-label="关闭抽屉">${ICONS.close}</button>
          </div>
          <p class="today-pop-desc">${selected.size ? '已选好这一页的同页伙伴；隐私变更需手动确认一次。' : '默认仅自己可见。选一位伙伴即可一起写、一起留批注。'}</p>
          <div class="today-partner-picks">
            ${list.length ? list.map(person => {
              const on = selected.has(person.id);
              return `<button type="button" class="today-partner-chip${on ? ' is-on' : ''}" data-action="toggle-partner-chip" data-person-id="${esc(person.id)}"><span class="today-partner-mini-dot" style="--partner-color:${colorFor(person.id)}"></span><span>${esc(person.displayName || person.id)}</span></button>`;
            }).join('') : '<button type="button" class="today-partner-chip' + (selected.has('lunara') ? ' is-on' : '') + '" data-action="toggle-partner-chip" data-person-id="lunara"><span class="today-partner-mini-dot"></span><span>Lunara</span></button>'}
          </div>
          ${selected.size ? `
            <div class="today-pop-sec-label">伙伴可见范围</div>
            <div class="today-scope-row" role="radiogroup" aria-label="伙伴可见范围">
              <label class="today-scope-option"><input type="radio" name="entry-share-scope" value="note" ${scope === 'note' ? 'checked' : ''} /><span>只读选歌备注</span></label>
              <label class="today-scope-option"><input type="radio" name="entry-share-scope" value="summary" ${scope === 'summary' ? 'checked' : ''} /><span>可读标题与摘要</span></label>
            </div>
            <input type="text" class="today-companion-note-input" name="entry-note" value="${esc(entry.companionNote || '')}" placeholder="选歌备注（例如：想听安静一点的琴声）" aria-label="给伙伴的选歌备注" />
            <p class="today-pop-preview" data-partner-preview-text>${esc(currentPreviewText(entry))}</p>
          ` : ''}
          ${annotationError ? `<p class="today-pop-error" role="alert">${esc(annotationError)}</p>` : ''}
          <div class="today-pop-footer">
            ${draft?.status === 'authorization'
              ? '<button type="button" class="today-btn-primary" data-action="add-entry">确认同页共享</button>'
              : `<button type="button" class="today-pill-btn is-on" data-action="request-annotation" ${annotationBusy ? 'disabled' : ''}>${annotationBusy ? '伙伴阅读中…' : '请 Ta 留一句批注'}</button>`}
            ${typeof onTalkAboutEntry === 'function' ? '<button type="button" class="today-inline-link" data-action="talk-about-entry">带这篇去聊聊</button>' : ''}
            ${entry.id && entry.useForCompanionship ? `<button type="button" class="today-inline-link" data-action="revoke" data-id="${esc(entry.id)}">撤回同页</button>` : ''}
          </div>
        </aside>`;
    }

    return '';
  }

  function renderMoreMenuHtml(entry, { isEffectivelyEmpty = true } = {}) {
    if (popover !== 'more') return '';
    const isTaskEntry = entry.type === 'todo' || entry.type === 'event';
    const frequency = repeatFrequency(entry);
    const weekdays = new Set(entry.repeatWeekdays || []);
    return `
      <section class="today-popover is-menu" role="menu" aria-label="更多操作">
        <button type="button" class="today-menu-item" role="menuitem" data-action="toggle-pinned">
          <span>${entry.pinned ? '取消置顶' : '置顶这页'}</span>
          <span>${ICONS.pin}</span>
        </button>
        <div class="today-menu-label">此刻心情</div>
        <div class="today-mood-row" role="group" aria-label="此刻心情">
          ${MOOD_PRESETS.map(m => `<button type="button" class="${entry.mood === m ? 'is-on' : ''}" data-action="set-mood" data-mood="${m}">${m}</button>`).join('')}
          ${entry.mood ? '<button type="button" data-action="set-mood" data-mood="">清除</button>' : ''}
        </div>
        <details class="today-more-advanced" ${moreAdvancedOpen ? 'open' : ''}>
          <summary data-action="toggle-more-advanced">类型 · 日程与标签</summary>
          <div class="today-more-fields">
            <label><span>类型</span>
              <select name="entry-type">
                ${Object.entries(TYPE_OPTIONS).map(([val, label]) => `<option value="${val}" ${entry.type === val || (entry.type === 'event' && val === 'todo') ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>
            <label><span>日期</span><input type="date" name="entry-date" value="${esc(entry.localDate || selectedDate)}" /></label>
            ${isTaskEntry ? `
              <div class="today-more-row-2">
                <label><span>开始</span><input type="time" name="entry-start" value="${esc(entry.startTime || '')}" /></label>
                <label><span>结束</span><input type="time" name="entry-end" value="${esc(entry.endTime || '')}" /></label>
              </div>
              <label><span>结束日</span><input type="date" name="entry-end-date" value="${esc(entry.endDate || '')}" /></label>
              <label><span>重复</span>
                <select name="entry-repeat">
                  <option value="none" ${frequency === 'none' ? 'selected' : ''}>不重复</option>
                  <option value="daily" ${frequency === 'daily' ? 'selected' : ''}>每天</option>
                  <option value="weekly" ${frequency === 'weekly' ? 'selected' : ''}>每周</option>
                  <option value="yearly" ${frequency === 'yearly' ? 'selected' : ''}>每年</option>
                </select>
              </label>
              ${frequency === 'weekly' ? `
                <div class="today-repeat-weekdays">
                  ${WEEKDAYS.map(([label, num]) => `<label><input type="checkbox" name="entry-weekday" value="${num}" ${weekdays.has(num) ? 'checked' : ''} /><span>${label}</span></label>`).join('')}
                </div>` : ''}
            ` : ''}
            <label><span>标签</span><input type="text" name="entry-tags" value="${esc(formatTagsString(entry.tags))}" placeholder="雨夜, 读书" /></label>
            ${entry.id && isTaskEntry && !entry.done && frequency === 'none' ? '<button type="button" class="today-menu-item" data-action="move-tomorrow">推迟到明天</button>' : ''}
          </div>
        </details>
        ${entry.id ? `
          <button type="button" class="today-menu-item is-danger" role="menuitem" data-action="soft-delete" data-id="${esc(entry.id)}">
            <span>删掉这页</span>
            <span>${ICONS.trash}</span>
          </button>` : (!isEffectivelyEmpty ? `
          <button type="button" class="today-menu-item is-danger" role="menuitem" data-action="clear-draft">
            <span>清空这页草稿</span>
            <span>${ICONS.trash}</span>
          </button>` : '')}
      </section>`;
  }

  function renderEditor() {
    const key = editorKey();
    const existing = selectedEntryId ? data.entries.find(item => item.id === selectedEntryId) : null;
    if (selectedEntryId && !existing) selectedEntryId = null;

    const draft = drafts.get(key);
    const blankBase = {
      type: 'note',
      title: '',
      content: '',
      localDate: selectedDate,
      startTime: '',
      endTime: '',
      endDate: '',
      yearlyRepeat: false,
      repeatFrequency: 'none',
      repeatWeekdays: [],
      useForCompanionship: false,
      companionNote: '',
      noteUsesTitle: false,
      shareScope: 'note',
      allowedPersonIds: [],
      sceneTag: '',
      mood: '',
      tags: [],
      pinned: false,
      attachedTrack: null,
      attachedTracks: [],
      attachedQuotes: [],
      checklist: [],
      annotations: [],
      layoutVariant: 'blank',
      revision: 0,
    };
    const baseEntry = existing ? {
      ...blankBase,
      ...existing,
      attachedTracks: effectiveTracksOf(existing),
    } : blankBase;
    const entry = draft?.entry ? {
      ...blankBase,
      ...draft.entry,
      attachedTracks: effectiveTracksOf(draft.entry),
    } : baseEntry;
    renderedEditor = { key, entry: baseEntry };

    const status = draft?.status || 'saved';
    const isBlankNew = !entry.id;
    const statusText = isBlankNew && (!draft || (status === 'saved' && !draft.dirty))
      ? '新纸页'
      : (saveLabels[status] || saveLabels.saved);
    const showPrimaryBtn = status === 'authorization' || status === 'error' || status === 'conflict';
    const layoutVariant = LAYOUT_ORDER.includes(entry.layoutVariant) ? entry.layoutVariant : 'blank';
    const tracks = effectiveTracksOf(entry);
    const quotes = Array.isArray(entry.attachedQuotes) ? entry.attachedQuotes : [];
    const checklist = Array.isArray(entry.checklist) ? entry.checklist : [];
    const meta = parseDateMeta(entry.localDate || selectedDate);
    const partnerNames = (entry.allowedPersonIds || []).map(personName).filter(Boolean);
    const headerMetaParts = [`${meta.year}年${meta.month}月${meta.day}日 <time data-now-time>${wallTime()}</time>`];
    if (entry.useForCompanionship && partnerNames.length) headerMetaParts.push(`与 ${partnerNames.join('、')} 同页`);
    if (entry.mood) headerMetaParts.push(esc(entry.mood));

    const isEffectivelyEmpty = !String(entry.title || '').trim()
      && !String(entry.content || '').trim()
      && !tracks.length
      && !quotes.length
      && !checklist.length;
    const availablePool = realTrackPool();
    const canComposeCollage = isEffectivelyEmpty && (availablePool.length > 0 || dayQuotes.length > 0);
    const collageLabel = availablePool.length && dayQuotes.length
      ? `用今日 ${Math.min(3, availablePool.length)} 首歌与聊天原话拼一页`
      : availablePool.length
        ? `用今日 ${Math.min(3, availablePool.length)} 首歌拼一页`
        : '用今日聊天原话拼一页';

    const bannerHtml = renderEditorBannerHtml(draft);
    const hasFrags = tracks.length + quotes.length > 0;
    const hasPartners = Boolean(entry.useForCompanionship && entry.allowedPersonIds?.length);
    const needsBannerSpace = String(entry.content || '').length > 4500;

    return `
      <div class="today-sheet-toolbar">
        <div class="today-sheet-toolbar-left">
          <button type="button" class="today-back-to-list" data-action="close-detail">${ICONS.back}<span>手帐</span></button>
          <span class="today-save-indicator" data-state="${status}">${statusText}</span>
          <button type="button" class="today-btn-primary" data-action="add-entry" data-id="${esc(entry.id || '')}" data-revision="${entry.revision ?? 0}" data-save-state="${status}" ${showPrimaryBtn ? '' : 'hidden'}>${status === 'authorization' ? '确认共享' : '保存'}</button>
        </div>
        <div class="today-toolbar-actions">
          <button type="button" class="today-tool-btn" data-action="add-checklist-item" title="插入待办清单">
            ${ICONS.checklist}<span class="today-tool-label">清单</span>
          </button>
          <button type="button" class="today-tool-btn${inspectorTab === 'fragments' ? ' is-active' : (hasFrags ? ' is-armed' : '')}" data-action="toggle-inspector" data-inspector="fragments" title="贴入今日听歌与聊天原话">
            ${ICONS.clip}<span class="today-tool-label">贴碎片</span>
          </button>
          <button type="button" class="today-tool-btn${inspectorTab === 'partner' ? ' is-active' : (hasPartners ? ' is-armed' : '')}" data-action="toggle-inspector" data-inspector="partner" title="同页伙伴与批注">
            ${ICONS.partner}<span class="today-tool-label">${hasPartners ? esc(partnerNames[0]) : '同页伙伴'}</span>
          </button>
          <button type="button" class="today-tool-btn${layoutVariant !== 'blank' ? ' is-armed' : ''}" data-action="cycle-layout" title="切换纸面版式（不改文字）">
            ${ICONS.dice}<span class="today-tool-label">版式 · ${LAYOUT_LABELS[layoutVariant]}</span>
          </button>
          <button type="button" class="today-tool-btn${popover === 'more' ? ' is-active' : ''}" data-action="toggle-popover" data-popover="more" aria-label="更多操作">
            ${ICONS.more}
          </button>
        </div>
        ${renderMoreMenuHtml(entry, { isEffectivelyEmpty })}
      </div>

      <div data-editor-banner-slot>${bannerHtml}</div>
      ${needsBannerSpace ? `<div class="today-word-count-row"><span data-word-count>${String(entry.content || '').length} / ${MAX_ENTRY_CONTENT_LENGTH} 字</span></div>` : ''}

      <div class="today-sheet-body-wrap">
        <div class="today-sheet-scroll variant-${layoutVariant}" data-action="focus-body-stage">
          <p class="today-sheet-meta-date">${headerMetaParts.join(' · ')}</p>
          ${layoutVariant === 'playbill' ? `
            <div class="today-playbill-masthead">
              <span class="today-playbill-day">${esc(meta.monthDay)} · ${esc(meta.weekDayName)}</span>
              <span class="today-playbill-sub">电台同页特刊 · 已排 ${tracks.length} 首歌，${quotes.length} 段原话</span>
            </div>` : ''}
          <div class="today-spread variant-${layoutVariant}${(entry.annotations || []).length ? ' has-annotations' : ''}">
            <div class="today-paper-col">
              <textarea name="entry-title" class="today-sheet-firstline" rows="1" placeholder="标题（可留空）" aria-label="首行标题">${esc(entry.title || '')}</textarea>
              ${renderPaperFlowHtml(entry)}
              ${canComposeCollage ? `
                <button type="button" class="today-compose-today-cta" data-action="compose-today-page">
                  ${ICONS.dice}<span>${esc(collageLabel)}</span>
                </button>` : ''}
            </div>
            ${renderMarginRailHtml(entry)}
          </div>
        </div>
        ${renderInspectorDrawerHtml(entry)}
      </div>`;
  }

  function render() {
    const panel = $('#today-panel');
    if (!panel) return;
    if (loadErrors.entries && !panelHasContent()) {
      panel.innerHTML = `<section class="today-load-fail"><p>条目加载失败</p><button type="button" class="today-btn-primary" data-action="retry-load">重试</button></section>`;
      return;
    }

    const active = documentLike?.activeElement;
    const searchHadFocus = active?.name === 'task-search';
    const prevListScroll = resetListScroll ? 0 : (panel.querySelector?.('.today-notes-list')?.scrollTop || 0);
    resetListScroll = false;

    const entries = filterEntries();
    panel.innerHTML = `
      <div class="today-workspace-body${detailOpen ? ' is-detail-open' : ''}">
        <aside class="today-notes-sidebar" aria-label="手帐时间列表">
          <div class="today-sidebar-head">
            <label class="today-search-box" aria-label="搜索手帐">
              ${ICONS.search}
              <input type="search" name="task-search" value="${esc(search)}" placeholder="搜索手帐…" />
            </label>
            <button type="button" class="today-new-btn" data-action="new-entry" title="新建手帐 (Cmd/Ctrl+N)" aria-label="新建手帐">${ICONS.compose}</button>
          </div>
          ${loadErrors.entries ? `<div class="today-load-error"><span>条目加载失败</span><button type="button" class="today-quiet-btn" data-action="retry-load">重试</button></div>` : ''}
          <ul class="today-notes-list">${renderNotesList(entries)}</ul>
          <span class="today-spine-count tabular" hidden>${entries.length} 篇</span>
        </aside>

        <div class="today-split" role="separator" aria-orientation="vertical" tabindex="0" aria-label="调整列表与编辑器的宽度" title="拖动调整宽度，双击恢复默认"></div>

        <section class="today-notes-editor-pane" aria-label="手帐纸页">
          ${renderEditor()}
        </section>
      </div>

      <div class="today-undo-toast" role="status" aria-live="polite" ${pendingDelete ? '' : 'hidden'}>
        <span>${pendingDelete ? `已删掉「${esc(pendingDelete.entry.title || '这页手帐')}」` : ''}</span>
        <button type="button" data-action="undo-delete">撤销（5秒）</button>
      </div>`;

    const nextList = panel.querySelector?.('.today-notes-list');
    if (nextList) nextList.scrollTop = prevListScroll;
    if (searchHadFocus) {
      const searchInput = panel.querySelector?.('[name="task-search"]');
      searchInput?.focus?.({ preventScroll: true });
      const len = String(searchInput?.value || '').length;
      searchInput?.setSelectionRange?.(len, len);
    }
    autoResizeTextarea(panel.querySelector?.('[name="entry-title"]'), 36);
    for (const seg of panel.querySelectorAll?.('.today-sheet-body') || []) {
      autoResizeTextarea(seg, 30);
    }
    if (!panel.querySelectorAll?.('.today-sheet-body')?.length) {
      autoResizeTextarea(panel.querySelector?.('[name="entry-content"]'), 30);
    }
    const current = renderedEditor ? drafts.get(renderedEditor.key)?.entry || renderedEditor.entry : null;
    if (current?.useForCompanionship && current?.allowedPersonIds?.length) requestPreviewSync(current);
  }

  function addChecklistItem(afterCheckId = null) {
    if (!renderedEditor) return;
    const key = renderedEditor.key;
    const current = drafts.get(key)?.entry || renderedEditor.entry;
    const ins = resolveCursorInsertion(current, { afterCheckId });
    const items = [...ins.shiftList(Array.isArray(current.checklist) ? current.checklist : [])];
    const newId = `chk:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
    const insertAt = afterCheckId ? items.findIndex(item => item.id === afterCheckId) + 1 : items.length;
    const newItem = { id: newId, text: '', done: false, afterLine: ins.afterLine, order: ins.order };
    items.splice(insertAt > 0 ? insertAt : items.length, 0, newItem);
    const shiftedTracks = ins.shiftList(effectiveTracksOf(current));
    drafts.update(key, renderedEditor.entry, {
      content: ins.content,
      checklist: items,
      attachedTracks: shiftedTracks,
      attachedTrack: shiftedTracks[0] || null,
      attachedQuotes: ins.shiftList(current.attachedQuotes || []),
    });
    sheetCursor = { zone: 'check', checkId: newId };
    render();
    const input = $('#today-panel')?.querySelector?.(`.today-check-input[data-check-id="${newId}"]`);
    input?.focus?.();
  }

  function handleShortcutKeydown(event) {
    if (event.isComposing || composing) return true;
    const mod = event.metaKey || event.ctrlKey;
    const key = String(event.key || '').toLowerCase();

    if (event.target?.name === 'entry-title' && event.key === 'Enter' && !event.shiftKey && !mod) {
      event.preventDefault?.();
      const body = $('#today-panel')?.querySelector?.('[name="entry-content"]');
      body?.focus?.();
      body?.setSelectionRange?.(0, 0);
      return false;
    }

    if (event.target?.name === 'entry-content' && event.key === 'Backspace' && !mod) {
      if (event.target.selectionStart === 0 && event.target.selectionEnd === 0) {
        event.preventDefault?.();
        const titleInput = $('#today-panel')?.querySelector?.('[name="entry-title"]');
        titleInput?.focus?.();
        const len = String(titleInput?.value || '').length;
        titleInput?.setSelectionRange?.(len, len);
        return false;
      }
    }

    if (event.target?.name === 'entry-check-item' && event.key === 'Enter' && !event.shiftKey && !mod) {
      event.preventDefault?.();
      const checkId = event.target.dataset?.checkId;
      if (!String(event.target.value || '').trim() && checkId && renderedEditor) {
        const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
        const targetItem = (current.checklist || []).find(item => item.id === checkId);
        const lineIdx = Number.isInteger(targetItem?.afterLine) ? targetItem.afterLine : contentLinesOf(current.content).length;
        const nextChecks = (current.checklist || []).filter(item => item.id !== checkId);
        drafts.update(renderedEditor.key, renderedEditor.entry, { checklist: nextChecks });
        render();
        const panel = $('#today-panel');
        const nextSeg = panel?.querySelector?.(`.today-sheet-body[data-seg-start="${lineIdx}"]`) || panel?.querySelector?.('[name="entry-content"]');
        nextSeg?.focus?.();
        nextSeg?.setSelectionRange?.(0, 0);
        return false;
      }
      addChecklistItem(checkId);
      return false;
    }

    if (event.target?.name === 'ann-reply-input' && event.key === 'Enter' && !event.shiftKey && !mod) {
      event.preventDefault?.();
      const annId = event.target.dataset?.annId;
      if (annId && renderedEditor) {
        const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
        const anns = (current.annotations || []).map(a => (a.id === annId
          ? { ...a, reply: String(event.target.value || '').trim(), repliedAt: Date.now() }
          : a));
        replyingAnnId = null;
        drafts.update(renderedEditor.key, renderedEditor.entry, { annotations: anns });
        render();
      }
      return false;
    }

    if (mod && key === 's') {
      event.preventDefault?.();
      if (renderedEditor) {
        const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
        void saveEntry(current.id || null, { title: current.title, content: current.content });
      }
      return false;
    }
    if (mod && key === 'n') {
      event.preventDefault?.();
      openNewDraft();
      return false;
    }
    if (event.key === '/' && !mod && !event.altKey) {
      const tag = String(event.target?.tagName || '').toUpperCase();
      if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) {
        event.preventDefault?.();
        $('#today-panel')?.querySelector?.('[name="task-search"]')?.focus?.();
        return false;
      }
    }
    if (event.key === 'Escape') {
      if (popover) { popover = null; render(); return false; }
      if (inspectorTab) { inspectorTab = null; render(); return false; }
      if (replyingAnnId) { replyingAnnId = null; render(); return false; }
      if (deleteConfirm) { deleteConfirm = null; render(); return false; }
    }
    return true;
  }

  function handleEvent(event) {
    if (event.type === 'keydown') return handleShortcutKeydown(event);

    const target = event.target.closest?.('[data-action]');
    if (!target) {
      if (event.type === 'click' && popover && !event.target.closest?.('.today-popover')) {
        popover = null;
        render();
      }
      return;
    }
    const action = target.dataset.action;

    if (event.type === 'change') {
      if (action === 'change-date') return setSelectedDate(target.value);
      if (action === 'toggle-inline-check' && renderedEditor) {
        const line = Number(target.dataset.line);
        const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
        drafts.update(renderedEditor.key, renderedEditor.entry, {
          content: toggleChecklistLine(current.content || '', line),
        });
        render();
        return undefined;
      }
      if (action !== 'toggle-done') return;
    } else if (event.type === 'click' && (action === 'toggle-done' || action === 'toggle-inline-check')) {
      return;
    }

    if (action === 'retry-load') { void load(); return; }
    if (action === 'clear-filters') { search = ''; taskFilter = 'open'; selectedView = 'all'; sort = 'updated-desc'; resetListScroll = true; render(); return; }
    if (action === 'switch-view') { selectedView = target.dataset.view || 'all'; resetListScroll = true; render(); return; }
    if (action === 'task-filter') { taskFilter = target.dataset.filter || 'open'; resetListScroll = true; render(); return; }
    if (action === 'close-detail' || action === 'back-to-list') {
      if (renderedEditor?.key) void drafts.flush(renderedEditor.key);
      detailOpen = false;
      render();
      return;
    }
    if (action === 'toggle-more-advanced') { moreAdvancedOpen = !moreAdvancedOpen; return; }
    if (action === 'focus-body-stage') {
      if (event.target === target) {
        $('#today-panel')?.querySelector?.('[name="entry-content"]')?.focus?.({ preventScroll: true });
      }
      return;
    }
    if (action === 'toggle-popover') {
      const next = target.dataset.popover || 'more';
      popover = popover === next ? null : next;
      render();
      return;
    }
    if (action === 'toggle-inspector') {
      const next = target.dataset.inspector;
      popover = null;
      annotationError = '';
      inspectorTab = inspectorTab === next ? null : next;
      render();
      if (inspectorTab === 'fragments') void loadAuxiliaryForDate(selectedDate).then(() => { if (inspectorTab === 'fragments') render(); });
      return;
    }
    if (action === 'close-inspector') { inspectorTab = null; annotationError = ''; render(); return; }

    if (action === 'add-checklist-item') { popover = null; addChecklistItem(); return; }
    if (action === 'toggle-check' && renderedEditor) {
      const checkId = target.dataset.checkId;
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const list = (current.checklist || []).map(item => (item.id === checkId ? { ...item, done: !item.done } : item));
      drafts.update(renderedEditor.key, renderedEditor.entry, { checklist: list });
      render();
      return;
    }
    if (action === 'remove-check' && renderedEditor) {
      const checkId = target.dataset.checkId;
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const list = (current.checklist || []).filter(item => item.id !== checkId);
      drafts.update(renderedEditor.key, renderedEditor.entry, { checklist: list });
      render();
      return;
    }

    if (action === 'toggle-frag-track') {
      const track = realTrackPool()[Number(target.dataset.fragIndex)];
      if (track) toggleFragmentTrack(track);
      return;
    }
    if (action === 'remove-track' && renderedEditor) {
      const idx = Number(target.dataset.trackIdx);
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const list = [...effectiveTracksOf(current)];
      list.splice(idx, 1);
      drafts.update(renderedEditor.key, renderedEditor.entry, { attachedTracks: list, attachedTrack: list[0] || null });
      render();
      return;
    }
    if (action === 'toggle-frag-quote') {
      const quote = dayQuotes[Number(target.dataset.fragIndex)];
      if (quote) toggleFragmentQuote(quote);
      return;
    }
    if (action === 'remove-quote' && renderedEditor) {
      const idx = Number(target.dataset.quoteIdx);
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const list = [...(current.attachedQuotes || [])];
      list.splice(idx, 1);
      drafts.update(renderedEditor.key, renderedEditor.entry, { attachedQuotes: list });
      render();
      return;
    }
    if (action === 'compose-today-page') { composeTodayCollage(); return; }
    if (action === 'adopt-open-loop' && target.dataset.noteId) { void adoptOpenLoop(target.dataset.noteId); return; }

    if (action === 'cycle-layout' && renderedEditor) {
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const idx = LAYOUT_ORDER.indexOf(current.layoutVariant || 'blank');
      const next = LAYOUT_ORDER[(idx + 1) % LAYOUT_ORDER.length];
      drafts.update(renderedEditor.key, renderedEditor.entry, { layoutVariant: next });
      render();
      return;
    }

    if (action === 'toggle-partner-chip' && renderedEditor) {
      const pid = target.dataset.personId;
      if (!pid) return;
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const ids = new Set(current.allowedPersonIds || []);
      if (ids.has(pid)) ids.delete(pid);
      else ids.add(pid);
      const nextIds = [...ids];
      drafts.update(renderedEditor.key, renderedEditor.entry, {
        allowedPersonIds: nextIds,
        useForCompanionship: nextIds.length > 0,
      });
      render();
      return;
    }
    if (action === 'request-annotation') { void requestPartnerAnnotation(); return; }
    if (action === 'start-ann-reply') {
      const annId = target.dataset.annId;
      replyingAnnId = replyingAnnId === annId ? null : annId;
      render();
      $('#today-panel')?.querySelector?.('.today-reply-input')?.focus?.();
      return;
    }
    if (action === 'submit-ann-reply' && renderedEditor) {
      const annId = target.dataset.annId;
      const input = $('#today-panel')?.querySelector?.(`.today-reply-input[data-ann-id="${annId}"]`);
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const anns = (current.annotations || []).map(a => (a.id === annId
        ? { ...a, reply: String(input?.value || '').trim(), repliedAt: Date.now() }
        : a));
      replyingAnnId = null;
      drafts.update(renderedEditor.key, renderedEditor.entry, { annotations: anns });
      render();
      return;
    }
    if (action === 'remove-ann' && renderedEditor) {
      const annId = target.dataset.annId;
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const anns = (current.annotations || []).filter(a => a.id !== annId);
      if (replyingAnnId === annId) replyingAnnId = null;
      drafts.update(renderedEditor.key, renderedEditor.entry, { annotations: anns });
      render();
      return;
    }

    if (action === 'toggle-pinned' && renderedEditor) {
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      popover = null;
      drafts.update(renderedEditor.key, renderedEditor.entry, { pinned: !current.pinned });
      render();
      return;
    }
    if (action === 'set-mood' && renderedEditor) {
      popover = null;
      drafts.update(renderedEditor.key, renderedEditor.entry, { mood: target.dataset.mood || '' });
      render();
      return;
    }
    if (action === 'talk-about-entry' && renderedEditor && typeof onTalkAboutEntry === 'function') {
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      onTalkAboutEntry(current);
      return;
    }
    if (action === 'undo-delete') { undoPendingDelete(); return; }
    if (action === 'delete-cancel') { deleteConfirm = null; render(); return; }
    if (action === 'retry-save') return renderedEditor && void drafts.save(renderedEditor.key, { manual: true });
    if (action === 'overwrite-save') return renderedEditor && void drafts.save(renderedEditor.key, { manual: true, overwrite: true });
    if (action === 'use-server') return renderedEditor && drafts.useServer(renderedEditor.key);
    if (action === 'save-as-new' && renderedEditor) {
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      drafts.discard(renderedEditor.key);
      selectedEntryId = null;
      const copy = { ...current, id: undefined, revision: 0 };
      drafts.update(editorKey(), copy, copy);
      return void drafts.save(editorKey(), { manual: true });
    }
    if (action === 'select-entry') {
      const entryId = target.dataset.id;
      if (entryId) {
        if (renderedEditor?.key && entryId !== selectedEntryId) void drafts.flush(renderedEditor.key);
        selectedEntryId = entryId;
        detailOpen = true;
        popover = null;
        replyingAnnId = null;
        annotationError = '';
        sheetCursor = null;
        render();
        $('#today-panel')?.querySelector?.('[name="entry-title"]')?.focus?.({ preventScroll: true });
      }
      return;
    }
    if (action === 'clear-draft' && renderedEditor) {
      popover = null;
      sheetCursor = null;
      openNewDraft();
      return;
    }
    if (action === 'new-entry') {
      if (renderedEditor?.key) void drafts.flush(renderedEditor.key);
      openNewDraft();
      return;
    }

    const panel = $('#today-panel');
    const { value } = readForm(panel);
    const entryEl = target.closest?.('.today-entry');

    if (action === 'add-entry') {
      if (!renderedEditor) return;
      const current = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
      const checkedScope = panel?.querySelector?.('[name="entry-share-scope"]:checked')?.value;
      const shareScope = checkedScope ? (checkedScope === 'summary' ? 'summary' : 'note') : normalizeShareScope(current);
      const persons = Array.isArray(current.allowedPersonIds) ? current.allowedPersonIds : [];
      const useCompanion = Boolean(current.useForCompanionship && persons.length > 0);
      const segNodes = [...(panel?.querySelectorAll?.('.today-sheet-body') || [])];
      const mergedDomContent = segNodes.length > 1
        ? segNodes.flatMap(node => contentLinesOf(node.value)).join('\n')
        : (panel?.querySelector?.('[name="entry-content"]')?.value ?? current.content ?? null);
      const payload = {
        type: value('entry-type') || current.type || 'note',
        title: panel?.querySelector?.('[name="entry-title"]')?.value ?? current.title ?? '',
        content: mergedDomContent,
        localDate: value('entry-date') || current.localDate || selectedDate,
        startTime: value('entry-start') || current.startTime || null,
        endTime: value('entry-end') || current.endTime || null,
        endDate: value('entry-end-date') || current.endDate || null,
        repeatFrequency: value('entry-repeat') || current.repeatFrequency || 'none',
        repeatWeekdays: current.repeatWeekdays || [],
        yearlyRepeat: (value('entry-repeat') || current.repeatFrequency) === 'yearly',
        useForCompanionship: useCompanion,
        companionNote: panel?.querySelector?.('[name="entry-note"]')?.value ?? current.companionNote ?? null,
        noteUsesTitle: shareScope === 'summary',
        shareScope,
        allowedPersonIds: persons,
        tags: current.tags || [],
        attachedTracks: effectiveTracksOf(current),
        attachedTrack: effectiveTracksOf(current)[0] || null,
        attachedQuotes: current.attachedQuotes || [],
        checklist: current.checklist || [],
        annotations: current.annotations || [],
        layoutVariant: current.layoutVariant || 'blank',
      };
      return void saveEntry(current.id || null, payload);
    }

    const targetId = entryEl?.dataset?.id || target.dataset.id || selectedEntryId;
    if (action === 'toggle-done' && targetId) {
      return void mutateEntry(targetId, 'done', {
        done: target.checked,
        ...(entryEl?.dataset?.occurrenceDate ? { occurrenceDate: entryEl.dataset.occurrenceDate } : {}),
      });
    }
    if ((action === 'move-today' || action === 'move-tomorrow') && targetId) {
      const current = data.entries.find(item => item.id === targetId);
      const changes = current && rescheduleEntry(current, shiftDate(localToday(), action === 'move-tomorrow' ? 1 : 0));
      if (changes) {
        popover = null;
        return void mutateEntry(targetId, 'reschedule', changes);
      }
      return;
    }
    if (action === 'revoke' && targetId) return void mutateEntry(targetId, 'revoke');
    if (action === 'soft-delete' && targetId) return void startSoftDelete(targetId);
    if (action === 'delete' && targetId) { deleteConfirm = targetId; render(); return; }
    if (action === 'delete-confirm' && targetId) return void mutateEntry(targetId, 'delete');
    return undefined;
  }

  function openNewDraft({
    type = 'note',
    title = '',
    content = '',
    attachedTrack = null,
    attachedTracks = null,
    attachedQuotes = [],
    checklist = [],
    layoutVariant = 'blank',
    focus = true,
  } = {}) {
    selectedEntryId = null;
    detailOpen = true;
    popover = null;
    replyingAnnId = null;
    annotationError = '';
    sheetCursor = null;
    const tracks = Array.isArray(attachedTracks)
      ? attachedTracks
      : (attachedTrack?.title ? [attachedTrack] : []);
    const key = editorKey();
    const emptySeed = {
      type: 'note',
      title: '',
      content: '',
      localDate: selectedDate,
      useForCompanionship: false,
      noteUsesTitle: false,
      shareScope: 'note',
      allowedPersonIds: [],
      tags: [],
      mood: '',
      pinned: false,
      attachedTrack: null,
      attachedTracks: [],
      attachedQuotes: [],
      checklist: [],
      annotations: [],
      layoutVariant: 'blank',
      revision: 0,
    };
    const blank = {
      ...emptySeed,
      type,
      title,
      content,
      attachedTrack: tracks[0] || null,
      attachedTracks: tracks,
      attachedQuotes: Array.isArray(attachedQuotes) ? attachedQuotes : [],
      checklist: Array.isArray(checklist) ? checklist : [],
      layoutVariant: LAYOUT_ORDER.includes(layoutVariant) ? layoutVariant : 'blank',
    };
    drafts.discard(key);
    if (title || content || tracks.length || blank.attachedQuotes.length || blank.checklist.length || type !== 'note' || blank.layoutVariant !== 'blank') {
      drafts.update(key, emptySeed, blank);
    }
    render();
    if (focus) {
      $('#today-panel')?.querySelector?.('[name="entry-title"]')?.focus?.();
    }
  }

  function refreshNowPlaying() {
    const nextKey = playingKeyOf(getNowPlaying?.());
    if (nextKey === lastPlayingKey) return;
    lastPlayingKey = nextKey;
    if (inspectorTab !== 'fragments') return;
    const panel = $('#today-panel');
    if (!panel || panel.hidden || composing) return;
    if (isEditorTextFocused()) {
      const heading = panel.querySelector?.('[data-frag-track-heading]');
      const list = panel.querySelector?.('[data-frag-track-list]');
      if (heading && list && renderedEditor) {
        const entry = drafts.get(renderedEditor.key)?.entry || renderedEditor.entry;
        heading.textContent = `今日听过的歌（${realTrackPool().length}）`;
        list.innerHTML = renderFragmentsTrackRowsHtml(entry);
      }
      return;
    }
    render();
  }

  function tickClock() {
    const panel = $('#today-panel');
    if (!panel || panel.hidden || composing) return;
    const nowDate = localToday();
    if (nowDate !== lastWallDate) {
      const wasSelectedToday = selectedDate === lastWallDate;
      lastWallDate = nowDate;
      if (wasSelectedToday) selectedDate = nowDate;
      render();
      return;
    }
    const clock = wallTime();
    const timeNode = panel.querySelector?.('[data-now-time]') || panel.querySelector?.('[data-now-line] time');
    if (timeNode) timeNode.textContent = clock;
  }

  function init() {
    const panel = $('#today-panel');
    const clockTimer = scheduleInterval(() => { tickClock(); }, 60000);
    clockTimer?.unref?.();
    documentLike.defaultView?.addEventListener?.('beforeunload', event => {
      if (renderedEditor?.key) void drafts.flush(renderedEditor.key);
      void commitPendingDelete({ keepalive: true });
      if (drafts.hasPending()) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
    panel?.addEventListener?.('compositionstart', () => { composing = true; });
    panel?.addEventListener?.('compositionend', event => { composing = false; recordEditorInput(event); });
    panel?.addEventListener?.('input', recordEditorInput);
    panel?.addEventListener?.('change', event => {
      const tag = String(event.target?.tagName || '').toUpperCase();
      const type = String(event.target?.type || '').toLowerCase();
      if (tag === 'TEXTAREA' || (tag === 'INPUT' && (!type || type === 'text' || type === 'search'))) return;
      recordEditorInput(event);
    });
    panel?.addEventListener?.('focusout', event => {
      const next = event?.relatedTarget;
      if (next && typeof panel.contains === 'function' && !panel.contains(next)) {
        if (renderedEditor?.key) void drafts.flush(renderedEditor.key);
      }
    });
    panel?.addEventListener?.('focusin', event => { rememberSheetCursor(event.target); });
    panel?.addEventListener?.('keyup', event => { rememberSheetCursor(event.target); });
    panel?.addEventListener?.('mouseup', event => { rememberSheetCursor(event.target); });
    panel?.addEventListener?.('click', handleEvent);
    panel?.addEventListener?.('change', handleEvent);
    panel?.addEventListener?.('keydown', handleEvent);
    documentLike.fonts?.ready?.then?.(() => {
      const activePanel = $('#today-panel');
      if (activePanel && !activePanel.hidden) {
        autoResizeTextarea(activePanel.querySelector?.('[name="entry-title"]'), 36);
        for (const seg of activePanel.querySelectorAll?.('.today-sheet-body') || []) {
          autoResizeTextarea(seg, 30);
        }
      }
    });
    return api;
  }

  const api = Object.freeze({
    init,
    load,
    render,
    refreshNowPlaying,
    openNewDraft,
    flushPendingDelete: commitPendingDelete,
  });
  return api;
}

export default createTodayView;
