import { repeatFrequency } from '../../core/lifeRecurrence.js';

export const MAX_ENTRY_CONTENT_LENGTH = 5000;

const EDITABLE = [
  'type', 'title', 'content', 'localDate', 'endDate', 'startTime', 'endTime',
  'yearlyRepeat', 'repeatFrequency', 'repeatWeekdays', 'useForCompanionship',
  'companionNote', 'noteUsesTitle', 'allowedPersonIds', 'sceneTag',
  'mood', 'tags', 'pinned', 'archived', 'shareScope', 'attachedTrack',
  'attachedTracks', 'attachedQuotes', 'checklist', 'annotations', 'layoutVariant',
];
const LAYOUT_VARIANTS = new Set(['blank', 'dotgrid', 'playbill']);
const NULLABLE_STRINGS = new Set([
  'content', 'endDate', 'startTime', 'endTime', 'companionNote', 'sceneTag', 'mood', 'shareScope',
]);
const AUTHORIZATION = new Set(['useForCompanionship', 'companionNote', 'noteUsesTitle', 'allowedPersonIds', 'shareScope']);
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

export function deriveTitleFromContent(content, options = {}) {
  const opts = typeof options === 'number' ? { maxChars: options } : (options || {});
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 36;
  const lines = String(content || '').split(/\r?\n/u);
  for (const raw of lines) {
    const cleaned = raw
      .replace(/^\s*(?:#{1,6}\s*|[-*]\s*\[[ xX]\]\s*|[-*>]\s*)/u, '')
      .replace(/^[-*#\s\[\]xX]+/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!cleaned) continue;
    return cleaned.slice(0, maxChars);
  }
  const firstCheck = Array.isArray(opts.checklist)
    ? opts.checklist.map(item => String(item?.text || '').trim()).find(Boolean)
    : '';
  if (firstCheck) return firstCheck.slice(0, maxChars);
  const tracks = Array.isArray(opts.attachedTracks) ? opts.attachedTracks : [];
  if (tracks[0]?.title) return `听《${String(tracks[0].title).trim()}》`.slice(0, maxChars);
  const quotes = Array.isArray(opts.attachedQuotes) ? opts.attachedQuotes : [];
  if (quotes[0]?.text) return String(quotes[0].text).trim().slice(0, maxChars);
  return '';
}

export function entryRequestId() {
  return `life:${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`}`;
}

function cleanChecklistForPayload(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(item => item && typeof item === 'object' && (item.id || String(item.text || '').trim()))
    .slice(0, 50)
    .map((item, index) => ({
      id: String(item.id || `chk:${index + 1}`).trim(),
      text: String(item.text ?? '').slice(0, 240),
      done: item.done === true,
      ...(Number.isInteger(item.afterLine) && item.afterLine >= 0 ? { afterLine: item.afterLine } : {}),
      ...(Number.isFinite(item.order) ? { order: Number(item.order) } : {}),
    }));
}

export function entryPayload(entry) {
  const result = {};
  const effectiveTracks = Array.isArray(entry.attachedTracks)
    ? entry.attachedTracks.filter(t => t && typeof t === 'object' && String(t.title || '').trim())
    : (entry.attachedTrack && typeof entry.attachedTrack === 'object' && String(entry.attachedTrack.title || '').trim()
      ? [entry.attachedTrack]
      : []);
  for (const key of EDITABLE) {
    if (entry[key] === undefined) continue;
    if (NULLABLE_STRINGS.has(key)) result[key] = entry[key] || null;
    else if (key === 'title') {
      const explicit = String(entry[key] || '').trim();
      result[key] = explicit || (entry.type === 'note'
        ? deriveTitleFromContent(entry.content, {
          checklist: entry.checklist,
          attachedTracks: effectiveTracks,
          attachedQuotes: entry.attachedQuotes,
        })
        : '');
    } else if (key === 'tags') {
      result[key] = Array.isArray(entry[key]) ? entry[key].map(item => String(item || '').trim()).filter(Boolean) : [];
    } else if (key === 'pinned' || key === 'archived') {
      result[key] = Boolean(entry[key]);
    } else if (key === 'attachedTrack') {
      result[key] = entry[key] && typeof entry[key] === 'object' ? entry[key] : null;
    } else if (key === 'attachedTracks') {
      result[key] = Array.isArray(entry[key])
        ? entry[key].filter(item => item && typeof item === 'object' && String(item.title || '').trim()).slice(0, 12)
        : [];
    } else if (key === 'attachedQuotes') {
      result[key] = Array.isArray(entry[key])
        ? entry[key].filter(item => item && typeof item === 'object' && String(item.text || '').trim()).slice(0, 12)
        : [];
    } else if (key === 'checklist') {
      result[key] = cleanChecklistForPayload(entry[key]);
    } else if (key === 'annotations') {
      result[key] = Array.isArray(entry[key])
        ? entry[key].filter(item => item && typeof item === 'object' && String(item.text || '').trim()).slice(0, 20)
        : [];
    } else if (key === 'layoutVariant') {
      const variant = String(entry[key] || '').trim();
      result[key] = LAYOUT_VARIANTS.has(variant) ? variant : 'blank';
    } else {
      result[key] = entry[key];
    }
  }
  return result;
}

function mapSaveErrorMessage(error) {
  const code = error?.body?.error || error?.code;
  if (code === 'entry-content-too-long') return '正文最多 5000 字，当前超出上限，请精简后再保存。';
  if (code === 'title-required') return '请先填写标题再保存。';
  if (code === 'allowed-persons-required') return '开启伙伴陪伴后，请至少选择一位伙伴。';
  return '暂时没有保存，内容仍保留在这里。请检查连接后重试。';
}

// Private drafts live only in memory. A per-record in-flight gate serializes saves;
// a frozen create request survives lost responses independently of subsequent typing.
export function createEntryDrafts({
  request,
  fetchLatest,
  onSaved = () => {},
  onChange = () => {},
  isBlocked = () => false,
  delay = 700,
} = {}) {
  const records = new Map();
  function notify(record) { onChange(record); }

  function schedule(key) {
    const record = records.get(key);
    if (!record) return;
    clearTimeout(record.timer);
    if (!record.dirty || record.inFlight || record.authorizationPending || ['error', 'conflict', 'deleted'].includes(record.status)) return;
    record.timer = setTimeout(() => { void save(key); }, delay);
    record.timer.unref?.();
  }

  function update(key, base, changes) {
    let record = records.get(key);
    if (!record) {
      record = {
        key,
        base: { ...base },
        entry: { ...base },
        version: 0,
        status: 'saved',
        dirty: false,
        authorizationVersion: 0,
        authorizationPending: false,
        requestId: entryRequestId(),
      };
      records.set(key, record);
    }
    const changed = Object.keys(changes).filter(field => !same(record.entry[field], changes[field]));
    if (!changed.length) return record;
    record.entry = { ...record.entry, ...changes };
    record.version += 1;
    record.dirty = true;
    if (changed.some(field => AUTHORIZATION.has(field))) {
      record.authorizationVersion += 1;
      record.queuedManual = false;
      record.authorizationPending = true;
    }
    const contentLength = String(record.entry.content || '').length;
    if (contentLength > MAX_ENTRY_CONTENT_LENGTH) {
      record.status = 'error';
      record.error = '正文最多 5000 字，当前超出上限，请精简后再保存。';
    } else if (record.status === 'error' && String(record.error || '').includes('5000 字')) {
      record.error = null;
      record.status = record.inFlight ? 'saving' : record.authorizationPending ? 'authorization' : 'dirty';
    } else if (!['error', 'conflict', 'deleted'].includes(record.status)) {
      record.status = record.inFlight ? 'saving' : record.authorizationPending ? 'authorization' : 'dirty';
    }
    notify(record);
    schedule(key);
    return record;
  }

  async function captureConflict(record) {
    record.status = 'conflict';
    record.conflict = undefined;
    try {
      record.conflict = await fetchLatest(record.entry.id);
      if (!record.conflict) record.status = 'deleted';
    } catch {
      record.conflictLoadFailed = true;
    }
  }

  async function save(key, { manual = false, overwrite = false } = {}) {
    const record = records.get(key);
    if (!record || !record.dirty || record.status === 'deleted' || isBlocked(key)) return false;
    clearTimeout(record.timer);
    if (record.inFlight) { if (manual) record.queuedManual = true; return false; }
    if (record.status === 'conflict' && !(manual && overwrite && record.conflict)) return false;
    if (!manual && (record.authorizationPending || record.status === 'error')) return false;

    const content = String(record.entry.content || '');
    if (content.length > MAX_ENTRY_CONTENT_LENGTH) {
      record.status = 'error';
      record.error = '正文最多 5000 字，当前超出上限，请精简后再保存。';
      notify(record);
      return false;
    }

    const explicitTitle = String(record.entry.title || '').trim();
    const isNote = record.entry.type === 'note';
    const effectiveTracks = Array.isArray(record.entry.attachedTracks)
      ? record.entry.attachedTracks
      : (record.entry.attachedTrack?.title ? [record.entry.attachedTrack] : []);
    const hasDerivedNoteTitle = isNote && Boolean(deriveTitleFromContent(content, {
      checklist: record.entry.checklist,
      attachedTracks: effectiveTracks,
      attachedQuotes: record.entry.attachedQuotes,
    }));
    if (!explicitTitle && !hasDerivedNoteTitle) {
      if (manual) {
        record.status = 'error';
        record.error = isNote ? '请先写下几句内容或标题再保存。' : '请先填写标题再保存。';
      } else {
        record.status = 'dirty';
      }
      notify(record);
      return false;
    }

    const frequency = repeatFrequency(record.entry);
    if (frequency === 'weekly' && (!Array.isArray(record.entry.repeatWeekdays) || !record.entry.repeatWeekdays.length)) {
      record.status = 'error';
      record.error = '每周重复至少选择一个星期。';
      notify(record);
      return false;
    }
    if (['todo', 'event'].includes(record.entry.type) && frequency !== 'none' && record.entry.endDate && record.entry.endDate !== record.entry.localDate) {
      record.status = 'error';
      record.error = '重复待办暂不支持跨日范围，请将结束日期设为开始日期。';
      notify(record);
      return false;
    }
    if (record.entry.useForCompanionship && !record.entry.allowedPersonIds?.length) {
      record.status = 'authorization';
      record.authorizationPending = true;
      notify(record);
      return false;
    }
    if (overwrite) {
      record.entry = { ...record.entry, revision: record.conflict.revision };
      record.base = record.conflict;
      record.conflict = null;
    }

    const submitted = { ...record.entry };
    const submittedVersion = record.version;
    const submittedAuthorization = record.authorizationVersion;
    const editingId = submitted.id;
    if (!editingId && !record.pendingCreate) record.pendingCreate = { ...entryPayload(submitted), clientRequestId: record.requestId };
    const payload = editingId ? { ...entryPayload(submitted), expectedRevision: submitted.revision } : record.pendingCreate;

    record.inFlight = true;
    record.status = 'saving';
    record.error = null;
    notify(record);
    let succeeded = false;
    try {
      const result = await request(editingId ? `/api/life/entries/${encodeURIComponent(editingId)}` : '/api/life/entries', {
        method: editingId ? 'PATCH' : 'POST',
        body: payload,
      });
      if (result?.ok === false || !result?.entry?.id) throw new Error('保存结果未能确认');
      const saved = result.entry;
      const latest = record.entry;
      // For a retried create, compare against the frozen original request, not the
      // new text: the response acknowledges the original payload only.
      const acknowledged = editingId ? submitted : payload;
      const latestPayload = entryPayload(latest);
      const ackPayload = entryPayload(acknowledged);
      const remaining = Object.fromEntries(
        EDITABLE.filter(field => !same(latestPayload[field], ackPayload[field])).map(field => [field, latest[field]]),
      );
      const hadBlankNoteTitle = submitted.type === 'note' && !String(submitted.title || '').trim();
      const stillDirty = Object.keys(remaining).length > 0;
      record.base = saved;
      record.entry = stillDirty
        ? { ...saved, ...remaining }
        : {
          ...saved,
          ...(hadBlankNoteTitle ? { title: '' } : {}),
          ...(latest.content !== undefined && saved.content != null ? { content: latest.content } : {}),
        };
      record.dirty = stillDirty;
      record.authorizationPending = record.authorizationVersion !== submittedAuthorization
        || (!editingId && [...AUTHORIZATION].some(field => Object.hasOwn(remaining, field)));
      record.status = stillDirty ? record.authorizationPending ? 'authorization' : 'dirty' : 'saved';
      record.pendingCreate = null;
      const oldKey = record.key;
      if (oldKey !== saved.id) {
        records.delete(oldKey);
        record.key = saved.id;
        records.set(saved.id, record);
      }
      onSaved(saved, oldKey, submittedVersion);
      succeeded = true;
    } catch (error) {
      record.error = mapSaveErrorMessage(error);
      if (error.status === 409) await captureConflict(record);
      else if (error.status === 404 || error.status === 410) record.status = 'deleted';
      else record.status = 'error';
    } finally {
      record.inFlight = false;
      notify(record);
      const queuedManual = record.queuedManual;
      record.queuedManual = false;
      if (succeeded && record.dirty) {
        if (queuedManual) void save(record.key, { manual: true });
        else schedule(record.key);
      }
    }
    return succeeded;
  }

  function acceptExternal(key, saved, { revoked = false } = {}) {
    const record = records.get(key);
    if (!record) return;
    const edits = Object.fromEntries(EDITABLE.filter(field => !same(record.entry[field], record.base[field])).map(field => [field, record.entry[field]]));
    record.base = saved;
    record.entry = { ...saved, ...edits };
    if (revoked) {
      record.entry.useForCompanionship = false;
      record.entry.allowedPersonIds = [];
      record.authorizationPending = false;
      record.authorizationVersion += 1;
    }
    if (record.status !== 'conflict' && record.status !== 'error') {
      record.status = record.dirty ? record.authorizationPending ? 'authorization' : 'dirty' : 'saved';
    }
    notify(record);
    schedule(key);
  }

  async function conflict(key, base) {
    const record = records.get(key) || update(key, base, {});
    record.dirty = true;
    clearTimeout(record.timer);
    await captureConflict(record);
    notify(record);
  }

  function useServer(key) {
    const record = records.get(key);
    if (!record?.conflict) return;
    const saved = record.conflict;
    clearTimeout(record.timer);
    records.delete(key);
    onSaved(saved, key);
    notify(null);
  }

  function flush(key) {
    const record = records.get(key);
    if (!record || !record.dirty || record.inFlight || record.authorizationPending || ['error', 'conflict', 'deleted'].includes(record.status)) {
      return Promise.resolve(false);
    }
    clearTimeout(record.timer);
    return save(key);
  }

  function discard(key) {
    clearTimeout(records.get(key)?.timer);
    records.delete(key);
  }

  function dispose() {
    for (const record of records.values()) clearTimeout(record.timer);
  }

  return {
    get: key => records.get(key),
    update,
    save,
    schedule,
    flush,
    acceptExternal,
    conflict,
    useServer,
    discard,
    dispose,
    hasPending: () => [...records.values()].some(record => record.dirty || record.inFlight),
    isSaving: key => Boolean(records.get(key)?.inFlight),
  };
}
