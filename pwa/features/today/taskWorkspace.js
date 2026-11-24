import { repeatFrequency, isRecurringTask, entryOccursOn, occurrenceDone, nextOccurrence, annualOccurrence, shiftLocalDate } from '../../core/lifeRecurrence.js';
export { shiftLocalDate };

export const isTask = entry => entry.type === 'todo' || entry.type === 'event';
const dayValue = value => Date.parse(`${value}T00:00:00Z`);
const LOCAL_DATE_FMT = new Intl.DateTimeFormat('en-CA');

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+$/u.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function recencyBucketLabel(entry, todayStr = LOCAL_DATE_FMT.format(new Date())) {
  if (entry?.pinned) return '置顶';
  const recency = timestampMs(entry?.updatedAt) ?? timestampMs(entry?.createdAt);
  let dateStr = recency !== null ? LOCAL_DATE_FMT.format(new Date(recency)) : String(entry?.localDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateStr)) dateStr = todayStr;
  const diffDays = Math.round((dayValue(todayStr) - dayValue(dateStr)) / 86400000);
  if (!Number.isFinite(diffDays) || diffDays <= 0) return '今天';
  if (diffDays <= 7) return '过去 7 天';
  if (diffDays <= 30) return '过去 30 天';
  const month = Number.parseInt(dateStr.slice(5, 7), 10);
  if (dateStr.slice(0, 4) === String(todayStr).slice(0, 4)) return `${month}月`;
  return `${dateStr.slice(0, 4)}年${month}月`;
}

