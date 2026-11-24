// 今日生活资料的薄路由：本地 CRUD、revision 防覆盖、场景默认与显式使用。
// 服务内只做本地校验与投影，不接外部账号；错误信息面向用户，不回显内部细节。

import { randomUUID } from 'node:crypto';
import { publicRuntimeState } from '../../playback/playbackRuntimeTypes.js';
import { asyncRoute, requireService } from './routeUtils.js';
import { LifeValidationError } from '../../life/LifeContextService.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function lifeError(res, error) {
  if (error instanceof LifeValidationError) {
    const status = error.code === 'entry-request-deleted' ? 410
      : error.code.endsWith('conflict') ? 409 : 400;
    return res.status(status)
      .json({ ok: false, error: error.userMessage, code: error.code });
  }
  // 异常 name/message/code 都可能包含私密输入或路径；日志只输出封闭分类。
  const detail = String(error?.message || error || '');
  const diagnostic = `${String(error?.code || '')} ${detail}`;
  if (/READONLY|EACCES|EPERM/i.test(diagnostic)) {
    console.error('[life] write failed: storage_readonly');
    return res.status(500).json({ ok: false, error: '本地存储暂时不可写（可能被权限或同步盘占用），请检查数据目录后重试。', code: 'life_storage_readonly' });
  }
  if (/BUSY|locked/i.test(diagnostic)) {
    console.error('[life] write failed: storage_busy');
    return res.status(500).json({ ok: false, error: '本地存储正被其他程序占用，请稍后再试。', code: 'life_storage_busy' });
  }
  console.error('[life] write failed: internal_error');
  return res.status(500).json({ ok: false, error: '保存没有完成，请再试一次。', code: 'life_internal_error' });
}

