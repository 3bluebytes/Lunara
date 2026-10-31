export function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return;
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      res.status(status).json({ ok: false, error: error?.message || String(error) });
    }
  };
}

class HttpRouteError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpRouteError';
    this.statusCode = statusCode;
  }
}

export function requireService(res, service, name) {
  if (service) return true;
  res.status(503).json({ ok: false, error: `${name} unavailable` });
  return false;
}

export function okPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return 'ok' in value ? value : { ok: true, ...value };
  }
  return { ok: true, value };
}
