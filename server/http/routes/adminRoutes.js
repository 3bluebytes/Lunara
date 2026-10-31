import { asyncRoute, requireService } from './routeUtils.js';

export function registerAdminRoutes(app, services = {}) {
  const warmPool = services.warmPoolAdminService;
  const reflection = services.reflectionAdminService;
  const taste = services.tasteAdminService;
  const library = services.libraryAdminService;
  const librarySync = services.librarySyncService;
  const songTags = services.songTagAdminService;

  app.get('/api/warmpool/status', asyncRoute(async (_req, res) => {
    if (!requireService(res, warmPool, 'warm pool admin service')) return;
    res.json(await warmPool.status());
  }));
  app.post('/api/warmpool/refresh', asyncRoute(async (req, res) => {
    if (!requireService(res, warmPool, 'warm pool admin service')) return;
    res.json(await warmPool.refresh(req.body || {}));
  }));

  app.get('/api/reflection/status', asyncRoute(async (_req, res) => {
    if (!requireService(res, reflection, 'reflection admin service')) return;
    res.json(await reflection.status());
  }));
  app.post('/api/reflection/run', asyncRoute(async (req, res) => {
    if (!requireService(res, reflection, 'reflection admin service')) return;
    res.json(await reflection.run(req.body || {}));
  }));
  app.post('/api/reflection/distill-schema', asyncRoute(async (req, res) => {
    if (!requireService(res, reflection, 'reflection admin service')) return;
    res.json(await reflection.distillSchema(req.body || {}));
  }));

  app.post('/api/taste/consolidate', asyncRoute(async (req, res) => {
    if (!requireService(res, taste, 'taste admin service')) return;
    const dryRun = req.body?.dryRun === true || req.query?.dryRun === 'true';
    res.json(await taste.consolidate({ dryRun }));
  }));
  app.get('/api/taste/log', asyncRoute(async (req, res) => {
    if (!requireService(res, taste, 'taste admin service')) return;
    res.json(await taste.log({ limit: req.query?.limit }));
  }));
  app.get('/api/taste/status', asyncRoute(async (_req, res) => {
    if (!requireService(res, taste, 'taste admin service')) return;
    res.json(await taste.status());
  }));
  app.get('/api/taste', asyncRoute(async (_req, res) => {
    if (!requireService(res, taste, 'taste admin service')) return;
    res.json(await taste.profile());
  }));
  app.get('/api/plan/today', asyncRoute(async (_req, res) => {
    if (!requireService(res, taste, 'taste admin service')) return;
    res.json(await taste.today());
  }));

  app.get('/api/me/library', asyncRoute(async (_req, res) => {
    if (!requireService(res, library, 'library admin service')) return;
    res.json(await library.snapshot());
  }));

  app.post('/api/library/import', asyncRoute(async (req, res) => {
    if (!requireService(res, librarySync, 'library sync service')) return;
    res.status(202).json(await librarySync.import(req.body || {}));
  }));
  app.get('/api/library/status', asyncRoute(async (_req, res) => {
    if (!requireService(res, librarySync, 'library sync service')) return;
    res.json(await librarySync.status());
  }));

  app.get('/api/songtags/status', asyncRoute(async (_req, res) => {
    if (!requireService(res, songTags, 'song tag admin service')) return;
    res.json(await songTags.status());
  }));
  // 标签库浏览：只读 GET，搜索 + 分页（song-tag-inspection）。
  app.get('/api/songtags', asyncRoute(async (req, res) => {
    if (!requireService(res, songTags, 'song tag admin service')) return;
    res.json(await songTags.list({
      search: req.query?.search,
      limit: req.query?.limit,
      offset: req.query?.offset,
    }));
  }));
  // 手动修正一首歌的标签：显式 (provider, songId) + 白名单补丁。
  app.put('/api/songtags', asyncRoute(async (req, res) => {
    if (!requireService(res, songTags, 'song tag admin service')) return;
    res.json(await songTags.update(req.body || {}));
  }));
  // 删除标签行；删后下一轮 resolve/backfill 会重新自动打标。
  app.delete('/api/songtags', asyncRoute(async (req, res) => {
    if (!requireService(res, songTags, 'song tag admin service')) return;
    res.json(await songTags.remove(req.body || {}));
  }));
  app.post('/api/songtags/backfill', asyncRoute(async (req, res) => {
    if (!requireService(res, songTags, 'song tag admin service')) return;
    res.json(await songTags.backfill(req.body || {}));
  }));
  app.get('/api/songtags/config', asyncRoute(async (_req, res) => {
    if (!requireService(res, songTags, 'song tag admin service')) return;
    res.json({ ok: true, config: await songTags.config() });
  }));
  app.put('/api/songtags/config', asyncRoute(async (req, res) => {
    if (!requireService(res, songTags, 'song tag admin service')) return;
    res.json({ ok: true, config: await songTags.saveConfig(req.body || {}) });
  }));
}
