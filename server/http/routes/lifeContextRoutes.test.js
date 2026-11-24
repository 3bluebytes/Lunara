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
    assert.equal(used.payload.modeId, 'music_only');
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

test('preview-context, day-music and open-loops routes bridge journal and companions safely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'life-routes-ext-'));
  const store = new LifeContextStore({ dbPath: join(dir, 'life.db') });
  const life = new LifeContextService({ store });
  const app = fakeApp();
  let settledArgs = null;
  registerLifeContextRoutes(app, {
    lifeContextService: life,
    virtualPersonRegistry: { get: id => (id === 'lunara' ? { id: 'lunara', displayName: 'Lunara' } : null) },
    trackLikeStore: { isLiked: ({ songId }) => songId === '101' },
    playsForDateRange: () => [
      { ts: Date.parse('2026-11-20T22:14:00+08:00'), song_id: '101', source: 'ncm', title: 'Waltz for Debby', artist: 'Bill Evans Trio', album: 'Village Vanguard' },
      { ts: Date.parse('2026-11-20T22:10:00+08:00'), song_id: '101', source: 'ncm', title: 'Waltz for Debby', artist: 'Bill Evans Trio', album: 'Village Vanguard' },
    ],
    conversationStore: {
      notes: {
        listOpenLoops: () => [{ noteId: 'note:ol1', personId: 'lunara', sessionId: 's1', text: '周末给迷迭香换盆', dueAt: Date.parse('2026-11-21T00:00:00Z'), createdAt: 100 }],
        settleById: (id, status) => { settledArgs = { id, status }; return true; },
      },
    },
  });
  try {
    const previewRes = response();
    app.routes.get('POST /api/life/entries/preview-context')({
      body: { type: 'note', title: '夜雨笔记', content: '听爵士', useForCompanionship: true, shareScope: 'summary', allowedPersonIds: ['lunara'] },
    }, previewRes);
    assert.equal(previewRes.statusCode, 200);
    assert.match(previewRes.payload.preview, /Lunara.*夜雨笔记/);

    const musicRes = response();
    app.routes.get('GET /api/life/day-music')({ query: { date: '2026-11-20' } }, musicRes);
    assert.equal(musicRes.statusCode, 200);
    assert.equal(musicRes.payload.tracks.length, 1);
    assert.equal(musicRes.payload.tracks[0].liked, true);

    const loopsRes = response();
    app.routes.get('GET /api/life/open-loops')({}, loopsRes);
    assert.equal(loopsRes.payload.openLoops.length, 1);
    assert.equal(loopsRes.payload.openLoops[0].partnerName, 'Lunara');

    const settleRes = response();
    app.routes.get('POST /api/life/open-loops/:noteId/settle')({ params: { noteId: 'note:ol1' }, body: { status: 'resolved' } }, settleRes);
    assert.deepEqual(settledArgs, { id: 'note:ol1', status: 'resolved' });
    assert.equal(settleRes.payload.settled, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('day-quotes reads real non-superseded visible conversation turns and annotations route enforces LLM & person checks', async () => {
  const { openSqliteDatabase } = await import('../../sqlite.js');
  const dir = mkdtempSync(join(tmpdir(), 'life-quotes-routes-'));
  const lifeStore = new LifeContextStore({ dbPath: join(dir, 'life.db') });
  const chatDb = openSqliteDatabase(join(dir, 'chat.db'));
  try {
    chatDb.exec(`
      CREATE TABLE conversation_requests (request_id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE conversation_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        speaker_virtual_person_id TEXT,
        visible_text TEXT NOT NULL,
        visibility TEXT NOT NULL,
        superseded_at INTEGER,
        request_id TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    const targetDayMid = new Date(2026, 10, 21, 14, 25, 0, 0).getTime();
    const otherDay = new Date(2026, 10, 20, 22, 0, 0, 0).getTime();
    chatDb.prepare('INSERT INTO conversation_requests (request_id, state) VALUES (?, ?)').run('req-ok', 'completed');
    chatDb.prepare('INSERT INTO conversation_requests (request_id, state) VALUES (?, ?)').run('req-pending', 'streaming');
    const insertTurn = chatDb.prepare(`
      INSERT INTO conversation_turns (turn_id, session_id, role, speaker_virtual_person_id, visible_text, visibility, superseded_at, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertTurn.run('t-user', 's1', 'user', null, '今天外面的风像初冬。', 'visible', null, null, targetDayMid);
    insertTurn.run('t-asst', 's1', 'assistant', 'lunara', '那这首钢琴留给你慢慢听。', 'visible', null, 'req-ok', targetDayMid + 5000);
    insertTurn.run('t-superseded', 's1', 'assistant', 'lunara', '被替换的草稿不该出现', 'visible', targetDayMid + 6000, 'req-ok', targetDayMid + 4000);
    insertTurn.run('t-hidden', 's1', 'assistant', 'lunara', '内部旁白不该出现', 'hidden', null, 'req-ok', targetDayMid + 3000);
    insertTurn.run('t-pending', 's1', 'assistant', 'lunara', '尚未完成的输出不该出现', 'visible', null, 'req-pending', targetDayMid + 7000);
    insertTurn.run('t-prev-day', 's1', 'user', null, '昨天的话不该出现在今天', 'visible', null, null, otherDay);

    const life = new LifeContextService({ store: lifeStore });
    const registry = new Map([['lunara', { id: 'lunara', displayName: 'Lunara' }]]);

    // 1. 未配置模型时，POST annotations 返回 503
    const appNoLlm = fakeApp();
    registerLifeContextRoutes(appNoLlm, {
      lifeContextService: life,
      conversationStore: { db: chatDb },
      virtualPersonRegistry: registry,
    });

    const badDateRes = response();
    appNoLlm.routes.get('GET /api/life/day-quotes')({ query: { date: 'bad' } }, badDateRes);
    assert.equal(badDateRes.statusCode, 400);

    const quotesRes = response();
    appNoLlm.routes.get('GET /api/life/day-quotes')({ query: { date: '2026-11-21' } }, quotesRes);
    assert.equal(quotesRes.statusCode, 200);
    assert.equal(quotesRes.payload.quotes.length, 2);
    assert.deepEqual(quotesRes.payload.quotes.map(q => q.turnId), ['t-asst', 't-user']);
    assert.equal(quotesRes.payload.quotes[0].speaker, 'Lunara');
    assert.equal(quotesRes.payload.quotes[0].text, '那这首钢琴留给你慢慢听。');
    assert.equal(quotesRes.payload.quotes[1].speaker, '你');

    const created = life.createEntry({
      type: 'note',
      title: '风声笔记',
      content: '今天外面的风像初冬。',
      localDate: '2026-11-21',
    });

    const badPersonRes = response();
    await appNoLlm.routes.get('POST /api/life/entries/:id/annotations')({
      params: { id: created.id },
      body: { personId: 'ghost' },
    }, badPersonRes);
    assert.equal(badPersonRes.statusCode, 400);
    assert.equal(badPersonRes.payload.code, 'invalid_person');

    const unconfiguredRes = response();
    await appNoLlm.routes.get('POST /api/life/entries/:id/annotations')({
      params: { id: created.id },
      body: { personId: 'lunara' },
    }, unconfiguredRes);
    assert.equal(unconfiguredRes.statusCode, 503);
    assert.equal(unconfiguredRes.payload.code, 'annotation_llm_unavailable');

    // 2. 配置模型返回 LLM_NOT_CONFIGURED 异常也降级为 503
    const appThrowLlm = fakeApp();
    registerLifeContextRoutes(appThrowLlm, {
      lifeContextService: life,
      conversationStore: { db: chatDb },
      virtualPersonRegistry: registry,
      generateJournalAnnotation: async () => {
        const err = new Error('not configured');
        err.name = 'LLMNotConfiguredError';
        err.code = 'LLM_NOT_CONFIGURED';
        throw err;
      },
    });
    const thrownRes = response();
    await appThrowLlm.routes.get('POST /api/life/entries/:id/annotations')({
      params: { id: created.id },
      body: { personId: 'lunara' },
    }, thrownRes);
    assert.equal(thrownRes.statusCode, 503);

    // 3. 真实生成回调成功写入并返回 201
    const appOk = fakeApp();
    registerLifeContextRoutes(appOk, {
      lifeContextService: life,
      conversationStore: { db: chatDb },
      virtualPersonRegistry: registry,
      generateJournalAnnotation: async ({ entry }) => ({
        anchor: entry.content.slice(0, 6),
        text: '这句风像初冬很有画面感，晚上再放一首暖一点的歌给你。',
      }),
    });
    const okRes = response();
    await appOk.routes.get('POST /api/life/entries/:id/annotations')({
      params: { id: created.id },
      body: { personId: 'lunara', expectedRevision: created.revision },
    }, okRes);
    assert.equal(okRes.statusCode, 201);
    assert.equal(okRes.payload.annotation.personId, 'lunara');
    assert.equal(okRes.payload.annotation.anchor, '今天外面的风');
    assert.equal(okRes.payload.entry.annotations.length, 1);
    assert.equal(okRes.payload.entry.useForCompanionship, true);
    assert.ok(okRes.payload.entry.allowedPersonIds.includes('lunara'));
  } finally {
    chatDb.close();
    lifeStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
