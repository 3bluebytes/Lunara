import { asyncRoute, requireService } from './routeUtils.js';
import { isCompanionModeId } from '../../playback/companionModes.js';

const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/;

export function registerOperationsRoutes(app, services = {}) {
  const playback = services.playbackOperationsService;

  app.get('/api/now', (_req, res) => {
    if (!requireService(res, services.playbackRuntime, 'playback runtime')) return;
    res.json({
      runtime: services.playbackRuntime.snapshot(),
      ...services.queueService?.snapshot?.(),
      env: { now: services.environmentService?.getNow?.() || null },
    });
  });

  // 陪伴感在场状态：只读产品事实（是否在场、节奏档位、今天开口/被晾次数）；没有观察者时如实报告关闭。
  app.get('/api/presence/status', (_req, res) => {
    const status = services.presence?.status?.();
    res.json(status ? { ok: true, ...status } : { ok: true, enabled: false, phase: 'off' });
  });

  // 「一起听歌时伙伴会主动说话」与「打开 app 时伙伴可以打招呼」开关：独立 prefs，只改给出的那个；
  // 写入成功才返回新值；PRESENCE_AUTO=0 时 available=false。
  app.get('/api/presence/preferences', (_req, res) => {
    const preferences = services.presence?.preferences?.();
    res.json(preferences ? { ok: true, ...preferences } : { ok: true, ambientEnabled: false, greetingEnabled: false, available: false });
  });

  app.post('/api/presence/preferences', (req, res) => {
    if (!requireService(res, services.presence?.setPreferences, 'presence')) return;
    const input = {};
    for (const key of ['ambientEnabled', 'greetingEnabled']) {
      if (req.body?.[key] !== undefined) input[key] = req.body[key];
    }
    if (!Object.keys(input).length || Object.values(input).some(value => typeof value !== 'boolean')) {
      return res.status(400).json({ ok: false, error: 'ambientEnabled / greetingEnabled must be booleans', code: 'invalid_presence_preferences' });
    }
    try {
      res.json({ ok: true, ...services.presence.setPreferences(input) });
    } catch {
      res.status(500).json({ ok: false, error: '没能保存这个开关', code: 'presence_preferences_write_failed' });
    }
  });

  // 「安静点」的一键恢复：只清这个听歌来源的本次安静，不改持久开关。
  app.post('/api/presence/listener-quiet/restore', (req, res) => {
    if (!requireService(res, services.presence?.restoreListenerQuiet, 'presence')) return;
    const sessionId = req.body?.sessionId;
    if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
      return res.status(400).json({ ok: false, error: 'sessionId required', code: 'invalid_session_id' });
    }
    res.json({ ok: true, ...services.presence.restoreListenerQuiet(sessionId) });
  });

  app.post('/api/play-outcome', asyncRoute(async (req, res) => {
    if (!requireService(res, playback, 'playback operations service')) return;
    const songId = req.body?.song_id;
    const outcome = req.body?.outcome;
    if (songId == null || !String(outcome || '').trim()) {
      return res.status(400).json({ ok: false, error: 'song_id and outcome required' });
    }
    res.json(await playback.recordOutcome({
      song_id: String(songId),
      outcome: String(outcome),
      played_seconds: Number(req.body?.played_seconds) || 0,
    }));
  }));

  app.post('/api/pb-event', asyncRoute(async (req, res) => {
    if (!requireService(res, playback, 'playback operations service')) return;
    res.json(await playback.dispatch(req.body || {}));
  }));

  // 陪伴模式修改：唯一入口。封闭枚举 + requestId 幂等 + 可选 expectedRevision；
  // 重复提交返回同一权威结果，迟到 revision 以 409 附当前快照可恢复。
  app.patch('/api/listening-sessions/:id/companion-mode', asyncRoute(async (req, res) => {
    const runtime = services.playbackRuntime;
    if (!requireService(res, runtime, 'playback runtime')) return;
    const sessionId = String(req.params?.id || '');
    const body = req.body || {};
    const requestId = String(body.requestId || '').trim();
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      return res.status(400).json({ ok: false, error: 'invalid listening session id', code: 'invalid_listening_session' });
    }
    if (!requestId) {
      return res.status(400).json({ ok: false, error: 'requestId required', code: 'request_id_required' });
    }
    if (body.modeId != null && !isCompanionModeId(body.modeId)) {
      return res.status(400).json({ ok: false, error: 'unknown companion mode', code: 'unknown_companion_mode' });
    }
    if (body.expectedRevision != null && (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0)) {
      return res.status(400).json({ ok: false, error: 'expectedRevision must be a non-negative integer', code: 'invalid_expected_revision' });
    }
    const current = runtime.snapshot();
    if (current.activeListeningSessionId !== sessionId && !current.suspendedSessions?.[sessionId]) {
      return res.status(404).json({ ok: false, error: 'listening session not found', code: 'listening_session_not_found' });
    }
    const result = await runtime.submit({
      type: 'COMPANION_MODE_CHANGED',
      eventId: `companion-mode:${sessionId}:${requestId}`,
      listeningSessionId: sessionId,
      modeId: body.modeId === undefined ? null : body.modeId,
      requestId,
      ...(body.expectedRevision != null ? { expectedRevision: body.expectedRevision } : {}),
    });
    if (result.accepted) {
      return res.json({ ok: true, snapshot: runtime.listeningSnapshot(sessionId), runtime: runtime.snapshot() });
    }
    if (result.reason === 'duplicate event') {
      return res.json({ ok: true, idempotent: true, snapshot: runtime.listeningSnapshot(sessionId), runtime: runtime.snapshot() });
    }
    if (result.reason === 'stale mode revision') {
      return res.status(409).json({ ok: false, error: '模式刚被更新过，请以当前状态重试。', code: 'stale_mode_revision',
        snapshot: runtime.listeningSnapshot(sessionId), runtime: runtime.snapshot() });
    }
    return res.status(409).json({ ok: false, error: result.reason || 'companion mode change rejected', code: 'companion_mode_rejected' });
  }));
}
