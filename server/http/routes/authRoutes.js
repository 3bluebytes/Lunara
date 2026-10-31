import { asyncRoute, requireService } from './routeUtils.js';
import { providerRegistry } from '../../music/providerRegistry.js';

export function registerAuthRoutes(app, services = {}) {
  const auth = services.authService;

  const cookieLogin = source => asyncRoute(async (req, res) => {
    if (!requireService(res, auth, 'auth service')) return;
    const cookie = String(req.body?.cookie || '').trim();
    if (!cookie) return res.status(400).json({ ok: false, error: 'empty cookie' });
    res.json(await auth.loginWithCookie(source, cookie));
  });

  const startQr = source => asyncRoute(async (_req, res) => {
    if (!requireService(res, auth, 'auth service')) return;
    res.json(await auth.startQr(source));
  });

  const checkQr = source => asyncRoute(async (req, res) => {
    if (!requireService(res, auth, 'auth service')) return;
    const key = String(req.query?.key || '').trim();
    if (!key) return res.status(400).json({ ok: false, error: 'missing key' });
    res.json(await auth.checkQr(source, key));
  });

  // QR session creation is POST-only: AuthService ends an existing NCM session
  // before minting a key, so a GET form would let any page log the user out.
  // The polling endpoint stays GET because it requires a server-issued key.
  app.post('/api/login/qr', startQr('ncm'));
  app.get('/api/login/qr/check', checkQr('ncm'));
  app.post('/api/login/cookie', cookieLogin('ncm'));
  app.post('/api/logout', asyncRoute(async (req, res) => {
    if (!requireService(res, auth, 'auth service')) return;
    const requested = String(req.query?.source || '').trim().toLowerCase();
    const source = providerRegistry.isPlayable(requested) ? requested : 'ncm';
    res.json(await auth.logout(source));
  }));

  app.post('/api/login/qq/qr', startQr('qq'));
  app.get('/api/login/qq/qr/check', checkQr('qq'));
  app.post('/api/login/qq/cookie', cookieLogin('qq'));
  app.post('/api/logout/qq', asyncRoute(async (_req, res) => {
    if (!requireService(res, auth, 'auth service')) return;
    res.json(await auth.logout('qq'));
  }));
}
