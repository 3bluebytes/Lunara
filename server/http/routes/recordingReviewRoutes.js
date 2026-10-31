import { asyncRoute, requireService } from './routeUtils.js';
import { ServiceError } from '../../services/ServiceError.js';

export function registerRecordingReviewRoutes(app, services = {}) {
  const review = services.recordingReviewService;
  const handle = action => asyncRoute(async (req, res) => {
    if (!requireService(res, review, 'recording review service')) return;
    try {
      res.json(await action(req));
    } catch (error) {
      // 不把 SQLite 路径、查询内容或内部堆栈送到界面。
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(500, '歌曲整理暂时没有完成，请稍后重试。');
    }
  });
  app.get('/api/library/recordings', handle(() => review.snapshot()));
  app.post('/api/library/recordings/confirm', handle(req => review.confirm(req.body || {})));
  app.post('/api/library/recordings/dismiss', handle(() => review.dismiss()));
  app.post('/api/library/recordings/split', handle(req => review.split(req.body || {})));
}
