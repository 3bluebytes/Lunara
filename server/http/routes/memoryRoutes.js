import { asyncRoute, requireService } from './routeUtils.js';

export function registerMemoryRoutes(app, services = {}) {
  const memory = services.memoryAdminService;

  app.get('/api/memory/shared', asyncRoute(async (_req, res) => {
    if (requireService(res, memory, 'memory admin service')) res.json(await memory.sharedMemory());
  }));
  app.get('/api/memory/person/:personId', asyncRoute(async (req, res) => {
    if (requireService(res, memory, 'memory admin service')) res.json(await memory.listPersonMemory(req.params.personId));
  }));
  app.post('/api/memory/claims/:claimId/revoke', asyncRoute(async (req, res) => {
    if (requireService(res, memory, 'memory admin service')) res.json(await memory.revokeCandidate(req.params.claimId));
  }));
  app.post('/api/memory/records/:memoryId', asyncRoute(async (req, res) => {
    if (requireService(res, memory, 'memory admin service')) res.json(await memory.updateMemory(req.params.memoryId, req.body || {}));
  }));

  app.get('/api/memory/status', asyncRoute(async (_req, res) => {
    if (!requireService(res, memory, 'memory admin service')) return;
    res.json(await memory.status());
  }));

  app.post('/api/memory/summarize', asyncRoute(async (req, res) => {
    if (!requireService(res, memory, 'memory admin service')) return;
    res.json(await memory.summarize(req.body || {}));
  }));

  app.get('/api/station/status', asyncRoute(async (_req, res) => {
    if (!requireService(res, memory, 'memory admin service')) return;
    res.json(await memory.stationStatus());
  }));

  app.get('/api/station/memory', asyncRoute(async (req, res) => {
    if (!requireService(res, memory, 'memory admin service')) return;
    res.json(await memory.listStationMemory(req.query || {}));
  }));

  app.post('/api/station/memory', asyncRoute(async (req, res) => {
    if (!requireService(res, memory, 'memory admin service')) return;
    res.json(await memory.addStationMemory(req.body || {}));
  }));

  app.post('/api/station/consolidate', asyncRoute(async (req, res) => {
    if (!requireService(res, memory, 'memory admin service')) return;
    res.json(await memory.consolidateStation(req.body || {}));
  }));
}