export function registerLifeContextRoutes(app, services = {}) {
  const life = services.lifeContextService;

  app.get('/api/life/status', (_req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    res.json({ ok: true, ...life.status() });
  });

  app.get('/api/life/routine', (_req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    res.json({ ok: true, routine: life.getRoutine() });
  });

  app.put('/api/life/routine', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      const routine = life.saveRoutine(req.body || {}, { expectedRevision: req.body?.expectedRevision ?? null });
      res.json({ ok: true, routine, contextRevision: life.status().contextRevision });
    } catch (error) { lifeError(res, error); }
  }));

  app.get('/api/life/days/:date', (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    const date = String(req.params?.date || '');
    if (!DATE_PATTERN.test(date)) return res.status(400).json({ ok: false, error: '日期无效。', code: 'invalid_date' });
    res.json({ ok: true, date, override: life.getOverride(date), day: life.resolveDayType(date) });
  });

  app.put('/api/life/days/:date', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    const date = String(req.params?.date || '');
    if (!DATE_PATTERN.test(date)) return res.status(400).json({ ok: false, error: '日期无效。', code: 'invalid_date' });
    try {
      const override = life.saveOverride({ ...(req.body || {}), localDate: date },
        { expectedRevision: req.body?.expectedRevision ?? null });
      res.json({ ok: true, override, day: life.resolveDayType(date) });
    } catch (error) { lifeError(res, error); }
  }));

  app.delete('/api/life/days/:date', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      life.deleteOverride(String(req.params?.date || ''), { expectedRevision: req.body?.expectedRevision ?? null });
      res.json({ ok: true });
    } catch (error) { lifeError(res, error); }
  }));

  app.get('/api/life/entries', (_req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    res.json({ ok: true, entries: life.listEntries() });
  });

  app.post('/api/life/entries', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      const created = life.createEntry(req.body || {});
      res.status(201).json({ ok: true, entry: created });
    } catch (error) { lifeError(res, error); }
  }));

  app.patch('/api/life/entries/:id', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      const updated = life.updateEntry(String(req.params?.id || ''), req.body || {},
        { expectedRevision: req.body?.expectedRevision ?? null });
      res.json({ ok: true, entry: updated });
    } catch (error) { lifeError(res, error); }
  }));

  app.post('/api/life/entries/:id/done', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      const updated = life.setEntryDone(String(req.params?.id || ''), req.body?.done === true,
        { expectedRevision: req.body?.expectedRevision ?? null, occurrenceDate: req.body?.occurrenceDate ?? null });
      res.json({ ok: true, entry: updated });
    } catch (error) { lifeError(res, error); }
  }));

  app.delete('/api/life/entries/:id', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      res.json({ ok: true, ...life.deleteEntry(String(req.params?.id || ''),
        { expectedRevision: req.body?.expectedRevision ?? null }) });
    } catch (error) { lifeError(res, error); }
  }));

  app.post('/api/life/entries/:id/revoke-companionship', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      res.json({ ok: true, entry: life.revokeEntryCompanionship(String(req.params?.id || '')) });
    } catch (error) { lifeError(res, error); }
  }));

  app.get('/api/life/scene-defaults', (_req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    res.json({ ok: true, sceneDefaults: life.listSceneDefaults() });
  });

  app.put('/api/life/scene-defaults/:sceneTag', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    try {
      const saved = life.saveSceneDefault(String(req.params?.sceneTag || ''), req.body?.modeId,
        { expectedRevision: req.body?.expectedRevision ?? null });
      res.json({ ok: true, sceneDefault: saved });
    } catch (error) { lifeError(res, error); }
  }));

  app.delete('/api/life/scene-defaults/:sceneTag', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    life.deleteSceneDefault(String(req.params?.sceneTag || ''));
    res.json({ ok: true });
  }));

  // 显式使用场景：设置 confirmedScene 并把保存的默认模式应用到指定听歌会话。
  // 已有手动模式覆盖保持优先，只记录场景，不改模式。
  app.post('/api/life/scenes/use', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    const runtime = services.playbackRuntime;
    if (!requireService(res, runtime, 'playback runtime')) return;
    const body = req.body || {};
    const listeningSessionId = String(body.listeningSessionId || '');
    const sceneTag = String(body.sceneTag || '');
    const targetDate = String(body.targetDate || '');
    if (!listeningSessionId || !sceneTag || !DATE_PATTERN.test(targetDate)) {
      return res.status(400).json({ ok: false, error: '需要听歌会话、场景和日期。', code: 'scene_use_invalid' });
    }
    const sceneDefault = life.getSceneDefault(sceneTag) || null;
    if (!sceneDefault) {
      return res.status(404).json({ ok: false, error: '这个场景还没有保存默认模式。', code: 'scene_default_missing' });
    }
    try {
      life.confirmScene({ listeningSessionId, sceneTag, targetDate });
    } catch (error) { return lifeError(res, error); }
    const snapshot = runtime.listeningSnapshot(listeningSessionId);
    const manualOverrideHeld = snapshot.modeSource === 'explicit';
    if (!manualOverrideHeld) {
      const result = await runtime.submit({
        type: 'COMPANION_MODE_CHANGED',
        eventId: `companion-mode:${listeningSessionId}:scene:${sceneTag}:${life.status().contextRevision}`,
        listeningSessionId,
        modeId: sceneDefault.modeId,
        modeSource: 'scene',
        requestId: `scene-use:${sceneTag}`,
      });
      if (!result.accepted && result.reason !== 'duplicate event') {
        return res.status(409).json({ ok: false, error: result.reason, code: 'scene_mode_rejected' });
      }
    }
    res.json({ ok: true, confirmed: { sceneTag, targetDate },
      modeApplied: !manualOverrideHeld, modeId: manualOverrideHeld ? null : sceneDefault.modeId,
      manualOverrideHeld,
      snapshot: publicRuntimeState(runtime.listeningSnapshot(listeningSessionId)) });
  }));

  app.post('/api/life/scenes/clear', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    life.clearConfirmedScene(String(req.body?.listeningSessionId || ''));
    res.json({ ok: true });
  }));

  app.post('/api/life/entries/preview-context', (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    const registry = services.virtualPersonRegistry;
    const personIds = Array.isArray(req.body?.allowedPersonIds) ? req.body.allowedPersonIds : [];
    const partnerNames = personIds.map(id => registry?.get?.(id)?.displayName || (id === 'lunara' ? 'Lunara' : id));
    const preview = life.previewCompanionshipText(req.body || {}, { partnerNames });
    res.json({ ok: true, preview });
  });

  app.get('/api/life/day-music', (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    const date = String(req.query?.date || '');
    if (!DATE_PATTERN.test(date)) return res.status(400).json({ ok: false, error: '日期无效。', code: 'invalid_date' });
    const [year, month, day] = date.split('-').map(n => Number.parseInt(n, 10));
    const startMs = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    const endMs = startMs + 24 * 3600 * 1000;
    const plays = typeof services.playsForDateRange === 'function'
      ? services.playsForDateRange(startMs, endMs, 60)
      : [];
    const likeStore = services.trackLikeStore;
    const seen = new Set();
    const tracks = [];
    for (const row of plays) {
      if (!row?.title) continue;
      const provider = row.source || 'unknown';
      const songId = row.song_id || '';
      const identity = songId ? `${provider}:${songId}` : `${row.title}::${row.artist || ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const liked = Boolean(likeStore && songId && likeStore.isLiked?.({ provider, songId }));
      const dt = new Date(row.ts);
      const playedAt = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      tracks.push({
        provider,
        songId,
        title: row.title,
        artist: row.artist || '',
        album: row.album || '',
        playedAt,
        ts: row.ts,
        liked,
      });
    }
    res.json({ ok: true, date, tracks });
  });

  app.get('/api/life/open-loops', (_req, res) => {
    const notes = services.conversationStore?.notes;
    if (!notes?.listOpenLoops) return res.json({ ok: true, openLoops: [] });
    const registry = services.virtualPersonRegistry;
    const loops = notes.listOpenLoops({ limit: 20 }).map(loop => ({
      noteId: loop.noteId,
      personId: loop.personId,
      partnerName: registry?.get?.(loop.personId)?.displayName || (loop.personId === 'lunara' ? 'Lunara' : loop.personId),
      sessionId: loop.sessionId,
      text: loop.text,
      dueDate: loop.dueAt ? new Intl.DateTimeFormat('en-CA').format(new Date(loop.dueAt)) : null,
      createdAt: loop.createdAt,
    }));
    res.json({ ok: true, openLoops: loops });
  });

  app.post('/api/life/open-loops/:noteId/settle', (req, res) => {
    const notes = services.conversationStore?.notes;
    if (!notes?.settleById) return res.json({ ok: true, settled: false });
    const status = req.body?.status === 'dropped' ? 'dropped' : 'resolved';
    const settled = notes.settleById(String(req.params?.noteId || ''), status);
    res.json({ ok: true, settled });
  });

  app.get('/api/life/day-quotes', (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    const date = String(req.query?.date || '');
    if (!DATE_PATTERN.test(date)) return res.status(400).json({ ok: false, error: '日期无效。', code: 'invalid_date' });
    const [year, month, day] = date.split('-').map(n => Number.parseInt(n, 10));
    const startMs = new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
    const endMs = startMs + 24 * 3600 * 1000;
    const registry = services.virtualPersonRegistry;
    let rawRows = [];
    if (typeof services.listQuotesForDateRange === 'function') {
      rawRows = services.listQuotesForDateRange({ startMs, endMs, date, limit: 30 }) || [];
    } else if (services.conversationStore?.db) {
      try {
        rawRows = services.conversationStore.db.prepare(`
          SELECT t.turn_id, t.session_id, t.role, t.speaker_virtual_person_id, t.visible_text, t.created_at
          FROM conversation_turns t
          LEFT JOIN conversation_requests r ON r.request_id = t.request_id
          WHERE t.created_at >= ? AND t.created_at < ?
            AND t.visibility = 'visible'
            AND t.superseded_at IS NULL
            AND t.visible_text != ''
            AND (t.request_id IS NULL OR r.state = 'completed')
          ORDER BY t.created_at DESC
          LIMIT 30
        `).all(startMs, endMs);
      } catch {
        rawRows = [];
      }
    }
    const quotes = [];
    for (const row of rawRows) {
      const text = String(row?.visible_text ?? row?.text ?? '').trim();
      if (!text) continue;
      const role = row?.role === 'user' ? 'user' : 'assistant';
      const personId = role === 'assistant' ? (row?.speaker_virtual_person_id || row?.personId || 'lunara') : null;
      const speaker = role === 'user'
        ? (row?.speaker || '你')
        : (row?.speaker || registry?.get?.(personId)?.displayName || (personId === 'lunara' ? 'Lunara' : personId || '伙伴'));
      const ts = Number(row?.created_at ?? row?.ts ?? startMs);
      const dt = new Date(Number.isFinite(ts) ? ts : startMs);
      const time = row?.time || `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      quotes.push({
        turnId: String(row?.turn_id || row?.turnId || ''),
        sessionId: String(row?.session_id || row?.sessionId || ''),
        role,
        ...(personId ? { personId: String(personId) } : {}),
        speaker,
        time,
        text,
      });
    }
    res.json({ ok: true, date, quotes });
  });

  app.post('/api/life/entries/:id/annotations', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    const entryId = String(req.params?.id || '');
    const entry = life.getEntry(entryId);
    if (!entry) return res.status(404).json({ ok: false, error: '这条内容已经不存在。', code: 'entry-not-found' });
    const personId = String(req.body?.personId || '').trim() || 'lunara';
    const person = services.virtualPersonRegistry?.get?.(personId);
    if (!person) return res.status(400).json({ ok: false, error: '这位伙伴不存在。', code: 'invalid_person' });
    if (typeof services.generateJournalAnnotation !== 'function') {
      return res.status(503).json({ ok: false, error: '当前未配置可用模型，暂时无法生成伙伴批注。', code: 'annotation_llm_unavailable' });
    }
    try {
      const generated = await services.generateJournalAnnotation({ entry, person, personId });
      const text = String(generated?.text || '').trim();
      if (!text) {
        return res.status(500).json({ ok: false, error: '伙伴这次没能写出批注，请稍后再试。', code: 'annotation_empty' });
      }
      const dt = new Date();
      const wallHHMM = `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
      const saved = life.appendAnnotation(entry.id, {
        id: `ann:${randomUUID()}`,
        personId,
        personName: person.displayName || personId,
        createdAt: Date.now(),
        time: wallHHMM,
        anchor: String(generated?.anchor || '').trim().slice(0, 24),
        text,
        reply: '',
      }, { expectedRevision: req.body?.expectedRevision ?? null });
      res.status(201).json({ ok: true, entry: saved.entry, annotation: saved.annotation });
    } catch (error) {
      if (error?.code === 'annotation_llm_unavailable' || error?.name === 'LLMNotConfiguredError' || error?.code === 'LLM_NOT_CONFIGURED') {
        return res.status(503).json({ ok: false, error: '当前未配置可用模型，暂时无法生成伙伴批注。', code: 'annotation_llm_unavailable' });
      }
      lifeError(res, error);
    }
  }));
}
