import { repeatFrequency } from '../../core/lifeRecurrence.js';

const EDITABLE = ['type', 'title', 'content', 'localDate', 'endDate', 'startTime', 'endTime', 'yearlyRepeat', 'repeatFrequency', 'repeatWeekdays',
  'useForCompanionship', 'companionNote', 'noteUsesTitle', 'allowedPersonIds', 'sceneTag'];
const AUTHORIZATION = new Set(['useForCompanionship', 'companionNote', 'noteUsesTitle', 'allowedPersonIds']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function entryRequestId() {
  return `life:${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`}`;
}
export function entryPayload(entry) {
  return Object.fromEntries(EDITABLE.filter(key => entry[key] !== undefined).map(key => [key,
    ['content', 'endDate', 'startTime', 'endTime', 'companionNote', 'sceneTag'].includes(key)
      ? (entry[key] || null) : key === 'title' ? String(entry[key] || '').trim() : entry[key]]));
}

// Private drafts live only in memory. A per-record in-flight gate serializes saves;
// a frozen create request survives lost responses independently of subsequent typing.
export function createEntryDrafts({ request, fetchLatest, onSaved = () => {}, onChange = () => {},
  isBlocked = () => false, delay = 700 } = {}) {
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
      record = { key, base: { ...base }, entry: { ...base }, version: 0, status: 'saved', dirty: false,
        authorizationVersion: 0, authorizationPending: false, requestId: entryRequestId() };
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
    if (!['error', 'conflict', 'deleted'].includes(record.status)) record.status = record.inFlight ? 'saving' : record.authorizationPending ? 'authorization' : 'dirty';
    notify(record); schedule(key);
    return record;
  }
  async function captureConflict(record) {
    record.status = 'conflict'; record.conflict = undefined;
    try {
      record.conflict = await fetchLatest(record.entry.id);
      if (!record.conflict) record.status = 'deleted';
    } catch { record.conflictLoadFailed = true; }
  }
  async function save(key, { manual = false, overwrite = false } = {}) {
    const record = records.get(key);
    if (!record || !record.dirty || record.status === 'deleted' || isBlocked(key)) return false;
    clearTimeout(record.timer);
    if (record.inFlight) { if (manual) record.queuedManual = true; return false; }
    if (record.status === 'conflict' && !(manual && overwrite && record.conflict)) return false;
    if (!manual && (record.authorizationPending || record.status === 'error')) return false;
    if (!record.entry.title?.trim()) { record.status = 'dirty'; notify(record); return false; }
    const frequency = repeatFrequency(record.entry);
    if (frequency === 'weekly' && (!Array.isArray(record.entry.repeatWeekdays) || !record.entry.repeatWeekdays.length)) {
      record.status = 'error'; record.error = '每周重复至少选择一个星期。'; notify(record); return false;
    }
    if (['todo', 'event'].includes(record.entry.type) && frequency !== 'none' && record.entry.endDate && record.entry.endDate !== record.entry.localDate) {
      record.status = 'error'; record.error = '重复待办暂不支持跨日范围，请将结束日期设为开始日期。'; notify(record); return false;
    }
    if (record.entry.useForCompanionship && !record.entry.allowedPersonIds?.length) {
      record.status = 'authorization'; record.authorizationPending = true; notify(record); return false;
    }
    if (overwrite) {
      record.entry = { ...record.entry, revision: record.conflict.revision };
      record.base = record.conflict; record.conflict = null;
    }
    const submitted = { ...record.entry };
    const submittedVersion = record.version;
    const submittedAuthorization = record.authorizationVersion;
    const editingId = submitted.id;
    if (!editingId && !record.pendingCreate) record.pendingCreate = { ...entryPayload(submitted), clientRequestId: record.requestId };
    const payload = editingId ? { ...entryPayload(submitted), expectedRevision: submitted.revision } : record.pendingCreate;
    record.inFlight = true; record.status = 'saving'; notify(record);
    let succeeded = false;
    try {
      const result = await request(editingId ? `/api/life/entries/${encodeURIComponent(editingId)}` : '/api/life/entries', {
        method: editingId ? 'PATCH' : 'POST', body: payload,
      });
      if (result?.ok === false || !result?.entry?.id) throw new Error('保存结果未能确认');
      const saved = result.entry;
      const latest = record.entry;
      // For a retried create, compare against the frozen original request, not the
      // new text: the response acknowledges the original payload only.
      const acknowledged = editingId ? submitted : payload;
      const remaining = Object.fromEntries(EDITABLE.filter(field => !same(entryPayload(latest)[field], entryPayload(acknowledged)[field]))
        .map(field => [field, latest[field]]));
      const stillDirty = Object.keys(remaining).length > 0;
      record.base = saved;
      record.entry = stillDirty ? { ...saved, ...remaining } : saved;
      record.dirty = stillDirty;
      record.authorizationPending = record.authorizationVersion !== submittedAuthorization
        || (!editingId && [...AUTHORIZATION].some(field => Object.hasOwn(remaining, field)));
      record.status = stillDirty ? record.authorizationPending ? 'authorization' : 'dirty' : 'saved';
      record.pendingCreate = null;
      const oldKey = record.key;
      if (oldKey !== saved.id) { records.delete(oldKey); record.key = saved.id; records.set(saved.id, record); }
      onSaved(saved, oldKey, submittedVersion);
      succeeded = true;
    } catch (error) {
      record.error = '暂时没有保存，内容仍保留在这里。请检查连接后重试。';
      if (error.status === 409) await captureConflict(record);
      else if (error.status === 404 || error.status === 410) record.status = 'deleted';
      else record.status = 'error';
    } finally {
      record.inFlight = false; notify(record);
      const queuedManual = record.queuedManual; record.queuedManual = false;
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
    record.base = saved; record.entry = { ...saved, ...edits };
    if (revoked) {
      record.entry.useForCompanionship = false; record.entry.allowedPersonIds = [];
      record.authorizationPending = false; record.authorizationVersion += 1;
    }
    if (record.status !== 'conflict' && record.status !== 'error') record.status = record.dirty ? record.authorizationPending ? 'authorization' : 'dirty' : 'saved';
    notify(record); schedule(key);
  }
  async function conflict(key, base) {
    const record = records.get(key) || update(key, base, {});
    record.dirty = true; clearTimeout(record.timer); await captureConflict(record); notify(record);
  }
  function useServer(key) {
    const record = records.get(key);
    if (!record?.conflict) return;
    const saved = record.conflict;
    clearTimeout(record.timer); records.delete(key); onSaved(saved, key); notify(null);
  }
  function discard(key) { clearTimeout(records.get(key)?.timer); records.delete(key); }
  function dispose() { for (const record of records.values()) clearTimeout(record.timer); }
  return { get: key => records.get(key), update, save, schedule, acceptExternal, conflict, useServer, discard, dispose,
    hasPending: () => [...records.values()].some(record => record.dirty || record.inFlight),
    isSaving: key => Boolean(records.get(key)?.inFlight) };
}
