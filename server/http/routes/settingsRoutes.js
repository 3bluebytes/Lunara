import { asyncRoute, okPayload, requireService } from './routeUtils.js';
import { publicLocation } from '../../locationService.js';
import { CUSTOM_TTS_PROTOCOLS } from '../../ttsCustomConfig.js';

export function registerSettingsRoutes(app, services = {}) {
  const settings = services.settingsService;
  const health = services.healthService;
  const ttsStatus = services.ttsStatusService;
  const location = services.locationService;
  const environment = services.environmentService;
  const ttsCustom = services.ttsCustomService;
  const ttsFailures = services.ttsFailureLog;

  app.get('/api/settings', asyncRoute(async (_req, res) => {
    if (!requireService(res, settings, 'settings service')) return;
    res.json(okPayload(await settings.snapshot()));
  }));

  app.post('/api/settings', asyncRoute(async (req, res) => {
    if (!requireService(res, settings, 'settings service')) return;
    res.json(okPayload(await settings.update(req.body || {})));
  }));

  // 位置：城市名由用户显式给出，服务端解析为坐标后只存本地。
  // 解析失败保留既有位置并返回可纠正错误；成功/清除都会经 onChanged 广播 environment。
  app.post('/api/settings/location', asyncRoute(async (req, res) => {
    if (!requireService(res, location, 'location service')) return;
    const result = await location.setLocation(String(req.body?.city || ''));
    if (result?.error) return res.status(400).json({ ok: false, error: result.error });
    res.json(okPayload({ location: publicLocation(result.location) }));
  }));

  app.delete('/api/settings/location', asyncRoute(async (_req, res) => {
    if (!requireService(res, location, 'location service')) return;
    await location.clearLocation();
    res.json(okPayload({ location: null }));
  }));

  // 重新自动定位：显式解除手动固定并按出口 IP 重测。
  app.post('/api/settings/location/auto', asyncRoute(async (_req, res) => {
    if (!requireService(res, location, 'location service')) return;
    const result = await location.redetectLocation();
    if (result?.error) return res.status(400).json({ ok: false, error: result.error });
    res.json(okPayload({ location: publicLocation(result.location) }));
  }));

  // ---- 自定义 TTS 接口（多接口 + 统一声音池；协议：openai 兼容 / minimax / breeze / recipe）----
  // key 只在服务端配置文件里；GET 永远只回 hasKey。发现端点失败时如实透传
  // 错误消息（不含 key），voices 不可用由 UI 引导手填。发现与试听都按 endpointId。
  // recipe 接口保存前，服务端要求同一「地址 + 配方」刚通过试合成（recipe-test / recipe-draft）。
  const endpointIdOf = req => String(req.body?.endpointId || '').trim();
  app.get('/api/tts/custom', asyncRoute(async (_req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    res.json(okPayload({ config: ttsCustom.getConfig() }));
  }));

  app.post('/api/tts/custom', asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    const { endpoint, voices } = req.body || {};
    if (voices !== undefined && !Array.isArray(voices)) {
      return res.status(400).json({ ok: false, error: 'voices 必须是数组' });
    }
    if (endpoint !== undefined && (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint))) {
      return res.status(400).json({ ok: false, error: 'endpoint 必须是对象' });
    }
    if (endpoint?.protocol !== undefined && !CUSTOM_TTS_PROTOCOLS.includes(endpoint.protocol)) {
      return res.status(400).json({ ok: false, error: 'protocol 只支持 openai、minimax、breeze 或 recipe' });
    }
    const config = ttsCustom.saveConfig({
      ...(endpoint ? { endpoint } : {}),
      ...(voices !== undefined ? { voices } : {}),
    });
    if (config?.error) return res.status(400).json({ ok: false, error: config.error });
    res.json(okPayload({ config }));
  }));

  // 配方接口：预设列表、对配方只做试合成（一次厂商请求）、让助手读文档起草或按失败修订（只调模型）。
  // 都由用户点击触发；失败如实返回脱敏后的原因，不自动重试、不自动修订。
  app.get('/api/tts/custom/recipe-presets', asyncRoute(async (_req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    res.json(okPayload({ presets: ttsCustom.recipePresets() }));
  }));
  const recipeFields = body => ({
    endpointId: endpointIdOf({ body }), baseUrl: body.baseUrl, apiKey: body.apiKey, model: body.model, voice: body.voice,
  });
  const recipeRoute = (path, call) => app.post(path, asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    const result = await call(req.body || {});
    if (result?.error) return res.status(400).json({ ok: false, error: result.error, ...(result.summary ? { summary: result.summary } : {}), ...(result.stage ? { stage: result.stage } : {}) });
    res.json({ ok: true, ...result });
  }));
  recipeRoute('/api/tts/custom/recipe-test', body => ttsCustom.testRecipe({ ...recipeFields(body), recipe: body.recipe, presetId: body.presetId }));
  recipeRoute('/api/tts/custom/recipe-draft', body => ttsCustom.draftRecipe({ ...recipeFields(body), docText: body.docText, docUrl: body.docUrl, previous: body.previous }));

  // 删除接口：它名下的保留声音一并移除（界面在调用前已说明影响）。
  app.post('/api/tts/custom/remove-endpoint', asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    const result = ttsCustom.removeEndpoint({ endpointId: endpointIdOf(req) });
    if (result?.error) return res.status(400).json({ ok: false, error: result.error });
    res.json(okPayload({ config: result }));
  }));

  app.post('/api/tts/custom/discover-models', asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    try {
      const models = await ttsCustom.discoverModels({ endpointId: endpointIdOf(req) });
      res.json(okPayload({ models }));
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
  }));

  // 伙伴发声失败的本地记录：只有原因、卡住的阶段与分段耗时，不含文字与上游原文。
  app.get('/api/tts/failures', asyncRoute(async (req, res) => {
    if (!requireService(res, ttsFailures, 'tts failure log')) return;
    const endpointId = String(req.query?.endpointId || '').trim() || null;
    res.json(okPayload({ failures: ttsFailures.list({ endpointId, limit: Number(req.query?.limit) || 20 }) }));
  }));

  app.post('/api/tts/custom/discover-voices', asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    try {
      const voices = await ttsCustom.discoverVoices({ endpointId: endpointIdOf(req) });
      res.json(okPayload({ voices }));
    } catch (error) {
      res.status(502).json({ ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) });
    }
  }));

  // 待选声音试听：按 (接口, 源 voice id[, model]) 用保存的连接配置直接合成一小段，
  // 先听再决定去留。试听不代表已保留；是否进入声音池仍由 voices 保存动作决定。
  app.post('/api/tts/custom/preview', asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    const result = await ttsCustom.previewVoice({
      endpointId: endpointIdOf(req), voiceId: req.body?.voiceId, model: req.body?.model, text: req.body?.text,
    });
    if (result?.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result });
  }));

  // 免费声音（Edge 朗读）开关与代读设置。从关到开必须带本次知情确认（consent:true），
  // 说明文字固定在设置页；只转交白名单字段。
  const FALLBACK_FIELDS = ['freeVoicesEnabled', 'consent', 'fallbackEnabled', 'fallbackTarget'];
  app.post('/api/tts/fallback', asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    const patch = Object.fromEntries(FALLBACK_FIELDS.filter(key => req.body?.[key] !== undefined).map(key => [key, req.body[key]]));
    const result = ttsCustom.saveFallback(patch);
    if (result?.error) return res.status(400).json({ ok: false, error: result.error });
    res.json(okPayload({ config: result }));
  }));

  // 按描述设计声音（breeze/minimax）：生成候选、按伙伴人设起草描述、候选转正。
  // 每次调用都由用户点击触发；生成与转正会扣厂商额度，失败如实返回原因，不自动重试。
  const designRoute = (path, call) => app.post(path, asyncRoute(async (req, res) => {
    if (!requireService(res, ttsCustom, 'custom tts service')) return;
    const result = await call(req.body || {});
    if (result?.error) return res.status(400).json({ ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) });
    res.json({ ok: true, ...result });
  }));
  designRoute('/api/tts/custom/design', body => ttsCustom.designVoices({
    endpointId: endpointIdOf({ body }), description: body.description, previewText: body.previewText, count: body.count,
  }));
  designRoute('/api/tts/custom/design-draft', body => ttsCustom.draftVoiceDescription({ personId: body.personId }));
  designRoute('/api/tts/custom/design-activate', body => ttsCustom.activateDesignedVoice({
    endpointId: endpointIdOf({ body }), generatedId: body.generatedId, name: body.name, description: body.description, model: body.model,
  }));

  // 环境快照：客户端启动时拉一次初始状态，此后靠 environment 事件增量更新。
  app.get('/api/environment', asyncRoute(async (_req, res) => {
    if (!requireService(res, environment, 'environment service')) return;
    res.json(okPayload({ environment: await environment.environmentEvent() }));
  }));

  app.get('/api/tts/status', (_req, res) => {
    if (!requireService(res, ttsStatus, 'tts status service')) return;
    res.json({ ok: true, providers: ttsStatus.status().providers });
  });

  // 试听：走与串词完全相同的合成路径，因此受缓存、响度与失败契约约束。
  // 不使用预烘样本——否则用户听到的与实际串词不一致。
  app.post('/api/tts/preview', asyncRoute(async (req, res) => {
    const preview = services.ttsPreviewService;
    if (!requireService(res, preview, 'tts preview service')) return;
    const result = await preview.preview({
      voiceProfileId: req.body?.voiceProfileId,
      text: req.body?.text,
    });
    if (result?.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result });
  }));

  app.get('/api/health', asyncRoute(async (_req, res) => {
    if (!requireService(res, health, 'health service')) return;
    res.json(okPayload(await health.snapshot()));
  }));
}
