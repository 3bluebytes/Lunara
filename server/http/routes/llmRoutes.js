import { asyncRoute, requireService } from './routeUtils.js';

// /api/llm/* —— provider 注册表、模型发现、使用中模型与会话级覆盖。
// 全部是本机 JSON 边界内的显式动作；key 永不出服务（hasKey 语义）。

export function registerLlmRoutes(app, services = {}) {
  const llmSettings = services.llmSettingsService;

  app.get('/api/llm/providers', asyncRoute(async (_req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.registry());
  }));

  app.post('/api/llm/providers', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.createProvider(req.body || {}));
  }));

  app.put('/api/llm/providers/:id', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.updateProvider(req.params?.id, req.body || {}));
  }));

  app.delete('/api/llm/providers/:id', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.deleteProvider(req.params?.id));
  }));

  app.post('/api/llm/providers/discover-models', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    try {
      res.json(await llmSettings.discover(req.body || {}));
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || '模型列表获取失败' });
    }
  }));

  app.post('/api/llm/test-model', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    try {
      res.json(await llmSettings.testModel(req.body || {}));
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || '连通性测试失败' });
    }
  }));

  // 用量摘要：按任务聚合的调用数/token/失败分类（不含正文）；/api/health 另带最近一次预算拒绝。
  app.get('/api/llm/usage', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    const days = Number.parseInt(req.query?.days, 10);
    res.json(await llmSettings.usageSummary({ days: Number.isInteger(days) && days > 0 ? days : 1 }));
  }));

  // 用量报告（设置页「使用统计」）：逐日连续序列、totals、按模型拆分与失败分类。
  // 只读；days 只做整数校验，越界与缺省由账本按保留期夹紧；不含正文与凭据。
  app.get('/api/llm/usage/report', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    const requested = Number.parseInt(req.query?.days, 10);
    const days = Number.isInteger(requested) && requested > 0 ? requested : undefined;
    res.json(await llmSettings.usageReport(days == null ? {} : { days }));
  }));

  // 能力探测：行为判定（思考/关闭/预算/结构化），数 token 级小请求；结果写入档案。
  app.post('/api/llm/probe-capability', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    const body = req.body || {};
    res.json(await llmSettings.probeCapability({ providerId: body.providerId, model: body.model || null, force: body.force !== false }));
  }));

  // 用户显式声明能力（可选覆盖）：只有显式保存才写 source 'user'，自动结论不静默改写。
  app.put('/api/llm/capabilities', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.saveCapability(req.body || {}));
  }));

  app.delete('/api/llm/capabilities', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.clearCapability({ providerId: req.query?.providerId, model: req.query?.model }));
  }));

  app.put('/api/llm/active-model', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    try {
      res.json(await llmSettings.chooseActiveModel(req.body || {}));
    } catch (error) {
      res.status(400).json({ ok: false, error: error?.message || '设置使用中模型失败' });
    }
  }));

  // 故障切换策略：默认关闭；只暴露 providerId/model 与两个开关，绝不含 key/baseUrl。
  app.get('/api/llm/failover', asyncRoute(async (_req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.failoverPolicy());
  }));

  app.put('/api/llm/failover', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    const result = await llmSettings.saveFailoverPolicy(req.body || {});
    if (result?.ok === false) {
      res.status(400).json(result);
      return;
    }
    res.json(result);
  }));

  app.get('/api/llm/session-model', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.sessionModel(req.query?.sessionId || ''));
  }));

  app.put('/api/llm/session-model', asyncRoute(async (req, res) => {
    if (!requireService(res, llmSettings, 'llm settings service')) return;
    res.json(await llmSettings.setSessionModel(req.body || {}));
  }));
}
