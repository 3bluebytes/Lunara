import { asyncRoute, okPayload, requireService } from './routeUtils.js';

export function registerRadiohostRoutes(app, services = {}) {
  const station = services.stationService;

  app.get('/api/radiohost/list', (_req, res) => {
    if (!requireService(res, station, 'station service')) return;
    res.json({ ok: true, hosts: station.list() });
  });

  app.get('/api/radiohost/active', (_req, res) => {
    if (!requireService(res, station, 'station service')) return;
    res.json({ ok: true, active: station.active() });
  });

  app.post('/api/radiohost/create', asyncRoute(async (req, res) => {
    if (!requireService(res, station, 'station service')) return;
    const { voiceProfileId, personaHint, displayName } = req.body || {};
    if (!voiceProfileId) return res.status(400).json({ ok: false, error: 'voiceProfileId required' });
    const host = await station.create({ voiceProfileId, personaHint, displayName });
    res.json({ ok: true, host });
  }));

  app.post('/api/radiohost/:id/activate', asyncRoute(async (req, res) => {
    if (!requireService(res, station, 'station service')) return;
    const result = await station.activate(req.params.id, req.body?.sessionId || 'conversation:primary');
    if (!result) return res.status(404).json({ ok: false, error: 'radiohost not found' });

    res.json(okPayload(result));
  }));

  app.delete('/api/radiohost/:id', asyncRoute(async (req, res) => {
    if (!requireService(res, station, 'station service')) return;
    const deleted = await station.delete(req.params.id);
    if (!deleted) return res.status(404).json({ ok: false, error: 'radiohost not found' });
    res.json({ ok: true });
  }));

  app.get('/api/station/voices', (_req, res) => {
    if (!requireService(res, station, 'station service')) return;
    res.json({ ok: true, voices: station.voices?.() || [] });
  });
}
