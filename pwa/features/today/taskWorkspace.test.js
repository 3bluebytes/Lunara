import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTaskEntries, taskCounts, entryOccurrence, rescheduleEntry, recencyBucketLabel } from './taskWorkspace.js';
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
 assert.equal(filterTaskEntries(entries,{...opts,view:'today'}).some(e=>e.id==='once'),true);
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
test('pinned entries float first, updated-desc sorts by recency, search spans mood/tags/track, and archived hides', () => {
  const entries = [
    todo('old', '2026-10-01', { updatedAt: '2026-10-01T10:00:00Z', mood: '平静', tags: ['阅读'] }),
    todo('pinned', '2026-09-01', { pinned: true, updatedAt: '2026-09-01T10:00:00Z', attachedTrack: { title: '夜曲' } }),
    todo('recent', '2026-10-02', { updatedAt: '2026-10-05T10:00:00Z' }),
    todo('gone', '2026-10-06', { archived: true, title: '夜曲' }),
  ];
  assert.deepEqual(filterTaskEntries(entries, { sort: 'updated-desc', today: '2026-10-08' }).map(e => e.id), ['pinned', 'recent', 'old']);
  assert.deepEqual(filterTaskEntries(entries, { search: '夜曲', today: '2026-10-08' }).map(e => e.id), ['pinned']);
  assert.deepEqual(filterTaskEntries(entries, { search: '平静', today: '2026-10-08' }).map(e => e.id), ['old']);
  assert.deepEqual(filterTaskEntries(entries, { search: '阅读', today: '2026-10-08' }).map(e => e.id), ['old']);
});

test('updated-desc compares numeric ms updatedAt/createdAt cleanly against older dates', () => {
  const entries = [
    todo('sep', '2026-09-23', { createdAt: Date.UTC(2026, 8, 23, 1, 0), updatedAt: Date.UTC(2026, 8, 23, 2, 0) }),
    todo('oct-old', '2026-10-27', { createdAt: Date.UTC(2026, 9, 27, 8, 0), updatedAt: Date.UTC(2026, 9, 27, 8, 0) }),
    todo('sep-edited-now', '2026-09-10', { createdAt: Date.UTC(2026, 8, 10, 8, 0), updatedAt: Date.UTC(2026, 10, 20, 22, 0) }),
  ];
  assert.deepEqual(
    filterTaskEntries(entries, { sort: 'updated-desc', today: '2026-11-20' }).map(e => e.id),
    ['sep-edited-now', 'oct-old', 'sep'],
  );
});

test('recencyBucketLabel groups notes like Apple Notes and search spans co-page attachments', () => {
  const today = '2026-11-21';
  assert.equal(recencyBucketLabel({ pinned: true, localDate: '2025-01-01' }, today), '置顶');
  assert.equal(recencyBucketLabel({ localDate: '2026-11-21' }, today), '今天');
  assert.equal(recencyBucketLabel({ localDate: '2026-11-16' }, today), '过去 7 天');
  assert.equal(recencyBucketLabel({ localDate: '2026-10-27' }, today), '过去 30 天');
  assert.equal(recencyBucketLabel({ localDate: '2026-09-23' }, today), '9月');
  assert.equal(recencyBucketLabel({ localDate: '2025-12-10' }, today), '2025年12月');

  const entries = [
    todo('t1', today, { attachedTracks: [{ title: 'Endless Story', artist: 'REIRA' }] }),
    todo('t2', today, { attachedQuotes: [{ speaker: 'Lunara', text: '今夜的风很轻。' }] }),
    todo('t3', today, { checklist: [{ id: 'c1', text: '重听爵士唱片', done: false }] }),
    todo('t4', today, { annotations: [{ id: 'a1', text: '页边记得泡乌龙茶', reply: '马上就去' }] }),
  ];
  assert.deepEqual(filterTaskEntries(entries, { search: 'reira', today }).map(e => e.id), ['t1']);
  assert.deepEqual(filterTaskEntries(entries, { search: '风很轻', today }).map(e => e.id), ['t2']);
  assert.deepEqual(filterTaskEntries(entries, { search: '爵士唱片', today }).map(e => e.id), ['t3']);
  assert.deepEqual(filterTaskEntries(entries, { search: '乌龙茶', today }).map(e => e.id), ['t4']);
  assert.deepEqual(filterTaskEntries(entries, { search: '马上就去', today }).map(e => e.id), ['t4']);
});
