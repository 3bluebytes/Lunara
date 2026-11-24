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

test('untitled note derives title cleanly while over-5000 chars blocks saving explicitly', async () => {
  const calls = [];
  const drafts = setup({
    request: async (_p, opts) => {
      calls.push(opts.body);
      return { entry: { ...base, type: 'note', ...opts.body, id: 'note:new', revision: 1 } };
    },
  });
  try {
    drafts.update('new:2026-11-20', { id: undefined, type: 'note', title: '', content: '', localDate: '2026-11-20', revision: 0 }, {
      content: '## 雨夜听歌记事\n第二行是细节内容',
      mood: '平静',
      tags: ['雨夜', '阅读'],
      pinned: true,
      attachedTrack: { provider: 'qq', songId: 'song-1', title: '深夜电台', artist: '林一' },
    });
    assert.equal(await drafts.save('new:2026-11-20', { manual: true }), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, '雨夜听歌记事');
    assert.equal(calls[0].mood, '平静');
    assert.deepEqual(calls[0].tags, ['雨夜', '阅读']);
    assert.equal(calls[0].pinned, true);
    assert.equal(calls[0].attachedTrack.songId, 'song-1');

    drafts.update('note:new', drafts.get('note:new').entry, { content: '字'.repeat(5001) });
    assert.equal(drafts.get('note:new').status, 'error');
    assert.equal(await drafts.save('note:new', { manual: true }), false);
    assert.equal(calls.length, 1);

    drafts.update('note:new', drafts.get('note:new').entry, { content: '精简回正文内' });
    assert.equal(drafts.get('note:new').status, 'dirty');
    assert.equal(await drafts.save('note:new', { manual: true }), true);
    assert.equal(calls.length, 2);
  } finally {
    drafts.dispose();
  }
});

test('shareScope edits require explicit manual save like other companion authorizations', async () => {
  let calls = 0;
  const drafts = setup({
    delay: 5,
    request: async (_p, opts) => {
      calls += 1;
      return { entry: { ...base, useForCompanionship: true, allowedPersonIds: ['lunara'], ...opts.body, revision: 2 } };
    },
  });
  try {
    const authEntry = { ...base, useForCompanionship: true, allowedPersonIds: ['lunara'], shareScope: 'note' };
    drafts.update('a', authEntry, { shareScope: 'summary' });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(calls, 0);
    assert.equal(drafts.get('a').status, 'authorization');
    assert.equal(await drafts.save('a', { manual: true }), true);
    assert.equal(calls, 1);
  } finally {
    drafts.dispose();
  }
});

test('scheme B co-page fields derive note title from checklist/tracks/quotes when prose is empty', async () => {
  const calls = [];
  const drafts = setup({
    request: async (_p, opts) => {
      calls.push(opts.body);
      return { entry: { ...base, type: 'note', ...opts.body, id: `note:${calls.length}`, revision: 1 } };
    },
  });
  try {
    // 1. 仅 checklist
    drafts.update('new:chk', { id: undefined, type: 'note', title: '', content: '', localDate: '2026-11-21', revision: 0 }, {
      checklist: [{ id: 'chk:1', text: '把黑胶收好', done: false }],
      layoutVariant: 'dotgrid',
    });
    assert.equal(await drafts.save('new:chk', { manual: true }), true);
    assert.equal(calls[0].title, '把黑胶收好');
    assert.equal(calls[0].layoutVariant, 'dotgrid');

    // 2. 仅 attachedTracks
    drafts.update('new:trk', { id: undefined, type: 'note', title: '', content: '', localDate: '2026-11-21', revision: 0 }, {
      attachedTracks: [{ provider: 'ncm', songId: 's1', title: 'Endless Story', artist: 'REIRA' }],
    });
    assert.equal(await drafts.save('new:trk', { manual: true }), true);
    assert.equal(calls[1].title, '听《Endless Story》');
    assert.equal(calls[1].attachedTracks.length, 1);

    // 3. 仅 attachedQuotes
    drafts.update('new:qt', { id: undefined, type: 'note', title: '', content: '', localDate: '2026-11-21', revision: 0 }, {
      attachedQuotes: [{ turnId: 't1', speaker: 'Lunara', time: '22:15', text: '夜深了听慢歌吧。' }],
      annotations: [{ id: 'ann1', personId: 'lunara', personName: 'Lunara', time: '22:16', text: '我也记得这句', reply: '' }],
      layoutVariant: 'playbill',
    });
    assert.equal(await drafts.save('new:qt', { manual: true }), true);
    assert.equal(calls[2].title, '夜深了听慢歌吧。');
    assert.equal(calls[2].layoutVariant, 'playbill');
    assert.equal(calls[2].annotations.length, 1);
  } finally {
    drafts.dispose();
  }
});

test('flush saves dirty non-auth drafts, skips authorization, and keeps blank title empty for untitled notes', async () => {
  const calls = [];
  let releaseSave;
  const drafts = setup({
    request: async (_p, opts) => {
      calls.push(opts.body);
      if (calls.length === 1) {
        return new Promise(resolve => { releaseSave = resolve; });
      }
      return { entry: { ...base, id: 'saved-2', type: 'note', ...opts.body, title: opts.body.title || 'Derived', revision: 1 } };
    },
  });
  try {
    // 1. Untitled note keeps entry.title === '' locally even when server derives a list title, and keeps concurrent content
    const newNoteBase = { ...base, id: undefined, type: 'note', title: '', content: '', revision: 0 };
    drafts.update('new:note', newNoteBase, { content: '第一句' });
    const flushing = drafts.flush('new:note');
    drafts.update('new:note', newNoteBase, { content: '第一句，接着写' });
    releaseSave({
      entry: { ...base, id: 'created-note', type: 'note', title: '第一句', content: '第一句', revision: 1 },
    });
    assert.equal(await flushing, true);
    const rebased = drafts.get('created-note');
    assert.ok(rebased);
    assert.equal(rebased.entry.title, '');
    assert.equal(rebased.entry.content, '第一句，接着写');
    assert.equal(rebased.dirty, true);

    // 2. Authorization draft is refused by flush
    drafts.update('auth-entry', base, { useForCompanionship: true, allowedPersonIds: ['lunara'] });
    assert.equal(drafts.get('auth-entry').status, 'authorization');
    assert.equal(await drafts.flush('auth-entry'), false);
    assert.equal(calls.length, 1);
  } finally {
    drafts.dispose();
  }
});
