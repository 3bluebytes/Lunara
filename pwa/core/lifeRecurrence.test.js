import test from 'node:test';
import assert from 'node:assert/strict';
import { entryOccursOn, nextOccurrence, occurrenceDone } from './lifeRecurrence.js';
test('weekly starts at anchor and leap yearly skips invalid years', () => {
 const weekly = { localDate:'2026-10-08',repeatFrequency:'weekly',repeatWeekdays:[1,3,5] };
 assert.equal(entryOccursOn(weekly,'2026-10-07'),false);
 assert.equal(nextOccurrence(weekly,'2026-10-08'),'2026-10-09');
 assert.equal(nextOccurrence({localDate:'2024-02-29',repeatFrequency:'yearly'},'2026-01-01'),'2028-02-29');
});
test('completion belongs to one occurrence and unfinished skips it', () => {
 const e={type:'todo',localDate:'2026-10-08',repeatFrequency:'daily',completedDates:['2026-10-08']};
 assert.equal(occurrenceDone(e,'2026-10-08'),true);
 assert.equal(occurrenceDone(e,'2026-10-09'),false);
 assert.equal(nextOccurrence(e,'2026-10-08',{unfinished:true}),'2026-10-09');
});
test('many completed leap anniversaries still find the next valid occurrence',()=>{
 const e={type:'todo',localDate:'2024-02-29',repeatFrequency:'yearly',completedDates:Array.from({length:10},(_,i)=>`${2024+i*4}-02-29`)};
 assert.equal(nextOccurrence(e,'2024-02-29',{unfinished:true}),'2064-02-29');
});