export function entryRecencyMs(entry, fallbackDate = '1970-01-01') {
  const updated = timestampMs(entry?.updatedAt);
  if (updated !== null) return updated;
  const created = timestampMs(entry?.createdAt);
  if (created !== null) return created;
  const date = fallbackDate && fallbackDate !== '9999-12-31' ? fallbackDate : (entry?.localDate || '1970-01-01');
  const time = entry?.startTime && /^\d{2}:\d{2}$/u.test(entry.startTime) ? `${entry.startTime}:00` : '00:00:00';
  const parsed = Date.parse(`${date}T${time}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function entryOccurrence(entry, anchor) {
  if (repeatFrequency(entry) === 'yearly') return annualOccurrence(entry, anchor);
  if (repeatFrequency(entry) !== 'none') {
    const date = entry.occurrenceDate || nextOccurrence(entry, anchor);
    return date ? { start: date, end: date } : null;
  }
  return { start: entry.localDate, end: entry.endDate || entry.localDate };
}

function rows(entry, filter, today, selectedDate) {
  if (filter === 'completed') {
    const dates = [...new Set([...(entry.completedDates || []), ...(isRecurringTask(entry) && entry.done ? [entry.localDate] : [])])];
    const history = dates.map(date => ({ ...entry, occurrenceDate: date, occurrenceKey: `${entry.id}:${date}`, done: true }));
    return !isRecurringTask(entry) && entry.done ? [...history, entry] : history;
  }
  const recurring = isRecurringTask(entry);
  if (!recurring) {
    if (entry.done) return [];
    const date = entryOccurrence(entry, today);
    if (filter === 'today' && !(date?.start <= today && date?.end >= today)) return [];
    if (filter === 'overdue' && !(repeatFrequency(entry) === 'none' && date?.end < today)) return [];
    if (filter === 'week' && !Array.from({ length: 7 }, (_, i) => shiftLocalDate(today, i)).some(d => entryOccursOn(entry, d))) return [];
    return [entry];
  }
  if (filter === 'overdue') return [];
  const dates = filter === 'week'
    ? Array.from({ length: 7 }, (_, i) => shiftLocalDate(today, i))
    : filter === 'today'
      ? [today]
      : [nextOccurrence(entry, selectedDate, { unfinished: true })];
  return dates.filter(date => date && entryOccursOn(entry, date))
    .filter(date => !occurrenceDone(entry, date))
    .map(date => ({ ...entry, occurrenceDate: date, occurrenceKey: `${entry.id}:${date}`, done: false }));
}

export function taskCounts(entries, today, selectedDate = today) {
  const active = entries.filter(entry => !entry.archived);
  return Object.fromEntries(['open', 'today', 'overdue', 'week', 'completed'].map(filter => [filter,
    active.filter(isTask).flatMap(entry => rows(entry, filter, today, selectedDate)).length]));
}

export function filterTaskEntries(entries, { view = 'all', filter = 'open', search = '', sort = 'date-asc', today, selectedDate = today } = {}) {
  const query = search.trim().toLocaleLowerCase();
  const activeEntries = entries.filter(entry => !entry.archived);
  const filtered = activeEntries.flatMap(entry => {
    if (view === 'todo') return isTask(entry) ? rows(entry, filter, today, selectedDate) : [];
    if (view === 'completed') return isTask(entry) ? rows(entry, 'completed', today, selectedDate) : [];
    if (view === 'note') return entry.type === 'note' ? [entry] : [];
    if (view === 'important_date') return entry.type === 'important_date' ? [entry] : [];
    if (view === 'today') {
      if (!entryOccursOn(entry, selectedDate)) return [];
      if (isTask(entry) && isRecurringTask(entry)) {
        const done = occurrenceDone(entry, selectedDate);
        return [{ ...entry, occurrenceDate: selectedDate, occurrenceKey: `${entry.id}:${selectedDate}`, done }];
      }
      // 所选日视图保留当日已完成待办（划掉复盘），方便回溯当天做完的事。
      return [entry];
    }
    if (isTask(entry) && !isRecurringTask(entry) && entry.done) return [];
    if (isRecurringTask(entry)) return rows(entry, 'open', today, selectedDate);
    return [entry];
  }).filter(entry => {
    if (!query) return true;
    const fields = [
      entry.title,
      entry.content,
      entry.sceneTag,
      entry.mood,
      ...(Array.isArray(entry.tags) ? entry.tags : []),
      entry.attachedTrack?.title,
      entry.attachedTrack?.artist,
      ...(Array.isArray(entry.attachedTracks) ? entry.attachedTracks.flatMap(t => [t?.title, t?.artist]) : []),
      ...(Array.isArray(entry.attachedQuotes) ? entry.attachedQuotes.map(q => q?.text) : []),
      ...(Array.isArray(entry.checklist) ? entry.checklist.map(c => c?.text) : []),
      ...(Array.isArray(entry.annotations) ? entry.annotations.flatMap(a => [a?.text, a?.reply]) : []),
    ];
    return fields.some(text => String(text || '').toLocaleLowerCase().includes(query));
  });

  return filtered.sort((a, b) => {
    const byPin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (byPin !== 0) return byPin;
    const aDate = a.occurrenceDate || entryOccurrence(a, selectedDate)?.start || '9999-12-31';
    const bDate = b.occurrenceDate || entryOccurrence(b, selectedDate)?.start || '9999-12-31';
    if (sort === 'updated-desc') {
      const byRecency = entryRecencyMs(b, bDate) - entryRecencyMs(a, aDate);
      return byRecency || bDate.localeCompare(aDate) || String(a.id).localeCompare(String(b.id));
    }
    const byDate = aDate.localeCompare(bDate) || (a.startTime || '24:00').localeCompare(b.startTime || '24:00');
    return (sort === 'date-desc' ? -byDate : byDate) || String(a.id).localeCompare(String(b.id));
  });
}

export function rescheduleEntry(entry, localDate) {
  if (repeatFrequency(entry) !== 'none') return null;
  const span = entry.endDate ? Math.round((dayValue(entry.endDate) - dayValue(entry.localDate)) / 86400000) : null;
  return { localDate, ...(span === null ? {} : { endDate: shiftLocalDate(localDate, span) }) };
}
