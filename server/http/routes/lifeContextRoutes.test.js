import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerLifeContextRoutes } from './lifeContextRoutes.js';
import { LifeContextStore } from '../../life/LifeContextStore.js';
import { LifeContextService } from '../../life/LifeContextService.js';
import { PlaybackRuntimeHost } from '../../playback/PlaybackRuntimeHost.js';

function fakeApp() {
  const routes = new Map();
  return {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    put(path, handler) { routes.set(`PUT ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
    delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
    routes,
  };
}

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'life-routes-'));
  const store = new LifeContextStore({ dbPath: join(dir, 'life.db') });
  const life = new LifeContextService({ store });
  const host = new PlaybackRuntimeHost({});
  const app = fakeApp();
  registerLifeContextRoutes(app, {
    lifeContextService: life,
    playbackRuntime: {
      snapshot: () => host.snapshot(),
      listeningSnapshot: id => host.listeningSnapshot(id),
      submit: async event => host.submit(event),
    },
  });
  return { app, life, host, dir, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('life routes round-trip routine, entries and day overrides with revision guards', async () => {
  const ctx = harness();
  try {
    const routineRes = response();
    await ctx.app.routes.get('PUT /api/life/routine')({ body: { timeZone: 'Asia/Shanghai', workDays: [1, 2, 3, 4, 5],
      workStartTime: '09:00', workEndTime: '18:00' } }, routineRes);
    assert.equal(routineRes.statusCode, 200);
    assert.equal(routineRes.payload.routine.revision, 1);

    const staleRes = response();
    await ctx.app.routes.get('PUT /api/life/routine')({ body: { timeZone: 'Asia/Shanghai', workDays: [1],
      expectedRevision: 0 } }, staleRes);
    assert.equal(staleRes.statusCode, 409);
    assert.equal(staleRes.payload.code, 'routine-revision-conflict');

    const dayRes = response();
    await ctx.app.routes.get('PUT /api/life/days/:date')({ params: { date: '2026-09-22' },
      body: { dayType: 'rest' } }, dayRes);
    assert.equal(dayRes.statusCode, 200);
    assert.equal(dayRes.payload.day.dayType, 'rest');

    const created = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: { type: 'todo', title: '买咖啡', localDate: '2026-09-22',
      useForCompanionship: true, companionNote: '想听轻快的', allowedPersonIds: ['lunara'] } }, created);
    assert.equal(created.statusCode, 201);
    const entryId = created.payload.entry.id;

    const done = response();
    await ctx.app.routes.get('POST /api/life/entries/:id/done')({ params: { id: entryId }, body: { done: true } }, done);
    assert.equal(done.statusCode, 200);
    assert.equal(done.payload.entry.done, true);

    const invalid = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: { type: 'todo', title: '', localDate: '2026-09-22' } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.payload.code, 'entry-title-required');
  } finally { ctx.close(); }
});

test('explicit scene use applies the saved mode unless a manual override holds priority', async () => {
  const ctx = harness();
  try {
    const saved = response();
    await ctx.app.routes.get('PUT /api/life/scene-defaults/:sceneTag')({ params: { sceneTag: '骑车回家' },
      body: { modeId: 'music_only' } }, saved);
    assert.equal(saved.statusCode, 200);

    const used = response();
    await ctx.app.routes.get('POST /api/life/scenes/use')({ body: {
      listeningSessionId: 'conversation:primary', sceneTag: '骑车回家', targetDate: '2026-09-22' } }, used);
    assert.equal(used.statusCode, 200);
    assert.equal(used.payload.modeApplied, true);
    assert.equal(used.payload.snapshot.companionModeId, 'music_only');
    assert.equal(used.payload.snapshot.modeSource, 'scene');

    // 用户手动选择偶尔介绍后，场景再次使用不改模式，但场景确认仍记录。
    const manual = await ctx.host.submit({
      type: 'COMPANION_MODE_CHANGED',
      eventId: 'companion-mode:conversation:primary:manual-1',
      listeningSessionId: 'conversation:primary', modeId: 'occasional', requestId: 'manual-1',
    });
    assert.equal(manual.accepted, true, manual.reason);
    const usedAgain = response();
    await ctx.app.routes.get('POST /api/life/scenes/use')({ body: {
      listeningSessionId: 'conversation:primary', sceneTag: '骑车回家', targetDate: '2026-09-22' } }, usedAgain);
    assert.equal(usedAgain.statusCode, 200);
    assert.equal(usedAgain.payload.modeApplied, false, '手动覆盖保持优先');
    assert.equal(usedAgain.payload.manualOverrideHeld, true);
    assert.equal(usedAgain.payload.snapshot.companionModeId, 'occasional');

    const missing = response();
    await ctx.app.routes.get('POST /api/life/scenes/use')({ body: {
      listeningSessionId: 'conversation:primary', sceneTag: '不存在的场景', targetDate: '2026-09-22' } }, missing);
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.payload.code, 'scene_default_missing');
  } finally { ctx.close(); }
});

test('revoking companionship keeps the entry private but locally intact', async () => {
  const ctx = harness();
  try {
    const created = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: { type: 'event', title: '私人预约', localDate: '2026-09-22',
      useForCompanionship: true, companionNote: '想听安静的', allowedPersonIds: ['lunara'] } }, created);
    const id = created.payload.entry.id;
    const revoked = response();
    await ctx.app.routes.get('POST /api/life/entries/:id/revoke-companionship')({ params: { id } }, revoked);
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.payload.entry.useForCompanionship, false);
    assert.equal(revoked.payload.entry.title, '私人预约', '正文保留为本地私有');
    assert.equal(ctx.life.buildLifeContextSnapshot({ personId: 'lunara', targetDate: '2026-09-22' }).entries.length, 0);
  } finally { ctx.close(); }
});

test('entry routes support request identity, partial edits and revision guarded deletion', async () => {
  const ctx = harness();
  try {
    const input = { type: 'todo', title: '写周记', content: '私有正文', localDate: '2026-10-08', clientRequestId: 'route-create' };
    const created = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: input }, created);
    assert.equal(created.statusCode, 201);
    const id = created.payload.entry.id;
    const patch = response();
    await ctx.app.routes.get('PATCH /api/life/entries/:id')({ params: { id }, body: { title: '周记已修改', expectedRevision: 1 } }, patch);
    assert.equal(patch.statusCode, 200);
    assert.equal(patch.payload.entry.content, input.content);
    const replay = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: input }, replay);
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.payload.entry, patch.payload.entry);
    const conflict = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: { ...input, title: '另一件事' } }, conflict);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.payload.code, 'entry-request-conflict');
    const staleDelete = response();
    await ctx.app.routes.get('DELETE /api/life/entries/:id')({ params: { id }, body: { expectedRevision: 1 } }, staleDelete);
    assert.equal(staleDelete.statusCode, 409);
    assert.equal(staleDelete.payload.code, 'entry-revision-conflict');
    assert.equal(ctx.life.getEntry(id).title, '周记已修改');
    const deleted = response();
    await ctx.app.routes.get('DELETE /api/life/entries/:id')({ params: { id }, body: { expectedRevision: 2 } }, deleted);
    assert.deepEqual(deleted.payload, { ok: true, deleted: true });
    const deletedReplay = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: input }, deletedReplay);
    assert.equal(deletedReplay.statusCode, 410);
    assert.equal(deletedReplay.payload.code, 'entry-request-deleted');
    assert.deepEqual(ctx.life.listEntries(), []);
    const invalid = response();
    await ctx.app.routes.get('POST /api/life/entries')({ body: { ...input, clientRequestId: 'x'.repeat(129) } }, invalid);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.payload.code, 'entry-invalid-request-id');
  } finally { ctx.close(); }
});

test('life write errors never log entry content, arbitrary error names or private paths', async t => {
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args));
  const privateText = '私密标题-不应泄露';
  for (const sample of [
    { message: `database is locked: ${privateText}`, code: 'SQLITE_BUSY', result: 'life_storage_busy' },
    { message: `readonly /private/user/${privateText}.db`, code: 'SQLITE_READONLY', result: 'life_storage_readonly' },
    { message: `unknown failure: ${privateText}`, code: privateText, result: 'life_internal_error' },
  ]) {
    const app = fakeApp();
    registerLifeContextRoutes(app, { lifeContextService: {
      createEntry() { throw Object.assign(new Error(sample.message), { name: privateText, code: sample.code }); },
    } });
    const failed = response();
    await app.routes.get('POST /api/life/entries')({ body: { title: privateText } }, failed);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.payload.code, sample.result);
    assert.ok(!JSON.stringify(failed.payload).includes(privateText));
  }
  assert.equal(logs.length, 3);
  assert.ok(!JSON.stringify(logs).includes(privateText));
  assert.ok(!JSON.stringify(logs).includes('/private/user/'));
});

test('recurring route forwards occurrence date and enforces revision per completion',async()=>{
 const ctx=harness();
 try{
  const entry=ctx.life.createEntry({type:'todo',title:'每天运动',localDate:'2026-10-08',repeatFrequency:'daily'});
  const done=ctx.app.routes.get('POST /api/life/entries/:id/done');
  const invalid=response();await done({params:{id:entry.id},body:{done:true,expectedRevision:entry.revision}},invalid);
  assert.equal(invalid.statusCode,400);
  const valid=response();await done({params:{id:entry.id},body:{done:true,expectedRevision:entry.revision,occurrenceDate:'2026-10-08'}},valid);
  assert.equal(valid.statusCode,200);assert.deepEqual(valid.payload.entry.completedDates,['2026-10-08']);
  const stale=response();await done({params:{id:entry.id},body:{done:false,expectedRevision:entry.revision,occurrenceDate:'2026-10-08'}},stale);
  assert.equal(stale.statusCode,409);
 }finally{ctx.close();}
});
