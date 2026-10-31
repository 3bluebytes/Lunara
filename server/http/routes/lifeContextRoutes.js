// 今日生活资料的薄路由：本地 CRUD、revision 防覆盖、场景默认与显式使用。
// 服务内只做本地校验与投影，不接外部账号；错误信息面向用户，不回显内部细节。

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
      modeApplied: !manualOverrideHeld, modeId: manualOverrideHeld ? null : sceneDefault.mode_id,
      manualOverrideHeld,
      snapshot: runtime.listeningSnapshot(listeningSessionId) });
  }));

  app.post('/api/life/scenes/clear', asyncRoute(async (req, res) => {
    if (!requireService(res, life, 'life context service')) return;
    life.clearConfirmedScene(String(req.body?.listeningSessionId || ''));
    res.json({ ok: true });
  }));
}
