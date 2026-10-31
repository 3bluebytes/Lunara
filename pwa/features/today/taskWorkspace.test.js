import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTaskEntries, taskCounts, entryOccurrence, rescheduleEntry } from './taskWorkspace.js';
const todo = (id, localDate, extra = {}) => ({ id, type: 'todo', title: id, localDate, ...extra });
test('task filters separate completion and anchor seven dates on today', () => {
  const entries = [todo('overdue', '2026-12-30'), todo('today', '2026-12-31'), todo('last', '2027-01-06'), todo('later', '2027-01-07'), todo('done', '2026-12-01', { done: true }), todo('legacy', '2026-12-31', { type: 'event' })];
  const opts = { view: 'todo', today: '2026-12-31' };
  assert.deepEqual(filterTaskEntries(entries, { ...opts, filter: 'week' }).map(e => e.id), ['legacy', 'today', 'last']);
  assert.deepEqual(filterTaskEntries(entries, { ...opts, filter: 'overdue' }).map(e => e.id), ['overdue']);
  assert.deepEqual(filterTaskEntries(entries, { ...opts, filter: 'completed' }).map(e => e.id), ['done']);
  assert.deepEqual(taskCounts(entries, opts.today), { open: 5, today: 2, overdue: 1, week: 3, completed: 1 });
});
test('annual occurrence uses valid dates and keeps a cross-year span', () => {
  assert.equal(entryOccurrence(todo('leap', '2024-02-29', { yearlyRepeat: true }), '2026-03-01'), null);
  assert.deepEqual(entryOccurrence(todo('leap', '2024-02-29', { yearlyRepeat: true }), '2028-02-28'), { start: '2028-02-29', end: '2028-02-29' });
  assert.deepEqual(entryOccurrence(todo('annual', '2020-12-30', { yearlyRepeat: true, endDate: '2021-01-02' }), '2026-01-01'), { start: '2025-12-30', end: '2026-01-02' });
  assert.equal(taskCounts([todo('annual', '2020-12-30', { yearlyRepeat: true })], '2026-10-08').overdue, 0);
});
test('search includes body and scene and deterministic sort breaks ties by id', () => {
  const entries = [todo('b', '2026-10-08', { content: 'COFFEE' }), todo('a', '2026-10-08', { sceneTag: 'coffee' }), todo('c', '2026-10-07', { title: 'other' })];
  assert.deepEqual(filterTaskEntries(entries, { search: ' coffee ', today: '2026-10-08' }).map(e => e.id), ['a', 'b']);
});
test('reschedule changes only the date range while retaining span across month and year', () => {
  assert.deepEqual(rescheduleEntry(todo('x', '2026-12-30', { endDate: '2027-01-02', title: 'private', startTime: '22:00' }), '2027-02-27'), { localDate: '2027-02-27', endDate: '2027-03-02' });
  assert.equal(rescheduleEntry(todo('x', '2020-10-08', { yearlyRepeat: true }), '2026-10-08'), null);
});
test('weekly and daily rows have occurrence identity and selected-date completion',()=>{
 const e=todo('repeat','2026-10-08',{repeatFrequency:'daily',completedDates:['2026-10-08']});
 const opts={view:'todo',today:'2026-10-08',selectedDate:'2026-10-08'};
 const week=filterTaskEntries([e],{...opts,filter:'week'});
 assert.equal(week.length,6);
 assert.equal(new Set(week.map(row=>row.occurrenceKey)).size,6);
 assert.equal(filterTaskEntries([e],{...opts,filter:'open'})[0].occurrenceDate,'2026-10-09');
 assert.equal(filterTaskEntries([e],{...opts,filter:'completed'})[0].occurrenceDate,'2026-10-08');
 assert.equal(filterTaskEntries([e],{...opts,filter:'completed',selectedDate:'2026-10-09'}).length,1);
 assert.equal(filterTaskEntries([e],{...opts,filter:'overdue'}).length,0);
});
test('completed occurrences archive automatically across dates and leave other days actionable',()=>{
 const repeat=todo('daily','2026-10-01',{repeatFrequency:'daily',completedDates:['2026-10-02','2026-10-07']});
 const once=todo('once','2026-10-08',{done:true});
 const entries=[repeat,once];const opts={today:'2026-10-08',selectedDate:'2026-10-08'};
 assert.equal(filterTaskEntries(entries,{...opts,view:'all'}).some(e=>e.id==='once'),false);
 assert.equal(filterTaskEntries(entries,{...opts,view:'today'}).some(e=>e.id==='once'),false);
 const archive=filterTaskEntries(entries,{...opts,view:'todo',filter:'completed'});
 assert.equal(archive.length,3);assert.equal(taskCounts(entries,opts.today).completed,3);
 assert.equal(filterTaskEntries(entries,{...opts,view:'todo'})[0].occurrenceDate,'2026-10-08');
});
test('archive preserves history after weekly rule edits and disabling recurrence',()=>{
 for(const repeatFrequency of ['weekly','none']) {
  const edited=todo('x','2026-10-09',{repeatFrequency,repeatWeekdays:[1],completedDates:['2026-10-08']});
  const archived=filterTaskEntries([edited],{view:'todo',filter:'completed',today:'2026-10-09'});
  assert.equal(archived.length,1);assert.equal(archived[0].occurrenceDate,'2026-10-08');assert.equal(archived[0].done,true);
 }
});
