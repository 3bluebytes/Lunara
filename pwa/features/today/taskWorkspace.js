import { repeatFrequency, isRecurringTask, entryOccursOn, occurrenceDone, nextOccurrence, annualOccurrence, shiftLocalDate } from '../../core/lifeRecurrence.js';
export { shiftLocalDate };
export const isTask = entry => entry.type === 'todo' || entry.type === 'event';
const dayValue = value => Date.parse(`${value}T00:00:00Z`);
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
    if (filter === 'completed') return entry.done ? [entry] : [];
    if (entry.done) return [];
    const date = entryOccurrence(entry, today);
    if (filter === 'today' && !(date?.start <= today && date?.end >= today)) return [];
    if (filter === 'overdue' && !(repeatFrequency(entry) === 'none' && date?.end < today)) return [];
    if (filter === 'week' && !Array.from({ length: 7 }, (_, i) => shiftLocalDate(today, i)).some(d => entryOccursOn(entry, d))) return [];
    return [entry];
  }
  if (filter === 'overdue') return [];
  const dates = filter === 'completed' ? [...new Set([...(entry.completedDates || []), ...(entry.done ? [entry.localDate] : [])])] : filter === 'week' ? Array.from({ length: 7 }, (_, i) => shiftLocalDate(today, i))
    : filter === 'today' ? [today] : filter === 'completed' ? [selectedDate] : [nextOccurrence(entry, selectedDate, { unfinished: true })];
  return dates.filter(date => date && entryOccursOn(entry, date))
    .filter(date => filter === 'completed' ? occurrenceDone(entry, date) : !occurrenceDone(entry, date))
    .map(date => ({ ...entry, occurrenceDate: date, occurrenceKey: `${entry.id}:${date}`, done: occurrenceDone(entry, date) }));
}
export function taskCounts(entries, today, selectedDate = today) {
  return Object.fromEntries(['open', 'today', 'overdue', 'week', 'completed'].map(filter => [filter,
    entries.filter(isTask).flatMap(entry => rows(entry, filter, today, selectedDate)).length]));
}
export function filterTaskEntries(entries, { view = 'all', filter = 'open', search = '', sort = 'date-asc', today, selectedDate = today } = {}) {
  const query = search.trim().toLocaleLowerCase();
  const filtered = entries.flatMap(entry => {
    if (view === 'todo') return isTask(entry) ? rows(entry, filter, today, selectedDate) : [];
    if (view === 'note' && entry.type !== 'note') return [];
    if (view === 'important_date' && entry.type !== 'important_date') return [];
    if (isTask(entry) && !isRecurringTask(entry) && entry.done) return [];
    if (view === 'today') return entryOccursOn(entry, selectedDate) && !(isTask(entry) && occurrenceDone(entry, selectedDate)) ? [{ ...entry, ...(isRecurringTask(entry) ? { occurrenceDate: selectedDate, occurrenceKey: `${entry.id}:${selectedDate}`, done: occurrenceDone(entry, selectedDate) } : {}) }] : [];
    if (isRecurringTask(entry)) return rows(entry, 'open', today, selectedDate);
    return [entry];
  }).filter(entry => !query || [entry.title, entry.content, entry.sceneTag].some(text => String(text || '').toLocaleLowerCase().includes(query)));
  return filtered.sort((a, b) => {
    const aDate = a.occurrenceDate || entryOccurrence(a, selectedDate)?.start || '9999-12-31';
    const bDate = b.occurrenceDate || entryOccurrence(b, selectedDate)?.start || '9999-12-31';
    const byDate = aDate.localeCompare(bDate) || (a.startTime || '24:00').localeCompare(b.startTime || '24:00');
    return (sort === 'date-desc' ? -byDate : byDate) || String(a.id).localeCompare(String(b.id));
  });
}
export function rescheduleEntry(entry, localDate) {
  if (repeatFrequency(entry) !== 'none') return null;
  const span = entry.endDate ? Math.round((dayValue(entry.endDate) - dayValue(entry.localDate)) / 86400000) : null;
  return { localDate, ...(span === null ? {} : { endDate: shiftLocalDate(localDate, span) }) };
}
