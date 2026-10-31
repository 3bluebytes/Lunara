import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntryDrafts } from './entryDrafts.js';
const base = { id: 'a', type: 'todo', title: 'Original', content: '', localDate: '2026-10-08', revision: 1, allowedPersonIds: [], useForCompanionship: false };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) { return createEntryDrafts({ request: async (_p, opts) => ({ entry: { ...base, ...opts.body, revision: 2 } }), fetchLatest: async () => base, delay: 60000, ...options }); }
test('save is serial and older responses retain new input against acknowledged revision', async () => {
  let release; const calls = [];
  const store = setup({ request: async (_p, opts) => { calls.push(opts); return new Promise(resolve => { release = resolve; }); } });
  store.update('a', base, { title: 'First' }); const saving = store.save('a', { manual: true });
  store.update('a', base, { title: 'Second' }); await store.save('a');
  assert.equal(calls.length, 1);
  release({ entry: { ...base, title: 'First', revision: 2 } }); await saving;
  assert.equal(store.get('a').entry.title, 'Second'); assert.equal(store.get('a').entry.revision, 2);
  assert.equal(store.get('a').dirty, true); store.dispose();
});
test('permission changes stop auto save even after further ordinary editing', async () => {
  let calls = 0; const store = setup({ request: async (_p, opts) => { calls++; return { entry: { ...base, ...opts.body, revision: 2 } }; } });
  store.update('a', base, { useForCompanionship: true, allowedPersonIds: ['luna'] });
  store.update('a', base, { content: 'Private detail' });
  await store.save('a'); assert.equal(calls, 0); assert.equal(store.get('a').status, 'authorization');
  await store.save('a', { manual: true }); assert.equal(calls, 1); assert.equal(store.hasPending(), false); store.dispose();
});
test('lost create response retries its original identity and payload, then preserves later typing', async () => {
  const calls = []; let fail = true;
  const store = setup({ request: async (_p, opts) => { calls.push(opts.body); if (fail) { fail = false; throw new Error('lost'); } return { entry: { ...base, ...opts.body, id: 'created', revision: 1 } }; } });
  store.update('new:date', { ...base, id: undefined, revision: 0 }, { title: 'First' });
  await store.save('new:date', { manual: true });
  store.update('new:date', base, { title: 'Later' });
  await store.save('new:date', { manual: true });
  assert.deepEqual(calls[1], calls[0]); assert.ok(calls[0].clientRequestId);
  assert.equal(store.get('created').entry.title, 'Later'); assert.equal(store.get('created').dirty, true); store.dispose();
});
test('conflict preserves local text and only explicit overwrite uses latest revision', async () => {
  const calls = []; let conflict = true;
  const latest = { ...base, title: 'Remote', revision: 5 };
  const store = setup({ fetchLatest: async () => latest, request: async (_p, opts) => { calls.push(opts.body); if (conflict) throw Object.assign(new Error('conflict'), { status: 409 }); return { entry: { ...latest, ...opts.body, revision: 6 } }; } });
  store.update('a', base, { content: 'Local' }); await store.save('a', { manual: true });
  assert.equal(store.get('a').status, 'conflict'); assert.equal(store.get('a').conflict.title, 'Remote');
  await store.save('a'); assert.equal(calls.length, 1);
  conflict = false; await store.save('a', { manual: true, overwrite: true });
  assert.equal(calls[1].expectedRevision, 5); assert.equal(calls[1].content, 'Local'); assert.equal(store.hasPending(), false); store.dispose();
});
test('revocation rebases drafts without restoring permission from a pending local draft', async () => {
  const store = setup(); store.update('a', base, { content: 'Draft', useForCompanionship: true, allowedPersonIds: ['p'] });
  store.acceptExternal('a', { ...base, revision: 2 }, { revoked: true });
  assert.equal(store.get('a').entry.useForCompanionship, false); assert.deepEqual(store.get('a').entry.allowedPersonIds, []);
  assert.equal(store.get('a').entry.content, 'Draft'); store.dispose();
});
test('auto save debounce runs and a network error does not auto retry on subsequent typing', async () => {
  let calls = 0;
  const store = setup({ delay: 5, request: async () => { calls++; throw new Error('offline'); } });
  store.update('a', base, { title: 'One' }); store.update('a', base, { title: 'Two' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
  store.update('a', base, { title: 'Three' }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1);
  assert.equal(store.hasPending(), true); store.dispose(); await tick();
});
test('repeat drafts reject empty weekdays and cross-day ranges without losing input',async()=>{
 let calls=0;const drafts=setup({request:async(_p,opts)=>{calls++;return {entry:{...base,...opts.body,revision:2}};}});
 try{
  drafts.update('a',base,{repeatFrequency:'weekly',repeatWeekdays:[]});
  assert.equal(await drafts.save('a',{manual:true}),false);assert.equal(calls,0);assert.match(drafts.get('a').error,/星期/);
  drafts.update('a',base,{repeatWeekdays:[1,3],endDate:'2026-10-09'});
  assert.equal(await drafts.save('a',{manual:true}),false);assert.equal(calls,0);assert.match(drafts.get('a').error,/跨日/);
  drafts.update('a',base,{endDate:null});assert.equal(await drafts.save('a',{manual:true}),true);
  assert.deepEqual(drafts.get('a').entry.repeatWeekdays,[1,3]);
 }finally{drafts.dispose();}
});
