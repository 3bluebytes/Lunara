import { asyncRoute, requireService } from './routeUtils.js';
import { providerRegistry } from '../../music/providerRegistry.js';

const SONG_ID_PATTERN = /^[^\s]{1,128}$/;
const REQUEST_ID_PATTERN = /^[^\s]{1,128}$/;

/**
 * 「喜欢」的唯一 HTTP 入口。
 *
 * 语义要注意：`ok: true` 只表示**本地意图已保存**，远端是否跟上要看返回的
 * `like.remoteState`。界面必须按 remoteState 说话，不能把 ok 当成「已同步」。
 */
export function registerTrackLikeRoutes(app, services = {}) {
  const trackLikes = services.trackLikeService;

  function validate(body = {}) {
    const provider = String(body.provider ?? '').trim().toLowerCase();
    const songId = String(body.songId ?? body.song_id ?? '').trim();
    if (!providerRegistry.get(provider)) {
      return { error: 'unknown music source', code: 'unknown_provider' };
    }
    if (!SONG_ID_PATTERN.test(songId)) {
      return { error: 'songId required', code: 'invalid_song_id' };
    }
    if (body.desired !== true && body.desired !== false) {
      return { error: 'desired must be a boolean', code: 'invalid_desired' };
    }
    const rawRequestId = body.requestId;
    const requestId = rawRequestId == null ? null : String(rawRequestId).trim();
    if (requestId !== null && !REQUEST_ID_PATTERN.test(requestId)) {
      return { error: 'requestId must be a non-empty token', code: 'invalid_request_id' };
    }
    return { provider, songId, desired: body.desired, requestId };
  }

  app.get('/api/track-like', asyncRoute(async (req, res) => {
    if (!requireService(res, trackLikes, 'track like service')) return;
    const provider = String(req.query?.provider ?? '').trim().toLowerCase();
    const songId = String(req.query?.songId ?? req.query?.song_id ?? '').trim();
    if (!providerRegistry.get(provider) || !SONG_ID_PATTERN.test(songId)) {
      return res.status(400).json({ ok: false, error: 'provider and songId required', code: 'invalid_request' });
    }
    // 本地没表达过时读一次远端：这首歌可能本来就在用户的「我喜欢」里，
    // 否则心形会显示成未喜欢，点一下等于「又收藏一遍」，看起来毫无反应。
    const resolved = await trackLikes.resolveLike({ provider, songId });
    res.json({
      ok: true,
      like: resolved.like,
      // adopted = 这条喜欢不是用户在 Lunara 里点的，而是从云端歌单采纳的事实。
      adopted: resolved.adopted === true || resolved.like?.origin === 'adopted',
      canWriteRemote: resolved.canWriteRemote === true,
      readError: resolved.readError || null,
    });
  }));

  app.post('/api/track-like', asyncRoute(async (req, res) => {
    if (!requireService(res, trackLikes, 'track like service')) return;
    const input = validate(req.body || {});
    if (input.error) return res.status(400).json({ ok: false, error: input.error, code: input.code });
    const result = await trackLikes.setLike(input);
    if (!result.ok && result.reason === 'invalid_song') {
      return res.status(400).json({ ok: false, error: 'songId required', code: 'invalid_song_id' });
    }
    res.json({
      ok: true,
      like: result.like,
      idempotent: result.idempotent === true,
      // 同步失败不是写入失败：意图已保存，界面按 remoteState 呈现。
      sync: result.reason ? { reason: result.reason, retryable: result.retryable !== false } : null,
    });
  }));

  app.post('/api/track-like/retry', asyncRoute(async (req, res) => {
    if (!requireService(res, trackLikes, 'track like service')) return;
    const body = req.body || {};
    const provider = String(body.provider ?? '').trim().toLowerCase();
    const songId = String(body.songId ?? body.song_id ?? '').trim();
    if (!providerRegistry.get(provider) || !SONG_ID_PATTERN.test(songId)) {
      return res.status(400).json({ ok: false, error: 'provider and songId required', code: 'invalid_request' });
    }
    const result = await trackLikes.retry({ provider, songId, requestId: body.requestId });
    if (!result.ok && result.reason === 'no_intent') {
      return res.status(404).json({ ok: false, error: 'no like intent for this track', code: 'no_intent' });
    }
    res.json({ ok: true, like: result.like, sync: result.reason ? { reason: result.reason, retryable: result.retryable !== false } : null });
  }));
}
