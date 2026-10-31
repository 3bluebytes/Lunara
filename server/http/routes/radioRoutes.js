import { asyncRoute, requireService } from './routeUtils.js';
import { randomUUID } from 'node:crypto';

function interruptionFrom(req) {
  return typeof req.body?.interruptRequestId === 'string' ? req.body.interruptRequestId.trim().slice(0, 128) : null;
}

function requestIdFrom(req) {
  const value = req.body?.requestId || req.get?.('x-request-id') || '';
  const requestId = String(value).trim();
  return requestId || null;
}

function withRequestId(input, req) {
  const requestId = requestIdFrom(req);
  return requestId ? { ...input, requestId } : input;
}

// 用户发这句话时在听的那一首。只收这三个字符串字段，其余一律丢掉。
function heardPlaybackIdentity(value) {
  if (!value || typeof value !== 'object') return null;
  const text = key => (typeof value[key] === 'string' && value[key] && value[key].length <= 200 ? value[key] : null);
  const identity = { listeningSessionId: text('listeningSessionId'), queueItemId: text('queueItemId'), songId: text('songId') };
  return identity.listeningSessionId && identity.queueItemId ? identity : null;
}

export function registerRadioRoutes(app, services = {}) {
  const radio = services.radioRequestService;

  app.post('/api/chat', asyncRoute(async (req, res) => {
    if (!requireService(res, radio, 'radio request service')) return;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'empty message' });
    const playbackIdentity = heardPlaybackIdentity(req.body?.playbackIdentity);
    const sessionId = String(req.body?.sessionId || '').trim() || null;
    res.json(await radio.handleChat(withRequestId({
      message,
      ...(typeof req.body?.speak === 'boolean' ? { speak: req.body.speak } : {}),
      ...(interruptionFrom(req) ? { interruptRequestId: interruptionFrom(req) } : {}),
      ...(Array.isArray(req.body?.mentionedPersonIds) ? { mentionedPersonIds: req.body.mentionedPersonIds.filter(id => typeof id === 'string').slice(0, 8) } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(playbackIdentity ? { playbackIdentity } : {}),
    }, req)));
  }));

  // Drafts are request-local JSON-lines, not runtime-state or durable conversation messages.
  app.post('/api/chat/stream', asyncRoute(async (req, res) => {
    if (!requireService(res, radio, 'radio request service')) return;
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'empty message' });
    const sessionId = String(req.body?.sessionId || 'conversation:primary').trim().slice(0, 128);
    const requestId = requestIdFrom(req) || `chat:${randomUUID()}`;
    const controller = new AbortController();
    let finished = false;
    let closed = false;
    let bytes = 0;
    const onClose = () => { if (!finished) { closed = true; controller.abort(); } };
    req.on?.('aborted', onClose);
    res.on?.('close', onClose);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();
    const write = event => {
      if (closed || res.destroyed) return;
      const line = `${JSON.stringify(event)}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > 1_048_576) { controller.abort(); return; }
      if (res.write(line) === false) controller.abort(); // bounded slow-consumer failure
    };
    try {
      write({ type: 'start', sessionId, requestId });
      const result = await radio.handleChat({ message, sessionId, requestId, mode: 'text_stream',
        speak: typeof req.body?.speak === 'boolean' ? req.body.speak : true,
        interruptRequestId: interruptionFrom(req), signal: controller.signal,
        ...(Array.isArray(req.body?.mentionedPersonIds) ? { mentionedPersonIds: req.body.mentionedPersonIds.filter(id => typeof id === 'string').slice(0, 8) } : {}),
        onDraft: event => write(event),
      });
      write({ type: 'result', sessionId, requestId, result });
    } catch {
      // No raw provider exception, credential or stack reaches the draft channel.
      write({ type: 'error', sessionId, requestId, message: '这次回复没有完成，可以再试一次。' });
    } finally {
      finished = true;
      req.removeListener?.('aborted', onClose);
      res.removeListener?.('close', onClose);
      if (!closed && !res.destroyed) res.end();
    }
  }));

  app.post('/api/next', asyncRoute(async (req, res) => {
    if (!requireService(res, radio, 'radio request service')) return;
    res.json(await radio.handleNext(withRequestId({ sessionId: req.body?.sessionId, delivery: req.body?.delivery }, req)));
  }));
}
