// Date-only calendar shared by browser and server; no local timezone arithmetic.
export const repeatFrequency = entry => entry.repeatFrequency ?? (entry.yearlyRepeat ? 'yearly' : 'none');
export const isRecurringTask = entry => ['todo', 'event'].includes(entry.type) && repeatFrequency(entry) !== 'none';
export function validLocalDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function shiftLocalDate(value, days) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function annualOccurrence(entry, anchor) {
  const year = Number(anchor.slice(0, 4));
  const span = Number((entry.endDate || entry.localDate).slice(0, 4)) - Number(entry.localDate.slice(0, 4));
  const range = y => {
    const start = `${y}-${entry.localDate.slice(5)}`;
    const end = `${y + span}-${(entry.endDate || entry.localDate).slice(5)}`;
    return validLocalDate(start) && validLocalDate(end) && start >= entry.localDate ? { start, end } : null;
  };
  const previous = range(year - 1);
  return previous && previous.start <= anchor && previous.end >= anchor ? previous : range(year);
}
export function entryOccursOn(entry, date) {
  if (!validLocalDate(date) || !validLocalDate(entry.localDate) || date < entry.localDate) return false;
  const frequency = repeatFrequency(entry);
  if (frequency === 'daily') return true;
  if (frequency === 'weekly') return (entry.repeatWeekdays || []).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  if (frequency === 'yearly') {
    const range = annualOccurrence(entry, date);
    return Boolean(range && range.start <= date && range.end >= date);
  }
  return entry.localDate <= date && date <= (entry.endDate || entry.localDate);
}
export function occurrenceDone(entry, date) {
  if (!isRecurringTask(entry)) return entry.done === true;
  // Preserve old done without making all future occurrences complete.
  return (entry.completedDates || []).includes(date) || (entry.done === true && date === entry.localDate);
}
export function nextOccurrence(entry, anchor, { unfinished = false } = {}) {
  if (!validLocalDate(anchor) || !validLocalDate(entry.localDate)) return null;
  const frequency = repeatFrequency(entry);
  if (frequency === 'none') return unfinished && entry.done ? null : entry.localDate;
  let date = anchor > entry.localDate ? anchor : entry.localDate;
  // Annual leap dates can be eight years apart at century boundaries.
  const limit = frequency === 'yearly' ? 366 * 8 * ((entry.completedDates?.length || 0) + 2) : (entry.completedDates?.length || 0) * 7 + 14;
  for (let i = 0; i < limit; i++, date = shiftLocalDate(date, 1)) {
    if (entryOccursOn(entry, date) && (!unfinished || !occurrenceDone(entry, date))) return date;
  }
  return null;
}
