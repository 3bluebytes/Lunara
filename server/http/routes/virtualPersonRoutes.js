import { asyncRoute, requireService } from './routeUtils.js';
import { listPersonaPresets } from '../../persona/personaPresets.js';

/**
 * 把服务层的错误映射为可纠正的 HTTP 状态。
 * 校验类错误是调用方可以修正的，因此不能用 500 把它们埋起来。
 */
function respondServiceError(res, error, fallbackMessage) {
  // 已带状态码的服务错误自带用户可读文案，不再按 message 猜测。
  if (Number.isInteger(error?.statusCode) && error.statusCode >= 400) {
    return res.status(error.statusCode).json({ ok: false, error: String(error.message || fallbackMessage) });
  }
  const message = String(error?.message || fallbackMessage);
  if (/not found|not available/.test(message)) {
    return res.status(404).json({ ok: false, error: message });
  }
  if (/cannot be deleted|cannot be archived|required|exceeds|cannot be empty|invalid/i.test(message)) {
    return res.status(400).json({ ok: false, error: message });
  }
  return res.status(500).json({ ok: false, error: fallbackMessage });
}

export function registerVirtualPersonRoutes(app, { virtualPersonService } = {}) {
  app.get('/api/conversations', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    res.json({ ok: true, conversations: virtualPersonService.rooms({ includeArchived: req.query?.archived === 'true' }) });
  });
  app.post('/api/conversations', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    res.json({ ok: true, conversation: await virtualPersonService.createRoom(req.body || {}) });
  }));
  app.post('/api/conversations/:sessionId', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    res.json({ ok: true, conversation: await virtualPersonService.updateRoom(req.params.sessionId, req.body || {}) });
  }));
  app.delete('/api/conversations/:sessionId', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    try {
      res.json({ ok: true, deleted: await virtualPersonService.deleteRoom(req.params.sessionId) });
    } catch (error) {
      respondServiceError(res, error, '无法删除该聊天');
    }
  }));
  app.post('/api/conversations/:sessionId/members', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    const method = req.body?.remove === true ? 'remove' : 'invite';
    res.json({ ok: true, conversation: virtualPersonService[method](req.params.sessionId, req.body?.personId) });
  }));
  app.post('/api/conversations/:sessionId/cancel', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    const expected = typeof req.body?.requestId === 'string' ? req.body.requestId.trim().slice(0, 128) : null;
    res.json({ ok: true, cancelled: expected ? virtualPersonService.cancel(req.params.sessionId, expected)
      : virtualPersonService.cancel(req.params.sessionId) });
  });
  // 编辑与分叉（add-chat-edit-and-fork）：回退只在发送改写时调用；分叉返回新聊天与被分叉的原话。
  app.post('/api/conversations/:sessionId/rewind', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    try {
      res.json({ ok: true, ...virtualPersonService.rewind(req.params.sessionId, req.body?.turnId) });
    } catch (error) {
      respondServiceError(res, error, '这次没改写成功，可以再试一次');
    }
  }));
  app.post('/api/conversations/:sessionId/fork', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    try {
      res.json({ ok: true, ...await virtualPersonService.fork(req.params.sessionId, req.body?.turnId) });
    } catch (error) {
      respondServiceError(res, error, '这次没分叉成功，可以再试一次');
    }
  }));
  // ambient 推荐的「放这首」（add-ambient-music-recommendation）：只在 pending、未过期、这个聊天正是
  // 当前听歌来源时排到当前歌之后；绝不切换听歌来源，也不替歌。
  app.post('/api/conversations/:sessionId/recommendations/:turnId/accept', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    let result;
    try {
      result = await virtualPersonService.acceptRecommendation(req.params.sessionId, req.params.turnId);
    } catch (error) {
      respondServiceError(res, error, '这首暂时没排上，可以再试一次');
      return;
    }
    const status = result?.ok === true ? 200
      : result?.code === 'RECOMMENDATION_NOT_FOUND' ? 404
        : result?.retryable === true ? 503 : 409;
    res.status(status).json({ ok: result?.ok === true, code: String(result?.code || ''), retryable: result?.retryable === true,
      ...(result?.recommendation ? { recommendation: result.recommendation } : {}) });
  }));
  app.get('/api/conversations/:sessionId/turns', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    res.json({
      ok: true,
      sessionId: req.params.sessionId,
      turns: virtualPersonService.transcript(req.params.sessionId, { limit: req.query?.limit, beforeSequence: req.query?.before }),
    });
  });

  app.get('/api/virtual-persons', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    const sessionId = String(req.query?.sessionId || '').trim();
    res.json({
      ok: true,
      persons: virtualPersonService.list(),
      ...(sessionId ? { session: virtualPersonService.session(sessionId) } : {}),
    });
  });

  // 预令人设：与声音正交，供创建/编辑时说“选人设”。
  app.get('/api/persona-presets', (_req, res) => {
    res.json({ ok: true, presets: listPersonaPresets() });
  });

  app.get('/api/virtual-persons/:id', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    const person = virtualPersonService.get(req.params.id);
    if (!person) return res.status(404).json({ ok: false, error: 'virtual person not found' });
    res.json({ ok: true, person });
  });

  app.post('/api/virtual-persons', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    try {
      const person = await virtualPersonService.create(req.body || {});
      res.json({ ok: true, person });
    } catch (error) {
      // 未知声音/预设、超长字段都是调用方可纠正的，不能落成 500。
      respondServiceError(res, error, '无法创建该伙伴');
    }
  }));

  app.post('/api/virtual-persons/:id/activate', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    const result = await virtualPersonService.activate({
      id: req.params.id,
      sessionId: req.body?.sessionId || 'conversation:primary',
    });
    if (!result) return res.status(404).json({ ok: false, error: 'virtual person not found' });
    res.json({ ok: true, ...result });
  }));

  app.post('/api/virtual-persons/:id/archive', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    const person = virtualPersonService.archive(req.params.id);
    if (!person) return res.status(404).json({ ok: false, error: 'virtual person not found' });
    res.json({ ok: true, person });
  });

  // 删除前披露：删除不可回退，调用方必须在确认前拿到真实影响面。
  app.get('/api/virtual-persons/:id/deletion-impact', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    const impact = virtualPersonService.personDeletionImpact(req.params.id);
    if (!impact) return res.status(404).json({ ok: false, error: 'virtual person not found' });
    res.json({ ok: true, impact });
  });

  app.patch('/api/virtual-persons/:id', (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    try {
      const person = virtualPersonService.updatePerson(req.params.id, req.body || {});
      if (!person) return res.status(404).json({ ok: false, error: 'virtual person not found' });
      res.json({ ok: true, person });
    } catch (error) {
      respondServiceError(res, error, '无法保存该伙伴的设置');
    }
  });

  app.delete('/api/virtual-persons/:id', asyncRoute(async (req, res) => {
    if (!requireService(res, virtualPersonService, 'virtual person service')) return;
    try {
      const result = await virtualPersonService.deletePerson(req.params.id);
      if (!result?.deleted) {
        // 部分失败（记忆已清理但实体行没删掉等）不是 not-found，必须与它区分开：
        // 返回可重试的失败态，而不是让客户端以为"伙伴不存在"。
        if (result?.errors?.length) {
          console.warn('[virtual-person] deletion partially failed:', result.errors);
          return res.status(500).json({ ok: false, error: '删除未完成，请稍后重试', details: result });
        }
        return res.status(404).json({ ok: false, error: 'virtual person not found' });
      }
      res.json({ ok: true, ...result });
    } catch (error) {
      respondServiceError(res, error, '无法删除该伙伴');
    }
  }));
}
